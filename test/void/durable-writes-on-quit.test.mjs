/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pending chat-thread writes must survive quitting within the write-coalescing
// window (bug 15 in docs/designs/thread-storage.md).
//
// _storeThread() does not write; it queues into _pendingThreadWrites and schedules
// a flush 500ms out. The shutdown flush used to run on onWillShutdown, but the
// workbench registers its own onWillShutdown listener during startup which closes
// storage first, and writes to closed storage are dropped without error.
//
// Symptom: compact a thread and quit right away and the compaction is gone on
// relaunch; compact, send a message, then quit and it survives, because the
// debounce fired in the meantime.
//
// Each scenario cancels the debounce before quitting, so "did shutdown persist
// this?" is deterministic instead of a race. The control scenario deliberately
// leaves the debounce alone and must always pass — it proves the probe and the
// compaction path work, so a failure above it means shutdown, not the harness.
//
//   npm run test-void
//   VOID_EXPECT=lost npm run test-void    # must fail on unmodified code

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

const MARKER = {
	rename: 'E2E-RENAME',
	compactionWrite: 'E2E-COMPACTION-WRITE',
	compaction: 'E2E-COMPACTION',
	control: 'E2E-CONTROL',
}

before(() => h.preflight())

/** Prints the storage trace when a scenario fails, so CI logs are diagnosable. */
function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

describe('durable writes on quit', () => {

	test('a thread rename queued at quit is persisted', async (t) => {
		await h.withScenario('durable-writes/rename', async (s) => {
			await h.instrumentThreadStorage(s.page)

			const { threadId } = await s.page.evaluate((marker) => {
				const svc = globalThis.__voidChatThreadService
				const threadId = svc.state.currentThreadId
				svc.setThreadCustomTitle(threadId, marker)   // public API; queues a metadata write
				return { threadId }
			}, MARKER.rename)

			await h.cancelFlushScheduler(s.page)
			// Guard: if the write were not still queued, the debounce would be
			// what saved it and this scenario would prove nothing.
			assert.equal(await h.pendingThreadWrites(s.page), 1, 'expected the rename to still be queued at quit')

			await s.close()   // graceful quit, exercising the shutdown path
			trace(t, s)
			h.assertPersistence('thread rename', (s.readThread(threadId) ?? '').includes(MARKER.rename), { subject: true })
		})
	})

	test('a compaction-shaped metadata write queued at quit is persisted', async (t) => {
		await h.withScenario('durable-writes/compaction-write', async (s) => {
			await h.instrumentThreadStorage(s.page)

			const { threadId } = await s.page.evaluate((marker) => {
				const svc = globalThis.__voidChatThreadService
				const threadId = svc.state.currentThreadId
				// Exactly the write compactCurrentThread performs at its end, in
				// isolation from the compaction machinery.
				const thread = svc.state.allThreads[threadId]
				const updated = {
					...thread,
					lastModified: new Date().toISOString(),
					compactionSummary: marker,
					compactionBoundaryIdx: 4,
					compactionPercent: 50,
					compactionSavedTokens: 1234,
				}
				svc._storeThread(threadId, updated)
				svc._setState({ allThreads: { ...svc.state.allThreads, [threadId]: updated } })
				return { threadId }
			}, MARKER.compactionWrite)

			await h.cancelFlushScheduler(s.page)
			assert.equal(await h.pendingThreadWrites(s.page), 1, 'expected the metadata write to still be queued at quit')

			await s.close()
			trace(t, s)
			h.assertPersistence('compaction metadata write', (s.readThread(threadId) ?? '').includes(MARKER.compactionWrite), { subject: true })
		})
	})

	test('a completed compaction survives quitting immediately', async (t) => {
		await h.withScenario('durable-writes/compaction', async (s) => {
			await h.instrumentThreadStorage(s.page)
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 15)
			await h.stubLLM(s.page, MARKER.compaction)   // real compaction, faked transport

			const result = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const threadId = svc.state.currentThreadId
				const outcome = await svc.compactCurrentThread({ compactPercent: 50, protectTurns: 1, protectMessages: 2 })
				const thread = svc.state.allThreads[threadId]
				return {
					threadId,
					error: outcome === null ? null : String(outcome),
					boundaryIdx: thread?.compactionBoundaryIdx,
					summaryLength: thread?.compactionSummary?.length ?? 0,
				}
			})

			// Guard: a compaction that silently refused to run would otherwise
			// look like a failed persistence assertion.
			assert.equal(result.error, null, `compaction did not run: ${result.error}`)
			assert.ok(result.summaryLength > 0, 'compaction produced no summary')
			assert.ok(result.boundaryIdx > 0, 'compaction produced no boundary')

			await h.cancelFlushScheduler(s.page)
			await s.close()
			trace(t, s)
			h.assertPersistence('completed compaction', (s.readThread(result.threadId) ?? '').includes(MARKER.compaction), { subject: true })
		})
	})

	test('control: the same compaction is persisted when the debounce is allowed to fire', async (t) => {
		await h.withScenario('durable-writes/control', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 15)
			await h.stubLLM(s.page, MARKER.control)

			const result = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const threadId = svc.state.currentThreadId
				const outcome = await svc.compactCurrentThread({ compactPercent: 50, protectTurns: 1, protectMessages: 2 })
				const thread = svc.state.allThreads[threadId]
				return { threadId, error: outcome === null ? null : String(outcome), summaryLength: thread?.compactionSummary?.length ?? 0 }
			})
			assert.equal(result.error, null, `compaction did not run: ${result.error}`)
			assert.ok(result.summaryLength > 0, 'compaction produced no summary')

			await h.sleep(2000)   // let the 500ms coalescing timer fire
			await s.close()
			trace(t, s)
			h.assertPersistence('control compaction', (s.readThread(result.threadId) ?? '').includes(MARKER.control))
		})
	})
})
