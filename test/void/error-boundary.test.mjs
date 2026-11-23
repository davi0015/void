/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A render error clears when the current thread changes, instead of replacing the
// chat pane until the window is reloaded.
//
// The boundary that wraps the chat exists so one bad render does not take the
// sidebar with it, but it had no way back: `hasError` stayed true for the session,
// which turned any transient render failure — the 1.5.0 startup landing raced the
// first render and threw `Current thread should never be undefined` — into a pane
// that could only be recovered by restarting, which repeated the race. The service
// underneath was healthy the whole time.
//
// So the behaviour under test is recovery, not the error: the same throw is induced
// on purpose, then the current thread is changed and the pane must come back.
//
//   npm run test-void -- --only=error-boundary

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

const PROBE = 'boundary probe: render failed'

describe('chat pane error boundary', () => {

	test('a transient render error clears when the current thread changes', async () => {
		await h.withScenario('error-boundary/reset', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.stubLLM(s.page, 'ok')
			// A thread with messages, so `openNewThread` below creates a *new* thread
			// rather than reusing the empty current one — the reset key has to change.
			await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				await svc.addUserMessageAndStreamResponse({ userMessage: 'boundary fixture', threadId: svc.state.currentThreadId })
			})
			await h.waitForRunEnd(s.page)

			// Induce the failure the way a race does: the next render throws.
			const crashed = await s.page.evaluate(async (probe) => {
				const svc = globalThis.__voidChatThreadService
				svc.__boundaryProbeOriginal = svc.getCurrentThread
				svc.getCurrentThread = () => { throw new Error(probe) }
				svc._setState({}) // notifies the React bridge
				const deadline = Date.now() + 10000
				while (Date.now() < deadline) {
					if ((document.body?.innerText ?? '').includes(probe)) return true
					await new Promise(r => setTimeout(r, 100))
				}
				return false
			}, PROBE)
			// Control: the induced render error really did replace the pane. Without
			// this the recovery assertion below could pass by never breaking anything.
			h.assertPersistence('the pane showed the induced render error', crashed, {})

			// Repair the service and change the current thread, which is what the
			// boundary watches. The chat input coming back is what "recovered" means —
			// the error text disappearing alone would also happen if the pane stayed
			// blank.
			const recovered = await s.page.evaluate(async (probe) => {
				const svc = globalThis.__voidChatThreadService
				svc.getCurrentThread = svc.__boundaryProbeOriginal
				delete svc.__boundaryProbeOriginal
				svc.openNewThread()
				const deadline = Date.now() + 10000
				while (Date.now() < deadline) {
					const text = document.body?.innerText ?? ''
					if (!text.includes(probe) && document.querySelector('[data-void-chat-input]')) return true
					await new Promise(r => setTimeout(r, 100))
				}
				return false
			}, PROBE)

			h.assertPersistence('the chat pane came back after the current thread changed', recovered, { subject: true })
		})
	})
})
