/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The browser half of the external chat integration (see
// docs/designs/slack-integration.md). This service:
//
//   1. owns the pairing token and starts/stops the localhost protocol server
//      in electron-main (integrationChannel.ts), over the
//      'void-channel-integration' IPC channel,
//   2. routes proxy conversations onto real Void threads via
//      IChatThreadService (creating threads without stealing the user's
//      visible selection — see createThread),
//   3. watches thread stream state and forwards presentation-safe updates
//      back to the proxy (integrationChannel relays them onto the socket).
//
// REDACTION BOUNDARY: everything this service sends is structurally
// redacted — per-tool one-line summaries only, never raw results. The
// summarizer functions in the constructor are the one place this could
// leak; they must never format result bodies (file contents, terminal
// output, match text) into their output. Only uris, counts, sizes and
// resolve reasons.

import { Disposable } from '../../../../base/common/lifecycle.js'
import { Emitter, Event } from '../../../../base/common/event.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js'
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js'
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js'
import { localize2 } from '../../../../nls.js'
import { INotificationService } from '../../../../platform/notification/common/notification.js'
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js'
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { URI } from '../../../../base/common/uri.js'

import { IChatThreadService, QueuedMessage } from './chatThreadService.js'
import { ToolMessage } from '../common/chatThreadServiceTypes.js'
import { BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolName } from '../common/toolsServiceTypes.js'
import { LLMUsage } from '../common/sendLLMMessageTypes.js'
import {
	IntegrationChannelStartParams,
	IntegrationChannelState,
	IntegrationInbound,
	IntegrationOutbound,
} from '../common/integrationTypes.js'


// One workspace = one port = one proxy connection. The port is derived
// deterministically from the window's workspace URI, and the daemon
// computes the SAME port from the workspace path in its channel config —
// this is how a proxy reaches a specific workspace's window. Unscoped
// windows (no folder open) keep the base port.
//
// DEV vs RELEASED builds use different bases: a workspace open in BOTH
// the dev app and the installed app would otherwise contend for one
// port (first binder wins, the other never serves). With split bases
// the two apps serve different ports for the same workspace, and the
// proxy's channel config picks which app to reach via `portBase`. The
// pairing token (per-installation storage) still refuses accidental
// cross-talk. The daemon must implement the identical scheme.
const PORT_BASE_RELEASE = 4757
const PORT_BASE_DEV = 5757

const workspacePortOf = (workspaceUri: string | undefined, base: number): number => {
	if (!workspaceUri) return base
	let h = 0
	for (let i = 0; i < workspaceUri.length; i++)
		h = (h * 31 + workspaceUri.charCodeAt(i)) | 0
	return base + (Math.abs(h) % 1000)
}

const PAIRING_TOKEN_STORAGE_KEY = 'void.integration.pairingToken'

// streamDelta is the one high-frequency outbound message; the proxy would
// throttle before posting anyway, so coalesce here too — at most one per
// conversation per second.
const STREAM_DELTA_MIN_INTERVAL_MS = 1000

// Unresolved approvals on a remote surface are rejected, not forgotten: the
// channel is less trusted than the editor UI, and a tool left waiting
// forever would pin the thread.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

// Commands longer than this are cut for display in summaries.
const SUMMARY_MAX_COMMAND_LEN = 80


export interface IIntegrationService {
	readonly _serviceBrand: undefined

	readonly state: IntegrationChannelState & { pairingToken: string }
	readonly onDidChangeState: Event<void>

	/** Starts the localhost protocol server (idempotent). */
	start(): Promise<void>
	/** Stops the server and drops all proxy connections. */
	stop(): Promise<void>
	/** Mints a new pairing token, persists it, and restarts the server with it. */
	regeneratePairingToken(): Promise<void>
	/**
	 * Ask the proxy to create a new external conversation mirroring the
	 * CURRENT chat — the editor-initiated direction of the binding. The
	 * current chat's replies/events start flowing to the new conversation
	 * once the proxy confirms with conversationBound. No-op (with a
	 * notification) if the chat is already mirrored or nothing is open.
	 */
	mirrorCurrentChat(): Promise<void>
}

export const IIntegrationService = createDecorator<IIntegrationService>('voidIntegrationService')


type PendingApproval = {
	threadId: string
	toolId: string
	conversationKey: string
	timeout: ReturnType<typeof setTimeout>
}

// a summary of a tool call built from params (and result when it exists)
type SummarizeBuiltinTool<T extends BuiltinToolName> = (params: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]> | null) => string


