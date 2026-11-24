/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// When the agent loop compacts before it sends, and how big the request it is about
// to send actually is.
//
// Two numbers decide the trigger: the model's context window, and how much of it the
// next request would occupy. Remaining is the difference, and compaction runs before a
// request when remaining falls below `min(20% of the window, 30k tokens)` — a fraction,
// so a small model compacts proportionally, and an absolute ceiling, so a large one
// does not wait until it is nearly full.
//
// The size estimate counts the *live view*: the summary plus the messages after the
// compaction boundary. The raw message array keeps everything a compaction replaced,
// so counting it would report a thread as full the moment after it was compacted, and
// compact again on the next iteration, and again on the one after that.

import { CompactionMessageLike, messageChars } from './compactionBoundary.js'

/** Compact when less than this fraction of the window is left. */
export const AUTO_COMPACT_REMAINING_RATIO = 0.20

/** Ceiling on that fraction, in tokens, so a large window compacts on a fixed budget. */
export const AUTO_COMPACT_REMAINING_TOKENS = 30_000

/** The manual dialog's compression: a summary targeting ~30% of the compacted span. */
export const AUTO_COMPACT_PERCENT = 70

/** Keep the last ten turns verbatim — the manual dialog's maximum. */
export const AUTO_COMPACT_PROTECT_TURNS = 10

/**
 * How many tokens may remain before a request is compacted first.
 *
 * A window of 0 (an unrecognized route) yields 0, and `shouldCompactProactively`
 * treats that as "do not guess" rather than "compact everything".
 */
export function autoCompactThresholdTokens(contextWindowTokens: number): number {
	const window = Number.isFinite(contextWindowTokens) ? Math.max(0, contextWindowTokens) : 0
	return Math.min(window * AUTO_COMPACT_REMAINING_RATIO, AUTO_COMPACT_REMAINING_TOKENS)
}

/**
 * Whether the request about to be sent should be compacted first.
 *
 * `usedTokens` is the live view's size. Equality does not trigger: the threshold is a
 * floor to cross, not a boundary to sit on, which keeps a request that exactly fits the
 * budget from paying for a summary it does not need.
 */
export function shouldCompactProactively({ usedTokens, contextWindowTokens }: {
	usedTokens: number
	contextWindowTokens: number
}): boolean {
	if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return false
	if (!Number.isFinite(usedTokens) || usedTokens < 0) return false
	return (contextWindowTokens - usedTokens) < autoCompactThresholdTokens(contextWindowTokens)
}

/**
 * Characters of the live view: the summary that replaced the compacted span, plus every
 * message after the boundary. Before any compaction this is the whole array. A boundary
 * past the end of the array counts the summary alone, which is what a truncated thread
 * looks like.
 */
export function liveViewChars({ messages, summary, boundaryIdx }: {
	messages: readonly CompactionMessageLike[]
	summary: string | undefined
	boundaryIdx: number | undefined
}): number {
	const from = boundaryIdx === undefined ? 0 : Math.max(0, Math.min(boundaryIdx, messages.length))
	let chars = summary?.length ?? 0
	for (let i = from; i < messages.length; i++) chars += messageChars(messages[i])
	return chars
}
