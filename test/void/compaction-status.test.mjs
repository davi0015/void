/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The compaction status belongs to the thread being compacted.
//
// The chat pane is one component reused across tab switches, so state it keeps about a
// compaction survives the switch: the Compact control in the *next* conversation renders
// as "Compacting..." and disabled. Driving the service directly does not reproduce it —
// the flag is set by the dialog's confirm handler, not by `compactCurrentThread` — so this
// goes through the two clicks a user makes.
//
// Inactive threads stay mounted and hidden for caching, so the assertion asks what is not
// inside a `display: none` ancestor: `body.textContent` also contains the hidden pane of
// the thread that really is compacting, which would make the check read the wrong one.
//
//   npm run test-void -- --only=compaction-status

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

/** Text of every innermost element mentioning "Compacting" that is not in a hidden pane. */
const visibleCompactingText = (page) => page.evaluate(() => {
	const inHiddenPane = (el) => {
		for (let n = el; n; n = n.parentElement) {
			if (getComputedStyle(n).display === 'none') return true
		}
		return false
	}
	const found = []
	for (const el of Array.from(document.querySelectorAll('*'))) {
		const text = (el.textContent ?? '').trim()
		if (!text.includes('Compacting')) continue
		// Innermost match only: the bubble's span holds an icon child and the phrase as a
		// text node, so a leaf-only rule misses it and every-ancestor reports the sidebar.
		if (Array.from(el.children).some(c => (c.textContent ?? '').includes('Compacting'))) continue
		if (!inHiddenPane(el)) found.push(text.slice(0, 60))
	}
	return found
})

/** Clicks the first button whose own text is exactly `text`. */
const clickButton = (page, text) => page.evaluate((label) => {
	const button = Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === label)
	if (!button) return 'missing'
	if (button.disabled) return 'disabled'
	button.click()
	return 'clicked'
}, text)

describe('compaction status', () => {

	test('a compaction started in one thread does not show in another', async (t) => {
		await h.withScenario('compaction-status/other-thread', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 12, 2)
			const compactingThreadId = await s.page.evaluate(() => globalThis.__voidChatThreadService.state.currentThreadId)

			// A second thread, long enough that its composer offers the Compact control —
			// which is the element that carries the stale "Compacting..." label.
			await s.page.evaluate(async () => { globalThis.__voidChatThreadService.openNewThread() })
			await h.seedTestThread(s.page, 12, 2)
			const otherThreadId = await s.page.evaluate(() => globalThis.__voidChatThreadService.state.currentThreadId)
			assert.notEqual(otherThreadId, compactingThreadId, 'fixture: both threads are the same one')

			await s.page.evaluate(async (id) => { await globalThis.__voidChatThreadService.switchToThread(id) }, compactingThreadId)
			await h.stubLLM(s.page, 'summary text', { hang: true })

			// The two clicks a user makes: open the dialog, confirm it.
			const opened = await clickButton(s.page, 'Compact')
			assert.equal(opened, 'clicked', `fixture: the Compact control was not clickable (${opened})`)
			await h.sleep(200)
			const confirmed = await clickButton(s.page, 'Compact')
			assert.equal(confirmed, 'clicked', `fixture: the dialog's confirm was not clickable (${confirmed})`)

			const started = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const a = svc.state.currentThreadId
				for (let i = 0; i < 100; i++) {
					if (svc.streamState[a]?.compacting) break
					await new Promise(r => setTimeout(r, 50))
				}
				return { id: a, compacting: !!svc.streamState[a]?.compacting }
			})
			assert.equal(started.id, compactingThreadId, 'fixture: the compaction started on the wrong thread')
			assert.ok(started.compacting, 'fixture: confirming the dialog did not start a compaction')

			// Control: the compacting thread shows its own indicator.
			const onItself = await visibleCompactingText(s.page)
			t.diagnostic(`compacting thread, visible: ${JSON.stringify(onItself)}`)
			assert.ok(onItself.some(x => x.includes('Compacting')), 'the compacting thread must show its own indicator')

			// Switch while the summarisation is still in flight.
			await s.page.evaluate(async (id) => {
				await globalThis.__voidChatThreadService.switchToThread(id)
				await new Promise(r => setTimeout(r, 400))
			}, otherThreadId)
			const afterSwitch = await s.page.evaluate(() => ({
				current: globalThis.__voidChatThreadService.state.currentThreadId,
				compacting: Object.entries(globalThis.__voidChatThreadService.streamState).filter(([, v]) => v?.compacting).map(([k]) => k),
			}))
			t.diagnostic(`after switch: current=${afterSwitch.current} compacting=${JSON.stringify(afterSwitch.compacting)}`)
			assert.equal(afterSwitch.current, otherThreadId, 'fixture: the switch did not take effect')

			const onOther = await visibleCompactingText(s.page)
			t.diagnostic(`other thread, visible: ${JSON.stringify(onOther)}`)
			h.assertAbsent('another thread shows no compaction status', onOther.length === 0, { subject: true })

			// Let the compaction finish before teardown, so the scenario ends on a settled state.
			await h.completeStubbedLLM(s.page)
			await h.sleep(800)
		})
	})
})
