/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ThreadPermissionMode } from './toolsServiceTypes.js'
import type { LLMUsage } from './sendLLMMessageTypes.js'

// What makes a thread a child of another thread, and what a child inherits.
//
// A delegated child is an ordinary `ThreadType` — same storage, same loop, same
// rendering — that carries a pointer to the thread which spawned it. There is
// deliberately no `kind: 'user' | 'child'` field: `kind === 'child'` and
// `parentThreadId !== undefined` state the same fact, two encodings can disagree,
// and one disagreement is reachable (a child whose parent was deleted before the
// cascade). Everything below derives the classification from the pointer, so the
// disagreement cannot be represented at all.
//
// Inheritance is the other half of the module, and it is a **copy, never a
// lookup**. A child that resolved its workspace from the ambient window, or its
// permission mode from the settings default, would be a different agent from its
// parent on exactly the axes the delegation is supposed to preserve. So creation
// copies four things — workspace, `permissionMode`, `frozenAiInstructions`, and
// (in the spawn path, as an argument rather than a thread field) the model
// selection — and copies them verbatim, including `undefined`. Copying
// `permissionMode: undefined` is not a lossy default: the field normalizes to
// `'read_only'` on read (`normalizeThreadPermissionMode`), so a child of a legacy
// thread holds exactly the grant its parent holds. Substituting the `'read_only'`
// default that `newThreadObject` gives a top-level thread would be a *narrowing*
// for the child of a thread the user had granted something wider, which is the
// direction this must never move by accident.
//
// What a child does not inherit is `messages`. That is the entire point of a
// fresh-context delegation: the child reads the task, not the parent's
// exploration. Forking the parent's context is a different verb and a different
// milestone.

/**
 * How a child run ended. Every child reaches one of these, so "it stopped" is
 * always distinguishable from "it finished". `blocked` and `budget_exceeded`
 * are not produced by M2 — nothing bounds a run yet — but they are part of the
 * contract the parent reads, and a status added later would be a contract change.
 */
export type SubagentStatus = 'done' | 'blocked' | 'budget_exceeded' | 'error' | 'rejected'

/**
 * What the parent receives back from a delegation. This is where isolation is
 * enforced, so every field is bounded and none of them is a transcript: the
 * child's messages, tool results and reasoning never cross. `summary` is the only
 * text, and the caller caps its length.
 *
 * `filesTouched` is derived from the child's *successful* write tools, so a
 * rejected or failed edit is not reported as a change. `usage` is the child's
 * lifetime spend, which is what the parent's cost rollup adds to its own figure —
 * populated here even while the rollup itself is not yet wired.
 */
export type SubagentOutcome = {
	status: SubagentStatus
	summary: string
	filesTouched: string[]
	childThreadId: string
	usage?: LLMUsage
	error?: string
}

/**
 * One row of `list_children`.
 *
 * The tool exists because a parent's handles have to survive its own compaction:
 * once a long conversation is summarised, the ids it read from earlier tool results
 * are gone, and without this there is no way to address the child that is still
 * sitting there half-finished. So the list is derived from stored linkage rather
 * than remembered — and it carries `task`, the child's first instruction, because an
 * id is not something a model can recognise and a paraphrased task is.
 */
export type ChildThreadSummary = {
	childThreadId: string
	alias: string | null
	/** True while the child's run is going, false once it has settled or never ran. */
	running: boolean
	/** How the last run ended. Absent on a child that has not finished a run yet. */
	resultStatus?: SubagentStatus
	task: string
}

/**
 * Deepest delegation the product allows: a top-level thread may spawn children,
 * and a child may not spawn further. This is a shape rather than a cap — nesting
 * is where "a child can do what its parent can" stops being explainable — and it
 * is exported so the checks live in one place instead of a comment in the tool.
 */
export const MAX_DELEGATION_DEPTH = 1

