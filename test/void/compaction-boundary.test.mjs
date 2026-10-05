// Compaction replaces everything before `compactionBoundaryIdx` with a summary,
// so that one index decides what the model loses.
//
// Background: the boundary was `max(turn boundary, messages.length − 10)`. The
// turn rule is the one the dialog's "Keep last N turns" slider drives, and it
// points at a user message. A `max` on the boundary is a `min` on retention, so
// the fixed ten-entry rule won whenever the recent tail was longer than ten
// entries — which is every agent turn. And because that rule cuts by position,
// it can land inside an assistant message's tool batch.
//
// Bug: the projection keeps `messages[boundaryIdx..]`, so a positional boundary
// can slice a tool batch in half. Half the results are summarised away with the
// assistant that made the calls — its text and reasoning included — and the rest
// arrive verbatim, where `prepareMessages_openai_tools` attaches them to the
// synthetic acknowledgement the projection inserts before the kept tail
// ("Understood. Continuing with the context above."). The request stays
// structurally valid, which is why this is not a malformed-request bug: it is a
// request that says the model called tools it has no record of calling, with the
// summary describing results the model also sees in full.
//
// Example fixture below: four chat turns, then one turn with twelve parallel
// tool calls. `messages.length − 10` lands on the third of those twelve results.
//
//   npm run test-void -- --only=compaction-boundary
//   VOID_EXPECT=lost npm run test-void -- --only=compaction-boundary   # must fail on unmodified code

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

// Four small turns, then a burst: 5 turns x (user + assistant) = 10 entries, plus
// a tail turn of user + assistant + 12 tool results = 24 messages, so a
// ten-entry cap boundary lands at index 14, inside the batch.
const TURNS = 5
const TOOL_CALLS_PER_TURN = [0, 0, 0, 0, 12]
const CAP = 10

before(() => h.preflight())

function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

/**
 * Reads a compaction outcome across the two shapes this branch has carried:
 * `{ status }` after Stop/queue handling was added, and `string | null` before
 * it. Tolerant so the pre-change build can still be measured end to end with
 * VOID_EXPECT=lost rather than failing on the shape of a return value.
 */
function outcomeOf(raw) {
	if (raw === null) return 'compacted'
	if (typeof raw === 'string') return `failed: ${raw}`
	return raw?.status ?? `unrecognised: ${JSON.stringify(raw)}`
}

/**
 * Locates the kept tail inside a built request: the summary user message, the
 * synthetic assistant acknowledgement the projection inserts after it, and the
 * first message that follows.
 *
 * This is the request-level shape of a legal cut. When the boundary falls inside
 * a tool batch, the first kept message is a `tool` row: the batch is split across
 * the summary boundary, and because `prepareMessages_openai_tools` rebuilds an
 * assistant's `tool_calls` by walking back to the nearest assistant, those
 * surviving results end up declared by the synthetic acknowledgement instead of
 * by the assistant that actually made the calls.
 */