class IntegrationService extends Disposable implements IIntegrationService {

	readonly _serviceBrand: undefined

	private readonly channel: IChannel

	private _channelState: IntegrationChannelState = {
		running: false,
		port: undefined,
		nConnections: 0,
	}
	private _pairingToken: string

	private readonly _onDidChangeState = new Emitter<void>()
	public readonly onDidChangeState = this._onDidChangeState.event

	// ---- conversation ↔ thread routing (session-local mirror; the proxy owns the durable map)

	private readonly _threadIdOfConversationKey = new Map<string, string>()
	private readonly _conversationKeyOfThreadId = new Map<string, string>()

	// ---- outbound bookkeeping

	// tool messages we've already reported, by `${threadId}:${toolMsgId}` →
	// last phase sent. Guards against re-emitting toolStatus on every stream
	// tick (onDidChangeStreamState fires constantly during a run).
	private readonly _toolPhaseOfKey = new Map<string, 'running' | 'success' | 'error'>()
	// tool ids we've already surfaced an approvalRequest for
	private readonly _approvalRequestedToolIds = new Set<string>()
	private readonly _approvalOfRequestId = new Map<string, PendingApproval>()
	// last isRunning phase per thread — the falsy-transition is what marks a turn end
	private readonly _lastRunningPhaseOfThreadId = new Map<string, string>()
	private readonly _lastDeltaTextOfConversationKey = new Map<string, string>()
	private readonly _lastDeltaTimeOfConversationKey = new Map<string, number>()
	private readonly _lastErrorMessageOfThreadId = new Map<string, string>()
	// finals held while a conversation is being minted for an unbound
	// thread (auto-mirror) — flushed on conversationBound
	private readonly _pendingFinalOfThreadId = new Map<string, { text: string, usage: LLMUsage | undefined }>()
	// messages-array index captured when a binding was established — tool
	// and approval scans start there. A thread WITH history (adoption,
	// auto-mirror, remembered-binding adoption after restart) must not replay
	// every old tool status as if it just happened: first sight of such a
	// thread would otherwise flood the external surface with its entire
	// history of tool errors, and re-flood on every app restart.
	private readonly _scanStartIdxOfThreadId = new Map<string, number>()

	// per-tool redaction summarizers, built in the constructor where the
	// relative-uri helper is in scope
	private _summarizeOfName!: { [T in BuiltinToolName]?: SummarizeBuiltinTool<T> }


	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super()
		this.channel = mainProcessService.getChannel('void-channel-integration')

		// pairing token — persisted so the proxy config stays valid across restarts
		let pairingToken = this._storageService.get(PAIRING_TOKEN_STORAGE_KEY, StorageScope.APPLICATION)
		if (!pairingToken) {
			pairingToken = generateUuid()
			this._storageService.store(PAIRING_TOKEN_STORAGE_KEY, pairingToken, StorageScope.APPLICATION, StorageTarget.USER)
		}
		this._pairingToken = pairingToken

		this._buildSummarizers()

		this._register((this.channel.listen('onInbound') satisfies Event<IntegrationInbound>)(p => {
			this._onInbound(p).catch(e => console.error('integration service: inbound handler failed:', e))
		}))
		this._register((this.channel.listen('onProxyConnected') satisfies Event<void>)(() => this._refreshState()))
		this._register((this.channel.listen('onProxyDisconnected') satisfies Event<void>)(() => this._refreshState()))

		this._register(this._chatThreadService.onDidChangeStreamState(({ threadId }) => {
			try { this._onStreamState(threadId) }
			catch (e) { console.error('integration service: stream state handler failed:', e) }
		}))

		// the workspace-derived port this window serves (see workspacePortOf)
		// — computed here, not as a field initializer, because it reads an
		// injected service whose parameter property is assigned in this
		// constructor. Dev builds serve a different base than released ones.
		this._port = workspacePortOf(this._chatThreadService.state.currentWorkspaceUri,
			this._environmentService.isBuilt ? PORT_BASE_RELEASE : PORT_BASE_DEV)

