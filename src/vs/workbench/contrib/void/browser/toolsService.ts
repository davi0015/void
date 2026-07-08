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
import type { ToolCtx } from './tools/toolTypes.js'
import { validateURIWithRoot, validateOptionalURIWithRoot } from './tools/toolHelpers.js'

// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams!: ValidateBuiltinParams;
	public callTool!: CallBuiltinTool;
	public stringOfResult!: BuiltinToolResultToString;

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

		// Build dispatch maps from the registry. Object.fromEntries + cast is
		// necessary because TypeScript loses the key-value type correlation through
		// iteration (the mapped type { [T in K]: V<T> } collapses to an intersection
		// when indexed with the full union K). The cast is on the result, not on
		// individual values.
		const entries = Object.entries(toolDefinitionOfToolName)
		this.validateParams = Object.fromEntries(entries.map(([name, def]) =>
			[name, (raw: RawToolParamsObj) => def.validateParams(raw, toolCtx)]
		)) as ValidateBuiltinParams
		this.callTool = Object.fromEntries(entries.map(([name, def]) =>
			[name, (params: never) => def.callTool(params, toolCtx)]
		)) as CallBuiltinTool
		this.stringOfResult = Object.fromEntries(entries.map(([name, def]) =>
			[name, (params: never, result: never) => def.stringOfResult(params, result, toolCtx)]
		)) as BuiltinToolResultToString

	}

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
