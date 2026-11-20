/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The filesystem half of the thread message log, in the main process.
//
// `common/threadLog.ts` owns the bytes; this owns the file. Three things belong here
// rather than there, because they are about a filesystem and not about the data:
//
//   - Every operation on one thread is serialised. A conversion and an append to the same
//     file must not interleave, and a read must not land in the middle of an append. The
//     queue is keyed by thread, so one slow thread does not hold another.
//   - A torn final line is repaired *before* an append. Appending to a file whose last
//     line is a partial record would glue the new record onto the fragment and lose both;
//     the repair cuts back to the last terminator, or adds the missing newline when the
//     record itself was written in full.
//   - A rewrite goes through a temporary file and a rename. A truncation or a conversion
//     that dies mid-write must leave the previous log intact, and a rename within one
//     directory is atomic.
//
// Durability is the same promise the rest of the store makes: an append that resolved has
// reached the operating system, which survives the process but not a power cut. This is
// deliberately not weaker than the mirrored keys it replaces — those are debounced for
// about 100 ms before they reach SQLite — and it is not stronger, so nothing may treat a
// resolved append as proof that the bytes are on the platter.

import * as path from 'path';
import { promises as fs } from 'fs';

import { Event } from '../../../../base/common/event.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';

import { threadStoreDir } from '../common/threadImagePaths.js';
import { encodeRecord, decodeLog, threadMessageLogFile, truncateFrom } from '../common/threadLog.js';
import {
	ThreadStoreAppendParams, ThreadStoreAppendResult, ThreadStoreDeleteParams,
	ThreadStoreReadParams, ThreadStoreReadResult, ThreadStoreTruncateParams, ThreadStoreTruncateResult,
	ThreadStoreWriteParams, ThreadStoreWriteResult,
} from '../common/threadStoreTypes.js';

export class ThreadStoreChannel implements IServerChannel {

	/** One promise chain per thread, so two operations on one file cannot overlap. */
	private readonly _queue = new Map<string, Promise<unknown>>()

	constructor(
		private readonly _globalStorageHome: URI,
	) { }

	/** The store publishes no events. Nothing subscribes, and a dead emitter would lie. */
	listen(): Event<any> {
		throw new Error('Void thread store: this channel has no events')
	}

	async call(_ctx: unknown, command: string, params: any): Promise<any> {
		switch (command) {
			case 'append': return this._append(params as ThreadStoreAppendParams)
			case 'readAll': return this._readAll(params as ThreadStoreReadParams)
			case 'writeAll': return this._writeAll(params as ThreadStoreWriteParams)
			case 'truncateFrom': return this._truncateFrom(params as ThreadStoreTruncateParams)
			case 'deleteThread': return this._deleteThread(params as ThreadStoreDeleteParams)
			default: throw new Error(`Void thread store: command "${command}" not recognized.`)
		}
	}

	private _append({ threadId, records }: ThreadStoreAppendParams): Promise<ThreadStoreAppendResult> {
		return this._perThread(threadId, async () => {
			if (!Array.isArray(records)) throw new Error('Void thread store: append needs an array of records')
			const file = await this._prepare(threadId)
			await fs.appendFile(file, records.map(encodeRecord).join(''), 'utf8')
			return { records: records.length }
		})
	}

	private _readAll({ threadId }: ThreadStoreReadParams): Promise<ThreadStoreReadResult> {
		return this._perThread(threadId, async () => {
			const text = await readTextIfPresent(this._logFile(validatedId(threadId)))
			// Returned as text, not as messages: a message's URIs only become `URI`
			// instances where a reviver runs, and that has to be the renderer — IPC strips
			// the prototype again on the way over.
			return { exists: text !== undefined, text: text ?? '' } satisfies ThreadStoreReadResult
		})
	}

	private _writeAll({ threadId, messages }: ThreadStoreWriteParams): Promise<ThreadStoreWriteResult> {
		return this._perThread(threadId, async () => {
			if (!Array.isArray(messages)) throw new Error('Void thread store: writeAll needs an array of messages')
			const file = this._logFile(validatedId(threadId))
			await fs.mkdir(path.dirname(file), { recursive: true })
			await this._writeAtomic(file, messages.map((m, i) => encodeRecord({ i, m })).join(''))
			return { records: messages.length }
		})
	}

	private _truncateFrom({ threadId, boundary }: ThreadStoreTruncateParams): Promise<ThreadStoreTruncateResult> {
		return this._perThread(threadId, async () => {
			const file = this._logFile(validatedId(threadId))
			const text = await readTextIfPresent(file)
			if (text === undefined) return { records: 0 }
			const kept = truncateFrom(decodeLog<unknown>(text).records, boundary)
			await this._writeAtomic(file, kept.map(encodeRecord).join(''))
			return { records: kept.length }
		})
	}

