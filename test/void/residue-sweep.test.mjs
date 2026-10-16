/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Startup residue sweep (S10c).
//
// Checkpoints, `filesWithUserChanges`, `state.mountedInfo` and the request logs
// are all *removed features or removed fields* — nothing in the current build
// writes them. But the cleanup for them is **read-path only**: `_readThread`
// drops the junk fields in memory and compacts checkpoint records out of the
// message keys, and it is called with `loadMessages = true` only when a thread
// is opened. `_readAllThreadsSplit` calls it with `false` for every thread at
// startup and takes an early return before any of that work.
//
// So a profile that carries this residue keeps it until the user happens to open
// each affected thread. Measured on a real profile: 287 checkpoint records
// across 23 threads, in threads last opened weeks earlier. Because
// `Storage.init()` pulls every key over IPC at startup with no filter, that
// residue is paid for on every launch, forever.
//
// This file is S10c's acceptance gate: **residue is reclaimed without the thread
// being opened.** The distinction is the whole test — every existing legacy
// scenario drives the app into rewriting the thread, which is exactly what the
// user does not do.
//
// The profile is seeded *before* the app launches, and the seeded thread is
// deliberately not the one restored as current, so nothing opens it. A guard
// asserts that: if the thread were loaded, the read path would clean it and this
// file would pass for the wrong reason.
//
//   npm run test-void -- --only=residue-sweep
//   VOID_EXPECT=lost npm run test-void -- --only=residue-sweep

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

// A thread that is never the restored current thread, so it is never opened.
const SEEDED_ID = '5eeded00-0000-4000-8000-000000000c10'
const SUMMARY = 'S10C-LEGACY-SUMMARY'

// Real messages sit at keys 0,1,2,4,5 — the gap at 3 is from an old delete —
// with checkpoint records occupying 3 and 6, and a boundary of 7 that still
// counts them. This is the shape `legacy-storage-compat.test.mjs` established;
// the difference here is that nothing opens the thread.
const REAL_KEYS = [0, 1, 2, 4, 5]
const CHECKPOINT_KEYS = [3, 6]
const LEGACY_BOUNDARY = 7
const EXPECTED_BOUNDARY = 5 // 7 minus the 2 checkpoint records in front of it

const DAY_MS = 24 * 60 * 60 * 1000
// Log files older than this are reclaimed; newer ones are kept. The threshold
// lives in the sweep; this is the same number, restated here so the fixture can
// sit clearly on either side of it.
const LOG_RETENTION_DAYS = 7

const message = (i) => i % 2 === 0
	? { role: 'user', content: 'u' + i, displayContent: 'u' + i, selections: null }
	: { role: 'assistant', displayContent: 'a' + i, reasoning: '', anthropicReasoning: null }

/**
 * Builds the profile an older build left behind, directly in the database.
 *
 * This cannot be done through the app: the current build has no code path that
 * writes a checkpoint record or `filesWithUserChanges`, which is precisely why
 * the residue needs reclaiming rather than preventing.
 */
