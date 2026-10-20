/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The harness's own storage plumbing, at sizes where a naive implementation breaks.
//
// Every test in this tier asserts on what reached `state.vscdb`, and the harness
// reaches it by spawning `sqlite3`. That spawn has two limits that only show up with
// realistic data, and both fail as bare spawn errors that say nothing about storage —
// so they read as a broken test rather than a broken harness.
//
//   reads  — without an explicit `maxBuffer` the spawn gets Node's 1 MB default, so
//            a larger value fails with `ENOBUFS`. Not hypothetical: a single chat
//            thread in a real profile had 4.5 MB of metadata, and the biggest thread
//            held 61% of everything reclaimable.
//   writes — the SQL is an `argv` entry, so it inherits the platform's command-line
//            limit (32,767 characters on Windows). A few hundred seeded keys exceeds
//            it and fails with `ENAMETOOLONG`, which reads like `sqlite3` not being
//            installed at all.
//
// The synthetic fixtures the rest of this tier uses are small, which is exactly why
// both went unnoticed until a fixture needed to look like real data.
//
//   npm run test-void -- --only=harness-storage
//   VOID_EXPECT=lost npm run test-void -- --only=harness-storage

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

// Comfortably past the 1 MB default, and past the 4.5 MB the real thread had.
const BIG_CHARS = 5 * 1024 * 1024
const SMALL_CHARS = 64 * 1024
const BIG_KEY = 'void.test.harness.big'
const SMALL_KEY = 'void.test.harness.small'

// Past the Windows command-line limit once turned into SQL: 300 keys of 200 chars is
// roughly 65,000 characters of statement, the same order of magnitude as a fixture
// seeding a realistic conversation.
const MANY_COUNT = 300
const MANY_PAD = 200
const manyKey = (i) => `void.test.harness.many.${i}`

before(() => h.preflight())

describe('harness storage', () => {

	test('a value larger than the spawn default reads back whole', async (t) => {
		await h.withScenario('harness-storage-reads/big-value', async (s) => {
			const written = await s.page.evaluate(({ bigKey, smallKey, bigChars, smallChars }) => {
				const svc = globalThis.__voidChatThreadService
				// StorageScope.APPLICATION / StorageTarget.USER, as the service uses.
				const big = 'B'.repeat(bigChars)
				const small = 'S'.repeat(smallChars)
				svc._storageService.store(bigKey, big, -1, 0)
				svc._storageService.store(smallKey, small, -1, 0)
				return { big, small }
			}, { bigKey: BIG_KEY, smallKey: SMALL_KEY, bigChars: BIG_CHARS, smallChars: SMALL_CHARS })

			// Guard: the fixture must have written what it thinks it wrote. A short
			// value would make the assertion below pass for the wrong reason.
			assert.equal(written.big.length, BIG_CHARS, 'fixture did not build a large value')

			await h.sleep(600) // the storage layer debounces ~100ms per hop

			// Control: an ordinary-sized value reads. If this failed too, the harness
			// would be broken outright rather than at a size boundary, and the two
			// would not be worth telling apart.
			const small = h.readAppKey(s.dirs, SMALL_KEY)
			assert.equal(small?.length, SMALL_CHARS, 'the harness could not read a small value')

			let big
			let readError
			try {
				big = h.readAppKey(s.dirs, BIG_KEY)
			} catch (err) {
				readError = String(err?.message ?? err)
			}
			t.diagnostic(`read ${big?.length ?? 0} of ${BIG_CHARS} chars${readError ? ` — threw: ${readError}` : ''}`)

			h.assertPersistence(
				`a ${BIG_CHARS}-char value reads back whole`,
				big?.length === BIG_CHARS,
				{ subject: true },
			)
		})
	})

	// The write half. `writeAppKeys` hands its SQL to `sqlite3` as an `argv` entry, so
	// the seed size is bounded by the platform's command line rather than by SQLite.
	// No app is launched: seeding is only valid against a closed profile anyway, and a
	// launch would cost a minute to learn something about the harness.
	//
	// Plain assertions, not `assertPersistence`: this is the harness checking itself,
	// so it has to hold in both `VOID_EXPECT` directions. Inverting it under `lost`
	// would be asserting that the harness is broken.
	test('more keys than one command line can hold are seeded whole', async (t) => {
		const dirs = h.createProfile('harness-storage/many-keys')
		const entries = Array.from({ length: MANY_COUNT }, (_, i) => [manyKey(i), 'x'.repeat(MANY_PAD)])

		let writeError
		try {
			h.writeAppKeys(dirs, entries)
		} catch (err) {
			writeError = String(err?.message ?? err)
		}
		t.diagnostic(`seeded ${MANY_COUNT} keys of ${MANY_PAD} chars${writeError ? ` — threw: ${writeError}` : ''}`)
		assert.equal(writeError, undefined, `writeAppKeys threw on ${MANY_COUNT} keys: ${writeError}`)

		// Control: the ordinary case works. If this failed too, the write path would be
		// broken outright rather than at a size boundary, and the two are not worth
		// telling apart.
		const single = h.createProfile('harness-storage/one-key')
		h.writeAppKeys(single, [[SMALL_KEY, 'ok']])
		assert.equal(h.readAppKey(single, SMALL_KEY), 'ok', 'writeAppKeys could not write a single key')

		// Subject: every key, whole. The last one is the interesting one — a chunked
		// write that dropped its final partial statement would leave the earlier
		// chunks intact and fail only at the boundary.
		assert.equal(h.readAppKey(dirs, manyKey(0))?.length, MANY_PAD, 'the first seeded key is missing or short')
		assert.equal(h.readAppKey(dirs, manyKey(MANY_COUNT - 1))?.length, MANY_PAD,
			'the last seeded key is missing or short — a trailing chunk was dropped')

		const all = h.listAppKeys(dirs, 'void.test.harness.many.%')
		assert.equal(all.length, MANY_COUNT, `${all.length} of ${MANY_COUNT} seeded keys are present`)
	})
})
