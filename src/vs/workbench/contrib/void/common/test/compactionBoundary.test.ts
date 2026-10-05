/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CompactionMessageLike, isLegalCut, messageChars, planCompaction, snapToLegalBoundary } from '../compactionBoundary.js';

// The arithmetic behind "keep last N turns", and the one invariant that must hold
// for every boundary: the kept tail never opens on a tool result.
//
// The bug this replaces took the *larger* of two boundary candidates, so a fixed
// ten-entry cap beat the turn rule whenever the recent tail was long — which is
// every agent turn — and, cutting by position, could land inside an assistant
// message's tool batch.

const user = (n = 1000): CompactionMessageLike => ({ role: 'user', content: 'u'.repeat(n) })
const assistant = (n = 1000): CompactionMessageLike => ({ role: 'assistant', displayContent: 'a'.repeat(n), reasoning: '' })
const tool = (n = 50): CompactionMessageLike => ({ role: 'tool', content: '', rawParamsStr: 't'.repeat(n), result: null })

/** One agent step: an assistant message followed by the results it requested. */
const step = (toolCount: number) => [assistant(), ...Array.from({ length: toolCount }, () => tool())]

/** Every kept tool result must have the assistant that requested it inside the slice too. */
function assertKeptSliceIsBalanced(messages: CompactionMessageLike[], boundaryIdx: number) {
	for (let i = boundaryIdx; i < messages.length; i++) {
		if (messages[i].role !== 'tool') continue
		let declaredInside = false
		for (let j = i - 1; j >= 0; j--) {
			if (messages[j].role === 'assistant') { declaredInside = j >= boundaryIdx; break }
			if (messages[j].role !== 'tool') break
		}
		assert.ok(declaredInside, `kept tool result at ${i} lost the assistant that requested it (boundary ${boundaryIdx})`);
	}
}

