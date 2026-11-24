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
})
