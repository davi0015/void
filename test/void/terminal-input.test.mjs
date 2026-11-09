/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Terminal input.
//
// Opening a terminal and typing must reach the shell. The assertion is a file the
// shell creates, not text in the terminal widget: whether that text is in the DOM
// depends on which renderer xterm picked — the canvas renderer draws to pixels and
// leaves `.xterm-rows` empty — so an assertion on the DOM would report on the
// renderer rather than on whether the keystrokes arrived.
//
// The first scenario is the fixture guard. Keyboard events must reach the workbench
// at all, proven by a command palette that opens; without it, "typing did not reach
// the shell" is also what a harness that cannot type produces, and the two are
// indistinguishable from the failure text alone.
//
//   npm run test-void -- --only=terminal-input

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

/// No spaces, so the shell's redirect works with or without quoting.
const PROBE_FILE = join(h.ROOT, '.tmp', 'terminal-input-probe.txt')

before(() => h.preflight())

describe('terminal input', () => {

	test('the workbench receives keyboard events', async (t) => {
		await h.withScenario('terminal-input/palette', async (s) => {
			const page = s.page
			await page.keyboard.press('Control+Shift+P')
			const opened = await page.waitForSelector('.quick-input-widget', { timeout: 20000 }).then(() => true).catch(() => false)
			t.diagnostic(`command palette opened: ${opened}`)
			assert.ok(
				opened,
				'Control+Shift+P did not open the command palette. Keyboard events are not reaching the ' +
				'workbench at all, which is a different bug from the terminal one — fix this first or the ' +
				'next scenario cannot say anything about terminals.',
			)
		})
	})

	test('typing into a terminal reaches the shell', async (t) => {
		await h.withScenario('terminal-input/echo', async (s) => {
			const page = s.page
			rmSync(PROBE_FILE, { force: true })

			// Open the terminal through the palette rather than a keybinding: the
			// palette is already proven by the scenario above, and the terminal
			// keybinding varies by keyboard layout.
			await page.keyboard.press('Control+Shift+P')
			await page.waitForSelector('.quick-input-widget', { timeout: 20000 })
			await page.keyboard.type('Terminal: Create New Terminal', { delay: 15 })
			await h.sleep(600)
			await page.keyboard.press('Enter')

			const opened = await page.waitForSelector('.xterm', { timeout: 30000 }).then(() => true).catch(() => false)
			t.diagnostic(`terminal widget appeared: ${opened}`)
			assert.ok(opened, 'the terminal never appeared, so this scenario cannot reach the typing step')

			// The shell is spawned by the pty host, not by the renderer, so the widget
			// can exist before the shell is ready. Input typed into a pty that has not
			// started is buffered rather than lost, but the echo below is easier to
			// read when the profile has finished loading.
			await h.sleep(2500)

			const focused = await page.evaluate(() => {
				const textarea = document.querySelector('.xterm-helper-textarea')
				if (!textarea) return false
				textarea.focus()
				return document.activeElement === textarea
			})
			t.diagnostic(`xterm textarea focused: ${focused}`)
			assert.ok(focused, 'the terminal has no focusable input element, so keys would go to the editor instead')

			const typeTheCommand = async () => {
				await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus())
				await page.keyboard.type(`echo probe > ${PROBE_FILE}`, { delay: 15 })
				await page.keyboard.press('Enter')
			}

			// Under the full suite a dozen Electron apps start at once and the shell can
			// still be attaching when the first keystroke arrives. Type again rather than
			// lengthening the sleep: the assertion is that a typed command runs, not that
			// the first attempt was buffered.
			for (let attempt = 0; attempt < 2 && !existsSync(PROBE_FILE); attempt++) {
				if (attempt > 0) await h.sleep(4000)
				await typeTheCommand()
				const deadline = Date.now() + 15000
				while (Date.now() < deadline && !existsSync(PROBE_FILE)) await h.sleep(250)
			}
			t.diagnostic(`probe file created: ${existsSync(PROBE_FILE)}`)

			assert.ok(
				existsSync(PROBE_FILE),
				`the shell never ran the typed command (waited 20s for ${PROBE_FILE}). ` +
				'Input is reaching the terminal widget but not the shell, or keys are not reaching the widget at all.',
			)
		})
	})
})
