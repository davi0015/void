/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Where a thread's images live, and which images a thread is allowed to delete.
//
// Images used to be written to one flat `<userRoamingDataHome>/voidImages` folder
// shared by every thread. A message stores the image's URI, `copyThreadToCurrentWorkspace`
// deep-clones messages, so a duplicated thread stored the *same* URI as its source —
// two threads, one file — while `deleteThread` decided what to delete by scanning the
// messages of the thread being deleted. Deleting the original therefore deleted an
// image the duplicate was still rendering (bug 6), and the whole folder sat in the
// roaming profile, which is settings-sync territory and the wrong place for binaries
// (bug 8).
//
// Ownership is the fix, not a more careful scan: an image is written inside the thread
// that attached it, so a thread's images can be deleted with the thread and nothing
// else has to be consulted. That gives the rest of the code one rule:
//
//     no code path deletes a file it does not own.
//
// `isThreadImageUri` is how a caller asks. It is load-bearing because images written
// before this change are still in the old flat directory and are deliberately **not**
// migrated here: attributing one requires knowing whether any other thread references
// the same URI, which needs a view of every thread rather than of one (see
// `thread-storage.md` §1.5 step 4 — S10's pass). Until that runs, a thread in use since
// before the change holds messages pointing at both locations, and the only safe thing
// to do with the old ones is leave them alone. Leaked bytes are the failure mode to
// prefer here; a deleted image another thread still renders is not.

import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * The directory holding every thread's store, under the profile's global storage.
 * `globalStorageHome` is normalized to `file` because the profile's URI is not
 * guaranteed to carry that scheme, and every consumer here hands the result to
 * `IFileService` — the same conversion `Storage` performs on the same URI.
 */
export function threadStoreDir(globalStorageHome: URI): URI {
	return joinPath(globalStorageHome.with({ scheme: Schemas.file }), 'void', 'threads');
}

/** The directory holding one thread's images. */
export function threadImageDir(globalStorageHome: URI, threadId: string): URI {
	return joinPath(threadStoreDir(globalStorageHome), threadId, 'images');
}

/** A new image file inside a thread's own image directory. */
export function threadImageUri(globalStorageHome: URI, threadId: string, fileName: string): URI {
	return joinPath(threadImageDir(globalStorageHome, threadId), fileName);
}

/**
 * Whether `uri` is a file inside `threadId`'s own image directory. Everything else —
 * the legacy flat directory, another thread's images, a path merely *prefixed* with
 * this thread's directory name — is not this thread's to delete.
 */
export function isThreadImageUri(globalStorageHome: URI, threadId: string, uri: URI): boolean {
	if (uri.scheme !== Schemas.file) return false
	const dir = threadImageDir(globalStorageHome, threadId).path
	return uri.path.startsWith(dir + '/')
}
