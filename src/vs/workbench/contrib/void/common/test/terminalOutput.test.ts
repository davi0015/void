/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalCommandOutputTracker } from '../terminalOutput.js'

// The pty stream is chunked arbitrarily, so a marker can be split across feeds;
// and the terminal can fire `onCommandFinished` before the `633;D` bytes reach
// `onData`, so the window is taken while still open. Both shapes are covered
// here because the service relies on them.

const C = '\x1b]633;C\x07'
const D = '\x1b]633;D\x07'
const D0 = '\x1b]633;D;0\x07'

const feedAll = (chunks: string[]) => {
	const tracker = new TerminalCommandOutputTracker()
	for (const chunk of chunks) tracker.feed(chunk)
	return tracker
}

describe('terminal command output tracking', () => {

	test('keeps only the bytes between C and D', () => {
		const tracker = feedAll([`user@host repo % echo hi\r\n${C}hi\r\n${D}user@host repo % `])
		assert.equal(tracker.take(), 'hi\r\n')
		assert.equal(tracker.take(), null)
	})

	test('a D payload carries the exit code', () => {
		const tracker = feedAll([C, 'out', D0])
		assert.equal(tracker.take(), 'out')
	})

	test('an empty window is an empty string, not "no command"', () => {
		const tracker = feedAll([C, D])
		assert.equal(tracker.take(), '')
	})

	test('no shell integration means no window', () => {
		const tracker = feedAll(['user@host repo % echo hi\r\nhi\r\nuser@host repo % '])
		assert.equal(tracker.take(), null)
	})

	test('a marker split across chunks is reassembled', () => {
		const tracker = feedAll(['\x1b]633', ';C\x07a', 'b\x1b]633;D;1\x07'])
		assert.equal(tracker.take(), 'ab')
	})

	test('several commands come back in order', () => {
		const tracker = feedAll([`${C}one${D}prompt ${C}two${D}`])
		assert.equal(tracker.take(), 'one')
		assert.equal(tracker.take(), 'two')
	})

	test('a window taken while still collecting is not taken twice', () => {
		// onCommandFinished fires before the D bytes reach onData.
		const tracker = feedAll([C, 'partial'])
		assert.equal(tracker.take(), 'partial')
		tracker.feed(D)
		assert.equal(tracker.take(), null)
	})

	test('other shell-integration sequences inside the window are not output', () => {
		const tracker = feedAll([C, 'line1\n', '\x1b]633;A\x07', 'line2\n', D])
		assert.equal(tracker.take(), 'line1\nline2\n')
	})

	test('a partial marker at the end is held until the next chunk', () => {
		const tracker = feedAll([`${C}out\x1b]633;`])
		assert.equal(tracker.take(), 'out')
		tracker.feed('D\x07')
		assert.equal(tracker.take(), null)
	})
})
