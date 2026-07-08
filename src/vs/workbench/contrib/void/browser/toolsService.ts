import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { IPathService } from '../../../services/path/common/pathService.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { Edit } from '../common/editCodeServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js'

import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { IDirectoryStrService } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { IFetchUrlService } from '../common/fetchUrlService.js'
import type { ChatMessage } from '../common/chatThreadServiceTypes.js'


import { toolDefinitionOfToolName } from './tools/toolRegistry.js'
import type { ToolCtx } from './tools/toolTypes.js'

// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


export const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

export const safeFence = (content: string): string => {
	let maxRun = 2
	const re = /`{3,}/g
	let m: RegExpExecArray | null
	while ((m = re.exec(content)) !== null) {
		if (m[0].length > maxRun) maxRun = m[0].length
	}
	return '`'.repeat(maxRun + 1)
}

export const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

export const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// Detects whether a plain path string is absolute.
// - Unix absolute: starts with '/'
// - Windows absolute: drive letter followed by ':\' or ':/' (e.g. 'C:\...', 'c:/...')
// - UNC path: starts with '\\'
const isAbsolutePathString = (s: string) => {
	if (s.startsWith('/')) return true
	if (s.startsWith('\\\\')) return true
	if (/^[a-zA-Z]:[\\/]/.test(s)) return true
	return false
}

// We are NOT checking to make sure in workspace.
// workspaceRoot is optional; when provided, bare relative paths like "src/foo.ts" or
// "./README.md" are resolved against it. Without it (or when no workspace is open),
// we fall back to URI.file which resolves relative paths against the filesystem root —
// same as the legacy behavior, but that's the pathological case we want to avoid.
// Prefer the workspace-aware `validateURI` bound inside ToolsService; this raw
// version is exported-by-module-scope only for internal re-use.
const validateURIWithRoot = (uriStr: unknown, workspaceRoot?: URI | null) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Scheme-qualified URI (e.g. vscode-remote://, file://, etc.) — parse as-is.
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	}

	// Absolute path — safe to pass to URI.file.
	if (isAbsolutePathString(uriStr)) {
		return URI.file(uriStr)
	}

	// Relative path (e.g. "README.md", "src/foo.ts", "./foo", "../bar").
	// Resolve against workspace root when available. This is the critical branch:
	// weak models naturally produce bare filenames, and without this resolution
	// URI.file("README.md") would become file:///README.md (root of filesystem),
	// forcing models to fall back to terminal commands.
	if (workspaceRoot) {
		return URI.joinPath(workspaceRoot, uriStr)
	}

	// No workspace — legacy fallback. Will resolve from filesystem root and likely fail,
	// but preserves prior behavior for the (rare) no-workspace case.
	return URI.file(uriStr)
}

const validateOptionalURIWithRoot = (uriStr: unknown, workspaceRoot?: URI | null) => {
	if (isFalsy(uriStr)) return null
	return validateURIWithRoot(uriStr, workspaceRoot)
}

export const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


export const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

export const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

export const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

export const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


