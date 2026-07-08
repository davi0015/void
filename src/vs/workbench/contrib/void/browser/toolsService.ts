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
import { MAX_FILE_CHARS_PAGE } from '../common/prompt/prompts.js'
import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { IFetchUrlService } from '../common/fetchUrlService.js'


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

			run_command: () => { throw new Error('overridden by registry') },
			run_persistent_command: () => { throw new Error('overridden by registry') },
			open_persistent_terminal: () => { throw new Error('overridden by registry') },
			kill_persistent_terminal: () => { throw new Error('overridden by registry') },
			fetch_url: () => { throw new Error('overridden by registry') },
			semantic_search: () => { throw new Error('overridden by registry') },
			search_history: () => { throw new Error('overridden by registry') },
			load_skill: () => { throw new Error('overridden by registry') },

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
			run_command: async () => { throw new Error('overridden by registry') },
			run_persistent_command: async () => { throw new Error('overridden by registry') },
			open_persistent_terminal: async () => { throw new Error('overridden by registry') },
			kill_persistent_terminal: async () => { throw new Error('overridden by registry') },
			fetch_url: async () => { throw new Error('overridden by registry') },
			semantic_search: async () => { throw new Error('overridden by registry') },
			search_history: async () => { throw new Error('overridden by registry') },
			load_skill: async () => { throw new Error('overridden by registry') },

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
			run_command: () => { throw new Error('overridden by registry') },
			run_persistent_command: () => { throw new Error('overridden by registry') },
			open_persistent_terminal: () => { throw new Error('overridden by registry') },
			kill_persistent_terminal: () => { throw new Error('overridden by registry') },
			fetch_url: () => { throw new Error('overridden by registry') },
			semantic_search: () => { throw new Error('overridden by registry') },
			search_history: () => { throw new Error('overridden by registry') },
			load_skill: () => { throw new Error('overridden by registry') },
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
		if (toolDefinitionOfToolName.run_command) {
			const d = toolDefinitionOfToolName.run_command
			this.validateParams.run_command = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.run_command = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.run_command = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.run_persistent_command) {
			const d = toolDefinitionOfToolName.run_persistent_command
			this.validateParams.run_persistent_command = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.run_persistent_command = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.run_persistent_command = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.open_persistent_terminal) {
			const d = toolDefinitionOfToolName.open_persistent_terminal
			this.validateParams.open_persistent_terminal = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.open_persistent_terminal = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.open_persistent_terminal = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.kill_persistent_terminal) {
			const d = toolDefinitionOfToolName.kill_persistent_terminal
			this.validateParams.kill_persistent_terminal = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.kill_persistent_terminal = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.kill_persistent_terminal = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.fetch_url) {
			const d = toolDefinitionOfToolName.fetch_url
			this.validateParams.fetch_url = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.fetch_url = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.fetch_url = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.semantic_search) {
			const d = toolDefinitionOfToolName.semantic_search
			this.validateParams.semantic_search = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.semantic_search = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.semantic_search = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.search_history) {
			const d = toolDefinitionOfToolName.search_history
			this.validateParams.search_history = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.search_history = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.search_history = (params, result) => d.stringOfResult(params, result, toolCtx)
		}
		if (toolDefinitionOfToolName.load_skill) {
			const d = toolDefinitionOfToolName.load_skill
			this.validateParams.load_skill = (raw) => d.validateParams(raw, toolCtx)
			this.callTool.load_skill = (params) => d.callTool(params, toolCtx)
			this.stringOfResult.load_skill = (params, result) => d.stringOfResult(params, result, toolCtx)
		}

	}

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
