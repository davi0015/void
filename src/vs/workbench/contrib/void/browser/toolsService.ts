import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js'
import { Position } from '../../../../editor/common/core/position.js'
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js'
import { getDefinitionsAtPosition, getReferencesAtPosition } from '../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { AUTO_OUTLINE_THRESHOLD, MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const safeFence = (content: string): string => {
	let maxRun = 2
	const re = /`{3,}/g
	let m: RegExpExecArray | null
	while ((m = re.exec(content)) !== null) {
		if (m[0].length > maxRun) maxRun = m[0].length
	}
	return '`'.repeat(maxRun + 1)
}

const validateStr = (argName: string, value: unknown) => {
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

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
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

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
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
const resolveSymbolPosition = (model: ITextModel, symbolName: string, lineHint: number | null): { line: number, column: number } | null => {
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

async function getFileOutline(
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
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

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
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			go_to_definition: (params: RawToolParamsObj) => {
				const { uri: uriStr, symbol_name: symbolNameUnknown, line: lineUnknown } = params
				const uri = validateURI(uriStr)
				const symbolName = validateStr('symbol_name', symbolNameUnknown)
				const line = validateNumber(lineUnknown, { default: null })
				if (line !== null && line < 1) throw new Error(`\`line\` must be 1 or greater, got ${line}.`)
				return { uri, symbolName, line }
			},

			go_to_usages: (params: RawToolParamsObj) => {
				const { uri: uriStr, symbol_name: symbolNameUnknown, line: lineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const symbolName = validateStr('symbol_name', symbolNameUnknown)
				const line = validateNumber(lineUnknown, { default: null })
				if (line !== null && line < 1) throw new Error(`\`line\` must be 1 or greater, got ${line}.`)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, symbolName, line, pageNumber }
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

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

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }

				const totalNumLines = model.getLineCount()

				if (startLine === null && endLine === null && pageNumber === 1 && this.voidSettingsService.state.globalSettings.autoOutlineReadFile) {
					const fullContent = model.getValue(EndOfLinePreference.LF)
					if (fullContent.length > AUTO_OUTLINE_THRESHOLD) {
						const outlineText = await getFileOutline(model, languageFeaturesService, uri)
						if (outlineText !== null) {
							return { result: { outlined: true as const, outlineText, totalFileLen: fullContent.length, totalNumLines } }
						}
						// No outline available — return first ~1KB as fallback
						const truncated = fullContent.slice(0, 1024)
						const fallbackText = `(No symbol outline available for this file type. Showing first ~1KB.)\n\n${truncated}`
						return { result: { outlined: true as const, outlineText: fallbackText, totalFileLen: fullContent.length, totalNumLines } }
					}
				}

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { outlined: false as const, fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await voidModelService.initializeModel(uri);
				const { model } = await voidModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			go_to_definition: async ({ uri, symbolName, line }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) throw new Error(`File does not exist: ${uri.fsPath}.`)

				// Position resolution:
				//  1. If `line` is given AND in range AND the symbol is on that line (word-boundary
				//     match), use it. This is the most reliable mode — the agent has seen the symbol.
				//  2. Otherwise (null / out of range / symbol not on that line), fall back to scanning
				//     the file for the first whole-word occurrence. Safe for unique names; documented
				//     in the tool description so agents know when this is safe.
				//  3. If the symbol doesn't appear anywhere in the file, error.
				const position = resolveSymbolPosition(model, symbolName, line)
				if (position === null) throw new Error(`Symbol \`${symbolName}\` not found anywhere in ${uri.fsPath}. Check the spelling of the symbol or the file path.`)

				const providers = languageFeaturesService.definitionProvider.ordered(model)
				if (providers.length === 0) throw new Error(`No LSP definition provider is registered for ${model.getLanguageId()} files. Use \`search_in_file\` or \`search_for_files\` with \`${symbolName}\` as the query instead.`)

				const links = await getDefinitionsAtPosition(
					languageFeaturesService.definitionProvider,
					model,
					new Position(position.line, position.column),
					false,
					CancellationToken.None,
				)

				// Pre-initialize target models so the stringifier can synchronously read
				// a preview line for each location (matching the search_in_file pattern).
				await Promise.all(
					[...new Set(links.map(l => l.uri.toString()))].map(s => voidModelService.initializeModel(URI.parse(s)))
				)

				const locations = links.map(link => ({
					uri: link.uri,
					line: link.range.startLineNumber,
					column: link.range.startColumn,
				}))
				return { result: { locations } }
			},

			go_to_usages: async ({ uri, symbolName, line, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) throw new Error(`File does not exist: ${uri.fsPath}.`)

				const position = resolveSymbolPosition(model, symbolName, line)
				if (position === null) throw new Error(`Symbol \`${symbolName}\` not found anywhere in ${uri.fsPath}. Check the spelling of the symbol or the file path.`)

				const providers = languageFeaturesService.referenceProvider.ordered(model)
				if (providers.length === 0) throw new Error(`No LSP reference provider is registered for ${model.getLanguageId()} files. Use \`search_for_files\` with \`${symbolName}\` as the query instead.`)

				// `compact: false` keeps declaration in the result list (matches Shift+F12);
				// `recursive: false` matches the default VS Code "Find All References" command.
				const links = await getReferencesAtPosition(
					languageFeaturesService.referenceProvider,
					model,
					new Position(position.line, position.column),
					false,
					false,
					CancellationToken.None,
				)

				// Paginate at the same page size as search_for_files / ls_dir.
				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const pageLinks = links.slice(fromIdx, toIdx + 1)
				const hasNextPage = (links.length - 1) - toIdx >= 1

				await Promise.all(
					[...new Set(pageLinks.map(l => l.uri.toString()))].map(s => voidModelService.initializeModel(URI.parse(s)))
				)

				const locations = pageLinks.map(link => ({
					uri: link.uri,
					line: link.range.startLineNumber,
					column: link.range.startColumn,
				}))
				return { result: { locations, hasNextPage } }
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				// Check file existence BEFORE `initializeModel` — the latter silently
				// swallows FileNotFound (catches and logs) and returns void, making the
				// whole chain (initializeModel → instantlyRewriteFile → _startStreamingDiffZone
				// → "if (!model) return") fall through quietly. Net result before this
				// fix: agent sees "Change successfully made" with zero lint errors, but
				// nothing actually got written. Reported by the user as "rewrite_file
				// only works after create_file_or_folder is called, otherwise it
				// returns without error". Auto-creating here matches the intent of
				// `rewrite_file` (produce a file with the given contents) and aligns
				// with user preference for this tool specifically.
				if (!(await fileService.exists(uri))) {
					await fileService.createFile(uri)
				}
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				// Same silent-fallthrough issue as rewrite_file (see comment there),
				// but the right behavior is different: edit_file uses search/replace
				// blocks which require existing content to match against. Auto-creating
				// an empty file would make every search block fail to match — silent
				// no-op again. Throwing a clear error is the honest behavior and
				// nudges the agent toward the right alternative (rewrite_file for
				// wholesale new-file authoring, create_file_or_folder + edit_file
				// for incremental build-up).
				if (!(await fileService.exists(uri))) {
					throw new Error(`File not found at ${uri.fsPath}. edit_file requires an existing file to apply search/replace blocks against. Use rewrite_file to create a new file with full contents, or create_file_or_folder first then edit_file.`)
				}
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},
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
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				if (result.outlined) {
					return `SUCCESS: File outline retrieved for ${params.uri.fsPath} (${result.totalNumLines} lines, ${result.totalFileLen} characters).\nThis file is too large to read all at once. The outline below shows the file's structure with line numbers.\n\nIMPORTANT: Do NOT retry this call without line numbers — you will get the same outline.\nUse start_line and end_line to read specific sections.\n\n${result.outlineText}\n\nNEXT STEPS: To read a specific section, call read_file with the same path plus start_line and end_line from the outline above.`
				}
				const fence = safeFence(result.fileContents)
				return `${params.uri.fsPath}\n${fence}\n${result.fileContents}\n${fence}${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voidModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			go_to_definition: (params, result) => {
				if (result.locations.length === 0) {
					return `No definition found for \`${params.symbolName}\` on ${params.uri.fsPath}:${params.line}. This can happen for built-in or primitive types. If you believe this is wrong, try \`search_in_file\` or \`search_for_files\` with \`${params.symbolName}\` as the query.`
				}
				const header = result.locations.length === 1
					? `Found 1 definition of \`${params.symbolName}\`:`
					: `Found ${result.locations.length} definitions of \`${params.symbolName}\`:`
				const lines = result.locations.map((loc, i) => {
					const { model } = voidModelService.getModel(loc.uri)
					const preview = model ? model.getLineContent(loc.line).trim() : '<preview unavailable>'
					return `${i + 1}. ${loc.uri.fsPath}:${loc.line}:${loc.column}  ${preview}`
				})
				return [header, ...lines].join('\n')
			},
			go_to_usages: (params, result) => {
				if (result.locations.length === 0) {
					return `No usages found for \`${params.symbolName}\` on ${params.uri.fsPath}:${params.line}. If you believe this is wrong, try \`search_for_files\` with \`${params.symbolName}\` as the query.`
				}
				const header = `Found ${result.locations.length} ${result.locations.length === 1 ? 'usage' : 'usages'} of \`${params.symbolName}\`${result.hasNextPage ? ' (more on next page)' : ''}:`
				const lines = result.locations.map((loc, i) => {
					const { model } = voidModelService.getModel(loc.uri)
					const preview = model ? model.getLineContent(loc.line).trim() : '<preview unavailable>'
					return `${i + 1}. ${loc.uri.fsPath}:${loc.line}:${loc.column}  ${preview}`
				})
				const footer = result.hasNextPage ? '\n\n(More usages available. Call again with `page_number` incremented by 1 to see them.)' : ''
				return [header, ...lines].join('\n') + footer
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
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
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
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


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