	private _deleteThread({ threadId }: ThreadStoreDeleteParams): Promise<void> {
		return this._perThread(threadId, async () => {
			const file = this._logFile(validatedId(threadId))
			await fs.rm(file, { force: true })
			// Only when the log was the last thing in the directory: a thread's images are
			// deleted by the image code, which is the code that owns them.
			await fs.rmdir(path.dirname(file)).catch(() => undefined)
		})
	}

	/** The log file, and the directory it lives in made if this is the thread's first write. */
	private async _prepare(threadId: string): Promise<string> {
		const file = this._logFile(validatedId(threadId))
		await fs.mkdir(path.dirname(file), { recursive: true })
		await this._repairTail(file)
		return file
	}

	private _logFile(threadId: string): string {
		return threadMessageLogFile(joinPath(threadStoreDir(this._globalStorageHome), threadId)).fsPath
	}

	/**
	 * Makes the file end on a line boundary, changing as little as possible.
	 *
	 * Scans backwards rather than reading the file, which can be hundreds of megabytes:
	 * the tail after the last newline is the only region a partial write can occupy.
	 */
	private async _repairTail(file: string): Promise<void> {
		let size: number
		try { size = (await fs.stat(file)).size }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
			throw error
		}
		if (size === 0) return

		const CHUNK = 256 * 1024
		const handle = await fs.open(file, 'r')
		try {
			let end = size
			const scanned: Buffer[] = []
			while (end > 0) {
				const length = Math.min(CHUNK, end)
				const start = end - length
				const buffer = Buffer.alloc(length)
				const { bytesRead } = await handle.read(buffer, 0, length, start)
				const chunk = buffer.subarray(0, bytesRead)
				const newline = chunk.lastIndexOf(0x0A)
				if (newline >= 0) {
					// Decode only from the newline, so a chunk boundary cannot split a
					// multi-byte character inside the record being inspected.
					scanned.unshift(chunk.subarray(newline + 1))
					await this._settleTail(file, start + newline + 1, Buffer.concat(scanned).toString('utf8'))
					return
				}
				scanned.unshift(chunk)
				end = start
			}
			// No newline anywhere: the file holds one record, complete or not.
			await this._settleTail(file, 0, Buffer.concat(scanned).toString('utf8'))
		}
		finally { await handle.close() }
	}

	private async _settleTail(file: string, tailStart: number, tail: string): Promise<void> {
		if (tail.length === 0) return
		const decoded = decodeLog(tail)
		// A record written in full but without its terminator: keep the message and add
		// the newline, rather than cutting away content that is already there.
		if (decoded.records.length === 1 && decoded.malformedLines === 0) {
			await fs.appendFile(file, '\n', 'utf8')
			return
		}
		// A partial record: cut back to the terminator, so the next append starts on a
		// line boundary instead of gluing itself onto the fragment.
		await fs.truncate(file, tailStart)
	}

	private async _writeAtomic(file: string, text: string): Promise<void> {
		// The temporary file is in the same directory, so the rename stays within one
		// filesystem and is atomic.
		const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
		try {
			await fs.writeFile(temporary, text, 'utf8')
			await fs.rename(temporary, file)
		}
		catch (error) {
			await fs.unlink(temporary).catch(() => undefined)
			throw error
		}
	}

	/**
	 * Runs `operation` after every earlier operation on the same thread, whatever their
	 * outcome — a failed write must not block every later one. The chain removes itself
	 * from the map once it drains, so a long session does not accumulate one promise per
	 * thread.
	 */
	private _perThread<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this._queue.get(threadId) ?? Promise.resolve()
		const run = previous.catch(() => undefined).then(operation)
		const settled = run.then(() => undefined, () => undefined)
		this._queue.set(threadId, settled)
		void settled.then(() => {
			if (this._queue.get(threadId) === settled) this._queue.delete(threadId)
		})
		return run
	}
}

/**
 * A thread id is a path segment, and it arrives from the renderer. Reject anything that
 * could address a file outside the thread's own directory rather than trusting the
 * caller.
 */
function validatedId(threadId: unknown): string {
	if (typeof threadId !== 'string' || threadId.length === 0 || threadId === '.' || threadId === '..'
		|| threadId.includes('/') || threadId.includes('\\') || threadId.includes('\0')) {
		throw new Error(`Void thread store: invalid thread id ${JSON.stringify(threadId)}`)
	}
	return threadId
}

async function readTextIfPresent(file: string): Promise<string | undefined> {
	try { return await fs.readFile(file, 'utf8') }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}
