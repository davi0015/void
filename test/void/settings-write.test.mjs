/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A settings write survives the next second in the window that made it.
//
// Settings are one encrypted blob, and the main process echoes every storage change
// back to the window that wrote it as an `external` change. `_reloadExternalState`
// treats those as another window's edit and re-reads the blob, so a reload that lands
// while a write is still encrypting or flushing adopts the *previous* blob and undoes
// the setting — then the follow-on writes (the model-selection mirrors) persist the
// reverted value. The user sees a setting flip back a moment after choosing it.
//
// The assertion is deliberately "still there a second later" rather than "the setter
// returned the new value": the revert happens after the setter resolves, which is why
// no existing test caught it.
//
//   npm run test-void -- --only=settings-write

import { describe, test, before } from 'node:test'
import * as h from './harness.mjs'

before(() => h.preflight())

const modeNow = (page) => page.evaluate(() => globalThis.__voidChatThreadService._settingsService.state.globalSettings.chatMode)

describe('settings writes', () => {

	test('a chat mode set here is still set a second later', async () => {
		await h.withScenario('settings-write/sticks', async (s) => {
			await h.ensureModelSelection(s.page)

			const applied = await s.page.evaluate(async () => {
				const settings = globalThis.__voidChatThreadService._settingsService
				await settings.setGlobalSetting('chatMode', 'gather')
				return settings.state.globalSettings.chatMode
			})
			// Control: the setter did apply the value. A failure here is the fixture, not
			// the behaviour under test.
			h.assertPersistence('the mode took effect when set', applied === 'gather', {})

			await h.sleep(1000)
			const later = await modeNow(s.page)
			h.assertPersistence('the mode is still set a second later', later === 'gather', { subject: true })
		})
	})

	test('a reload whose read spans a write does not undo it', async (t) => {
		// The same defect as the scenario above, made deterministic. `_reloadExternalState`
		// reads the blob, and if a write completes while that read is in flight the read can
		// return the *previous* blob — which the reload then adopts, undoing a write that has
		// already been persisted. Under load the read is slow enough to overlap a write about
		// once per suite run; here the read is held open so it always does.
		await h.withScenario('settings-write/reload-race', async (s) => {
			await h.ensureModelSelection(s.page)

			const out = await s.page.evaluate(async () => {
				const settings = globalThis.__voidChatThreadService._settingsService
				const originalRead = settings._readState.bind(settings)
				let releaseRead = () => { }
				let held = false
				// Read the blob *now* (the state before the write), then hold the result: the
				// reload is between its read and its adoption while the write runs. Only the
				// first read is held — the write's own merge read must not wait for us.
				settings._readState = async () => {
					const value = await originalRead()
					if (!held) {
						held = true
						await new Promise(resolve => { releaseRead = resolve })
					}
					return value
				}
				const reload = settings._reloadExternalState()
				await new Promise(r => setTimeout(r, 100)) // let the reload reach the held read
				const before = settings.state.globalSettings.chatMode
				await settings.setGlobalSetting('chatMode', 'gather')
				const afterWrite = settings.state.globalSettings.chatMode
				releaseRead()
				await reload
				settings._readState = originalRead
				return { before, afterWrite, afterReload: settings.state.globalSettings.chatMode }
			})
			t.diagnostic(`reload race: ${JSON.stringify(out)}`)
			h.assertPersistence('the write applied', out.afterWrite === 'gather', {})
			h.assertPersistence(
				'the write survives a reload that read before it and adopted after it',
				out.afterReload === 'gather',
				{ subject: true },
			)
		})
	})
})