		this.start().catch(e => console.error('integration service: failed to start:', e))
	}

	private readonly _port: number


	get state(): IntegrationChannelState & { pairingToken: string } {
		return { ...this._channelState, pairingToken: this._pairingToken }
	}

	async start(): Promise<void> {
		this._channelState = await this.channel.call<IntegrationChannelState>('start',
			{ port: this._port, pairingToken: this._pairingToken } satisfies IntegrationChannelStartParams)
		this._onDidChangeState.fire()
	}

	async stop(): Promise<void> {
		this._channelState = await this.channel.call<IntegrationChannelState>('stop', undefined)
		this._onDidChangeState.fire()
	}

	async regeneratePairingToken(): Promise<void> {
		this._pairingToken = generateUuid()
		this._storageService.store(PAIRING_TOKEN_STORAGE_KEY, this._pairingToken, StorageScope.APPLICATION, StorageTarget.USER)
		await this.stop()
		await this.start()
	}

	private async _refreshState() {
		this._channelState = await this.channel.call<IntegrationChannelState>('getState', undefined)
		this._onDidChangeState.fire()
	}


	// -------------------------------------------------- inbound (proxy → threads)

	private async _onInbound(p: IntegrationInbound): Promise<void> {
		switch (p.type) {
			case 'userMessage': {
				const threadId = this._resolveThread(p.conversationKey, p.threadId)
				if (threadId === undefined) return // createThread failed — nothing more to do
				// apply the channel's permission grant BEFORE dispatching — the
				// turn's own state snapshot happens after this, so the mode is
				// already in effect when any tool approval gate runs
				if (p.permissionMode !== undefined)
					this._chatThreadService.setThreadPermissionMode(threadId, p.permissionMode)
				const s = this._chatThreadService.streamState[threadId]
				if (s?.isRunning !== undefined) {
					// a run is in flight — the message queues and auto-sends
					// when the turn ends naturally
					const queued: Omit<QueuedMessage, 'id'> = { userMessage: p.text, chatSelections: [], pendingImageBytes: new Map() }
					this._chatThreadService.queueUserMessage(threadId, queued)
				}
				else {
					await this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: p.text, threadId })
				}
				return
			}
			case 'newThread': {
				this._resolveThread(p.conversationKey, undefined)
				return
			}
			case 'approvalResponse': {
				const pending = this._approvalOfRequestId.get(p.requestId)
				if (!pending) return // already timed out or already answered
				clearTimeout(pending.timeout)
				this._approvalOfRequestId.delete(p.requestId)
				if (p.approved)
					this._chatThreadService.approveToolRequest(pending.threadId, pending.toolId)
				else
					this._chatThreadService.rejectToolRequest(pending.threadId, pending.toolId)
				return
			}
			case 'interrupt': {
				const threadId = this._threadIdOfConversationKey.get(p.conversationKey)
				if (threadId !== undefined)
					await this._chatThreadService.abortRunning(threadId)
				return
			}
			case 'conversationBound': {
				// the proxy created (or re-confirmed) an external conversation for
				// an existing thread — fill the session mirror, then deliver any
				// final that was held while the conversation was being minted
				this._threadIdOfConversationKey.set(p.conversationKey, p.threadId)
				this._conversationKeyOfThreadId.set(p.threadId, p.conversationKey)
				// floor the scans at current history — pre-binding tool messages
				// are history, not news (the pending final below still covers the
				// turn that triggered the mirroring)
				this._setScanFloor(p.threadId)
				console.log(`[integration] mirrored thread ${p.threadId} to conversation ${p.conversationKey}`)
				const pending = this._pendingFinalOfThreadId.get(p.threadId)
				if (pending) {
					this._pendingFinalOfThreadId.delete(p.threadId)
					this._postOutbound({
						type: 'final',
						conversationKey: p.conversationKey,
						text: pending.text,
						usage: pending.usage,
						title: this._threadTitleOf(p.threadId),
					})
				}
				this._notificationService.info('Chat mirrored — replies in the external thread now reach this chat')
				return
			}
			case 'setThreadPermissionMode': {
				// a per-channel re-grant of trust from the proxy's config — only
				// applies to threads this conversation is bound to. The proxy
				// carries its remembered threadId so this works right after an app
				// restart, when the session mirror is empty (pre-warm path).
				let threadId = this._threadIdOfConversationKey.get(p.conversationKey)
				if (threadId === undefined
					&& this._chatThreadService.state.allThreads[p.threadId] !== undefined) {
					// adopt the proxy's durable binding
					threadId = p.threadId
					this._bind(p.conversationKey, threadId)
				}
				console.log(`[integration] setThreadPermissionMode ${p.permissionMode} on ${p.conversationKey}: threadId=${threadId ?? 'NO BINDING'}`)
				if (threadId !== undefined)
					this._chatThreadService.setThreadPermissionMode(threadId, p.permissionMode)
				return
			}
		}
	}

	// Finds the thread for a conversation, adopting the proxy's remembered
	// binding (or creating a new thread) when the session-local mirror has
	// no entry. Emits `bound` whenever a binding is established, so the proxy
	// can persist it. Returns undefined if a thread had to be created but
	// creation failed — which currently can't happen, but the shape leaves
	// room for validation later.
	private _resolveThread(conversationKey: string, rememberedThreadId: string | undefined): string | undefined {
		let threadId = this._threadIdOfConversationKey.get(conversationKey)

		if (threadId !== undefined) {
			// already bound this session — make sure the reverse mirror exists too
			this._bind(conversationKey, threadId)
			return threadId
		}

		// adopt the proxy's durable binding if the thread still exists
		if (rememberedThreadId !== undefined && this._chatThreadService.state.allThreads[rememberedThreadId] !== undefined) {
			this._bind(conversationKey, rememberedThreadId)
			return rememberedThreadId
		}

		// otherwise create a fresh thread in the current workspace — without
		// switching the user's visible thread
		const newThreadId = this._chatThreadService.createThread()
		this._bind(conversationKey, newThreadId)
		return newThreadId
	}

	private _bind(conversationKey: string, threadId: string) {
		this._threadIdOfConversationKey.set(conversationKey, threadId)
		this._conversationKeyOfThreadId.set(threadId, conversationKey)
		// floor the scans at the thread's current history — called BEFORE the
		// inbound user message that triggered binding is appended, so the
		// turn it starts is still scanned
		this._setScanFloor(threadId)
		this._postOutbound({ type: 'bound', conversationKey, threadId })
	}

	private _setScanFloor(threadId: string): void {
		const withMessages = this._chatThreadService.getThreadWithMessages(threadId)
		this._scanStartIdxOfThreadId.set(threadId, withMessages?.messages.length ?? 0)
	}

	async mirrorCurrentChat(): Promise<void> {
		const thread = this._chatThreadService.getCurrentThread()
		if (!thread) {
			this._notificationService.info('No chat is currently open to mirror')
				return
		}
		if (this._conversationKeyOfThreadId.has(thread.id)) {
			this._notificationService.info('This chat is already mirrored to an external conversation')
				return
		}

		// a human-readable label for the anchor message the proxy will post
		let title: string | undefined = thread.customTitle?.trim() || undefined
		if (title === undefined) {
			const withMessages = this._chatThreadService.getThreadWithMessages(thread.id)
			const firstUser = withMessages?.messages.find(m => m.role === 'user')
			if (firstUser && firstUser.role === 'user' && firstUser.displayContent.trim() !== '')
				title = firstUser.displayContent.slice(0, 80)
		}

		this._postOutbound({
			type: 'createConversation',
			threadId: thread.id,
			title,
			text: this._openingMessageOf(thread.id),
		})
		// conversationBound (from the proxy) completes the mirroring; events
		// for this thread are dropped until it arrives — mirroring effectively
		// starts with the next turn
	}


	// -------------------------------------------------- outbound (threads → proxy)

	private _onStreamState(threadId: string): void {
		const conversationKey = this._conversationKeyOfThreadId.get(threadId)

		const s = this._chatThreadService.streamState[threadId]
		const isRunning = s?.isRunning

		// mid-turn events only flow for already-bound conversations;
		// unbound threads are still tracked below so their turn END can
		// mint a conversation (editor-started threads)
		if (conversationKey !== undefined) {
			// tool transitions from the thread's messages — skipped mid-stream
			// ticks already see these, the phase map dedupes
			this._scanToolMessages(threadId, conversationKey)

			// assistant text so far — coalesced
			if (isRunning === 'LLM' && s?.llmInfo)
				this._maybeStreamDelta(conversationKey, s.llmInfo.displayContentSoFar)

			// a tool is waiting on the user — surface it as an approvalRequest
			if (isRunning === 'awaiting_user')
				this._scanApprovalRequests(threadId, conversationKey)
		}

		// turn end: was running, now not — the only transition that fires once
		// per completed turn ('idle' between agent-loop requests stays truthy)
		const prev = this._lastRunningPhaseOfThreadId.get(threadId)
		if (prev !== undefined && isRunning === undefined) {
			this._lastRunningPhaseOfThreadId.delete(threadId)
			if (conversationKey === undefined) {
				// an editor-started thread finished a turn with no external
				// conversation — mint one now and deliver the final into it
				// (error/aborted turns don't sprout conversations)
				if (!s?.error)
					this._beginAutoMirror(threadId)
				return
			}
			if (s?.error) {
				if (this._lastErrorMessageOfThreadId.get(threadId) !== s.error.message) {
					this._lastErrorMessageOfThreadId.set(threadId, s.error.message)
					this._postOutbound({ type: 'error', conversationKey, message: s.error.message, title: this._threadTitleOf(threadId) })
				}
			}
			else {
				this._postFinal(threadId, conversationKey)
			}
		}
		else if (isRunning !== undefined) {
			this._lastRunningPhaseOfThreadId.set(threadId, isRunning)
		}
	}

	private _scanToolMessages(threadId: string, conversationKey: string): void {
		const thread = this._chatThreadService.getThreadWithMessages(threadId)
		if (!thread) return

		const startIdx = this._scanStartIdxOfThreadId.get(threadId) ?? 0
		for (let i = startIdx; i < thread.messages.length; i++) {
			const m = thread.messages[i]
			if (m.role !== 'tool') continue
			// 'tool_request' is surfaced by _scanApprovalRequests instead
			let phase: 'running' | 'success' | 'error' | null = null
			if (m.type === 'running_now') phase = 'running'
			else if (m.type === 'success') phase = 'success'
			else if (m.type === 'tool_error' || m.type === 'invalid_params' || m.type === 'rejected') phase = 'error'
			if (phase === null) continue

			const key = `${threadId}:${m.id}`
			if (this._toolPhaseOfKey.get(key) === phase) continue
			this._toolPhaseOfKey.set(key, phase)

			this._postOutbound({
				type: 'toolStatus',
				conversationKey,
				toolName: m.name,
				mcpServerName: m.mcpServerName,
				phase,
				summary: this._summarizeToolMessage(m),
				title: this._threadTitleOf(threadId),
			})
		}
	}

	private _scanApprovalRequests(threadId: string, conversationKey: string): void {
		const thread = this._chatThreadService.getThreadWithMessages(threadId)
		if (!thread) return

		const startIdx = this._scanStartIdxOfThreadId.get(threadId) ?? 0
		for (let i = startIdx; i < thread.messages.length; i++) {
			const m = thread.messages[i]
			if (m.role !== 'tool' || m.type !== 'tool_request') continue
			const key = `${threadId}:${m.id}`
			if (this._approvalRequestedToolIds.has(key)) continue
			this._approvalRequestedToolIds.add(key)

			const requestId = generateUuid()
			const timeout = setTimeout(() => {
				// unresolved on a remote surface → reject, never park forever
				this._approvalOfRequestId.delete(requestId)
				this._chatThreadService.rejectToolRequest(threadId, m.id)
			}, APPROVAL_TIMEOUT_MS)
			this._approvalOfRequestId.set(requestId, { threadId, toolId: m.id, conversationKey, timeout })

			this._postOutbound({
				type: 'approvalRequest',
				requestId,
				conversationKey,
				toolName: m.name,
				mcpServerName: m.mcpServerName,
				paramsSummary: this._summarizeToolMessage(m),
				title: this._threadTitleOf(threadId),
			})
		}
	}

	private _maybeStreamDelta(conversationKey: string, textSoFar: string): void {
		if (this._lastDeltaTextOfConversationKey.get(conversationKey) === textSoFar) return
		const now = Date.now()
		if (now - (this._lastDeltaTimeOfConversationKey.get(conversationKey) ?? 0) < STREAM_DELTA_MIN_INTERVAL_MS) return
		this._lastDeltaTextOfConversationKey.set(conversationKey, textSoFar)
		this._lastDeltaTimeOfConversationKey.set(conversationKey, now)
		this._postOutbound({ type: 'streamDelta', conversationKey, textSoFar })
	}

	// an unbound thread completed a turn — ask the proxy to mint a
	// conversation for it, and hold the final until conversationBound
	// brings back the key. The proxy is idempotent on threadId (re-confirms
	// a remembered binding), so an app restart can't mint a duplicate
	// conversation — the pending final lands in the existing thread.
	private _beginAutoMirror(threadId: string): void {
		const final = this._finalOfThreadId(threadId)
		if (final === undefined || final.text === '') return // nothing to say — don't mint a thread for it
		this._pendingFinalOfThreadId.set(threadId, final)
		this._postOutbound({
			type: 'createConversation',
			threadId,
			title: this._threadTitleOf(threadId),
			text: this._openingMessageOf(threadId),
		})
	}

	private _finalOfThreadId(threadId: string): { text: string, usage: LLMUsage | undefined } | undefined {
		const thread = this._chatThreadService.getThreadWithMessages(threadId)
		if (!thread) return undefined

		// The agent loop creates ONE assistant message per LLM request — so a
		// multi-step turn has its narration split across several assistant
		// messages, interleaved with tool results. The user message that started
		// this turn is the last 'user' message (queued follow-ups aren't appended
		// until their own turn starts). Everything the model said this turn is
		// the answer — sending only the last assistant message silently drops
		// intermediate narration (e.g. "File 1: …" before reading File 2).
		const messages = thread.messages
		const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
		const parts: string[] = []
		for (let i = lastUserIdx + 1; i < messages.length; i++) {
			const m = messages[i]
			if (m.role === 'assistant' && m.displayContent.trim() !== '')
				parts.push(m.displayContent)
		}
		const text = parts.length > 0
			? parts.join('\n\n')
			: ([...messages].reverse().find(m => m.role === 'assistant')?.displayContent ?? '')

		const usage: LLMUsage | undefined = this._chatThreadService.latestUsageOfThreadId[threadId]
		return { text, usage }
	}

	private _postFinal(threadId: string, conversationKey: string): void {
		const final = this._finalOfThreadId(threadId)
		if (final === undefined) return
		this._postOutbound({
			type: 'final',
			conversationKey,
			text: final.text,
			usage: final.usage,
			title: this._threadTitleOf(threadId),
		})
	}

	// The user message that opens a mirrored conversation: the LAST user
	// message in the thread — for auto-mirror that is the turn that just
	// completed, for the manual command it is the message the user is
	// looking at. Posted by the proxy as the conversation's root so the
	// external thread begins with real content instead of a synthetic
	// anchor. Capped to keep protocol frames small; the thread itself has
	// the full text.
	private _openingMessageOf(threadId: string): string | undefined {
		const withMessages = this._chatThreadService.getThreadWithMessages(threadId)
		const lastUser = withMessages ? [...withMessages.messages].reverse().find(m => m.role === 'user') : undefined
		if (!lastUser || lastUser.role !== 'user' || lastUser.displayContent.trim() === '') return undefined
		return lastUser.displayContent.slice(0, 2000)
	}

	// The thread's current human-readable label, sent with every posted
	// outbound message so external surfaces can identify the task out of
	// context (mobile notifications show reply text without thread
	// context). Mirrors the anchor-label derivation in mirrorCurrentChat.
	private _threadTitleOf(threadId: string): string | undefined {
		const thread = this._chatThreadService.state.allThreads[threadId]
		const custom = thread?.customTitle?.trim()
		if (custom) return custom
		const withMessages = this._chatThreadService.getThreadWithMessages(threadId)
		const firstUser = withMessages?.messages.find(m => m.role === 'user')
		if (firstUser && firstUser.role === 'user' && firstUser.displayContent.trim() !== '')
			return firstUser.displayContent.slice(0, 80)
		return undefined
	}

	private _postOutbound(payload: IntegrationOutbound): void {
		this.channel.call('postOutbound', payload).catch(e => console.error('integration service: postOutbound failed:', e))
	}


	// -------------------------------------------------- redaction summarizers

	private _buildSummarizers() {
		// workspace-relative when possible — absolute paths leak machine layout
		const short = (uri: URI): string => this._chatThreadService.getRelativeStr(uri) ?? uri.path
		const trunc = (s: string): string => s.length > SUMMARY_MAX_COMMAND_LEN ? s.slice(0, SUMMARY_MAX_COMMAND_LEN - 1) + '…' : s

		// TerminalResolveReason is a discriminated union, not a string — without
		// this helper it stringifies as "[object Object]".
		const terminalReason = (r: { type: 'timeout', reason: string } | { type: 'done', exitCode: number }) =>
			r.type === 'done' ? `exit ${r.exitCode}` : `timeout (${r.reason})`

		// REDACTION BOUNDARY — none of these may format result *bodies*
		// (file contents, terminal output, match text) into the summary.
		// Only uris, counts, sizes and resolve reasons.
		this._summarizeOfName = {
			'read_file': (p, r) => r === null
				? `readFile ${short(p.uri)}`
				: `readFile ${short(p.uri)} (${r.totalFileLen} chars, ${r.totalNumLines} lines${!r.outlined && r.hasNextPage ? ', paginated' : ''})`,
			'ls_dir': (p, r) => `lsDir ${short(p.uri)}${r?.children ? ` (${r.children.length} items)` : ''}`,
			'get_dir_tree': (p) => `getDirTree ${short(p.uri)}`,
			'search_pathnames_only': (p, r) => `searchPathnames "${trunc(p.query)}"${r ? ` (${r.uris.length} files)` : ''}`,
			'search_for_files': (p, r) => `searchContents "${trunc(p.query)}"${r ? ` (${r.uris.length} files)` : ''}`,
			'search_in_file': (p, r) => `searchInFile ${short(p.uri)}${r ? ` (${r.lines.length} lines)` : ''}`,
			'go_to_definition': (p, r) => `goToDefinition ${p.symbolName}${r ? ` (${r.locations.length} locations)` : ''}`,
			'go_to_usages': (p, r) => `goToUsages ${p.symbolName}${r ? ` (${r.locations.length} locations)` : ''}`,
			'read_lint_errors': (p, r) => `readLintErrors ${short(p.uri)}${r?.lintErrors ? ` (${r.lintErrors.length} errors)` : ''}`,
			'rewrite_file': (p) => `rewriteFile ${short(p.uri)}`,
			'edit_file': (p) => `editFile ${short(p.uri)} (${p.edits.length} edits)`,
			'create_file_or_folder': (p) => `create${p.isFolder ? 'Folder' : 'File'} ${short(p.uri)}`,
			'delete_file_or_folder': (p) => `delete${p.isFolder ? 'Folder' : 'File'} ${short(p.uri)}`,
			'rename_file_or_folder': (p) => `rename ${short(p.sourceUri)} → ${short(p.targetUri)}`,
			'run_command': (p, r) => `runCommand ${trunc(p.command)}${r ? ` · ${terminalReason(r.resolveReason)}` : ''}`,
			'open_persistent_terminal': (p) => `openTerminal${p.cwd ? ` in ${p.cwd}` : ''}`,
			'run_persistent_command': (p, r) => `runCommand ${trunc(p.command)}${r ? ` · ${terminalReason(r.resolveReason)}` : ''}`,
			'kill_persistent_terminal': () => `killTerminal`,
			'read_terminal': (p) => `readTerminal ${p.terminalName}`,
			'fetch_url': (p, r) => `fetchUrl ${p.url}${r ? ` (${r.content.length} chars)` : ''}`,
			'semantic_search': (p, r) => `semanticSearch "${trunc(p.query)}"${r ? ` (${r.results.length} results)` : ''}`,
			'search_history': (p, r) => `searchHistory${p.query ? ` "${trunc(p.query)}"` : ''}${r ? ` (${r.totalMatches} matches)` : ''}`,
			'load_skill': (p) => `loadSkill ${p.skillName}`,
		}
	}

	// Summary of a tool message — the one function all outbound tool info
	// flows through. Called before the result exists for approvalRequest
	// summaries, and with the structured result for toolStatus. NOTE: the
	// tool_error variant's `result` is a raw error string — deliberately NOT
	// forwarded (it can quote file content / stderr), we only say “— error”.
	private _summarizeToolMessage(m: ToolMessage<ToolName>): string {
		if (m.type === 'invalid_params')
			return `${m.name} (invalid params)`
		if (m.type === 'rejected')
			return `${this._summarizeParams(m.name, m.mcpServerName, m.params)} — rejected`
		if (m.type === 'tool_error')
			return `${this._summarizeParams(m.name, m.mcpServerName, m.params)} — error`
		if (m.type === 'running_now' || m.type === 'tool_request')
			return this._summarizeParams(m.name, m.mcpServerName, m.params)
		// success — the structured result exists; summarizers reduce it to
		// counts/sizes, never bodies
		return this._summarizeParams(m.name, m.mcpServerName, m.params, m.result)
	}

	private _summarizeParams(name: ToolName, mcpServerName: string | undefined, params: unknown, result?: unknown): string {
		// non-builtin tools are MCP — no per-tool knowledge, keep it coarse
		if (!(name in this._summarizeOfName))
			return `mcp ${mcpServerName ?? '?'}/${name}`

		// Documented cast — indexing the map with the full BuiltinToolName
		// union collapses the per-key generic correlation (the same reason
		// toolsService casts its dispatch maps). Each stored value is fully
		// typed at its key; only the dispatch erases it.
		const fn = this._summarizeOfName[name as BuiltinToolName] as
			((params: BuiltinToolCallParams[BuiltinToolName], result: Awaited<BuiltinToolResultType[BuiltinToolName]> | null) => string)

		// params/result come off a ToolMessage<ToolName>, whose union includes
		// MCP shapes — safe here because the `in` check above proved builtin
		return fn(
			params as BuiltinToolCallParams[BuiltinToolName],
			(result ?? null) as Awaited<BuiltinToolResultType[BuiltinToolName]> | null,
		)
	}

}


