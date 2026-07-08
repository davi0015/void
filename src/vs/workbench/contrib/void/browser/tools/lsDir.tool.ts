import { computeDirectoryTree1Deep, stringifyDirectoryTree1Deep } from '../../common/directoryStrService.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validatePageNum } from './toolHelpers.js'

export const lsDirToolCore: ToolDefinitionCore<'ls_dir'> = {
	name: 'ls_dir',
	description: `Use this to list the files and folders directly inside a directory. For a recursive tree view, use \`get_dir_tree\` instead. Never use \`run_command\` with \`ls\` — this tool is the correct choice.`,
	params: {
		uri: { description: `Optional. Path to the folder. Can be absolute (e.g. \`/Users/you/project/src\`) or relative to the workspace root (e.g. \`src/vs/workbench\`). Leave as empty or "" to list from the workspace root.` },
		page_number: { description: 'Optional. The page number of the result. Default is 1.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, page_number: pageNumberUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const pageNumber = validatePageNum(pageNumberUnknown)
		return { uri, pageNumber }
	},

	callTool: async ({ uri, pageNumber }, ctx) => {
		const dirResult = await computeDirectoryTree1Deep(ctx.fileService, uri, pageNumber)
		return { result: dirResult }
	},

	stringOfResult: (params, result) => {
		return stringifyDirectoryTree1Deep(params, result)
	},

	title: { done: 'Inspected folder', proposed: 'Inspect folder', running: 'Inspecting folder' },
}