function seedLegacyProfile(dirs, { logDir }) {
	const metadata = {
		id: SEEDED_ID,
		createdAt: '2026-01-01T00:00:00.000Z',
		lastModified: '2026-01-02T00:00:00.000Z',
		compactionSummary: SUMMARY,
		compactionBoundaryIdx: LEGACY_BOUNDARY,
		// bug 11 — a Set, serialized as {}. Removed from the type, still on disk.
		filesWithUserChanges: {},
		state: {
			stagingSelections: [],
			linksOfMessageIdx: {},
			// removed with the checkpoint feature, still on disk
			currCheckpointIdx: 3,
			// bug 12 — live mount wiring serialized as junk
			mountedInfo: { whenMounted: {}, mountedIsResolvedRef: { current: false } },
		},
	}

	const entries = [
		['void.chatThreadIndex', JSON.stringify([SEEDED_ID])],
		[`void.chatThread.${SEEDED_ID}`, JSON.stringify(metadata)],
	]
	for (const i of REAL_KEYS) entries.push([`void.chatMsg.${SEEDED_ID}.${i}`, JSON.stringify(message(i))])
	for (const i of CHECKPOINT_KEYS) entries.push([`void.chatMsg.${SEEDED_ID}.${i}`, JSON.stringify({ role: 'checkpoint' })])
	// The separate checkpoint key range a pre-removal build also wrote.
	entries.push([`void.chatCheckpoint.${SEEDED_ID}.0`, JSON.stringify({ role: 'checkpoint' })])
	entries.push([`void.chatCheckpoint.${SEEDED_ID}.1`, JSON.stringify({ role: 'checkpoint' })])
	h.writeAppKeys(dirs, entries)

	// Two log files on either side of the retention threshold: the old one is the
	// subject, the recent one is the control that proves the sweep is not simply
	// emptying the directory.
	mkdirSync(logDir, { recursive: true })
	const now = Date.now()
	const stale = join(logDir, `compaction-${SEEDED_ID.slice(0, 8)}-2026-01-01T00-00-00-000Z.md`)
	const fresh = join(logDir, `thread-${SEEDED_ID}.jsonl`)
	writeFileSync(stale, '# Compaction Log\n\nfull transcript of the conversation\n')
	writeFileSync(fresh, '{"t":"recent"}\n')
	const oldSeconds = (now - (LOG_RETENTION_DAYS + 23) * DAY_MS) / 1000
	utimesSync(stale, oldSeconds, oldSeconds)
	return { stale, fresh }
}

/** The directory the app resolves `voidRequestLogs` to, as the app itself sees it. */
const logDirOf = (dirs) => join(dirs.userDataDir, 'User', 'voidRequestLogs')

// Windows paths are case-insensitive and the two sides are built differently —
// Node's `join` keeps the drive letter as the profile dir spelled it, while
// `URI.fsPath` reports it lowercased. Comparing raw strings therefore fails on a
// path that is the same directory, which reads as a real mismatch.
const samePath = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

async function waitFor(predicate, { timeoutMs = 30000, label = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (predicate()) return true
		if (Date.now() > deadline) {
			console.error(`[residue-sweep] timed out waiting for ${label}`)
			return false
		}
		await h.sleep(500)
	}
}

