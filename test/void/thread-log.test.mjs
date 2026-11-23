/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The message log, end to end: a thread's messages live in
// `void/threads/<id>/messages.jsonl`, the keys they came from are kept,
// and the lifecycle (read, duplicate, delete) moves with the file.
//
// Two things are load-bearing and are asserted rather than assumed:
//
//   - A thread created by this build writes a log and no `void.chatMsg.*` keys. Without
//     this the branch is a second store bolted on beside the first.
//   - A key-backed thread is converted on the first launch, *before* the renderer's
//     mirror is built, and its keys stay in the database. Converted-then-deleted would
//     pass the first half of that and lose the escape hatch the change is promising.
//
//   npm run test-void -- --only=thread-log

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

const logPath = (dirs, threadId) => join(dirs.userDataDir, 'User', 'globalStorage', 'void', 'threads', threadId, 'messages.jsonl')
const readRecords = (file) => readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))

const user = (text) => JSON.stringify({
	role: 'user', content: text, displayContent: text, selections: null,
	state: { stagingSelections: [], isBeingEdited: false },
})

async function waitForFile(file, present, label, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (existsSync(file) === present) return
		await h.sleep(100)
	}
	throw new Error(`timed out waiting for ${label}: ${file} present=${existsSync(file)}`)
}

describe('thread message log', () => {

	test('a key-backed thread is converted on the first launch and its keys are kept', async (t) => {
		const dirs = h.createProfile('thread-log/upgrade')
		const id = 'upgrade-0000-4000-8000-000000000001'
		const now = new Date().toISOString()
		h.writeAppKeys(dirs, [
			['void.chatThreadIndex', JSON.stringify([id])],
			[`void.chatThread.${id}`, JSON.stringify({ id, createdAt: now, lastModified: now, messages: [] })],
			[`void.chatMsg.${id}.0`, user('first')],
			[`void.chatMsg.${id}.1`, user('second')],
		])
		assert.equal((h.readAppKey(dirs, `void.chatMsg.${id}.0`) ?? '').includes('first'), true,
			'fixture did not seed the message keys')

		const s = await h.launchVoid(dirs)
		try {
			// Control: the conversion is the reason the log exists, so the log has to exist.
			assert.equal(existsSync(logPath(dirs, id)), true, 'the key-backed thread was not converted at launch')
			assert.deepEqual(readRecords(logPath(dirs, id)).map(r => r.m.displayContent), ['first', 'second'])

			// Subject: the renderer never received the message rows. This is the whole point —
			// a launch stops paying for them.
			const mirrored = await s.page.evaluate((threadId) =>
				globalThis.__voidChatThreadService._storageService.get(`void.chatMsg.${threadId}.0`, -1) === undefined, id)
			h.assertAbsent('message keys in the renderer mirror', mirrored, { subject: true })

			// Control: they are still in the database, which is the downgrade promise.
			assert.equal((h.readAppKey(dirs, `void.chatMsg.${id}.0`) ?? '').includes('first'), true,
				'the conversion deleted the message keys — a downgrade would now lose the conversation')

			// And the thread still opens with its conversation, read from the log.
			const messages = await s.page.evaluate(async (threadId) => {
				const svc = globalThis.__voidChatThreadService
				await svc.ensureMessagesLoaded(threadId)
				return svc.getThreadWithMessages(threadId).messages.map(m => m.displayContent)
			}, id)
			assert.deepEqual(messages, ['first', 'second'], 'the converted thread does not read back from its log')
		}
		finally {
			await s.close()
		}
	})

	test('a new thread writes a log, and duplicate and delete move with it', async (t) => {
		await h.withScenario('thread-log/turn', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.stubLLM(s.page, 'ok')

			const threadId = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				await svc.addUserMessageAndStreamResponse({ userMessage: 'log me please', threadId: id })
				return id
			})
			await h.waitForRunEnd(s.page)
			await waitForFile(logPath(s.dirs, threadId), true, 'the turn to write its log')
			// The last append is in flight, not awaited by the turn.
			await h.sleep(300)

			const records = readRecords(logPath(s.dirs, threadId))
			assert.ok(records.length >= 2, `expected the turn's messages in the log, found ${records.length}`)
			assert.deepEqual(records.map(r => r.i), records.map((_, n) => n), 'the records are contiguous')

			h.assertPersistence('the new thread has a log file', existsSync(logPath(s.dirs, threadId)), { subject: true })
			h.assertAbsent('void.chatMsg keys for the new thread',
				s.listKeys(`void.chatMsg.${threadId}.%`).length === 0, { subject: true })

			// Duplicating copies the conversation into its own file rather than pointing at
			// the source's, which is deleted with the source.
			const duplicateId = await s.page.evaluate((id) => globalThis.__voidChatThreadService.duplicateThread(id), threadId)
			assert.ok(duplicateId, 'the duplicate was not created')
			await waitForFile(logPath(s.dirs, duplicateId), true, 'the duplicate to write its log')
			assert.equal(readRecords(logPath(s.dirs, duplicateId)).length, records.length,
				'the duplicate does not hold the same records as its source')
			h.assertAbsent('void.chatMsg keys for the duplicate',
				s.listKeys(`void.chatMsg.${duplicateId}.%`).length === 0, { subject: true })

			// And deleting removes only the deleted thread's file.
			await s.page.evaluate((id) => globalThis.__voidChatThreadService.deleteThread(id), duplicateId)
			await waitForFile(logPath(s.dirs, duplicateId), false, 'the delete to remove the log')
			h.assertAbsent('the deleted thread\'s log', !existsSync(logPath(s.dirs, duplicateId)), { subject: true })
			assert.equal(existsSync(logPath(s.dirs, threadId)), true, 'deleting the duplicate removed the original')
		})
	})
})
