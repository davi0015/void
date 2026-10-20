/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Thread residency (S10a) — the measurement, before the change.
//
// `_loadedMessageThreadIds` (`chatThreadService.ts`) is a plain `Set`. 
// `_ensureMessagesLoaded` adds to it when a thread is opened and nothing removes an
// entry except `deleteThread` and `resetState`. So opening N threads leaves all N
// threads' messages in `state.allThreads[id].messages` for the life of the window,
// and renderer memory tracks how many threads have *ever* been opened rather than
// how many are open. One thread switch is enough to make a thread permanent.
//
// The design's gate — "renderer memory no longer scales with total message count" —
// is not assertable as written, so this file *is* the measurement: it counts the
// message objects the renderer still retains after N threads have been opened. Heap
// is printed as corroboration and deliberately not asserted on, because it moves
// with garbage-collection timing rather than with what is still reachable.
//
// What this file is not: a statement that N should be small. S10a bounds residency
// *across* threads (what stays resident when you are looking at one), not the size
// of one thread's context — a single large thread is compaction's problem, not
// eviction's.
//
//   npm run test-void -- --only=thread-residency
//   VOID_EXPECT=lost npm run test-void -- --only=thread-residency

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

const THREAD_COUNT = 6
const MESSAGES_PER_THREAD = 40

// Distinct from any id the app generates, and stable across runs so a failure can
// be traced back to this fixture.
const threadIdOf = (n) => `5eeded10-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`

const message = (i) => i % 2 === 0
	? { role: 'user', content: 'u' + i, displayContent: 'u' + i, selections: null }
	: { role: 'assistant', displayContent: 'a' + i, reasoning: '', anthropicReasoning: null }

/**
 * Seeds N threads of M messages each, directly in the database.
 *
 * Seeding rather than driving the app is the point: the measurement has to count
 * messages the renderer holds because they were *opened*, and creating them through
 * the app would make each one resident as a side effect of creating it.
 */
function seedThreads(dirs) {
	const ids = Array.from({ length: THREAD_COUNT }, (_, n) => threadIdOf(n))
	const entries = [['void.chatThreadIndex', JSON.stringify(ids)]]

	for (const [n, id] of ids.entries()) {
		entries.push([`void.chatThread.${id}`, JSON.stringify({
			id,
			createdAt: '2026-01-01T00:00:00.000Z',
			lastModified: `2026-01-0${n + 1}T00:00:00.000Z`,
			state: { stagingSelections: [], linksOfMessageIdx: {} },
		})])
		for (let i = 0; i < MESSAGES_PER_THREAD; i++) {
			entries.push([`void.chatMsg.${id}.${i}`, JSON.stringify(message(i))])
		}
	}

	h.writeAppKeys(dirs, entries)
	return ids
}

/** What the renderer is still holding, read in the page. */
const measure = (session) => session.page.evaluate(() => {
	const svc = globalThis.__voidChatThreadService
	const threads = Object.values(svc.state.allThreads)
	const holding = threads
		.map(t => ({ id: t.id, messages: t.messages?.length ?? 0 }))
		.filter(t => t.messages > 0)
	return {
		currentThreadId: svc.state.currentThreadId,
		loadedSetSize: svc._loadedMessageThreadIds.size,
		residentMessages: holding.reduce((n, t) => n + t.messages, 0),
		holding,
		// Corroboration only — not asserted on. Absent on a build without the API.
		heapBytes: globalThis.performance?.memory?.usedJSHeapSize ?? null,
	}
})

const report = (t, label, m) => {
	t.diagnostic(`${label}: ${m.holding.length} thread(s) holding ${m.residentMessages} message(s); ` +
		`_loadedMessageThreadIds.size=${m.loadedSetSize}; heap=${m.heapBytes ?? 'n/a'}`)
	t.diagnostic(`${label}: ${JSON.stringify(m.holding)}`)
}

