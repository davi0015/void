import { timeout } from '../../../../../base/common/async.js'
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js'
import { LintErrorItem } from '../../common/toolsServiceTypes.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { stringifyLintErrors } from './toolHelpers.js'

export const readLintErrorsToolCore: ToolDefinitionCore<'read_lint_errors'> = {
	name: 'read_lint_errors',
	description: `Use this tool to view all the lint errors on a file.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriUnknown } = raw
		const uri = ctx.validateURI(uriUnknown)
		return { uri }
	},

	callTool: async ({ uri }, ctx) => {
		await timeout(1000)
		const lintErrors = ctx.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		return { result: { lintErrors: lintErrors.length ? lintErrors : null } }
	},

	stringOfResult: (_params, result) => {
		return result.lintErrors ?
			stringifyLintErrors(result.lintErrors)
			: 'No lint errors found.'
	},

	title: { done: 'Read lint errors', proposed: 'Read lint errors', running: 'Reading lint errors' },
}
