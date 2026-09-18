/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The codespan link cache: which `like this` spans in a chat message point at a file
// or symbol, and where.
//
// Resolution is expensive — it walks every file the conversation has touched, asks
// each definition provider, and can fall back to a codebase search — so results are
// cached per (thread, message, span text) in `state.linksOfMessageIdx`. The cache is
// only ever a speed-up: every entry can be rebuilt, and losing one costs a lookup.
//
// Two properties of the cache are decided here. Both were wrong, and both were wrong
// silently:
//
//   * A resolution that found nothing is NOT a cache hit. It was stored as `null` and
//     read back as a hit, so a span that failed to resolve once — language server not
//     warmed up, index not ready, file not yet seen in the conversation — stayed dead
//     for the life of the thread, long after the cause had gone. Real databases held
//     43,691 such permanent nulls, 64% of all entries.
//   * A negative result must never be persisted at all. Dropping it is what lets a
//     legacy `null` heal on the next render, and it keeps the thread blob from
//     accumulating an entry per mention of every ordinary word in a reply. Callers
//     that want to avoid repeating a hopeless lookup keep that in memory instead,
//     where it dies with the session.
//
// Pruning is the other half: entries are keyed by message index, so editing a message
// orphans every entry at or after it. Together, unresolved and orphaned entries were
// 85% of the cache in a real profile — 4.6 MB of a 6.5 MB blob.
//
// Deliberately free of services and storage so the policy can be pinned by fast unit
// tests rather than by reading the service that hosts it.

import type { CodespanLocationLink } from './chatThreadServiceTypes.js';

/** Resolved links for one message, keyed by the codespan text exactly as written. */
export type CodespanLinksOfMessage = { [codespanName: string]: CodespanLocationLink }

/** The cache for a whole thread, keyed by message index. */
export type CodespanLinkMap = { [messageIdx: number]: CodespanLinksOfMessage }

/** A link that actually resolved. `CodespanLocationLink` also admits `null`. */
export type ResolvedCodespanLink = NonNullable<CodespanLocationLink>

/**
 * The cached link for a span, or `undefined` when there is nothing usable.
 *
 * A stored `null` is "nothing usable", not a hit: returning it is what made a
 * failed resolution permanent, because the caller treats any defined value as
 * cached and skips the retry.
 */
export function lookupCodespanLink(links: CodespanLinkMap | undefined, messageIdx: number, codespanStr: string): ResolvedCodespanLink | undefined {
	const link = links?.[messageIdx]?.[codespanStr]
	return isResolvedCodespanLink(link) ? link : undefined
}

/** Whether a resolution produced something worth keeping. */
export function isResolvedCodespanLink(link: CodespanLocationLink | undefined): link is ResolvedCodespanLink {
	// `!== null && !== undefined`, not `!link`: the type admits null, and a truthiness
	// test would also reject a future link shape that happened to be falsy.
	return link !== null && link !== undefined
}

export type CodespanPruneResult = {
	links: CodespanLinkMap
	/** Entries dropped because the resolution had not succeeded. */
	removedUnresolved: number
	/** Entries dropped because their message index no longer exists. */
	removedOutOfRange: number
}

/**
 * Drop entries that can never be used again.
 *
 * `messageCount` is the number of messages the thread has, or `undefined` when that
 * is not known — a metadata-only read, for instance, where the messages have not
 * been loaded and the count would come out as `0`. **Passing `undefined` disables
 * the range check entirely**; it does not stand for "no messages". Passing a real
 * `0` does mean that, and drops every entry.
 *
 * The input is not modified: it is usually live in-memory thread state, and the
 * pruned copy is only what gets written.
 */
export function pruneCodespanLinks(links: CodespanLinkMap | undefined, messageCount: number | undefined): CodespanPruneResult {
	const kept: CodespanLinkMap = {}
	let removedUnresolved = 0
	let removedOutOfRange = 0

	for (const [idxStr, ofMessage] of Object.entries(links ?? {})) {
		const idx = Number(idxStr)
		let keptOfMessage: CodespanLinksOfMessage | undefined

		for (const [codespanStr, link] of Object.entries(ofMessage ?? {})) {
			// Unresolved is tested first, so an entry that is both unresolved and
			// out of range is counted once. The split is diagnostic only — either
			// way the entry is gone.
			if (!isResolvedCodespanLink(link)) { removedUnresolved++; continue }
			if (messageCount !== undefined && idx >= messageCount) { removedOutOfRange++; continue }
			;(keptOfMessage ??= {})[codespanStr] = link
		}

		if (keptOfMessage) kept[idx] = keptOfMessage
	}

	return { links: kept, removedUnresolved, removedOutOfRange }
}
