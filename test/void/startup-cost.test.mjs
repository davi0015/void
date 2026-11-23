/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// What a launch costs in stored conversation volume, after S10b.
//
// Before S10b the renderer's `Storage` mirrored the whole application store at startup
// — `cache = await database.getItems()`, no filter — so a launch paid for every message
// ever stored, whether or not its thread was opened. Bug 1 in
// `docs/designs/thread-storage.md`.
//
// Now message bodies live in `threads/<id>/messages.jsonl`, and the startup pass converts
// any key-backed thread before the mirror is built. So this file asserts the *inverted*
// behaviour: after launch, the seeded `void.chatMsg.*` values are NOT resident in the
// renderer, although their threads exist and were not opened. The keys are still in the
// database — they are held for a downgrade — which is why the assertion is about the
// mirror rather than about the rows.
//
// The timings remain the deliverable and are printed as diagnostics: a control profile
// with no messages and a seeded one, each launched RUNS times. This file cannot assert a
// duration without becoming a flaky stopwatch; the mechanism is the assertion and the
// numbers are what a release decision reads.
//
//   npm run test-void -- --only=startup-cost
//   VOID_STARTUP_MEASURE=1 VOID_STARTUP_THREADS=40 VOID_STARTUP_MESSAGES=2500 \
//     npm run test-void -- --only=startup-cost
//
// Message bodies are padded to ~3 KB (two padded fields): a real assistant turn
// carrying a tool result is that order, and total bytes — not key count — is
// what crosses IPC.
//
// Reference result before S10b (this repository, dev build, 2026-11-19, medians of three):
//
//   10,000 messages,  39.6 MB   5.8 s control -> 6.3 s load   (+0.4 s, inside noise)
//  100,000 messages, 395.3 MB   5.9 s control -> 8.7 s load   (+2.9 s, 29 ms/1000)

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

const THREADS = Number(process.env.VOID_STARTUP_THREADS ?? 20)
const MESSAGES = Number(process.env.VOID_STARTUP_MESSAGES ?? 500)
const PAD = Number(process.env.VOID_STARTUP_PAD ?? 1400)
// Timings are only meaningful when this file runs alone: under the full suite a dozen
// apps launch at once and the spread swamps the effect (measured: 30.2 s vs 17.9 s for
// profiles whose own delta is 0.2 s). So the suite checks the mechanism only, and the
// numbers are produced on demand with VOID_STARTUP_MEASURE=1.
const MEASURE = process.env.VOID_STARTUP_MEASURE === '1'
const RUNS = Number(process.env.VOID_STARTUP_RUNS ?? (MEASURE ? 3 : 1))

// Mirrors of common/storageKeys.ts, kept literal because this tier is plain JS.
const THREAD_KEY_PREFIX = 'void.chatThread.'
const THREAD_INDEX_KEY = 'void.chatThreadIndex'
const MESSAGE_KEY_PREFIX = 'void.chatMsg.'

const dbPath = (dirs) => join(dirs.userDataDir, 'User', 'globalStorage', 'state.vscdb')

/** Launches once and times it: from spawn to the chat service being ready. */
async function timeLaunch(dirs) {
	const started = Date.now()
	const scenario = await h.launchVoid(dirs)
	return { scenario, ms: Date.now() - started }
}