export const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export const validateEdits = (editsUnknown: unknown): Edit[] => {
	if (typeof editsUnknown !== 'string') throw new Error(`Invalid LLM output format: edits must be a JSON string, but its type is "${typeof editsUnknown}".`)
	let parsed: unknown
	try {
		parsed = JSON.parse(editsUnknown)
	} catch (e) {
		throw new Error(`Invalid LLM output format: edits must be valid JSON. Error: ${e}`)
	}
	if (!Array.isArray(parsed)) throw new Error(`Invalid LLM output format: edits must be a JSON array, but got ${typeof parsed}.`)
	const edits: Edit[] = []
	for (let i = 0; i < parsed.length; i++) {
		const item = parsed[i]
		if (item === null || typeof item !== 'object') throw new Error(`Invalid LLM output format: edits[${i}] must be an object, but got ${typeof item}.`)
		const obj = item as Record<string, unknown>
		const original = obj.original
		if (typeof original !== 'string') {
			const providedKeys = Object.keys(obj)
			throw new Error(`Invalid LLM output format: edits[${i}] must have an "original" field (string). Provided field names: ${providedKeys.join(', ')}. Only "original", "updated", and "delete" are supported.`)
		}

		const del = obj.delete
		const deleteBool = del === true || del === 'true'
		const updated = obj.updated
		if (typeof updated !== 'string') {
			const providedKeys = Object.keys(obj)
			if (deleteBool) {
				// delete is set, updated is optional — but if provided it must be a string
				if (updated !== undefined) {
					throw new Error(`Invalid LLM output format: edits[${i}]."updated" must be a string. Provided field names: ${providedKeys.join(', ')}. Only "original", "updated", and "delete" are supported.`)
				}
			} else {
				throw new Error(`Invalid LLM output format: edits[${i}] must have an "updated" field (string). Provided field names: ${providedKeys.join(', ')}. Only "original", "updated", and "delete" are supported.`)
			}
		}
		edits.push({ original, updated: typeof updated === 'string' ? updated : '', delete: deleteBool || undefined })
	}
	if (edits.length === 0) throw new Error(`Invalid LLM output format: edits must contain at least one edit object.`)
	return edits
}

// Scan a model for the first whole-word occurrence of `symbolName`. Whole-word
// matching via \b prevents false positives like `validateNumber` matching inside
// `validateNumberAbs`. Returns 1-indexed line and column, or null when the symbol
// does not appear anywhere in the file.
const findFirstSymbolOccurrence = (model: ITextModel, symbolName: string): { line: number, column: number } | null => {
	const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const regex = new RegExp(`\\b${escaped}\\b`)
	const lineCount = model.getLineCount()
	for (let ln = 1; ln <= lineCount; ln++) {
		const content = model.getLineContent(ln)
		const m = regex.exec(content)
		if (m) return { line: ln, column: m.index + 1 }
	}
	return null
}

// Resolve where to point the LSP for `symbolName` in `model`.
// Priority: explicit lineHint if the symbol is actually on that line (word-boundary);
// otherwise fall back to first whole-word occurrence anywhere in the file.
// Returns null only when the symbol does not appear in the file at all.
export const resolveSymbolPosition = (model: ITextModel, symbolName: string, lineHint: number | null): { line: number, column: number } | null => {
	const lineCount = model.getLineCount()
	if (lineHint !== null && lineHint >= 1 && lineHint <= lineCount) {
		const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		const m = new RegExp(`\\b${escaped}\\b`).exec(model.getLineContent(lineHint))
		if (m) return { line: lineHint, column: m.index + 1 }
	}
	return findFirstSymbolOccurrence(model, symbolName)
}

const symbolKindLabel: Record<number, string> = {
	[SymbolKind.File]: 'file',
	[SymbolKind.Module]: 'module',
	[SymbolKind.Namespace]: 'namespace',
	[SymbolKind.Package]: 'package',
	[SymbolKind.Class]: 'class',
	[SymbolKind.Method]: 'method',
	[SymbolKind.Property]: 'property',
	[SymbolKind.Field]: 'field',
	[SymbolKind.Constructor]: 'constructor',
	[SymbolKind.Enum]: 'enum',
	[SymbolKind.Interface]: 'interface',
	[SymbolKind.Function]: 'function',
	[SymbolKind.Variable]: 'variable',
	[SymbolKind.Constant]: 'constant',
	[SymbolKind.String]: 'string',
	[SymbolKind.Number]: 'number',
	[SymbolKind.Boolean]: 'boolean',
	[SymbolKind.Array]: 'array',
	[SymbolKind.Object]: 'object',
	[SymbolKind.Key]: 'key',
	[SymbolKind.Null]: 'null',
	[SymbolKind.EnumMember]: 'enum-member',
	[SymbolKind.Struct]: 'struct',
	[SymbolKind.Event]: 'event',
	[SymbolKind.Operator]: 'operator',
	[SymbolKind.TypeParameter]: 'type-param',
}

