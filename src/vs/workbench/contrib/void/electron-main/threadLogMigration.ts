/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Converts a profile's threads from the mirrored `void.chatMsg.*` keys to their log
// files, once, before the renderer builds its mirror.
//
// The keys are *not* deleted. They stay in the database so a downgrade still finds them,
// and they stop costing anything because the mirror leaves them out once every thread has
// a log — see `ThreadLogMirrorPolicy` at the bottom and the `getItems` branch of
// `StorageDatabaseChannel`. That is the whole trade: the data stays, the transfer goes.
//
// Three details are load-bearing:
//
//   - The log is written before the metadata says so. A crash between the two leaves the
//     thread marked as a key-backed one, and the next launch converts it again over the
//     same file. The reverse order would leave a thread claiming a log that does not exist.
//   - Compaction still happens here. A thread that predates the checkpoint removal carries
//     `role: 'checkpoint'` records and gaps in its key indices; the log is written
//     contiguous, and `compactionBoundaryIdx` is moved down by however many keys below it
//     produced no message — the same arithmetic `_readThread` performs, because a log with
//     a hole in it would read back as a corrupt thread.
//   - The message JSON is copied verbatim, not parsed and re-serialized. Only the role is
//     read (to find checkpoints) and only the first user message is parsed (for the tab
//     label), so a 456 MB profile is not a 456 MB parse.

import * as path from 'path';
import { promises as fs } from 'fs';

import { CHECKPOINT_KEY_PREFIX, MESSAGE_KEY_PREFIX, THREAD_KEY_PREFIX } from '../common/storageKeys.js';
import { MESSAGE_LOG_FILE_NAME, THREAD_STORE_FORMAT_LOG } from '../common/threadLog.js';
import { IStorageMirrorPolicy } from '../../../../platform/storage/electron-main/storageIpc.js';
export type ThreadLogMigrationResult = {
	/** Threads whose log was written and whose metadata now points at it. */
	converted: number
	/** Threads that could not be converted; they stay key-backed and readable. */
	failed: number
	/** True when no thread in this storage is key-backed any more. */
	allThreadsAreLogs: boolean
}

type MessageEntry = { i: number; raw: string }

/**
 * Writes a log file for every key-backed thread in `items`, and flips its
 * `storeFormatVersion` through `write` (the storage service's own setter, so the change is
 * persisted and observable like any other).
 *
 * Runs on every launch and is a no-op once every thread is converted: the scan is a walk
 * of the item map, which the storage service has already loaded.
 */
export async function migrateThreadsToLogs(
	globalStorageHome: string,
	items: Map<string, string>,
	write: (key: string, value: string) => void,
	remove: (key: string) => void,
): Promise<ThreadLogMigrationResult> {
	const messagesOfThread = collectMessages(items)
	const threadsRoot = path.join(globalStorageHome, 'void', 'threads')
	const metadataKeys = Array.from(items.keys()).filter(key => key.startsWith(THREAD_KEY_PREFIX))

	let converted = 0
	let failed = 0
	let keyBacked = 0

	for (const metadataKey of metadataKeys) {
		const threadId = metadataKey.slice(THREAD_KEY_PREFIX.length)
		if (threadId === '') continue

		let metadata: Record<string, unknown>
		try { metadata = JSON.parse(items.get(metadataKey)!) }
		catch { failed++; keyBacked++; continue }
		if (!metadata || typeof metadata !== 'object') { failed++; keyBacked++; continue }
		if (metadata.storeFormatVersion === THREAD_STORE_FORMAT_LOG) continue

		keyBacked++
		try {
			await convertThread(threadId, metadata, messagesOfThread.get(threadId) ?? [], threadsRoot)
			write(metadataKey, JSON.stringify(metadata))
			// The separate checkpoint key range a pre-removal build wrote. The log is now
			// the record of what those keys repeated.
			for (const key of items.keys()) {
				if (key.startsWith(CHECKPOINT_KEY_PREFIX + threadId + '.')) remove(key)
			}
			converted++
		}
		catch (error) {
			console.error(`[thread-log] migration: could not convert ${threadId}:`, error)
			failed++
		}
	}

	return { converted, failed, allThreadsAreLogs: keyBacked === converted }
}

