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


// The localhost port the proxy connects to. Fixed for v1 — a single
// user-owned proxy on the same machine. Make configurable via settings if a
// second proxy ever needs to run alongside.
const INTEGRATION_PORT = 4757

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

	// per-tool redaction summarizers, built in the constructor where the
	// relative-uri helper is in scope
	private _summarizeOfName!: { [T in BuiltinToolName]?: SummarizeBuiltinTool<T> }


	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IStorageService private readonly _storageService: IStorageService,
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

		this.start().catch(e => console.error('integration service: failed to start:', e))
	}


	get state(): IntegrationChannelState & { pairingToken: string } {
		return { ...this._channelState, pairingToken: this._pairingToken }
	}

	async start(): Promise<void> {
		this._channelState = await this.channel.call<IntegrationChannelState>('start',
			{ port: INTEGRATION_PORT, pairingToken: this._pairingToken } satisfies IntegrationChannelStartParams)
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
		this._postOutbound({ type: 'bound', conversationKey, threadId })
	}


	// -------------------------------------------------- outbound (threads → proxy)

	private _onStreamState(threadId: string): void {
		const conversationKey = this._conversationKeyOfThreadId.get(threadId)
		if (conversationKey === undefined) return // not a remote conversation

		const s = this._chatThreadService.streamState[threadId]
		const isRunning = s?.isRunning

		// tool transitions from the thread's messages — skipped mid-stream
		// ticks already see these, the phase map dedupes
		this._scanToolMessages(threadId, conversationKey)

		// assistant text so far — coalesced
		if (isRunning === 'LLM' && s?.llmInfo)
			this._maybeStreamDelta(conversationKey, s.llmInfo.displayContentSoFar)

		// a tool is waiting on the user — surface it as an approvalRequest
		if (isRunning === 'awaiting_user')
			this._scanApprovalRequests(threadId, conversationKey)

		// turn end: was running, now not — the only transition that fires once
		// per completed turn ('idle' between agent-loop requests stays truthy)
		const prev = this._lastRunningPhaseOfThreadId.get(threadId)
		if (prev !== undefined && isRunning === undefined) {
			this._lastRunningPhaseOfThreadId.delete(threadId)
			if (s?.error) {
				if (this._lastErrorMessageOfThreadId.get(threadId) !== s.error.message) {
					this._lastErrorMessageOfThreadId.set(threadId, s.error.message)
					this._postOutbound({ type: 'error', conversationKey, message: s.error.message })
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

		for (const m of thread.messages) {
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
			})
		}
	}

	private _scanApprovalRequests(threadId: string, conversationKey: string): void {
		const thread = this._chatThreadService.getThreadWithMessages(threadId)
		if (!thread) return

		for (const m of thread.messages) {
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

	private _postFinal(threadId: string, conversationKey: string): void {
		const thread = this._chatThreadService.getThreadWithMessages(threadId)
		if (!thread) return
		const lastAssistant = [...thread.messages].reverse().find(m => m.role === 'assistant')
		const usage: LLMUsage | undefined = this._chatThreadService.latestUsageOfThreadId[threadId]
		this._postOutbound({
			type: 'final',
			conversationKey,
			text: lastAssistant?.displayContent ?? '',
			usage,
		})
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
