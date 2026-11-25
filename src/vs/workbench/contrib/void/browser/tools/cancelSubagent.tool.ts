import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { IDelegationService } from '../../common/delegationService.js'

import { ToolDefinitionCore } from './toolTypes.js'

// The escape. A cancelled child is not a failed one: it stops where it is, keeps whatever
// it wrote, and reports `cancelled` so the manager can tell its own decision from a stop
// nobody asked for.

export const cancelSubagentToolCore: ToolDefinitionCore<'cancel_subagent'> = {
	name: 'cancel_subagent',
	description: `Stop a subagent you started, and keep the files it already wrote.

Use it when the work has become unnecessary - the requirement changed, another child answered the question, or you can see it is on the wrong path. Stopping a child does not undo its edits: they are on disk and appear among the files awaiting review like any other change.

Address it the same way \`send_message\` is addressed: by \`child_thread_id\` or by the \`alias\` you coined, scoped to your own children. A child that is not running has nothing to cancel and the error says how its last run ended - collect it to read what it produced.`,
	params: {
		child_thread_id: { description: 'The id of the child to stop, from run_subagent or list_children.' },
		alias: { description: 'The name you coined for the child, if you do not have its id.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj) => {
		const childThreadId = typeof raw.child_thread_id === 'string' && raw.child_thread_id.trim() ? raw.child_thread_id.trim() : null
		const alias = typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias.trim() : null
		if (!childThreadId && !alias) {
			throw new Error('cancel_subagent needs child_thread_id or alias to say which subagent to stop. list_children lists them.')
		}
		return { childThreadId, alias }
	},

	callTool: async ({ childThreadId, alias }, ctx, threadId) => {
		const delegationService = ctx.instantiationService.invokeFunction(accessor => accessor.get(IDelegationService))
		const { childThreadId: stopped, status } = delegationService.cancelSubagent({ parentThreadId: threadId, childThreadId: childThreadId ?? undefined, alias: alias ?? undefined })
		return { result: { childThreadId: stopped, status } }
	},

	stringOfResult: (_params, result) =>
		`Stopped the subagent (${result.childThreadId}). Status: ${result.status}. Anything it wrote before stopping is on disk; its last partial output is still in its transcript.`,

	title: { done: 'Cancelled subagent', proposed: 'Cancel subagent', running: 'Cancelling subagent' },
}