function describeKeptTail(request) {
	const msgs = request?.messages ?? []
	const summaryIdx = msgs.findIndex(
		m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[Conversation compacted'),
	)
	if (summaryIdx === -1) return { found: false }
	const ackIdx = summaryIdx + 1
	return {
		found: true,
		firstKeptRole: msgs[ackIdx + 1]?.role ?? null,
		ackToolCalls: msgs[ackIdx]?.tool_calls?.length ?? 0,
		toolMessages: msgs.filter(m => m.role === 'tool').length,
	}
}

/**
 * The request the agent loop sent for the chat turn. Compaction sends one too,
 * and a brand-new thread fires a fire-and-forget title request after it, so the
 * chat request is identified by the extras the loop stamps on it
 * (`loggingExtras.nMessagesSent`) rather than by position.
 */
function lastChatRequest(requestsJson) {
	const all = JSON.parse(requestsJson)
	const chat = all.filter(r => r?.logging?.loggingExtras?.nMessagesSent !== undefined)
	if (chat.length === 0) {
		const names = all.map(r => r?.logging?.loggingName ?? '(unnamed)').join(', ')
		return { request: null, reason: `no chat request captured (captured: ${names})` }
	}
	return { request: chat[chat.length - 1], reason: null }
}

describe('compaction boundary', () => {

	test('a boundary never lands inside an assistant message’s tool batch', async (t) => {
		await h.withScenario('compaction-boundary/legal-cut', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'summary text')

			const result = await s.page.evaluate(async (cap) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const before = svc.state.allThreads[id].messages

				// Fixture facts, read before compaction rewrites the thread.
				const capIdx = before.length - cap
				const capRole = before[capIdx]?.role
				const toolRows = before.filter(m => m.role === 'tool').length

				const outcome = await svc.compactCurrentThread({ compactPercent: 70, protectTurns: 1 })
				const messages = svc.state.allThreads[id]?.messages ?? []
				const boundaryIdx = svc.state.allThreads[id]?.compactionBoundaryIdx

				// What the projection keeps, and whether each kept tool row still has
				// the assistant that requested it inside the kept slice.
				const kept = boundaryIdx === undefined ? [] : messages.slice(boundaryIdx)
				let orphan = null
				for (let i = 0; i < kept.length && orphan === null; i++) {
					if (kept[i].role !== 'tool') continue
					const at = boundaryIdx + i
					let declaredInside = false
					for (let j = at - 1; j >= 0; j--) {
						if (messages[j].role === 'assistant') { declaredInside = j >= boundaryIdx; break }
						if (messages[j].role !== 'tool') break
					}
					if (!declaredInside) orphan = { id: kept[i].id, at }
				}

				return {
					outcome,
					boundaryIdx,
					boundaryRole: boundaryIdx === undefined ? null : messages[boundaryIdx]?.role,
					capIdx, capRole, toolRows,
					totalMessages: messages.length,
					keptMessages: kept.length,
					orphan,
				}
			}, CAP)

			trace(t, s)

			// Guards: the scenario depends on the tail being long enough that a
			// ten-entry cap lands on a tool row, and on compaction having run.
			assert.equal(outcomeOf(result.outcome), 'compacted', `compaction did not run: ${outcomeOf(result.outcome)}`)
			assert.equal(result.capRole, 'tool',
				`fixture guard: a ${CAP}-entry cap lands on '${result.capRole}' at index ${result.capIdx}, not on a tool row`)
			assert.ok(result.toolRows > CAP,
				`fixture guard: expected more than ${CAP} tool rows in the fixture, got ${result.toolRows}`)
			assert.ok(result.boundaryIdx !== undefined, 'no boundary was stored')

			// Subject: the stored boundary is a legal cut, and no kept tool row lost
			// the assistant that declared it.
			h.assertAbsent(
				`a boundary pointing at a tool result (observed role: ${result.boundaryRole}; kept ${result.keptMessages}/${result.totalMessages})`,
				result.boundaryRole !== 'tool',
				{ subject: true },
			)
			h.assertAbsent(
				`an orphaned tool result in the kept slice (${result.orphan ? `tool '${result.orphan.id}' at index ${result.orphan.at}` : 'none'})`,
				result.orphan === null,
				{ subject: true },
			)
		})
	})

	test('the request built after a compaction keeps its tail starting at a turn, not mid-batch', async (t) => {
		await h.withScenario('compaction-boundary/request', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'summary text')

			const outcome = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const outcome = await svc.compactCurrentThread({ compactPercent: 70, protectTurns: 1 })
				const compacted = outcome === null || (typeof outcome === 'object' && outcome?.status === 'compacted')
				if (!compacted) return { outcome }
				// A real send, so the request under test is the projection of the
				// compacted thread rather than the compaction request itself.
				await svc.addUserMessageAndStreamResponse({ userMessage: 'and then?', threadId: id })
				return { outcome }
			})

			trace(t, s)
			assert.equal(outcomeOf(outcome.outcome), 'compacted', `compaction or send did not run: ${outcomeOf(outcome.outcome)}`)

			const { request, reason } = lastChatRequest(await h.capturedLLMRequests(s.page))
			assert.ok(request, reason)

			const keptTail = describeKeptTail(request)
			assert.ok(keptTail.found, 'the captured chat request carries no compacted summary')
			// Guard: the request must carry tool history, or the check is vacuous.
			assert.ok(keptTail.toolMessages > 0,
				'fixture guard: the post-compaction request carries no tool result')

			h.assertAbsent(
				`a kept tail opening with a tool result (first kept message: '${keptTail.firstKeptRole}', ${keptTail.toolMessages} tool messages, ${keptTail.ackToolCalls} call(s) declared by the summary acknowledgement)`,
				keptTail.firstKeptRole !== 'tool',
				{ subject: true },
			)
		})
	})

	test('the dialog’s preview is the plan the compaction runs', async (t) => {
		// A control, not a VOID_EXPECT subject: there is no "before" state to
		// invert, the property is simply that the two agree. The preview getter
		// does not exist before this change, so the check is skipped when it is
		// absent and the unpatched build is measured by the subjects above.
		await h.withScenario('compaction-boundary/preview', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'summary text')

			const result = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				if (typeof svc.getCompactionPlan !== 'function') return { skipped: true }
				const id = svc.state.currentThreadId
				const plan = svc.getCompactionPlan({ turns: 1 })
				const outcome = await svc.compactCurrentThread({ compactPercent: 70, protectTurns: 1 })
				const thread = svc.state.allThreads[id]
				return {
					skipped: false,
					outcome,
					planBoundary: plan?.boundaryIdx,
					planKept: plan?.keptMessages,
					storedBoundary: thread?.compactionBoundaryIdx,
					storedKept: thread ? thread.messages.length - thread.compactionBoundaryIdx : null,
				}
			})

			trace(t, s)
			if (result.skipped) {
				t.diagnostic('preview getter absent — nothing to compare')
				return
			}
			assert.equal(outcomeOf(result.outcome), 'compacted', `compaction did not run: ${outcomeOf(result.outcome)}`)
			assert.equal(result.planBoundary, result.storedBoundary,
				'the previewed boundary is not the boundary the compaction stored')
			assert.equal(result.planKept, result.storedKept,
				'the previewed kept-message count is not what the compaction kept')
		})
	})

	test('stopping a compaction leaves the thread exactly as it was', async (t) => {
		// Compaction holds the input the way a run does, so Stop (or Escape) is
		// available while it works. It has to mean something: abort the
		// summarisation request, write nothing, and leave no empty assistant
		// bubble behind — `abortRunning` appends one for a streaming reply.
		await h.withScenario('compaction-boundary/stop', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'summary text', { hang: true })

			const result = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const priorUsage = { inputTokens: 4321, outputTokens: 55, totalTokens: 4376, requestCount: 1 }
				svc.state.allThreads[id].latestUsage = priorUsage
				svc.latestUsageOfThreadId[id] = priorUsage

				const before = {
					summary: svc.state.allThreads[id].compactionSummary ?? null,
					boundary: svc.state.allThreads[id].compactionBoundaryIdx ?? null,
					messageCount: svc.state.allThreads[id].messages.length,
				}

				const running = svc.compactCurrentThread({ compactPercent: 70, protectTurns: 1 })
				for (let i = 0; i < 150 && (globalThis.__voidPendingLLMRequests ?? []).length === 0; i++) {
					await new Promise(r => setTimeout(r, 20))
				}
				// The marker exists only once compaction is abortable; without it
				// this scenario cannot run and says so instead of hanging.
				if (!svc.streamState[id]?.compacting) return { abortable: false }

				await svc.abortRunning(id)
				const outcome = await running
				const thread = svc.state.allThreads[id]
				return {
					abortable: true,
					outcome,
					before,
					after: {
						summary: thread.compactionSummary ?? null,
						boundary: thread.compactionBoundaryIdx ?? null,
						messageCount: thread.messages.length,
					},
					usage: thread.latestUsage,
					stillRunning: svc.streamState[id]?.isRunning ?? null,
				}
			})

			trace(t, s)
			if (!result.abortable) {
				t.diagnostic('compaction is not abortable in this build — scenario skipped')
				return
			}

			// Subject: Stop cancels, it does not let the compaction land.
			const status = outcomeOf(result.outcome)
			h.assertAbsent(
				`a compaction that completed anyway after Stop (status: ${status})`,
				status === 'cancelled',
				{ subject: true },
			)
			// Controls: nothing was written, no bubble was added, usage is intact,
			// and the thread is usable again.
			assert.deepEqual(result.after, result.before, 'the cancelled compaction changed the thread')
			assert.deepEqual(result.usage, { inputTokens: 4321, outputTokens: 55, totalTokens: 4376, requestCount: 1 },
				'the summarisation request\'s usage was left on the thread')
			assert.equal(result.stillRunning, null, 'the thread was left looking like it is still running')
		})
	})

	test('a message typed during a compaction is sent when it finishes', async (t) => {
		// Same contract as a run: Enter during compaction queues, and the queue
		// drains once the thread is idle again instead of sitting there.
		await h.withScenario('compaction-boundary/queued', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'summary text', { hang: true })

			const result = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const MARKER = 'QUEUED-WHILE-COMPACTING'
				const sent = () => svc.state.allThreads[id].messages.some(m =>
					(m.content ?? '').includes(MARKER) || (m.displayContent ?? '').includes(MARKER))

				const running = svc.compactCurrentThread({ compactPercent: 70, protectTurns: 1 })
				for (let i = 0; i < 150 && (globalThis.__voidPendingLLMRequests ?? []).length === 0; i++) {
					await new Promise(r => setTimeout(r, 20))
				}
				// What the composer does when Enter is pressed mid-run.
				svc.queueUserMessage(id, { userMessage: MARKER, chatSelections: [], pendingImageBytes: new Map() })
				const queuedWhileCompacting = svc.getQueuedMessages(id).length

				globalThis.__voidCompleteLLMRequest(0)
				const outcome = await running
				for (let i = 0; i < 150 && !sent(); i++) await new Promise(r => setTimeout(r, 20))

				return {
					queuedWhileCompacting,
					outcome,
					sent: sent(),
					queueAfter: svc.getQueuedMessages(id).length,
				}
			})

			trace(t, s)
			// Guard: it really was queued while the compaction was in flight.
			assert.equal(result.queuedWhileCompacting, 1, 'the message was not queued during compaction')
			const status = outcomeOf(result.outcome)
			assert.equal(status, 'compacted', `compaction did not complete: ${status}`)
			// Subject: the queue drains when compaction finishes.
			h.assertAbsent(
				`the queued message still unsent after compaction (status: ${status})`,
				result.sent,
				{ subject: true },
			)
			h.assertAbsent(
				`the queued message still waiting in the queue (${result.queueAfter} left)`,
				result.queueAfter === 0,
				{ subject: true },
			)
		})
	})

	test('a chat-style thread still compacts at the turn the user asked to keep', async (t) => {
		await h.withScenario('compaction-boundary/control', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, 8)
			await h.stubLLM(s.page, 'summary text')

			const result = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const before = svc.state.allThreads[id].messages
				let lastUserIdx = 0
				for (let i = before.length - 1; i >= 0; i--) {
					if (before[i].role === 'user') { lastUserIdx = i; break }
				}
				const outcome = await svc.compactCurrentThread({ compactPercent: 70, protectTurns: 1 })
				const thread = svc.state.allThreads[id]
				return {
					outcome,
					lastUserIdx,
					boundaryIdx: thread?.compactionBoundaryIdx,
					boundaryRole: thread?.messages?.[thread?.compactionBoundaryIdx]?.role,
				}
			})

			trace(t, s)
			// Control: must pass before and after the fix — a chat-style thread's
			// boundary is already the start of the turn the slider names.
			assert.equal(outcomeOf(result.outcome), 'compacted', `compaction did not run: ${outcomeOf(result.outcome)}`)
			assert.equal(result.boundaryIdx, result.lastUserIdx,
				'the boundary should be the start of the last user turn')
			assert.equal(result.boundaryRole, 'user', 'the boundary should point at a user message')
		})
	})

	test('a boundary stored before the fix is repaired when the thread is sent', async (t) => {
		await h.withScenario('compaction-boundary/legacy', async (s) => {
			await h.ensureModelSelection(s.page)
			await h.seedTestThread(s.page, TURNS, TOOL_CALLS_PER_TURN)
			await h.stubLLM(s.page, 'summary text')

			const stored = await s.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				const messages = svc.state.allThreads[id].messages
				// The shape the old rule could store: the third tool result of the
				// tail batch, whose assistant sits before it.
				const illegal = messages.length - 10
				const patched = {
					...svc.state.allThreads[id],
					compactionSummary: '[Conversation compacted — summary of prior context]\n\nlegacy',
					compactionBoundaryIdx: illegal,
				}
				svc._storeThread(id, patched)
				svc._setState({ allThreads: { ...svc.state.allThreads, [id]: patched } })

				await svc.addUserMessageAndStreamResponse({ userMessage: 'continue', threadId: id })
				return { illegalRole: messages[illegal]?.role, illegal }
			})

			trace(t, s)
			// Guard: the stored boundary must be the illegal shape.
			assert.equal(stored.illegalRole, 'tool',
				`fixture guard: the stored boundary at ${stored.illegal} points at '${stored.illegalRole}', not a tool row`)

			const { request } = lastChatRequest(await h.capturedLLMRequests(s.page))
			const keptTail = describeKeptTail(request)
			assert.ok(keptTail.found, 'the captured chat request carries no compacted summary')
			assert.ok(keptTail.toolMessages > 0,
				'fixture guard: the request carries no tool result')

			h.assertAbsent(
				`a kept tail opening with a tool result from a stored boundary (first kept message: '${keptTail.firstKeptRole}', ${keptTail.ackToolCalls} call(s) declared by the summary acknowledgement)`,
				keptTail.firstKeptRole !== 'tool',
				{ subject: true },
			)
		})
	})
})
