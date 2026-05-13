/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { builtinToolNames, chat_userMessageContent, isABuiltinToolName, visionHelper_systemMessage, visionHelper_userMessage } from '../common/prompt/prompts.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { AnthropicReasoning, getErrorMessage, type LLMUsage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { approvalIsWorkspaceScoped, approvalTypeOfBuiltinToolName, BuiltinToolCallParams, normalizeAutoApproveMode, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, CompactionInfo, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY, PINNED_THREADS_STORAGE_KEY, THREAD_INDEX_KEY, THREAD_KEY_PREFIX, THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { IRequestTelemetryService } from './requestTelemetryService.js';
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService, toWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { basename as resourceBasename } from '../../../../base/common/resources.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { buildTestMessages, runSimulatedStream } from './chatThreadDevTools.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500

const classifyToolError = (msg: string): string => {
	if (msg.includes('appears multiple times')) return 'not_unique'
	if (msg.includes('no match for')) return 'not_found'
	if (msg.includes('had overlap with')) return 'has_overlap'
	if (msg.includes('ENOENT')) return 'file_not_found'
	return 'unknown'
}


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	// Terminal snapshots are deliberately never deduped — each capture is a
	// distinct point in time, even if the user attaches the same `npm test` twice.
	// The synthetic URI is unique per snapshot so the fsPath check below would
	// already not match, but exit early to avoid relying on that detail.
	if (newSelection.type === 'Terminal') return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.type === 'Terminal') continue

		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// Last-seen token usage from the LLM for this thread. Persisted so the
	// context-usage ring shows a value immediately on reload (instead of only
	// after the user sends a new message).
	latestUsage?: LLMUsage;

	// Sum of `LLMUsage` across every API request ever made on this thread.
	// In an agent loop with N tool calls, the loop fires N sequential requests
	// each carrying the full history + accumulated tool results — total billed
	// tokens are O(N²) while `latestUsage` only shows the latest request (O(N)).
	// This field surfaces the real cumulative cost so the user can see actual
	// billing impact, not just the last sample. Persisted alongside latestUsage.
	cumulativeUsageThisThread?: LLMUsage;

	// Perf 2 — compaction visibility. Populated by `_recordCompaction` whenever
	// `compactToolResultsForRequest` fires for a request on this thread. `latestCompaction`
	// reflects the most recent request's trim summary (undefined if the last request
	// did not trim anything); `cumulativeCompactionThisThread` is the lifetime sum
	// so users can see how much prompt-size pressure was relieved across the whole chat.
	// Persisted alongside latestUsage so the TokenUsageRing tooltip keeps its compaction
	// badge after a reload.
	latestCompaction?: CompactionInfo;
	cumulativeCompactionThisThread?: CompactionInfo;

	// Model used to send the most recent user message on this thread. Captured
	// on send, restored on `switchToThread` (writes to settings' `Chat` model
	// selection). `null` means "no message was sent on this thread yet"; if the
	// provider/model no longer exists or is hidden, the restore is skipped and
	// the user keeps whatever model is currently globally selected.
	lastUsedModelSelection?: ModelSelection | null;

	// Snapshot of `.voidrules` content as it was at the most recent user message
	// send on this thread. Compared against the current on-disk content at send
	// time to detect rule edits between turns; when a change is detected we flag
	// the outgoing user message with `rulesChangedBefore: true` so the UI can
	// render a small chip above it. Persisted so changes made while Void is
	// closed are still detected on the next send in an existing thread. Undefined
	// before the first message is sent on a thread (no baseline → first send
	// doesn't flag, only subsequent sends can).
	lastAppliedRules?: string;

	// Full combined AI instructions (globalAIInstructions + .voidrules) frozen
	// on the thread's first send. Passed to prepareLLMChatMessages on every
	// subsequent request so the system-message prefix is byte-identical across
	// turns, keeping the provider's prefix cache warm. Undefined before the
	// first send (no baseline yet).
	frozenAiInstructions?: string;

	// ===== Workspace scoping (Phase E — workspace-scoped chats) =====
	// Stable per-workspace identity captured at thread creation time. URI string
	// of the folder (single-folder workspace) or `.code-workspace` file (multi-root).
	// Used as the filter key in the default thread list — a thread is "yours"
	// when `workspaceUri === currentWorkspaceUri || workspaceUri === undefined`.
	// Undefined for: (a) legacy threads created before this field existed —
	// remain visible in every workspace's list as "unscoped" until explicitly
	// Moved (= claimed); (b) threads created with no folder open. Renaming a
	// folder will break the link (accepted edge case — recovery via Move-here
	// from the "Other workspaces" group). Storage stays APPLICATION-scoped,
	// the workspace boundary is purely a logical filter.
	workspaceUri?: string;

	// Human-readable workspace name captured at thread creation, NOT derived
	// dynamically from `workspaceUri` — that way a thread from a workspace whose
	// folder has been deleted still shows a sensible label in the "Other
	// workspaces" group instead of a raw URI. Falls back to URI basename when
	// no friendlier name is available.
	workspaceLabel?: string;

	// Provenance — set ONLY by `copyThreadToCurrentWorkspace` (Move re-tags in
	// place and leaves these undefined; the thread *is* the original, just
	// relocated). Used by the tab-strip imported-icon tooltip ("Imported from
	// workspace X on Y") and reserved for future "find original" tooling.
	// Storing both URI and the source thread id is intentional — URI tells the
	// user *where* the original lived; thread id lets us follow the link
	// programmatically later if we ever build a "trace ancestry" feature.
	importedFromWorkspaceUri?: string;
	importedFromThreadId?: string;
	importedAt?: number; // unix ms

	// User-provided override of the auto-derived tab / history label. When
	// non-empty, used as the display label everywhere; when undefined or
	// whitespace-only, the UI falls back to the first user message's
	// `displayContent` (and finally to "New Chat" for empty threads). Lets
	// users curate their tab strip without editing message content.
	// Persisted as part of the thread blob — no separate storage key.
	customTitle?: string;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only

	// Ordered list of thread ids shown as tabs in the chat sidebar header
	// for THIS workspace. Entirely a UI-pin concept — removing an id from
	// here does NOT delete the thread (it remains accessible via history).
	//
	// Phase E — this is a *projection* of the current workspace's bucket of
	// `_pinnedThreadIdsByWorkspace` (the source of truth). Pins are per-
	// workspace: the same thread can be pinned in workspace A and workspace
	// B independently (e.g. a thread owned by A and opened read-only in B).
	// Persisted under PINNED_THREADS_STORAGE_KEY as the full map; this
	// state field is re-derived on every mutation via
	// `_setPinsForCurrentWorkspace`.
	pinnedThreadIds: string[];

	// Phase E — current window's workspace identity. Resolved once at service
	// construction (`_getCurrentWorkspaceIdentity`) and held here so React
	// consumers can derive `isThreadInScope(thread)` without re-injecting the
	// workspace service everywhere. Undefined for empty-window startups
	// (no folder open) — those windows see only unscoped (`workspaceUri ===
	// undefined`) threads in their default list. Workspace identity is treated
	// as constant across a single window lifetime; switching workspaces opens
	// a new window with a fresh service instance.
	currentWorkspaceUri?: string;
}

// Phase E — true if this thread belongs in the current workspace's default
// list. Two cases qualify: (a) the thread was tagged with the same workspace,
// or (b) the thread is "unscoped" (legacy / pre-feature, or created in an
// empty window) — those float across workspaces until claimed by Move. Used
// by both the sidebar tab strip filter and the history list filter so the
// rule lives in exactly one place.
export const isThreadInWorkspaceScope = (thread: Pick<ThreadType, 'workspaceUri'> | undefined, currentWorkspaceUri: string | undefined): boolean => {
	if (!thread) return false
	if (!thread.workspaceUri) return true // unscoped → visible everywhere
	return thread.workspaceUri === currentWorkspaceUri
}

// Phase E — true if the thread is foreign to this window's workspace and
// therefore must not be mutated from this window. Strict counterpart to
// `isThreadInWorkspaceScope`: only fires for threads explicitly tagged to
// a *different* workspace; unscoped threads are NOT read-only (they're
// shared, claim-on-engagement re-tags them when the user sends). Read-
// only doesn't apply when the current window has no workspace (empty
// window) — there's no "foreign" reference frame to compare against.
//
// Used as the single gating predicate for every mutation entry point on
// `IChatThreadService` (send / edit / approve / reject / checkpoint
// restore / staging selections). Service-level rather than UI-level so
// the read-only invariant holds even if a future UI bug exposes a
// disabled button as still-clickable.
export const isThreadReadOnly = (thread: Pick<ThreadType, 'workspaceUri'> | undefined, currentWorkspaceUri: string | undefined): boolean => {
	if (!thread) return false
	if (!currentWorkspaceUri) return false // empty window: nothing is "foreign"
	if (!thread.workspaceUri) return false // unscoped: shared, not foreign
	return thread.workspaceUri !== currentWorkspaceUri
}

// Phase E commit 4 — true if the thread should show the "Other workspaces"
// banner. Broader than `isThreadReadOnly`: also fires for unscoped threads
// in workspaced windows so the user gets an explicit Copy/Claim affordance
// without losing edit access. The two predicates together produce four
// cases:
//   - same workspace        → banner: no,  read-only: no  (normal)
//   - foreign workspace     → banner: yes, read-only: yes (Copy / Move)
//   - unscoped + workspaced → banner: yes, read-only: no  (Copy / Claim)
//   - empty window          → banner: no,  read-only: no  (no frame)
// Used by the SidebarChat banner placement; the partition predicate in
// the history sidebar uses the same workspace-mismatch rule (`!==`).
export const shouldShowOwnershipBanner = (thread: Pick<ThreadType, 'workspaceUri'> | undefined, currentWorkspaceUri: string | undefined): boolean => {
	if (!thread) return false
	if (!currentWorkspaceUri) return false
	return thread.workspaceUri !== currentWorkspaceUri
}


export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			// Ordered list of tool calls being streamed from the LLM. Most turns have
			// length 0 (pure text) or 1 (single tool call). Providers that support
			// parallel tool calling (OpenAI, Anthropic, Gemini) may emit multiple.
			// Tools are executed serially by the agent loop in this order.
			toolCallsSoFar: RawToolCallObj[];
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			rawParamsStr?: string;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

