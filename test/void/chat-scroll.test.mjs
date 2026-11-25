/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Transcript scrolling. The transcript follows the bottom only while the reader
// is at the bottom; anything that happens to content while they are above it
// must leave the viewport where it is.
//
// It did not: "at the bottom" was a 100 px distance check, and three paths scroll
// to the bottom whenever it holds — the streaming bubble (every token), the
// content ResizeObserver (any resize, e.g. a code block swapping to Monaco), and
// the message-count layout effect (an appended row). So the first 100 px of an
// upward scroll was a dead zone: scroll up from the last message and the next
// token or lazy block pulled you back. The scenarios below scroll 50 px up — the
// measured case — then grow the content the way a lazy block does.
//
//   npm run test-void -- --only=chat-scroll

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

/** The visible transcript's scroll geometry. */
const geometry = (page) => page.evaluate(() => {
	const content = [...document.querySelectorAll('[data-virtualized-content]')]
		.find((c) => c.parentElement?.parentElement?.clientHeight > 0)
	if (!content) return null
	const scroller = content.parentElement.parentElement
	return {
		scrollTop: scroller.scrollTop,
		scrollHeight: scroller.scrollHeight,
		clientHeight: scroller.clientHeight,
		distance: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
		contentHeight: content.offsetHeight,
	}
})

/** Puts the viewport `px` above the bottom. */
const scrollToDistance = (page, px) => page.evaluate((distance) => {
	const content = [...document.querySelectorAll('[data-virtualized-content]')]
		.find((c) => c.parentElement?.parentElement?.clientHeight > 0)
	const scroller = content.parentElement.parentElement
	scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - distance
}, px)

/**
 * Grows the transcript the way lazy content does. ResizeObserver observes the
 * content box, so a child with a real height is what fires it — the same shape as
 * a LazyBlockCode→Monaco swap or a mounted image. Padding on the wrapper would
 * not fire it (measured).
 */
const growContent = (page, height) => page.evaluate((px) => {
	const content = [...document.querySelectorAll('[data-virtualized-content]')]
		.find((c) => c.parentElement?.parentElement?.clientHeight > 0)
	const grown = document.createElement('div')
	grown.style.height = `${px}px`
	grown.setAttribute('data-test-content-growth', '1')
	content.appendChild(grown)
}, height)

describe('chat transcript scrolling', () => {

	test('content growth does not move a reader who scrolled up', async (t) => {
		await h.withScenario('chat-scroll/escape', async (s) => {
			const page = s.page
			await h.seedTestThread(page, 8)
			await h.sleep(800)

			const initial = await geometry(page)
			t.diagnostic(`initial ${JSON.stringify(initial)}`)
			assert.ok(initial, 'fixture: no visible transcript')
			assert.ok(initial.scrollHeight > initial.clientHeight + 200, 'fixture: the transcript must be scrollable')
			assert.ok(initial.distance < 2, 'fixture: the transcript must land at the bottom')

			// 50 px up: inside the window that used to count as "at the bottom".
			await scrollToDistance(page, 50)
			await h.sleep(300)
			const scrolledUp = await geometry(page)
			t.diagnostic(`after scrolling up 50 ${JSON.stringify(scrolledUp)}`)
			assert.ok(scrolledUp.distance > 40 && scrolledUp.distance < 60, 'fixture: the reader must be 50 px up')

			// Content grows, the way a lazy block or an appended row does.
			await growContent(page, 400)
			await h.sleep(500)
			const after = await geometry(page)
			t.diagnostic(`after growth ${JSON.stringify(after)}`)

			const keptPosition = Math.abs(after.scrollTop - scrolledUp.scrollTop) < 5 && after.distance > 300
			const wanted = h.expectedPersistence()
			assert.equal(
				keptPosition, wanted,
				`content growth must not move the viewport while the reader is above the bottom (scrollTop ${scrolledUp.scrollTop} -> ${after.scrollTop}, distance ${scrolledUp.distance} -> ${after.distance})`,
			)
		})
	})

	test('content growth keeps a reader who is at the bottom there', async (t) => {
		await h.withScenario('chat-scroll/follow', async (s) => {
			const page = s.page
			await h.seedTestThread(page, 8)
			await h.sleep(800)

			const initial = await geometry(page)
			assert.ok(initial, 'fixture: no visible transcript')
			assert.ok(initial.distance < 2, 'fixture: the transcript must land at the bottom')

			await growContent(page, 400)
			await h.sleep(500)
			const after = await geometry(page)
			t.diagnostic(`after growth at the bottom ${JSON.stringify(after)}`)

			// Control, in both directions: the pin must still follow content while
			// the reader is at the bottom.
			assert.ok(after.distance < 5, `a reader at the bottom must be kept there (distance ${after.distance})`)
		})
	})
})
