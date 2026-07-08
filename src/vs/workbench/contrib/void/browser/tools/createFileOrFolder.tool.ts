import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, checkIfIsFolder } from './toolHelpers.js'

export const createFileOrFolderToolCore: ToolDefinitionCore<'create_file_or_folder'> = {
	name: 'create_file_or_folder',
	description: `Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.`,
	params: {
		uri: { description: `Path to the file or folder. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
	},
	approvalType: 'edits',

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriUnknown } = raw
		const uri = ctx.validateURI(uriUnknown)
		const uriStr = validateStr('uri', uriUnknown)
		const isFolder = checkIfIsFolder(uriStr)
		return { uri, isFolder }
	},

	callTool: async ({ uri, isFolder }, ctx) => {
		if (isFolder)
			await ctx.fileService.createFolder(uri)
		else {
			await ctx.fileService.createFile(uri)
		}
		return { result: {} }
	},

	stringOfResult: (params, result) => {
		return `URI ${params.uri.fsPath} successfully created.`
	},

	title: { done: 'Created', proposed: 'Create', running: 'Creating' },
}
