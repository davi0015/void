/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import type { ChildThreadSummary, SubagentOutcome } from './childThreadLinkage.js'

// The seam between the delegation *tool* and the chat loop that runs a child.
//
// It exists because of a dependency direction, not because delegation deserves a
// subsystem. Running a child means creating a thread, appending its first user
// message and driving `_runChatAgent` — all of which live on `IChatThreadService`,
// which is built with `IToolsService` injected. A tool cannot ask for the chat
// service without closing that cycle, so the tool asks for this interface instead:
// it is declared in `common/`, imports nothing at runtime, and the chat service
// registers the one implementation that forwards to itself.
//
// The interface is deliberately this narrow. Everything else a delegation needs —
// depth, inheritance, the result contract — is decided in `childThreadLinkage.ts`
// and in the chat service, not here.

export type RunSubagentRequest = {
	/** The thread whose tool call is delegating. */
	parentThreadId: string
	/** The `run_subagent` call, so the child records which call created it. */
	toolCallId: string
	/** The parent's name for the child; unique among that parent's children. */
	alias: string
	/** The instruction. There is no agent catalogue: this text is the child's role. */
	task: string
}

/**
 * Continue a child that already exists.
 *
 * Addressed by id or by alias, because the two fail differently. An alias is what
 * the parent coined and can carry in prose; the id is what `list_children` returns
 * after a compaction has eaten the alias. Exactly one must be supplied, and
 * resolution is scoped to the delegating thread's own children — a parent cannot
 * message somebody else's.
 */
export type ContinueSubagentRequest = {
	parentThreadId: string
	childThreadId?: string
	alias?: string
	message: string
}

export type StartedSubagent = {
	/** The child thread's id, available before the run finishes. */
	childThreadId: string
	/**
	 * Resolves with the bounded outcome the parent's tool result carries. It does
	 * not reject for a child that failed, needed approval or was interrupted —
	 * those are outcomes, and a rejection would be a malformed tool result rather
	 * than an answer.
	 */
	result: Promise<SubagentOutcome>
}

export interface IDelegationService {
	readonly _serviceBrand: undefined

	/**
	 * Create a child thread and start running it.
	 *
	 * Synchronous through creation and throws when the child must not exist (too
	 * deep, an empty or reused alias), so the caller reports that as a normal tool
	 * error instead of leaving a half-created thread. The run itself is the
	 * returned promise.
	 */
	startSubagent(request: RunSubagentRequest): StartedSubagent

	/**
	 * Give an existing child another instruction and run it again.
	 *
	 * A child is a conversation that already persists and reloads, so a follow-up is
	 * an ordinary turn: appending the message and driving the same loop. That is what
	 * makes delegation iterative — a parent that asks for development and then asks
	 * the same child to fix what the tests found is holding one conversation in two
	 * parts, rather than starting a fresh agent with no memory of the first.
	 *
	 * Throws when the child cannot be resolved from this parent (unknown id or alias,
	 * or another thread's child), so that reaches the model as an ordinary tool error.
	 */
	continueSubagent(request: ContinueSubagentRequest): StartedSubagent

	/**
	 * The children of a thread, derived from stored linkage.
	 *
	 * Read from storage-backed fields rather than from anything the caller remembers,
	 * because the caller's memory is a conversation that may have been compacted. This
	 * is a correctness affordance, not a convenience.
	 */
	listChildren(parentThreadId: string): ChildThreadSummary[]


	/**
	 * Stop a child's current turn. This is the interrupt cascade: aborting the
	 * parent calls it, so a delegation cannot keep spending tokens after the run
	 * that asked for it has been cancelled.
	 */
	interruptSubagent(childThreadId: string): void
}

export const IDelegationService = createDecorator<IDelegationService>('voidDelegationService')
