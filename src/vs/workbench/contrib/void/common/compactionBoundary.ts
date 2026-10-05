/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Where a compaction boundary may fall, as a pure function of the message array.
//
// Compaction replaces `[0, boundaryIdx)` with a summary, so that one index decides
// what the model loses. Two rules decide it, and they answer different questions:
//
//   - The turn is what the user chooses. "Keep last N turns" means the start of
//     the N-th-from-last user message, so whole turns survive and the kept tail
//     can never open on a tool result.
//   - `retentionChars` is the constraint. A turn has no size bound — one turn
//     with a hundred tool calls is ordinary — so when the turns the user asked to
//     keep are themselves over budget, the tail is filled newest-first at group
//     granularity: an assistant message plus the results it requested, never
//     split. The newest group is kept even if it alone exceeds the budget, since
//     an assistant and its results are indivisible.
//
// Legality is the invariant under both: a boundary that points at a `tool`
// message is never valid. The projection would keep results whose requesting
// assistant sits in the summarised prefix, and `prepareMessages_openai_tools`
// then rebuilds those calls onto the projection's synthetic acknowledgement —
// a well-formed request claiming the model called tools it has no record of.
// `planCompaction` cannot produce one; `snapToLegalBoundary` repairs boundaries
// chosen elsewhere (stored by an older build, or picked by a size target).
//
// The array this reasons over is `thread.messages`: one entry per user message,
// assistant message and tool result, so one agent step is 1 + N entries.

/**
 * How much of a model's context window stays verbatim once compaction fires.
 * The rest is summarised. A fraction rather than an entry count: ten entries is
 * two chat turns or a fifth of one agent step, depending on the thread.
 */
export const RETENTION_RATIO = 0.15

/**
 * Floor for the retention budget, in characters (~5k tokens). `contextWindow` is
 * per model and can be missing for an unrecognized route; a zero budget would let
 * the fallback keep only the newest group and summarise almost everything.
 */
export const RETENTION_MIN_CHARS = 20_000

/** The fields this module reads. Structural, so tests can pass plain objects. */
export type CompactionMessageLike = {
	role: string
	content?: string
	displayContent?: string
	reasoning?: string
	rawParamsStr?: string
	result?: unknown
}

/**
 * Characters in one message, as the compaction path has always counted them:
 * user content, assistant display text plus reasoning, tool params plus result.
 * One copy, shared by the planner, the prompt's target length and the preview —
 * the two former copies drifted apart only by accident of being written twice.
 */
export function messageChars(msg: CompactionMessageLike): number {
	if (msg.role === 'user') return msg.content?.length ?? 0
	if (msg.role === 'assistant') return (msg.displayContent?.length ?? 0) + (msg.reasoning?.length ?? 0)
	if (msg.role === 'tool') {
		let n = msg.rawParamsStr?.length ?? 0
		const r = msg.result
		if (typeof r === 'string') n += r.length
		else if (r && typeof r === 'object' && 'content' in r && typeof (r as { content?: string }).content === 'string')
			n += (r as { content: string }).content.length
		return n
	}
	return 0
}

/**
 * Whether `idx` is a legal place to cut. Messages the request never sends
 * (`interrupted_streaming_tool`) are transparent: cutting in front of one is
 * only legal if the next real message is not a tool result, since the projection
 * drops the decorative row and the result would surface with its assistant gone.
 */
export function isLegalCut(messages: readonly CompactionMessageLike[], idx: number): boolean {
	for (let i = idx; i < messages.length; i++) {
		const role = messages[i].role
		if (role === 'interrupted_streaming_tool') continue
		return role !== 'tool'
	}
	return true
}

/**
 * Moves a boundary earlier until it is a legal cut, so the assistant that
 * requested a batch stays with its results. Used on boundaries this module did
 * not choose — ones already stored on disk — where keeping more is the safe
 * direction: the stored summary was generated over `[0, boundary)` and the worst
 * case is that it mentions content the tail now also carries, where moving
 * forward would discard results that are in neither the summary nor the tail.
 *
 * Returns 0 when no legal cut exists in front of the boundary — 0 means "summarise
 * nothing", which is always safe and is what both callers treat as "no compaction".
 */
