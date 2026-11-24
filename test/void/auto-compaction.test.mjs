/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Proactive compaction: before a request is sent, if less than the trigger's worth of
// context is left, the oldest span is summarised first and the request that follows is
// built from the compacted view.
//
// The trigger is `min(20% of the window, 30k tokens)` of remaining context, computed
// from the *live* view (summary plus the messages after the boundary). The window comes
// from `getModelCapabilities`, so the test forces a small one through the model
// overrides rather than pretending to have a small model — the code path under test is
// the real one.
//
//   npm run test-void -- --only=auto-compaction

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

/** A phrase only the summarisation request carries. */
const COMPACTION_PROMPT = 'Extract and organize the key information'

/** Forces the chat model's context window, which is what the trigger reads. */
function forceContextWindow(page, tokens) {
	return page.evaluate((tokens) => {
		const settings = globalThis.__voidChatThreadService._settingsService
		const selection = settings.state.modelSelectionOfFeature['Chat']
		const { providerName, modelName } = selection
		settings.state.overridesOfModel[providerName] ??= {}
		settings.state.overridesOfModel[providerName][modelName] = {
			...settings.state.overridesOfModel[providerName][modelName],
			contextWindow: tokens,
		}
	}, tokens)
}

/** Appends a long alternating conversation to the current thread's log. */
function seedLongThread(page, { messages = 40, chars = 2_000 } = {}) {
	return page.evaluate(async ({ messages, chars }) => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		await svc.ensureMessagesLoaded(id)
		const start = svc.state.allThreads[id].messages.length
		const records = []
		for (let n = 0; n < messages; n++) {
			const text = `seed ${n} ` + 'x'.repeat(chars)
			records.push({
				i: start + n,
				m: n % 2 === 0
					? { role: 'user', content: text, displayContent: text, selections: null }
					: { role: 'assistant', content: text, displayContent: text },
			})
		}
		await svc._threadStore.call('append', { threadId: id, records })
		svc._loadedMessageThreadIds.delete(id)
		await svc.ensureMessagesLoaded(id)
		return { id, count: svc.state.allThreads[id].messages.length }
	}, { messages, chars })
}

/** The thread's compaction fields, read after the run. */
function compactionState(page, threadId) {
	return page.evaluate((id) => {
		const thread = globalThis.__voidChatThreadService.state.allThreads[id]
		return { summary: thread?.compactionSummary ?? null, boundaryIdx: thread?.compactionBoundaryIdx ?? null }
	}, threadId)
}

/** Which captured requests carry the summarisation prompt. */
async function requestKinds(page, threadId) {
	const raw = JSON.parse(await h.capturedLLMRequests(page))
	return raw.map((req, idx) => ({
		idx,
		isCompaction: JSON.stringify(req.messages ?? '').includes(COMPACTION_PROMPT),
	}))
}

describe('auto compaction', () => {

	test('a request that would leave too little context is compacted first', async () => {
		await h.withScenario('auto-compaction/triggered', async (s) => {
			await h.ensureModelSelection(s.page)
			await forceContextWindow(s.page, 8_000) // threshold = min(1,600, 30,000) = 1,600
			await h.stubLLM(s.page, 'ok')

			const seeded = await seedLongThread(s.page)
			assert.ok(seeded.count >= 40, `fixture: the long thread was not seeded (${seeded.count} messages)`)

			await s.page.evaluate(async (id) => {
				await globalThis.__voidChatThreadService.addUserMessageAndStreamResponse({ userMessage: 'carry on', threadId: id })
			}, seeded.id)
			await h.waitForRunEnd(s.page)

			const state = await compactionState(s.page, seeded.id)
			h.assertPersistence('the thread was summarised before sending', typeof state.summary === 'string' && state.summary.length > 0, { subject: true })
			h.assertPersistence('a boundary was written', state.boundaryIdx !== null, { subject: true })

			const kinds = await requestKinds(s.page, seeded.id)
			const compactionIndex = kinds.findIndex(k => k.isCompaction)
			// Control: the summarisation request exists at all, and the chat request is
			// after it. Without this the subject assertions could pass on a thread that
			// was compacted by something else.
			assert.ok(compactionIndex >= 0, 'no summarisation request was sent')
			assert.ok(kinds.some((k, i) => i > compactionIndex && !k.isCompaction), 'the chat request did not follow the compaction')
		})
	})

	test('a conversation with room to spare is not compacted (control)', async () => {
		await h.withScenario('auto-compaction/quiet', async (s) => {
			await h.ensureModelSelection(s.page)
			// Default window for a recognized model is >= 32k, so the same seed that
			// triggers above stays far from the line.
			await h.stubLLM(s.page, 'ok')

			const seeded = await seedLongThread(s.page)
			await s.page.evaluate(async (id) => {
				await globalThis.__voidChatThreadService.addUserMessageAndStreamResponse({ userMessage: 'carry on', threadId: id })
			}, seeded.id)
			await h.waitForRunEnd(s.page)

			const state = await compactionState(s.page, seeded.id)
			h.assertAbsent('no summary was written', state.summary === null, {})
			const kinds = await requestKinds(s.page, seeded.id)
			h.assertAbsent('no summarisation request was sent', !kinds.some(k => k.isCompaction), {})
		})
	})
})
