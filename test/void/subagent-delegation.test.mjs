/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Delegation (M2b).
//
// `run_subagent` hands a task to a child agent and returns a bounded report. The
// child is not a new kind of object: it is a `ThreadType` naming the thread that
// spawned it, run through the same `_runChatAgent` the parent uses. What is new is
// the two-sided guarantee this file exists to pin:
//
//   * anything the child needs, it inherits from the parent — its workspace, its
//     permission grant, its frozen system prompt — because a child that resolved
//     any of those from the window would be a different agent than the one asked
//     for, in a way nothing errors about;
//   * nothing the child *learns* crosses back. The parent receives a status, a
//     capped summary and the list of files the child changed; it never receives the
//     child's messages. That separation is the entire point of delegating, and it is
//     the one property an implementation can lose by accident — copying the child's
//     history into the parent would look like a feature.
//
// Measurements are through the real dispatch entry the agent loop uses,
// `_runToolCall`, so validation, the approval gate, dispatch, `stringOfResult` and
// the persisted tool row are all the production path. Only "the model asked for
// this tool" is supplied directly, which is the one thing a stubbed transport
// cannot honestly produce.
//
// `VOID_EXPECT` does not apply here: that inversion demonstrates a *fix* by failing
// against unpatched code, and there is no unpatched code to fail against — the tool
// does not exist on the previous build.
//
//   npm run test-void -- --only=subagent-delegation

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

const PARENT_MARKER = 'PARENT-MARKER: find out how many tools the agent has'
const CHILD_MARKER = 'CHILD-MARKER: count the tool names and report the number'
const CHILD_REPORT = 'CHILD-REPORT: the agent has twenty-five builtin tools.'
const SECOND_TASK = 'SECOND-MARKER: now check the count again'
const SECOND_REPORT = 'SECOND-REPORT: still twenty-five.'
const ALIAS = 'counter'

/// Fixed per-request cost, so the rollup arithmetic below is exact rather than
/// approximate. One request per turn: the stubbed model returns text and no tool calls.
const STUB_USAGE = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requestCount: 1 }

before(() => h.preflight())

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * True when the rendered chat contains `needle`.
 *
 * This asserts the row *exists*, not that it looks right: a builtin tool with no
 * entry in `builtinToolNameToComponent` renders nothing at all, so a delegation
 * would vanish from the transcript while every state assertion still passed. Read
 * the text rather than `innerText` because the harness hides the window.
 */
function domHas(page, needle) {
	return page.evaluate((n) => (document.body.textContent ?? '').includes(n), needle)
}

/** Puts one user message on the current thread through the real message store. */
async function seedCurrentThread(page, text) {
	return page.evaluate((message) => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		svc._storeMessageKey(id, 0, { role: 'user', content: message, displayContent: message, selections: null })
		svc._flushPendingThreadWrites()
		svc._loadedMessageThreadIds.delete(id)
		svc._ensureMessagesLoaded(id)
		return { id, messageCount: svc.state.allThreads[id].messages.length }
	}, text)
}

/**
 * Dispatches one delegation tool through `_runToolCall` — the same entry the agent
 * loop calls — and reports the parent's tool row, the child threads it can see, and
 * the parent's rolled-up spend.
 *
 * `threadId` is the *delegating* thread, which is the parent the first time and the
 * child in the depth scenario. `rawParams` is what the model would have emitted; the
 * `alias`/`task` shorthand exists because most scenarios call `run_subagent`.
 */
async function delegateFrom(page, { threadId, name = 'run_subagent', rawParams, alias, task, toolId }) {
	return page.evaluate(async ({ threadIdArg, toolName, params, id }) => {
		const svc = globalThis.__voidChatThreadService
		const delegatingThreadId = threadIdArg ?? svc.state.currentThreadId

		const res = await svc._runToolCall(delegatingThreadId, toolName, id, undefined, {
			preapproved: false,
			unvalidatedToolParams: params,
		})

		const textOf = (m) => m.displayContent ?? m.content ?? ''
		const delegating = svc.state.allThreads[delegatingThreadId]
		const row = delegating.messages.find(m => m.role === 'tool' && m.id === id)
		const children = Object.values(svc.state.allThreads).filter(x => x !== undefined && x.parentThreadId === delegatingThreadId)

		return {
			delegatingThreadId,
			interrupted: res.interrupted === true,
			toolRowType: row?.type,
			toolRowContent: row?.content ?? '',
			toolRowResult: row?.type === 'success' ? row.result : undefined,
			delegatingWorkspaceUri: delegating.workspaceUri,
			delegatingPermissionMode: delegating.permissionMode,
			delegatingMessages: delegating.messages.map(textOf).join('\n'),
			// The rolled-up figure, which is what a user reads off the token ring.
			delegatingTotalTokens: svc.cumulativeUsageThisThreadOfThreadId[delegatingThreadId]?.totalTokens ?? 0,
			children: children.map(c => ({
				id: c.id,
				alias: c.alias,
				parentThreadId: c.parentThreadId,
				parentToolCallId: c.parentToolCallId,
				delegationDepth: c.delegationDepth,
				workspaceUri: c.workspaceUri,
				permissionMode: c.permissionMode,
				resultStatus: c.resultStatus,
				resultSummary: c.resultSummary,
				totalTokens: svc.cumulativeUsageThisThreadOfThreadId[c.id]?.totalTokens ?? 0,
				roles: c.messages.map(m => m.role),
				text: c.messages.map(textOf).join('\n'),
			})),
		}
	}, { threadIdArg: threadId, toolName: name, params: rawParams ?? { alias, task }, id: toolId })
}

