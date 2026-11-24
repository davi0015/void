/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Merging whole-blob writes.
//
// Three stores in this extension are one JSON blob each: the settings state, the
// per-workspace pinned-thread map, and the per-workspace "last active thread" map.
// Every write replaces the blob, so a writer that built its object from a copy it
// read earlier drops whatever someone else changed in between — including the parts
// it never touched. Two windows do this to each other constantly, and one window does
// it to itself because the main process echoes its own write back as an external
// change, which can be read and re-adopted mid-write.
//
// These helpers compute a three-way merge at write time instead. `base` is the state
// this writer last read or wrote, `ours` is the state it is about to write, and
// `persisted` is what storage holds now. A key whose `ours` value differs from `base`
// is a local change and wins — including a deletion, which is why a missing key is
// compared rather than skipped. A key that did not change locally keeps the persisted
// value, so another writer's change survives instead of being overwritten.
//
// Equality is by JSON, which is what these blobs are: no Dates, no Maps, no classes.

export function deepEquals(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Three-way merge of a keyed map: pinned thread ids per workspace, model selections
 * per feature, MCP state per server. A key is ours when it differs from `base`;
 * otherwise the persisted value is kept.
 */
export function mergeRecordWrites(
	persisted: Record<string, unknown>,
	base: Record<string, unknown>,
	ours: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...persisted }

	for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
		const oursHas = Object.prototype.hasOwnProperty.call(ours, key)
		const baseHas = Object.prototype.hasOwnProperty.call(base, key)
		const unchangedLocally = oursHas === baseHas && deepEquals(ours[key], base[key])
		if (unchangedLocally) continue // keep the persisted value

		if (oursHas) merged[key] = ours[key]
		else delete merged[key] // removed here, so it stays removed
	}

	return merged
}

/**
 * Three-way merge of the settings blob. A field that is a map is merged per key one
 * level in, so one provider's edited endpoint does not clobber another provider's
 * model list. Any other field is replaced only when this writer changed it.
 */
export function mergeSettingsWrites(
	persisted: Record<string, unknown>,
	base: Record<string, unknown>,
	ours: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...persisted }

	for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
		const oursValue = ours[key]
		if (isRecord(oursValue)) {
			const persistedValue = persisted[key]
			const baseValue = base[key]
			merged[key] = mergeRecordWrites(
				isRecord(persistedValue) ? persistedValue : {},
				isRecord(baseValue) ? baseValue : {},
				oursValue,
			)
			continue
		}

		if (!deepEquals(oursValue, base[key])) merged[key] = oursValue
	}

	return merged
}
