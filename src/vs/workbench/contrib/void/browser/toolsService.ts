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

		// Override entries for converted tools with registry delegations.
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
