/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { nextStepperIdx, prevStepperIdx, StepperPosition } from '../commandBarStepper.js';

// The changed-file stepper in the command bar. Three of these cases pin
// behaviour fixed in #116 so it cannot regress again; the "nothing current"
// group covers the case that fix missed.
suite('CommandBarStepper', () => {

	const next = (p: StepperPosition) => nextStepperIdx(p)
	const prev = (p: StepperPosition) => prevStepperIdx(p)

	test('no changed files: nothing to navigate to', () => {
		assert.strictEqual(next({ listLength: 0, currentIdx: null, lastIdx: null }), null);
		assert.strictEqual(prev({ listLength: 0, currentIdx: null, lastIdx: null }), null);
	});

	test('showing a changed file: steps within the list, wrapping', () => {
		assert.strictEqual(next({ listLength: 3, currentIdx: 0, lastIdx: 0 }), 1);
		assert.strictEqual(next({ listLength: 3, currentIdx: 1, lastIdx: 1 }), 2);
		assert.strictEqual(next({ listLength: 3, currentIdx: 2, lastIdx: 2 }), 0, 'Next wraps from the last file');

		assert.strictEqual(prev({ listLength: 3, currentIdx: 2, lastIdx: 2 }), 1);
		assert.strictEqual(prev({ listLength: 3, currentIdx: 1, lastIdx: 1 }), 0);
		assert.strictEqual(prev({ listLength: 3, currentIdx: 0, lastIdx: 0 }), 2, 'Prev wraps from the first file');
	});

	test('single changed file: Next and Prev both stay on it', () => {
		assert.strictEqual(next({ listLength: 1, currentIdx: 0, lastIdx: 0 }), 0);
		assert.strictEqual(prev({ listLength: 1, currentIdx: 0, lastIdx: 0 }), 0);
	});

	// #116: after approving the file it was showing, the bar has no current
	// index. Next must land on the slot the successor slid into, not one past
	// it — that was "Next skips a file".
	test('file just approved: Next lands on the successor that took its slot', () => {
		assert.strictEqual(next({ listLength: 3, currentIdx: null, lastIdx: 1 }), 1);
		assert.strictEqual(prev({ listLength: 3, currentIdx: null, lastIdx: 1 }), 0);
	});

	// #116: the removed file was last, so no successor slid into its slot and
	// clamping would land on the new last — going backwards. Next wraps instead.
	test('last file approved: Next wraps to the first file', () => {
		assert.strictEqual(next({ listLength: 3, currentIdx: null, lastIdx: 3 }), 0);
	});

	// The bar is mounted per editor and only learns a position once it has shown
	// a file with diffs. Nothing current and no memory is therefore the normal
	// state when the agent edits a file the user never had open: the list is not
	// empty, but the bar has never occupied an index.
	test('nothing current and no memory: Next reaches the first changed file', () => {
		assert.strictEqual(
			next({ listLength: 3, currentIdx: null, lastIdx: null }), 0,
			'the stepper cannot reach a changed file until one has been opened by hand',
		);
		assert.strictEqual(
			next({ listLength: 1, currentIdx: null, lastIdx: null }), 0,
			'a single changed file is unreachable for the same reason',
		);
	});

	test('nothing current and no memory: Prev reaches the last changed file', () => {
		assert.strictEqual(
			prev({ listLength: 3, currentIdx: null, lastIdx: null }), 2,
			'Prev should land on the last changed file, not one before it',
		);
		assert.strictEqual(
			prev({ listLength: 1, currentIdx: null, lastIdx: null }), 0,
			'a single changed file is unreachable for the same reason',
		);
	});
});
