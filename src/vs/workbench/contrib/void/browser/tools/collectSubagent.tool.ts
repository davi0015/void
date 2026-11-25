import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { IDelegationService } from '../../common/delegationService.js'
import { CollectedSubagent } from '../../common/toolsServiceTypes.js'

import { ToolDefinitionCore } from './toolTypes.js'

// The join. `run_subagent` returns a handle, so this is how a parent reads what the
// child produced - and the only place a report crosses back (M3).

const MAX_COLLECT_SECONDS = 300
const DEFAULT_COLLECT_SECONDS = 60

const describeOne = (r: CollectedSubagent) => {
	const head = `"${r.alias || r.childThreadId}" (${r.childThreadId}): ${r.status}`
	if (r.status === 'running') return `${head}. Still working - collect again, or do something else and come back.`
	const files = r.filesTouched.length > 0 ? `\nFiles it changed: ${r.filesTouched.join(', ')}` : ''
	const body = r.summary.trim() || '(it reported nothing)'
	return `${head}${files}\n--- child's report ---\n${body}\n--- end of report ---`
}

export const collectSubagentToolCore: ToolDefinitionCore<'collect_subagent'> = {
	name: 'collect_subagent',
	description: `Wait for subagents you started and read their reports.

Pass the handles you got from \`run_subagent\` - ids or the aliases you coined - and this waits until they settle, then returns each one's status and, for the settled ones, their report. A child that is still running after the timeout is reported as \`running\`: you can collect it again later, and nothing is lost when you do.

Use it at the point you actually need the work, not immediately after spawning: the value of a child is that it runs while you do something else. Several children can be collected in one call - that is the fan-out join.

Statuses: \`done\` (read the report and verify what matters), \`blocked\` (it stopped on an approval nothing could answer - narrow the task or approve it in its transcript), \`error\`, \`cancelled\` (you stopped it), \`interrupted\` (its window closed mid-run), \`rejected\` (something else stopped it; the summary says why).`,
	params: {
		children: { description: 'The subagents to join: ids returned by run_subagent (or list_children), or the aliases you coined. Several can be given, separated by commas.' },
		timeout_seconds: { description: `Optional. How long to wait for them to settle before reporting the ones still running. Default ${DEFAULT_COLLECT_SECONDS}, maximum ${MAX_COLLECT_SECONDS}. Pass 0 to read their status without waiting.` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj) => {
		const rawChildren = raw.children
		const children = (Array.isArray(rawChildren) ? rawChildren : String(rawChildren ?? '').split(','))
			.map(v => typeof v === 'string' ? v.trim() : '')
			.filter(v => v.length > 0)
		if (children.length === 0) {
			throw new Error('collect_subagent needs the children to join. Pass the id run_subagent returned (or the alias you coined); list_children lists them if you have forgotten.')
		}
		const rawTimeout = String(raw.timeout_seconds ?? '').trim()
		const parsed = rawTimeout === '' ? Number.NaN : Number(rawTimeout)
		const timeoutSeconds = Number.isFinite(parsed)
			? Math.max(0, Math.min(MAX_COLLECT_SECONDS, Math.floor(parsed)))
			: DEFAULT_COLLECT_SECONDS
		return { children, timeoutSeconds }
	},

	callTool: async ({ children, timeoutSeconds }, ctx, threadId) => {
		const delegationService = ctx.instantiationService.invokeFunction(accessor => accessor.get(IDelegationService))
		const { promise, interrupt } = delegationService.collectSubagents({ parentThreadId: threadId, children, timeoutSeconds })
		// The interrupt path is this tool's `interruptTool`: stopping the turn stops the wait,
		// and the children keep running. That is the whole of "interrupts preempt the
		// conversation, not the work" (M3).
		return { result: promise.then(results => ({ results })), interruptTool: interrupt }
	},

	stringOfResult: (_params, result) => result.results.map(describeOne).join('\n\n'),

	title: { done: 'Collected subagents', proposed: 'Collect subagents', running: 'Waiting for subagents' },
}