/** Groups `void.chatMsg.<threadId>.<index>` values by thread, in one walk of the items. */
function collectMessages(items: Map<string, string>): Map<string, MessageEntry[]> {
	const messagesOfThread = new Map<string, MessageEntry[]>()
	for (const [key, raw] of items) {
		if (!key.startsWith(MESSAGE_KEY_PREFIX)) continue
		const rest = key.slice(MESSAGE_KEY_PREFIX.length)
		const dot = rest.lastIndexOf('.')
		if (dot <= 0) continue
		const index = Number(rest.slice(dot + 1))
		if (!Number.isInteger(index) || index < 0) continue
		const threadId = rest.slice(0, dot)
		const existing = messagesOfThread.get(threadId)
		if (existing) existing.push({ i: index, raw })
		else messagesOfThread.set(threadId, [{ i: index, raw }])
	}
	return messagesOfThread
}

/**
 * Writes one thread's log and updates `metadata` in place. Throws if the file cannot be
 * written; the caller then leaves the thread key-backed.
 */
async function convertThread(
	threadId: string,
	metadata: Record<string, unknown>,
	entries: MessageEntry[],
	threadsRoot: string,
): Promise<void> {
	entries.sort((a, b) => a.i - b.i)
	const lastIdx = entries.length > 0 ? entries[entries.length - 1].i : -1
	const boundary = typeof metadata.compactionBoundaryIdx === 'number' ? metadata.compactionBoundaryIdx : undefined

	const present = new Set<number>()
	const lines: string[] = []
	let writeIdx = 0
	let dropped = 0
	let title: string | undefined

	for (const entry of entries) {
		present.add(entry.i)
		const role = roleOf(entry.raw)

		if (role === 'checkpoint') {
			// The feature is gone; the record only exists in threads written before it was
			// removed, and the load path has been dropping these on read ever since.
			if (boundary !== undefined && entry.i < boundary) dropped++
			continue
		}

		if (title === undefined && role === 'user') {
			title = displayContentOf(entry.raw)
		}

		// The index in the log is the position after compaction, not the old key index:
		// a log with a hole in it is the renumbering bug this format removes.
		lines.push(`{"i":${writeIdx},"m":${entry.raw}}\n`)
		writeIdx++
	}

	if (boundary !== undefined) {
		// A gap at or past the last real key shifted nothing, so only interior ones count —
		// the same rule `_readThread` applies before it remaps the anchor.
		const limit = Math.min(boundary, lastIdx)
		for (let i = 0; i < limit; i++) if (!present.has(i)) dropped++
		if (dropped > 0) metadata.compactionBoundaryIdx = boundary - dropped
	}

	if (lines.length > 0) {
		const threadDir = path.join(threadsRoot, threadId)
		const file = path.join(threadDir, MESSAGE_LOG_FILE_NAME)
		await fs.mkdir(threadDir, { recursive: true })
		await removeAbandonedTemporaries(threadDir)
		// Temporary and rename, so an interrupted conversion cannot leave a half-written
		// log that the next launch would then read as short.
		const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
		try {
			await fs.writeFile(temporary, lines.join(''), 'utf8')
			await fs.rename(temporary, file)
		}
		catch (error) {
			await fs.unlink(temporary).catch(() => undefined)
			throw error
		}
		// Read back and count before claiming the thread is converted. A short log is
		// indistinguishable from a shorter conversation when it is read, so the one moment
		// where the mistake can be caught is here, while the keys are still authoritative.
		const written = await fs.readFile(file, 'utf8')
		const records = written.length === 0 ? 0 : written.split('\n').length - 1
		if (records !== lines.length) {
			throw new Error(`log verification failed for ${threadId}: ${records} records written, ${lines.length} expected`)
		}
	}

	// Written last: before this line the thread is still key-backed, so an interrupted
	// conversion is retried rather than trusted.
	metadata.storeFormatVersion = THREAD_STORE_FORMAT_LOG
	if (title !== undefined) metadata.title = title

	// The dead fields the renderer's residue sweep used to strip when it opened a
	// thread: a Set that serialized as `{}` and was never read, the removed checkpoint
	// feature's cursor, and live mount wiring that is a Promise and a ref. This pass
	// already rewrites the row, and a converted thread is never visited by the sweep.
	delete metadata.filesWithUserChanges
	delete metadata.checkpoints
	const state = metadata.state
	if (state && typeof state === 'object') {
		delete (state as Record<string, unknown>).currCheckpointIdx
		delete (state as Record<string, unknown>).mountedInfo
	}
}

