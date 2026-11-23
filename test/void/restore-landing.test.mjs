/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A thread restored at startup is current *before* its messages are read.
//
// 1.5.0 made the startup landing asynchronous: the landing thread's messages are a
// file in `globalStorage/void/threads/<id>/messages.jsonl`, so `_landOnThread` waits
// on a main-process read before publishing `currentThreadId`. The sidebar mounts
// inside that window, and `SidebarChat` calls `getCurrentThread()` at the top of its
// render — with no current thread that throws, and the React error boundary keeps the
// throw on screen for the rest of the session. The chat pane is then unusable until
// the next launch, which repeats it.
//
// The service state was right the whole time, which is why this asserts the sidebar's
// text and not `state.currentThreadId`: a service-only assertion passes on broken code.
//
//   npm run test-void -- --only=restore-landing

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

const ERROR_TEXT = 'Current thread should never be undefined'
const logPath = (dirs, threadId) => join(dirs.userDataDir, 'User', 'globalStorage', 'void', 'threads', threadId, 'messages.jsonl')

/** Polls the sidebar until it either shows the error or has a current thread. */
function observeLanding(page, timeoutMs = 15000) {
	return page.evaluate(async ({ errorText, timeout }) => {
		const deadline = Date.now() + timeout
		let sawError = false
		while (Date.now() < deadline) {
			if ((document.body?.innerText ?? '').includes(errorText)) { sawError = true; break }
			if (globalThis.__voidChatThreadService?.state?.currentThreadId) break
			await new Promise(r => setTimeout(r, 100))
		}
		return {
			sawError,
			currentThreadId: globalThis.__voidChatThreadService?.state?.currentThreadId,
			bodyText: (document.body?.innerText ?? '').slice(0, 300),
		}
	}, { errorText: ERROR_TEXT, timeout: timeoutMs })
}

describe('startup landing', () => {

	test('a restored log thread is current before its messages are read', async () => {
		const dirs = h.createProfile('restore-landing/stored')
		// Session 1: an ordinary turn, on the thread a fresh profile opens with. That
		// pins it and records it as the workspace's last-active thread, which is what
		// makes the next launch land on it.
		const id = await (async () => {
			const s = await h.launchVoid(dirs)
			try {
				await h.ensureModelSelection(s.page)
				await h.stubLLM(s.page, 'ok')
				const threadId = await s.page.evaluate(async () => {
					const svc = globalThis.__voidChatThreadService
					const current = svc.state.currentThreadId
					await svc.addUserMessageAndStreamResponse({ userMessage: 'restore me', threadId: current })
					return current
				})
				await h.waitForRunEnd(s.page)
				await h.sleep(500)
				return threadId
			}
			finally {
				await s.close()
			}
		})()
		// Guard the fixture: without a log on disk the relaunch lands on a key-backed
		// thread, the read is synchronous, and the scenario proves nothing.
		assert.equal(existsSync(logPath(dirs, id)), true,
			'fixture: the first session did not write a log, so the relaunch is not restoring a log thread')

		const s = await h.launchVoid(dirs)
		try {
			const seen = await observeLanding(s.page)
			h.assertAbsent('the current-thread error in the sidebar', !seen.sawError, { subject: true })

			// Control: the landing did happen, on the thread that was restored.
			h.assertPersistence('the restored thread is current', seen.currentThreadId === id, {})

			const messages = await s.page.evaluate(async (threadId) => {
				const svc = globalThis.__voidChatThreadService
				await svc.ensureMessagesLoaded(threadId)
				return svc.getThreadWithMessages(threadId)?.messages?.map(m => m.displayContent) ?? []
			}, id)
			assert.ok(messages.length >= 2,
				`the restored thread did not bring its conversation back: ${JSON.stringify(messages)}`)
		}
		finally {
			await s.close()
		}
	})

	test('a fresh profile lands without the error (control)', async () => {
		// No stored thread, so `openNewThread` lands synchronously. This passes in every
		// configuration; a failure here means the harness or the launch is unsound.
		await h.withScenario('restore-landing/fresh', async (s) => {
			const seen = await observeLanding(s.page)
			h.assertAbsent('the current-thread error in the sidebar', !seen.sawError, {})
			h.assertPersistence('a thread is current', !!seen.currentThreadId, {})
		})
	})
})
