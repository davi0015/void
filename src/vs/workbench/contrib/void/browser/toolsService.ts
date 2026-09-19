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
import { BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js'
import { IVoidCommandBarService } from './voidCommandBarService.js'
import { IDirectoryStrService } from '../common/directoryStrService.js'
import { IMarkerService } from '../../../../platform/markers/common/markers.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { IFetchUrlService } from '../common/fetchUrlService.js'

import { toolDefinitionOfToolName } from './tools/toolRegistry.js'
import { searchWorkspacePathnames } from './tools/searchPathnames.js'
import type { ToolCtx } from './tools/toolTypes.js'
import { validateURIWithRoot, validateOptionalURIWithRoot } from './tools/toolHelpers.js'

// tool use for AI
//
// Every one of these takes the id of the thread the call is executing *for*.
// A tool acts on its executing thread, not on the one the user happens to be
// looking at, and the two only coincide while a single thread is running. The
// thread is a required argument rather than a field of `ToolCtx`'s static half
// so that a caller cannot forget it: omitting it is a type error, and a wrong
// one is visible at the call site.
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj, threadId: string) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], threadId: string) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>, threadId: string) => string }


export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;

	/**
	 * Workspace pathname search, unpaginated, for internal callers.
	 *
	 * Not the `search_pathnames_only` tool: that one pages its results because it is
	 * answering an LLM, and its core assumes params have already been through
	 * `validateParams`. `callTool` dispatches straight to the core, so an internal
	 * caller gets no coercion — the codespan resolver asked it for `pageNumber: 0`
	 * for a long time and silently received nothing for every query. Reach for this
	 * instead of `callTool` when what you want is a name rather than a page.
	 */
	searchPathnames: (opts: { query: string, includePattern?: string | null }) => Promise<URI[]>;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams!: ValidateBuiltinParams;
	public callTool!: CallBuiltinTool;
	public stringOfResult!: BuiltinToolResultToString;
	public searchPathnames!: (opts: { query: string, includePattern?: string | null }) => Promise<URI[]>;

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
		const getWorkspaceRoot = (): URI | null => {
			const folders = workspaceContextService.getWorkspace().folders
			return folders.length > 0 ? folders[0].uri : null
		}
		const validateURI = (uriStr: unknown) => validateURIWithRoot(uriStr, getWorkspaceRoot())
		const validateOptionalURI = (uriStr: unknown) => validateOptionalURIWithRoot(uriStr, getWorkspaceRoot())

		// --- Tool registry delegation ---
		// Build ToolCtx from injected services so converted tools can access DI.
		// Typed as everything-but-the-thread: this half is captured once and shared,
		// and `ctxFor` below is the only thing that can produce a whole ToolCtx.
		const toolCtx: Omit<ToolCtx, 'threadId'> = {
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

		// Build dispatch maps from the registry. Object.fromEntries + cast is
		// necessary because TypeScript loses the key-value type correlation through
		// iteration (the mapped type { [T in K]: V<T> } collapses to an intersection
		// when indexed with the full union K). The cast is on the result, not on
		// individual values.
		//
		// The context is per call rather than captured once, because the thread it
		// carries changes with every call.
		const ctxFor = (threadId: string): ToolCtx => ({ ...toolCtx, threadId })
		const entries = Object.entries(toolDefinitionOfToolName)
		this.validateParams = Object.fromEntries(entries.map(([name, def]) =>
			[name, (raw: RawToolParamsObj, threadId: string) => def.validateParams(raw, ctxFor(threadId))]
		)) as ValidateBuiltinParams
		this.callTool = Object.fromEntries(entries.map(([name, def]) =>
			[name, (params: never, threadId: string) => def.callTool(params, ctxFor(threadId))]
		)) as CallBuiltinTool
		this.stringOfResult = Object.fromEntries(entries.map(([name, def]) =>
			[name, (params: never, result: never, threadId: string) => def.stringOfResult(params, result, ctxFor(threadId))]
		)) as BuiltinToolResultToString

		// The unpaginated search, sharing one implementation with the tool above.
		this.searchPathnames = (opts) => searchWorkspacePathnames(toolCtx, opts)

	}

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
