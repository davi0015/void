/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Thread identity (S6).
//
// A tool has to act on the thread it is *executing* for, which is not always the
// thread the user is looking at. `ToolCtx` carries the DI services a tool needs
// but no thread, so a tool that wants "this conversation" asks the service for
// the current one — and `currentThreadId` means the thread on screen.
//
// `search_history` is the tool that does this (`searchHistory.tool.ts`), and it
// is wrong today whenever the two differ: start a run, click another thread
// while it works, and the next `search_history` call searches the thread you
// clicked. It returns plausible matches from someone else's conversation and
// nothing errors.
//
// This file is the S6 acceptance gate:
//   * a tool invoked on a non-visible thread reads that thread's conversation;
//   * it still reads the visible one when that is the thread it was asked for.
//
// The first scenario is the subject, the second a control that must pass before
// and after, and the third pins the related trap: the visible thread is the only
// one guaranteed to have its messages in memory, so acting on another thread
// means loading it first.
//
//   npm run test-void -- --only=thread-identity
//   VOID_EXPECT=lost npm run test-void -- --only=thread-identity

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

const ALPHA = 'ALPHA-MARKER the visible thread said this'
const BRAVO = 'BRAVO-MARKER the executing thread said this'

before(() => h.preflight())

/** Prints storage traces when a scenario fails, so CI logs are diagnosable. */
function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

/**
 * Puts one user message on the current thread and reloads it, so the message is
 * in memory the way an opened thread's messages are.
 */
async function seedCurrentThread(page, text) {
	return page.evaluate((message) => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		svc._storeMessageKey(id, 0, { role: 'user', content: message, displayContent: message, selections: null })
		// _storeMessageKey only queues; the reload below reads storage.
		svc._flushPendingThreadWrites()
		svc._loadedMessageThreadIds.delete(id)
		svc._ensureMessagesLoaded(id)
		return { id, messageCount: svc.state.allThreads[id].messages.length }
	}, text)
}

/**
 * Calls `search_history` through the same dispatch map the agent loop uses,
 * naming the thread it is executing for.
 *
 * The second argument is the whole point: the old dispatch signature took only
 * the params, so it is ignored and the tool falls back to the visible thread.
 * A fixture that could not run against unpatched code could not show what the
 * fix changed.
 */
async function searchHistoryFor(page, threadId, query) {
	return page.evaluate(async ({ id, q }) => {
		const svc = globalThis.__voidChatThreadService
		const out = await svc._toolsService.callTool['search_history'](
			{ query: q, toolName: null, resultStatus: null, contextRadius: 1 },
			id,
		)
		const result = await out.result
		return { matches: result.matches, totalMatches: result.totalMatches }
	}, { id: threadId, q: query })
}

/** Two threads: A visible with ALPHA in it, B not visible with BRAVO in it. */
async function twoThreads(page) {
	const a = await seedCurrentThread(page, ALPHA)
	await page.evaluate(() => globalThis.__voidChatThreadService.openNewThread())
	const b = await seedCurrentThread(page, BRAVO)
	const state = await page.evaluate((aId) => {
		const svc = globalThis.__voidChatThreadService
		svc.switchToThread(aId)
		return { currentThreadId: svc.state.currentThreadId }
	}, a.id)

	// Guards: two distinct threads, both holding a message, with A on screen.
	assert.notEqual(a.id, b.id, 'the fixture produced one thread instead of two')
	assert.equal(a.messageCount, 1, `thread A did not load its message (${a.messageCount})`)
	assert.equal(b.messageCount, 1, `thread B did not load its message (${b.messageCount})`)
	assert.equal(state.currentThreadId, a.id, 'thread A is not the visible thread')

	return { a, b }
}

