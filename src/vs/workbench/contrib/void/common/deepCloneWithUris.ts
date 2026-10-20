/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// `deepClone` for values that carry URIs.
//
// `base/common/objects.ts#deepClone` rebuilds every object as a bare one
// (`Array.isArray(obj) ? [] : {}`) and copies own enumerable properties only. That is
// correct for plain data and wrong for a URI: `scheme`, `authority`, `path`, `query`
// and `fragment` are own properties, but `fsPath` and `toJSON` are prototype getters,
// so the copy is a plain object with the components and none of the behaviour.
//
// Two consequences, and the second is the one that persists. The copy's `fsPath` is
// `undefined`, so anything rendering it (`getBasename(selection.uri.fsPath)`) throws;
// and `JSON.stringify` emits `$mid` for a real URI but nothing for the copy, while
// `ChatThreadService._storageReviver` revives only `$mid === 1` — so the copy is
// written to storage in a shape nothing ever revives again.
//
// Duplicating a thread is where that bites: `duplicateThread` and
// `copyThreadToCurrentWorkspace` both clone every message, and messages carry URIs in
// their selections *and* in tool-call params (`read_file`, `edit_file`, …), so a fix
// that only touched selections would miss half of them.
//
// URIs are immutable, so the clone shares them rather than copying. Callers only ever
// *replace* a URI (`selection.uri = dest` in `_copyOwnedImages`), never mutate one, and
// replacing a property of a fresh object cannot reach the source.

import { URI } from '../../../../base/common/uri.js';

/**
 * A deep clone that keeps URIs as URIs and everything else as `deepClone` leaves it.
 */
export function deepCloneWithUris<T>(value: T): T {
	return cloneValue(value) as T
}

function cloneValue(value: any): any {
	if (!value || typeof value !== 'object') return value
	// Shared, not copied: immutable, and recursing into one is exactly what
	// strips the getters.
	if (value instanceof URI) return value
	// Matches `deepClone`, which returns these as-is and would otherwise flatten
	// them to `{}`.
	if (value instanceof RegExp) return value
	if (Array.isArray(value)) return value.map(cloneValue)
	const result: any = {}
	// Own enumerable properties, the same surface `deepClone` copies.
	for (const key of Object.keys(value)) result[key] = cloneValue(value[key])
	return result
}