// Caller (always `chatThreadService`) is responsible for resolving workspace
// identity from `IWorkspaceContextService` and passing it in. Kept as a free
// function rather than promoted to a method so the construction shape stays
// auditable in one place — the only legitimate creators are `openNewThread`
// (and the Phase-E import flow once it lands). Both `workspaceUri` and
// `workspaceLabel` are intentionally optional: empty-window / no-folder
// startup leaves them undefined and the resulting thread becomes "unscoped"
// (visible in every workspace's list until explicitly Moved). Importantly
// we do NOT default to a string like "(no workspace)" — undefined is the
// load-bearing signal that distinguishes "legacy / unscoped" from "tagged".
const newThreadObject = (workspace?: { uri?: string, label?: string }) => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		workspaceUri: workspace?.uri,
		workspaceLabel: workspace?.label,
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent
	readonly latestUsageOfThreadId: { [threadId: string]: LLMUsage | undefined }; // hydrated from persisted threads on startup; updated as the model streams
	// Cumulative usage across all requests in the *current* user turn (reset
	// when a new user message is sent or a thread is opened/switched-to fresh).
	// Only lives in memory — not persisted, since "this turn" doesn't survive
	// a reload anyway.
	readonly cumulativeUsageThisTurnOfThreadId: { [threadId: string]: LLMUsage | undefined };
	// Cumulative usage across the entire thread history. Hydrated from the
	// persisted thread on startup so the user can see lifetime cost across
	// reloads.
	readonly cumulativeUsageThisThreadOfThreadId: { [threadId: string]: LLMUsage | undefined };

	// Perf 2 compaction telemetry — same shape as the usage maps above. `latest…`
	// reflects the most recent request only (undefined if it didn't compact);
	// `cumulative…` sums every compaction that fired on the thread. Consumed by
	// the TokenUsageRing tooltip to show a "compacted N results / saved ~Xk tokens"
	// badge so users can see when the prompt was shrunk server-side.
	readonly latestCompactionOfThreadId: { [threadId: string]: CompactionInfo | undefined };
	readonly cumulativeCompactionThisTurnOfThreadId: { [threadId: string]: CompactionInfo | undefined };
	readonly cumulativeCompactionThisThreadOfThreadId: { [threadId: string]: CompactionInfo | undefined };

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// tab-strip pinning (does not affect existence — only the chat-header tab row)
	pinThread(threadId: string): void;
	unpinThread(threadId: string): void;

	// Reorders a pinned thread to sit immediately before/after `targetThreadId`
	// in the current workspace's tab strip. Both source and target must already
	// be pinned in this workspace; mismatched / unknown ids no-op. Returns
	// `true` when the order changed. Mirrors `reorderCustomModel` in shape.
	reorderPinnedThread(threadId: string, targetThreadId: string, position: 'before' | 'after'): boolean;

	// User-editable tab label override. Pass `undefined` (or whitespace) to
	// reset to the auto-derived first-user-message label. Gated by
	// `_isThreadMutationBlocked` — read-only foreign threads cannot be
	// renamed from this window (consistent with the rest of Phase E).
	setThreadCustomTitle(threadId: string, title: string | undefined): void;

	// Phase E commit 4 — claim a foreign thread into the current workspace.
	// Both auto-pin to this workspace's tab strip on completion.
	//   copy: clone source, reset usage counters, stamp importedFrom*. Source untouched.
	//   move: re-tag source workspaceUri to current. Source disappears from its origin workspace.
	// Both return the id the user is now looking at (new id for copy, same id for move).
	copyThreadToCurrentWorkspace(threadId: string): string | undefined;
	moveThreadToCurrentWorkspace(threadId: string): string | undefined;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, _pendingImageBytes, modelSelectionOptionsOverride }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, _pendingImageBytes?: Map<string, Uint8Array>, modelSelectionOptionsOverride?: ModelSelectionOptions }): Promise<void>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>

	// Dev-only: populate the current thread with a large fake conversation
	// for performance testing.
	_populateTestThread(turns?: number): void;
	// Dev-only: simulate a streaming LLM response through the real render
	// pipeline. Tests streaming perf (issue #3).
	_simulateStream(opts?: { charsPerChunk?: number, intervalMs?: number, includeReasoning?: boolean, repetitions?: number }): void;
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	// Per-thread latest LLM request id (from IRequestTelemetryService). Tool
	// executions triggered by that request read this map to attribute themselves
	// to the emitting rid. Ephemeral / not persisted.
	private readonly _telemetryRidByThread = new Map<string, string>()
	private readonly _pendingImageBytesByThread = new Map<string, Map<string, Uint8Array>>()
	readonly latestUsageOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
	readonly cumulativeUsageThisTurnOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
	readonly cumulativeUsageThisThreadOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
	readonly latestCompactionOfThreadId: { [threadId: string]: CompactionInfo | undefined } = {}
	readonly cumulativeCompactionThisTurnOfThreadId: { [threadId: string]: CompactionInfo | undefined } = {}
	readonly cumulativeCompactionThisThreadOfThreadId: { [threadId: string]: CompactionInfo | undefined } = {}
	state: ThreadsState // allThreads is persisted, currentThread is not

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IRequestTelemetryService private readonly _requestTelemetryService: IRequestTelemetryService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string, pinnedThreadIds: [] } // default state

		const readThreads = this._loadAllThreads() || {}

		const allThreads = readThreads

		// Phase E — resolve current workspace identity once at startup. Used
		// both as the filter key for the default thread list AND as the
		// dictionary key for `_lastActiveThreadIdByWorkspace`. Treat as
		// constant for the window's lifetime; multi-root folder edits are
		// rare enough that "stale until reload" is fine.
		const currentWorkspace = this._getCurrentWorkspaceIdentity()

		// Phase E — hydrate per-workspace pin map. Reader handles v1→v2
		// migration, ghost-id filtering, and empty-bucket pruning.
		Object.assign(this._pinnedThreadIdsByWorkspace, this._readPinnedThreadIdsByWorkspace(allThreads))
		const currentPins = this._pinnedThreadIdsByWorkspace[currentWorkspace.uri ?? ''] ?? []

		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // set below by openNewThread() or restore-last-active
			pinnedThreadIds: currentPins,
			currentWorkspaceUri: currentWorkspace.uri,
		}

		// hydrate in-memory latestUsage map from the persisted threads so the
		// context-usage ring shows the last-known values right after a reload
		for (const id in allThreads) {
			const t = allThreads[id]
			if (t?.latestUsage) this.latestUsageOfThreadId[id] = t.latestUsage
			if (t?.cumulativeUsageThisThread) this.cumulativeUsageThisThreadOfThreadId[id] = t.cumulativeUsageThisThread
			if (t?.latestCompaction) this.latestCompactionOfThreadId[id] = t.latestCompaction
			if (t?.cumulativeCompactionThisThread) this.cumulativeCompactionThisThreadOfThreadId[id] = t.cumulativeCompactionThisThread
		}

		// Phase E — hydrate the per-workspace "last active" map so we can
		// restore where the user left off in *this* workspace, even when other
		// workspaces' threads were touched more recently.
		Object.assign(this._lastActiveThreadIdByWorkspace, this._readLastActiveThreadIdByWorkspace())

		// Migration: re-tag threads that used the old volatile
		// `void-untitled-workspace://<workspace.id>` URI to the current
		// identity. Also merge pin buckets and last-active entries.
		const wsUri = currentWorkspace.uri
		if (wsUri) {
			let migrated = 0
			const oldKeys: string[] = []
			for (const id in allThreads) {
				const t = allThreads[id]
				if (!t?.workspaceUri) continue
				if (t.workspaceUri === wsUri) continue
				const isOldUntitledPrefix = t.workspaceUri.startsWith('void-untitled-workspace://')
			const isOldTempWorkspaceJson = t.workspaceUri.endsWith('/workspace.json')
			if (!isOldUntitledPrefix && !isOldTempWorkspaceJson) continue
				if (!oldKeys.includes(t.workspaceUri)) oldKeys.push(t.workspaceUri)
				t.workspaceUri = wsUri
				t.workspaceLabel = currentWorkspace.label
				this._storeThread(id, t)
				migrated++
			}
			for (const oldKey of oldKeys) {
				const oldPins = this._pinnedThreadIdsByWorkspace[oldKey]
				if (oldPins?.length) {
					const cur = this._pinnedThreadIdsByWorkspace[wsUri] ?? []
					this._pinnedThreadIdsByWorkspace[wsUri] = [...new Set([...cur, ...oldPins])]
				}
				delete this._pinnedThreadIdsByWorkspace[oldKey]
				if (!this._lastActiveThreadIdByWorkspace[wsUri] && this._lastActiveThreadIdByWorkspace[oldKey]) {
					this._lastActiveThreadIdByWorkspace[wsUri] = this._lastActiveThreadIdByWorkspace[oldKey]
				}
				delete this._lastActiveThreadIdByWorkspace[oldKey]
			}
			if (migrated > 0) {
				this.state.pinnedThreadIds = this._pinnedThreadIdsByWorkspace[wsUri] ?? []
				this._storePinnedThreadIdsByWorkspace()
				this._storeLastActiveThreadIdByWorkspace()
				console.log(`[void/chat] migrated ${migrated} thread(s) from old void-untitled-workspace:// URI to ${wsUri}`)
			}
		}

		// Phase E — startup landing. `_normalizeCurrentThreadInScope` runs a
		// 3-step cascade: per-workspace last-active (pinned & in scope) →
		// newest pinned in-scope → openNewThread. Restricting to pinned at
		// each pre-create step avoids "tab strip silently grows on every
		// reload" and "active thread has no highlighted tab", both of which
		// surfaced during commit-2 testing.
		this._normalizeCurrentThreadInScope()

		// Phase E — multi-window state sync for the small per-workspace
		// dicts (pins + last-active). Without these listeners, opening
		// a thread or pinning/unpinning in window A wouldn't reach
		// window B until B reloads — particularly visible after
		// `moveThreadToCurrentWorkspace` re-tags a thread away from
		// another open window, leaving a ghost tab there until reload.
		//
		// Deliberately not listening on per-thread storage keys:
		// applying an external thread write would overwrite any
		// in-flight stream / mid-edit state in this window. In
		// practice thread desyncs only matter for "see threads
		// created in another window without reload", which users
		// notice less than the pin/tab issue.
		//
		// `e.external` filter is essential — every local store call
		// also fires the same event; without the filter we'd loop
		// (re-read → _setState → React re-render → no real-world cost
		// but a lot of needless work).
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, PINNED_THREADS_STORAGE_KEY, this._store)(e => {
			if (!e.external) return
			const fresh = this._readPinnedThreadIdsByWorkspace(this.state.allThreads)
			for (const k of Object.keys(this._pinnedThreadIdsByWorkspace)) delete this._pinnedThreadIdsByWorkspace[k]
			Object.assign(this._pinnedThreadIdsByWorkspace, fresh)
			const newPins = this._pinnedThreadIdsByWorkspace[this._currentPinKey()] ?? []
			const oldPins = this.state.pinnedThreadIds
			const samePins = newPins.length === oldPins.length && newPins.every((id, i) => id === oldPins[i])
			if (!samePins) this._setState({ pinnedThreadIds: newPins })
		}))
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY, this._store)(e => {
			if (!e.external) return
			const fresh = this._readLastActiveThreadIdByWorkspace()
			for (const k of Object.keys(this._lastActiveThreadIdByWorkspace)) delete this._lastActiveThreadIdByWorkspace[k]
			Object.assign(this._lastActiveThreadIdByWorkspace, fresh)
			// Intentionally not auto-switching the current thread when this
			// changes externally. That would yank the user's focus to a
			// different thread because another window happened to switch —
			// jarring at best, lost-work at worst if the user was mid-typing.
			// The map is consulted by `_normalizeCurrentThreadInScope` on
			// reload / workspace changes, so fresh values land naturally
			// without disrupting the in-progress session.
		}))

		// Capture live dropdown changes onto whichever thread is currently in
		// focus, so switching tabs round-trips the chosen model even when no
		// message was sent. Without this listener, the field is only written
		// at send time (see `_addUserMessageAndStreamResponse`) and an "unsent"
		// dropdown change would be lost on tab switch.
		//
		// Races are benign: `switchToThread` itself calls
		// `setModelSelectionOfFeature` which will fire this listener back, but
		// by the time it fires `currentThreadId` is already the new thread and
		// the equality check in `_setThreadLastUsedModelSelection` skips the
		// redundant write.
		let lastSeenChatModel = this._settingsService.state.modelSelectionOfFeature['Chat']
		this._register(this._settingsService.onDidChangeState(() => {
			const current = this._settingsService.state.modelSelectionOfFeature['Chat']
			const unchanged = (
				(!lastSeenChatModel && !current) ||
				(!!lastSeenChatModel && !!current
					&& lastSeenChatModel.providerName === current.providerName
					&& lastSeenChatModel.modelName === current.modelName)
			)
			if (unchanged) return
			lastSeenChatModel = current
			const threadId = this.state.currentThreadId
			if (threadId && this.state.allThreads[threadId]) {
				this._setThreadLastUsedModelSelection(threadId, current)
			}
		}))


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		// Remove all per-thread storage keys before wiping state
		for (const id of Object.keys(this.state.allThreads)) {
			this._storageService.remove(THREAD_KEY_PREFIX + id, StorageScope.APPLICATION)
		}
		this._storageService.remove(THREAD_INDEX_KEY, StorageScope.APPLICATION)
		this._storageService.remove(THREAD_STORAGE_KEY, StorageScope.APPLICATION)

		this.state = {
			allThreads: {},
			currentThreadId: null as unknown as string, // see constructor
			pinnedThreadIds: [],
			currentWorkspaceUri: this.state.currentWorkspaceUri, // preserve identity across a reset
		}
		// Wipe every workspace's pin bucket on reset — `resetState` is the
		// "nuclear option" for clearing user data, scope-agnostic.
		for (const k of Object.keys(this._pinnedThreadIdsByWorkspace)) delete this._pinnedThreadIdsByWorkspace[k]
		this._storePinnedThreadIdsByWorkspace()
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private static _storageReviver(_key: string, value: any): any {
		if (value && typeof value === 'object' && value.$mid === 1) {
			return URI.from(value);
		}
		return value;
	}

	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, ChatThreadService._storageReviver);
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	// ── Per-thread storage ─────────────────────────────────────────────────
	// Each thread is stored under its own key (`void.chatThread.{id}`) so
	// that saving one thread doesn't re-serialize the entire map. A small
	// index key (`void.chatThreadIndex`) stores just the list of thread IDs.

	/**
	 * Persist a single thread. Serialization is deferred and coalesced: rapid
	 * back-to-back writes for the same thread (usage + compaction + message
	 * commit) only produce a single `JSON.stringify` call after a short delay,
	 * keeping the main thread free for rendering.
	 *
	 * Deletes are synchronous (cheap — just removing a key).
	 * Index writes for create/delete are also synchronous.
	 */
	private readonly _pendingThreadWrites = new Map<string, ThreadType>()
	private _storeThreadFlushScheduler: RunOnceScheduler | null = null

	private _storeThread(threadId: string, thread: ThreadType | undefined, updateIndex = false) {
		if (thread === undefined) {
			this._pendingThreadWrites.delete(threadId)
			this._storageService.remove(THREAD_KEY_PREFIX + threadId, StorageScope.APPLICATION)
			this._writeThreadIndex({ removed: threadId })
			return
		}

		this._pendingThreadWrites.set(threadId, thread)
		if (updateIndex) this._writeThreadIndex({ added: threadId })

		if (!this._storeThreadFlushScheduler) {
			this._storeThreadFlushScheduler = new RunOnceScheduler(() => this._flushPendingThreadWrites(), 500)
			this._register(this._storeThreadFlushScheduler)
		}
		if (!this._storeThreadFlushScheduler.isScheduled()) {
			this._storeThreadFlushScheduler.schedule()
		}
	}

	private _flushPendingThreadWrites() {
		if (this._pendingThreadWrites.size === 0) return
		for (const [id, thread] of this._pendingThreadWrites) {
			this._storageService.store(THREAD_KEY_PREFIX + id, JSON.stringify(thread), StorageScope.APPLICATION, StorageTarget.USER)
		}
		this._pendingThreadWrites.clear()
	}

	private _writeThreadIndex(delta?: { added?: string, removed?: string }) {
		const baseIds = Object.keys(this.state.allThreads).filter(id => this.state.allThreads[id] !== undefined)
		const ids = new Set(baseIds)
		if (delta?.added) ids.add(delta.added)
		if (delta?.removed) ids.delete(delta.removed)
		this._storageService.store(THREAD_INDEX_KEY, JSON.stringify([...ids]), StorageScope.APPLICATION, StorageTarget.USER)
	}

	private _readThread(threadId: string): ThreadType | undefined {
		const raw = this._storageService.get(THREAD_KEY_PREFIX + threadId, StorageScope.APPLICATION)
		if (!raw) return undefined
		return JSON.parse(raw, ChatThreadService._storageReviver) as ThreadType
	}

	private _readAllThreadsSplit(): ChatThreads | null {
		const indexStr = this._storageService.get(THREAD_INDEX_KEY, StorageScope.APPLICATION)
		if (!indexStr) return null
		const ids: string[] = JSON.parse(indexStr)
		if (ids.length === 0) return null
		const threads: ChatThreads = {}
		for (const id of ids) {
			threads[id] = this._readThread(id)
		}
		return threads
	}

	/** One-time migration: split the old single-blob into per-thread keys, then remove the old key. */
	private _migrateToPerThreadStorage(): ChatThreads | null {
		const oldBlob = this._readAllThreads()
		if (!oldBlob) return null
		const ids = Object.keys(oldBlob).filter(id => oldBlob[id] !== undefined)
		if (ids.length === 0) return null
		for (const id of ids) {
			const thread = oldBlob[id]
			if (thread) {
				this._storageService.store(THREAD_KEY_PREFIX + id, JSON.stringify(thread), StorageScope.APPLICATION, StorageTarget.USER)
			}
		}
		this._storageService.store(THREAD_INDEX_KEY, JSON.stringify(ids), StorageScope.APPLICATION, StorageTarget.USER)
		this._storageService.remove(THREAD_STORAGE_KEY, StorageScope.APPLICATION)
		console.log(`[void] Migrated ${ids.length} threads to per-thread storage`)
		return oldBlob
	}

	/** Load threads: try per-thread first, fall back to old blob + migrate. */
	private _loadAllThreads(): ChatThreads | null {
		const split = this._readAllThreadsSplit()
		if (split) return split
		return this._migrateToPerThreadStorage()
	}

	// Phase E — per-workspace pin storage. Key = workspaceUri (real folder
	// or `.code-workspace` config path or synthetic `void-untitled-workspace://...`)
	// — same key shape as `_lastActiveThreadIdByWorkspace`. Empty string `''`
	// is the sentinel for empty-window pins so users can still maintain a
	// tab strip in folder-less windows; this bucket is shared across all
	// empty windows by design (there's no workspace identity to disambiguate).
	//
	// Source of truth lives here on the service; `state.pinnedThreadIds`
	// is just a projection of this map's current-workspace bucket and gets
	// re-derived on every mutation (see `_setPinsForCurrentWorkspace`).
	private readonly _pinnedThreadIdsByWorkspace: Record<string, string[]> = {}

	// Storage shape v1: `string[]` (single global pin list).
	// Storage shape v2: `Record<workspaceUri, string[]>` (per-workspace).
	// Reads tolerate both shapes; v1 is migrated by distributing each pinned
	// id into its owning workspace's bucket, with unscoped pins dropped per
	// the agreed migration policy (user re-pins via history click if they
	// want them back). v1 self-heals on first interaction post-upgrade —
	// `_storePinnedThreadIdsByWorkspace` re-serializes under the v2 shape.
	//
	// `allThreads` is required for both the v1 migration (ownership lookup)
	// and the ghost-id filter applied to v2 (a pinned id whose thread was
	// deleted on another machine never makes it into the in-memory map, so
	// the tab strip can't render it). Empty buckets are dropped to keep
	// storage tidy.
	private _readPinnedThreadIdsByWorkspace(allThreads: ChatThreads): Record<string, string[]> {
		const s = this._storageService.get(PINNED_THREADS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!s) return {};
		let parsed: unknown
		try { parsed = JSON.parse(s); } catch { return {}; }
		const out: Record<string, string[]> = {}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			// v2: already the right shape.
			for (const k of Object.keys(parsed as Record<string, unknown>)) {
				const v = (parsed as Record<string, unknown>)[k]
				if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string')
			}
		} else if (Array.isArray(parsed)) {
			// v1 → v2: distribute by ownership. Unscoped pins are dropped.
			for (const id of parsed) {
				if (typeof id !== 'string') continue
				const t = allThreads[id]
				if (!t || !t.workspaceUri) continue
				if (!out[t.workspaceUri]) out[t.workspaceUri] = []
				out[t.workspaceUri].push(id)
			}
			console.log('[void/chat] migrated v1 pinned-thread storage to per-workspace shape', { workspaces: Object.keys(out).length, totalPins: Object.values(out).reduce((n, a) => n + a.length, 0) })
		}
		// Filter ghosts + drop empty buckets in a single pass.
		for (const k of Object.keys(out)) {
			out[k] = out[k].filter(id => !!allThreads[id])
			if (out[k].length === 0) delete out[k]
		}
		return out
	}

	private _storePinnedThreadIdsByWorkspace() {
		this._storageService.store(
			PINNED_THREADS_STORAGE_KEY,
			JSON.stringify(this._pinnedThreadIdsByWorkspace),
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}

	// The sentinel key under which empty-window pins live. Empty string keeps
	// it visually distinct from any real URI (which always have a scheme).
	private _currentPinKey(): string {
		return this.state.currentWorkspaceUri ?? ''
	}

	// Single mutation entry point: updates the underlying map, reflects to
	// state.pinnedThreadIds, and persists. All pin/unpin/reorder/delete
	// paths funnel through this so the three-way consistency (map, state,
	// storage) is impossible to break. Empty buckets are pruned to match
	// the reader's empty-pruning behavior — keeps storage shape stable.
	private _setPinsForCurrentWorkspace(newPins: string[], extraStateUpdate?: Partial<ThreadsState>) {
		const key = this._currentPinKey()
		if (newPins.length === 0) delete this._pinnedThreadIdsByWorkspace[key]
		else this._pinnedThreadIdsByWorkspace[key] = newPins
		this._storePinnedThreadIdsByWorkspace()
		this._setState({ pinnedThreadIds: newPins, ...(extraStateUpdate ?? {}) })
	}

	// Phase E — persist the per-workspace "last active thread" map. Lives in
	// its own storage key (not bundled into THREAD_STORAGE_KEY) so this
	// frequently-updated tiny blob never re-serializes the full thread payload.
	private readonly _lastActiveThreadIdByWorkspace: Record<string, string> = {}
	private _readLastActiveThreadIdByWorkspace(): Record<string, string> {
		const s = this._storageService.get(LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY, StorageScope.APPLICATION)
		if (!s) return {}
		try {
			const parsed = JSON.parse(s)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
			// Defensive: keep only string→string entries. Storage corruption
			// (or a future shape change) should degrade to "no memory of last
			// active" rather than crash on first thread switch.
			const out: Record<string, string> = {}
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof k === 'string' && typeof v === 'string') out[k] = v
			}
			return out
		} catch { return {} }
	}

	private _storeLastActiveThreadIdByWorkspace() {
		this._storageService.store(
			LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY,
			JSON.stringify(this._lastActiveThreadIdByWorkspace),
			StorageScope.APPLICATION,
			StorageTarget.USER
		)
	}

	// Phase E — drop every `lastActive[ws]` entry that currently points at
	// `threadId`. Called from unpin / delete. Without this, the next reload
	// would re-restore the just-unpinned thread via the normalize cascade,
	// effectively making unpin a no-op ("I closed this thread but it
	// always comes back"). Particularly bad for legacy unscoped threads,
	// which pass `isThreadInWorkspaceScope` for any workspace and could
	// otherwise be resurrected by foreign-window restores too.
	private _clearLastActiveEntriesForThread(threadId: string): void {
		let changed = false
		for (const [ws, id] of Object.entries(this._lastActiveThreadIdByWorkspace)) {
			if (id === threadId) {
				delete this._lastActiveThreadIdByWorkspace[ws]
				changed = true
			}
		}
		if (changed) this._storeLastActiveThreadIdByWorkspace()
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, rawParamsStr: lastMessage.rawParamsStr, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		// Any non-throttled state transition (tool, idle, error, undefined, etc.)
		// must supersede any pending throttled stream-text update for this thread,
		// otherwise the delayed flush could overwrite the new authoritative state.
		this._cancelPendingStreamTextUpdate(threadId)
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}

	// Per-thread coalescer for streaming-text updates. LLM chunks can arrive
	// at 30-60Hz; before this throttle, each chunk fired _onDidChangeStreamState
	// which forced a full React re-render of the assistant bubble (full marked
	// re-lex of the entire message + Monaco editor work for code blocks). That
	// saturated the renderer's main thread, causing input lag (queued Enter
	// keypresses) and visible UI freezes. We coalesce to ~20Hz here, which is
	// indistinguishable from real-time visually but bounds per-chunk render cost.
	private readonly _streamTextThrottle = new Map<string, { scheduler: RunOnceScheduler; pending: ThreadStreamState[string] | null }>()

	private _scheduleStreamTextUpdate(threadId: string, state: ThreadStreamState[string]) {
		let entry = this._streamTextThrottle.get(threadId)
		if (!entry) {
			const scheduler = new RunOnceScheduler(() => {
				const e = this._streamTextThrottle.get(threadId)
				if (!e || !e.pending) return
				const pending = e.pending
				e.pending = null
				this.streamState[threadId] = pending
				this._onDidChangeStreamState.fire({ threadId })
			}, 100)
			entry = { scheduler, pending: state }
			this._streamTextThrottle.set(threadId, entry)
		} else {
			entry.pending = state
		}
		if (!entry.scheduler.isScheduled()) entry.scheduler.schedule()
	}

	private _cancelPendingStreamTextUpdate(threadId: string) {
		const entry = this._streamTextThrottle.get(threadId)
		if (!entry) return
		entry.scheduler.cancel()
		entry.pending = null
	}

	// updates per-thread latest usage and re-uses the streamState emitter so existing
	// listeners (and the React mirror in services.tsx) re-read without extra plumbing.
	// Also persists on the thread so the ring shows the last-known value after a reload.
	private _setLatestUsage(threadId: string, usage: LLMUsage) {
		this.latestUsageOfThreadId[threadId] = usage

		// Cumulative = (cumulative locked-in from prior finalized requests in this
		// turn/thread) + (this request's running total). Always recompute from the
		// baseline so streaming updates (which carry the per-request running total,
		// not a delta) don't double-count.
		this.cumulativeUsageThisTurnOfThreadId[threadId] = this._addUsage(this._cumulativeThisTurnBaselineOfThreadId[threadId], usage)
		this.cumulativeUsageThisThreadOfThreadId[threadId] = this._addUsage(this._cumulativeThisThreadBaselineOfThreadId[threadId], usage)

		const thread = this.state.allThreads[threadId]
		if (thread) {
			thread.latestUsage = usage
			thread.cumulativeUsageThisThread = this.cumulativeUsageThisThreadOfThreadId[threadId]
			this._storeThread(threadId, thread)
		}
		this._onDidChangeStreamState.fire({ threadId })
	}

	// Baseline = cumulative usage from previously-finalized requests in this
	// turn/thread. The current request's running total gets added on top in
	// `_setLatestUsage`. Moved forward by `_lockInCurrentRequestUsage` once a
	// request finishes, so the next request starts counting from where we
	// left off.
	private readonly _cumulativeThisTurnBaselineOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
	private readonly _cumulativeThisThreadBaselineOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}

	// Sum two LLMUsage values. `undefined` fields stay undefined unless one of
	// the inputs has a defined value, in which case we fall back to the defined
	// side (so e.g. a request that doesn't report `cachedInputTokens` doesn't
	// erase the previously-accumulated cached count).
	private _addUsage(a: LLMUsage | undefined, b: LLMUsage | undefined): LLMUsage | undefined {
		if (!a) return b ? { ...b } : undefined
		if (!b) return { ...a }
		const add = (x: number | undefined, y: number | undefined): number | undefined => {
			if (x === undefined && y === undefined) return undefined
			return (x ?? 0) + (y ?? 0)
		}
		return {
			inputTokens: add(a.inputTokens, b.inputTokens),
			outputTokens: add(a.outputTokens, b.outputTokens),
			totalTokens: add(a.totalTokens, b.totalTokens),
			reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
			cachedInputTokens: add(a.cachedInputTokens, b.cachedInputTokens),
		}
	}

	// Roll the most recent per-request usage into the cumulative baselines so
	// the next request's running total starts from a fresh zero on top of the
	// locked-in totals. Called once per request (on `onFinalMessage`).
	private _lockInCurrentRequestUsage(threadId: string) {
		const lastUsage = this.latestUsageOfThreadId[threadId]
		if (!lastUsage) return
		this._cumulativeThisTurnBaselineOfThreadId[threadId] = this._addUsage(this._cumulativeThisTurnBaselineOfThreadId[threadId], lastUsage)
		this._cumulativeThisThreadBaselineOfThreadId[threadId] = this._addUsage(this._cumulativeThisThreadBaselineOfThreadId[threadId], lastUsage)
	}

	// Reset the "this turn" counter and its baseline. Called when a new user
	// message starts a fresh turn. Does NOT touch "this thread" — that's
	// lifetime accumulation.
	private _resetCumulativeThisTurn(threadId: string) {
		this.cumulativeUsageThisTurnOfThreadId[threadId] = undefined
		this._cumulativeThisTurnBaselineOfThreadId[threadId] = undefined
		// Mirror the reset for compaction so the tooltip's "this turn" block
		// matches the token-usage "this turn" block semantically.
		this.cumulativeCompactionThisTurnOfThreadId[threadId] = undefined
		this._onDidChangeStreamState.fire({ threadId })
	}

	// Sum two CompactionInfo values. Unlike `_addUsage` there are no optional
	// fields to reconcile — both counters are plain numbers — so we just add.
	private _addCompaction(a: CompactionInfo | undefined, b: CompactionInfo | undefined): CompactionInfo | undefined {
		if (!a) return b ? { ...b } : undefined
		if (!b) return { ...a }
		// Coerce every field through a finite-number guard before summing.
		// `?? 0` is not enough — it only traps `undefined`/`null`, but once a
		// counter has been poisoned with `NaN` (possible with older builds that
		// did `undefined + number`), that NaN gets written back to disk and the
		// next session loads it as `NaN`, for which `NaN ?? 0 === NaN`. So
		// `Number.isFinite` is the only guard that self-heals a previously
		// poisoned persisted counter on the next sum.
		const safe = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n)) ? n : 0
		const aEmTrim = safe(a.emergencyTrimmedCount)
		const bEmTrim = safe(b.emergencyTrimmedCount)
		const aEmChars = safe(a.emergencySavedChars)
		const bEmChars = safe(b.emergencySavedChars)
		const aEmTok = safe(a.emergencySavedTokens)
		const bEmTok = safe(b.emergencySavedTokens)
		const mergedEmTrim = aEmTrim + bEmTrim
		return {
			trimmedCount: safe(a.trimmedCount) + safe(b.trimmedCount),
			savedChars: safe(a.savedChars) + safe(b.savedChars),
			// Sum pre-computed savedTokens rather than re-deriving from savedChars:
			// each CompactionInfo was computed with the calibrated ratio *at the
			// time it ran*, and summing preserves that per-request accuracy.
			// Legacy undefined / NaN sides fall through to 0 here; the UI's
			// `approxTokens` fallback (savedChars/4) still renders a number
			// when the summed savedTokens genuinely underreports vs. savedChars.
			savedTokens: safe(a.savedTokens) + safe(b.savedTokens),
			...(mergedEmTrim > 0 ? {
				emergencyTrimmedCount: mergedEmTrim,
				emergencySavedChars: aEmChars + bEmChars,
				emergencySavedTokens: aEmTok + bEmTok,
			} : {}),
		}
	}

	// Called once per outbound LLM request, right after `prepareLLMChatMessages`
	// reports whether compaction fired. Unlike `_setLatestUsage` (which is
	// re-invoked every streamed token and relies on baseline subtraction),
	// compaction is a one-shot event so we can simply `latest=info` and
	// `cumulative += info`.
	//
	// When `info` is null (no compaction this request) we clear `latest…` so the
	// tooltip shows "Last request: no compaction", matching how `latestUsage`
	// reflects the most recent request rather than the last request that had
	// data. Cumulative counters keep their running totals.
	private _recordCompaction(threadId: string, info: CompactionInfo | null) {
		this.latestCompactionOfThreadId[threadId] = info ?? undefined
		if (info) {
			this.cumulativeCompactionThisTurnOfThreadId[threadId] = this._addCompaction(this.cumulativeCompactionThisTurnOfThreadId[threadId], info)
			this.cumulativeCompactionThisThreadOfThreadId[threadId] = this._addCompaction(this.cumulativeCompactionThisThreadOfThreadId[threadId], info)
		}
		const thread = this.state.allThreads[threadId]
		if (thread) {
			thread.latestCompaction = this.latestCompactionOfThreadId[threadId]
			thread.cumulativeCompactionThisThread = this.cumulativeCompactionThisThreadOfThreadId[threadId]
			this._storeThread(threadId, thread)
		}
		this._onDidChangeStreamState.fire({ threadId })
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}

	// Updates the per-thread `.voidrules` snapshot used for rule-change detection
	// on the next send. Persisted so changes made while Void is closed (or in
	// other threads) are still detected correctly when this thread resumes. No
	// state-change event — the stored value is read back on next send and never
	// affects anything currently rendered; the user-message `rulesChangedBefore`
	// flag is what drives the UI chip, and that's set when the NEXT message is
	// stored, not here.
	private _setThreadLastAppliedRules(threadId: string, rules: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		// Skip the (persistent) write if unchanged. Same rationale as
		// `_setThreadLastUsedModelSelection`: avoids rewriting the full threads
		// blob every turn when rules haven't moved.
		if (thread.lastAppliedRules === rules) return

		const updatedThread = { ...thread, lastAppliedRules: rules }
		const newThreads = { ...this.state.allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
	}

	private _setThreadFrozenAiInstructions(threadId: string, instructions: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const updatedThread = { ...thread, frozenAiInstructions: instructions }
		const newThreads = { ...this.state.allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
	}

	// Persists the given model selection on the thread so that a later
	// `switchToThread` can restore the dropdown to whatever the user sent with.
	// Writes through `_storeThread` to survive reloads. No state change
	// event here — the dropdown state lives on `IVoidSettingsService`, not on
	// this service, so there's nothing for chat-UI listeners to re-render.
	private _setThreadLastUsedModelSelection(threadId: string, modelSelection: ModelSelection | null) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		// Skip the (persistent) write if the stored value is already identical.
		// Without this, every user message would rewrite the whole threads blob
		// to storage for no reason.
		const prev = thread.lastUsedModelSelection
		if (
			prev && modelSelection &&
			prev.providerName === modelSelection.providerName &&
			prev.modelName === modelSelection.modelName
		) return
		if (!prev && !modelSelection) return

		const updatedThread = { ...thread, lastUsedModelSelection: modelSelection }
		const newThreads = { ...this.state.allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
	}

	// Returns true iff `sel` points at a provider+model that still exists in
	// settings AND is not currently hidden. Used to decide whether restoring a
	// thread's saved model is safe, or if we should silently fall back to the
	// current global selection (e.g. the user deleted that model in Settings
	// since the thread was last used).
	private _isModelSelectionCurrentlyValid(sel: ModelSelection): boolean {
		const providerSettings = this._settingsService.state.settingsOfProvider[sel.providerName]
		if (!providerSettings) return false
		return providerSettings.models.some(m => m.modelName === sel.modelName && !m.isHidden)
	}



	/**
	 * Transitions a tool message (by id) to a new state in the thread. Before parallel tool
	 * calling this just swapped the last message, which worked because a tool was always
	 * the most recent message at every transition. With batches, tool i may be followed
	 * in the thread by pre-added tool_requests for tools i+1, i+2..., so we search by id.
	 *
	 * If no matching tool is found we append (preserves the original behavior for fresh
	 * tool_request additions by `_runToolCall`'s non-batch path). When a match exists,
	 * we preserve batchIndex/batchSize from the existing row so the UI's (i/N) prefix
	 * doesn't drop across state transitions (tool_request → running_now → success).
	 */
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) { this._addMessageToThread(threadId, tool); return }
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]
			if (m.role === 'tool' && m.id === tool.id) {
				// Preserve batch metadata from the pre-added row — the transitional updates
				// from `_runToolCall` don't know about batchIndex/batchSize.
				const merged = { batchIndex: m.batchIndex, batchSize: m.batchSize, ...tool } as ChatMessage & { role: 'tool' }
				this._editMessageInThread(threadId, i, merged)
				return
			}
		}
		this._addMessageToThread(threadId, tool)
	}

	/**
	 * Returns consecutive trailing `tool_request` messages in the thread — these are the
	 * not-yet-executed tools in the current batch. The user-facing "awaiting approval"
	 * tool is always the FIRST of this list (the batch processor runs them in order, so
	 * any tool before the paused one is already in a terminal state like `success`).
	 */
	private _getPendingBatchTools = (threadId: string): (ToolMessage<ToolName> & { type: 'tool_request' })[] => {
		const messages = this.state.allThreads[threadId]?.messages ?? []
		const pending: (ToolMessage<ToolName> & { type: 'tool_request' })[] = []
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]
			if (m.role === 'tool' && m.type === 'tool_request') pending.unshift(m)
			else break
		}
		return pending
	}

	/**
	 * Runs all currently-pending tool_requests at the tail of the thread, in order.
	 * Each call to `_runToolCall` validates, checks approval, and either runs the tool
	 * or pauses for user approval. Returns:
	 *   - 'awaiting_user' if a tool paused for approval (remaining tools stay pending)
	 *   - 'interrupted' if a tool was interrupted (agent should terminate)
	 *   - 'done' if all pending tools ran to a terminal state
	 */
	private _tryDrainPendingBatch = async (threadId: string): Promise<'done' | 'awaiting_user' | 'interrupted'> => {
		while (true) {
			const pending = this._getPendingBatchTools(threadId)
			if (pending.length === 0) return 'done'
			const next = pending[0]
			const { awaitingUserApproval, interrupted } = await this._runToolCall(
				threadId, next.name, next.id, next.mcpServerName,
				{ preapproved: false, unvalidatedToolParams: next.rawParams, rawParamsStr: next.rawParamsStr }
			)
			if (interrupted) return 'interrupted'
			if (awaitingUserApproval) return 'awaiting_user'
		}
	}

	approveLatestToolRequest(threadId: string) {
		if (this._isThreadMutationBlocked(threadId, 'approveLatestToolRequest')) return
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// In batch mode multiple tool_requests can be pending at the tail of the thread —
		// the one awaiting approval is the FIRST (tools that already ran have transitioned
		// away from tool_request state). Pre-batch code grabbed messages[-1], which silently
		// breaks for batches because later not-yet-started tools are newer in the thread.
		const pending = this._getPendingBatchTools(threadId)
		if (pending.length === 0) return
		const callThisToolFirst = pending[0]

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	/**
	 * Reject a pending tool request.
	 *
	 * `resumeAgent` controls what happens after the rejection:
	 *   - true  (from UI "reject" button): mark this tool + all other pending tools in
	 *           the same batch as `rejected` ("reject-all" semantic), then resume the
	 *           agent loop so the LLM sees the rejections and can react (e.g. ask the
	 *           user what to do next). This keeps the conversation alive.
	 *   - false (from abort/hard-stop path in `abortRunning`): mark rejected and stop.
	 *           The conversation terminates; no further LLM call is made.
	 *
	 * Default is true because the common case is the user clicking the UI reject button.
	 * `abortRunning` explicitly passes false.
	 */
	rejectLatestToolRequest(threadId: string, resumeAgent: boolean = true) {
		// Phase E — block user-initiated rejects on read-only foreign threads.
		// Skip the gate when called as part of `abortRunning` cleanup
		// (`resumeAgent === false`): an abort is allowed to terminate any
		// stale stream that shouldn't have been started, and the alternative
		// (leaving the run-loop alive on a thread we now refuse to mutate)
		// is worse than letting cleanup finish.
		if (resumeAgent && this._isThreadMutationBlocked(threadId, 'rejectLatestToolRequest')) return
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// Reject-all semantics: if the user rejected any tool in a batch, reject all its
		// pending siblings too. Partial execution (run 1 and 2, reject 3, continue to 4)
		// is confusing — the model emitted the batch as an atomic plan, so we either run
		// it or abort it as a unit. Tools that already completed (success/tool_error)
		// retain their terminal state; only pending tool_requests are rejected.
		const pending = this._getPendingBatchTools(threadId)
		if (pending.length === 0) {
			// Fallback to legacy path: last message should be a tool in a non-terminal
			// state. Kept for safety when called from unusual contexts.
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (!(lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params')) return
			const { name, id, rawParams, rawParamsStr, mcpServerName, params } = lastMsg
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params, name, content: this.toolErrMsgs.rejected, result: null, id, rawParams, rawParamsStr, mcpServerName })
			if (!resumeAgent) this._setStreamState(threadId, undefined)
			return
		}

		const rejectedCount = pending.length
		// Mark every pending tool in the batch as rejected. For the one the user actually
		// clicked (the first pending), use the primary rejection message. For the others
		// ("cascade rejections"), use a short explanation so the LLM can distinguish direct
		// vs. cascade rejection when composing its response.
		for (let i = 0; i < pending.length; i++) {
			const p = pending[i]
			const content = i === 0 ? this.toolErrMsgs.rejected : this.toolErrMsgs.rejectedCascade(rejectedCount)
			this._updateLatestTool(threadId, {
				role: 'tool', type: 'rejected',
				params: p.params, name: p.name, content, result: null,
				id: p.id, rawParams: p.rawParams, rawParamsStr: p.rawParamsStr, mcpServerName: p.mcpServerName,
			})
		}

		if (resumeAgent) {
			// Let the LLM see the rejection(s) and respond. No callThisToolFirst —
			// _runChatAgent will loop straight into a new LLM call with the rejected
			// tool results in context.
			this._wrapRunAgentToNotify(
				this._runChatAgent({ threadId, ...this._currentModelSelectionProps() })
				, threadId
			)
		} else {
			this._setStreamState(threadId, undefined)
		}
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallsSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			// For each partially-streamed tool call interrupted mid-flight, add a decorative
			// "interrupted_streaming_tool" marker. Pre-batch this only handled one tool;
			// now we iterate the full list so the UI shows all tools the model was planning.
			for (const tc of toolCallsSoFar) {
				this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: tc.name, mcpServerName: this._computeMCPServerOfToolName(tc.name) })
			}
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, rawParamsStr, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, rawParamsStr, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant. `resumeAgent: false` — abortRunning is
		// a hard stop from the user; we don't want to restart the LLM loop with rejection
		// feedback (which is what the normal reject-button path does).
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId, false)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		// Phrased to discourage the model from immediately retrying the same tool. "Rejected"
		// alone tends to trigger LLMs into "let me try again" behavior, which wastes tokens
		// and annoys the user. Framing it as a signal to pause and consult the user breaks
		// that pattern.
		rejected: 'The user rejected this tool call. Do not retry the same action. Acknowledge the rejection, ask the user what they want you to do differently, or propose an alternative approach.',
		// Used for the "cascade" rejections when the user rejects one tool in a multi-tool
		// batch and reject-all semantics propagates the rejection to its siblings. Tells
		// the model that not running the rest was a side effect of one rejection, not a
		// per-tool decision, so it doesn't over-apologize for each.
		rejectedCascade: (batchSize: number) => `The user rejected the tool batch (${batchSize} tools). This specific tool was skipped as part of that rejection, not individually rejected. See the primary rejection for the user's reasoning.`,
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName>, rawParamsStr?: string } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj, rawParamsStr?: string },
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean }> => {
		// Carry the model's original serialized arguments string (when available) into
		// every tool message we persist. This lets the replay path send byte-identical
		// tool_calls back to the provider, preserving the prefix cache across turns.
		const rawParamsStr = opts.rawParamsStr

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)

		// Early-reject unknown tool names. Without this, any non-builtin name was
		// silently classified as MCP further down, surfaced to the user as a "Call MCP"
		// approval dialog, and only failed *after* approval with "MCP tool X not found".
		// Models occasionally hallucinate tool names — especially DeepSeek thinking on
		// off-topic / gibberish input, or models that were trained against a different
		// tool set (e.g. Cursor's `codebase_search`) — and the old flow forced the user
		// to click "approve" on a call that was guaranteed to fail.
		//
		// Reject here means: no approval prompt, immediate `tool_error` row in the UI,
		// and a structured message back to the LLM listing the names it should use.
		// The LLM sees this as a normal tool error on its next turn and self-corrects.
		const knownMcpToolNames = !isBuiltInTool ? (this._mcpService.getMCPTools()?.map(t => t.name) ?? []) : []
		const isKnownMcpTool = !isBuiltInTool && knownMcpToolNames.includes(toolName)
		if (!isBuiltInTool && !isKnownMcpTool) {
			const validNames = [...builtinToolNames, ...knownMcpToolNames]
			const errorMessage = `Unknown tool: \`${toolName}\`. This tool is not available in this workspace and will not be retried. Valid tool names are: ${validNames.map(n => `\`${n}\``).join(', ') || '(none)'}. Continue without calling tools, or use one of the valid names above.`
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: opts.preapproved ? opts.validatedParams : opts.unvalidatedToolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName })
			this._requestTelemetryService.logTool({
				phase: 'tool',
				t: new Date().toISOString(),
				rid: this._telemetryRidByThread.get(threadId),
				tid: threadId,
				name: toolName,
				status: 'error',
				paramsLen: typeof rawParamsStr === 'string'
					? rawParamsStr.length
					: (() => { try { return JSON.stringify(opts.unvalidatedToolParams ?? {}).length } catch { return 0 } })(),
				resultLen: errorMessage.length,
				durMs: 0,
				mcp: undefined,
			})
			return {}
		}

		// Per-tool telemetry scaffolding. Start-ms is wall-clock at entry so `durMs`
		// covers validation + approval wait + execution + stringification — the full
		// cost of the tool as the user experiences it. `rid` is pulled from the
		// thread-keyed map populated right after `prepareLLMChatMessages` returns.
		const telemetryToolStartMs = Date.now()
		const telemetryRid = this._telemetryRidByThread.get(threadId)
		const telemetryParamsLen = typeof rawParamsStr === 'string'
			? rawParamsStr.length
			: (() => { try { return JSON.stringify(opts.unvalidatedToolParams ?? {}).length } catch { return 0 } })()
		const logToolTelemetry = (status: 'ok' | 'error' | 'invalid_params' | 'interrupted', resultLen?: number, errorReason?: string) => {
			this._requestTelemetryService.logTool({
				phase: 'tool',
				t: new Date().toISOString(),
				rid: telemetryRid,
				tid: threadId,
				name: toolName,
				status,
				errorReason,
				paramsLen: telemetryParamsLen,
				resultLen,
				durMs: Date.now() - telemetryToolStartMs,
				mcp: !isBuiltInTool || undefined,
			})
		}


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				// Use _updateLatestTool (not _addMessageToThread) so that when this tool was
				// pre-added as a `tool_request` by the batch processor, we transition that
				// row in place (preserving batchIndex/batchSize) instead of appending a new one.
				this._updateLatestTool(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, rawParamsStr, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				logToolTelemetry('invalid_params', errorMessage.length)
				return {}
			}
			// once validated, add checkpoint for edit
			if (toolName === 'edit_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }) }
			if (toolName === 'rewrite_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }) }

			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
			if (approvalType) {
				const mode = normalizeAutoApproveMode(this._settingsService.state.globalSettings.autoApprove[approvalType])
				// Tri-state resolution:
				//   'off'       → always prompt
				//   'all'       → skip prompt
				//   'workspace' → skip prompt iff target URI is inside an open workspace folder.
				//                 For non-workspace-scoped tiers ('terminal', 'MCP tools'),
				//                 'workspace' is semantically equivalent to 'all' — commands/MCPs
				//                 don't have a single target URI to scope against and can
				//                 legitimately operate outside the workspace.
				let autoApprove = false
				if (mode === 'all') {
					autoApprove = true
				} else if (mode === 'workspace') {
					if (approvalIsWorkspaceScoped(approvalType) && isBuiltInTool) {
						const targetUri = (toolParams as { uri?: URI } | undefined)?.uri
						autoApprove = !!targetUri && this._workspaceContextService.isInsideWorkspace(targetUri)
					} else {
						autoApprove = true
					}
				}

				// Transition (or create) the tool_request row. _updateLatestTool finds the
				// row by id: for solo tool calls there's no pre-added row and it appends one
				// (same as the old behavior). For batched tool calls, the batch processor
				// pre-added a tool_request with batchIndex/batchSize, and this call now
				// replaces its placeholder unvalidated params with the validated ones while
				// preserving the batch metadata.
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName })
				if (!autoApprove) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName } })

			if (isBuiltInTool) {
				const { result, interruptTool } = await this._toolsService.callTool[toolName](toolParams as any)
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				resolveInterruptor(() => { })

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					toolName: toolName,
					params: toolParams
				})).result
			}

			if (interrupted) { logToolTelemetry('interrupted'); return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { logToolTelemetry('interrupted'); return { interrupted: true } } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName })
			const reason = classifyToolError(errorMessage)
			logToolTelemetry('error', errorMessage.length, reason)
			return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName })
			logToolTelemetry('error', errorMessage.length, 'stringify')
			return {}
		}

		// 5. add to history and keep going
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, rawParamsStr, mcpServerName })
		logToolTelemetry('ok', toolResultStr.length)
		return {}
	};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
	}) {


		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined

		// before enter loop, call tool
		if (callThisToolFirst) {
			// Run the just-approved tool, then drain any remaining pending batch siblings
			// (tools pre-added when the batch started and not yet run). Each drained tool
			// may pause for its own approval — we stop the agent in that case and return.
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, rawParamsStr: callThisToolFirst.rawParamsStr, validatedParams: callThisToolFirst.params })
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })
				return
			}
			// Drain the remaining pending batch (if there are other tools from this turn
			// that still need to run). If any of them pauses for approval, stop here — the
			// agent will resume when the user next approves or rejects.
			const drainRes = await this._tryDrainPendingBatch(threadId)
			if (drainRes === 'interrupted') {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })
				return
			}
			if (drainRes === 'awaiting_user') {
				this._setStreamState(threadId, { isRunning: 'awaiting_user' })
				return
			}
			// drainRes === 'done': fall through to the main LLM loop below.
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			// Pass the previous request's total content size (input + output tokens)
			// so `prepareLLMChatMessages` can reason in tokens using the provider's
			// real tokenizer output instead of estimating everything from chars.
			//
			// The sum is the exact token count of the conversation at the moment
			// the last request completed: `inputTokens` = what the last request
			// sent, `outputTokens` = the assistant reply that was generated and is
			// now in history. Every one of those tokens is also in THIS request's
			// input (history is append-only within a turn) — so the sum is a
			// tight, exact lower bound on the current request's input tokens.
			// The only thing still estimated is the delta (new tool results, new
			// user message), which the chars/ratio floor inside prepareLLMChatMessages
			// covers via Math.max.
			//
			// Why `inputTokens + outputTokens` and not `totalTokens`?
			//   - Anthropic path doesn't populate `totalTokens` at all (would give `undefined`).
			//   - Gemini's `totalTokens = promptTokenCount + candidatesTokenCount + thoughtsTokenCount`.
			//     Thought parts are filtered out before replay (see Gemini `thought: true` split),
			//     so `totalTokens` overcounts by `thoughtsTokenCount` — `inputTokens + outputTokens`
			//     excludes reasoning on Gemini and is tighter.
			//   - OpenAI path: `totalTokens == inputTokens + outputTokens`, so they're equivalent here.
			// Net: the manual sum is defined in more cases and equal-or-tighter everywhere else.
			//
			// Undefined on the first request of a thread (no prior usage) — the
			// chars/ratio estimate handles that case alone.
			const lastUsage = this.latestUsageOfThreadId[threadId]
			const priorContentTokens = lastUsage ? (lastUsage.inputTokens ?? 0) + (lastUsage.outputTokens ?? 0) : undefined
			const pendingImageBytes = this._pendingImageBytesByThread.get(threadId)
			const frozenAiInstructions = this.state.allThreads[threadId]?.frozenAiInstructions
			const { messages, separateSystemMessage, compactionInfo, sentChars, telemetryRequestId } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				priorContentTokens,
				threadId,
				pendingImageBytes,
				frozenAiInstructions,
			})
			// Images are only attached on the first user message of a turn;
			// clear after the first prepare so subsequent tool-loop iterations
			// don't carry stale references (the bytes are on disk by now).
			if (pendingImageBytes) this._pendingImageBytesByThread.delete(threadId)
			// Wall-clock for the request/response round-trip. Captured right after
			// `prepareLLMChatMessages` (which emits the "request" telemetry line) so
			// durMs on the response line is the time from log-request → log-response.
			const telemetryStartMs = Date.now()
			// Expose the current rid to `_runToolCall` so per-tool telemetry events
			// can attribute themselves to the LLM request that emitted them. Cleared
			// when the stream ends (see _setStreamState undefined sites).
			if (telemetryRequestId) this._telemetryRidByThread.set(threadId, telemetryRequestId)
			// Surface any Perf 2 compaction that fired for this request so the
			// TokenUsageRing tooltip can show "compacted N results / saved ~Xk tokens".
			// null means "no trimming this request" — still recorded, so "Last request"
			// in the tooltip correctly reflects the most recent LLM call.
			this._recordCompaction(threadId, compactionInfo)
			// Snapshot of what we're about to send for this specific request; fed
			// back into calibration on onFinalMessage below. Captured per-iteration
			// (not lifted out of the while loop) because the agent loop fires
			// multiple sequential requests and each one has its own sentChars.
			const sentCharsThisRequest = sentChars

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCalls: RawToolCallObj[], info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null, finishReason?: string } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: separateSystemMessage,
					onText: ({ fullText, fullReasoning, toolCalls, usage }) => {
						if (usage) this._setLatestUsage(threadId, usage)
						// Coalesced fire (see _scheduleStreamTextUpdate). Final/transition
						// state changes go through _setStreamState which cancels any
						// pending update, so we cannot drop a meaningful end-state.
						this._scheduleStreamTextUpdate(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallsSoFar: toolCalls ?? [] }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCalls, anthropicReasoning, usage, finishReason }) => {
						if (usage) this._setLatestUsage(threadId, usage)
						// Lock in this request's usage so the next loop iteration's
						// running total is added to (not replacing) what we already counted.
						this._lockInCurrentRequestUsage(threadId)
						// Per-request telemetry (Option A): pair with the "request" line so
						// offline analysis can compute cache-hit rate from usage.cached,
						// end-to-end latency from durMs, and empirical chars/token ratio.
						if (telemetryRequestId) {
							// Snapshot tool calls the model emitted this turn. `paramsLen`
							// comes from the raw serialized arguments string when present
							// (OpenAI-compat) and falls back to a JSON re-stringify so
							// Anthropic / Gemini get comparable numbers.
							const toolCallsForLog = (toolCalls ?? []).map(tc => {
								let paramsLen = 0
								try {
									const raw = (tc as { rawParamsStr?: string }).rawParamsStr
									paramsLen = typeof raw === 'string' ? raw.length : JSON.stringify(tc.rawParams ?? {}).length
								} catch { paramsLen = 0 }
								return {
									name: tc.name,
									paramsLen,
									mcp: !isABuiltinToolName(tc.name) || undefined,
								}
							})
							this._requestTelemetryService.logResponse({
								phase: 'response',
								t: new Date().toISOString(),
								rid: telemetryRequestId,
								tid: threadId,
								status: 'ok',
								finishReason,
								durMs: Date.now() - telemetryStartMs,
								usage: usage ? {
									in: usage.inputTokens,
									out: usage.outputTokens,
									cached: usage.cachedInputTokens,
									reasoning: usage.reasoningTokens,
								} : undefined,
								tools: toolCallsForLog.length > 0 ? toolCallsForLog : undefined,
							})
						}
						// Feed the provider-reported input-token count back into the
						// calibration loop. Next time `prepareLLMChatMessages` runs for
						// this model, the chars/token ratio reflects what the tokenizer
						// actually does, which tightens the emergency trim's overflow
						// threshold and makes `savedTokens` in the tooltip more accurate.
						// Guarded on modelSelection because the _runChatAgent signature
						// allows null, even though we'd have bailed out of prepareLLMChatMessages
						// with 0 sentChars in that case (recordTokenUsageCalibration would
						// no-op anyway, but narrowing avoids the TS error).
						if (modelSelection) {
							this._convertToLLMMessagesService.recordTokenUsageCalibration({
								providerName: modelSelection.providerName,
								modelName: modelSelection.modelName,
								sentChars: sentCharsThisRequest,
								reportedInputTokens: usage?.inputTokens,
							})
						}
						resMessageIsDonePromise({ type: 'llmDone', toolCalls: toolCalls ?? [], info: { fullText, fullReasoning, anthropicReasoning, finishReason } }) // resolve with tool calls
					},
					onError: async (error) => {
						if (telemetryRequestId) {
							this._requestTelemetryService.logResponse({
								phase: 'response',
								t: new Date().toISOString(),
								rid: telemetryRequestId,
								tid: threadId,
								status: 'error',
								durMs: Date.now() - telemetryStartMs,
								errorMsg: error?.message?.slice(0, 200),
							})
						}
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						if (telemetryRequestId) {
							this._requestTelemetryService.logResponse({
								phase: 'response',
								t: new Date().toISOString(),
								rid: telemetryRequestId,
								tid: threadId,
								status: 'aborted',
								durMs: Date.now() - telemetryStartMs,
							})
						}
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallsSoFar: [] }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					// error, should retry
					if (nAttempts < CHAT_RETRIES) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(RETRY_DELAY)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const { error } = llmRes
						const { displayContentSoFar, reasoningSoFar, toolCallsSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
						// Record an interrupted-streaming marker for every tool the LLM was
						// mid-way through emitting. Pre-batch this only handled the first tool.
						for (const tc of toolCallsSoFar) {
							this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: tc.name, mcpServerName: this._computeMCPServerOfToolName(tc.name) })
						}

						this._setStreamState(threadId, { isRunning: undefined, error })
						this._addUserCheckpoint({ threadId })
						return
					}
				}

				// llm res success
				const { toolCalls, info } = llmRes

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning, finishReason: info.finishReason })

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// call tool(s) if there are any. Batched / parallel tool emissions are handled
				// by pre-adding every tool as a `tool_request` (with batchIndex/batchSize so the
				// UI can render "(1/N)" prefixes), then running them serially. Any tool may pause
				// for user approval; if that happens the remaining tools in the batch stay as
				// pending tool_requests, visible to the user as stacked progress rows.
				if (toolCalls.length > 0) {
					const mcpTools = this._mcpService.getMCPTools()
					const batchSize = toolCalls.length
					for (let i = 0; i < batchSize; i++) {
						const tc = toolCalls[i]
						const mcpServerName = mcpTools?.find(t => t.name === tc.name)?.mcpServerName
						this._addMessageToThread(threadId, {
							role: 'tool',
							type: 'tool_request',
							content: '(Pending...)',
							result: null,
							name: tc.name,
							// Placeholder unvalidated params — `_runToolCall` will validate and
							// replace via `_updateLatestTool` before the tool runs. The cast is
							// safe because the UI only reads validated `params` on tool_requests
							// once they've transitioned past the placeholder phase (which happens
							// synchronously when `_tryDrainPendingBatch` hits this tool).
							params: tc.rawParams as unknown as ToolCallParams<ToolName>,
							id: tc.id,
							rawParams: tc.rawParams,
							rawParamsStr: tc.rawParamsStr,
							mcpServerName,
							// Only stamp batch metadata when there's actually more than one tool —
							// a solo tool call shouldn't render "(1/1)" in the UI.
							batchIndex: batchSize > 1 ? i : undefined,
							batchSize: batchSize > 1 ? batchSize : undefined,
						})
					}

					const batchRes = await this._tryDrainPendingBatch(threadId)
					if (batchRes === 'interrupted') {
						this._setStreamState(threadId, undefined)
						return
					}
					if (batchRes === 'awaiting_user') { isRunningWhenEnd = 'awaiting_user' }
					else { shouldSendAnotherMessage = true }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const updatedThread = {
			...oldThread,
			lastModified: new Date().toISOString(),
			messages: [
				...oldThread.messages.slice(0, messageIdx),
				newMessage,
				...oldThread.messages.slice(messageIdx + 1, Infinity),
			],
		}
		const newThreads = { ...allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voidModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const { model } = this._voidModelService.getModel(uri)
		if (!model) return // should never happen
		const diffAreasSnapshot = this._editCodeService.getVoidFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {
		// Phase E — block. Checkpoint restore writes to disk (file snapshots
		// → real workspace files), so a foreign-thread restore would clobber
		// THIS workspace's files with snapshots taken in a different one.
		// Definitely the most destructive entry point in the read-only set.
		if (this._isThreadMutationBlocked(threadId, 'jumpToCheckpointBeforeMessageIdx')) return

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, _pendingImageBytes, modelSelectionOptionsOverride }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, _pendingImageBytes?: Map<string, Uint8Array>, modelSelectionOptionsOverride?: ModelSelectionOptions }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// Phase E — claim-on-engagement. If the user is sending a message in
		// a thread that has no `workspaceUri` (legacy / pre-Phase-E, or one
		// that slipped through the empty-thread reuse path), tag it to the
		// current workspace now. After this point the thread participates in
		// the per-workspace filter normally and stops appearing in other
		// workspaces' lists. No-op when the thread is already tagged (any
		// workspace) or when the window has no workspace.
		this._claimThreadForCurrentWorkspaceIfUnscoped(threadId)

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// A new user message starts a new "turn" — zero out this-turn cumulative
		// before any LLM requests fire. Lifetime/this-thread cumulative keeps
		// accumulating across turns.
		this._resetCumulativeThisTurn(threadId)

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)

		// Snapshot the volatile runtime context (date, open files, active URI,
		// directory listing, terminal IDs) into this user message's stored content
		// so past turns stay byte-identical across subsequent requests. The volatile
		// block goes into `content` (what the LLM sees) but NOT into `displayContent`
		// (what the UI renders), so the chat bubble shows only the user's words.
		const { chatMode } = this._settingsService.state.globalSettings
		const volatileBlock = await this._convertToLLMMessagesService.generateChatVolatileContext({ chatMode })
		const contentWithVolatile = volatileBlock
			? `${volatileBlock}\n\n${userMessageContent}`
			: userMessageContent

		// Detect `.voidrules` change since the last send on THIS thread. Flag is
		// UI-only (a chip rendered above the user bubble to show where in the
		// conversation the rules shifted). The rule CONTENT itself reaches the
		// model via the system message in `prepareLLMChatMessages` — this flag
		// doesn't carry any payload the LLM sees. First send on a thread doesn't
		// flag (no baseline to compare against).
		const currentRulesContent = await this._convertToLLMMessagesService.getCurrentVoidRulesContent()
		const rulesChangedBefore = thread.lastAppliedRules !== undefined && thread.lastAppliedRules !== currentRulesContent

		// Freeze combined AI instructions on the thread's first send. Subsequent
		// sends reuse this snapshot so the system-message prefix is byte-identical
		// across turns, keeping the provider's prefix cache warm. If rules change
		// on disk the user sees an indicator and can manually re-apply via
		// `read_file .voidrules`.
		if (thread.frozenAiInstructions === undefined) {
			const combined = await this._convertToLLMMessagesService.getCombinedAIInstructionsAsync()
			this._setThreadFrozenAiInstructions(threadId, combined)
		}

		// Add the user message immediately so the chat bubble appears right away.
		// Content may be updated below if the vision helper needs to inject
		// image descriptions.
		const userHistoryElt: ChatMessage = {
			role: 'user',
			content: contentWithVolatile,
			displayContent: instructions,
			selections: currSelns,
			state: defaultMessageState,
			...(rulesChangedBefore ? { rulesChangedBefore: true } : {}),
		}
		this._addMessageToThread(threadId, userHistoryElt)
		this._setThreadLastAppliedRules(threadId, currentRulesContent)

		this._setThreadState(threadId, { currCheckpointIdx: null })

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})

		// Vision helper: if the primary model doesn't support vision and images
		// are attached, describe them via a vision-capable helper model and inject
		// the descriptions into the LLM-facing content.
		const imageSelections = currSelns.filter(s => s.type === 'Image')
		if (imageSelections.length > 0) {
			const chatModelSelection = this._settingsService.state.modelSelectionOfFeature['Chat']
			const { overridesOfModel } = this._settingsService.state
			const primarySupportsVision = chatModelSelection
				? getModelCapabilities(chatModelSelection.providerName, chatModelSelection.modelName, overridesOfModel).supportsVision === true
				: false

			if (!primarySupportsVision) {
				// Images that already have a cachedDescription (from a previous
				// send or carried forward on edit) don't need re-describing.
				const cachedDescs: string[] = []
				const newImages: (StagingSelectionItem & { type: 'Image' })[] = []
				for (const img of imageSelections) {
					if (img.type !== 'Image') continue
					if (img.cachedDescription) {
						cachedDescs.push(img.cachedDescription)
					} else {
						newImages.push(img)
					}
				}

				let newDescs = ''
				if (newImages.length > 0) {
					this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '_Processing attached images..._', reasoningSoFar: '', toolCallsSoFar: [] }, interrupt: Promise.resolve(() => { }) })
					const helperModelSelection = this._settingsService.state.modelSelectionOfFeature['VisionHelper']
					newDescs = await this._describeImagesWithHelper(newImages, helperModelSelection, _pendingImageBytes, userMessage)
					this._setStreamState(threadId, { isRunning: undefined })
				}

				const allDescs = [...cachedDescs, ...(newDescs ? [newDescs] : [])].join('\n\n')
				userHistoryElt.content = allDescs + '\n\n' + contentWithVolatile
				this._onDidChangeCurrentThread.fire()
			}
		}

		// Store pending bytes so the agent loop can pass them to
		// prepareLLMChatMessages for the first request (before flush).
		if (_pendingImageBytes && _pendingImageBytes.size > 0) {
			this._pendingImageBytesByThread.set(threadId, _pendingImageBytes)
		}

		// Flush pending images to disk for persistence. This runs after the
		// message is already persisted and the in-memory bytes are stored on
		// the service, so the agent loop can start immediately without waiting.
		if (_pendingImageBytes && _pendingImageBytes.size > 0) {
			for (const s of currSelns) {
				if (s.type !== 'Image') continue
				const bytes = _pendingImageBytes.get(s.uri.path)
				if (!bytes) continue
				this._fileService.writeFile(s.uri, VSBuffer.wrap(bytes)).catch(e => { console.error('[Image flush] Failed to write image to disk:', s.uri.path, e) })
			}
		}

		const modelProps = this._currentModelSelectionProps()
		if (modelSelectionOptionsOverride) {
			modelProps.modelSelectionOptions = { ...modelProps.modelSelectionOptions, ...modelSelectionOptionsOverride }
		}
		this._setThreadLastUsedModelSelection(threadId, modelProps.modelSelection)

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...modelProps, }),
			threadId,
		)
	}


	private async _describeImagesWithHelper(imageSelections: (StagingSelectionItem & { type: 'Image' })[], helperModelSelection: ModelSelection | null, pendingImageBytes?: Map<string, Uint8Array>, userMessage?: string): Promise<string> {
		const descriptions: string[] = []
		for (const s of imageSelections) {
			if (!helperModelSelection) {
				descriptions.push(`[Image: ${s.fileName}]\n--- start description ---\n[Configure a Vision Helper model in settings to enable image understanding]\n--- end description ---`)
				continue
			}
			try {
				const pending = pendingImageBytes?.get(s.uri.path)
				let bytes: Uint8Array
				if (pending) {
					bytes = pending
				} else {
					const content = await this._fileService.readFile(s.uri)
					bytes = content.value.buffer
				}
				let binary = ''
				for (let bi = 0; bi < bytes.length; bi++) binary += String.fromCharCode(bytes[bi])
				const base64 = btoa(binary)

				const helperSelectionOptions = this._settingsService.state.optionsOfModelSelection['VisionHelper']?.[helperModelSelection.providerName]?.[helperModelSelection.modelName]
				const { overridesOfModel } = this._settingsService.state

				const simpleMessages = [
					{ role: 'user' as const, content: visionHelper_userMessage(s.fileName, userMessage), images: [{ base64, mimeType: s.mimeType }] },
				]
				const { messages, separateSystemMessage } = this._convertToLLMMessagesService.prepareLLMSimpleMessages({
					simpleMessages,
					systemMessage: visionHelper_systemMessage,
					modelSelection: helperModelSelection,
					featureName: 'VisionHelper',
				})

				const description = await new Promise<string>((resolve, reject) => {
					this._llmMessageService.sendLLMMessage({
						messagesType: 'chatMessages',
						messages,
						separateSystemMessage,
						chatMode: null,
						modelSelection: helperModelSelection,
						modelSelectionOptions: helperSelectionOptions,
						overridesOfModel,
						onText: () => { },
						onFinalMessage: ({ fullText }) => { resolve(fullText) },
						onError: (err) => { reject(new Error(err.message)) },
						onAbort: () => { resolve('[Image description aborted]') },
						logging: { loggingName: 'VisionHelper - Image Description' },
					})
				})
				const descBlock = `[Image: ${s.fileName}]\n--- start description ---\n${description.trim()}\n--- end description ---`
				s.cachedDescription = descBlock
				descriptions.push(descBlock)
			} catch (e) {
				const descBlock = `[Image: ${s.fileName}]\n--- start description ---\n[Error describing image: ${String(e)}]\n--- end description ---`
				s.cachedDescription = descBlock
				descriptions.push(descBlock)
			}
		}
		return descriptions.join('\n\n')
	}

	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, _pendingImageBytes, modelSelectionOptionsOverride }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, _pendingImageBytes?: Map<string, Uint8Array>, modelSelectionOptionsOverride?: ModelSelectionOptions }) {
		if (this._isThreadMutationBlocked(threadId, 'addUserMessageAndStreamResponse')) return
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);
			const removedMessages = thread.messages.slice(checkpointIdx + 1);

			const updatedThread = {
				...thread,
				lastModified: new Date().toISOString(),
				messages: newMessages,
			};
			const newThreads = { ...this.state.allThreads, [threadId]: updatedThread };
			this._storeThread(threadId, updatedThread);
			this._setState({ allThreads: newThreads });

			this._deleteOrphanedImages(removedMessages, newMessages);
		}

		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, _pendingImageBytes, modelSelectionOptionsOverride });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {
		if (this._isThreadMutationBlocked(threadId, 'editUserMessageAndStreamResponse')) return

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const editedMessage = thread.messages[messageIdx]
		if (editedMessage?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// Staging selections already carry `cachedDescription` from the
		// original send — unchanged images reuse it, new images have none.
		const currSelns = editedMessage.state.stagingSelections || []

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		const removedMessages = thread.messages.slice(messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// The edited message's images are re-sent (currSelns), so retain them.
		// Images only in the removed tail are orphaned.
		const retainedWithEdit: ChatMessage[] = [...slicedMessages, { role: 'user' as const, content: '', displayContent: '', selections: currSelns, state: { stagingSelections: currSelns, isBeingEdited: false } }]
		this._deleteOrphanedImages(removedMessages, retainedWithEdit)

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	/**
	 * Delete image files referenced by the given messages but NOT referenced
	 * by any of `retainedMessages`. Best-effort; errors are swallowed.
	 */
	private _deleteOrphanedImages(removedMessages: ChatMessage[], retainedMessages: ChatMessage[]) {
		const retainedPaths = new Set<string>()
		for (const m of retainedMessages) {
			if (m.role !== 'user') continue
			for (const s of m.selections ?? []) {
				if (s.type === 'Image') retainedPaths.add(s.uri.path)
			}
		}
		for (const m of removedMessages) {
			if (m.role !== 'user') continue
			for (const s of m.selections ?? []) {
				if (s.type === 'Image' && !retainedPaths.has(s.uri.path)) {
					this._fileService.del(s.uri).catch(() => { /* best-effort */ })
				}
			}
		}
	}

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		// User-initiated switch (tab click, history click, etc). Auto-pins
		// into the *current workspace's* bucket so the thread surfaces in
		// THIS workspace's tab strip — and only this one. A foreign thread
		// opened from "Other workspaces" lands here too, read-only via
		// commit 3's gating; the foreign thread's own workspace tab strip
		// is unaffected. Use `_landOnThread` for non-user-initiated
		// transitions (startup restore, normalize) where the tab strip
		// should stay exactly as the user left it.
		const alreadyPinned = this.state.pinnedThreadIds.includes(threadId)
		if (alreadyPinned) {
			this._setState({ currentThreadId: threadId })
		} else {
			const newPinned = [...this.state.pinnedThreadIds, threadId]
			this._setPinsForCurrentWorkspace(newPinned, { currentThreadId: threadId })
		}
		this._afterCurrentThreadChanged(threadId)
	}

	// Phase E — set currentThreadId WITHOUT touching the pinned tab strip.
	// The strip is a stable user-curated set; reloads / startup restoration
	// must not silently pin previously-unpinned threads or it produces the
	// "every refresh adds a new tab" behavior reported during commit-2
	// testing. Same lastActive + model-restore side-effects as
	// `switchToThread` so a reload-landing thread still gets remembered.
	private _landOnThread(threadId: string): void {
		if (!this.state.allThreads[threadId]) return
		this._setState({ currentThreadId: threadId })
		this._afterCurrentThreadChanged(threadId)
	}

	// Shared post-switch side-effects for both the pinning and non-pinning
	// landing paths above. Updates the per-workspace last-active map and
	// reapplies the saved per-thread model selection.
	private _afterCurrentThreadChanged(threadId: string): void {
		// Phase E — remember "last thread looked at in this workspace" so the
		// next reload (or reopen of this workspace in another window) can
		// restore the user's place. We key on the *current window's*
		// workspace, not on the thread's tag, because a foreign-workspace
		// thread viewed in read-only mode shouldn't be remembered as the
		// landing thread for *its* workspace from this window.
		const wsUri = this.state.currentWorkspaceUri
		if (wsUri) {
			if (this._lastActiveThreadIdByWorkspace[wsUri] !== threadId) {
				this._lastActiveThreadIdByWorkspace[wsUri] = threadId
				this._storeLastActiveThreadIdByWorkspace()
			}
		}

		// Restore the dropdown to the model that was last used to send a
		// message on this thread. Fire-and-forget: the switch already took
		// effect visually; `setModelSelectionOfFeature` just updates settings
		// state which the model-selector component listens to separately.
		// Skip when the thread has no saved selection (fresh thread, or
		// pre-feature thread) or when the saved model has since been deleted
		// or hidden — in both cases we intentionally leave the current global
		// selection alone so the user isn't surprised by a blank dropdown.
		const saved = this.state.allThreads[threadId]?.lastUsedModelSelection
		if (saved && this._isModelSelectionCurrentlyValid(saved)) {
			const current = this._settingsService.state.modelSelectionOfFeature['Chat']
			const alreadyMatches = current
				&& current.providerName === saved.providerName
				&& current.modelName === saved.modelName
			if (!alreadyMatches) {
				this._settingsService.setModelSelectionOfFeature('Chat', saved)
			}
		}
	}


	// Resolve the workspace identity to stamp on a freshly-created thread.
	// Returns `{}` for empty-window / no-folder startups — the caller threads
	// that through to `newThreadObject`, which leaves `workspaceUri/Label`
	// undefined ("unscoped" thread, visible in every workspace's list until
	// claimed via Move). For multi-root workspaces we use the `.code-workspace`
	// file URI as identity (NOT individual folder URIs) — splitting/joining
	// roots into a different `.code-workspace` is intentionally treated as a
	// new workspace, accepted small footgun. Label = basename minus the
	// `.code-workspace` extension for legibility.
	private _getCurrentWorkspaceIdentity(): { uri?: string, label?: string } {
		const workspace = this._workspaceContextService.getWorkspace()
		const identifier = toWorkspaceIdentifier(workspace)
		if ('uri' in identifier) {
			// single-folder
			const label = resourceBasename(identifier.uri) || identifier.uri.toString()
			return { uri: identifier.uri.toString(), label }
		}
		if ('configPath' in identifier) {
			const configName = resourceBasename(identifier.configPath)
			if (configName !== 'workspace.json' && configName.endsWith('.code-workspace')) {
				// Saved .code-workspace file — use configPath as identity.
				const label = configName.replace(/\.code-workspace$/, '') || configName
				return { uri: identifier.configPath.toString(), label }
			}
			// Untitled workspace (temp workspace.json) — fall through to
			// first-folder identity below so adding/removing extra folders
			// doesn't break thread ownership.
		}
		// Single-folder or untitled multi-root: use the first folder's URI
		// as identity. For untitled multi-root, this deliberately matches
		// the single-folder identity so threads stay in scope when the
		// user adds/removes folders without saving a .code-workspace.
		if (workspace.folders.length > 0) {
			const primaryUri = workspace.folders[0].uri.toString()
			const firstName = resourceBasename(workspace.folders[0].uri) || primaryUri
			const extra = workspace.folders.length - 1
			const label = extra > 0 ? `${firstName} (+${extra})` : firstName
			return { uri: primaryUri, label }
		}
		// True empty window — no folders at all. Threads become unscoped.
		return {}
	}

	// Phase E — gate every thread-mutating service entry point. Foreign
	// threads (tagged to another workspace) are read-only from this
	// window: send, edit, approve/reject, checkpoint-restore, and
	// staging-selection writes all short-circuit when this returns true.
	// Centralised here (instead of each method copy-pasting the predicate)
	// so the rule stays consistent and a future change to the read-only
	// definition only needs editing in one place.
	//
	// Logs a console warning when a guard fires. Not a notification —
	// this should never happen via normal UI (commit 4's Copy/Move banner
	// gates user actions before they reach the service). A warning here
	// flags either a UI bug (clickable button that should have been
	// disabled) or a programmatic caller that bypassed the UI; both worth
	// surfacing during development.
	private _isThreadMutationBlocked(threadId: string, op: string): boolean {
		const thread = this.state.allThreads[threadId]
		if (!isThreadReadOnly(thread, this.state.currentWorkspaceUri)) return false
		console.warn(`[void/chat] blocked '${op}' on read-only foreign thread`, {
			threadId,
			threadWorkspace: thread?.workspaceUri,
			currentWorkspace: this.state.currentWorkspaceUri,
		})
		return true
	}

	// Phase E — "claim on engagement". An unscoped thread (workspaceUri ===
	// undefined) is otherwise visible in every workspace's list, which is
	// confusing in practice: when the user actually engages with such a
	// thread from a workspaced window (sends a message, reuses an empty
	// thread via `+`), they expect it to *become* this workspace's thread.
	// This helper tags it idempotently. No-ops in three safe cases:
	//   - thread already tagged (any workspace): never silently move it
	//   - empty window (no current workspace): nothing to claim it for
	//   - thread doesn't exist: defensive
	// Returns true when a tag write actually happened so callers can decide
	// whether to forward the new state to subscribers in their existing
	// `_setState` calls (saves a redundant emit).
	private _claimThreadForCurrentWorkspaceIfUnscoped(threadId: string): boolean {
		const wsUri = this.state.currentWorkspaceUri
		if (!wsUri) return false
		const t = this.state.allThreads[threadId]
		if (!t || t.workspaceUri) return false
		const identity = this._getCurrentWorkspaceIdentity()
		const updatedThread = { ...t, workspaceUri: identity.uri, workspaceLabel: identity.label }
		const newThreads = { ...this.state.allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
		return true
	}

	// Phase E — defensive guard + startup landing logic. Snaps the current
	// thread to a thread that's *pinned in this workspace*. Used by:
	//   - constructor end (lands on existing thread instead of creating new)
	//   - any future code path that risks setting currentThreadId to
	//     something not in this workspace's tab strip
	// Cascade:
	//   1. per-workspace last-active (must exist + still pinned here)
	//   2. newest pinned-in-workspace thread by lastModified
	//   3. openNewThread (creates / reuses an empty thread, auto-pins)
	//
	// Pin storage is per-workspace, so any thread in `state.pinnedThreadIds`
	// is by definition "in this workspace's strip" — no `isThreadInWorkspaceScope`
	// filter needed. A foreign thread in the strip (opened from "Other
	// workspaces" via switchToThread) is a legitimate landing target — the
	// user pinned it here and will be locked out of mutations by commit 3's
	// gates regardless. Empty windows fall through step 1 cleanly: the map
	// is keyed by workspace URI; the `''` empty-window key gets its own
	// last-active slot via the same path.
	private _normalizeCurrentThreadInScope(): void {
		const cur = this.state.allThreads[this.state.currentThreadId]
		const isPinned = (id: string) => this.state.pinnedThreadIds.includes(id)
		// Already on a thread that's in this workspace's strip? Done.
		if (cur && isPinned(cur.id)) return

		const lastActiveKey = this.state.currentWorkspaceUri
		// (1) per-workspace last-active, validated against current pin set.
		//     Self-heal any stale entry (dead ref / unpinned in this ws)
		//     so it doesn't keep blocking step (2).
		if (lastActiveKey) {
			const lastId = this._lastActiveThreadIdByWorkspace[lastActiveKey]
			if (lastId) {
				if (this.state.allThreads[lastId] && isPinned(lastId)) {
					this._landOnThread(lastId)
					return
				}
				delete this._lastActiveThreadIdByWorkspace[lastActiveKey]
				this._storeLastActiveThreadIdByWorkspace()
			}
		}
		// (2) newest pinned-in-this-workspace thread by lastModified.
		const pinnedCandidates = this.state.pinnedThreadIds
			.map(id => this.state.allThreads[id])
			.filter((t): t is NonNullable<typeof t> => !!t)
			.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))
		if (pinnedCandidates.length > 0) {
			this._landOnThread(pinnedCandidates[0].id)
			return
		}
		// (3) Empty strip in this workspace. Mint a fresh pinned thread —
		//     standard "blank slate" so the chat pane has something to render.
		this.openNewThread()
	}

	openNewThread() {
		// if an empty thread already exists *in the current workspace scope*,
		// reuse it instead of spawning yet another. We deliberately don't
		// hijack empty threads tagged to a *different* workspace — those
		// belong to that workspace's scope and reusing them would silently
		// migrate them. Unscoped empty threads (legacy / pre-feature) are
		// considered fair game and get reused as-is (Move would re-tag them
		// later).
		const { allThreads: currentThreads, currentWorkspaceUri } = this.state
		for (const threadId in currentThreads) {
			const t = currentThreads[threadId]
			if (!t || t.messages.length !== 0) continue
			if (!isThreadInWorkspaceScope(t, currentWorkspaceUri)) continue
			// Claim BEFORE switch: if we reuse an unscoped legacy empty
			// thread in a workspaced window, tag it so it's no longer "shared
			// across all workspaces" the moment the user starts typing in it.
			// Idempotent + scoped to unscoped-only, so a properly-tagged empty
			// thread (whether for this workspace or any other) is left alone.
			this._claimThreadForCurrentWorkspaceIfUnscoped(threadId)
			this.switchToThread(threadId)
			return
		}
		// otherwise, start a new thread, stamped with current workspace
		const newThread = newThreadObject(this._getCurrentWorkspaceIdentity())

		// update state — also auto-pin so it becomes the active tab
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		const newPinned = this.state.pinnedThreadIds.includes(newThread.id)
			? this.state.pinnedThreadIds
			: [...this.state.pinnedThreadIds, newThread.id]
		this._storeThread(newThread.id, newThread, true)
		this._setPinsForCurrentWorkspace(newPinned, { allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state
		const deletedThread = currentThreads[threadId]

		// Clean up image files owned by this thread
		if (deletedThread) {
			this._deleteOrphanedImages(deletedThread.messages, [])
		}

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// Drop the deleted thread from EVERY workspace's pin bucket — pins
		// are now per-workspace, so the same thread can be pinned in multiple
		// places. Without iterating all buckets, deleting from workspace A
		// would leave a ghost pin in workspace B's tab strip on reload.
		let pinMapChanged = false
		for (const k of Object.keys(this._pinnedThreadIdsByWorkspace)) {
			const before = this._pinnedThreadIdsByWorkspace[k]
			const after = before.filter(id => id !== threadId)
			if (after.length !== before.length) {
				this._pinnedThreadIdsByWorkspace[k] = after
				pinMapChanged = true
			}
		}
		if (pinMapChanged) this._storePinnedThreadIdsByWorkspace()
		const newPinned = this._pinnedThreadIdsByWorkspace[this._currentPinKey()] ?? []

		// release in-memory telemetry state (rid map + sysMessage snapshot used
		// for flip detection) so neither map grows forever. The on-disk log file
		// for the deleted thread is kept — it may still have analysis value and
		// the user can purge the whole voidRequestLogs dir when they want to
		// reclaim.
		this._telemetryRidByThread.delete(threadId)
		this._pendingImageBytesByThread.delete(threadId)
		this._requestTelemetryService.forgetThread(threadId)

		// Phase E — also clear any per-workspace last-active pointers to this
		// thread so it doesn't get auto-pinned back via restore on next reload.
		// (Restore self-heals dead refs anyway, but doing it here is cheap and
		// makes the storage state consistent immediately, which is helpful
		// when debugging via direct SQLite inspection.)
		this._clearLastActiveEntriesForThread(threadId)

		this._storeThread(threadId, undefined)
		this._setState({ ...this.state, allThreads: newThreads, pinnedThreadIds: newPinned })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		// Pin the duplicate right after the original, so the new tab appears
		// next to the source tab (natural position). Fall back to append if
		// the source isn't pinned in this workspace. The duplicate inherits
		// `workspaceUri` from the source — if the source was foreign here,
		// the duplicate is foreign too (read-only); user can Move via commit
		// 4 if they want to claim it.
		const srcIdx = this.state.pinnedThreadIds.indexOf(threadId)
		const newPinned = [...this.state.pinnedThreadIds]
		if (srcIdx === -1) newPinned.push(newThread.id)
		else newPinned.splice(srcIdx + 1, 0, newThread.id)

		this._storeThread(newThread.id, newThread, true)
		this._setPinsForCurrentWorkspace(newPinned, { allThreads: newThreads })
	}

	// Phase E commit 4 — claim a foreign thread into the current workspace by
	// cloning. Source thread is untouched (still owned by its origin
	// workspace). The clone gets a fresh id, the current workspace's
	// identity, and `importedFrom*` provenance fields so a future audit can
	// trace it back. Usage / compaction counters are reset because the
	// "lifetime cost" of the source thread accrued in another workspace's
	// context — carrying the totals over is misleading. Messages,
	// checkpoints, model selection, and staging all carry over verbatim.
	//
	// Auto-pins the new thread + switches to it, mirroring the user's
	// expectation that "Copy" produces something they can immediately work
	// on. Returns the new id so the caller (banner button) can follow up
	// with UI work if needed.
	copyThreadToCurrentWorkspace(threadId: string): string | undefined {
		const source = this.state.allThreads[threadId]
		if (!source) return undefined
		const identity = this._getCurrentWorkspaceIdentity()
		const newId = generateUuid()
		const cloned: ThreadType = {
			...deepClone(source),
			id: newId,
			workspaceUri: identity.uri,
			workspaceLabel: identity.label,
			importedFromWorkspaceUri: source.workspaceUri,
			importedFromThreadId: source.id,
			importedAt: Date.now(),
			lastModified: new Date().toISOString(),
			// Reset usage telemetry: lifetime totals on the source accrued in
			// another workspace's request stream and don't represent this
			// thread's cost going forward. `latestUsage` is per-request so
			// it gets refreshed on the next send anyway, but clearing keeps
			// the TokenUsageRing accurate immediately after Copy.
			latestUsage: undefined,
			cumulativeUsageThisThread: undefined,
			latestCompaction: undefined,
			cumulativeCompactionThisThread: undefined,
		}
		const newThreads = { ...this.state.allThreads, [newId]: cloned }
		this._storeThread(newId, cloned, true)
		// Drop in-memory telemetry mirrors for the new id (defensive — should
		// be empty since the id is fresh, but keeps the maps strictly
		// in-sync with what's persisted on the thread).
		delete this.latestUsageOfThreadId[newId]
		delete this.cumulativeUsageThisThreadOfThreadId[newId]
		delete this.latestCompactionOfThreadId[newId]
		delete this.cumulativeCompactionThisThreadOfThreadId[newId]

		this._setState({ allThreads: newThreads })
		// Use switchToThread so the auto-pin + last-active update flows
		// through the established channels rather than open-coding them.
		this.switchToThread(newId)
		return newId
	}

	// Phase E commit 4 — claim a foreign thread by re-tagging in place.
	// Source thread's `workspaceUri` flips to the current workspace's, so
	// it disappears from its origin workspace's history and starts showing
	// up in this one's default list. No clone, no usage reset — same
	// thread, just a new owner. Auto-pins to current workspace's tab strip;
	// drops it from the *origin* workspace's pin bucket if it was there.
	//
	// Use case: "I started this thread in workspace X by accident, fix it".
	// The destructive bit (origin workspace loses access from default
	// view) is the deliberate trade-off — that's why Copy is offered as
	// the alternative.
	moveThreadToCurrentWorkspace(threadId: string): string | undefined {
		const source = this.state.allThreads[threadId]
		if (!source) return undefined
		const identity = this._getCurrentWorkspaceIdentity()
		// No-op if it's already this workspace's (or empty-window with no
		// identity to assign). Caller (banner) shouldn't even offer Move
		// in those cases, but defensive check for any direct API calls.
		if (source.workspaceUri === identity.uri) {
			this.switchToThread(threadId)
			return threadId
		}

		// Drop from the origin workspace's pin bucket — once re-tagged it's
		// no longer "in scope" there per the new model, so leaving the pin
		// would render an out-of-place tab in that workspace's strip on
		// next reload. The current workspace's auto-pin happens via
		// switchToThread below.
		const originKey = source.workspaceUri ?? ''
		if (originKey && this._pinnedThreadIdsByWorkspace[originKey]?.includes(threadId)) {
			const filtered = this._pinnedThreadIdsByWorkspace[originKey].filter(id => id !== threadId)
			if (filtered.length === 0) delete this._pinnedThreadIdsByWorkspace[originKey]
			else this._pinnedThreadIdsByWorkspace[originKey] = filtered
			this._storePinnedThreadIdsByWorkspace()
		}
		// Same logic for the origin workspace's last-active pointer.
		if (originKey && this._lastActiveThreadIdByWorkspace[originKey] === threadId) {
			delete this._lastActiveThreadIdByWorkspace[originKey]
			this._storeLastActiveThreadIdByWorkspace()
		}

		const updated: ThreadType = {
			...source,
			workspaceUri: identity.uri,
			workspaceLabel: identity.label,
			lastModified: new Date().toISOString(),
		}
		const newThreads = { ...this.state.allThreads, [threadId]: updated }
		this._storeThread(threadId, updated)
		this._setState({ allThreads: newThreads })
		this.switchToThread(threadId)
		return threadId
	}

	pinThread(threadId: string): void {
		if (!this.state.allThreads[threadId]) return
		if (this.state.pinnedThreadIds.includes(threadId)) return
		const newPinned = [...this.state.pinnedThreadIds, threadId]
		this._setPinsForCurrentWorkspace(newPinned)
	}

	unpinThread(threadId: string): void {
		if (!this.state.pinnedThreadIds.includes(threadId)) return
		const newPinned = this.state.pinnedThreadIds.filter(id => id !== threadId)

		// Phase E — clear the per-workspace last-active map of any pointers
		// to this thread *for the current workspace only*. Other workspaces
		// may still legitimately have it pinned + last-active; their entries
		// stand. Without this clear, the next reload of THIS workspace
		// resurrects the thread via the restore-last-active path → auto-pin
		// → unpin defeated.
		const wsKey = this._currentPinKey()
		if (wsKey && this._lastActiveThreadIdByWorkspace[wsKey] === threadId) {
			delete this._lastActiveThreadIdByWorkspace[wsKey]
			this._storeLastActiveThreadIdByWorkspace()
		}

		// If the user removed the tab they're currently looking at, jump to
		// a neighboring pinned tab in this workspace so the chat pane doesn't
		// show stale content. Per-workspace pin storage means `newPinned` is
		// already correctly scoped — no extra filter needed (commit-2's
		// `isThreadInWorkspaceScope` filter here is now redundant). Falling
		// through to `openNewThread()` is correct when this workspace's
		// strip is empty: lands on per-workspace last-active or mints a
		// fresh thread tagged to the current workspace.
		if (this.state.currentThreadId === threadId) {
			if (newPinned.length > 0) {
				this._setPinsForCurrentWorkspace(newPinned, { currentThreadId: newPinned[newPinned.length - 1] })
			} else {
				this._setPinsForCurrentWorkspace(newPinned)
				this.openNewThread()
			}
		} else {
			this._setPinsForCurrentWorkspace(newPinned)
		}
	}


	// Mirrors `reorderCustomModel` (settings service): splice source out,
	// recompute target index in the resulting array, splice source back in
	// at `position` relative to the target. Routes through
	// `_setPinsForCurrentWorkspace` so persistence + multi-window sync are
	// inherited. Operates on `this.state.pinnedThreadIds` (the current
	// workspace projection) — `_pinnedThreadIdsByWorkspace[currentKey]` is
	// the same array, kept consistent by `_setPinsForCurrentWorkspace`.
	reorderPinnedThread(threadId: string, targetThreadId: string, position: 'before' | 'after'): boolean {
		if (threadId === targetThreadId) return false

		const pins = this.state.pinnedThreadIds
		const fromIdx = pins.indexOf(threadId)
		const toIdx = pins.indexOf(targetThreadId)
		if (fromIdx === -1 || toIdx === -1) return false

		const without = [...pins.slice(0, fromIdx), ...pins.slice(fromIdx + 1)]
		const targetAfterRemoval = without.indexOf(targetThreadId)
		const insertAt = position === 'before' ? targetAfterRemoval : targetAfterRemoval + 1
		const newPinned = [
			...without.slice(0, insertAt),
			threadId,
			...without.slice(insertAt),
		]

		// Identity check: if the new array equals the old (e.g. dropping
		// 'after' onto your immediate left neighbor when you're already to
		// its right), don't dirty storage or trigger a re-render.
		if (newPinned.length === pins.length && newPinned.every((id, i) => id === pins[i])) return false

		this._setPinsForCurrentWorkspace(newPinned)
		return true
	}


	setThreadCustomTitle(threadId: string, title: string | undefined): void {
		if (this._isThreadMutationBlocked(threadId, 'setThreadCustomTitle')) return
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return

		// Normalize: empty / whitespace-only resets to default. Storing
		// `undefined` (vs `''`) keeps the persisted JSON minimal — the
		// field disappears from the serialized thread when reset.
		const trimmed = title?.trim()
		const next = trimmed && trimmed.length > 0 ? trimmed : undefined

		// No-op when the value didn't actually change. Both sides
		// normalize to `undefined` for the empty case so a rename to
		// the same string doesn't dirty the storage blob.
		const current = oldThread.customTitle && oldThread.customTitle.trim().length > 0 ? oldThread.customTitle : undefined
		if (current === next) return

		const newThread: ThreadType = { ...oldThread, customTitle: next, lastModified: new Date().toISOString() }
		const newThreads = { ...allThreads, [threadId]: newThread }
		this._storeThread(threadId, newThread)
		this._setState({ allThreads: newThreads })
	}

	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		const updatedThread = {
			...oldThread,
			lastModified: new Date().toISOString(),
			messages: [...oldThread.messages, message],
		}
		const newThreads = { ...allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {
		// Phase E — staging selections feed into the next user-message send.
		// Block on read-only foreign threads so the user can't queue file
		// context that would only be discarded by the addUserMessage gate.
		if (this._isThreadMutationBlocked(this.state.currentThreadId, 'addNewStagingSelection')) return

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {
		if (this._isThreadMutationBlocked(this.state.currentThreadId, 'popStagingSelections')) return

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}


	// ── Dev-only: perf testing helpers (see chatThreadDevTools.ts) ──────

	_simulateStream(opts?: { charsPerChunk?: number, intervalMs?: number, includeReasoning?: boolean, repetitions?: number }): void {
		const threadId = this.state.currentThreadId
		if (!this.state.allThreads[threadId]) return
		runSimulatedStream(threadId, {
			addMessage: (id, msg) => this._addMessageToThread(id, msg),
			setStreamState: (id, s) => this._setStreamState(id, s),
			scheduleStreamTextUpdate: (id, s) => this._scheduleStreamTextUpdate(id, s),
		}, opts)
	}

	_populateTestThread(turns: number = 15): void {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const messages = buildTestMessages(turns)
		const updatedThread = { ...thread, lastModified: new Date().toISOString(), messages }
		const newThreads = { ...this.state.allThreads, [threadId]: updatedThread }
		this._storeThread(threadId, updatedThread)
		this._setState({ allThreads: newThreads })
		console.log(`[test] Populated thread ${threadId} with ${turns} turns, ${messages.length} messages. Approx chars: ${JSON.stringify(messages).length}`)
	}

}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
