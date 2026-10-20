/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Whether the load path still renumbers a thread out from under its compaction
// anchor — bug 3, `thread-storage.md` §1.6.
//
// The loader walks message keys `0..100000`, skips gaps, and *rewrites* keys to
// contiguous indices whenever a gap exists (`chatThreadService.ts:1590`). The array it
// builds is therefore compacted while `compactionBoundaryIdx` — a positional anchor —
// is remapped only by `checkpointsBeforeBoundary`, which counts `role === 'checkpoint'`
// records and nothing else. A gap left by a deleted real message is shifted down
// without the anchor moving, so the anchor ends up one message further along than it
// was: the message that used to sit at the tail boundary drops out of the verbatim
// tail without entering the summary either.
//
// S10c's startup sweep compacts the same keys with the same code, which is why this is
// worth pinning rather than assuming either way: if the sweep already closes every gap
// a profile can hold, the trigger is unreachable and the log format loses its last
// non-memory motivation. If it does not, the trigger is live and this is a correctness
// bug that does not need a format change to fix.
//
//   npm run test-void -- --only=compaction-gap

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

const THREAD_ID = '5eeded20-0000-4000-8000-000000000003'

// Keys 0,1,3,4 — the gap at 2 is what a deleted message leaves behind. The anchor of 4
// means "keys 0..3 are in the summary, key 4 is the verbatim tail", so the message at
// key 4 must still be outside the summary after the thread loads.
const SEEDED_KEYS = [0, 1, 3, 4]
const SEEDED_BOUNDARY = 4
const TAIL_CONTENT = 'M4-TAIL-MESSAGE'

const contentOfKey = (i) => (i === 4 ? TAIL_CONTENT : `M${i}`)

const messageOfKey = (i) => ({ role: 'user', content: contentOfKey(i), displayContent: contentOfKey(i), selections: null })

function seedThreadWithGap(dirs) {
	const entries = [
		['void.chatThreadIndex', JSON.stringify([THREAD_ID])],
		[`void.chatThread.${THREAD_ID}`, JSON.stringify({
			id: THREAD_ID,
			createdAt: '2026-01-01T00:00:00.000Z',
			lastModified: '2026-01-02T00:00:00.000Z',
			compactionSummary: 'SUMMARY-OF-KEYS-0-TO-3',
			compactionBoundaryIdx: SEEDED_BOUNDARY,
			state: { stagingSelections: [], linksOfMessageIdx: {} },
		})],
	]
	for (const i of SEEDED_KEYS) entries.push([`void.chatMsg.${THREAD_ID}.${i}`, JSON.stringify(messageOfKey(i))])
	h.writeAppKeys(dirs, entries)
}

describe('compaction anchor across a key gap', () => {

	test('the anchor still points at the same message after a gapped thread loads', async (t) => {
		const dirs = h.createProfile('compaction-gap/load')
		seedThreadWithGap(dirs)

		// Guard the fixture: the gap and the anchor must both be on disk before the app
		// sees them, or the load below proves nothing about either.
		assert.equal(h.readAppKey(dirs, `void.chatMsg.${THREAD_ID}.2`), undefined,
			'fixture did not leave a gap at key 2')
		assert.equal(h.readAppKey(dirs, `void.chatMsg.${THREAD_ID}.4`)?.includes(TAIL_CONTENT), true,
			'fixture did not seed the tail message at key 4')
		assert.match(h.readThreadMetadata(dirs, THREAD_ID) ?? '', /"compactionBoundaryIdx":4/,
			'fixture did not seed the boundary at 4')

		const s = await h.launchVoid(dirs)
		try {
			// Open it the way a tab click does.
			await s.page.evaluate((id) => globalThis.__voidChatThreadService.switchToThread(id), THREAD_ID)

			const loaded = await s.page.evaluate((id) => {
				const thread = globalThis.__voidChatThreadService.state.allThreads[id]
				const messages = thread?.messages ?? []
				return {
					count: messages.length,
					boundary: thread?.compactionBoundaryIdx,
					tailContents: messages.map(m => m.displayContent ?? m.content ?? null),
					indexOfTail: messages.findIndex(m => (m.displayContent ?? m.content) === 'M4-TAIL-MESSAGE'),
				}
			}, THREAD_ID)

			t.diagnostic(`after load: ${loaded.count} message(s), anchor=${loaded.boundary}, ` +
				`tail message at index ${loaded.indexOfTail}, contents=${JSON.stringify(loaded.tailContents)}`)

			// Control: the thread loaded at all, with its messages. Otherwise "the anchor
			// is wrong" would be a statement about nothing.
			assert.equal(loaded.count, SEEDED_KEYS.length,
				`the thread loaded ${loaded.count} messages, expected ${SEEDED_KEYS.length}`)
			assert.ok(loaded.indexOfTail >= 0, 'the tail message did not survive the load')

			// The subject. `[0, boundary)` is the compacted prefix and the rest is sent
			// verbatim, so a message at an index below the anchor must be represented in
			// the summary — and this one is not, because the summary describes keys 0-3
			// and the tail message was at key 4. If the compaction moved it below the
			// anchor without moving the anchor, it is in neither.
			h.assertPersistence(
				'the tail message is still outside the compacted prefix',
				loaded.boundary !== undefined && loaded.indexOfTail >= loaded.boundary,
				{ subject: true },
			)
		} finally {
			await s.close()
		}
	})
})
