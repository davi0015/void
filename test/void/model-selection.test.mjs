/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The model dropdown is global state, but each chat is supposed to keep the
// model it was using: switching to a tab and back must not change what that tab
// shows.
//
// The memory is `lastUsedModelSelection` on the thread, and it used to do two
// jobs at once. It is the *run record* — the model the chat's last message was
// actually sent with — and it is what a switch restores. A model picked on a
// chat but never sent with is a *draft*: it belongs in `draftModelSelection`,
// is restored only for a chat that has no run record yet (a new chat, or one
// written before the record existed), and must never overwrite what the chat
// ran with. #172 wrote the leave-the-chat value into the run record so new
// chats would remember a pick, and a chat with messages then kept showing a
// model its last message never used.
//
// The subject is the restore *request*, not the final dropdown value. The
// settings service validates a selection against providers that are filled in,
// and a test profile has no credentials; a restore that reaches
// `setModelSelectionOfFeature` can therefore be nulled afterwards by validation
// (and a `dangerousSetState` patch to add a dummy key is overwritten by the
// external-state reload it triggers — measured, see the probe in the commit).
// So the scenarios spy on `setModelSelectionOfFeature` and assert what the
// switch asks for. That request is what the fix changes; whether it sticks is
// the settings service's business.
//
// For the same reason a pick is simulated by writing the field and firing the
// change event the picker fires: the setter's validation would otherwise null
// the value before the listener that records picks saw it.
//
// The models used are real provider entries, because the restore path refuses a
// selection whose provider or model no longer exists — a fake one would skip the
// restore for the wrong reason and make the red phase meaningless.
//
//   npm run test-void -- --only=model-selection

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

/** Rewrites one thread field the way storage would have loaded it. */
const setThreadField = (page, threadId, field, value) => page.evaluate(({ id, key, val }) => {
	const chat = globalThis.__voidChatThreadService
	chat.state.allThreads[id] = { ...chat.state.allThreads[id], [key]: val }
}, { id: threadId, key: field, val: value })

/** Three real, visible models of one commercial provider. */
const findModels = (page) => page.evaluate(() => {
	const settings = globalThis.__voidChatThreadService._settingsService
	for (const [providerName, st] of Object.entries(settings.state.settingsOfProvider)) {
		const names = (st.models ?? []).filter(m => !m.isHidden).map(m => m.modelName)
		if (names.length >= 3 && ['anthropic', 'openAI', 'deepseek'].includes(providerName)) {
			return {
				x: { providerName, modelName: names[0] },
				y: { providerName, modelName: names[1] },
				z: { providerName, modelName: names[2] },
			}
		}
	}
	return null
})

const sameSelection = (a, b) => !!a && !!b && a.providerName === b.providerName && a.modelName === b.modelName

/**
 * Writes the dropdown value and, unless told not to, fires the change event the
 * picker fires. Fixture-only ambient values pass `{ fire: false }` so they are
 * not recorded as a pick.
 */
const setChatModel = (page, selection, opts = {}) => page.evaluate(({ sel, fire }) => {
	const settings = globalThis.__voidChatThreadService._settingsService
	settings.state.modelSelectionOfFeature['Chat'] = sel
	if (fire) settings._onDidChangeState.fire()
}, { sel: selection, fire: opts.fire !== false })

const pickModel = (page, selection) => setChatModel(page, selection)

/** Records every selection the service is asked to restore. */
const spyOnSelectionRequests = (page) => page.evaluate(() => {
	const settings = globalThis.__voidChatThreadService._settingsService
	settings.__modelSelectionRequests = []
	const original = settings.setModelSelectionOfFeature
	settings.setModelSelectionOfFeature = (featureName, newVal) => {
		settings.__modelSelectionRequests.push({ featureName, newVal })
		return original.call(settings, featureName, newVal)
	}
})

/** The live dropdown, the recorded restore requests, and each thread's model records. */
const readChat = (page, threadIds = []) => page.evaluate((ids) => {
	const chat = globalThis.__voidChatThreadService
	const settings = chat._settingsService
	const threads = {}
	for (const id of ids) {
		const t = chat.state.allThreads[id]
		threads[id] = t ? {
			lastUsed: t.lastUsedModelSelection ?? null,
			draft: t.draftModelSelection ?? null,
			messages: t.messages.length,
		} : null
	}
	return {
		current: chat.state.currentThreadId,
		selection: settings.state.modelSelectionOfFeature['Chat'] ?? null,
		requests: (settings.__modelSelectionRequests ?? []).map(r => r.newVal),
		threads,
	}
}, threadIds)

const switchTo = (page, threadId) => page.evaluate((id) => globalThis.__voidChatThreadService.switchToThread(id), threadId)
const createThread = (page) => page.evaluate(() => globalThis.__voidChatThreadService.createThread())