describe('startup residue sweep', () => {

	test('legacy storage residue is reclaimed without the thread being opened', async (t) => {
		const dirs = h.createProfile('residue-sweep/storage')
		const seeded = seedLegacyProfile(dirs, { logDir: logDirOf(dirs) })

		// Guard the fixture before the app ever sees it: if the residue is not on
		// disk now, its absence later proves nothing.
		assert.equal(h.readAppKey(dirs, `void.chatMsg.${SEEDED_ID}.3`), JSON.stringify({ role: 'checkpoint' }),
			'fixture did not seed the checkpoint record at message key 3')
		assert.ok((h.readThreadMetadata(dirs, SEEDED_ID) ?? '').includes('filesWithUserChanges'),
			'fixture did not seed filesWithUserChanges on disk')

		const s = await h.launchVoid(dirs)
		try {
			// Guard: the app must resolve its log directory to where the fixture put
			// the files, or the log assertions below are about a directory nothing
			// reads.
			const appLogDir = await s.page.evaluate(() => globalThis.__voidChatThreadService._environmentService.userRoamingDataHome.fsPath)
			assert.ok(samePath(join(appLogDir, 'voidRequestLogs'), logDirOf(dirs)),
				`the app resolves its request logs to ${appLogDir}, not the seeded profile dir`)

			// Guard: the fixture must have produced a thread the service loaded. If it
			// did not, every "residue is gone" assertion below holds for the
			// uninteresting reason that the thread does not exist.
			const loaded = await s.page.evaluate((id) => {
				const svc = globalThis.__voidChatThreadService
				return {
					inState: !!svc.state.allThreads[id],
					opened: svc._loadedMessageThreadIds.has(id),
				}
			}, SEEDED_ID)
			assert.ok(loaded.inState, 'the seeded thread did not load — the fixture is wrong, not the sweep')
			// The load-bearing guard. If the read path opened this thread, it would
			// clean the residue by itself and this file would pass with no sweep at
			// all — the bug would look fixed while remaining exactly as it was.
			assert.equal(loaded.opened, false,
				'the seeded thread was opened — the read path, not the sweep, would be doing the work')

			await waitFor(
				() => s.listKeys(`void.chatCheckpoint.${SEEDED_ID}.%`).length === 0,
				{ label: 'the sweep to reclaim the checkpoint keys' },
			)

			t.diagnostic(`message keys after sweep: [${s.listKeys(`void.chatMsg.${SEEDED_ID}.%`).join(', ')}]`)

			// ── checkpoint residue ──────────────────────────────────────────
			h.assertAbsent('legacy void.chatCheckpoint.* keys',
				s.listKeys(`void.chatCheckpoint.${SEEDED_ID}.%`).length === 0, { subject: true })

			const msgKeys = s.listKeys(`void.chatMsg.${SEEDED_ID}.%`).sort()
			h.assertAbsent('checkpoint records left in the message key range',
				!msgKeys.some(k => (h.readAppKey(dirs, k) ?? '').includes('"role":"checkpoint"')), { subject: true })

			// Compaction is the other half: the records are gone *and* the keys are
			// contiguous again, so the load path stops tolerating a gap.
			const expectedKeys = [0, 1, 2, 3, 4].map(i => `void.chatMsg.${SEEDED_ID}.${i}`)
			h.assertAbsent('a gap in the message key indices',
				msgKeys.length === expectedKeys.length && expectedKeys.every(k => msgKeys.includes(k)), { subject: true })

			// Control: the real conversation is untouched. A sweep that emptied the
			// thread would otherwise read as a clean success.
			h.assertPersistence('the 5 real messages survive',
				REAL_KEYS.every((_, i) => (h.readAppKey(dirs, `void.chatMsg.${SEEDED_ID}.${i}`) ?? '').includes('"role"')))

			// ── legacy metadata fields ──────────────────────────────────────
			const meta = h.readThreadMetadata(dirs, SEEDED_ID) ?? ''
			h.assertAbsent('filesWithUserChanges in persisted metadata',
				!meta.includes('filesWithUserChanges'), { subject: true })
			h.assertAbsent('state.mountedInfo in persisted metadata',
				!meta.includes('mountedInfo'), { subject: true })
			h.assertAbsent('state.currCheckpointIdx in persisted metadata',
				!meta.includes('currCheckpointIdx'), { subject: true })

			// Control: real metadata survives the rewrite.
			h.assertPersistence('the compaction summary survives', meta.includes(SUMMARY))

			const boundary = JSON.parse(meta).compactionBoundaryIdx
			assert.equal(boundary, EXPECTED_BOUNDARY,
				`expected the boundary remapped ${LEGACY_BOUNDARY} -> ${EXPECTED_BOUNDARY}, got ${boundary}`)
		} finally {
			await s.close()
		}
	})

	test('request logs are reclaimed by age, keeping the recent ones', async (t) => {
		const dirs = h.createProfile('residue-sweep/logs')
		const seeded = seedLegacyProfile(dirs, { logDir: logDirOf(dirs) })

		const s = await h.launchVoid(dirs)
		try {
			await waitFor(() => !existsSync(seeded.stale), { label: 'the stale log file to be reclaimed' })
			t.diagnostic(`log dir after sweep: [${readdirSync(logDirOf(dirs)).join(', ')}]`)

			h.assertAbsent('a request log older than the retention window',
				!existsSync(seeded.stale), { subject: true })

			// Control: a recent log is diagnostic material — the sweep bounds the
			// directory, it does not empty it.
			h.assertPersistence('a recent request log survives', existsSync(seeded.fresh))
		} finally {
			await s.close()
		}
	})
})
