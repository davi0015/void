/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Index arithmetic for the changed-file stepper in the Void command bar.
//
// Deliberately free of React, services and storage. The ordering rules here are
// fiddly — the widget's position can be unknown, stale, or pointing one past the
// end after a file leaves the list — and this area has already produced two
// rounds of regressions (see #116). Keeping the arithmetic pure means it can be
// pinned by fast unit tests rather than by hand in the editor.

/**
 * Where the stepper currently thinks it is.
 *
 * The bar is mounted once per code editor and remembers the last position it
 * occupied (`lastIdx`). `currentIdx` is the position of the file the bar is
 * showing, which is null whenever that file has no pending diffs — including
 * the moment right after it was approved and left the list.
 */
export type StepperPosition = {
	/** Number of files with pending diffs, in stepper order. */
	listLength: number
	/** Index of the file this bar shows, or null when it has no pending diffs. */
	currentIdx: number | null
	/** Last index this bar occupied, or null if it never occupied one. */
	lastIdx: number | null
}

/** Index the forward control (Next / right arrow) moves to, or null if none. */
export function nextStepperIdx({ listLength: n, currentIdx, lastIdx }: StepperPosition): number | null {
	if (n === 0) return null
	if (currentIdx !== null) return (currentIdx + 1 + n) % n

	// The file this bar was showing just left the list (typically approved), so
	// the successor slid down into its slot. Next means that slot, not the one
	// past it.
	const removedWasLast = lastIdx !== null && lastIdx >= n
	if (removedWasLast) return 0

	// No current file and no memory of one: the bar has never occupied a
	// position. Next means the first changed file. Answering null here left the
	// forward control disabled — and, in the single-file bar the user sees when
	// one file changed, rendered but inert — until a changed file had been
	// opened by hand.
	return clampedIdx(n, lastIdx) ?? 0
}

/** Index the backward control (Prev / left arrow) moves to, or null if none. */
export function prevStepperIdx({ listLength: n, currentIdx, lastIdx }: StepperPosition): number | null {
	if (n === 0) return null
	if (currentIdx !== null) return (currentIdx - 1 + n) % n

	const here = clampedIdx(n, lastIdx)
	// Same hole as above, in the other direction: with no position, Prev means
	// the last changed file. Stepping back from an implied index 0 skipped it.
	if (here === null) return n - 1
	return (here - 1 + n) % n
}

/** `lastIdx` clamped into the current list, or null when there is no memory. */
function clampedIdx(n: number, lastIdx: number | null): number | null {
	if (lastIdx === null) return null
	return Math.min(lastIdx, n - 1)
}
