import { timeout } from '../../../../../base/common/async.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, stringifyLintErrors, getLintErrors } from './toolHelpers.js'

export const rewriteFileToolCore: ToolDefinitionCore<'rewrite_file'> = {
	name: 'rewrite_file',
	description: `Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		new_content: { description: `The new contents of the file. Must be a string.` }
	},
	approvalType: 'edits',

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, new_content: newContentUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const newContent = validateStr('newContent', newContentUnknown)
		return { uri, newContent }
	},

	callTool: async ({ uri, newContent }, ctx) => {
		// Check file existence BEFORE `initializeModel` — the latter silently
		// swallows FileNotFound (catches and logs) and returns void, making the
		// whole chain (initializeModel → instantlyRewriteFile → _startStreamingDiffZone
		// → "if (!model) return") fall through quietly. Auto-creating here matches
		// the intent of `rewrite_file` (produce a file with the given contents).
		if (!(await ctx.fileService.exists(uri))) {
			await ctx.fileService.createFile(uri)
		}
		await ctx.voidModelService.initializeModel(uri)
		if (ctx.commandBarService.getStreamState(uri) === 'streaming') {
			throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
		}
		await ctx.editCodeService.callBeforeApplyOrEdit(uri)

		ctx.editCodeService.instantlyRewriteFile({ uri, newContent })

		// at end, get lint errors
		const lintErrorsPromise = Promise.resolve().then(async () => {
			await timeout(2000)
			const { lintErrors } = getLintErrors(ctx.markerService, uri)
			return { lintErrors }
		})
		return { result: lintErrorsPromise }
	},

	stringOfResult: (params, result, ctx) => {
		const lintErrsString = (
			ctx.voidSettingsService.state.globalSettings.includeToolLintErrors ?
				(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
					: ` No lint errors found.`)
				: '')

		return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
	},

	title: { done: 'Wrote file', proposed: 'Write file', running: 'Writing file' },
}
