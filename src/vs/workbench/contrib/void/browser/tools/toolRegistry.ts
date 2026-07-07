import { BuiltinToolName } from '../../common/toolsServiceTypes.js'
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
}


// Whether a tool has been migrated to the new per-file definition.
export const isConvertedTool = (toolName: BuiltinToolName): boolean => {
	return toolName in toolDefinitionOfToolName
}