registerSingleton(IIntegrationService, IntegrationService, InstantiationType.Eager);


// Mirror the CURRENT chat to a new external conversation — the explicit,
// editor-initiated direction of the binding (createConversation →
// conversationBound handshake with the proxy).
export const VOID_MIRROR_CHAT_ACTION_ID = 'void.integration.mirrorCurrentChat'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_MIRROR_CHAT_ACTION_ID,
			title: localize2('voidMirrorCurrentChat', 'Void: Mirror Current Chat to an External Chat'),
			f1: true,
		})
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const integrationService = accessor.get(IIntegrationService)
		await integrationService.mirrorCurrentChat()
	}
});

// Show this installation's pairing token — the one manual step of
// configuring a proxy: copy it into the proxy's config. Tokens are
// per-installation (application storage), so this is how you get the
// token for whichever app (dev or released) you intend the proxy to talk to.
export const VOID_SHOW_INTEGRATION_TOKEN_ACTION_ID = 'void.integration.showPairingToken'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_SHOW_INTEGRATION_TOKEN_ACTION_ID,
			title: localize2('voidShowIntegrationToken', 'Void: Show External Chat Pairing Token'),
			f1: true,
		})
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const integrationService = accessor.get(IIntegrationService)
		const clipboardService = accessor.get(IClipboardService)
		const notificationService = accessor.get(INotificationService)
		const token = integrationService.state.pairingToken
		await clipboardService.writeText(token)
		notificationService.info(`Pairing token copied to clipboard: ${token}`)
	}
});

// The service has no UI yet — this contribution's only job is to instantiate
// the singleton at startup, so the localhost server is listening (and the
// pairing token is persisted) without any user action. Same pattern as
// metricsPollService. Injecting the service into the constructor is what
// forces instantiation; registerSingleton alone never constructs anything.
class IntegrationServiceStarter {
	static readonly ID = 'voidIntegrationServiceStarter'
	constructor(@IIntegrationService _integrationService: IIntegrationService) { }
}
registerWorkbenchContribution2(IntegrationServiceStarter.ID, IntegrationServiceStarter, WorkbenchPhase.AfterRestored);
