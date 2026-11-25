import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { IDelegationService } from '../../common/delegationService.js'
import { ALIAS_MAX_CHARS } from '../../common/childThreadLinkage.js'

import { ToolDefinitionCore } from './toolTypes.js'

// The delegation tool. Its description is the only place the model learns what a
// subagent is, because there is no agent catalogue to read instead: the `task`
// text is the child's role.
//
// This file is deliberately thin. Creating the thread, deciding what it inherits
// and running it are the chat service's work, reached through `IDelegationService`.
// The tool's job is to give the model a schema it can use, reject params that cannot
// mean anything, and say what was started.
//
// Since M3 the call returns a handle rather than a report: the child runs beside the
// parent, and `collect_subagent` is the join.

export const runSubagentToolCore: ToolDefinitionCore<'run_subagent'> = {
	name: 'run_subagent',
	description: `Hand a self-contained task to a child agent and keep working. This returns immediately with a handle; the report comes back when you ask for it with \`collect_subagent\`.

The child is a separate agent with a **fresh, empty context**: it does not see this conversation, your reasoning, or your tool results. Everything it knows is the \`task\` you write. It works in the same workspace, with the same model and the same permissions you have, so it can read, edit, run commands and search exactly as you can, but it cannot delegate further. The subagents are yours.

Use it when the work is self-contained and its intermediate steps would crowd your context: investigating a subsystem and reporting findings, running the tests and reporting failures, searching for every call site, reviewing a diff you just wrote. Do NOT use it for work that needs the conversation you are in. The child starts blind.

Write \`task\` as a complete brief for a competent engineer who has not seen this conversation: what to do, where to look, and what to report back. **Name files instead of pasting their contents**. The report it sends back is its own, written through report_to_parent or its final message, and it is not trimmed on the way, so ask for findings rather than a transcript: everything it sends is re-sent on every one of your later turns.

\`alias\` names the child (e.g. "tester", "reviewer"); it must be unique among the children you have already spawned.

Returns \`{ childThreadId, alias, status: "running" }\`. Several \`run_subagent\` calls in one turn start children that run at the same time. Collect their reports with \`collect_subagent\` when you need them, read their status with \`list_children\`, and stop one with \`cancel_subagent\` if the work turns out to be unnecessary. A child that finished without being collected is still collectable later, including after a restart.` ,
	params: {
		alias: { description: `A short name for this child, unique among the children you spawn, e.g. "tester" or "reviewer". At most ${ALIAS_MAX_CHARS} characters.` },
		task: { description: 'The complete instruction for the child. It is the only thing the child receives, so make it self-contained: the goal, the files or commands to start from, and exactly what to report back.' },
	},
	// Delegating needs no approval: the child's own tool calls are gated by its own
	// permission mode, which is yours (section 5 of the design). Asking the user to approve
	// "start working" would be a gate on nothing.
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj) => {
		const alias = typeof raw.alias === 'string' ? raw.alias : ''
		if (!alias.trim()) {
			throw new Error('alias must be a short non-empty name for the child, e.g. "tester".')
		}
		const task = typeof raw.task === 'string' ? raw.task : ''
		if (!task.trim()) {
			throw new Error('task must be the instruction for the child to carry out. The child starts with an empty context, so it receives nothing else.')
		}
		return { alias, task }
	},

	callTool: async ({ alias, task }, ctx, threadId, toolCallId) => {
		// Resolved here rather than injected into `ToolCtx` because the delegation
		// service needs the chat service, and `ToolCtx` is assembled by the tools
		// service that the chat service is itself built with. `common/delegationService.ts`
		// carries the long version.
		const delegationService = ctx.instantiationService.invokeFunction(accessor => accessor.get(IDelegationService))

		// Creation happens synchronously inside this call and throws when the child
		// must not exist, which `_runToolCall` turns into an ordinary tool error the
		// model can read and correct.
		const { childThreadId, result } = delegationService.startSubagent({ parentThreadId: threadId, toolCallId, alias, task })

		// Deliberately not awaited, and no `interruptTool`: stopping this turn must not stop
		// the child. The run records its own outcome on the thread when it settles, which is
		// what `collect_subagent` reads. The catch is for a bug in the run path, not for a
		// child outcome — outcomes are values and never reject.
		result.catch(e => { console.error('[delegation] a child run threw instead of returning an outcome:', e) })

		return { result: { childThreadId, alias, status: 'running' as const } }
	},

	stringOfResult: ({ alias }, result) =>
		`Started a subagent named "${alias}" (id ${result.childThreadId}). It runs in its own thread with a fresh context, beside this conversation.\nCall collect_subagent with "${result.childThreadId}" (or "${alias}") when you need its report; list_children shows its status; cancel_subagent stops it if the work is no longer needed.`,

	title: { done: 'Delegated', proposed: 'Delegate task', running: 'Starting subagent' },
}