suite('CompactionBoundary', () => {

	test('the boundary is the start of the turn the user asked to keep', () => {
		// Three chat turns: user indices are 0, 2, 4.
		const messages = [user(), assistant(), user(), assistant(), user(), assistant()];

		const two = planCompaction({ messages, turns: 2, retentionChars: 1_000_000 });
		assert.strictEqual(two.boundaryIdx, 2, 'the 2nd-from-last user message is at index 2');
		assert.strictEqual(two.turnsKept, 2);
		assert.strictEqual(two.cutInsideTurn, false);
		assert.strictEqual(two.canCompact, true);

		const one = planCompaction({ messages, turns: 1, retentionChars: 1_000_000 });
		assert.strictEqual(one.boundaryIdx, 4);
		assert.strictEqual(one.turnsKept, 1);
	});

	test('fewer turns than requested keeps everything and says so', () => {
		const messages = [user(), assistant(), user(), assistant()];

		const plan = planCompaction({ messages, turns: 3, retentionChars: 1_000_000 });
		assert.strictEqual(plan.boundaryIdx, 0, 'keeping 3 turns of a 2-turn thread keeps everything');
		assert.strictEqual(plan.canCompact, false);
		assert.strictEqual(plan.userTurns, 2, 'the caller needs this to explain the refusal');
		assert.strictEqual(plan.keptMessages, messages.length);
	});

	test('a single-turn thread is not compacted by the turn rule alone', () => {
		const messages = [user(), ...step(4), ...step(4)];

		const plan = planCompaction({ messages, turns: 1, retentionChars: 1_000_000 });
		assert.strictEqual(plan.userTurns, 1);
		assert.strictEqual(plan.boundaryIdx, 0, 'the only turn is the one being kept');
		assert.strictEqual(plan.canCompact, false);
	});

	test('turns that exceed the retention budget are cut at a group edge instead', () => {
		// Turn 4 is the newest and makes a three-call batch (indices 8, 9, 10).
		const messages = [
			user(), assistant(),
			user(), assistant(),
			user(), assistant(),
			user(), assistant(), tool(), tool(), tool(),
		];

		// Enough for the newest turn, not for the two turns asked for: the cut lands
		// on the newest turn's user message, so that turn survives whole.
		const wholeNewestTurn = planCompaction({ messages, turns: 2, retentionChars: 3000 });
		assert.strictEqual(wholeNewestTurn.boundaryIdx, 6);
		assert.strictEqual(wholeNewestTurn.cutInsideTurn, true, 'it is earlier than the two turns requested');
		assert.strictEqual(wholeNewestTurn.turnsKept, 1);
		assert.ok(wholeNewestTurn.keptChars <= 3000);
		assertKeptSliceIsBalanced(messages, wholeNewestTurn.boundaryIdx);

		// Enough only for the newest group: the cut lands on the assistant that
		// requested the batch, never on one of its results.
		const newestGroupOnly = planCompaction({ messages, turns: 2, retentionChars: 2000 });
		assert.strictEqual(newestGroupOnly.boundaryIdx, 7);
		assert.strictEqual(newestGroupOnly.cutInsideTurn, true);
		assert.strictEqual(newestGroupOnly.turnsKept, 0, 'no whole turn fits in the budget');
		assert.ok(newestGroupOnly.keptChars <= 2000);
		assertKeptSliceIsBalanced(messages, newestGroupOnly.boundaryIdx);
	});

	test('a newest group larger than the budget is kept, not split', () => {
		const messages = [user(), assistant(), user(), assistant(), tool(), tool(), tool()];

		const plan = planCompaction({ messages, turns: 2, retentionChars: 20 });
		assert.strictEqual(plan.boundaryIdx, 3, 'the assistant that requested the batch starts the kept group');
		assert.ok(plan.keptChars > 20, 'the indivisible group overshoots the budget rather than being cut in half');
		assertKeptSliceIsBalanced(messages, plan.boundaryIdx);
	});

	test('no budget produces a boundary inside a tool batch', () => {
		// Four chat turns, then a twelve-call burst — the shape a message-count rule
		// (10 entries from the end) resolves to the third result of that batch.
		const messages = [
			user(), assistant(), user(), assistant(), user(), assistant(), user(), assistant(),
			...step(12),
		];

		for (const retentionChars of [0, 50, 500, 2000, 5000, 50_000]) {
			for (const turns of [1, 2, 3]) {
				const plan = planCompaction({ messages, turns, retentionChars });
				assert.ok(isLegalCut(messages, plan.boundaryIdx),
					`boundary ${plan.boundaryIdx} is not a legal cut (turns=${turns}, budget=${retentionChars})`);
				assert.notStrictEqual(messages[plan.boundaryIdx]?.role, 'tool',
					`boundary ${plan.boundaryIdx} points at a tool result (turns=${turns}, budget=${retentionChars})`);
				assertKeptSliceIsBalanced(messages, plan.boundaryIdx);
			}
		}
	});

	test('a stored boundary that points at a tool result is snapped back to its assistant', () => {
		const messages = [user(), assistant(), tool(), tool(), tool(), assistant(), tool()];

		assert.strictEqual(snapToLegalBoundary(messages, 6), 5, 'the trailing solo result snaps to its assistant');
		assert.strictEqual(snapToLegalBoundary(messages, 4), 1, 'a result mid-batch snaps back to the requesting assistant');
		assert.strictEqual(snapToLegalBoundary(messages, 1), 1, 'an assistant index is already legal');
		assert.strictEqual(snapToLegalBoundary(messages, 0), 0, 'the start of the array is legal');
		assert.strictEqual(snapToLegalBoundary(messages, messages.length), messages.length, 'the end is legal: nothing is kept');
		assert.strictEqual(snapToLegalBoundary([tool(), tool()], 1), 0,
			'with no assistant anywhere there is no legal cut, so it reports "summarise nothing"');
		assert.strictEqual(snapToLegalBoundary([tool(), tool()], 2), 2,
			'a boundary at the end keeps nothing and needs no repair — planCompaction never chooses one');
	});

	test('a decorative row in front of a tool result does not hide the cut', () => {
		// `interrupted_streaming_tool` rows are dropped by the projection, so a cut
		// in front of one still surfaces the tool result with its assistant gone.
		const messages: CompactionMessageLike[] = [
			user(), assistant(), { role: 'interrupted_streaming_tool' }, tool(),
		];

		assert.strictEqual(isLegalCut(messages, 2), false);
		assert.strictEqual(snapToLegalBoundary(messages, 2), 1);
		assert.strictEqual(isLegalCut(messages, messages.length), true);
	});

	test('message chars follow the accounting the compaction prompt targets', () => {
		assert.strictEqual(messageChars({ role: 'user', content: 'abc' }), 3);
		assert.strictEqual(messageChars({ role: 'assistant', displayContent: 'abc', reasoning: 'de' }), 5);
		assert.strictEqual(messageChars({ role: 'tool', rawParamsStr: 'ab', result: 'cde' }), 5);
		assert.strictEqual(messageChars({ role: 'tool', rawParamsStr: 'ab', result: { content: 'cde' } }), 5);
		assert.strictEqual(messageChars({ role: 'tool', rawParamsStr: 'ab', result: null }), 2);
		assert.strictEqual(messageChars({ role: 'interrupted_streaming_tool' }), 0);
	});
});
