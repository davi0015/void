/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The model dropdown is global state, but each chat is supposed to keep the
// model it was using: switching to a tab and back must not change what that tab
// shows. The memory is `lastUsedModelSelection` on the thread, and it was only
// written when a message was sent or when the dropdown changed *while that
// thread was current*. A thread that has never sent a message — or one written
// before the field existed — therefore has no saved selection, and the restore
// on the way back has nothing to restore. It keeps whatever model was picked
// elsewhere: the "model randomly changed" report.
//
// The subject is the restore *request*, not the final dropdown value. The
// settings service validates a selection against providers that are filled in,
// and a test profile has no credentials; a restore that reaches
// `setModelSelectionOfFeature` can therefore be nulled afterwards by validation
// (and a `dangerousSetState` patch to add a dummy key is overwritten by the
// external-state reload it triggers — measured, see the probe in the commit).
// So the scenario spies on `setModelSelectionOfFeature` and asserts that the
// switch back asks for the thread's model. That request is what the fix adds;
// whether the request sticks is the settings service's business.
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
})
