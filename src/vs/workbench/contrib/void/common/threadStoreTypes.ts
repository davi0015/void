/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The contract between the renderer and the main-process thread store.
//
// A thread's messages live in a file, and file I/O belongs to the main process, so the
// renderer talks to a channel instead of to the filesystem. Two things are deliberately
// not in this contract: a file path and a byte offset. A caller addresses a thread and
// gets messages back; where the log lives, how a torn final line is repaired, and how a
// rewrite is made atomic stay in the channel. See `common/threadLog.ts` for the format
// itself, and `docs/designs/thread-storage.md` for why the bodies move at all.
//
// Every operation on one thread is serialised inside the channel, so an append cannot
// interleave with a conversion or a truncation of the same file.

import { ChatMessage } from './chatThreadServiceTypes.js';
import { LogRecord } from './threadLog.js';

/** The IPC channel name, registered in `app.ts`. */
export const THREAD_STORE_CHANNEL_NAME = 'void-channel-threadStore'

export type ThreadStoreRecord = LogRecord<ChatMessage>

export type ThreadStoreAppendParams = {
	threadId: string
	/** Appended in order. An index may repeat an earlier record; the later one wins. */
	records: ThreadStoreRecord[]
}

export type ThreadStoreAppendResult = { records: number }

export type ThreadStoreReadParams = { threadId: string }

export type ThreadStoreReadResult = {
	/** False when the thread has no log. A new thread has none until its first append. */
	exists: boolean
	messages: ChatMessage[]
	/** The index of each entry in `messages`. A gap here means the log is corrupt. */
	indices: number[]
	/** Records dropped because a later record had the same index. */
	duplicateCount: number
	/** Indices missing below the highest one present. Empty for a healthy log. */
	gapIndices: number[]
	malformedLines: number
	tornTail: boolean
}

export type ThreadStoreWriteParams = {
	threadId: string
	/** The thread's messages, in order; replaces whatever the file held. */
	messages: ChatMessage[]
}

export type ThreadStoreWriteResult = { records: number }

export type ThreadStoreTruncateParams = {
	threadId: string
	/** Every index from here up is dropped. */
	boundary: number
}

export type ThreadStoreTruncateResult = { records: number }

export type ThreadStoreDeleteParams = { threadId: string }
