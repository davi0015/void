import { URI } from '../../../../../base/common/uri.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateBoolean } from './toolHelpers.js'

export const renameFileOrFolderToolCore: ToolDefinitionCore<'rename_file_or_folder'> = {
	name: 'rename_file_or_folder',
	description: `Rename or move a file or folder from one path to another.`,
	params: {
		source_uri: { description: `Path of the existing file or folder to rename/move. Can be absolute or relative to the workspace root.` },
		target_uri: { description: `New path for the file or folder. Can be absolute or relative to the workspace root.` },
		overwrite: { description: 'Optional. Set to true to overwrite the target if it already exists. Default is false.' },
	},
	approvalType: 'edits',

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { source_uri: sourceUnknown, target_uri: targetUnknown, overwrite: overwriteUnknown } = raw
		const sourceUri = ctx.validateURI(sourceUnknown)
		const targetUri = ctx.validateURI(targetUnknown)
		const overwrite = validateBoolean(overwriteUnknown, { default: false })
		return { sourceUri, targetUri, overwrite }
	},

	callTool: async ({ sourceUri, targetUri, overwrite }, ctx) => {
		// Clean up any pending diffs for the source before moving
		const sourcePath = sourceUri.fsPath
		for (const trackedPath of Object.keys(ctx.editCodeService.diffAreasOfURI)) {
			if (trackedPath === sourcePath || trackedPath.startsWith(sourcePath + '/')) {
				const trackedUri = URI.file(trackedPath)
				ctx.editCodeService.acceptOrRejectAllDiffAreas({ uri: trackedUri, removeCtrlKs: true, behavior: 'accept', _addToHistory: false })
			}
		}
		await ctx.fileService.move(sourceUri, targetUri, overwrite)
		return { result: {} }
	},

	stringOfResult: (params, result) => {
		return `Successfully renamed ${params.sourceUri.fsPath} to ${params.targetUri.fsPath}.`
	},

	title: { done: 'Renamed', proposed: 'Rename', running: 'Renaming' },
}