/** A conversion that was interrupted before its rename leaves a temporary behind. */
async function removeAbandonedTemporaries(threadDir: string): Promise<void> {
	let names: string[]
	try { names = await fs.readdir(threadDir) }
	catch { return }
	for (const name of names) {
		if (name.startsWith(MESSAGE_LOG_FILE_NAME + '.') && name.endsWith('.tmp')) {
			await fs.unlink(path.join(threadDir, name)).catch(() => undefined)
		}
	}
}

/**
 * The role of a stored message, without parsing it when the stored order allows.
 * Every message this codebase writes starts with `role`, and a checkpoint record is the
 * one role the log must not carry.
 */
function roleOf(raw: string): string | undefined {
	const match = /^\{"role":"([a-z_]+)"/.exec(raw)
	if (match) return match[1]
	try {
		const parsed = JSON.parse(raw) as { role?: unknown }
		return typeof parsed.role === 'string' ? parsed.role : undefined
	}
	catch { return undefined }
}

function displayContentOf(raw: string): string | undefined {
	try {
		const parsed = JSON.parse(raw) as { displayContent?: unknown }
		return typeof parsed.displayContent === 'string' && parsed.displayContent !== '' ? parsed.displayContent : undefined
	}
	catch { return undefined }
}

/**
 * Runs the conversion before a storage's mirror is built, and then asks the channel to
 * leave the message keys out of it.
 *
 * The keys stay in the database on purpose: a user who downgrades still reads them, and a
 * log that turns out to be wrong is recoverable from them. They are only dropped from the
 * *mirror*, which is what makes them free — the mirror is rebuilt from the database on
 * every launch, so a key left in it costs the same every time.
 *
 * Per storage path, and once: after the first `getItems` this is a map lookup. When any
 * thread could not be converted, nothing is hidden — a key-backed thread whose keys were
 * withheld from the mirror would open empty, which is worse than a slow launch.
 */
export class ThreadLogMirrorPolicy implements IStorageMirrorPolicy {

	private readonly _hiddenOfStoragePath = new Map<string, readonly string[]>()
	private readonly _preparingOfStoragePath = new Map<string, Promise<readonly string[]>>()

	async prepare(items: Map<string, string>, write: (key: string, value: string) => void, remove: (key: string) => void, storagePath: string | undefined): Promise<readonly string[]> {
		if (!storagePath) return []
		const prepared = this._hiddenOfStoragePath.get(storagePath)
		if (prepared) return prepared

		// A second window asking for its mirror while the first is still converting would
		// otherwise run the conversion twice over the same items.
		const inFlight = this._preparingOfStoragePath.get(storagePath)
		if (inFlight) return inFlight

		const run = this._prepare(storagePath, items, write, remove)
		this._preparingOfStoragePath.set(storagePath, run)
		try { return await run }
		finally { this._preparingOfStoragePath.delete(storagePath) }
	}

	private async _prepare(storagePath: string, items: Map<string, string>, write: (key: string, value: string) => void, remove: (key: string) => void): Promise<readonly string[]> {
		let result: ThreadLogMigrationResult
		try {
			result = await migrateThreadsToLogs(path.dirname(storagePath), items, write, remove)
		}
		catch (error) {
			// Fail open. This runs inside the call that builds the renderer's storage, so an
			// unexpected throw here would reject `getItems` and take the window down with it.
			// A complete mirror is slow, not broken.
			console.error('[thread-log] migration failed; keeping the full mirror:', error)
			this._hiddenOfStoragePath.set(storagePath, [])
			return []
		}

		const hidden = result.allThreadsAreLogs ? [MESSAGE_KEY_PREFIX] : []
		this._hiddenOfStoragePath.set(storagePath, hidden)

		if (result.converted > 0 || result.failed > 0) {
			console.log(`[thread-log] migration: ${result.converted} converted, ${result.failed} failed, hidden=${hidden.length > 0}`)
		}
		return hidden
	}
}
