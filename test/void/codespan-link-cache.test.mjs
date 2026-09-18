/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The codespan link cache — the clickable `like this` spans in a chat reply.
//
// Resolution results are cached per (thread, message, span) in
// `state.linksOfMessageIdx`, and that cache was wrong in three compounding ways:
//
//   * a resolution that found nothing was persisted as `null`;
//   * the read path returned that `null`, and the renderer treats any defined value
//     as a cached answer — so a span that failed once (language server still cold,
//     index not ready, file not yet mentioned in the conversation) stayed dead for
//     the life of the thread, long after the cause had gone;
//   * entries are keyed by message index, so editing a message orphaned every entry
//     at or after it, and nothing ever removed them.
//
// In a real profile that left 43,691 stored nulls and 14,004 orphaned entries: 85%
// of a 6.5 MB blob, 4.6 MB of it unreclaimable.
//
// The counter-intuitive part is that dropping failures *durably* is not the same as
// retrying them on every render. The lookup walks every file the conversation has
// touched, asks each definition provider, and can fall back to a codebase search, so
// repeating it for every ordinary word in a reply would be worse than the dead link.
// A failure is therefore held for the session — where the renderer sees `null` and
// stops asking — and dropped on write, so it cannot outlive the session. `undefined`
// is what means "not known, resolve it", and that distinction is the fix.
//
//   npm run test-void -- --only=codespan-link
//   VOID_EXPECT=lost npm run test-void -- --only=codespan-link

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

// StorageScope.APPLICATION / StorageTarget.USER, for seeding a raw legacy blob.
// Const enums, so they are inlined at the call sites in the service too.
const APP_SCOPE = -1
const USER_TARGET = 0
const threadKey = (id) => `void.chatThread.${id}`

// A link that resolved, in the shape the storage reviver rebuilds into a URI.
const LINK_A = { uri: { $mid: 1, scheme: 'file', path: '/repo/src/a.ts' }, displayText: 'a.ts' }
const LINK_B = { uri: { $mid: 1, scheme: 'file', path: '/repo/src/b.ts' }, displayText: 'b.ts' }

before(() => h.preflight())

/** Prints storage traces when a scenario fails, so CI logs are diagnosable. */
function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

