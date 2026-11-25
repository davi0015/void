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
 * Answers the stub's next held request, waiting until there is one.
 *
 * `completeStubbedLLM` returns false when nothing is held, and a held request only exists
 * once the loop has reached it — which is a render or a tool run later than the call site
 * that wants to answer it. Firing once and ignoring the answer hangs the child until the
 * scenario's page is torn down.
 */
async function answerNextRequest(page) {
	for (let i = 0; i < 120; i++) {
		if (await h.completeStubbedLLM(page)) return true
		await sleep(100)
	}
	return false
}

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
	return page.evaluate(async (message) => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		// Since 1.5.0 a thread's messages are a log file the main process owns, and
		// `_storeMessageKey` appends without touching the in-memory array. The old
		// helper wrote a key and expected `messages` to be there synchronously; this
		// awaits the append and reloads, which is what the count below needs.
		await svc.ensureMessagesLoaded(id)
		const before = svc.state.allThreads[id].messages.length
		await svc._threadStore.call('append', {
			threadId: id,
			records: [{ i: before, m: { role: 'user', content: message, displayContent: message, selections: null } }],
		})
		svc._loadedMessageThreadIds.delete(id)
		await svc.ensureMessagesLoaded(id)
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

		// Since M3 a spawn returns a handle, so the fixture spawns and then collects: the
		// report still reaches the parent, just through the join rather than the call.
		const spawn = await svc._runToolCall(delegatingThreadId, toolName, id, undefined, {
			preapproved: false,
			unvalidatedToolParams: params,
		})
		let res = spawn
		if (toolName === 'run_subagent') {
			const handle = svc.state.allThreads[delegatingThreadId].messages.find(m => m.role === 'tool' && m.id === id)?.result
			if (handle?.childThreadId) {
				res = await svc._runToolCall(delegatingThreadId, 'collect_subagent', id + '-collect', undefined, {
					preapproved: false,
					unvalidatedToolParams: { children: [handle.childThreadId], timeout_seconds: 60 },
				})
			}
		}

		const textOf = (m) => m.displayContent ?? m.content ?? ''
		const delegating = svc.state.allThreads[delegatingThreadId]
		const row = delegating.messages.find(m => m.role === 'tool' && m.id === id)
		// What the parent actually learns: the collected child, not the spawn handle.
		const collectRow = delegating.messages.find(m => m.role === 'tool' && m.id === id + '-collect')
		const collected = collectRow?.type === 'success' ? collectRow.result?.results?.[0] : undefined
		const children = Object.values(svc.state.allThreads).filter(x => x !== undefined && x.parentThreadId === delegatingThreadId)

		return {
			delegatingThreadId,
			interrupted: res.interrupted === true,
			toolRowType: row?.type,
			toolRowContent: row?.content ?? '',
			toolRowResult: collected ?? (row?.type === 'success' ? row.result : undefined),
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
				frozenAiInstructions: c.frozenAiInstructions,
				totalTokens: svc.cumulativeUsageThisThreadOfThreadId[c.id]?.totalTokens ?? 0,
				roles: c.messages.map(m => m.role),
				text: c.messages.map(textOf).join('\n'),
			})),
		}
	}, { threadIdArg: threadId, toolName: name, params: rawParams ?? { alias, task }, id: toolId })
}

/**
 * A launched app with a model selected and a stubbed transport, plus one parent message.
 *
 * The parent is put in `orchestrator` mode first: that is the only mode whose tool list
 * contains delegation — `agent` is every builtin tool *except* `run_subagent` and its two
 * companions — and these scenarios drive the tool by hand, so without this the product
 * would sit in a mode where a user could never reach what the test exercises. Whether the
 * gate itself is right is the node tier's job (`ToolAvailability`); this only makes the
 * app's state match the feature under test.
 */