/** A launched app with a model selected and a stubbed transport, plus one parent message. */
async function scenario(page, { report = CHILD_REPORT } = {}) {
	await h.ensureModelSelection(page)
	await h.stubLLM(page, report, { usage: STUB_USAGE })
	const parent = await seedCurrentThread(page, PARENT_MARKER)
	assert.equal(parent.messageCount, 1, `the parent thread did not take its message (${parent.messageCount})`)
	return parent
}

describe('subagent delegation', () => {

	test('a delegated child runs in its own thread and reports back a summary', async (t) => {
		await h.withScenario('subagent/basic', async (s) => {
			const parent = await scenario(s.page)

			const out = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-basic' })
			for (const line of s.log.slice(-5)) t.diagnostic(line)
			t.diagnostic(`tool row: ${out.toolRowType}; child: ${out.children.map(c => `${c.alias}/${c.resultStatus}`).join(', ')}`)

			// Guards: one child was created and the tool completed, so every assertion
			// below is about a delegation that actually happened.
			assert.equal(out.children.length, 1, `expected exactly one child thread, got ${out.children.length}`)
			assert.equal(out.toolRowType, 'success', `the tool did not succeed: ${out.toolRowContent.slice(0, 400)}`)
			const child = out.children[0]
			const result = out.toolRowResult

			// The child is linked to the thread and the call that spawned it.
			assert.equal(child.parentThreadId, parent.id, 'the child does not name the thread that spawned it')
			assert.equal(child.parentToolCallId, 'call-basic', 'the child does not name the run_subagent call')
			assert.equal(child.alias, ALIAS)
			assert.equal(child.delegationDepth, 1)

			// Inheritance, copied not resolved: same workspace and same grant. A child
			// that fell back to the default read-only mode would be narrower than its
			// parent, which is the direction the design forbids moving by accident.
			assert.equal(child.workspaceUri, out.delegatingWorkspaceUri, 'the child resolved a different workspace than its parent')
			assert.equal(child.permissionMode, out.delegatingPermissionMode, 'the child changed permission grant')

			// The result contract: bounded fields only.
			assert.equal(result?.status, 'done', `the outcome status was ${result?.status}`)
			assert.equal(result?.childThreadId, child.id)
			assert.ok(result.summary.includes('CHILD-REPORT'), `the summary did not carry the child's report: ${result.summary.slice(0, 300)}`)
			assert.ok(Array.isArray(result.filesTouched), 'filesTouched is not an array')

			// The child really did receive and answer the task, so "the parent never saw
			// the transcript" is not the uninteresting case of a child that never ran.
			assert.deepEqual(child.roles, ['user', 'assistant'], `unexpected child transcript shape: ${child.roles.join(',')}`)
			assert.ok(child.text.includes('CHILD-MARKER'), 'the child never received its task')

			// Isolation. The parent's transcript carries the tool row and nothing of the
			// child's conversation: not its task, and not the child's message stream.
			assert.ok(
				!out.delegatingMessages.includes('CHILD-MARKER'),
				'the child\'s task text reached the parent thread — delegation is not isolated',
			)
			assert.ok(
				out.toolRowContent.includes('CHILD-REPORT'),
				`the rendered tool result did not carry the report: ${out.toolRowContent.slice(0, 300)}`,
			)

			// The child records how it ended, which is what makes its thread a record
			// rather than a transcript the parent happens to have dropped.
			assert.equal(child.resultStatus, 'done')
			assert.ok(child.resultSummary?.includes('CHILD-REPORT'), 'the child did not persist its own result summary')

			// And the row has to render at all. `builtinToolNameToComponent` is exhaustive
			// over builtin tool names, and a name with no entry renders nothing — leaving a
			// hole in the transcript exactly where the delegation happened. This asserts
			// presence, not appearance: the harness has no opinion on how it looks.
			const dom = await s.page.evaluate((alias) => {
				const text = document.body.textContent ?? ''
				return {
					hasParentMarker: text.includes('PARENT-MARKER'),
					hasDelegated: text.includes('Delegated'),
					hasAlias: text.includes(alias),
					tail: text.slice(-900).replace(/\s+/g, ' '),
				}
			}, ALIAS)
			t.diagnostic(`DOM: parentMarker=${dom.hasParentMarker} delegated=${dom.hasDelegated} alias=${dom.hasAlias}; tail: ${dom.tail}`)

			// Guard: the transcript is rendered at all, so a missing row is about the row and
			// not about the chat never having painted.
			assert.ok(dom.hasParentMarker, 'the transcript itself is not in the DOM — the fixture never painted')
			assert.ok(dom.hasDelegated, 'the delegation row did not render in the chat')
			assert.ok(dom.hasAlias, 'the delegation row did not show the child\'s alias')
		})
	})

	test('the child\'s own messages are never returned, only its report', async (t) => {
		await h.withScenario('subagent/isolation', async (s) => {
			const parent = await scenario(s.page)
			// A report that quotes nothing: if the child's task text appears in the
			// parent's tool result, it came from the transcript rather than the report.
			const out = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-isolation' })
			for (const line of s.log.slice(-5)) t.diagnostic(line)

			assert.equal(out.children.length, 1, 'the fixture did not create a child')
			const result = out.toolRowResult
			assert.ok(result, 'the tool produced no result')

			// The result object is what the parent's loop re-sends on every later
			// request, so a transcript hidden here would still be paid for on every turn.
			const serialized = JSON.stringify(result)
			assert.ok(!serialized.includes('CHILD-MARKER'), 'the child\'s task is in the result object the parent re-sends')
			assert.ok(result.summary.length <= 12_000, 'the summary was not capped')

			// And no field carries message-shaped objects: the contract has room for a
			// report, not for the child's history. Stated as a shape rather than as a
			// key list so a field added later cannot quietly become a transcript.
			for (const [key, value] of Object.entries(result)) {
				if (!Array.isArray(value)) continue
				assert.ok(
					!value.some(v => v !== null && typeof v === 'object' && 'role' in v),
					`result.${key} carries message objects — the child's transcript is crossing back`,
				)
			}

			// Control: the report itself did cross, so the assertions above are about
			// what is excluded rather than about an empty result.
			assert.ok(result.summary.includes('CHILD-REPORT'), `the report did not cross: ${result.summary.slice(0, 200)}`)
		})
	})

	test('a child cannot spawn a child', async (t) => {
		await h.withScenario('subagent/depth', async (s) => {
			const parent = await scenario(s.page)
			const first = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-depth-1' })
			assert.equal(first.children.length, 1, 'the first delegation did not create a child')
			const child = first.children[0]

			// Depth 2, refused. It has to be a tool error rather than a hang or a
			// silently-created grandchild: the model reads the error and does the work
			// itself, which is the behaviour a cap is for.
			const second = await delegateFrom(s.page, { threadId: child.id, alias: 'grandchild', task: 'CHILD-OF-CHILD', toolId: 'call-depth-2' })
			for (const line of s.log.slice(-5)) t.diagnostic(line)
			t.diagnostic(`depth-2 tool row: ${second.toolRowType}: ${second.toolRowContent.slice(0, 200)}`)

			assert.equal(second.toolRowType, 'tool_error', `depth 2 was not refused: ${second.toolRowType}`)
			assert.match(second.toolRowContent, /cannot create subagents/i, `the refusal did not explain itself: ${second.toolRowContent.slice(0, 300)}`)

			// Control: the refusal created nothing, so "no grandchild" is about the check
			// rather than about the child being unable to delegate for some other reason.
			assert.equal(second.children.length, 0, 'a refused delegation still created a child thread')
		})
	})

	test('send_message gives the same child a second turn, and its spend rolls up once per turn', async (t) => {
		await h.withScenario('subagent/continue', async (s) => {
			const parent = await scenario(s.page)
			const first = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-continue-1' })
			assert.equal(first.children.length, 1, 'the fixture did not create a child')
			const child = first.children[0]

			// Guards: the first turn cost what the fixture says, and it reached the parent.
			// Without them the arithmetic below would be about the stub's defaults.
			assert.equal(child.totalTokens, STUB_USAGE.totalTokens, `the child's first turn did not cost ${STUB_USAGE.totalTokens}`)
			assert.equal(first.delegatingTotalTokens, STUB_USAGE.totalTokens, 'the first turn was not rolled up into the parent')

			// A second turn with a different reply, so the assertions can tell the two apart.
			await h.stubLLM(s.page, SECOND_REPORT, { usage: STUB_USAGE })
			const second = await delegateFrom(s.page, {
				threadId: parent.id,
				name: 'send_message',
				rawParams: { alias: ALIAS, child_thread_id: null, message: SECOND_TASK },
				toolId: 'call-continue-2',
			})
			t.diagnostic(`after continue: row=${second.toolRowType}, parentTokens=${second.delegatingTotalTokens}`)

			assert.equal(second.toolRowType, 'success', `the continuation failed: ${second.toolRowContent.slice(0, 300)}`)
			assert.equal(second.children.length, 1, 'sending a message created a second child instead of continuing one')
			const continued = second.children[0]
			assert.equal(continued.id, child.id, 'the message reached a different child')

			// The same conversation, two entries longer — that is what "the same child"
			// means, and the first turn's reply has to still be there.
			assert.deepEqual(continued.roles, ['user', 'assistant', 'user', 'assistant'], `unexpected transcript shape: ${continued.roles.join(',')}`)
			assert.ok(continued.text.includes(SECOND_REPORT), 'the second reply is not in the child thread')
			assert.ok(continued.text.includes(CHILD_REPORT), 'the first turn was lost — the child did not keep its history')

			const result = second.toolRowResult
			assert.equal(result?.status, 'done', `the outcome status was ${result?.status}`)
			assert.ok(result.summary.includes(SECOND_REPORT), 'the parent did not receive the second reply')

			// Rolled up once per turn: twice the per-turn cost. Rolling up the child's
			// lifetime total each time instead would report three turns' worth here.
			assert.equal(second.delegatingTotalTokens, STUB_USAGE.totalTokens * 2, 'the child\'s spend was rolled up more or less than once per turn')

			// The continuation row renders, and its body renders: the second reply is the
			// text only the collapsible report puts in the DOM.
			assert.ok(await domHas(s.page, 'Replied to subagent'), 'the send_message row did not render')
			assert.ok(await domHas(s.page, SECOND_REPORT), 'the send_message row rendered without its report')
		})
	})

	test('send_message refuses a child that belongs to another thread', async (t) => {
		await h.withScenario('subagent/foreign', async (s) => {
			const parent = await scenario(s.page)
			const first = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-foreign-1' })
			assert.equal(first.children.length, 1, 'the fixture did not create a child')
			const childId = first.children[0].id

			// A second top-level thread, which is not this child's parent.
			const otherThreadId = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				svc.openNewThread()
				return svc.state.currentThreadId
			})
			assert.notEqual(otherThreadId, parent.id, 'the fixture did not open a second thread')

			// By id: resolution is scoped to the delegating thread's own children, so this
			// is a property of the lookup rather than a check somebody has to remember.
			const foreignById = await delegateFrom(s.page, {
				threadId: otherThreadId,
				name: 'send_message',
				rawParams: { child_thread_id: childId, alias: null, message: SECOND_TASK },
				toolId: 'call-foreign-2',
			})
			assert.equal(foreignById.toolRowType, 'tool_error', 'a thread was allowed to message another thread\'s child')
			assert.match(foreignById.toolRowContent, /no subagents/i, `the refusal did not say why: ${foreignById.toolRowContent.slice(0, 300)}`)

			// And by alias, since a name is not a secret.
			const foreignByAlias = await delegateFrom(s.page, {
				threadId: otherThreadId,
				name: 'send_message',
				rawParams: { alias: ALIAS, message: SECOND_TASK },
				toolId: 'call-foreign-3',
			})
			assert.equal(foreignByAlias.toolRowType, 'tool_error', 'an alias leaked across threads')

			// Control: the owner can still reach its own child, so the two refusals above
			// are about ownership rather than about send_message being broken.
			await h.stubLLM(s.page, SECOND_REPORT, { usage: STUB_USAGE })
			const owner = await delegateFrom(s.page, {
				threadId: parent.id,
				name: 'send_message',
				rawParams: { alias: ALIAS, message: SECOND_TASK },
				toolId: 'call-foreign-4',
			})
			assert.equal(owner.toolRowType, 'success', `the owner could not message its own child: ${owner.toolRowContent.slice(0, 300)}`)
		})
	})

	test('list_children recovers the handles a summarised conversation forgot', async (t) => {
		await h.withScenario('subagent/list', async (s) => {
			const parent = await scenario(s.page)

			// Before any delegation it still answers, rather than failing: "you have none"
			// is the fact a parent needs, and an error would read as the tool being broken.
			const empty = await delegateFrom(s.page, { threadId: parent.id, name: 'list_children', rawParams: {}, toolId: 'call-list-0' })
			assert.equal(empty.toolRowType, 'success', `list_children failed: ${empty.toolRowContent.slice(0, 300)}`)
			assert.equal(empty.toolRowResult?.children.length, 0, 'list_children invented a child')
			assert.match(empty.toolRowContent, /no subagents/i)

			const first = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-list-1' })
			assert.equal(first.children.length, 1, 'the fixture did not create a child')

			const listed = await delegateFrom(s.page, { threadId: parent.id, name: 'list_children', rawParams: {}, toolId: 'call-list-2' })
			const rows = listed.toolRowResult?.children ?? []
			assert.equal(rows.length, 1, `list_children reported ${rows.length} children`)
			assert.equal(rows[0].childThreadId, first.children[0].id, 'the listed id is not the child\'s')
			assert.equal(rows[0].alias, ALIAS)
			assert.equal(rows[0].resultStatus, 'done', `the listed status was ${rows[0].resultStatus}`)
			assert.equal(rows[0].running, false, 'a settled child was listed as running')
			// The task is what a model recognises the child by — an id is not.
			assert.ok(rows[0].task.includes('CHILD-MARKER'), `the listed task did not identify the child: ${rows[0].task}`)

			// The row renders *and* its body does: the alias inside the list is text only
			// the collapsible body puts in the DOM, so its presence proves the list drew.
			assert.ok(await domHas(s.page, 'Listed subagents'), 'the list_children row did not render')
			assert.ok(await domHas(s.page, ALIAS), 'the list_children row rendered without its children')
		})
	})

	test('a child thread and its linkage survive a restart', async (t) => {
		// Two sessions on one profile: the point is that the child is durable like any
		// other thread, because a delegation whose result cannot be read again is not a
		// record of what was done. The index is the thing being tested — a child left
		// out of it is written to disk and never reloaded, which is the quiet way this
		// could ship broken.
		const dirs = h.createProfile('subagent/restart')
		const first = await h.launchVoid(dirs)
		let childId
		let parentId
		let stored
		try {
			const parent = await scenario(first.page)
			parentId = parent.id
			const out = await delegateFrom(first.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-restart' })
			assert.equal(out.children.length, 1, 'the fixture did not create a child')
			childId = out.children[0].id

			await first.page.evaluate(() => globalThis.__voidChatThreadService._flushPendingThreadWrites())
			await sleep(300)
		} finally {
			await first.close()
		}

		// Read from the profile after the app is gone: this is what the next launch
		// actually has, rather than what the closing session believed it wrote.
		const storedRaw = first.readThread(childId)
		assert.ok(storedRaw, 'the child thread has no storage key — nothing was persisted')
		stored = JSON.parse(storedRaw)
		assert.equal(stored.parentThreadId, parentId, 'the stored blob lost the child\'s parent')
		assert.equal(stored.alias, ALIAS, 'the stored blob lost the alias')
		assert.equal(stored.delegationDepth, 1, 'the stored blob lost the depth')
		assert.equal(stored.resultStatus, 'done', 'the stored blob lost the recorded status')

		const second = await h.launchVoid(dirs)
		try {
			const restored = await second.page.evaluate((id) => {
				const thread = globalThis.__voidChatThreadService.state.allThreads[id]
				return thread === undefined ? null : {
					alias: thread.alias,
					parentThreadId: thread.parentThreadId,
					delegationDepth: thread.delegationDepth,
					resultStatus: thread.resultStatus,
					hasSummary: !!thread.resultSummary,
				}
			}, childId)
			t.diagnostic(`restored after restart: ${JSON.stringify(restored)}`)

			assert.ok(restored, 'the child thread was not reloaded at all — it is not in the thread index')
			assert.equal(restored.alias, ALIAS, 'the alias did not survive the restart')
			assert.equal(restored.parentThreadId, parentId, 'the parent link did not survive the restart')
			assert.equal(restored.delegationDepth, 1, 'the depth did not survive the restart')
			assert.equal(restored.resultStatus, 'done', 'the child\'s recorded status did not survive the restart')
			assert.ok(restored.hasSummary, 'the child\'s summary did not survive the restart')
		} finally {
			await second.close()
		}
	})
})
