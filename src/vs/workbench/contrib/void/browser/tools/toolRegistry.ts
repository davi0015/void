import { BuiltinToolName, isToolAvailableInChatMode, levelOfChatMode } from '../../common/toolsServiceTypes.js'
import { InternalToolInfo, builtinToolNames } from '../../common/prompt/prompts.js'
import { ChatMode } from '../../common/voidSettingsTypes.js'
import { ToolDefinitionCore } from './toolTypes.js'
import { readFileToolCore } from './readFile.tool.js'
import { lsDirToolCore } from './lsDir.tool.js'
import { getDirTreeToolCore } from './getDirTree.tool.js'
import { searchPathnamesOnlyToolCore } from './searchPathnamesOnly.tool.js'
import { searchForFilesToolCore } from './searchForFiles.tool.js'
import { searchInFileToolCore } from './searchInFile.tool.js'
import { goToDefinitionToolCore } from './goToDefinition.tool.js'
import { goToUsagesToolCore } from './goToUsages.tool.js'
import { readLintErrorsToolCore } from './readLintErrors.tool.js'
import { createFileOrFolderToolCore } from './createFileOrFolder.tool.js'
import { deleteFileOrFolderToolCore } from './deleteFileOrFolder.tool.js'
import { renameFileOrFolderToolCore } from './renameFileOrFolder.tool.js'
import { editFileToolCore } from './editFile.tool.js'
import { rewriteFileToolCore } from './rewriteFile.tool.js'
import { runCommandToolCore } from './runCommand.tool.js'
import { runPersistentCommandToolCore } from './runPersistentCommand.tool.js'
import { openPersistentTerminalToolCore } from './openPersistentTerminal.tool.js'
import { killPersistentTerminalToolCore } from './killPersistentTerminal.tool.js'
import { readTerminalToolCore } from './readTerminal.tool.js'
import { fetchUrlToolCore } from './fetchUrl.tool.js'
import { semanticSearchToolCore } from './semanticSearch.tool.js'
import { searchHistoryToolCore } from './searchHistory.tool.js'
import { loadSkillToolCore } from './loadSkill.tool.js'
import { runSubagentToolCore } from './runSubagent.tool.js'
import { listChildrenToolCore, sendMessageToolCore } from './childSteering.tool.js'


export const toolDefinitionOfToolName: Partial<{ [T in BuiltinToolName]: ToolDefinitionCore<T> }> = {
	read_file: readFileToolCore,
	ls_dir: lsDirToolCore,
	get_dir_tree: getDirTreeToolCore,
	search_pathnames_only: searchPathnamesOnlyToolCore,
	search_for_files: searchForFilesToolCore,
	search_in_file: searchInFileToolCore,
	go_to_definition: goToDefinitionToolCore,
	go_to_usages: goToUsagesToolCore,
	read_lint_errors: readLintErrorsToolCore,
	create_file_or_folder: createFileOrFolderToolCore,
	delete_file_or_folder: deleteFileOrFolderToolCore,
	rename_file_or_folder: renameFileOrFolderToolCore,
	edit_file: editFileToolCore,
	rewrite_file: rewriteFileToolCore,
	run_command: runCommandToolCore,
	run_persistent_command: runPersistentCommandToolCore,
	open_persistent_terminal: openPersistentTerminalToolCore,
	kill_persistent_terminal: killPersistentTerminalToolCore,
	read_terminal: readTerminalToolCore,
	fetch_url: fetchUrlToolCore,
	semantic_search: semanticSearchToolCore,
	search_history: searchHistoryToolCore,
	load_skill: loadSkillToolCore,
	run_subagent: runSubagentToolCore,
	send_message: sendMessageToolCore,
	list_children: listChildrenToolCore,
}


// Whether a tool has been migrated to the new per-file definition.
export const isConvertedTool = (toolName: BuiltinToolName): boolean => {
	return toolName in toolDefinitionOfToolName
}

// Resolve the effective tool list for a given chat mode. Builtin tool info
// (name, description, params) is sourced from the per-file registry — no more
// duplicated descriptions in prompts.ts. MCP tools are included from `agent` up:
// below it a mode is not allowed to act on the world, and an MCP tool is an
// arbitrary one.
//
// Which names a mode may use is `isToolAvailableInChatMode` (in `common/`, because
// it is a rule rather than a lookup and the node tier covers it). This function is
// only the part that needs the registry: turning names into definitions.
export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined): InternalToolInfo[] | undefined => {
	const availableNames = chatMode === null
		? undefined
		: builtinToolNames.filter(toolName => isToolAvailableInChatMode(toolName, chatMode))
	// "This mode has no tools" is `undefined` to the rest of the pipeline, and `normal`
	// filters down to nothing — so normalise empty to absent rather than handing on an
	// empty array that reads as a mode with a tool list.
	const builtinNames: BuiltinToolName[] | undefined = availableNames && availableNames.length > 0 ? availableNames : undefined

	const effectiveBuiltinTools = builtinNames?.map(name => {
		const def = toolDefinitionOfToolName[name]!
		return {
			name: def.name,
			description: def.description,
			params: def.params as { [paramName: string]: { description: string } },
		}
	}) ?? undefined

	const effectiveMCPTools = chatMode !== null && levelOfChatMode[chatMode] >= levelOfChatMode['agent'] ? mcpTools : undefined

	const tools: InternalToolInfo[] | undefined = !(builtinNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		]

	return tools
}
