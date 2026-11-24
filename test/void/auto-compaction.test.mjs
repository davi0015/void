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
// from `getModelCapabilities`, so the test forces one through the model overrides rather
// than pretending to have a small model — the code path under test is the real one.
//
//   npm run test-void -- --only=auto-compaction

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

/** A phrase only the summarisation request carries. */
const COMPACTION_PROMPT = 'Extract and organize the key information'

/**
 * Selects a chat model and forces its context window, returning what the trigger will
 * read so the fixture can prove the setup instead of assuming it.
 *
 * The selection is the harness's direct mutation rather than
 * `setModelSelectionOfFeature`, because on a fresh profile that setter validates the
 * model against the configured providers and there are none — the selection would be
 * dropped. The override goes through its real setter, which is a write; the settings
 * merge treats the direct selection as a local change and persists it along with the
 * override, so a reload in the middle of the scenario cannot take either away.
 */
function prepareModel(page, contextWindow) {
	return page.evaluate(async (tokens) => {
		const settings = globalThis.__voidChatThreadService._settingsService
		const selection = settings.state.modelSelectionOfFeature['Chat']
			?? { providerName: 'ollama', modelName: 'qwen2.5-coder:7b' }
		const existing = settings.state.overridesOfModel[selection.providerName]?.[selection.modelName] ?? {}
		// The write comes first: a settings write re-validates the state, and validation
		// drops a selection whose provider has no configured models — which is every
		// model on a fresh profile. Selecting after it leaves the selection in place for
		// the run, which is what the harness's own helper relies on too.
		await settings.setOverridesOfModel(selection.providerName, selection.modelName, { ...existing, contextWindow: tokens })
		settings.state.modelSelectionOfFeature['Chat'] = selection
		return {
			selection: settings.state.modelSelectionOfFeature['Chat'],
			contextWindow: settings.state.overridesOfModel[selection.providerName]?.[selection.modelName]?.contextWindow,
		}
	}, contextWindow)
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
async function requestKinds(page) {
	const raw = JSON.parse(await h.capturedLLMRequests(page))
	return raw.map((req, idx) => ({
		idx,
		isCompaction: JSON.stringify(req.messages ?? '').includes(COMPACTION_PROMPT),
	}))
}

describe('auto compaction', () => {

	test('a request that would leave too little context is compacted first', async () => {
		await h.withScenario('auto-compaction/triggered', async (s) => {
			const seeded = await seedLongThread(s.page)
			assert.ok(seeded.count >= 40, `fixture: the long thread was not seeded (${seeded.count} messages)`)

			// 8k window: threshold = min(1,600, 30,000) = 1,600 tokens left.
			const model = await prepareModel(s.page, 8_000)
			assert.ok(model.selection, 'fixture: no chat model is selected')
			assert.equal(model.contextWindow, 8_000, 'fixture: the context-window override did not stick')
			await h.stubLLM(s.page, 'ok')

			await s.page.evaluate(async (id) => {
				await globalThis.__voidChatThreadService.addUserMessageAndStreamResponse({ userMessage: 'carry on', threadId: id })
			}, seeded.id)
			await h.waitForRunEnd(s.page)

			const state = await compactionState(s.page, seeded.id)
			h.assertPersistence('the thread was summarised before sending', typeof state.summary === 'string' && state.summary.length > 0, { subject: true })
			h.assertPersistence('a boundary was written', state.boundaryIdx !== null, { subject: true })

			const kinds = await requestKinds(s.page)
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
			const seeded = await seedLongThread(s.page)

			// A large window, forced the same way, so the control goes down the same
			// setup path and only the window differs.
			const model = await prepareModel(s.page, 200_000)
			assert.ok(model.selection, 'fixture: no chat model is selected')
			assert.equal(model.contextWindow, 200_000, 'fixture: the control did not get its window')
			await h.stubLLM(s.page, 'ok')

			await s.page.evaluate(async (id) => {
				await globalThis.__voidChatThreadService.addUserMessageAndStreamResponse({ userMessage: 'carry on', threadId: id })
			}, seeded.id)
			await h.waitForRunEnd(s.page)

			const state = await compactionState(s.page, seeded.id)
			h.assertAbsent('no summary was written', state.summary === null, {})
			const kinds = await requestKinds(s.page)
			h.assertAbsent('no summarisation request was sent', !kinds.some(k => k.isCompaction), {})
		})
	})
})