function renderSymbolOutline(symbols: DocumentSymbol[], depth: number = 0): string {
	const lines: string[] = []
	for (const sym of symbols) {
		const indent = '  '.repeat(depth)
		const kind = symbolKindLabel[sym.kind] ?? 'symbol'
		const startLine = sym.range.startLineNumber
		const endLine = sym.range.endLineNumber
		const range = startLine === endLine ? `[L${startLine}]` : `[L${startLine}-${endLine}]`
		lines.push(`${indent}${kind} ${sym.name} ${range}`)
		if (sym.children && sym.children.length > 0) {
			lines.push(renderSymbolOutline(sym.children, depth + 1))
		}
	}
	return lines.join('\n')
}

function renderMarkdownHeadingOutline(content: string): string | null {
	const lines = content.split('\n')
	const headings: { level: number; text: string; line: number }[] = []
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(#{1,6})\s+(.+)/)
		if (match) {
			headings.push({ level: match[1].length, text: match[2].trim(), line: i + 1 })
		}
	}
	if (headings.length === 0) return null

	const result: string[] = []
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i]
		const nextLine = i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length
		const indent = '  '.repeat(h.level - 1)
		const range = h.line === nextLine ? `[L${h.line}]` : `[L${h.line}-${nextLine}]`
		result.push(`${indent}${h.text} ${range}`)
	}
	return result.join('\n')
}

export async function getFileOutline(
	model: ITextModel,
	languageFeaturesService: ILanguageFeaturesService,
	uri: URI,
): Promise<string | null> {
	const providers = languageFeaturesService.documentSymbolProvider.ordered(model)
	if (providers.length > 0) {
		try {
			const symbols = await providers[0].provideDocumentSymbols(model, CancellationToken.None)
			if (symbols && symbols.length > 0) {
				return renderSymbolOutline(symbols)
			}
		} catch {
			// provider failed, fall through
		}
	}

	// Markdown heading fallback
	if (uri.path.endsWith('.md') || uri.path.endsWith('.mdx')) {
		const content = model.getValue(EndOfLinePreference.LF)
		const headingOutline = renderMarkdownHeadingOutline(content)
		if (headingOutline) return headingOutline
	}

	return null
}

export const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
	return lintErrors
		.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
		.join('\n\n')
		.substring(0, MAX_FILE_CHARS_PAGE)
}

