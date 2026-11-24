/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { IDelegationService } from '../../common/delegationService.js'
import { ALIAS_MAX_CHARS } from '../../common/childThreadLinkage.js'

import { ToolDefinitionCore } from './toolTypes.js'

// The delegation tool. Its description is the only place the model learns what a
// subagent is, because there is no agent catalogue to read instead: the `task`
// text is the child's role.
//
// This file is deliberately thin. Creating the thread, deciding what it inherits
// and running it to a terminal state are the chat service's work, reached through
// `IDelegationService`. The tool's job is to give the model a schema it can use,
// reject params that cannot mean anything, and render the bounded outcome back
// into prose — the same division every other tool in this directory follows.

export const runSubagentToolCore: ToolDefinitionCore<'run_subagent'> = {
	name: 'run_subagent',
	description: `Hand a self-contained task to a child agent and wait for its report.

The child is a separate agent with a **fresh, empty context**: it does not see this conversation, your reasoning, or your tool results. Everything it knows is the \`task\` you write. It works in the same workspace, with the same model and the same permissions you have, so it can read, edit, run commands and search exactly as you can — but it cannot delegate further. The subagents are yours.

Use it when the work is self-contained and its intermediate steps would crowd your context: investigating a subsystem and reporting findings, running the tests and reporting failures, searching for every call site, reviewing a diff you just wrote. Do NOT use it for work that needs the conversation you are in — the child starts blind.

Write \`task\` as a complete brief for a competent engineer who has not seen this conversation: what to do, where to look, and what to report back. **Name files instead of pasting their contents** — a reference is cheap, and pasting re-spends the context you delegated to save. The report it sends back is its own — written through report_to_parent, or its final message if it never called that — and it is not trimmed on the way, so ask for findings rather than a transcript: everything it sends is re-sent on every one of your later turns.

\`alias\` names the child (e.g. "tester", "reviewer"); it must be unique among the children you have already spawned.

Returns the child's status and summary, plus the files it changed. 'done' means it finished. 'blocked' means it stopped to ask for permission and nothing could answer, so narrow the task instead of waiting. The child's full transcript is not returned — it is stored as its own thread.

This call waits for the child to finish, and delegating is sequential: a second \`run_subagent\` in the same turn runs after this one returns, not alongside it. A child can write files while your own edits are still pending, so give it work that does not overlap something you are midway through.`,
	params: {
		alias: { description: `A short name for this child, unique among the children you spawn, e.g. "tester" or "reviewer". At most ${ALIAS_MAX_CHARS} characters.` },
		task: { description: 'The complete instruction for the child. It is the only thing the child receives, so make it self-contained: the goal, the files or commands to start from, and exactly what to report back.' },
	},
	// Delegating needs no approval: the child's own tool calls are gated by its own
	// permission mode, which is yours (§5 of the design). Asking the user to approve
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
		// service that the chat service is itself built with — asking for the one in
		// the other's constructor closes a DI cycle. `common/delegationService.ts`
		// carries the long version.
		const delegationService = ctx.instantiationService.invokeFunction(accessor => accessor.get(IDelegationService))

		// Creation happens synchronously inside this call and throws when the child
		// must not exist, which `_runToolCall` turns into an ordinary tool error the
		// model can read and correct.
		const { childThreadId, result } = delegationService.startSubagent({ parentThreadId: threadId, toolCallId, alias, task })

		// Returned before the run finishes, so the loop can still interrupt this call:
		// stopping the parent must stop the child rather than orphan it.
		return { result, interruptTool: () => delegationService.interruptSubagent(childThreadId) }
	},

	stringOfResult: ({ alias }, result) => {
		const head = result.status === 'done'
			? `A subagent named "${alias}" finished.`
			: result.status === 'blocked'
				? `A subagent named "${alias}" stopped before finishing and needs permission to continue.`
				: result.status === 'rejected'
					? `A subagent named "${alias}" was stopped before it finished.`
					: result.status === 'budget_exceeded'
						? `A subagent named "${alias}" stopped at its budget.`
						: `A subagent named "${alias}" failed.`

		const body = result.summary.trim() || '(no summary)'
		const errorLine = result.error ? `\nError: ${result.error}` : ''
		const filesLine = result.filesTouched.length > 0
			? `\nFiles it changed: ${result.filesTouched.join(', ')}`
			: ''
		const hint = result.status === 'done'
			? ''
			: '\nThe child\'s transcript is stored as its own thread; it is not included here. If its work is still needed, re-run a narrower task rather than expecting this one to resume.'

		return `${head}\n--- child's report ---\n${body}\n--- end of report ---${filesLine}${errorLine}${hint}`
	},

	title: { done: 'Delegated', proposed: 'Delegate task', running: 'Subagent working' },
}
