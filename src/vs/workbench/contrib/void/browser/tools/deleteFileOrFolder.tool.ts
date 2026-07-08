import { URI } from '../../../../../base/common/uri.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateBoolean, checkIfIsFolder } from './toolHelpers.js'

export const deleteFileOrFolderToolCore: ToolDefinitionCore<'delete_file_or_folder'> = {
	name: 'delete_file_or_folder',
	description: `Delete a file or folder at the given path.`,
	params: {
		uri: { description: `Path to the file or folder. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		is_recursive: { description: 'Optional. Return true to delete recursively.' }
	},
	approvalType: 'delete',

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = raw
		const uri = ctx.validateURI(uriUnknown)
		const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
		const uriStr = validateStr('uri', uriUnknown)
		const isFolder = checkIfIsFolder(uriStr)
		return { uri, isRecursive, isFolder }
	},

	callTool: async ({ uri, isRecursive }, ctx) => {
		// Clean up any pending diffs for the file (or files under the folder)
		// before deletion, so the diff UI doesn't reference stale URIs.
		const uriPath = uri.fsPath
		for (const trackedPath of Object.keys(ctx.editCodeService.diffAreasOfURI)) {
			if (trackedPath === uriPath || (isRecursive && trackedPath.startsWith(uriPath + '/'))) {
				const trackedUri = URI.file(trackedPath)
				ctx.editCodeService.acceptOrRejectAllDiffAreas({ uri: trackedUri, removeCtrlKs: true, behavior: 'accept', _addToHistory: false })
			}
		}
		await ctx.fileService.del(uri, { recursive: isRecursive })
		return { result: {} }
	},

	stringOfResult: (params, result) => {
		return `URI ${params.uri.fsPath} successfully deleted.`
	},

	title: { done: 'Deleted', proposed: 'Delete', running: 'Deleting' },
}
