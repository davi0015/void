/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	autoCompactThresholdTokens,
	AUTO_COMPACT_PERCENT,
	AUTO_COMPACT_PROTECT_TURNS,
	liveViewChars,
	shouldCompactProactively,
} from '../compactionTrigger.js';

// The arithmetic of "compact before sending": a fraction of the window with an absolute
// ceiling, and a size estimate that counts the live view rather than the message array.
//
// The cases worth pinning are the two ends of the ceiling (a small model is governed by
// the fraction, a large one by 30k) and the post-compaction estimate, which must not
// report the replaced messages — otherwise a compacted thread looks full forever and
// compacts on every iteration.

const user = (text: string) => ({ role: 'user', content: text });

suite('CompactionTrigger', () => {

	test('the threshold is 20% of the window, capped at 30k tokens', () => {
		assert.strictEqual(autoCompactThresholdTokens(32_000), 6_400, 'a small window is governed by the fraction');
		assert.strictEqual(autoCompactThresholdTokens(128_000), 25_600);
		assert.strictEqual(autoCompactThresholdTokens(400_000), 30_000, 'a large window is governed by the ceiling');
	});

	test('an unknown window never triggers', () => {
		assert.strictEqual(autoCompactThresholdTokens(0), 0);
		assert.strictEqual(shouldCompactProactively({ usedTokens: 1_000, contextWindowTokens: 0 }), false,
			'an unrecognized route is not a reason to summarise the conversation');
		assert.strictEqual(shouldCompactProactively({ usedTokens: 1_000, contextWindowTokens: NaN }), false);
	});

	test('compaction runs only once the remaining context is under the threshold', () => {
		const window = 128_000; // threshold 25,600
		assert.strictEqual(shouldCompactProactively({ usedTokens: 80_000, contextWindowTokens: window }), false,
			'48k left is enough headroom');
		assert.strictEqual(shouldCompactProactively({ usedTokens: 110_000, contextWindowTokens: window }), true,
			'18k left is not');
		assert.strictEqual(shouldCompactProactively({ usedTokens: window - 25_600, contextWindowTokens: window }), false,
			'sitting exactly on the threshold does not trigger; it is a floor to cross');
		assert.strictEqual(shouldCompactProactively({ usedTokens: window - 25_599, contextWindowTokens: window }), true);
	});

	test('the settings are the manual dialog\'s maximum retention', () => {
		assert.strictEqual(AUTO_COMPACT_PERCENT, 70, 'a summary targeting ~30% of the compacted span');
		assert.strictEqual(AUTO_COMPACT_PROTECT_TURNS, 10, 'the last ten turns stay verbatim');
	});

	test('the live view is the whole array before any compaction', () => {
		const messages = [user('aaa'), user('bb')];
		assert.strictEqual(liveViewChars({ messages, summary: undefined, boundaryIdx: undefined }), 5);
	});

	test('the live view is the summary plus the messages after the boundary', () => {
		const messages = [user('summarised-one'), user('summarised-two'), user('kept')];
		assert.strictEqual(
			liveViewChars({ messages, summary: 'S'.repeat(10), boundaryIdx: 2 }),
			10 + 4,
			'the two replaced messages must not be counted',
		);
	});

	test('a compacted thread does not report the messages it replaced', () => {
		const messages = Array.from({ length: 100 }, () => user('x'.repeat(1_000)));
		const before = liveViewChars({ messages, summary: undefined, boundaryIdx: undefined });
		const after = liveViewChars({ messages, summary: 'S'.repeat(2_000), boundaryIdx: 90 });

		assert.strictEqual(before, 100_000);
		assert.strictEqual(after, 2_000 + 10_000,
			'the live view must drop to the summary plus the kept tail, or the next iteration compacts again');
	});

	test('a boundary past the end counts the summary alone', () => {
		const messages = [user('a'), user('b')];
		assert.strictEqual(liveViewChars({ messages, summary: 'S'.repeat(7), boundaryIdx: 99 }), 7);
	});
});
