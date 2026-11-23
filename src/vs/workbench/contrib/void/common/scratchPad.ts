/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The scratchpad: where the agent puts files that exist only to check something —
// a probe script, a throwaway test, generated output — so they never become a
// project change the user has to accept.
//
// The location is fixed and relative to the workspace root, which is what lets
// `run_command` use a relative path without the model ever knowing the absolute
// one: a temporary terminal starts in the first workspace folder, so
// `node .void/tmp/<thread>/probe.js` resolves as written. The absolute path is
// still returned from a write for the cases where the cwd moved.
//
// This module is pure: it decides paths and validates names, and nothing else.

import { URI } from '../../../../base/common/uri.js'

/** Directory, relative to the workspace root, that holds every thread's scratch. */
export const SCRATCH_ROOT_SEGMENTS = ['.void', 'tmp'] as const

/**
 * A single scratch file is capped so one runaway capture cannot fill the disk
 * through the model's own output; the thread total is capped because scratch
 * persists for the life of the conversation rather than being cleared per run.
 */
export const MAX_SCRATCH_FILE_BYTES = 1024 * 1024
export const MAX_SCRATCH_THREAD_BYTES = 50 * 1024 * 1024

/** Root of one thread's scratchpad: `<workspace>/.void/tmp/<threadId>`. */
export const scratchRootUri = (workspaceFolderUri: URI, threadId: string): URI =>
	URI.joinPath(workspaceFolderUri, ...SCRATCH_ROOT_SEGMENTS, threadId)

/**
 * Normalises a scratch file name into a relative path, or throws with a message
 * the model can act on.
 *
 * The name is the only thing the caller provides, so it is also the only place a
 * scratch write could escape the scratchpad. Absolute paths, drive letters, `.`
 * and `..` segments, and empty segments are rejected rather than clipped: a
 * silently rewritten path would put the file somewhere the model does not expect
 * and would make `delete_scratch` disagree with it about the target.
 */
export const normalizeScratchPath = (raw: unknown): string => {
	if (typeof raw !== 'string') throw new Error(`Invalid scratch path: expected a string, got ${typeof raw}.`)
	const name = raw.trim()
	if (!name) throw new Error('Invalid scratch path: the path must not be empty.')
	if (name.startsWith('/') || name.startsWith('\\')) throw new Error(`Invalid scratch path "${raw}": use a path relative to the scratchpad, not an absolute one.`)
	if (/^[a-zA-Z]:[\\/]/.test(name)) throw new Error(`Invalid scratch path "${raw}": use a path relative to the scratchpad, not a drive path.`)
	if (/[\\/]$/.test(name)) throw new Error(`Invalid scratch path "${raw}": the path must name a file, not end with a separator.`)

	const segments = name.split(/[\\/]+/)
	for (const segment of segments) {
		if (segment === '') throw new Error(`Invalid scratch path "${raw}": empty path segment.`)
		if (segment === '.' || segment === '..') throw new Error(`Invalid scratch path "${raw}": "." and ".." are not allowed.`)
		if (segment.includes(':')) throw new Error(`Invalid scratch path "${raw}": ":" is not allowed in a scratch file name.`)
		if (/[\u0000-\u001f]/.test(segment)) throw new Error(`Invalid scratch path "${raw}": control characters are not allowed.`)
	}
	return segments.join('/')
}

/** The absolute URI of one scratch file inside a thread's scratchpad. */
export const scratchEntryUri = (rootUri: URI, normalizedPath: string): URI =>
	URI.joinPath(rootUri, ...normalizedPath.split('/'))