describe('codespan link cache', () => {

	test('a failure stored by an older build is retried, not read back as an answer', async (t) => {
		await h.withScenario('codespan-link/legacy-null', async (s) => {
			const result = await s.page.evaluate((links) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const current = svc.state.allThreads[id]

				// Exactly what an older build left on disk: one span that resolved,
				// and one that did not, stored as `null` beside it. Written as a raw
				// blob on purpose — the current write path prunes failures, so going
				// through it could not reproduce the shape being migrated from.
				const metadata = { ...current, messages: undefined, state: { ...current.state, linksOfMessageIdx: { 0: links } } }
				svc._storageService.store(`void.chatThread.${id}`, JSON.stringify(metadata), -1, 0)

				// Guard: the legacy shape has to be on disk, or "it retries" would
				// hold for the uninteresting reason that nothing was there.
				const onDisk = svc._storageService.get(`void.chatThread.${id}`, -1) ?? ''

				// Load it the way a restart does.
				const asLoaded = svc._readThread(id, false)
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: asLoaded } })

				return {
					id,
					storedNullOnDisk: /"nope":\s*null/.test(onDisk),
					failedSpanRetried: svc.getCodespanLink({ codespanStr: 'nope', messageIdx: 0, threadId: id }) === undefined,
					resolvedSpanKept: svc.getCodespanLink({ codespanStr: 'a.ts', messageIdx: 0, threadId: id })?.displayText === 'a.ts',
				}
			}, { 'nope': null, 'a.ts': LINK_A })

			trace(t, s)
			assert.ok(result.storedNullOnDisk, 'fixture failed to store a null link — nothing was migrated')

			// Control: a link that resolved survives the load untouched. Without it,
			// "the null is gone" would also pass if the whole cache were dropped.
			assert.ok(result.resolvedSpanKept, 'the load dropped a link that had resolved')

			h.assertPersistence('a stored failure is retried', result.failedSpanRetried, { subject: true })
		})
	})

	test('a failed resolution is held for the session but never written to storage', async (t) => {
		await h.withScenario('codespan-link/not-persisted', async (s) => {
			await h.seedTestThread(s.page, 1)

			const built = await s.page.evaluate(async (link) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const messageIdx = 0
				svc._loadedMessageThreadIds.add(id)

				await svc.addCodespanLink({ newLinkText: 'nope', newLinkLocation: null, messageIdx, threadId: id })
				await svc.addCodespanLink({ newLinkText: 'a.ts', newLinkLocation: link, messageIdx, threadId: id })

				return {
					id,
					messageCount: svc.state.allThreads[id].messages.length,
					// The renderer gets `null` — a defined value — so it does not repeat
					// the lookup on every remount this session.
					heldForSession: svc.getCodespanLink({ codespanStr: 'nope', messageIdx, threadId: id }) === null,
				}
			}, LINK_A)

			assert.ok(built.messageCount > 0, 'fixture produced no messages — there is no message 0 to attach links to')

			// Control, holding in both directions: the renderer must get an *answer*
			// for a span that failed, whichever side of the fix it is on — `null` from
			// a stored failure, or `null` from this session's record of one. Only
			// `undefined` sends it back to resolve, and that is what made the lookup
			// run on every remount. If the fix replaced the durable cache with nothing
			// at all, this is what would catch it.
			h.assertPersistence('a failure is held for the session', built.heldForSession)

			await s.page.evaluate((id) => {
				const svc = globalThis.__voidChatThreadService
				svc._storeThreadDurably(id, svc.state.allThreads[id])
			}, built.id)

			await h.sleep(600) // the storage layer debounces ~100ms per hop
			const raw = s.readThread(built.id)
			trace(t, s)
			assert.ok(raw, 'no thread metadata reached the database at all')
			const persisted = JSON.parse(raw).state?.linksOfMessageIdx?.[0] ?? {}

			// Control: the link that resolved is still cached on disk, so a write path
			// that dropped the whole map would not read as success.
			assert.equal(persisted['a.ts']?.displayText, 'a.ts', `the resolved link was not persisted: keys = [${Object.keys(persisted).join(', ')}]`)

			h.assertAbsent('a failed resolution in persisted metadata', !('nope' in persisted), { subject: true })
		})
	})

	test('links orphaned by an edit are pruned once the messages are loaded', async (t) => {
		await h.withScenario('codespan-link/orphans', async (s) => {
			await h.seedTestThread(s.page, 1)

			const built = await s.page.evaluate((links) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const thread = svc.state.allThreads[id]
				svc._loadedMessageThreadIds.add(id)

				// Message 0 exists; index 9 is what an edited message leaves behind.
				const seeded = { ...thread, state: { ...thread.state, linksOfMessageIdx: { 0: links, 9: links } } }
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: seeded } })
				svc._storeThreadDurably(id, seeded)

				return { id, messageCount: thread.messages.length }
			}, { 'a.ts': LINK_A, 'b.ts': LINK_B })

			assert.ok(built.messageCount > 0, 'fixture produced no messages — every index would be out of range')

			await h.sleep(600)
			const parsed = JSON.parse(s.readThread(built.id) ?? '{}')
			const persisted = parsed.state?.linksOfMessageIdx ?? {}
			trace(t, s)

			// Control: the entry for a message that exists is still cached.
			assert.equal(persisted['0']?.['a.ts']?.displayText, 'a.ts', `the live entry was pruned too: indices = [${Object.keys(persisted).join(', ')}]`)

			h.assertAbsent('links at an index with no message', !('9' in persisted), { subject: true })
		})
	})

	// The guard for the test above, and the reason `messageCount` is `undefined`
	// rather than `0` when the messages are not in memory. A metadata-only write
	// happens for every thread at startup, where `messages` is an empty array; if
	// that length were used as the count, one write would delete the entire link
	// cache of every thread the user is not currently looking at.
	//
	// Not a subject assertion: it must hold before and after the fix.
	test('a write without the messages loaded keeps every index', async (t) => {
		await h.withScenario('codespan-link/unloaded', async (s) => {
			const built = await s.page.evaluate((links) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const thread = svc.state.allThreads[id]

				// The metadata-only shape: no messages in memory, thread not loaded.
				svc._loadedMessageThreadIds.delete(id)
				const seeded = { ...thread, messages: [], state: { ...thread.state, linksOfMessageIdx: { 0: links, 9: links } } }
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: seeded } })
				svc._storeThreadDurably(id, seeded)

				return { id, messagesLoaded: svc._loadedMessageThreadIds.has(id) }
			}, { 'a.ts': LINK_A, 'b.ts': LINK_B })

			assert.equal(built.messagesLoaded, false, 'fixture left the thread loaded — this scenario is about an unloaded one')

			await h.sleep(600)
			const persisted = JSON.parse(s.readThread(built.id) ?? '{}').state?.linksOfMessageIdx ?? {}
			trace(t, s)

			assert.ok('9' in persisted, `an unloaded write pruned by message index: indices = [${Object.keys(persisted).join(', ')}]`)
			assert.equal(persisted['0']?.['a.ts']?.displayText, 'a.ts', 'an unloaded write dropped a live entry')
		})
	})
})
