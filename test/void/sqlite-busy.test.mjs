/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A write that meets a locked database must wait, not be lost.
//
// Every window owns a connection to the same `state.vscdb`
// (`SQLiteStorageDatabase` in base/parts/storage/node/storage.ts), and the
// connection is opened without a `busy_timeout` — so a statement that meets
// another writer's lock returns SQLITE_BUSY immediately. On the read path that
// surfaces as a rejected `getItems()` at startup; on the write path the error
// arrives on the statement's `error` event, the connection is marked erroneous,
// and `END TRANSACTION` still commits — the write is silently dropped while
// `flush()` reports success.
//
// The scenario holds a real write lock from a second process, proves a competing
// writer is refused, has the app store a value while the lock is held, releases
// it, and asserts the value is in the database.
//
//   npm run test-void -- --only=sqlite-busy

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

const dbPath = (dirs) => join(dirs.userDataDir, 'User', 'globalStorage', 'state.vscdb')
const PROBE_SQL = "INSERT INTO ItemTable (key, value) VALUES ('void.lockProbe', 'x');"

/**
 * Opens a second connection and takes the write lock, keeping it until the
 * returned release() is called. `BEGIN IMMEDIATE` acquires the reserved lock at
 * once; the sqlite3 CLI stays alive reading stdin, so the lock is held for as
 * long as we say, which is what a competing window or a long write looks like.
 */
function holdWriteLock(db) {
	const locker = spawn('sqlite3', [db], { stdio: ['pipe', 'ignore', 'pipe'] })
	let stderr = ''
	locker.stderr.on('data', (d) => { stderr += String(d) })
	locker.stdin.write('BEGIN IMMEDIATE;\n')
	return {
		async release() {
			locker.stdin.write('COMMIT;\n')
			locker.stdin.end()
			await new Promise((resolve) => locker.once('exit', resolve))
			return stderr
		},
		kill() { locker.kill() },
	}
}

describe('sqlite lock contention', () => {

	test('a write made while another process holds the lock is not lost', async (t) => {
		const dirs = h.createProfile('sqlite-busy/write-' + Date.now())
		const session = await h.launchVoid(dirs)
		try {
			const db = dbPath(dirs)
			const lock = holdWriteLock(db)

			// Prove the lock is held before the app writes: a competing writer must be
			// refused. Without this the scenario can pass without earning it — a slow CLI
			// start lets the app write freely and the assertion then proves nothing.
			const probe = () => spawnSync('sqlite3', [db, PROBE_SQL], { encoding: 'utf8' })
			let refused = false
			for (let attempt = 0; attempt < 20 && !refused; attempt++) {
				refused = probe().status !== 0
				if (!refused) await h.sleep(100)
			}
			assert.ok(refused, 'the write lock was never acquired, so the scenario proves nothing')
			t.diagnostic('competing writer refused while the lock is held')

			const write = session.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				svc._storageService.store('void.busyProbe', 'written-under-lock', -1, 0)
				try {
					await svc._storageService.flush()
					return { ok: true }
				} catch (error) {
					return { ok: false, error: String(error) }
				}
			})

			// Release the lock from the outside, as a competing window finishing its
			// write would.
			await h.sleep(1500)
			const stderr = await lock.release()
			t.diagnostic('locker stderr: ' + JSON.stringify(stderr.slice(0, 200)))

			const result = await write
			t.diagnostic('flush: ' + JSON.stringify(result))
			assert.equal(result.ok, true, 'the flush rejected: ' + result.error)

			// The point of the scenario: the value is in the database, not just in the
			// renderer's cache. Read it back through a separate sqlite3 process.
			//
			// Polled: the storage channel batches writes, so a flush resolving does not
			// by itself mean the row is committed. A lost write never appears, which is
			// the distinction this scenario is for.
			let stored
			for (let attempt = 0; attempt < 50 && stored !== 'written-under-lock'; attempt++) {
				stored = session.readKey('void.busyProbe')
				if (stored !== 'written-under-lock') await h.sleep(100)
			}
			t.diagnostic('persisted value: ' + JSON.stringify(stored))
			h.assertPersistence(
				'a write that met a locked database is persisted once the lock is released',
				stored === 'written-under-lock',
				{ subject: true },
			)

			// And the window is still usable — a busy database must not take the app
			// down with it.
			const alive = await session.page.evaluate(() => !!globalThis.__voidChatThreadService).catch(() => false)
			assert.ok(alive, 'the app did not survive a locked database write')
		} finally {
			await session.close()
		}
	})
})
