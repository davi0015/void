/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { IDelegationService } from '../../common/delegationService.js'

import { ToolDefinitionCore } from './toolTypes.js'

// The child's half of the result contract.
//
// Without it the parent's outcome is *derived*: the last thing the child said. That is
// wrong in both directions. It can be too much — a child that spent the turn thinking out
// loud hands over its working — or too little, when the run ends on a turn that only called
// a tool and the parent gets a blank report for a child that had answered a step earlier.
//
// Making it a tool makes the handover deliberate: this is the text the parent reads, it is
// written for that reader, and nothing trims it afterwards because the child already decided
// what to send. The tool is offered to subagents only (`subagentOnlyToolNames`) — a
// top-level thread has no parent to report to, and an affordance a model cannot use is one
// it will misuse.
//
// It does not end the run. A child that reports and then finishes its sentence is ordinary,
// and forcing termination from inside a tool call would be a second way to stop a run
// besides the model stopping and the user aborting.

export const reportToParentToolCore: ToolDefinitionCore<'report_to_parent'> = {
	name: 'report_to_parent',
	description: `Send your report to the agent that delegated this task. It is the **only thing that reaches it**: your conversation, your tool results and your reasoning never do.

Call this once you have what you were asked for, with the answer itself — findings, the exact error text, what you changed and where. Write it for a reader who has not seen any of your work and cannot ask you follow-up questions: name files by path, quote the command, state the conclusion before its justification.

The text is passed through verbatim and is not trimmed, so keep it to what that reader needs. If you keep working after reporting, a later report replaces this one; if the run ends without one, your final message is sent instead.`,
	params: {
		summary: { description: 'The report: what you found or changed, where, and anything the delegating agent needs before acting on it. This exact text is what it receives.' },
	},
	// No approval: reporting is a message to the parent, not an action on the world.
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj) => {
		const summary = typeof raw.summary === 'string' ? raw.summary : ''
		if (!summary.trim()) {
			throw new Error('summary must say what the delegating agent should know. It is the entire result it receives.')
		}
		return { summary }
	},

	callTool: async ({ summary }, ctx, threadId) => {
		// Same seam as the delegation tools themselves: the chat service owns thread state,
		// and a tool cannot ask for it directly without closing a dependency cycle.
		const delegationService = ctx.instantiationService.invokeFunction(accessor => accessor.get(IDelegationService))
		// Throws when this thread has no parent, which reaches the model as an ordinary tool
		// error rather than a silent no-op.
		delegationService.reportToParent(threadId, summary)
		return { result: { received: true as const } }
	},

	stringOfResult: () => 'Report sent to the delegating agent.',

	title: { done: 'Reported to parent', proposed: 'Report to parent', running: 'Reporting to parent' },
}
