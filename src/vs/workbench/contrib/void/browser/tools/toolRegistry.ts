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
import { createFileOrFolderToolCore } from './createFileOrFolder.tool.js'
import { deleteFileOrFolderToolCore } from './deleteFileOrFolder.tool.js'
import { renameFileOrFolderToolCore } from './renameFileOrFolder.tool.js'
import { editFileToolCore } from './editFile.tool.js'
import { rewriteFileToolCore } from './rewriteFile.tool.js'


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
}


// Whether a tool has been migrated to the new per-file definition.
export const isConvertedTool = (toolName: BuiltinToolName): boolean => {
	return toolName in toolDefinitionOfToolName
}