async function scenario(page, { report = CHILD_REPORT } = {}) {
	await h.ensureModelSelection(page)
	// The setting is read back in a bounded loop rather than once: a write can be
	// visible, reverted by a storage echo, and re-applied inside the first ~50 ms
	// (measured: `{false}` at 0 ms, `{true}` at 50 ms, twice on this machine). Reading it
	// once makes this fixture flake about once per suite run, on a scenario unrelated to
	// the write. The transient itself is a separate question and is not being papered
	// over here — this helper's job is to put the app in a state, not to test the write.
	const mode = await page.evaluate(async () => {
		const svc = globalThis.__voidChatThreadService
		// Wait for the settings service to finish reading storage before writing to it. A
		// write that lands first is overwritten by the initial read, which is a fixture
		// racing startup rather than a product bug — and it fails here as "the app is in
		// agent mode", which reads like a gate problem and is not.
		await svc._settingsService.waitForInitState
		await svc._settingsService.setGlobalSetting('chatMode', 'orchestrator')
		for (let i = 0; i < 40; i++) {
			const mode = svc._settingsService.state.globalSettings.chatMode
			if (mode === 'orchestrator') return mode
			await new Promise(r => setTimeout(r, 50))
		}
		return svc._settingsService.state.globalSettings.chatMode
	})
	assert.equal(mode, 'orchestrator', `the app is in "${mode}" mode, so delegation would not be offered to a user`)
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

			// The child knows what it is. Nothing else in the inherited prompt says the reader
			// is an agent that sees only the final message, and a child that believes it is
			// talking to a user writes a plan and stops, or asks a question nobody answers.
			assert.ok(child.frozenAiInstructions, 'the child has no frozen prompt to carry the framing')
			assert.match(child.frozenAiInstructions, /subagent/i, 'the child was never told it is a subagent')
			assert.ok(child.frozenAiInstructions.includes(ALIAS), 'the child was not told its own name')

			// The result contract: bounded fields only.
			assert.equal(result?.status, 'done', `the outcome status was ${result?.status}`)
			assert.equal(result?.childThreadId, child.id)
			// Exactly the child's final message, not a concatenation of its turns: what the
			// parent receives is one report, and the whole of it is the last thing the child said.
			assert.equal(result.summary, CHILD_REPORT, `the summary is not the child's final message: ${result.summary.slice(0, 300)}`)
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
			// Since M3 the spawn's row is a handle and the report renders on the collect row.
			// Both halves are asserted: the handle names the child, the join carries the words.
			assert.ok(
				out.toolRowContent.includes(child.id),
				`the spawn row is not a handle naming the child: ${out.toolRowContent.slice(0, 300)}`,
			)
			assert.equal(result.summary, CHILD_REPORT, 'the collected report was not what the child wrote')

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
				// Titles are spans; `body.textContent` also carries the workbench's stylesheet,
				// which is why the short-span list is the useful diagnostic here rather than a
				// tail of the page text.
				const spans = [...document.querySelectorAll('span')]
					.map(el => (el.textContent ?? '').trim())
					.filter(t => t.length > 0 && t.length < 48)
				return {
					hasParentMarker: text.includes('PARENT-MARKER'),
					hasDelegated: spans.includes('Delegated'),
					hasCollected: spans.includes('Collected subagents'),
					hasAlias: text.includes(alias),
					spans: spans.slice(0, 24),
				}
			}, ALIAS)
			t.diagnostic(`DOM: parentMarker=${dom.hasParentMarker} delegated=${dom.hasDelegated} collected=${dom.hasCollected} alias=${dom.hasAlias}`)
			t.diagnostic(`short spans: ${JSON.stringify(dom.spans)}`)

			// Guard: the transcript is rendered at all, so a missing row is about the row and
			// not about the chat never having painted.
			assert.ok(dom.hasParentMarker, 'the transcript itself is not in the DOM — the fixture never painted')
			assert.ok(dom.hasDelegated, 'the delegation row did not render in the chat: ' + dom.tail)
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

	test('the parent reads the child\'s <report> block, verbatim and untrimmed', async (t) => {
		await h.withScenario('subagent/report-block', async (s) => {
			const parent = await scenario(s.page)

			// Longer than the old 12,000-character cap on purpose: "not trimmed" is the claim,
			// so the fixture is a report that would have been cut.
			const REPORT = `REPORT-MARKER ${'x'.repeat(13_000)}`
			// The child thinks out loud outside the block, which is the whole reason the block
			// exists: the parent should not pay for its working.
			const CHILD_SAYS = `Working notes the parent should not read.\n\n<report>\n${REPORT}\n</report>\n\nThat is everything.`
			await h.stubLLM(s.page, CHILD_SAYS, { usage: STUB_USAGE })

			const out = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-report-1' })
			for (const line of s.log.slice(-5)) t.diagnostic(line)

			assert.equal(out.toolRowType, 'success', `the delegation failed: ${out.toolRowContent.slice(0, 300)}`)
			assert.equal(out.children.length, 1, 'the fixture did not create a child')
			const child = out.children[0]

			// Guard: the child's own transcript really does hold the prose *and* the block, so
			// "the notes were excluded" is a distinction rather than the only text there was.
			assert.ok(child.text.includes('Working notes'), 'the child never produced prose outside the block')
			assert.ok(child.text.includes('That is everything.'), 'the child never produced a closing line')

			const result = out.toolRowResult
			assert.equal(result.summary, REPORT, 'the parent did not receive exactly the block contents')
			assert.ok(result.summary.length > 12_000, `the report was trimmed to ${result.summary.length} characters`)
			assert.equal(result.summary.includes('Working notes'), false, 'the child\'s working notes leaked into the report')
		})
	})

	test('a child that used a tool still reports through the block', async (t) => {
		await h.withScenario('subagent/report-after-tool', async (s) => {
			const parent = await scenario(s.page)

			const REPORT = 'REPORT-MARKER: the workspace root has one entry.'
			// The child calls a real tool on its first request, then answers. A delegated run
			// that takes more than one request is the ordinary case, and the block has to be
			// read from the *final* message rather than the first one.
			await h.stubLLM(s.page, `Looked around.\n<report>\n${REPORT}\n</report>`, {
				usage: STUB_USAGE,
				toolCalls: [{ name: 'ls_dir', rawParams: { uri: '.', page_number: 1 } }],
			})

			const out = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-report-2' })
			assert.equal(out.children.length, 1, 'the fixture did not create a child')
			const child = out.children[0]

			// Guard: the tool really ran inside the child, so this is a multi-step run rather
			// than the single-request case above with extra assertions.
			const toolRowStatus = await s.page.evaluate((id) => {
				const svc = globalThis.__voidChatThreadService
				const row = svc.state.allThreads[id]?.messages.find(m => m.role === 'tool' && m.name === 'ls_dir')
				return row?.type ?? null
			}, child.id)
			t.diagnostic(`child tool row: ${toolRowStatus}`)
			assert.equal(toolRowStatus, 'success', 'the child never ran the tool, so the multi-step path is untested')

			assert.equal(out.toolRowResult.summary, REPORT, 'the block from the final message was not what the parent received')
		})
	})


	test('a subagent\'s conversation opens from the row and says where it came from', async (t) => {
		await h.withScenario('subagent/transcript', async (s) => {
			const parent = await scenario(s.page)
			const out = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-open-1' })
			assert.equal(out.children.length, 1, 'the fixture did not create a child')
			const childId = out.children[0].id

			// The report arrives closed. The row is the summary — a status, the name, the way
			// in — and the report is what a reader opens when they want it. Measured as height
			// rather than as text: the body is a collapsible that renders its children and hides
			// them with `max-h-0`, so presence alone would pass for a body on screen. Since M3
			// the reports render on the collect row, not on the spawn row.
			const measured = await s.page.evaluate(() => {
				const title = [...document.querySelectorAll('span')]
					.find(el => (el.textContent ?? '').trim() === 'Subagent reports')
				if (!title) return { found: false, height: -1 }
				// The body is the header row's next sibling; querying by class would depend on
				// the scoped Tailwind names this build emits.
				const header = title.closest('div')
				const body = header?.nextElementSibling ?? null
				return { found: true, hasBody: !!body, height: body ? Math.round(body.getBoundingClientRect().height) : -1 }
			})
			t.diagnostic(`reports body: ${JSON.stringify(measured)}`)
			assert.equal(measured.found, true, 'the collect row has no reports section')
			assert.equal(measured.height, 0, `the report arrived expanded (${measured.height}px)`)

			// The way in is on the row itself, so closing the body does not close the door.
			assert.ok(await domHas(s.page, 'View'), 'the delegation row has no way into the child')

			// Guard: spawning is the agent's act, so a child must not arrive as a tab. A
			// fan-out that pinned every child is the "strip of tabs" collapse.
			const before = await s.page.evaluate(() => [...globalThis.__voidChatThreadService.state.pinnedThreadIds])
			assert.equal(before.includes(childId), false, 'the child was pinned at spawn')

			// The row's own control, clicked the way a user clicks it. It must *not* pin: the
			// strip is the user's own list of threads, and a preview of the agent's delegate does
			// not belong in it — that is the supervision collapse, one tab per child.
			assert.ok(await domHas(s.page, 'View'), 'the delegation row has no View control')
			const opened = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const control = [...document.querySelectorAll('span')].find(el => (el.textContent ?? '').trim() === 'View')
				if (!control) return { clicked: false, currentThreadId: svc.state.currentThreadId, pinned: [...svc.state.pinnedThreadIds] }
				control.click()
				await new Promise(r => setTimeout(r, 300))
				return { clicked: true, currentThreadId: svc.state.currentThreadId, pinned: [...svc.state.pinnedThreadIds] }
			})
			assert.equal(opened.clicked, true, 'the View control could not be found to click')

			assert.equal(opened.currentThreadId, childId, 'the link did not switch to the child')
			assert.equal(opened.pinned.includes(childId), false, 'opening a child pinned it — it would sit in the tab strip for good')
			// Guard: the parent keeps its tab, so "the child is not in the strip" is not the
			// uninteresting case of a strip with nothing in it.
			assert.equal(opened.pinned.includes(parent.id), true, 'the parent lost its tab')

			// The banner: a badge, the name the parent coined, and a way back.
			assert.ok(await domHas(s.page, 'Subagent'), 'the child banner did not render')
			assert.ok(await domHas(s.page, ALIAS), 'the child banner did not name the subagent')
			assert.ok(await domHas(s.page, 'Back to parent'), 'the child banner has no way back')

			// And the conversation itself — the thing the whole feature exists to let you
			// audit without costing the parent any context.
			assert.ok(await domHas(s.page, CHILD_REPORT), 'the child\'s own conversation did not render')

			// Back to the parent, the way the banner does it. The switch is awaited: since
			// 1.5.0 it loads the target's messages before it publishes `currentThreadId`,
			// so reading that immediately after the call still sees the child.
			const back = await s.page.evaluate(async (id) => {
				const svc = globalThis.__voidChatThreadService
				await svc.switchToThread(id)
				return svc.state.currentThreadId
			}, parent.id)
			assert.equal(back, parent.id, 'could not return to the parent')
			assert.equal(await domHas(s.page, 'Back to parent'), false, 'the child banner still renders on the parent thread')
		})
	})

	test('a child that pauses and resumes announces nothing, while the parent still announces', async (t) => {
		await h.withScenario('subagent/no-notify', async (s) => {
			const parent = await scenario(s.page)

			// Notifications default to off on Windows (`notificationsEnabled: isMacintosh`),
			// so a scenario that never turns them on records nothing and its "the child said
			// nothing" assertion holds for the wrong reason. The control at the end of this
			// test is what caught that on the first run; this is the setup it needs. Read the
			// values back rather than assuming the write landed — a guard that silently did
			// nothing is the failure mode this whole test is about.
			// Notifications are off by default on Windows, and turning them on through the
			// settings path is wrong for this test twice over: that write is a whole-blob
			// store whose timing is unreliable under this fixture, and it is not the subject.
			// The subject is the guard in `_wrapRunAgentToNotify`, which is decided before
			// `_shouldNotify` is ever consulted. So the fixture states the premise — "this
			// user has finish notifications on" — and the control proves it took.
			const fixture = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				svc._shouldNotify = () => true
				return typeof svc._shouldNotify === 'function'
			})
			assert.equal(fixture, true, 'could not turn notifications on for the fixture')

			// The child's first request asks for a command, which the default settings do
			// not auto-approve, so its run parks at `awaiting_user` and `run_subagent`
			// returns 'blocked'. Approving it afterwards resumes the child through the
			// approval entry rather than the send entry a spawn uses — and that second
			// entry used to announce the child as though it were a chat the user opened.
			await h.stubLLM(s.page, CHILD_REPORT, {
				usage: STUB_USAGE,
				toolCalls: [{ name: 'run_command', rawParams: { command: 'echo subagent-approval' } }],
			})

			// Record every notification the workbench would show, from here on. The native
			// host service is a `ProxyChannel` proxy — its methods are get traps, so assigning
			// over `showNotification` silently does nothing. The field on the chat service is
			// a plain property, so the whole service is replaced instead, and the recorder
			// proves itself before the scenario depends on it.
			const recorder = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				globalThis.__voidNotifications = []
				const real = svc._nativeHostService
				const fake = {
					windowId: real?.windowId,
					showNotification: (n) => { globalThis.__voidNotifications.push(n) },
					dismissNotification: () => { },
					onNotificationAction: () => ({ dispose() { } }),
				}
				svc._nativeHostService = fake
				fake.showNotification({ id: 'probe-setup' })
				return {
					proved: (globalThis.__voidNotifications ?? []).some(n => n.id === 'probe-setup'),
					replaced: svc._nativeHostService === fake,
					realType: real?.constructor?.name ?? null,
				}
			})
			t.diagnostic(`notification recorder: ${JSON.stringify(recorder)}`)
			assert.equal(recorder.proved, true, `could not instrument notifications: ${JSON.stringify(recorder)}`)

			const out = await delegateFrom(s.page, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER, toolId: 'call-blocked' })
			assert.equal(out.children.length, 1, 'the fixture did not create a child')
			const childId = out.children[0].id

			// Guard: the child really parked. Without this the scenario asserts against the
			// ordinary path, which was already suppressed, and would pass for the wrong reason.
			const parked = await s.page.evaluate((id) => globalThis.__voidChatThreadService.streamState[id]?.isRunning, childId)
			t.diagnostic(`child stream state after the blocked spawn: ${parked}`)
			assert.equal(out.toolRowResult?.status, 'blocked', `run_subagent returned "${out.toolRowResult?.status}" instead of blocking`)
			assert.equal(parked, 'awaiting_user', `the child did not park for approval (${parked}), so the resume path is untested`)

			// Approve on the child's own thread, the way its transcript button does, and wait
			// for the resumed run to settle — the notification fires when it does.
			const approved = await s.page.evaluate(async (id) => {
				const svc = globalThis.__voidChatThreadService
				const pending = svc.state.allThreads[id].messages.filter(m => m.role === 'tool' && m.type === 'tool_request')
				if (pending.length === 0) return { ok: false, reason: 'the child has no pending tool to approve' }
				svc.approveToolRequest(id, pending[pending.length - 1].id)
				for (let i = 0; i < 240; i++) {
					await new Promise(r => setTimeout(r, 50))
					if (svc.streamState[id]?.isRunning === undefined) return { ok: true }
				}
				return { ok: false, reason: `the resumed child never settled (${svc.streamState[id]?.isRunning})` }
			}, childId)
			t.diagnostic(`resume: ${JSON.stringify(approved)}`)
			assert.equal(approved.ok, true, `the child did not finish after approval: ${approved.reason}`)

			// The assertion. A child has no tab to raise and no chat waiting behind it, so it
			// must not announce *its own finish*. Approval notices are a different question —
			// a child parked at `awaiting_user` is one the user may have to go and unblock —
			// so they are reported but not asserted on here.
			const allNotes = await s.page.evaluate(() => (globalThis.__voidNotifications ?? []).map(n => String(n.id)))
			t.diagnostic(`notifications so far: ${JSON.stringify(allNotes)}`)
			const childNotes = allNotes.filter(n => n === `done:${childId}` || n === `error:${childId}`)
			assert.deepEqual(childNotes, [], `the child announced itself: ${childNotes.join(', ')}`)

			// Control: the same recorder sees a top-level thread announce. Without it the
			// assertion above could pass because nothing was recorded at all. The current
			// thread is moved to the child first, so the parent is unambiguously a thread the
			// user is not looking at — that is the condition the notification exists for, and
			// leaving it to window focus would make the control depend on the harness.
			const control = await s.page.evaluate(async ({ parentId, childId }) => {
				const svc = globalThis.__voidChatThreadService
				await svc.switchToThread(childId)
				await svc.addUserMessageAndStreamResponse({ userMessage: 'control turn', threadId: parentId })
				const ids = () => (globalThis.__voidNotifications ?? []).map(n => String(n.id))
				let found = false
				for (let i = 0; i < 160; i++) {
					await new Promise(r => setTimeout(r, 50))
					if (ids().some(x => x.startsWith('done:' + parentId))) { found = true; break }
				}
				// Whether or not the parent announced, prove the recorder itself works: a
				// patch that never took would also produce an empty list, and that would be
				// indistinguishable from a suppressed child.
				svc._nativeHostService.showNotification({ id: 'probe-direct' })
				const g = svc._settingsService.state.globalSettings
				return {
					found,
					ids: ids(),
					settings: { notificationsEnabled: g.notificationsEnabled, notifyOnDone: g.notifyOnDone },
					streamState: svc.streamState[parentId]?.isRunning ?? null,
					error: svc.streamState[parentId]?.error?.message ?? null,
				}
			}, { parentId: parent.id, childId })
			t.diagnostic(`control: ${JSON.stringify(control)}`)
			assert.equal(control.ids.includes('probe-direct'), true, 'the notification recorder never took, so no claim about the child can be made')
			assert.equal(control.found, true, `the parent did not announce (${JSON.stringify(control)}), so the recorder proves nothing about the child`)
		})
	})

	test('a collect with no timeout budget reports running instead of waiting', async (t) => {
		await h.withScenario('subagent/collect-zero', async (s) => {
			const parent = await scenario(s.page)
			// The child's first request is held open, so it is genuinely still running.
			await h.stubLLM(s.page, CHILD_REPORT, { usage: STUB_USAGE, hang: true })

			const spawned = await s.page.evaluate(async ({ threadId, alias, task }) => {
				const svc = globalThis.__voidChatThreadService
				await svc._runToolCall(threadId, 'run_subagent', 'call-zero-spawn', undefined, {
					preapproved: false,
					unvalidatedToolParams: { alias, task },
				})
				const row = svc.state.allThreads[threadId].messages.find(m => m.role === 'tool' && m.id === 'call-zero-spawn')
				return row?.result ?? null
			}, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER })
			assert.ok(spawned?.childThreadId, 'the spawn returned no handle')
			t.diagnostic(`handle: ${JSON.stringify(spawned)}`)

			// The spawn is asynchronous, so the child may not have reached its first await yet.
			// Poll until it is running, or the scenario would prove nothing.
			let running = false
			for (let i = 0; i < 100; i++) {
				running = await s.page.evaluate((id) => globalThis.__voidChatThreadService.streamState[id]?.isRunning !== undefined, spawned.childThreadId)
				if (running) break
				await sleep(100)
			}
			assert.ok(running, 'the child never started, so a 0 s collect would prove nothing')

			const out = await s.page.evaluate(async ({ threadId, id }) => {
				const svc = globalThis.__voidChatThreadService
				const started = Date.now()
				await svc._runToolCall(threadId, 'collect_subagent', 'call-zero-collect', undefined, {
					preapproved: false,
					unvalidatedToolParams: { children: [id], timeout_seconds: 0 },
				})
				const row = svc.state.allThreads[threadId].messages.find(m => m.role === 'tool' && m.id === 'call-zero-collect')
				return { ms: Date.now() - started, results: row?.result?.results ?? null }
			}, { threadId: parent.id, id: spawned.childThreadId })

			t.diagnostic(`collect(0): ${out.ms}ms ${JSON.stringify(out.results)}`)
			assert.ok(out.ms < 3000, `a 0 s collect blocked for ${out.ms} ms`)
			assert.equal(out.results?.[0]?.status, 'running', 'a running child was not reported as running')

			// Clean up: stop the child so the scenario ends on a settled run.
			await s.page.evaluate(async ({ threadId, id }) => {
				const svc = globalThis.__voidChatThreadService
				await svc._runToolCall(threadId, 'cancel_subagent', 'call-zero-cancel', undefined, {
					preapproved: false,
					unvalidatedToolParams: { child_thread_id: id },
				})
			}, { threadId: parent.id, id: spawned.childThreadId })
		})
	})

	test('cancelling a child stops it and reports cancelled, not rejected', async (t) => {
		await h.withScenario('subagent/cancel', async (s) => {
			const parent = await scenario(s.page)
			await h.stubLLM(s.page, CHILD_REPORT, { usage: STUB_USAGE, hang: true })

			const spawned = await s.page.evaluate(async ({ threadId, alias, task }) => {
				const svc = globalThis.__voidChatThreadService
				await svc._runToolCall(threadId, 'run_subagent', 'call-cancel-spawn', undefined, {
					preapproved: false,
					unvalidatedToolParams: { alias, task },
				})
				const row = svc.state.allThreads[threadId].messages.find(m => m.role === 'tool' && m.id === 'call-cancel-spawn')
				return row?.result ?? null
			}, { threadId: parent.id, alias: ALIAS, task: CHILD_MARKER })
			assert.ok(spawned?.childThreadId, 'the spawn returned no handle')

			let running = false
			for (let i = 0; i < 100; i++) {
				running = await s.page.evaluate((id) => globalThis.__voidChatThreadService.streamState[id]?.isRunning !== undefined, spawned.childThreadId)
				if (running) break
				await sleep(100)
			}
			assert.ok(running, 'the child never started, so cancelling it would prove nothing')

			const cancelled = await s.page.evaluate(async ({ threadId, id }) => {
				const svc = globalThis.__voidChatThreadService
				await svc._runToolCall(threadId, 'cancel_subagent', 'call-cancel', undefined, {
					preapproved: false,
					unvalidatedToolParams: { child_thread_id: id },
				})
				const row = svc.state.allThreads[threadId].messages.find(m => m.role === 'tool' && m.id === 'call-cancel')
				// The run writes its own terminal status asynchronously; wait for it so the
				// assertion is about the settled record rather than about the abort call.
				for (let i = 0; i < 100; i++) {
					if (svc.state.allThreads[id]?.resultStatus !== undefined) break
					await new Promise(r => setTimeout(r, 50))
				}
				return { rowResult: row?.result ?? null, status: svc.state.allThreads[id]?.resultStatus ?? null }
			}, { threadId: parent.id, id: spawned.childThreadId })

			t.diagnostic(`cancel: ${JSON.stringify(cancelled)}`)
			assert.equal(cancelled.rowResult?.status, 'cancelled', 'the cancel tool did not report a cancellation')
			assert.equal(cancelled.status, 'cancelled', `the child settled as "${cancelled.status}" instead of cancelled`)
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
