/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A thread's messages as an append-only log, one JSON record per line.
//
// Every stored key is mirrored at startup — `Storage.init()` pulls the whole database
// over IPC with no filter — so a message costs the same whether its thread is open or
// not. On a profile with 126k message keys that is seconds of launch, and it is why
// message bodies move out of `void.chatMsg.*` into one file per thread. See
// `docs/designs/thread-storage.md` §1.5 (S10b).
//
// The file is `messages.jsonl`, LF-terminated UTF-8, one record per line:
//
//   {"i":0,"m":{"role":"user","content":"..."}}
//   {"i":1,"m":{"role":"assistant","displayContent":"..."}}
//
// Three properties, each of which a simpler layout would not have:
//
//   - Every write is an append. A new message, a tool placeholder filled in, an edit —
//     all appends, so no write reads or rewrites a neighbour.
//   - The index lives in the record. A reader takes position from `i`, not from line
//     order, so a deleted message cannot renumber the ones after it. That renumbering
//     is bug 3 in the design's ledger: it moved messages under `compactionBoundaryIdx`
//     and dropped one from the prompt with no error anywhere.
//   - Duplicate indices are normal. A parallel tool batch appends placeholders and then
//     supersedes them, so the last record for an index wins.
//
// Truncation therefore cannot be a `ftruncate`. A record for `i < K` may sit *after* the
// first record with `i >= K` — a batch appends 3, 4, 5 and then supersedes 3 — so
// cutting at that offset would silently revert a message below the cut. The rewrite
// takes the winning record for each `i < K` from anywhere in the file.
//
// A gap in the indices is *reported*, not repaired. Repacking around a gap is the
// renumbering this format exists to remove, so the load path has to decide, and it
// treats a gap as a corrupt log rather than silently shifting every later message.

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/** The file inside a thread's store directory that holds its messages. */
export const MESSAGE_LOG_FILE_NAME = 'messages.jsonl'

/** The thread-metadata field naming which store a thread's messages are in. */
export const STORE_FORMAT_VERSION_FIELD = 'storeFormatVersion'

/**
 * `storeFormatVersion` for a thread whose messages are a log file. A thread without the
 * field predates the format and keeps its messages in the mirrored `void.chatMsg.*` keys
 * until it is converted.
 */
export const THREAD_STORE_FORMAT_LOG = 2

/**
 * One line of the log: the message's index within the thread and the message itself,
 * stored verbatim. The record is deliberately not a richer type — the store has no
 * opinion about a message's shape, and keeping it that way is what lets this module be
 * tested without constructing a conversation.
 */
export type LogRecord<M> = {
	i: number
	m: M
}

/** The log file for a thread, inside that thread's store directory. */
export function threadMessageLogFile(threadDir: URI): URI {
	return joinPath(threadDir, MESSAGE_LOG_FILE_NAME)
}

/**
 * Serializes one record, terminator included.
 *
 * `JSON.stringify` escapes every newline inside the message, so the result is one line
 * by construction rather than after a second pass over the string. Invalid indices are
 * refused here, at the only place a record enters a file: an index that is not a
 * non-negative integer would either be dropped by the reader or collide with a real one.
 */
export function encodeRecord<M>(record: LogRecord<M>): string {
	if (!Number.isInteger(record.i) || record.i < 0) {
		throw new Error(`thread log record has an invalid index: ${String(record.i)}`)
	}
	if (record.m === undefined) {
		throw new Error('thread log record has no message')
	}
	return JSON.stringify({ i: record.i, m: record.m }) + '\n'
}

export type DecodedLog<M> = {
	/** Records in file order, malformed lines dropped. */
	records: LogRecord<M>[]
	malformedLines: number
	/** The file does not end in a newline and its last line does not parse. */
	tornTail: boolean
}

