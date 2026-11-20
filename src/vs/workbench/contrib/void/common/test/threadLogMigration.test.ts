/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrateThreadsToLogs } from '../../electron-main/threadLogMigration.js';
import { MESSAGE_KEY_PREFIX, THREAD_KEY_PREFIX } from '../storageKeys.js';
import { THREAD_STORE_FORMAT_LOG } from '../threadLog.js';

// The conversion that runs before the renderer's mirror is built.
//
// Four things are checked, and each has a way of looking right while being wrong: the log
// is contiguous after a checkpoint or a gap is compacted (the anchor must move with it, or
// a message falls outside both the summary and the verbatim tail), the metadata is written
// only after the file exists (the reverse leaves a thread claiming a log that is not there),
// a thread that cannot be converted stays readable through its keys, and a second run does
// nothing at all.

const user = (text: string) => JSON.stringify({ role: 'user', content: text, displayContent: text, selections: null, state: { stagingSelections: [], isBeingEdited: false } })
const assistant = (text: string) => JSON.stringify({ role: 'assistant', displayContent: text, reasoning: '', anthropicReasoning: null })
const checkpoint = () => JSON.stringify({ role: 'checkpoint', content: '' })

suite('ThreadLogMigration', () => {

	let root: string

	/** The items map the storage service would hand over, keyed exactly as it is stored. */
	const items = () => new Map<string, string>()
	const thread = (map: Map<string, string>, id: string, metadata: object) => map.set(THREAD_KEY_PREFIX + id, JSON.stringify(metadata))
	const message = (map: Map<string, string>, id: string, index: number, raw: string) => map.set(`${MESSAGE_KEY_PREFIX}${id}.${index}`, raw)
	const metadataOf = (map: Map<string, string>, id: string) => JSON.parse(map.get(THREAD_KEY_PREFIX + id)!)
	const logFile = (id: string) => path.join(root, 'void', 'threads', id, 'messages.jsonl')

	const readLines = async (id: string) => (await fs.readFile(logFile(id), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))

	const convert = (map: Map<string, string>) => migrateThreadsToLogs(root, map, (key, value) => map.set(key, value), key => map.delete(key))

	setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'void-thread-migration-')) })
	teardown(async () => { await fs.rm(root, { recursive: true, force: true }) })

	test('a key-backed thread becomes a log without losing its keys', async () => {
		const map = items()
		thread(map, 't1', { id: 't1', createdAt: 'now', messages: [] })
		message(map, 't1', 0, user('hello'))
		message(map, 't1', 1, assistant('hi'))

		const result = await convert(map)

		assert.deepStrictEqual(result, { converted: 1, failed: 0, allThreadsAreLogs: true })
		const lines = await readLines('t1')
		assert.deepStrictEqual(lines.map(l => l.m.displayContent), ['hello', 'hi'])
		assert.deepStrictEqual(lines.map(l => l.i), [0, 1])

		const metadata = metadataOf(map, 't1')
		assert.strictEqual(metadata.storeFormatVersion, THREAD_STORE_FORMAT_LOG)
		assert.strictEqual(metadata.title, 'hello', 'the tab label is persisted with the thread')

		// The safety net: every original row is still in the database.
		assert.strictEqual(map.get(`${MESSAGE_KEY_PREFIX}t1.0`), user('hello'))
		assert.strictEqual(map.get(`${MESSAGE_KEY_PREFIX}t1.1`), assistant('hi'))
	})

	test('an already-converted thread is left alone', async () => {
		const map = items()
		thread(map, 'done', { id: 'done', storeFormatVersion: THREAD_STORE_FORMAT_LOG, messages: [] })
		message(map, 'done', 0, user('hello'))

		const result = await convert(map)

		assert.deepStrictEqual(result, { converted: 0, failed: 0, allThreadsAreLogs: true })
		await assert.rejects(fs.stat(logFile('done')), /ENOENT/, 'nothing should have been written')
	})

	test('a checkpoint record is dropped and the anchor moves with it', async () => {
		// Key 1 is a checkpoint below an anchor of 3, so everything after it shifts down
		// one and the anchor has to move down with them.
		const map = items()
		thread(map, 'ckpt', { id: 'ckpt', compactionBoundaryIdx: 3, messages: [] })
		message(map, 'ckpt', 0, user('a'))
		message(map, 'ckpt', 1, checkpoint())
		message(map, 'ckpt', 2, assistant('b'))
		message(map, 'ckpt', 3, user('c'))

		await convert(map)

		const lines = await readLines('ckpt')
		assert.deepStrictEqual(lines.map(l => l.m.displayContent), ['a', 'b', 'c'])
		assert.deepStrictEqual(lines.map(l => l.i), [0, 1, 2], 'the log is contiguous')
		assert.strictEqual(metadataOf(map, 'ckpt').compactionBoundaryIdx, 2, 'the anchor moved down by the dropped record')
	})

	test('a gap in the key indices is closed and counted against the anchor', async () => {
		// Keys 0,1,3,4 with an anchor of 4: key 2 was deleted, so four messages become
		// three and the anchor must become 3.
		const map = items()
		thread(map, 'gap', { id: 'gap', compactionBoundaryIdx: 4, messages: [] })
		message(map, 'gap', 0, user('a'))
		message(map, 'gap', 1, assistant('b'))
		message(map, 'gap', 3, assistant('c'))
		message(map, 'gap', 4, user('d'))

		await convert(map)

		const lines = await readLines('gap')
		assert.deepStrictEqual(lines.map(l => l.m.displayContent), ['a', 'b', 'c', 'd'])
		assert.deepStrictEqual(lines.map(l => l.i), [0, 1, 2, 3])
		assert.strictEqual(metadataOf(map, 'gap').compactionBoundaryIdx, 3)
	})

	test('an empty thread is converted without creating a file', async () => {
		const map = items()
		thread(map, 'empty', { id: 'empty', messages: [] })

		const result = await convert(map)

		assert.deepStrictEqual(result, { converted: 1, failed: 0, allThreadsAreLogs: true })
		assert.strictEqual(metadataOf(map, 'empty').storeFormatVersion, THREAD_STORE_FORMAT_LOG)
		await assert.rejects(fs.stat(logFile('empty')), /ENOENT/)
	})

	test('a thread that cannot be converted keeps its keys and stops the mirror filter', async () => {
		const map = items()
		map.set(THREAD_KEY_PREFIX + 'broken', 'not json')
		thread(map, 'fine', { id: 'fine', messages: [] })
		message(map, 'fine', 0, user('a'))

		const result = await convert(map)

		assert.strictEqual(result.failed, 1)
		assert.strictEqual(result.converted, 1)
		assert.strictEqual(result.allThreadsAreLogs, false, 'one unreadable thread must keep the whole mirror intact')
		assert.strictEqual(map.get(THREAD_KEY_PREFIX + 'broken'), 'not json', 'the unreadable row is not rewritten')
	})

	test('a thread whose file cannot be written stays key-backed', async () => {
		// `void/threads` exists as a file, so every mkdir below it fails — the shape of a
		// full disk or a blocked directory without needing either.
		await fs.mkdir(path.join(root, 'void'), { recursive: true })
		await fs.writeFile(path.join(root, 'void', 'threads'), 'not a directory')

		const map = items()
		thread(map, 'blocked', { id: 'blocked', messages: [] })
		message(map, 'blocked', 0, user('a'))

		const result = await convert(map)

		assert.deepStrictEqual(result, { converted: 0, failed: 1, allThreadsAreLogs: false })
		const metadata = metadataOf(map, 'blocked')
		assert.strictEqual(metadata.storeFormatVersion, undefined, 'the metadata must not claim a log that was never written')
		assert.strictEqual(map.get(`${MESSAGE_KEY_PREFIX}blocked.0`), user('a'), 'the message is still readable through its key')
	})

	test('dead metadata fields and checkpoint keys go with the conversion', async () => {
		const map = items()
		thread(map, 'legacy', {
			id: 'legacy', createdAt: 'now', messages: [],
			filesWithUserChanges: {},
			state: { stagingSelections: [], linksOfMessageIdx: {}, currCheckpointIdx: 3, mountedInfo: { whenMounted: {} } },
		})
		message(map, 'legacy', 0, user('a'))
		map.set('void.chatCheckpoint.legacy.0', JSON.stringify({ role: 'checkpoint' }))
		map.set('void.chatCheckpoint.legacy.1', JSON.stringify({ role: 'checkpoint' }))

		await convert(map)

		const written = metadataOf(map, 'legacy')
		assert.strictEqual('filesWithUserChanges' in written, false, 'the Set that serialized as {} is gone')
		assert.strictEqual('currCheckpointIdx' in written.state, false, 'the removed feature cursor is gone')
		assert.strictEqual('mountedInfo' in written.state, false, 'live mount wiring is not persisted')
		assert.strictEqual(map.get('void.chatCheckpoint.legacy.0'), undefined, 'the separate checkpoint key range is gone')
		assert.strictEqual(map.get('void.chatCheckpoint.legacy.1'), undefined)
	})

	test('an abandoned temporary file is removed by the next conversion', async () => {
		const map = items()
		thread(map, 't-tmp', { id: 't-tmp', messages: [] })
		message(map, 't-tmp', 0, user('a'))
		const dir = path.join(root, 'void', 'threads', 't-tmp')
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, 'messages.jsonl.999.1.tmp'), 'half a record')

		await convert(map)

		assert.deepStrictEqual(await fs.readdir(dir), ['messages.jsonl'], 'the leftover is not left beside the log')
	})

	test('a second run does nothing', async () => {		const map = items()
		thread(map, 'twice', { id: 'twice', messages: [] })
		message(map, 'twice', 0, user('a'))

		await convert(map)
		const first = await fs.readFile(logFile('twice'), 'utf8')

		const result = await convert(map)

		assert.deepStrictEqual(result, { converted: 0, failed: 0, allThreadsAreLogs: true })
		assert.strictEqual(await fs.readFile(logFile('twice'), 'utf8'), first)
	})

	test('message keys with no thread metadata are left alone', async () => {
		const map = items()
		message(map, 'orphan', 3, user('lost'))

		const result = await convert(map)

		assert.deepStrictEqual(result, { converted: 0, failed: 0, allThreadsAreLogs: true })
		assert.strictEqual(map.get(`${MESSAGE_KEY_PREFIX}orphan.3`), user('lost'))
		await assert.rejects(fs.stat(logFile('orphan')), /ENOENT/)
	})
})
