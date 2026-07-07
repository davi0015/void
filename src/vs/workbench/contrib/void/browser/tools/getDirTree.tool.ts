import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'

export const getDirTreeToolCore: ToolDefinitionCore<'get_dir_tree'> = {
	name: 'get_dir_tree',
	description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
	params: {
		uri: { description: `Path to the folder. Can be absolute (e.g. \`/Users/you/project/src\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr } = raw
		const uri = ctx.validateURI(uriStr)
		return { uri }
	},

	callTool: async ({ uri }, ctx) => {
		const str = await ctx.directoryStrService.getDirectoryStrTool(uri)
		return { result: { str } }
	},

	stringOfResult: (_params, result) => {
		return result.str
	},

	title: { done: 'Inspected folder tree', proposed: 'Inspect folder tree', running: 'Inspecting folder tree' },
}
