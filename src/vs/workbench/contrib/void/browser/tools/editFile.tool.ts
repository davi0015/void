import { timeout } from '../../../../../base/common/async.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateEdits, stringifyLintErrors, getLintErrors } from './toolHelpers.js'

const editsDescription = `\
A JSON array of edit objects. Each edit object MUST have exactly these field names:
  { "original": string, "updated": string, "delete"?: boolean }

Field names are case-sensitive and must be exactly "original", "updated", and "delete". Do NOT use "replacement", "new", "new_content", "replacement_value", or any other variant — only "updated".

- "original": lines in the file to replace. Must EXACTLY match (including whitespace), be unique, and be DISJOINT from other "original" values. Bias towards minimal length.
- "updated": the new code replacing "original". Must be non-empty unless "delete" is true — an empty "updated" without "delete": true will be rejected.
- "delete": set to true to delete the "original" code.

Correct: [{"original": "let x = 6", "updated": "let x = 6.5"}, {"original": "let y = 7", "delete": true}]
Wrong (will be rejected): [{"original": "let x = 6", "replacement": "let x = 6.5"}]`

export const editFileToolCore: ToolDefinitionCore<'edit_file'> = {
	name: 'edit_file',
	description: `Edit the contents of a file. You must provide the file's URI as well as an "edits" array of edit objects (each with "original", "updated", and optional "delete"). IMPORTANT: When editing a file multiple times, combine ALL changes into a SINGLE edit_file call with multiple edit objects in the array. Do NOT call edit_file multiple times for the same file in one turn — each call modifies the file, making subsequent "original" matches stale.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		edits: { description: editsDescription }
	},
	approvalType: 'edits',

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, edits: editsUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const edits = validateEdits(editsUnknown)
		return { uri, edits }
	},

	callTool: async ({ uri, edits }, ctx) => {
		// edit_file uses search/replace blocks which require existing content to
		// match against. Auto-creating an empty file would make every search block
		// fail to match. Throwing a clear error is the honest behavior and nudges
		// the agent toward the right alternative (rewrite_file for wholesale
		// new-file authoring, create_file_or_folder + edit_file for incremental
		// build-up).
		if (!(await ctx.fileService.exists(uri))) {
			throw new Error(`File not found at ${uri.fsPath}. edit_file requires an existing file to apply search/replace blocks against. Use rewrite_file to create a new file with full contents, or create_file_or_folder first then edit_file.`)
		}
		await ctx.voidModelService.initializeModel(uri)
		if (ctx.commandBarService.getStreamState(uri) === 'streaming') {
			throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
		}
		await ctx.editCodeService.callBeforeApplyOrEdit(uri)

		ctx.editCodeService.instantlyApplyEdits({ uri, edits })

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

	title: { done: 'Edited file', proposed: 'Edit file', running: 'Editing file' },
}
