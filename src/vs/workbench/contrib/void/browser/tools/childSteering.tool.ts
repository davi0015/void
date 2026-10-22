/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { IDelegationService } from '../../common/delegationService.js'

import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'

// Steering a child that already exists, and finding the ones you have.
//
// These two are what make delegation a conversation instead of a function call.
// `send_message` gives the child another turn — the same child, with everything it
// learned on the first one — so a parent can ask for development and then ask that
// same child to fix what the tests found. `list_children` exists because the
// handles have to survive the parent's own compaction: a summarised conversation
// has lost the ids it read from earlier tool results, and deriving the list from
// stored linkage is the only thing that still answers after that.
//
// Neither blocks on a *running* child, because in this build a child cannot be
// running while the parent is: `run_subagent` waits, and the tools run one at a
// time. Steering a child mid-run is the parallelism step, where the parent parks
// and is resumed; a queue that never has anything in it would be a lie.

/** Shared by both tools: the delegation service, resolved past the DI cycle. */
const delegationServiceOf = (ctx: ToolCtx) =>
	// Resolved here rather than injected into `ToolCtx` because the delegation service
	// needs the chat service, and `ToolCtx` is assembled by the tools service that the
	// chat service is itself built with — asking for one in the other's constructor
	// closes a cycle. `common/delegationService.ts` carries the long version.
	ctx.instantiationService.invokeFunction(accessor => accessor.get(IDelegationService))

export const sendMessageToolCore: ToolDefinitionCore<'send_message'> = {
	name: 'send_message',
	description: `Continue a subagent you started with \`run_subagent\`, and wait for its reply.

This is the same child, not a new one: it still has its own history, its own report, and everything it did and learned on earlier turns. Use it to follow up — ask for a fix after it reported test failures, ask a question about what it found, or give it the next step of a task you split up. Starting a fresh \`run_subagent\` instead throws that away and pays to re-explore.

Address the child by \`alias\` (the name you gave it) or by \`child_thread_id\` (what \`list_children\` returns). If you have forgotten which children exist — a long conversation may have been summarised since you spawned them — call \`list_children\` first rather than guessing.

The message is the child's next instruction, and its whole input for this turn: it does not see this conversation, so refer to files by path rather than to "the change we discussed". The reply is bounded the same way \`run_subagent\`'s is: a status, a summary and the files the child changed, never its transcript.`,
	params: {
		alias: { description: 'The name you gave the child when you spawned it, e.g. "tester". Use this or child_thread_id, not both.' },
		child_thread_id: { description: 'The child\'s thread id, from `list_children` or a previous result. Use this when the alias is unknown or the conversation has been summarised.' },
		message: { description: 'The instruction for this turn. Self-contained: the child does not see this conversation.' },
	},
	// Talking to a child that already exists needs no approval. What the child then
	// does is gated by its own permission mode, which is the parent's.
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj) => {
		const childThreadId = typeof raw.child_thread_id === 'string' && raw.child_thread_id.trim() ? raw.child_thread_id : null
		const alias = typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias : null
		if (!childThreadId && !alias) {
			throw new Error('send_message needs either child_thread_id or alias to say which subagent to continue. Call list_children if you do not remember them.')
		}
		const message = typeof raw.message === 'string' ? raw.message : ''
		if (!message.trim()) {
			throw new Error('message must be the instruction for the child to carry out. It receives nothing else.')
		}
		return { childThreadId, alias, message }
	},

	callTool: async ({ childThreadId, alias, message }, ctx, threadId) => {
		const delegation = delegationServiceOf(ctx)
		// Resolution and the run both happen inside `continueSubagent`; it throws when
		// the child is not this thread's, which `_runToolCall` turns into a tool error.
		const { childThreadId: resolved, result } = delegation.continueSubagent({
			parentThreadId: threadId,
			childThreadId: childThreadId ?? undefined,
			alias: alias ?? undefined,
			message,
		})
		return { result, interruptTool: () => delegation.interruptSubagent(resolved) }
	},

	stringOfResult: ({ alias, childThreadId }, result) => {
		const who = alias ?? `subagent ${childThreadId?.slice(0, 8)}`
		const head = result.status === 'done'
			? `"${who}" replied.`
			: result.status === 'blocked'
				? `"${who}" stopped before replying and needs permission to continue.`
				: result.status === 'rejected'
					? `"${who}" was stopped before it replied.`
					: result.status === 'budget_exceeded'
						? `"${who}" stopped at its budget.`
						: `"${who}" failed.`
		const filesLine = result.filesTouched.length > 0
			? `\nFiles it changed: ${result.filesTouched.join(', ')}`
			: ''
		const errorLine = result.error ? `\nError: ${result.error}` : ''
		return `${head}\n--- reply ---\n${result.summary.trim() || '(no reply)'}\n--- end of reply ---${filesLine}${errorLine}`
	},

	title: { done: 'Replied to subagent', proposed: 'Message subagent', running: 'Waiting for subagent' },
}

export const listChildrenToolCore: ToolDefinitionCore<'list_children'> = {
	name: 'list_children',
	description: `List the subagents you have started from this thread, with their name, status and the task you gave each one.

Use this when you need a handle you no longer have: a long conversation can be summarised, and a summary does not carry the ids from earlier tool results. Nothing is lost — the children are still there, and this reads them back from where they are recorded.

It takes no arguments and does not wait for anything. Each entry gives the \`child_thread_id\` to pass to \`send_message\`, the alias you coined, whether it is still working, and whether its last run finished (\`done\`) or stopped for a reason worth reading.`,
	params: {},
	approvalType: undefined,

	validateParams: () => ({}),

	callTool: async (_params, ctx, threadId) => {
		const children = delegationServiceOf(ctx).listChildren(threadId)
		return { result: { children } }
	},

	stringOfResult: (_params, result) => {
		if (result.children.length === 0) {
			return 'This thread has no subagents. Use `run_subagent` to start one.'
		}
		const lines = result.children.map(child => {
			const state = child.running
				? 'running'
				: child.resultStatus === undefined
					? 'never finished a run'
					: child.resultStatus
			// The task is the child's first instruction, which is how a model recognises
			// which child it is looking at — an id is not something it can recognise.
			const task = child.task.replace(/\s+/g, ' ').trim()
			const shortTask = task.length > 120 ? `${task.slice(0, 120)}…` : task
			return `- ${child.alias ?? '(unnamed)'} — ${state} — ${child.childThreadId}\n  task: ${shortTask}`
		})
		return `Subagents of this thread (${result.children.length}):\n${lines.join('\n')}`
	},

	title: { done: 'Listed subagents', proposed: 'List subagents', running: 'Listing subagents' },
}