/** Longest alias accepted, in characters. Long enough for "test-runner", short
 * enough that it stays a name. Longer input is refused rather than truncated:
 * truncation turns two distinct aliases into one, and the parent addresses the
 * child by alias. */
export const ALIAS_MAX_CHARS = 40

/**
 * The fields this module reads off a thread. Structural rather than `ThreadType`
 * so tests can pass plain objects, and so the module stays free of a runtime
 * import of the chat service.
 */
export type DelegatingThreadLike = {
	id: string
	workspaceUri?: string
	workspaceLabel?: string
	permissionMode?: ThreadPermissionMode
	frozenAiInstructions?: string
	parentThreadId?: string
	delegationDepth?: number
}

/** True iff this thread was spawned by another. The only classification there is. */
export const isChildThread = (thread: Pick<DelegatingThreadLike, 'parentThreadId'> | undefined): boolean =>
	thread?.parentThreadId !== undefined

/**
 * Nesting level, normalized: 0 for a top-level thread, 1 for its children.
 *
 * A thread that names a parent but records no depth was written by a build that
 * did not store one. It is at least depth 1, and 1 is also the most restrictive
 * answer under a cap of 1 — guessing low would let it delegate, which is the
 * direction that must not happen by accident.
 */
export const delegationDepthOf = (thread: DelegatingThreadLike | undefined): number => {
	if (!thread) return 0
	if (typeof thread.delegationDepth === 'number') return thread.delegationDepth
	return isChildThread(thread) ? MAX_DELEGATION_DEPTH : 0
}

/**
 * What creation copies from the parent into the child. Everything here is a
 * scalar or absent, so the copy cannot alias the parent's objects.
 */
export type ChildThreadSeed = {
	parentThreadId: string
	parentToolCallId: string
	alias: string
	delegationDepth: number

	// Inherited. Copied verbatim from the parent, never from the window — a
	// background child resolving the ambient workspace is the hazard this avoids.
	workspaceUri: string | undefined
	workspaceLabel: string | undefined
	permissionMode: ThreadPermissionMode | undefined
	frozenAiInstructions: string | undefined
}

/**
 * Either the seed to create the child from, or the reason it cannot be created.
 * The refusal is LLM-facing prose: it is handed back to the parent as the tool's
 * error, so it has to say what to do instead of only what was wrong.
 *
 * Uniqueness of the alias among siblings is **not** checked here, because it
 * needs the list of existing children and this function sees one thread. The
 * spawn path, which has that list, enforces it.
 */
export type ChildThreadCreation =
	| { ok: true, seed: ChildThreadSeed }
	| { ok: false, refusal: string }

/**
 * The child seed for a `run_subagent` call on `parent`.
 *
 * Depth is incremented here rather than counted down from a constant, so a chain
 * of children reports the level it actually reached.
 */
export const childThreadSeedOf = (
	parent: DelegatingThreadLike,
	request: { toolCallId: string, alias: string },
): ChildThreadCreation => {
	const delegationDepth = delegationDepthOf(parent) + 1
	if (delegationDepth > MAX_DELEGATION_DEPTH) {
		return {
			ok: false,
			refusal: 'A subagent cannot create subagents. This delegation is one level deep, so do the work in this thread instead of delegating it further.',
		}
	}

	const alias = request.alias.trim().replace(/\s+/g, ' ')
	if (!alias) {
		return { ok: false, refusal: 'alias must be a short non-empty name for the child, e.g. "tester".' }
	}
	if (alias.length > ALIAS_MAX_CHARS) {
		return { ok: false, refusal: `alias must be at most ${ALIAS_MAX_CHARS} characters; use a short name like "tester".` }
	}

	return {
		ok: true,
		seed: {
			parentThreadId: parent.id,
			parentToolCallId: request.toolCallId,
			alias,
			delegationDepth,
			workspaceUri: parent.workspaceUri,
			workspaceLabel: parent.workspaceLabel,
			permissionMode: parent.permissionMode,
			frozenAiInstructions: parent.frozenAiInstructions,
		},
	}
}