export function snapToLegalBoundary(messages: readonly CompactionMessageLike[], idx: number): number {
	let i = Math.max(0, Math.min(idx, messages.length))
	while (i > 0 && !isLegalCut(messages, i)) i--
	return i
}

export type CompactionPlan = {
	/** Everything before this index is summarised; everything from it is sent verbatim. */
	boundaryIdx: number
	/** False when there is nothing before the boundary to summarise. */
	canCompact: boolean
	/** The boundary cuts inside the oldest kept turn because the turns did not fit. */
	cutInsideTurn: boolean
	turnsKept: number
	userTurns: number
	keptMessages: number
	droppedMessages: number
	keptChars: number
	droppedChars: number
}

/**
 * Plans one compaction. `turns` is what the user asked to keep; `retentionChars`
 * bounds what may be kept verbatim, converted from tokens by the caller because
 * the chars-per-token ratio is per model and calibrated at runtime.
 */
export function planCompaction({ messages, turns, retentionChars }: {
	messages: readonly CompactionMessageLike[]
	turns: number
	retentionChars: number
}): CompactionPlan {
	const total = messages.length

	// Suffix sums: `suffix[i]` is the char count of `messages[i..]`, so every
	// count below is O(1) and the whole plan is O(n). Threads reach thousands of
	// messages, and the dialog re-plans on every slider step.
	const suffix = new Array<number>(total + 1).fill(0)
	for (let i = total - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + messageChars(messages[i])

	const requestedTurns = Math.max(1, Math.floor(turns))

	// The start of the N-th-from-last turn. Fewer turns than that means the whole
	// thread is inside the protection zone: keeping "3 turns" of a 2-turn thread
	// keeps everything, so there is nothing to summarise and the caller says so
	// rather than quietly cutting into a turn the user asked to keep.
	let userTurns = 0
	let turnCandidate = 0
	for (let i = total - 1; i >= 0; i--) {
		if (messages[i].role !== 'user') continue
		userTurns++
		if (userTurns >= requestedTurns) { turnCandidate = i; break }
	}
	const enoughTurns = userTurns >= requestedTurns

	let boundaryIdx = 0
	let cutInsideTurn = false

	if (enoughTurns) {
		if (suffix[turnCandidate] <= retentionChars) {
			boundaryIdx = turnCandidate
		}
		else {
			// The turns on their own exceed the budget, so the tail is filled
			// newest-first at group granularity, inside the oldest kept turn.
			// Keeping the newest group is not optional: an assistant and the
			// results it requested are one indivisible unit, so a single group
			// larger than the budget overshoots rather than being split.
			let newestGroupStart = total
			while (newestGroupStart > 0 && messages[newestGroupStart - 1].role === 'tool') newestGroupStart--
			newestGroupStart = snapToLegalBoundary(messages, newestGroupStart)

			let boundary = newestGroupStart
			for (let i = total - 1; i >= 0; i--) {
				if (suffix[i] > retentionChars) break
				if (isLegalCut(messages, i)) boundary = i
			}
			boundaryIdx = boundary
			cutInsideTurn = boundaryIdx > turnCandidate
		}
	}

	// The boundary must be a legal cut. Both rules above produce one by
	// construction — a user index for the turn rule, `isLegalCut` for the
	// fallback — so this is an assertion of that property, not a repair.
	boundaryIdx = snapToLegalBoundary(messages, boundaryIdx)

	let turnsKept = 0
	for (let i = boundaryIdx; i < total; i++) if (messages[i].role === 'user') turnsKept++

	return {
		boundaryIdx,
		canCompact: boundaryIdx > 0,
		cutInsideTurn,
		turnsKept,
		userTurns,
		keptMessages: total - boundaryIdx,
		droppedMessages: boundaryIdx,
		keptChars: suffix[boundaryIdx],
		droppedChars: suffix[0] - suffix[boundaryIdx],
	}
}
