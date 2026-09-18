/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { CodespanLinkMap, isResolvedCodespanLink, lookupCodespanLink, pruneCodespanLinks } from '../codespanLinkCache.js';

// The codespan link cache behind the clickable `like this` spans in a chat reply.
//
// The first group pins the rule that a *failed* resolution must not be mistaken for
// a cached one: that is what left links permanently dead. The second group pins the
// prune, whose one dangerous input is "the message count is not known" — a
// metadata-only read reports zero messages for a thread that has thousands, and
// treating that as a real count would delete the whole cache.

const link = (path: string) => ({ uri: URI.file(path), displayText: path });

suite('CodespanLinkCache', () => {

	// ── a failed resolution is not a cache hit ──────────────────────────────

	test('a stored null is a miss, so the span gets resolved again', () => {
		// null is what a resolution that found nothing was persisted as.
		const links: CodespanLinkMap = { 3: { 'someUnknownThing': null } };

		assert.strictEqual(
			lookupCodespanLink(links, 3, 'someUnknownThing'),
			undefined,
			'a stored null must read as "not cached", or the span never retries',
		);
	});

	test('a resolved link is returned', () => {
		const target = link('/repo/src/a.ts');
		const links: CodespanLinkMap = { 3: { 'a.ts': target } };

		assert.strictEqual(lookupCodespanLink(links, 3, 'a.ts'), target);
	});

	test('an absent span, message or whole map is a miss', () => {
		const links: CodespanLinkMap = { 3: { 'a.ts': link('/repo/src/a.ts') } };

		assert.strictEqual(lookupCodespanLink(links, 3, 'b.ts'), undefined, 'span never seen');
		assert.strictEqual(lookupCodespanLink(links, 4, 'a.ts'), undefined, 'message never seen');
		assert.strictEqual(lookupCodespanLink(undefined, 3, 'a.ts'), undefined, 'thread has no cache');
	});

	test('null and undefined are not resolved links', () => {
		assert.strictEqual(isResolvedCodespanLink(null), false);
		assert.strictEqual(isResolvedCodespanLink(undefined), false);
		assert.strictEqual(isResolvedCodespanLink(link('/repo/src/a.ts')), true);
	});

	// ── pruning unusable entries ────────────────────────────────────────────

	test('unresolved entries are dropped', () => {
		const links: CodespanLinkMap = {
			0: { 'a.ts': link('/repo/src/a.ts'), 'nope': null },
			1: { 'gone': null },
		};

		const { links: kept, removedUnresolved, removedOutOfRange } = pruneCodespanLinks(links, 2);

		assert.deepStrictEqual(kept, { 0: { 'a.ts': link('/repo/src/a.ts') } });
		assert.strictEqual(removedUnresolved, 2);
		assert.strictEqual(removedOutOfRange, 0);
	});

	test('entries past the last message are dropped', () => {
		// Editing a message deletes it and everything after it, but leaves the
		// links that were cached for those indices.
		const links: CodespanLinkMap = {
			0: { 'a.ts': link('/repo/src/a.ts') },
			5: { 'b.ts': link('/repo/src/b.ts') },
			9: { 'c.ts': link('/repo/src/c.ts') },
		};

		const { links: kept, removedUnresolved, removedOutOfRange } = pruneCodespanLinks(links, 2);

		assert.deepStrictEqual(kept, { 0: { 'a.ts': link('/repo/src/a.ts') } });
		assert.strictEqual(removedOutOfRange, 2, 'indices 5 and 9 have no message');
		assert.strictEqual(removedUnresolved, 0);
	});

	test('the last message keeps its links', () => {
		// The range check is `>= messageCount`, and these indices are one-based in
		// spirit: index 2 is the third message. An off-by-one here would silently
		// drop the newest message's links on every write.
		const links: CodespanLinkMap = { 2: { 'c.ts': link('/repo/src/c.ts') } };

		const { links: kept, removedOutOfRange } = pruneCodespanLinks(links, 3);

		assert.deepStrictEqual(kept, { 2: { 'c.ts': link('/repo/src/c.ts') } });
		assert.strictEqual(removedOutOfRange, 0);
	});

	test('an unknown message count leaves every index alone', () => {
		// A metadata-only read loads no messages, so the count is unknown and must
		// be passed as undefined. If a caller passed the empty message array's
		// length instead, this same map would be wiped.
		const links: CodespanLinkMap = {
			0: { 'a.ts': link('/repo/src/a.ts') },
			5000: { 'b.ts': link('/repo/src/b.ts') },
		};

		const { links: kept, removedOutOfRange } = pruneCodespanLinks(links, undefined);

		assert.deepStrictEqual(kept, links, 'no range check without a count');
		assert.strictEqual(removedOutOfRange, 0);
	});

	test('a count of zero means every index is out of range', () => {
		// The other side of the guard above: a genuinely empty thread has no
		// message for any entry. Kept as an explicit case because it is exactly
		// what the unloaded-thread mistake looks like.
		const links: CodespanLinkMap = { 0: { 'a.ts': link('/repo/src/a.ts') } };

		const { links: kept, removedOutOfRange } = pruneCodespanLinks(links, 0);

		assert.deepStrictEqual(kept, {});
		assert.strictEqual(removedOutOfRange, 1);
	});

	test('an entry that is both unresolved and out of range is counted once', () => {
		const links: CodespanLinkMap = { 7: { 'nope': null } };

		const { links: kept, removedUnresolved, removedOutOfRange } = pruneCodespanLinks(links, 2);

		assert.deepStrictEqual(kept, {});
		assert.strictEqual(removedUnresolved + removedOutOfRange, 1, 'an entry is removed once');
	});

	test('a message left with no links is dropped entirely', () => {
		const links: CodespanLinkMap = { 0: { 'nope': null } };

		const { links: kept } = pruneCodespanLinks(links, 1);

		assert.deepStrictEqual(Object.keys(kept), [], 'no empty per-message objects survive');
	});

	test('an empty or absent cache prunes to an empty map', () => {
		assert.deepStrictEqual(pruneCodespanLinks({}, 5).links, {});
		assert.deepStrictEqual(pruneCodespanLinks(undefined, 5).links, {});
	});

	test('the input cache is not modified', () => {
		// The argument is live thread state; only the returned copy is written.
		const links: CodespanLinkMap = { 0: { 'a.ts': link('/repo/src/a.ts'), 'nope': null }, 9: { 'b.ts': link('/repo/src/b.ts') } };
		const before = JSON.stringify(links, (_k, v) => (v === undefined ? null : v));

		pruneCodespanLinks(links, 1);

		assert.strictEqual(JSON.stringify(links, (_k, v) => (v === undefined ? null : v)), before);
	});
});
