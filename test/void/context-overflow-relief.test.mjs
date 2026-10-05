/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A request that does not fit in the model's context window is retried three
// times, unchanged, and every attempt is guaranteed to fail the same way.
//
// Background: `_runChatAgent` retries a failed request `CHAT_RETRIES` (3) times,
// `RETRY_DELAY` (2500ms) apart, and the request it re-sends is the same array it
// built before the first attempt — `prepareLLMChatMessages` runs once per loop
// iteration, outside the retry loop. That policy is right for a rate limit or a
// dropped connection and wrong for a context overflow, which is a statement
// about the input: the same input fails identically, so the user waits ~5s and
// pays for two extra round trips to arrive at the error they were always going
// to get.
//
// Bug: an overflow is not distinguished from a transient error, and nothing
// relieves the input. Two valves exist for size and both are switched off for a
// good reason — trimming tool-result bodies (`_compactToolResultsForRequest`)
// and the emergency message trim both break the provider's prefix cache, so
// paying that cost on every request is a loss. Neither reason survives a request
// that has already been rejected: there is no warm cache on a request the
// provider refused.
//
// Example below: eight turns with four tool calls each. Tool rows are the bulk
// of the request and sit before the pruner's protection boundary, so the two
// scenarios differ only in body size — 1.3k chars (under both trim thresholds,
// so relief has nothing it may touch) and 3.9k (over both). The retry policy is
// reached through the harness's failing transport, which calls `onError` with a
// real provider message.
//
//   npm run test-void -- --only=context-overflow
//   VOID_EXPECT=lost npm run test-void -- --only=context-overflow   # must fail on unmodified code

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

// The classic OpenAI-compatible overflow, as it arrives at `onError`: the SDK
// error stringified by `sendLLMMessage.impl.ts` (`onError({ message: error + '' })`).
const OVERFLOW = "Error: 400 This model's maximum context length is 8192 tokens. " +
	'However, your messages resulted in 12000 tokens. Please reduce the length of the messages.'

// A transient failure that must keep the existing retry policy. Groq's rate
// limit wording deliberately contains "tokens" and "Limit" — an overflow
// classifier that keys on those words would mistake it for one.
const RATE_LIMIT = 'Error: 429 Rate limit reached for model `qwen2.5-coder:7b` in organization `org_x` ' +
	'on tokens per minute (TPM): Limit 6000, Used 5500, Requested 1200. Please try again in 4s.'

const TURNS = 8
const TOOL_CALLS_PER_TURN = 4

before(() => h.preflight())

function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

/**
 * The requests the agent loop sent for the chat turn, in order. The loop stamps
 * `loggingExtras.nMessagesSent` on each, which separates them from the
 * fire-and-forget title request a new thread fires.
 */
function chatRequests(requestsJson) {
	return JSON.parse(requestsJson).filter(r => r?.logging?.loggingExtras?.nMessagesSent !== undefined)
}

/**
 * Sends one user message and waits for the run to settle.
 *
 * The send path starts the agent loop without awaiting it, so this waits on the
 * thread's stream state (see `h.waitForRunEnd`) rather than on the send.
 */
async function sendAndSettle(page, userMessage = 'carry on') {
	await page.evaluate(async (text) => {
		const svc = globalThis.__voidChatThreadService
		await svc.addUserMessageAndStreamResponse({ userMessage: text, threadId: svc.state.currentThreadId })
	}, userMessage)
	return h.waitForRunEnd(page)
}

/**
 * Sizes each chat request by the characters it would put on the wire, and counts
 * the trimmed tool bodies in it. `charCount` sums message content plus the
 * separate system message, which is the same unit `sentChars` uses.
 *
 * The marker is counted only on `role: 'tool'` messages, and only at the start
 * of the content, because the system prompt itself *describes* the marker
 * (`prompts.ts` tells the model that older tool results may begin with
 * "[trimmed — ...]") — counting substrings anywhere would count every request.
 */
function summaryOf(request) {
	const msgs = request?.messages ?? []
	let chars = 0
	let trimmedCount = 0
	for (const m of msgs) {
		const c = typeof m.content === 'string' ? m.content : ''
		chars += c.length
		if (m.role === 'tool' && c.startsWith('[trimmed —')) trimmedCount += 1
	}
	chars += (request?.separateSystemMessage ?? '').length
	return { chars, trimmedCount, messageCount: msgs.length }
}

