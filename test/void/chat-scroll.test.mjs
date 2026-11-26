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

/** Same growth, but above the viewport: a block the reader has already passed. */
const prependContent = (page, height) => page.evaluate((px) => {
	const content = [...document.querySelectorAll('[data-virtualized-content]')]
		.find((c) => c.parentElement?.parentElement?.clientHeight > 0)
	const grown = document.createElement('div')
	grown.style.height = `${px}px`
	grown.setAttribute('data-test-content-growth', '1')
	content.insertBefore(grown, content.firstChild)
}, height)

/** Makes the last message several viewports tall ("the latest chat is a little longer"). */
const inflateLastMessage = (page) => page.evaluate(() => {
	const chat = globalThis.__voidChatThreadService
	const id = chat.state.currentThreadId
	const thread = chat.state.allThreads[id]
	const messages = thread.messages.slice()
	const lastIdx = messages.length - 1
	const last = messages[lastIdx]
	if (last.role !== 'assistant') return
	const extra = Array.from({ length: 40 }, (_, i) =>
		`Extra paragraph ${i}. ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(3)}`).join('\n\n')
	messages[lastIdx] = { ...last, displayContent: last.displayContent + '\n\n' + extra }
	chat._setState({ allThreads: { ...chat.state.allThreads, [id]: { ...thread, messages } } })
})

/** Scrolls to `top` and tags the first message crossing the viewport top. */
const sitAt = (page, top) => page.evaluate((scrollTop) => {
	const content = [...document.querySelectorAll('[data-virtualized-content]')]
		.find((c) => c.parentElement?.parentElement?.clientHeight > 0)
	const scroller = content.parentElement.parentElement
	scroller.scrollTop = scrollTop
	const containerTop = scroller.getBoundingClientRect().top
	for (const el of content.querySelectorAll('[data-probe-ref]')) el.removeAttribute('data-probe-ref')
	let ref = null
	for (const child of content.children) {
		const rect = child.getBoundingClientRect()
		if (rect.bottom > containerTop + 4) { ref = child; break }
	}
	if (ref) ref.setAttribute('data-probe-ref', '1')
	return ref !== null
}, top)

/** The tagged message's offset from the viewport top, plus the scroll geometry. */
const readReference = (page) => page.evaluate(() => {
	const content = [...document.querySelectorAll('[data-virtualized-content]')]
		.find((c) => c.parentElement?.parentElement?.clientHeight > 0)
	const scroller = content.parentElement.parentElement
	const containerTop = scroller.getBoundingClientRect().top
	const ref = content.querySelector('[data-probe-ref]')
	return {
		scrollTop: Math.round(scroller.scrollTop),
		refTop: ref ? Math.round(ref.getBoundingClientRect().top - containerTop) : null,
		contentHeight: content.offsetHeight,
		clientHeight: scroller.clientHeight,
	}
})

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

	test('content growing above the viewport keeps the reading position', async (t) => {
		await h.withScenario('chat-scroll/anchor', async (s) => {
			const page = s.page
			await h.seedTestThread(page, 10)
			await h.sleep(800)
			await inflateLastMessage(page)
			await h.sleep(800)

			await sitAt(page, 2000)
			await h.sleep(400)
			const settled = await readReference(page)
			t.diagnostic(`before ${JSON.stringify(settled)}`)
			assert.ok(settled.refTop !== null, 'fixture: a message must cross the viewport top')
			assert.ok(settled.contentHeight > settled.clientHeight * 4, 'fixture: the transcript must be taller than four viewports')

			// A block above the viewport finishes rendering and grows 400 px. With
			// native anchoring off and no compensation, the message under the reader
			// slides down by the growth: the view shows earlier content.
			await prependContent(page, 400)
			await h.sleep(500)
			const above = await readReference(page)
			t.diagnostic(`after growth above ${JSON.stringify(above)}`)

			const kept = Math.abs(above.refTop - settled.refTop) < 8
			const wanted = h.expectedPersistence()
			assert.equal(
				kept, wanted,
				`content growth above the viewport must not move the reading position (refTop ${settled.refTop} -> ${above.refTop}, scrollTop ${settled.scrollTop} -> ${above.scrollTop})`,
			)

			// Control, in both directions: growth below the viewport must not move
			// the reading position either — the case the old code was right to leave
			// alone, and the one an over-eager compensation would break.
			await growContent(page, 400)
			await h.sleep(500)
			const below = await readReference(page)
			t.diagnostic(`after growth below ${JSON.stringify(below)}`)
			assert.ok(
				Math.abs(below.refTop - above.refTop) < 8,
				`control: growth below the viewport must not move the reading position (refTop ${above.refTop} -> ${below.refTop})`,
			)
		})
	})
})