export const getLintErrors = (markerService: IMarkerService, uri: URI): { lintErrors: LintErrorItem[] | null } => {
	const lintErrors = markerService
		.read({ resource: uri })
		.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
		.slice(0, 100)
		.map(l => ({
			code: typeof l.code === 'string' ? l.code : l.code?.value || '',
			message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
			startLineNumber: l.startLineNumber,
			endLineNumber: l.endLineNumber,
		} satisfies LintErrorItem))

	if (!lintErrors.length) return { lintErrors: null }
	return { lintErrors, }
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IFetchUrlService private readonly fetchUrlService: IFetchUrlService,
		@IPathService private readonly pathService: IPathService,
	) {
		const queryBuilder = this.instantiationService.createInstance(QueryBuilder);

		// Resolve the current workspace root lazily so that multi-root / workspace-switch
		// scenarios pick up the correct folder at call time rather than at construction time.
		// These shadow the module-level helpers so the 11+ call sites below stay terse.
		const getWorkspaceRoot = (): URI | null => {
			const folders = workspaceContextService.getWorkspace().folders
			return folders.length > 0 ? folders[0].uri : null
		}
		const validateURI = (uriStr: unknown) => validateURIWithRoot(uriStr, getWorkspaceRoot())
		const validateOptionalURI = (uriStr: unknown) => validateOptionalURIWithRoot(uriStr, getWorkspaceRoot())

		this.validateParams = {
			read_file: () => { throw new Error('overridden by registry') },
			ls_dir: () => { throw new Error('overridden by registry') },
			get_dir_tree: () => { throw new Error('overridden by registry') },
			search_pathnames_only: () => { throw new Error('overridden by registry') },
			search_for_files: () => { throw new Error('overridden by registry') },
			search_in_file: () => { throw new Error('overridden by registry') },
			go_to_definition: () => { throw new Error('overridden by registry') },
			go_to_usages: () => { throw new Error('overridden by registry') },
			read_lint_errors: () => { throw new Error('overridden by registry') },

			// ---

			create_file_or_folder: () => { throw new Error('overridden by registry') },
			delete_file_or_folder: () => { throw new Error('overridden by registry') },
			rename_file_or_folder: () => { throw new Error('overridden by registry') },
			rewrite_file: () => { throw new Error('overridden by registry') },
			edit_file: () => { throw new Error('overridden by registry') },

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

			fetch_url: (params: RawToolParamsObj) => {
				const { url: urlUnknown } = params;
				const url = validateStr('url', urlUnknown);
				if (!/^https?:\/\//i.test(url)) {
					throw new Error(`Invalid URL: "${url}". URL must start with http:// or https://.`);
				}
				return { url };
			},

			semantic_search: (params: RawToolParamsObj) => {
				const { query: queryUnknown, n_results: nResultsUnknown, include_pattern: includePatternUnknown } = params
				const query = validateStr('query', queryUnknown)
				const nResults = validateNumber(nResultsUnknown, { default: 10 }) ?? 10
				const includePattern = isFalsy(includePatternUnknown) ? null : validateStr('include_pattern', includePatternUnknown)
				return { query, nResults, includePattern }
			},

			search_history: (params: RawToolParamsObj) => {
				const { query: queryUnknown, tool_name: toolNameUnknown, result_status: resultStatusUnknown, context_radius: contextRadiusUnknown } = params
				const query = isFalsy(queryUnknown) ? null : validateStr('query', queryUnknown)
				const toolName = isFalsy(toolNameUnknown) ? null : validateStr('toolName', toolNameUnknown)
				const resultStatus = isFalsy(resultStatusUnknown) ? null : (resultStatusUnknown === 'error' || resultStatusUnknown === 'success' ? resultStatusUnknown : null) as 'error' | 'success' | null
				const contextRadiusRaw = validateNumber(contextRadiusUnknown, { default: 3 })
				const contextRadius = Math.max(1, Math.min(contextRadiusRaw ?? 3, 10))
				return { query, toolName, resultStatus, contextRadius }
			},

			load_skill: (params: RawToolParamsObj) => {
				const { skill_name: skillNameUnknown } = params
				const skillName = validateStr('skill_name', skillNameUnknown)
				return { skillName }
			},

		}


		this.callTool = {
			read_file: async () => { throw new Error('overridden by registry') },
			ls_dir: async () => { throw new Error('overridden by registry') },
			get_dir_tree: async () => { throw new Error('overridden by registry') },
			search_pathnames_only: async () => { throw new Error('overridden by registry') },
			search_for_files: async () => { throw new Error('overridden by registry') },
			search_in_file: async () => { throw new Error('overridden by registry') },
			go_to_definition: async () => { throw new Error('overridden by registry') },
			go_to_usages: async () => { throw new Error('overridden by registry') },
			read_lint_errors: async () => { throw new Error('overridden by registry') },

			// ---

			create_file_or_folder: async () => { throw new Error('overridden by registry') },
			delete_file_or_folder: async () => { throw new Error('overridden by registry') },
			rename_file_or_folder: async () => { throw new Error('overridden by registry') },
			rewrite_file: async () => { throw new Error('overridden by registry') },
			edit_file: async () => { throw new Error('overridden by registry') },
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},

			fetch_url: async ({ url }) => {
				const result = await this.fetchUrlService.fetchUrl(url);
				return { result };
			},

			semantic_search: async ({ query, nResults, includePattern }) => {
				const { ISemanticIndexService } = await import('./semanticIndexService.js')
				const semanticIndexService = this.instantiationService.invokeFunction(accessor => accessor.get(ISemanticIndexService))
				const { results, noResultReason } = await semanticIndexService.search(query, nResults, includePattern ?? undefined)
				return { result: { results, noResultReason } }
			},

			search_history: async ({ query, toolName, resultStatus, contextRadius }) => {
				const { IChatThreadService } = await import('./chatThreadService.js')
				const chatThreadService = this.instantiationService.invokeFunction(accessor => accessor.get(IChatThreadService))
				const thread = chatThreadService.getCurrentThread()
				if (!thread) {
					return { result: { matches: 'No active conversation thread.', totalMatches: 0 } }
				}
				const messages = thread.messages
				const queryLower = query?.toLowerCase() ?? null

				// Find matching message indices
				const matchIndices: number[] = []

				for (let i = 0; i < messages.length; i++) {
					const msg = messages[i]

					// Filter by tool_name
					if (toolName && msg.role !== 'tool') continue
					if (toolName && msg.role === 'tool' && msg.name !== toolName) continue

					// Filter by result_status
					if (resultStatus && msg.role !== 'tool') continue
					if (resultStatus && msg.role === 'tool') {
						if (resultStatus === 'error' && msg.type !== 'tool_error') continue
						if (resultStatus === 'success' && msg.type !== 'success') continue
					}

					// Text search
					if (queryLower) {
						let textToSearch = ''
						if (msg.role === 'user') textToSearch = (msg.content ?? '') + ' ' + (msg.displayContent ?? '')
						else if (msg.role === 'assistant') textToSearch = (msg.displayContent ?? '') + ' ' + (msg.reasoning ?? '')
						else if (msg.role === 'tool') {
							textToSearch = (msg.content ?? '')
								+ ' ' + JSON.stringify(msg.rawParams ?? {})
								+ ' ' + (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? {}))
						}

						if (!textToSearch.toLowerCase().includes(queryLower)) continue
					}

					// If no filters at all, skip (don't return everything)
					if (!queryLower && !toolName && !resultStatus) continue

					matchIndices.push(i)
				}

				if (matchIndices.length === 0) {
					return { result: { matches: 'No matching messages found.', totalMatches: 0 } }
				}

				// Build context windows around matches, merging overlapping ranges
				const maxMatches = 20
				const limitedIndices = matchIndices.slice(0, maxMatches)

				// Collect unique message indices to include
				const includeIndices = new Set<number>()
				for (const idx of limitedIndices) {
					for (let j = Math.max(0, idx - contextRadius); j <= Math.min(messages.length - 1, idx + contextRadius); j++) {
						includeIndices.add(j)
					}
				}

				// Format messages
				const formatMessage = (msg: ChatMessage, idx: number): string => {
					const prefix = `[${idx}]`
					if (msg.role === 'user') {
						return `${prefix} [USER]: ${(msg.displayContent || msg.content || '(empty)').slice(0, 500)}`
					} else if (msg.role === 'assistant') {
						const content = msg.displayContent || msg.reasoning || '(empty)'
						const reasoning = (!msg.displayContent && msg.reasoning) ? '' : msg.reasoning ? `\n  Reasoning: ${msg.reasoning.slice(0, 300)}` : ''
						return `${prefix} [ASSISTANT]: ${content.slice(0, 500)}${reasoning}`
					} else if (msg.role === 'tool') {
						const paramsStr = JSON.stringify(msg.rawParams ?? {}).slice(0, 300)
						const resultStr = ('result' in msg ? (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? {})) : '(no result yet)').slice(0, 500)
						return `${prefix} [TOOL:${msg.name} type=${msg.type}]: params=${paramsStr}\n  result=${resultStr}`
					} else if (msg.role === 'interrupted_streaming_tool') {
						return `${prefix} [INTERRUPTED:${msg.name}]`
					} else {
						return `${prefix} [UNKNOWN]`
					}
				}

				const sortedIndices = Array.from(includeIndices).sort((a, b) => a - b)
				const formattedLines = sortedIndices.map(idx => formatMessage(messages[idx], idx))
				const matches = formattedLines.join('\n\n')

				return { result: { matches, totalMatches: matchIndices.length } }
			},

			load_skill: async ({ skillName }) => {
				// Strip frontmatter and return body
				const stripFrontmatter = (content: string) => {
					const bodyMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)
					return (bodyMatch ? bodyMatch[1] : content).trim()
				}
				// Try each candidate path: workspace .void/skills/ then global ~/.void/skills/
				// Supports both <name>/SKILL.md (directory) and <name>.md (flat file)
				const candidateUris: URI[] = []
				for (const folder of workspaceContextService.getWorkspace().folders) {
					candidateUris.push(URI.joinPath(folder.uri, '.void', 'skills', skillName, 'SKILL.md'))
					candidateUris.push(URI.joinPath(folder.uri, '.void', 'skills', `${skillName}.md`))
				}
				const userHome = await this.pathService.userHome()
				candidateUris.push(URI.joinPath(userHome, '.void', 'skills', skillName, 'SKILL.md'))
				candidateUris.push(URI.joinPath(userHome, '.void', 'skills', `${skillName}.md`))

				for (const uri of candidateUris) {
					if (await fileService.exists(uri)) {
						const content = (await fileService.readFile(uri)).value.toString()
						return { result: { content: stripFrontmatter(content) } }
					}
				}
				return { result: { content: `Skill "${skillName}" not found. Check the AVAILABLE SKILLS section for the correct name.` } }
			},
		}


		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: () => { throw new Error('overridden by registry') },
			ls_dir: () => { throw new Error('overridden by registry') },
			get_dir_tree: () => { throw new Error('overridden by registry') },
			search_pathnames_only: () => { throw new Error('overridden by registry') },
			search_for_files: () => { throw new Error('overridden by registry') },
			search_in_file: () => { throw new Error('overridden by registry') },
			go_to_definition: () => { throw new Error('overridden by registry') },
			go_to_usages: () => { throw new Error('overridden by registry') },
			read_lint_errors: () => { throw new Error('overridden by registry') },
			// ---
			create_file_or_folder: () => { throw new Error('overridden by registry') },
			delete_file_or_folder: () => { throw new Error('overridden by registry') },
			rename_file_or_folder: () => { throw new Error('overridden by registry') },
			edit_file: () => { throw new Error('overridden by registry') },
			rewrite_file: () => { throw new Error('overridden by registry') },
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},

			fetch_url: (_params, result) => {
				return `# ${result.title}\n\nSource: ${result.url}\n\n${result.content}`;
			},

			semantic_search: (_params, result) => {
				const statusNote = result.results.length > 0 && result.results[0].indexStatus === 'indexing'
					? `\nNote: Index is still being built (${result.results[0].indexProgress.indexed}/${result.results[0].indexProgress.total} files indexed). Results may be incomplete.`
					: ''
				const reasonMap: Record<string, string> = {
					'disabled': ' Semantic search is disabled in settings.',
					'noModel': ' No embedding model configured. Add a model with supportsEmbedding: true in Void settings.',
					'notReady': ' Index is not built yet. Wait for indexing to complete.',
				}
				const reasonNote = result.results.length === 0 && result.noResultReason ? reasonMap[result.noResultReason] ?? '' : ''
				if (result.results.length === 0) return `No semantic search results found.${reasonNote}${statusNote}`
				const lines = result.results.map((r, i) => {
					const scoreStr = r.score.toFixed(2)
					return `${i + 1}. ${r.uri.fsPath}:${r.startLine}-${r.endLine} (score: ${scoreStr})\n\`\`\`\n${r.snippet}\n\`\`\``
				})
				return `Found ${result.results.length} result(s):\n\n${lines.join('\n\n')}${statusNote}`
			},

			search_history: (_params, result) => {
				const totalStr = result.totalMatches > 20 ? ` (showing first 20 of ${result.totalMatches})` : ''
				return `Found ${result.totalMatches} matching message(s)${totalStr}:\n\n${result.matches}`
			},

			load_skill: (_params, result) => {
				return result.content
			},
		}


		// --- Tool registry delegation ---
		// Build ToolCtx from injected services so converted tools can access DI.
		const toolCtx: ToolCtx = {
			fileService,
			workspaceContextService,
			searchService,
			queryBuilder,
			voidModelService,
			editCodeService,
			terminalToolService: this.terminalToolService,
			commandBarService: this.commandBarService,
			directoryStrService: this.directoryStrService,
			markerService: this.markerService,
			voidSettingsService: this.voidSettingsService,
			languageFeaturesService,
			fetchUrlService: this.fetchUrlService,
			pathService: this.pathService,
			instantiationService: this.instantiationService,
			validateURI,
			validateOptionalURI,
		}

		// Override entries for converted tools with registry delegations.
		// Unconverted tools keep using the inline maps above.
		if (toolDefinitionOfToolName.read_file) {
			const d = toolDefinitionOfToolName.read_file
			this.validateParams.read_file = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.read_file = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.read_file = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.ls_dir) {
			const d = toolDefinitionOfToolName.ls_dir
			this.validateParams.ls_dir = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.ls_dir = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.ls_dir = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.get_dir_tree) {
			const d = toolDefinitionOfToolName.get_dir_tree
			this.validateParams.get_dir_tree = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.get_dir_tree = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.get_dir_tree = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.search_pathnames_only) {
			const d = toolDefinitionOfToolName.search_pathnames_only
			this.validateParams.search_pathnames_only = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.search_pathnames_only = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.search_pathnames_only = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.search_for_files) {
			const d = toolDefinitionOfToolName.search_for_files
			this.validateParams.search_for_files = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.search_for_files = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.search_for_files = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.search_in_file) {
			const d = toolDefinitionOfToolName.search_in_file
			this.validateParams.search_in_file = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.search_in_file = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.search_in_file = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.go_to_definition) {
			const d = toolDefinitionOfToolName.go_to_definition
			this.validateParams.go_to_definition = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.go_to_definition = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.go_to_definition = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.go_to_usages) {
			const d = toolDefinitionOfToolName.go_to_usages
			this.validateParams.go_to_usages = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.go_to_usages = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.go_to_usages = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.read_lint_errors) {
			const d = toolDefinitionOfToolName.read_lint_errors
			this.validateParams.read_lint_errors = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.read_lint_errors = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.read_lint_errors = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.create_file_or_folder) {
			const d = toolDefinitionOfToolName.create_file_or_folder
			this.validateParams.create_file_or_folder = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.create_file_or_folder = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.create_file_or_folder = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.delete_file_or_folder) {
			const d = toolDefinitionOfToolName.delete_file_or_folder
			this.validateParams.delete_file_or_folder = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.delete_file_or_folder = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.delete_file_or_folder = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.rename_file_or_folder) {
			const d = toolDefinitionOfToolName.rename_file_or_folder
			this.validateParams.rename_file_or_folder = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.rename_file_or_folder = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.rename_file_or_folder = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.edit_file) {
			const d = toolDefinitionOfToolName.edit_file
			this.validateParams.edit_file = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.edit_file = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.edit_file = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.rewrite_file) {
			const d = toolDefinitionOfToolName.rewrite_file
			this.validateParams.rewrite_file = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.rewrite_file = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.rewrite_file = (params, result) => d.stringOfResult(params, result, toolCtx)
		}

	}

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