describe('thread identity', () => {

	test('a tool invoked for a non-visible thread reads that thread', async (t) => {
		await h.withScenario('thread-identity/non-visible', async (s) => {
			const { a, b } = await twoThreads(s.page)

			const result = await searchHistoryFor(s.page, b.id, 'MARKER')
			trace(t, s)
			t.diagnostic(`searching for B returned ${result.totalMatches} match(es): ${result.matches.slice(0, 200)}`)

			// Guard: the search has to have found something, or "BRAVO is absent"
			// would hold for the uninteresting reason that nothing matched.
			assert.ok(result.totalMatches > 0, 'the search matched nothing at all')

			h.assertPersistence(
				'the executing thread\'s messages',
				result.matches.includes('BRAVO-MARKER'),
				{ subject: true },
			)
			h.assertAbsent(
				'the visible thread\'s messages in the result',
				!result.matches.includes('ALPHA-MARKER'),
				{ subject: true },
			)

			// Control: A is still the visible thread and still holds its message,
			// so the absence above is about which thread was read and not about A
			// having been mutated by the fixture.
			const aIntact = await s.page.evaluate((id) => {
				const thread = globalThis.__voidChatThreadService.state.allThreads[id]
				return thread?.messages?.some(m => (m.displayContent ?? '').includes('ALPHA-MARKER')) ?? false
			}, a.id)
			assert.ok(aIntact, 'the visible thread lost its message — the fixture is unsound')
		})
	})

	test('a tool invoked for the visible thread still reads that thread', async (t) => {
		await h.withScenario('thread-identity/visible', async (s) => {
			const { a, b } = await twoThreads(s.page)

			const result = await searchHistoryFor(s.page, a.id, 'MARKER')
			trace(t, s)

			// Control, in the sense the harness means it: this must hold in both
			// configurations. If searching the visible thread broke, the subject
			// above would be reporting on a tool that cannot search at all.
			assert.ok(result.totalMatches > 0, 'the search matched nothing at all')
			assert.ok(
				result.matches.includes('ALPHA-MARKER'),
				`the visible thread's message was not returned: ${result.matches.slice(0, 200)}`,
			)
			assert.ok(
				!result.matches.includes('BRAVO-MARKER'),
				'the visible thread\'s search returned another thread\'s message',
			)

			// Guard: B still holds its message, so B's absence here is about which
			// thread was read.
			const bIntact = await s.page.evaluate((id) => {
				const thread = globalThis.__voidChatThreadService.state.allThreads[id]
				return thread?.messages?.some(m => (m.displayContent ?? '').includes('BRAVO-MARKER')) ?? false
			}, b.id)
			assert.ok(bIntact, 'the non-visible thread lost its message — the fixture is unsound')
		})
	})

	// The visible thread is the only one this session is guaranteed to have
	// opened, so "read the executing thread" is not enough on its own — the tool
	// has to be able to read a thread nobody has looked at. The fixture puts B
	// back into exactly the state startup leaves an unopened thread in, using the
	// same call startup uses.
	test('a thread this session has not opened is loaded before it is read', async (t) => {
		await h.withScenario('thread-identity/unopened', async (s) => {
			const { b } = await twoThreads(s.page)

			const unloaded = await s.page.evaluate((bId) => {
				const svc = globalThis.__voidChatThreadService
				const metadataOnly = svc._readThread(bId, false)
				svc._loadedMessageThreadIds.delete(bId)
				svc._setState({ allThreads: { ...svc.state.allThreads, [bId]: metadataOnly } })
				return { messageCount: svc.state.allThreads[bId].messages.length }
			}, b.id)

			// Guard: B really is in the unopened state, or this scenario repeats
			// the one above with extra steps.
			assert.equal(unloaded.messageCount, 0, 'the fixture did not unload the thread')

			const result = await searchHistoryFor(s.page, b.id, 'MARKER')
			trace(t, s)
			t.diagnostic(`searching for an unopened thread returned ${result.totalMatches} match(es)`)

			h.assertPersistence(
				'the messages of a thread this session had not opened',
				result.matches.includes('BRAVO-MARKER'),
				{ subject: true },
			)
		})
	})
})
