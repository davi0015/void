/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A transient failure is retried twice, 2.5s apart, and nothing said so.
//
// Background: `_runChatAgent` retries a failed request `CHAT_RETRIES` (3)
// times, waiting `RETRY_DELAY` (2500ms) between attempts. That policy is right —
// a rate limit or a dropped connection often succeeds on the next attempt — but
// the wait is indistinguishable from a hang: the stream state goes to `'idle'`,
// no bubble is written, no error is shown, and the first thing the user sees is
// either a reply or the final error. Overflows stopped taking this path when
// they became relievable; everything else still does.
//
// Bug: the retry was invisible. Reported by the maintainer after reading the
// loop: "I didn't know there is a retry, so far I only get the final error."
//
// The request itself is the harness's failing transport, so the loop's real
// retry path runs; the assertions read the rendered window rather than the
// service, because "the user can see it" is the property under test.
//
//   npm run test-void -- --only=retry-visibility
//   VOID_EXPECT=lost npm run test-void -- --only=retry-visibility   # must fail on unmodified code

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

// A transient failure that keeps the retry policy. Groq's wording, which names
// a limit and a token count without being an overflow.
const RATE_LIMIT = 'Error: 429 Rate limit reached for model `qwen2.5-coder:7b` in organization `org_x` ' +
	'on tokens per minute (TPM): Limit 6000, Used 5500, Requested 1200. Please try again in 4s.'

before(() => h.preflight())

function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

/** Sends one user message and returns without waiting for the run. */
async function send(page, userMessage = 'carry on') {
	await page.evaluate(async (text) => {
		const svc = globalThis.__voidChatThreadService
		await svc.addUserMessageAndStreamResponse({ userMessage: text, threadId: svc.state.currentThreadId })
	}, userMessage)
}

/**
 * Waits for the window to render the composer's waiting state, and reports what
 * was on screen at that moment.
 *
 * The retry window is ~2.5s, so this polls the rendered text rather than
 * sampling once. `retryText` is the line the composer shows while the loop
 * waits; `streamRetrying` is the state behind it, reported alongside so a
 * failure says whether the UI or the state is missing.
 */
function waitForRetryWindow(page, timeoutMs = 20000) {
	return page.evaluate(async (timeout) => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		const t0 = Date.now()
		let sawLine = null
		let sawState = null
		while (Date.now() - t0 < timeout) {
			const text = document.body.innerText.replace(/\s+/g, ' ')
			if (!sawLine) {
				const at = text.indexOf('retrying')
				if (at !== -1) sawLine = text.slice(Math.max(0, at - 60), at + 90)
			}
			const st = svc.streamState[id]
			if (!sawState && st?.retrying) sawState = { ...st.retrying }
			if (sawLine && sawState) break
			await new Promise(r => setTimeout(r, 25))
		}
		return { sawLine, sawState, waitedMs: Date.now() - t0 }
	}, timeoutMs)
}

/** What the composer shows now, and how the run ended. */
function currentScreen(page) {
	return page.evaluate(() => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		return {
			text: document.body.innerText.replace(/\s+/g, ' '),
			state: svc.streamState[id]?.retrying ? { ...svc.streamState[id].retrying } : null,
			errorMessage: svc.streamState[id]?.error?.message ?? null,
		}
	})
}

/**
 * How many requests the *agent loop* sent. A new thread also fires a
 * fire-and-forget title request, which `waitForRunEnd`'s own count includes, so
 * the loop's requests are identified by the extras it stamps on them
 * (`loggingExtras.nMessagesSent`) — the same filter the compaction tests use.
 */
async function chatRequestCount(page) {
	const all = JSON.parse(await h.capturedLLMRequests(page))
	return all.filter(r => r?.logging?.loggingExtras?.nMessagesSent !== undefined).length
}

describe('retry visibility', () => {

	test('a retried request says so while it waits', async (t) => {
		await h.withScenario('retry-visibility/transient', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 4)
			await h.stubLLM(s.page, 'unused', { error: RATE_LIMIT })

			await send(s.page)
			const during = await waitForRetryWindow(s.page)
			trace(t, s)
			t.diagnostic(`retry line at ${during.waitedMs}ms: ${JSON.stringify(during.sawLine)}`)
			t.diagnostic(`retry state: ${JSON.stringify(during.sawState)}`)

			// The state the UI renders from.
			h.assertPersistence(
				`a retry in the stream state (${JSON.stringify(during.sawState)})`,
				during.sawState !== null,
				{ subject: true },
			)
			// And the line the user reads, which is the actual complaint.
			h.assertPersistence(
				`the composer saying a request is being retried (${JSON.stringify(during.sawLine)})`,
				typeof during.sawLine === 'string' && /retrying \(attempt \d+ of \d+\)/.test(during.sawLine),
				{ subject: true },
			)

			const settled = await h.waitForRunEnd(s.page)
			const after = await currentScreen(s.page)
			t.diagnostic(`ended: ${JSON.stringify(settled.errorMessage)?.slice(0, 120)}`)

			// Control: the retry policy itself is unchanged — the run still
			// repeats the request before giving up (`CHAT_RETRIES` is 3).
			const attempts = await chatRequestCount(s.page)
			assert.ok(
				attempts > 1,
				`the request was not retried (${attempts} chat request(s))`,
			)
			// Control: the line belongs to the wait, not to the failure. Once the
			// run ends, the error is what remains.
			assert.equal(after.state, null, 'the retry state outlived the run')
			assert.ok(
				!after.text.includes('retrying (attempt'),
				'the retry line is still on screen after the run ended',
			)
			assert.ok(
				(after.errorMessage ?? '').includes('Rate limit'),
				`the run did not end on the provider's error: ${JSON.stringify(after.errorMessage)}`,
			)
		})
	})

	test('a request that succeeds says nothing about retrying', async (t) => {
		await h.withScenario('retry-visibility/control-success', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 4)
			await h.stubLLM(s.page, 'all good')

			await send(s.page)
			await h.waitForRunEnd(s.page)
			const after = await currentScreen(s.page)
			trace(t, s)

			// Control: no retry state on a run that worked, and nothing on screen
			// claiming one.
			assert.equal(after.state, null, 'a successful run left a retry state behind')
			assert.ok(
				!after.text.includes('retrying (attempt'),
				'a successful run rendered a retry line',
			)
			const attempts = await chatRequestCount(s.page)
			assert.equal(attempts, 1, `a successful turn sent ${attempts} chat request(s)`)
		})
	})

})