describe('thread residency', () => {

	test('opening N threads does not keep all N resident', async (t) => {
		const dirs = h.createProfile('thread-residency/bounded')
		const ids = seedThreads(dirs)

		// Guard the fixture before the app sees it: the count below is only about
		// messages that exist on disk.
		assert.ok((h.readAppKey(dirs, `void.chatMsg.${ids[0]}.${MESSAGES_PER_THREAD - 1}`) ?? '').includes('displayContent'),
			'fixture did not seed the last message of the first thread')

		const s = await h.launchVoid(dirs)
		try {
			// Guard: every seeded thread reached the service. If one did not, it can
			// never hold messages and the subject below would pass for that reason.
			const present = await s.page.evaluate((seeded) => {
				const svc = globalThis.__voidChatThreadService
				return seeded.filter(id => !!svc.state.allThreads[id]).length
			}, ids)
			assert.equal(present, THREAD_COUNT,
				`only ${present} of ${THREAD_COUNT} seeded threads reached the service`)

			const before = await measure(s)
			report(t, 'before opening anything', before)
			assert.equal(before.residentMessages, 0,
				`something was already resident before any thread was opened: ${JSON.stringify(before.holding)}`)

			// Open each thread the way a user does — a tab click, which is
			// `switchToThread` and therefore `_ensureMessagesLoaded`.
			for (const id of ids) {
				await s.page.evaluate((threadId) => globalThis.__voidChatThreadService.switchToThread(threadId), id)
			}

			const after = await measure(s)
			report(t, `after opening ${THREAD_COUNT}`, after)

			// Control: the thread last opened really is loaded and really has its
			// messages. Without this, "nothing else is resident" would also be true
			// of a build that loaded nothing at all.
			const active = after.holding.find(x => x.id === after.currentThreadId)
			assert.ok(active, `the active thread ${after.currentThreadId} holds no messages — nothing was loaded, so the subject is about nothing`)
			assert.equal(active.messages, MESSAGES_PER_THREAD,
				`the active thread holds ${active.messages} messages, expected ${MESSAGES_PER_THREAD}`)

			// The subject. Everything the design is about is here: whether threads
			// the user is no longer looking at keep their messages in the renderer.
			// `assertAbsent`'s flag reads as "is it absent", so it is `length === 0`.
			const others = after.holding.filter(x => x.id !== after.currentThreadId)
			h.assertAbsent(
				'messages still resident for threads that are not the active one',
				others.length === 0,
				{ subject: true },
			)
		} finally {
			await s.close()
		}
	})

	// The other half of the change, and the reason it cannot ship alone: evicting is
	// only correct if coming back reloads. This scenario passes in both directions
	// today and must keep passing after eviction exists — if eviction ever drops a
	// thread without a way back, it fails here rather than in a user's window.
	test('a thread evicted and reopened still shows its messages', async (t) => {
		const dirs = h.createProfile('thread-residency/reopen')
		const ids = seedThreads(dirs)
		const [first, second] = ids

		const s = await h.launchVoid(dirs)
		try {
			const read = (threadId) => s.page.evaluate((id) => {
				const svc = globalThis.__voidChatThreadService
				const thread = svc.state.allThreads[id]
				return {
					current: svc.state.currentThreadId,
					messages: thread?.messages?.length ?? 0,
					lastContent: thread?.messages?.[thread.messages.length - 1]?.displayContent ?? null,
				}
			}, threadId)

			await s.page.evaluate((id) => globalThis.__voidChatThreadService.switchToThread(id), first)
			const openedFirst = await read(first)
			assert.equal(openedFirst.messages, MESSAGES_PER_THREAD, 'the first thread did not load')

			// Leaving it is what makes it evictable.
			await s.page.evaluate((id) => globalThis.__voidChatThreadService.switchToThread(id), second)
			const onSecond = await read(second)
			assert.equal(onSecond.messages, MESSAGES_PER_THREAD, 'the second thread did not load')

			await s.page.evaluate((id) => globalThis.__voidChatThreadService.switchToThread(id), first)
			const back = await read(first)

			report(t, 'after returning to the first thread', await measure(s))
			assert.equal(back.current, first, 'the switch back did not take effect')
			assert.equal(back.messages, MESSAGES_PER_THREAD,
				`the reopened thread holds ${back.messages} messages, expected ${MESSAGES_PER_THREAD}`)
			assert.equal(back.lastContent, message(MESSAGES_PER_THREAD - 1).displayContent,
				'the reopened thread lost its last message')
		} finally {
			await s.close()
		}
	})
})
