/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { URI } from '../../../../../base/common/uri.js';
import { ChatMessage } from '../chatThreadServiceTypes.js';
import { encodeRecord } from '../threadLog.js';
import { ThreadStoreChannel } from '../../electron-main/threadStoreChannel.js';
import { ThreadStoreRecord } from '../threadStoreTypes.js';

// The channel is written for the main process but depends on nothing Electron-specific,
// which is what lets the fast tier exercise it against a real temporary directory. It
// lives in `common/test` because the node runner excludes `electron-main/**` by path, not
// because a filesystem test belongs to the common layer.
//
// What is being guarded is the part the format module cannot see: a torn final record
// left by a crashed append, a complete record that lost only its terminator, a rewrite
// that must not leave a half-written log, and two operations on one thread that must not
// interleave.

const message = (text: string): ChatMessage => ({
	role: 'assistant',
	displayContent: text,
	reasoning: '',
	anthropicReasoning: null,
})

const rec = (i: number, text: string): ThreadStoreRecord => ({ i, m: message(text) })

const texts = (read: { messages: ChatMessage[] }) => read.messages.map(m => (m as { displayContent: string }).displayContent)

const exists = async (file: string) => {
	try { await fs.stat(file); return true }
	catch { return false }
}

suite('ThreadStoreChannel', () => {

	let root: string
	let channel: ThreadStoreChannel

	/** Where the channel puts a thread's log, spelled out so the test does not ask it. */
	const logFile = (threadId: string) => path.join(root, 'void', 'threads', threadId, 'messages.jsonl')

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'void-thread-store-'))
		channel = new ThreadStoreChannel(URI.file(root))
	})

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	test('append creates the log and readAll returns the messages', async () => {
		const appended = await channel.call({}, 'append', { threadId: 't1', records: [rec(0, 'a'), rec(1, 'b')] })
		assert.deepStrictEqual(appended, { records: 2 })

		const read = await channel.call({}, 'readAll', { threadId: 't1' })
		assert.strictEqual(read.exists, true)
		assert.deepStrictEqual(texts(read), ['a', 'b'])
		assert.deepStrictEqual(read.indices, [0, 1])
		assert.strictEqual(read.duplicateCount, 0)
		assert.deepStrictEqual(read.gapIndices, [])
		assert.strictEqual(read.malformedLines, 0)
		assert.strictEqual(read.tornTail, false)
	})

	test('readAll on a thread with no log says so instead of throwing', async () => {
		const read = await channel.call({}, 'readAll', { threadId: 'never-written' })
		assert.strictEqual(read.exists, false)
		assert.deepStrictEqual(read.messages, [])
	})

	test('append repairs a torn final record before writing', async () => {
		const file = logFile('torn')
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, encodeRecord(rec(0, 'a')) + '{"i":1,"m":{"role":"assi', 'utf8')

		const appended = await channel.call({}, 'append', { threadId: 'torn', records: [rec(1, 'b')] })
		assert.deepStrictEqual(appended, { records: 1 })

		// Without the repair the new record would be glued onto the fragment, and both
		// lines would fail to parse.
		const read = await channel.call({}, 'readAll', { threadId: 'torn' })
		assert.deepStrictEqual(texts(read), ['a', 'b'])
		assert.strictEqual(read.malformedLines, 0)
		assert.strictEqual(read.tornTail, false)
	})

	test('append terminates a complete record that lost its newline', async () => {
		const file = logFile('unterminated')
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, encodeRecord(rec(0, 'a')).trimEnd(), 'utf8')

		await channel.call({}, 'append', { threadId: 'unterminated', records: [rec(1, 'b')] })

		const raw = await fs.readFile(file, 'utf8')
		assert.strictEqual(raw.split('\n').length, 3, 'two terminated records and the empty tail')

		const read = await channel.call({}, 'readAll', { threadId: 'unterminated' })
		assert.deepStrictEqual(texts(read), ['a', 'b'])
	})

	test('truncateFrom keeps a supersede that sits after the boundary', async () => {
		await channel.call({}, 'writeAll', { threadId: 'trunc', messages: [message('a'), message('b'), message('c')] })
		await channel.call({}, 'append', { threadId: 'trunc', records: [rec(1, 'b2')] })

		const truncated = await channel.call({}, 'truncateFrom', { threadId: 'trunc', boundary: 2 })
		assert.deepStrictEqual(truncated, { records: 2 })

		const read = await channel.call({}, 'readAll', { threadId: 'trunc' })
		assert.deepStrictEqual(texts(read), ['a', 'b2'], 'b was superseded after c was written')
	})

	test('a corrupt line is surfaced, not swallowed', async () => {
		const file = logFile('corrupt')
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, encodeRecord(rec(0, 'a')) + 'not json\n' + encodeRecord(rec(2, 'c')), 'utf8')

		const read = await channel.call({}, 'readAll', { threadId: 'corrupt' })
		assert.deepStrictEqual(texts(read), ['a', 'c'])
		assert.strictEqual(read.malformedLines, 1)
		assert.deepStrictEqual(read.gapIndices, [1], 'the lost row is visible as a gap')
	})

	test('deleteThread removes the log and leaves the thread\'s images', async () => {
		const dir = path.join(root, 'void', 'threads', 't-del')
		await fs.mkdir(path.join(dir, 'images'), { recursive: true })
		await fs.writeFile(path.join(dir, 'images', 'shot.png'), 'x')
		await channel.call({}, 'append', { threadId: 't-del', records: [rec(0, 'a')] })

		await channel.call({}, 'deleteThread', { threadId: 't-del' })

		assert.strictEqual(await exists(logFile('t-del')), false)
		assert.strictEqual(await exists(path.join(dir, 'images', 'shot.png')), true, 'images are deleted by their owner, not here')
	})

	test('copyThread copies the records and the copies diverge afterwards', async () => {
		await channel.call({}, 'writeAll', { threadId: 'src', messages: [message('a'), message('b')] })
		await channel.call({}, 'copyThread', { fromId: 'src', toId: 'dst' })

		await channel.call({}, 'append', { threadId: 'dst', records: [rec(2, 'c')] })

		assert.deepStrictEqual(texts(await channel.call({}, 'readAll', { threadId: 'src' })), ['a', 'b'])
		assert.deepStrictEqual(texts(await channel.call({}, 'readAll', { threadId: 'dst' })), ['a', 'b', 'c'])
	})

	test('two appends issued together both land, in order', async () => {
		// The queue is the only thing ordering these: without it the second append can
		// start while the first is still opening, and the file interleaves.
		const first = channel.call({}, 'append', { threadId: 'q', records: [rec(0, 'a')] })
		const second = channel.call({}, 'append', { threadId: 'q', records: [rec(1, 'b')] })
		await Promise.all([first, second])

		const read = await channel.call({}, 'readAll', { threadId: 'q' })
		assert.deepStrictEqual(texts(read), ['a', 'b'])
		assert.deepStrictEqual(read.indices, [0, 1])
	})

	test('an invalid thread id is refused before it touches the filesystem', async () => {
		await assert.rejects(
			channel.call({}, 'append', { threadId: '../escape', records: [rec(0, 'a')] }),
			/invalid thread id/,
		)
		assert.strictEqual(await exists(path.join(root, 'void', 'escape')), false)
	})
})