describe('model selection per thread', () => {

	test('switching away and back asks for the model the thread showed', async (t) => {
		await h.withScenario('model-selection/switch', async (s) => {
			const page = s.page

			// Two real, visible models of one provider.
			const models = await page.evaluate(() => {
				const settings = globalThis.__voidChatThreadService._settingsService
				for (const [providerName, st] of Object.entries(settings.state.settingsOfProvider)) {
					const names = (st.models ?? []).filter(m => !m.isHidden).map(m => m.modelName)
					if (names.length >= 2 && ['anthropic', 'openAI', 'deepseek'].includes(providerName)) {
						return { x: { providerName, modelName: names[0] }, y: { providerName, modelName: names[1] } }
					}
				}
				return null
			})
			t.diagnostic(`models: ${JSON.stringify(models)}`)
			assert.ok(models, 'fixture: no provider with two visible models')
			const { x, y } = models

			// Record every selection the service asks for. The spy runs before the
			// real setter, so validation nulling the value does not hide the request.
			await page.evaluate(() => {
				const st = globalThis.__voidChatThreadService._settingsService
				st.__modelSelectionRequests = []
				const original = st.setModelSelectionOfFeature
				st.setModelSelectionOfFeature = (featureName, newVal) => {
					st.__modelSelectionRequests.push({ featureName, newVal })
					return original.call(st, featureName, newVal)
				}
			})

			const ids = await page.evaluate(() => {
				const chat = globalThis.__voidChatThreadService
				return { current: chat.state.currentThreadId, all: Object.keys(chat.state.allThreads) }
			})
			t.diagnostic(`threads: current=${ids.current} all=${JSON.stringify(ids.all)}`)
			assert.ok(ids.current, 'fixture: there must be a current thread')

			// The thread the user is on has no saved selection — the shape a thread
			// written before `lastUsedModelSelection` existed loads in.
			await setThreadField(page, ids.current, 'lastUsedModelSelection', undefined)
			assert.equal(
				await page.evaluate((id) => globalThis.__voidChatThreadService.state.allThreads[id]?.lastUsedModelSelection ?? null, ids.current),
				null,
				'fixture: the thread must start with no saved selection',
			)

			// It shows x; a second thread is opened and y is chosen there.
			await page.evaluate((sel) => { globalThis.__voidChatThreadService._settingsService.state.modelSelectionOfFeature['Chat'] = sel }, x)
			await page.evaluate(async (sel) => {
				const chat = globalThis.__voidChatThreadService
				const id = chat.createThread()
				await chat.switchToThread(id)
				chat._settingsService.state.modelSelectionOfFeature['Chat'] = sel
			}, y)
			assert.deepEqual(
				await page.evaluate(() => globalThis.__voidChatThreadService._settingsService.state.modelSelectionOfFeature['Chat']),
				y,
				'fixture: the model picked in the second thread must be in effect before returning',
			)

			// Coming back must ask for the model this thread was showing.
			await page.evaluate((id) => globalThis.__voidChatThreadService.switchToThread(id), ids.current)
			const subject = await page.evaluate((id) => {
				const st = globalThis.__voidChatThreadService._settingsService
				return {
					requests: st.__modelSelectionRequests.map(r => r.newVal),
					savedOnThread: globalThis.__voidChatThreadService.state.allThreads[id]?.lastUsedModelSelection ?? null,
				}
			}, ids.current)
			t.diagnostic(`requests: ${JSON.stringify(subject.requests)}\nsaved after return: ${JSON.stringify(subject.savedOnThread)}`)

			const askedForX = subject.requests.some(r => r && r.providerName === x.providerName && r.modelName === x.modelName)
			const wanted = h.expectedPersistence()
			assert.equal(
				askedForX, wanted,
				`returning to a thread must ask for the model it showed (expected asked=${wanted}, requests=${JSON.stringify(subject.requests)})`,
			)

			// Control, in both directions: a thread with a saved selection is asked
			// for on every switch. If this fails, the assertion above is blind.
			const control = await page.evaluate(async ({ ySel, currentId }) => {
				const chat = globalThis.__voidChatThreadService
				const id = chat.createThread()
				chat.state.allThreads[id] = { ...chat.state.allThreads[id], lastUsedModelSelection: ySel }
				chat._settingsService.__modelSelectionRequests = []
				await chat.switchToThread(id)
				return chat._settingsService.__modelSelectionRequests.map(r => r.newVal)
			}, { ySel: y, currentId: ids.current })
			t.diagnostic(`control requests: ${JSON.stringify(control)}`)
			assert.ok(
				control.some(r => r && r.providerName === y.providerName && r.modelName === y.modelName),
				'control: a thread with a saved selection must be asked for on switch',
			)
		})
	})

	test('a chat shows the model its last message ran with, not a pick that was never sent', async (t) => {
		await h.withScenario('model-selection/last-run', async (s) => {
			const page = s.page
			const models = await findModels(page)
			t.diagnostic(`models: ${JSON.stringify(models)}`)
			assert.ok(models, 'fixture: no provider with three visible models')
			const { x, y, z } = models
			await spyOnSelectionRequests(page)
			const t1 = await page.evaluate(() => globalThis.__voidChatThreadService.state.currentThreadId)

			// Control, before the subject so it runs in both directions: an ordinary
			// switch between two chats that do have run records restores each one.
			// Without this, "asked for the wrong model" and "asked for nothing" would
			// look alike.
			const control = await page.evaluate(async ({ xSel, ySel }) => {
				const chat = globalThis.__voidChatThreadService
				const st = chat._settingsService
				const first = chat.createThread()
				chat.state.allThreads[first] = { ...chat.state.allThreads[first], lastUsedModelSelection: xSel }
				await chat.switchToThread(first)
				const second = chat.createThread()
				chat.state.allThreads[second] = { ...chat.state.allThreads[second], lastUsedModelSelection: ySel }
				st.__modelSelectionRequests = []
				await chat.switchToThread(second)
				const asked = st.__modelSelectionRequests.map(r => r.newVal)
				await chat.switchToThread(first)
				return asked
			}, { xSel: x, ySel: y })
			t.diagnostic(`control requests: ${JSON.stringify(control)}`)
			assert.ok(control.some(r => sameSelection(r, y)), 'control: a chat with a run record must be restored on switch')

			// An existing chat: it has messages, and its last run used x.
			await switchTo(page, t1)
			await h.seedTestThread(page, 1)
			await setThreadField(page, t1, 'lastUsedModelSelection', x)
			await pickModel(page, x)
			assert.deepEqual((await readChat(page)).selection, x, 'fixture: the chat must show its run model before the pick')

			// A different model is picked here, but no message is sent with it.
			await pickModel(page, y)
			const picked = await readChat(page, [t1])
			t.diagnostic(`after pick: selection=${JSON.stringify(picked.selection)} t1=${JSON.stringify(picked.threads[t1])}`)
			assert.deepEqual(picked.selection, y, 'fixture: the pick must be live before leaving the chat')
			const wanted = h.expectedPersistence()
			const runRecordKept = sameSelection(picked.threads[t1].lastUsed, x)
			assert.equal(
				runRecordKept, wanted,
				`picking a model must not rewrite the record of what the chat ran with (lastUsed=${JSON.stringify(picked.threads[t1].lastUsed)})`,
			)

			// Visit another chat — which shows a third model — and come back.
			const t2 = await createThread(page)
			await switchTo(page, t2)
			await pickModel(page, z)
			await page.evaluate(() => { globalThis.__voidChatThreadService._settingsService.__modelSelectionRequests = [] })
			await switchTo(page, t1)
			const back = await readChat(page, [t1])
			t.diagnostic(`after round trip: selection=${JSON.stringify(back.selection)} t1=${JSON.stringify(back.threads[t1])} requests=${JSON.stringify(back.requests)}`)
			const askedForRun = back.requests.some(r => sameSelection(r, x))
			assert.equal(
				askedForRun, wanted,
				`returning to a chat must ask for the model its last message ran with (requests=${JSON.stringify(back.requests)})`,
			)
		})
	})

	test('leaving a chat does not give it a last-run model it never had', async (t) => {
		await h.withScenario('model-selection/no-fabricated-run', async (s) => {
			const page = s.page
			const models = await findModels(page)
			assert.ok(models, 'fixture: no provider with three visible models')
			const { x } = models

			// A chat from before the run record existed: it has messages, but no
			// `lastUsedModelSelection`.
			const old = await createThread(page)
			await switchTo(page, old)
			await h.seedTestThread(page, 1)
			await setThreadField(page, old, 'lastUsedModelSelection', undefined)
			// What the dropdown shows on the way out. Written without firing: this is
			// the ambient value the leave write reads, not a user pick.
			await setChatModel(page, x, { fire: false })
			const before = (await readChat(page, [old])).threads[old]
			assert.equal(before.lastUsed, null, 'fixture: the chat must start with no run record')

			// Leaving it must record the model it was showing as a draft, never as a
			// run record — a switch is not evidence of a message having run.
			const away = await createThread(page)
			await switchTo(page, away)
			const after = (await readChat(page, [old])).threads[old]
			t.diagnostic(`old chat after leaving: ${JSON.stringify(after)}`)
			const fabricated = after.lastUsed !== null
			assert.equal(
				fabricated, !h.expectedPersistence(),
				`leaving a chat must not record a run it never had (lastUsed=${JSON.stringify(after.lastUsed)})`,
			)
		})
	})
})
