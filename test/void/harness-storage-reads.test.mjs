/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The harness's own reads, over values larger than one buffer.
//
// Every test in this tier asserts on what reached `state.vscdb`, and it reads it by
// spawning `sqlite3`. Without an explicit `maxBuffer` that spawn gets Node's 1 MB
// default, so a value bigger than that fails with `ENOBUFS` — a bare spawn error
// that says nothing about storage and looks like a broken test rather than a broken
// harness.
//
// It is not hypothetical. A single chat thread in a real profile had 4.5 MB of
// metadata, and it is the threads that grow that are worth verifying against real
// data: the biggest thread held 61% of everything reclaimable. The synthetic
// fixtures the rest of this tier uses are small, which is exactly why this went
// unnoticed.
//
//   npm run test-void -- --only=harness-storage-reads
//   VOID_EXPECT=lost npm run test-void -- --only=harness-storage-reads

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

// Comfortably past the 1 MB default, and past the 4.5 MB the real thread had.
const BIG_CHARS = 5 * 1024 * 1024
const SMALL_CHARS = 64 * 1024
const BIG_KEY = 'void.test.harness.big'
const SMALL_KEY = 'void.test.harness.small'

before(() => h.preflight())

describe('harness storage reads', () => {

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
})