/** Median of a small sample, so one outlier cannot be the number reported. */
function median(values) {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

/**
 * How many seeded message values resolve from the renderer's storage cache.
 *
 * `StorageService.keys()` cannot answer this: it filters by a separate
 * key-target map that only the service itself maintains, so a database-seeded
 * profile reports zero keys even though every value is resident. `get(key, scope)`
 * reads the cache that `getItems()` filled at startup, which is the mirror the
 * measurement is about.
 */
function sampleMirror(page, { threads, perThread, samplePerThread = 10 }) {
	return page.evaluate(({ threads, perThread, samplePerThread }) => {
		const svc = globalThis.__voidChatThreadService
		let present = 0
		let total = 0
		for (let t = 0; t < threads; t++) {
			for (let i = 0; i < Math.min(perThread, samplePerThread); i++) {
				total++
				if (svc._storageService.get(`void.chatMsg.seed-${t}.${i}`, -1) !== undefined) present++
			}
		}
		return { present, total, metadata: svc._storageService.get('void.chatThread.seed-0', -1) !== undefined }
	}, { threads, perThread, samplePerThread })
}

describe('launch cost', () => {

	test('a launch no longer pays for stored messages, opened or not', async (t) => {
		// ── the fixture shape, taken from a real thread rather than invented ──
		// `_populateTestThread` fills memory without queueing message keys, so the
		// template is driven through a real (stubbed) turn: that is what persists
		// `void.chatMsg.*` in the shape the app writes and reads.
		const templateDirs = h.createProfile('startup-cost/template')
		const template = await timeLaunch(templateDirs)
		await h.ensureModelSelection(template.scenario.page)
		await h.stubLLM(template.scenario.page, 'ok')
		const ids = await template.scenario.page.evaluate(async () => {
			const svc = globalThis.__voidChatThreadService
			await svc.addUserMessageAndStreamResponse({ userMessage: 'template turn', threadId: svc.state.currentThreadId })
			return { threadId: svc.state.currentThreadId }
		})
		await h.waitForRunEnd(template.scenario.page)
		await template.scenario.close()

		// The message shape now comes from the thread's log: the template turn is a new
		// thread, and new threads store their messages there from birth.
		const templateLog = join(templateDirs.userDataDir, 'User', 'globalStorage', 'void', 'threads', ids.threadId, 'messages.jsonl')
		assert.ok(existsSync(templateLog), 'the template turn persisted no log, so the message shape is unknown')
		const templateRecords = readFileSync(templateLog, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
		const assistantRecord = templateRecords.find(record => record.m.role === 'assistant')
		assert.ok(assistantRecord, 'the template log has no assistant message, so the message shape is unknown')
		assert.equal(template.scenario.listKeys('void.chatMsg.%').length, 0,
			'a new thread wrote message keys, so it is not using the log')

		const metaRaw = template.scenario.readKey(THREAD_KEY_PREFIX + ids.threadId)
		assert.ok(metaRaw, 'the fixture thread did not persist its metadata, so the shape is unknown')
		const meta = JSON.parse(metaRaw)
		const message = assistantRecord.m
		t.diagnostic(`fixture: metadata ${metaRaw.length} chars, message ${JSON.stringify(message).length} chars, ${templateRecords.length} record(s)`)

		// ── control: same app, a profile with the store but no messages ──────
		const controlDirs = h.createProfile('startup-cost/control')
		h.writeAppKeys(controlDirs, [])
		const controlRuns = []
		for (let i = 0; i < RUNS; i++) {
			const { scenario, ms } = await timeLaunch(controlDirs)
			const mirrored = await sampleMirror(scenario.page, { threads: 0, perThread: 0 })
			controlRuns.push({ ms, mirrored })
			await scenario.close()
		}

		// ── load: THREADS x MESSAGES, seeded straight into state.vscdb ───────
		const loadDirs = h.createProfile('startup-cost/load')
		const entries = []
		const threadIds = []
		// The metadata carries the template profile's workspace path; JSON escapes
		// backslashes, so swap the escaped form rather than the raw path.
		const fromPath = JSON.stringify(templateDirs.workspacePath).slice(1, -1)
		const toPath = JSON.stringify(loadDirs.workspacePath).slice(1, -1)
		const metaJson = JSON.stringify(meta).split(fromPath).join(toPath)
		const padded = 'x'.repeat(Math.max(0, PAD))
		for (let thread = 0; thread < THREADS; thread++) {
			const id = `seed-${thread}`
			threadIds.push(id)
			const seededMeta = JSON.parse(metaJson)
			seededMeta.id = id
			// Seeded as key-backed threads on purpose: the fixture is the conversion, and a
			// thread that already claims a log would skip the pass this test is measuring.
			delete seededMeta.storeFormatVersion
			entries.push([THREAD_KEY_PREFIX + id, JSON.stringify(seededMeta)])
			for (let i = 0; i < MESSAGES; i++) {
				entries.push([MESSAGE_KEY_PREFIX + id + '.' + i, JSON.stringify({
					...message,
					content: `seeded message ${i} ` + padded,
					displayContent: `seeded message ${i} ` + padded,
				})])
			}
		}
		entries.push([THREAD_INDEX_KEY, JSON.stringify(threadIds)])
		const seedStarted = Date.now()
		h.writeAppKeys(loadDirs, entries)
		t.diagnostic(`seeded ${THREADS * MESSAGES} messages in ${Date.now() - seedStarted} ms`)

		const loadRuns = []
		for (let i = 0; i < RUNS; i++) {
			const { scenario, ms } = await timeLaunch(loadDirs)
			const mirrored = await sampleMirror(scenario.page, { threads: THREADS, perThread: MESSAGES })
			loadRuns.push({ ms, mirrored })
			await scenario.close()
		}

		// ── report ───────────────────────────────────────────────────────────
		const last = (runs) => runs[runs.length - 1]
		const dbBytes = statSync(dbPath(loadDirs)).size
		const controlMs = median(controlRuns.map(r => r.ms))
		const loadMs = median(loadRuns.map(r => r.ms))
		const deltaMs = loadMs - controlMs
		t.diagnostic(`control: ${controlRuns.map(r => r.ms).join(', ')} ms`)
		t.diagnostic(`load:    ${loadRuns.map(r => r.ms).join(', ')} ms`)
		t.diagnostic(`median:  control ${controlMs} ms, load ${loadMs} ms, delta ${deltaMs} ms`)
		t.diagnostic(`db:      ${(dbBytes / 1048576).toFixed(1)} MB for ${THREADS * MESSAGES} messages`)
		t.diagnostic(`mirror:  ${last(loadRuns).mirrored.present}/${last(loadRuns).mirrored.total} sampled message values resident in the renderer`)
		t.diagnostic(`cost:    ${(deltaMs / (THREADS * MESSAGES) * 1000).toFixed(2)} ms per 1000 stored messages (noise is the launch-to-launch spread above)`)

		// Controls: the comparison is only meaningful if the two profiles really
		// differ in the way claimed.
		assert.equal(last(controlRuns).mirrored.metadata, false, 'the control profile contains seeded thread metadata, so it is not a control')
		assert.equal(last(loadRuns).mirrored.total, THREADS * 10, 'the load profile was sampled for the wrong number of keys')
		assert.ok(last(loadRuns).mirrored.metadata, 'the seeded thread metadata did not reach the renderer, so the load was not read')

		// The subject, and the mechanism rather than a duration: none of the seeded
		// message values is resident in the renderer after launch. Their threads exist and
		// were never opened, so before S10b every one of them would have been present.
		assert.equal(
			last(loadRuns).mirrored.present,
			0,
			'seeded message values are resident after launch, so the bodies are still crossing IPC',
		)

		// Control: the threads themselves did reach the renderer, so a zero above is not
		// "the renderer got nothing".
		assert.ok(last(loadRuns).mirrored.metadata, 'the seeded thread metadata did not reach the renderer')

		// Control: the reason the values are absent is the conversion, not an empty profile.
		const convertedLog = join(loadDirs.userDataDir, 'User', 'globalStorage', 'void', 'threads', 'seed-0', 'messages.jsonl')
		assert.ok(existsSync(convertedLog), 'the seeded thread was not converted to a log at launch')
		assert.ok(readFileSync(convertedLog, 'utf8').trimEnd().split('\n').length >= MESSAGES,
			'the converted log holds fewer records than were seeded')
	})
})