describe('context overflow relief', () => {

	test('an overflow with nothing to trim is not re-sent', async (t) => {
		await h.withScenario('context-overflow/nothing-to-trim', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'unused', { error: OVERFLOW })

			const settled = await sendAndSettle(s.page)
			const requests = chatRequests(await h.capturedLLMRequests(s.page))
			trace(t, s)

			assert.ok(requests.length > 0, 'no request reached the model transport')

			// The default fixture's bodies are under both trim thresholds, so
			// relief has nothing it is allowed to touch and re-sending is
			// pointless. One attempt, then the error.
			h.assertAbsent(
				`a re-sent overflowing request (${requests.length} attempt(s))`,
				requests.length === 1,
				{ subject: true },
			)

			// And the user is told what to do about it, rather than only being
			// handed the provider's text.
			h.assertPersistence(
				`an explanation that the conversation no longer fits (error: ${settled.errorMessage})`,
				typeof settled.errorMessage === 'string' && settled.errorMessage.includes('no longer fits'),
				{ subject: true },
			)
			assert.ok(
				settled.errorMessage?.includes('maximum context length'),
				'the provider message was dropped instead of being kept alongside the explanation',
			)
		})
	})

	test('a trimmable overflow is relieved once and re-sent smaller', async (t) => {
		await h.withScenario('context-overflow/relieved', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN, { toolBodyRepeats: 3 })
			await h.stubLLM(s.page, 'unused', { error: OVERFLOW })

			// Fixture guard: relief can only be observed if the pruner is
			// allowed to trim these bodies — over 2000 chars or 60 lines, before
			// the protection boundary. Without this the scenario would report a
			// confident "no relief happened" for a fixture that never built one.
			const fixture = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				const msgs = svc.state.allThreads[svc.state.currentThreadId].messages
				const tool = msgs.filter(m => m.role === 'tool')
				const bodies = tool.map(m => m.content ?? '')
				return {
					toolRows: tool.length,
					messageCount: msgs.length,
					overThreshold: bodies.filter(b => b.length >= 2000 || b.split('\n').length >= 60).length,
				}
			})
			assert.ok(fixture.toolRows >= 8, `fixture built only ${fixture.toolRows} tool rows`)
			assert.ok(
				fixture.overThreshold >= 8,
				`fixture bodies are not trim-eligible (${fixture.overThreshold}/${fixture.toolRows} over threshold)`,
			)

			const settled = await sendAndSettle(s.page)
			const requests = chatRequests(await h.capturedLLMRequests(s.page))
			trace(t, s)

			assert.ok(requests.length > 0, 'no request reached the model transport')
			const sizes = requests.map(r => summaryOf(r).chars)
			t.diagnostic(`request sizes: ${sizes.join(', ')}`)

			// One relieved retry, not three identical attempts. Both attempts
			// overflow (the stub fails every request), so the run ends on the
			// provider's error after the relief gave it a second chance.
			const retry = requests[1] ? summaryOf(requests[1]) : null
			h.assertAbsent(
				`a third attempt after relief (${requests.length} attempt(s), sizes ${sizes.join('/') || 'none'})`,
				requests.length === 2,
				{ subject: true },
			)
			h.assertPersistence(
				`trimmed tool bodies in the retry (${retry ? retry.trimmedCount : 'no retry'} trimmed)`,
				(retry?.trimmedCount ?? 0) > 0,
				{ subject: true },
			)
			h.assertPersistence(
				`a smaller retry (${sizes[0] ?? 'none'} -> ${sizes[1] ?? 'none'} chars)`,
				sizes.length === 2 && sizes[1] < sizes[0],
				{ subject: true },
			)
			// Both attempts overflowed, so the run ends — but with the explanation
			// attached rather than only the provider's text (scenario 3 checks
			// that the provider's text survives underneath it).
			h.assertPersistence(
				`an explanation of the overflow (error: ${settled.errorMessage})`,
				settled.errorMessage?.includes('no longer fits') === true,
				{ subject: true },
			)

			// Control: relief is a request-image change. The stored thread keeps
			// full bodies, so nothing is lost from the conversation and the next
			// request (or a reload) is unaffected.
			const stored = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				const msgs = svc.state.allThreads[svc.state.currentThreadId].messages
				return msgs.filter(m => m.role === 'tool').map(m => (m.content ?? '').length)
			})
			assert.ok(
				stored.every(len => len >= 2000),
				`relief rewrote stored messages: body lengths ${stored.join(', ')}`,
			)
		})
	})

	test('errors that are not overflows still retry', async (t) => {
		await h.withScenario('context-overflow/control-transient', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 4)
			await h.stubLLM(s.page, 'unused', { error: RATE_LIMIT })

			const settled = await sendAndSettle(s.page)
			const requests = chatRequests(await h.capturedLLMRequests(s.page))
			trace(t, s)

			// Control — must hold before and after the change. `CHAT_RETRIES` is
			// 3; the point is that a transient failure is still repeated rather
			// than being collapsed into the overflow policy.
			assert.ok(
				requests.length > 1,
				`a rate limit was not retried (${requests.length} request(s)) — the retry policy was narrowed too far`,
			)
			assert.ok(
				settled.errorMessage === null || !settled.errorMessage.includes('no longer fits'),
				'a rate limit was reported as a context overflow',
			)
		})
	})

	test('a request that fits still goes out untouched', async (t) => {
		await h.withScenario('context-overflow/control-success', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN, { toolBodyRepeats: 3 })
			await h.stubLLM(s.page, 'all good')

			await sendAndSettle(s.page)
			const requests = chatRequests(await h.capturedLLMRequests(s.page))
			trace(t, s)

			// Control: nothing is trimmed unless the provider rejected the
			// request, so the prefix cache is untouched on the normal path.
			assert.equal(requests.length, 1, `a successful turn sent ${requests.length} requests`)
			assert.equal(
				summaryOf(requests[0]).trimmedCount, 0,
				'a successful request was trimmed — relief is firing without an overflow',
			)
		})
	})

})
