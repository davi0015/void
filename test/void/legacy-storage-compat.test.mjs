/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Legacy thread storage compatibility.
//
// Checkpoints were removed as a feature, but threads written before the removal
// are still on disk: their message keys carry `role: 'checkpoint'` records
// interleaved with real messages, sometimes with gaps from earlier deletes, and
// their `compactionBoundaryIdx` counts those records. The load path has to keep
// tolerating that shape — dropping the tolerance would load checkpoint records
// into the conversation and leave the compaction boundary off by the number of
// checkpoints in front of it (bug 3, and the remap S2 verified).
//
// This file is the S3 acceptance gate:
//   * a thread containing legacy checkpoint records still loads;
//   * no persisted thread metadata carries runtime-only fields (`mountedInfo`,
//     `filesWithUserChanges` — bug 11 and bug 12).
//
// The first scenario is a control: it must pass before and after S3, and it is
// what stops the residue cleanup from over-deleting the read path.
//
//   npm run test-void -- --only=legacy-storage
//   VOID_EXPECT=lost npm run test-void -- --only=legacy-storage

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

const LEGACY_SUMMARY = 'S3-LEGACY-SUMMARY'

before(() => h.preflight())

/** Prints storage traces when a scenario fails, so CI logs are diagnosable. */
function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

describe('legacy thread storage compatibility', () => {

	test('a thread containing legacy checkpoint records still loads', async (t) => {
		await h.withScenario('legacy-storage/checkpoint-records', async (s) => {
			const result = await s.page.evaluate((summary) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId

				// A pre-removal thread, reconstructed faithfully: real messages
				// at keys 0,1,2,4,5 (the gap at 3 is from an old delete),
				// checkpoint records occupying 3 and 6, and a boundary of 7 that
				// still counts them.
				const realAt = [0, 1, 2, 4, 5]
				for (const i of realAt) {
					svc._storeMessageKey(id, i, i % 2 === 0
						? { role: 'user', content: 'u' + i, displayContent: 'u' + i, selections: null }
						: { role: 'assistant', displayContent: 'a' + i, reasoning: '', anthropicReasoning: null })
				}
				svc._storeMessageKey(id, 3, { role: 'checkpoint' })
				svc._storeMessageKey(id, 6, { role: 'checkpoint' })

				const legacy = { ...svc.state.allThreads[id], messages: [], compactionSummary: summary, compactionBoundaryIdx: 7 }
				svc._storeThread(id, legacy)
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: legacy } })
				svc._flushPendingThreadWrites()

				// Force the load path to run as reopening the thread would.
				svc._loadedMessageThreadIds.delete(id)
				svc._ensureMessagesLoaded(id)

				const thread = svc.state.allThreads[id]
				return {
					roles: thread.messages.map(m => m.role),
					boundary: thread.compactionBoundaryIdx,
					summaryKept: thread.compactionSummary === summary,
				}
			}, LEGACY_SUMMARY)

			trace(t, s)
			// Guard: the fixture must have produced a loadable legacy thread.
			// Without this, "no checkpoint records leaked" is true for the
			// uninteresting reason that nothing loaded at all.
			assert.ok(result.roles.length > 0, 'the legacy thread did not load — fixture or read path is broken')

			assert.equal(
				result.roles.filter(r => r === 'checkpoint').length, 0,
				`checkpoint records leaked into the conversation: [${result.roles.join(', ')}]`,
			)
			assert.equal(result.roles.length, 5, `expected the 5 real messages, got ${result.roles.length}`)
			assert.equal(
				result.boundary, 5,
				`expected the boundary remapped from 7 to 5 (minus the 2 checkpoint records), got ${result.boundary}`,
			)
			assert.ok(result.summaryKept, 'the compaction summary was lost while loading the legacy thread')
		})
	})

	test('persisted metadata carries no runtime-only fields', async (t) => {
		await h.withScenario('legacy-storage/junk-fields', async (s) => {
			const built = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const thread = svc.state.allThreads[id]

				// Build the situation explicitly instead of hoping the sidebar
				// mounted: mountedInfo is created by _setThreadState when a
				// thread's UI mounts, which a headless run may never do. Shape
				// mirrors chatThreadService's own creation site.
				thread.state.mountedInfo = {
					whenMounted: new Promise(() => { /* never resolves in this run */ }),
					_whenMountedResolver: () => { /* live wiring, not data */ },
					mountedIsResolvedRef: { current: false },
				}
				svc._storeThreadDurably(id, thread)
				return {
					id,
					mountedInfoInMemory: thread.state.mountedInfo !== undefined,
					filesWithUserChangesInMemory: 'filesWithUserChanges' in thread,
				}
			})

			// Guard: the fixture must actually have put the junk in memory, or
			// "not persisted" would hold for the wrong reason.
			assert.ok(built.mountedInfoInMemory, 'fixture failed to create state.mountedInfo')

			await h.sleep(600) // the storage layer debounces ~100ms per hop
			const raw = s.readThread(built.id)
			trace(t, s)
			assert.ok(raw, 'no thread metadata reached the database at all')
			const parsed = JSON.parse(raw)

			// Control: real metadata still persists, so a strip that removed
			// everything would not read as success.
			assert.ok(
				typeof parsed.workspaceUri === 'string' && Array.isArray(parsed.state?.stagingSelections),
				`the strip removed real metadata too: keys = [${Object.keys(parsed).join(', ')}]`,
			)

			h.assertAbsent(
				'state.mountedInfo in persisted metadata',
				!('mountedInfo' in (parsed.state ?? {})),
				{ subject: true },
			)
			h.assertAbsent(
				'filesWithUserChanges in persisted metadata',
				!('filesWithUserChanges' in parsed),
				{ subject: true },
			)

			// The strip is a serialization concern only: the live object must
			// still hold the mount plumbing, or focus/blur/scroll-to-bottom break.
			const stillLive = await s.page.evaluate((id) => globalThis.__voidChatThreadService.state.allThreads[id]?.state.mountedInfo !== undefined, built.id)
			assert.ok(stillLive, 'stripping mountedInfo from storage also removed it from the live thread')
		})
	})
})
