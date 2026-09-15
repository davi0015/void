/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Compaction anchoring and context accounting — bugs 4, 5 and 16 in
// docs/designs/thread-storage.md.
//
// Bug 4  compactionBoundaryIdx is tested for truthiness, so a boundary of 0
//        drops the compaction entirely. `0` is reachable: the load-path remap
//        computes `oldBoundary - checkpointsBeforeBoundary`.
// Bug 5  _ensureMessagesLoaded spreads the pre-read thread over the freshly
//        read one, discarding the boundary correction _readThread just made.
// Bug 16 the pre-compaction usage is restored in memory but the compaction
//        request's usage wins at flush time, so the ring changes on reopen.
//
//   npm run test-void -- --only=compaction-context
//   VOID_EXPECT=lost npm run test-void -- --only=compaction-context

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

const MARKER = {
	boundaryZero: 'S2-SUMMARY-AT-BOUNDARY-ZERO',
	legacySummary: 'S2-LEGACY-SUMMARY',
}

before(() => h.preflight())

/** Prints storage traces when a scenario fails, so CI logs are diagnosable. */
function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

describe('compaction context accounting', () => {

	test('a compaction at boundary 0 still reaches the model', async (t) => {
		await h.withScenario('compaction-context/boundary-zero', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 4)
			await h.stubLLM(s.page, 'acknowledged')

			// A compacted thread whose boundary is 0: everything is at or after
			// the boundary, so the summary must be prepended and nothing dropped.
			const prepared = await s.page.evaluate((marker) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const thread = { ...svc.state.allThreads[id], compactionSummary: marker, compactionBoundaryIdx: 0, compactionPercent: 50 }
				svc._storeThreadDurably(id, thread)
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: thread } })
				return { id, boundaryIdx: svc.state.allThreads[id].compactionBoundaryIdx, messages: svc.state.allThreads[id].messages.length }
			}, MARKER.boundaryZero)

			// Guard: the scenario is meaningless unless the boundary really is 0
			// and there is history for the summary to sit in front of.
			assert.equal(prepared.boundaryIdx, 0, 'fixture did not set boundary 0')
			assert.ok(prepared.messages > 0, 'fixture has no messages')

			await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				await svc.addUserMessageAndStreamResponse({ userMessage: 'carry on', threadId: svc.state.currentThreadId })
			})

			const requests = await h.capturedLLMRequests(s.page)
			const count = await h.capturedLLMRequestCount(s.page)
			trace(t, s)
			assert.ok(count > 0, 'no request reached the model transport')
			assert.ok(
				requests.includes(MARKER.boundaryZero),
				'the compaction summary was not sent to the model at boundary 0 — the compaction was silently dropped',
			)
		})
	})

	test('a remapped boundary reaches memory, not just storage', async (t) => {
		await h.withScenario('compaction-context/remap', async (s) => {
			const result = await s.page.evaluate((legacySummary) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId

				// A legacy thread: real messages 0-5, then two checkpoint records
				// at 6 and 7, with metadata claiming the boundary sits at 8.
				// Loading must shift the boundary to 6 (8 - 2 checkpoints).
				for (let i = 0; i < 6; i++) {
					svc._storeMessageKey(id, i, i % 2 === 0
						? { role: 'user', content: 'u' + i, displayContent: 'u' + i, selections: null }
						: { role: 'assistant', displayContent: 'a' + i, reasoning: '', anthropicReasoning: null })
				}
				svc._storeMessageKey(id, 6, { role: 'checkpoint' })
				svc._storeMessageKey(id, 7, { role: 'checkpoint' })

				const stale = { ...svc.state.allThreads[id], compactionSummary: legacySummary, compactionBoundaryIdx: 8 }
				svc._storeThread(id, stale)
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: stale } })
				svc._flushPendingThreadWrites()

				// Force the load path to run again, as reopening the thread would.
				svc._loadedMessageThreadIds.delete(id)
				svc._ensureMessagesLoaded(id)

				return {
					id,
					inMemory: svc.state.allThreads[id].compactionBoundaryIdx,
					inStorage: svc._readThread(id, false)?.compactionBoundaryIdx,
				}
			}, MARKER.legacySummary)

			trace(t, s)
			// Guard: the remap must actually have run, or the comparison is vacuous.
			assert.equal(result.inStorage, 6, `expected the stored boundary to be remapped to 6, got ${result.inStorage}`)
			assert.equal(
				result.inMemory, 6,
				'the corrected boundary did not reach memory — the session keeps using the stale index until restart',
			)
		})
	})

	test('the token ring reads the same before and after a restart', async (t) => {
		// Two sessions on one profile: the ring's value has to survive the trip.
		const dirs = h.createProfile('compaction-context/ring')
		const priorUsage = { inputTokens: 4321, outputTokens: 55, totalTokens: 4376, requestCount: 1 }

		let live
		let first = await h.launchVoid(dirs)
		try {
			await h.ensureModelSelection(first.page)
			await h.seedTestThread(first.page, 15)
			await h.stubLLM(first.page, 'summary text')

			live = await first.page.evaluate(async (prior) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				// The user's last real turn, before compaction.
				svc.state.allThreads[id].latestUsage = prior
				svc.latestUsageOfThreadId[id] = prior

				const outcome = await svc.compactCurrentThread({ compactPercent: 50, protectTurns: 1, protectMessages: 2 })
				const thread = svc.state.allThreads[id]
				return {
					id,
					error: outcome === null ? null : String(outcome),
					summaryLength: thread?.compactionSummary?.length ?? 0,
					usage: thread?.latestUsage,
				}
			}, priorUsage)
		} finally {
			await first.close()
		}

		trace(t, first)
		assert.equal(live.error, null, `compaction did not run: ${live.error}`)
		assert.ok(live.summaryLength > 0, 'compaction produced no summary')
		assert.deepEqual(live.usage, priorUsage, 'the live ring value should be the restored pre-compaction usage')

		const second = await h.launchVoid(dirs)
		try {
			const persisted = JSON.parse(second.readKey(`void.chatUsage.${live.id}`) ?? '{}')
			assert.deepEqual(
				persisted.latestUsage, live.usage,
				`the ring changed across a restart: live totalTokens=${live.usage?.totalTokens}, persisted totalTokens=${persisted.latestUsage?.totalTokens}. `
				+ 'The compaction request\'s own usage was written instead of the restored value.',
			)
		} finally {
			await second.close()
		}
	})
})