/**
 * Parses a whole log file. A malformed line is skipped and counted rather than
 * throwing: a log is user data, and one corrupt line must not cost the thread.
 *
 * `tornTail` distinguishes the one recoverable case — a write interrupted mid-record —
 * from corruption in the middle of the file, which is reported the same way but is not
 * expected. The writer repairs a torn tail by cutting back to the last newline before
 * appending, so a torn tail should only ever be seen on the first read after a crash.
 */
export function decodeLog<M>(text: string): DecodedLog<M> {
	const records: LogRecord<M>[] = []
	let malformedLines = 0
	let tornTail = false
	if (text.length === 0) return { records, malformedLines, tornTail }

	const lines = text.split('\n')
	const endsWithNewline = text.endsWith('\n')
	// A file ending in a newline splits into one empty trailing element, which is a
	// terminator rather than a record.
	const lineCount = endsWithNewline ? lines.length - 1 : lines.length

	for (let n = 0; n < lineCount; n++) {
		const line = lines[n]
		if (line.length === 0) continue
		const record = parseRecord<M>(line)
		if (!record) {
			malformedLines++
			// Only the last line of a file whose final append did not finish can be
			// partial: records are written one at a time, terminator included.
			if (n === lineCount - 1 && !endsWithNewline) tornTail = true
			continue
		}
		records.push(record)
	}
	return { records, malformedLines, tornTail }
}

function parseRecord<M>(line: string): LogRecord<M> | undefined {
	let parsed: unknown
	try { parsed = JSON.parse(line) }
	catch { return undefined }
	if (!parsed || typeof parsed !== 'object') return undefined

	const record = parsed as { i?: unknown; m?: unknown }
	if (typeof record.i !== 'number' || !Number.isInteger(record.i) || record.i < 0) return undefined
	if (!('m' in record)) return undefined
	return { i: record.i, m: record.m as M }
}

export type FoldedLog<M> = {
	/** The winning message for each index, in ascending index order. */
	messages: M[]
	/** The index of each entry in `messages`, so a gap is visible without repacking. */
	indices: number[]
	/** Records discarded because a later record had the same index. */
	duplicateCount: number
	/** Indices missing below the highest one present. Empty for a healthy log. */
	gapIndices: number[]
}

/**
 * Folds records by index, last record wins, and reports what the fold had to ignore.
 *
 * This is the read half of the format and the reason `i` is stored at all: the result
 * is a function of the records' contents, not of their positions, so nothing can be
 * renumbered by a missing line.
 */
export function foldRecords<M>(records: readonly LogRecord<M>[]): FoldedLog<M> {
	const winner = new Map<number, number>()
	for (let n = 0; n < records.length; n++) winner.set(records[n].i, n)

	const indices = Array.from(winner.keys()).sort((a, b) => a - b)
	const messages = indices.map(i => records[winner.get(i)!].m)

	const gapIndices: number[] = []
	let next = 0
	for (const i of indices) {
		for (; next < i; next++) gapIndices.push(next)
		next = i + 1
	}

	return { messages, indices, duplicateCount: records.length - indices.length, gapIndices }
}

/**
 * The records that survive a truncation at `boundary`: for every index below it, the
 * last record anywhere in the file, in ascending order.
 *
 * Reading the whole file rather than cutting at an offset is what makes a superseded
 * record below the cut reachable, and it is affordable because truncation follows a user
 * action on a thread that is already loaded.
 */
export function truncateFrom<M>(records: readonly LogRecord<M>[], boundary: number): LogRecord<M>[] {
	if (!(boundary > 0)) return []

	const winner = new Map<number, LogRecord<M>>()
	for (const record of records) {
		// Overwrite rather than skip: the last record for an index below the cut may
		// sit after records at or above it.
		if (record.i < boundary) winner.set(record.i, record)
	}

	return Array.from(winner.keys()).sort((a, b) => a - b).map(i => winner.get(i)!)
}

/** The log with one record per index: the winning prefix, duplicates gone. */
export function compactRecords<M>(records: readonly LogRecord<M>[]): LogRecord<M>[] {
	return truncateFrom(records, Number.POSITIVE_INFINITY)
}
