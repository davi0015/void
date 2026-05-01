/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton, IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useFullChatThreadsStreamState, useSettingsState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, ChevronDown, ChevronRight, Copy, Globe, Icon, LoaderCircle, Lock, MessageCircleQuestion, Plus, Trash2, UserCheck, X } from 'lucide-react';
import { isThreadReadOnly, IsRunningType, ThreadType } from '../../../chatThreadService.js';


const numInitialThreads = 3

// Synthetic group label for unscoped (legacy / pre-Phase-E) threads —
// they live under "Other workspaces" alongside foreign threads. Internal
// constant so a real workspace named "Unscoped" wouldn't collide with
// the bucket key (we use the literal `undefined` workspaceUri as the
// bucket id instead — see `groupForeignByWorkspace` below).
const UNSCOPED_LABEL = 'Unscoped'

// Phase E commit 4 — partition the full thread list into:
//   - own: threads tagged to the current workspace (strict equality)
//   - foreign: every other non-empty thread, grouped by workspaceUri
//
// Strict equality (not `isThreadInWorkspaceScope`) intentionally —
// unscoped threads now live under "Other workspaces → Unscoped" rather
// than mixing into the default list. Cleaner mental model: the default
// section is "this workspace's stuff" and Copy/Move is the explicit
// path for adopting anything else.
const partitionThreadsByWorkspaceScope = (
	allThreads: { [id: string]: ThreadType | undefined },
	currentWorkspaceUri: string | undefined,
) => {
	const own: string[] = []
	// `Map` here (instead of plain object) preserves insertion order,
	// which we use as a stable group ordering when rendering.
	const foreignByKey = new Map<string, { label: string, threadIds: string[] }>()

	const sortedIds = Object.keys(allThreads)
		.sort((a, b) => ((allThreads[a]?.lastModified ?? '') > (allThreads[b]?.lastModified ?? '') ? -1 : 1))
		.filter(id => (allThreads[id]?.messages.length ?? 0) !== 0)

	for (const id of sortedIds) {
		const t = allThreads[id]
		if (!t) continue
		if (t.workspaceUri === currentWorkspaceUri) {
			own.push(id)
			continue
		}
		// Bucket key: thread.workspaceUri (real or synthetic untitled-multi-root)
		// for foreign-workspace threads, or the empty string for unscoped.
		// This is also the lookup key the service uses internally, so
		// nothing has to translate between display and storage scopes.
		const key = t.workspaceUri ?? ''
		const label = t.workspaceUri ? (t.workspaceLabel ?? t.workspaceUri) : UNSCOPED_LABEL
		const bucket = foreignByKey.get(key)
		if (bucket) bucket.threadIds.push(id)
		else foreignByKey.set(key, { label, threadIds: [id] })
	}

	return { own, foreignByKey }
}

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
	// Top-level "Other workspaces" group is collapsed by default each
	// reload (intentional — keeps the default view focused on this
	// workspace). Per-bucket expansion lives below; user-toggled state
	// is in-memory only, no persistence.
	const [foreignExpanded, setForeignExpanded] = useState(false)

	const threadsState = useChatThreadsState()
	const { allThreads, currentWorkspaceUri } = threadsState

	const streamState = useFullChatThreadsStreamState()

	const runningThreadIds: { [threadId: string]: IsRunningType | undefined } = {}
	for (const threadId in streamState) {
		const isRunning = streamState[threadId]?.isRunning
		if (isRunning) { runningThreadIds[threadId] = isRunning }
	}

	if (!allThreads) {
		return <div key="error" className="p-1">{`Error accessing chat history.`}</div>;
	}

	const { own, foreignByKey } = useMemo(
		() => partitionThreadsByWorkspaceScope(allThreads, currentWorkspaceUri),
		[allThreads, currentWorkspaceUri],
	)

	const hasMoreThreads = own.length > numInitialThreads;
	const displayThreads = showAll ? own : own.slice(0, numInitialThreads);

	const hasForeign = foreignByKey.size > 0

	return (
		<div className={`flex flex-col mb-2 gap-2 w-full text-nowrap text-void-fg-3 select-none relative ${className}`}>
			{displayThreads.map((threadId, i) => {
				const pastThread = allThreads[threadId];
				if (!pastThread) return <div key={i} className="p-1">{`Error accessing chat history.`}</div>;
				return (
					<PastThreadElement
						key={pastThread.id}
						pastThread={pastThread}
						idx={i}
						hoveredIdx={hoveredIdx}
						setHoveredIdx={setHoveredIdx}
						isRunning={runningThreadIds[pastThread.id]}
					/>
				);
			})}

			{hasMoreThreads && !showAll && (
				<div
					className="text-void-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(true)}
				>
					Show {own.length - numInitialThreads} more...
				</div>
			)}
			{hasMoreThreads && showAll && (
				<div
					className="text-void-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(false)}
				>
					Show less
				</div>
			)}

			{hasForeign && (
				<OtherWorkspacesSection
					foreignByKey={foreignByKey}
					expanded={foreignExpanded}
					onToggle={() => setForeignExpanded(v => !v)}
					allThreads={allThreads}
					runningThreadIds={runningThreadIds}
					hoveredIdx={hoveredIdx}
					setHoveredIdx={setHoveredIdx}
				/>
			)}
		</div>
	);
};

// Phase E commit 4 — collapsible "Other workspaces" section. Renders
// foreign + unscoped threads grouped by workspace label. Each group
// can be independently expanded; once the parent is open, groups
// default to expanded so the user can see contents without an extra
// click cascade.
const OtherWorkspacesSection = ({
	foreignByKey, expanded, onToggle,
	allThreads, runningThreadIds, hoveredIdx, setHoveredIdx,
}: {
	foreignByKey: Map<string, { label: string, threadIds: string[] }>
	expanded: boolean
	onToggle: () => void
	allThreads: { [id: string]: ThreadType | undefined }
	runningThreadIds: { [threadId: string]: IsRunningType | undefined }
	hoveredIdx: number | null
	setHoveredIdx: (idx: number | null) => void
}) => {
	// Per-bucket expansion. Stored as a Set of bucket keys; absence
	// means expanded (default). Keeps the default-open semantic without
	// having to seed state from a derived list.
	const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set())
	const toggleKey = (key: string) => {
		setCollapsedKeys(prev => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}

	const totalForeign = useMemo(() => {
		let n = 0
		for (const bucket of foreignByKey.values()) n += bucket.threadIds.length
		return n
	}, [foreignByKey])

	return (
		<div className='mt-3 flex flex-col gap-1'>
			<div
				className='flex items-center gap-1 cursor-pointer text-void-fg-3 opacity-70 hover:opacity-100 text-xs select-none'
				onClick={onToggle}
			>
				{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				<span>Other workspaces</span>
				<span className='opacity-60'>({totalForeign})</span>
			</div>
			{expanded && (
				<div className='flex flex-col gap-2 pl-2'>
					{Array.from(foreignByKey.entries()).map(([key, { label, threadIds }]) => {
						const collapsed = collapsedKeys.has(key)
						return (
							<div key={key} className='flex flex-col gap-1'>
								<div
									className='flex items-center gap-1 cursor-pointer text-void-fg-3 opacity-70 hover:opacity-100 text-xs select-none'
									onClick={() => toggleKey(key)}
								>
									{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
									<span className='truncate'>{label}</span>
									<span className='opacity-60'>({threadIds.length})</span>
								</div>
								{!collapsed && (
									<div className='flex flex-col gap-2 pl-2'>
										{threadIds.map((threadId, i) => {
											const t = allThreads[threadId]
											if (!t) return null
											return (
												<PastThreadElement
													key={t.id}
													pastThread={t}
													// Negative idx prevents hover-row collision with the
													// own-list's positive indices — the two share `hoveredIdx`
													// state and we don't want hover on a foreign row to flicker
													// the action buttons of an own row at the same numeric idx.
													idx={-1 * (i + 1)}
													hoveredIdx={hoveredIdx}
													setHoveredIdx={setHoveredIdx}
													isRunning={runningThreadIds[t.id]}
												/>
											)
										})}
									</div>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}





// Format date to display as today, yesterday, or date
const formatDate = (date: Date) => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	if (date >= today) {
		return 'Today';
	} else if (date >= yesterday) {
		return 'Yesterday';
	} else {
		return `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
	}
};

// Format time to 12-hour format
const formatTime = (date: Date) => {
	return date.toLocaleString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true
	});
};


const DuplicateButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	return <IconShell1
		Icon={Copy}
		className='size-[11px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
		data-tooltip-id='void-tooltip'
		data-tooltip-place='top'
		data-tooltip-content='Duplicate thread'
	>
	</IconShell1>

}

const TrashButton = ({ threadId }: { threadId: string }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')


	const [isTrashPressed, setIsTrashPressed] = useState(false)

	return (isTrashPressed ?
		<div className='flex flex-nowrap text-nowrap gap-1'>
			<IconShell1
				Icon={X}
				className='size-[11px]'
				onClick={() => { setIsTrashPressed(false); }}
				data-tooltip-id='void-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Cancel'
			/>
			<IconShell1
				Icon={Check}
				className='size-[11px]'
				onClick={() => { chatThreadsService.deleteThread(threadId); setIsTrashPressed(false); }}
				data-tooltip-id='void-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Confirm'
			/>
		</div>
		: <IconShell1
			Icon={Trash2}
			className='size-[11px]'
			onClick={() => { setIsTrashPressed(true); }}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Delete thread'
		/>
	)
}

const PastThreadElement = ({ pastThread, idx, hoveredIdx, setHoveredIdx, isRunning }: {
	pastThread: ThreadType,
	idx: number,
	hoveredIdx: number | null,
	setHoveredIdx: (idx: number | null) => void,
	isRunning: IsRunningType | undefined,
}

) => {


	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// const settingsState = useSettingsState()
	// const convertService = accessor.get('IConvertToLLMMessageService')
	// const chatMode = settingsState.globalSettings.chatMode
	// const modelSelection = settingsState.modelSelectionOfFeature?.Chat ?? null
	// const copyChatButton = <CopyButton
	// 	codeStr={async () => {
	// 		const { messages } = await convertService.prepareLLMChatMessages({
	// 			chatMessages: currentThread.messages,
	// 			chatMode,
	// 			modelSelection,
	// 		})
	// 		return JSON.stringify(messages, null, 2)
	// 	}}
	// 	toolTipName={modelSelection === null ? 'Copy As Messages Payload' : `Copy As ${displayInfoOfProviderName(modelSelection.providerName).title} Payload`}
	// />


	// const currentThread = chatThreadsService.getCurrentThread()
	// const copyChatButton2 = <CopyButton
	// 	codeStr={async () => {
	// 		return JSON.stringify(currentThread.messages, null, 2)
	// 	}}
	// 	toolTipName={`Copy As Void Chat`}
	// />

	let firstMsg = null;
	const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');

	if (firstUserMsgIdx !== -1) {
		const firsUsertMsgObj = pastThread.messages[firstUserMsgIdx];
		firstMsg = firsUsertMsgObj.role === 'user' && firsUsertMsgObj.displayContent || '';
	} else {
		firstMsg = '""';
	}

	const numMessages = pastThread.messages.filter((msg) => msg.role === 'assistant' || msg.role === 'user').length;

	const detailsHTML = <span
	// data-tooltip-id='void-tooltip'
	// data-tooltip-content={`Last modified ${formatTime(new Date(pastThread.lastModified))}`}
	// data-tooltip-place='top'
	>
		<span className='opacity-60'>{numMessages}</span>
		{` `}
		{formatDate(new Date(pastThread.lastModified))}
		{/* {` messages `} */}
	</span>

	return <div
		key={pastThread.id}
		className={`
			py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100
		`}
		onClick={() => {
			// startTransition marks the state update (swapping the whole message list
			// for a new thread) as low-priority / interruptible. The click responds
			// instantly; React yields while building the new thread's tree instead of
			// blocking the main thread for the full render + commit. Total CPU cost
			// is unchanged — this only improves perceived latency.
			startTransition(() => {
				chatThreadsService.switchToThread(pastThread.id);
			});
		}}
		onMouseEnter={() => setHoveredIdx(idx)}
		onMouseLeave={() => setHoveredIdx(null)}
	>
		<div className="flex items-center justify-between gap-1">
			<span className="flex items-center gap-2 min-w-0 overflow-hidden">
				{/* spinner */}
				{isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'idle' ? <LoaderCircle className="animate-spin bg-void-stroke-1 flex-shrink-0 flex-grow-0" size={14} />
					:
					isRunning === 'awaiting_user' ? <MessageCircleQuestion className="bg-void-stroke-1 flex-shrink-0 flex-grow-0" size={14} />
						:
						null}
				{/* name */}
				<span className="truncate overflow-hidden text-ellipsis"
					data-tooltip-id='void-tooltip'
					data-tooltip-content={numMessages + ' messages'}
					data-tooltip-place='top'
				>{firstMsg}</span>

				{/* <span className='opacity-60'>{`(${numMessages})`}</span> */}
			</span>

			<div className="flex items-center gap-x-1 opacity-60">
				{idx === hoveredIdx ?
					<>
						{/* trash icon */}
						<DuplicateButton threadId={pastThread.id} />

						{/* trash icon */}
						<TrashButton threadId={pastThread.id} />
					</>
					: <>
						{detailsHTML}
					</>
				}
			</div>
		</div>
	</div>
}



// Horizontal scrollable tab strip of pinned chat threads, shown at the top of
// the chat sidebar. Tabs are pure UI pins — `unpinThread` never deletes the
// underlying thread (it stays reachable via PastThreadsList / history). Users
// add tabs implicitly by starting a new thread (`+`) or switching to one from
// history; they remove tabs via the × on the tab itself.
export const SidebarThreadTabs = () => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	const threadsState = useChatThreadsState()
	const streamState = useFullChatThreadsStreamState()

	const { allThreads, currentThreadId, pinnedThreadIds, currentWorkspaceUri } = threadsState

	// Defensive filter: only render tabs whose thread still exists. Stale ids
	// are pruned at load time too (see ChatThreadService constructor), but this
	// guards against any in-memory drift between deleteThread and a re-render.
	//
	// Phase E — pin storage is per-workspace at the service layer
	// (`_pinnedThreadIdsByWorkspace`), so `pinnedThreadIds` here is already
	// scoped to this window's workspace. No `isThreadInWorkspaceScope` filter
	// needed: a thread can be pinned in workspace A and workspace B
	// independently, and a foreign thread that appears here was explicitly
	// opened by the user (read-only via commit 3's gating).
	const tabs = (pinnedThreadIds ?? [])
		.filter(id => !!allThreads[id])

	// Keep the active tab in view when threads are switched from outside the
	// strip (e.g. landing-page history click), otherwise long tab rows can
	// silently hide the current selection offscreen.
	const activeTabRef = useRef<HTMLDivElement | null>(null)
	useEffect(() => {
		activeTabRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
	}, [currentThreadId])

	// Nothing meaningful to render if there are no pinned threads. The `+`
	// button below still shows so the user can always start a new chat, even
	// if they unpinned everything (edge case; unpinThread auto-opens a new
	// thread in that situation anyway).
	const showNothing = tabs.length === 0

	return (
		<div
			className='flex items-center gap-0.5 px-1 py-1 border-b border-void-border-2 overflow-x-auto overflow-y-hidden flex-shrink-0'
			// Translate vertical wheel events to horizontal scroll so the strip
			// is usable with a regular mouse wheel (touchpads already scroll
			// horizontally natively).
			onWheel={(e) => {
				if (e.deltaY !== 0 && e.deltaX === 0) {
					e.currentTarget.scrollLeft += e.deltaY
				}
			}}
		>
			{showNothing ? null : tabs.map(id => {
				const t = allThreads[id]!
				const isActive = id === currentThreadId
				const isRunning = streamState[id]?.isRunning

				// Phase E commit 5 — workspace provenance indicator. The icon
				// slot is shared with the running-state spinner above; running
				// always wins (transient + time-sensitive). Indicator fires
				// only in workspaced windows: empty windows have no reference
				// frame to call something "foreign" against.
				//
				//   foreign  → Lock   (same icon as the read-only banner; user
				//                       opened it from "Other workspaces", it's
				//                       pinned here, but mutations still gated)
				//   unscoped → Globe  (legacy / pre-Phase-E thread; editable,
				//                       claim-on-engagement re-tags on next send)
				//
				// Each indicator gets its own tooltip on the icon span — the
				// outer tab keeps the message-preview tooltip, hovering the
				// icon directly reveals the provenance reason.
				const tabIsForeign = isThreadReadOnly(t, currentWorkspaceUri)
				const tabIsUnscoped = !!currentWorkspaceUri && !t.workspaceUri
				const foreignTooltip = tabIsForeign
					? `Read-only — owned by ${t.workspaceLabel ?? t.workspaceUri ?? 'another workspace'}. Use Move or Copy to bring it here.`
					: ''
				const unscopedTooltip = tabIsUnscoped
					? 'Not tied to a workspace yet. Sending a message will claim it for this workspace.'
					: ''

				// Label source of truth matches PastThreadsList: first user
				// message's displayContent, truncated. Empty threads get a
				// neutral "New Chat" label so the tab isn't blank.
				const firstUser = t.messages.find(m => m.role === 'user')
				const label = firstUser && firstUser.role === 'user' && firstUser.displayContent
					? firstUser.displayContent
					: 'New Chat'

				// Truncate the tooltip body. The visible tab label is already clipped
				// by `truncate` CSS (the on-screen tab is at most ~110px wide), but the
				// tooltip contents render the full string verbatim — so a thread whose
				// first user message is a 50KB pasted blob would lay out the entire
				// blob inside the tooltip portal on hover, stalling the main thread.
				// Cap at ~240 chars: enough to show the gist and disambiguate tabs,
				// short enough to render and reflow instantly. Whitespace is collapsed
				// so a paste of "\n\n\n…\n\n\nactual text" doesn't waste the budget on
				// blank lines.
				const TOOLTIP_LABEL_MAX = 240
				const tooltipLabel = (() => {
					const collapsed = label.replace(/\s+/g, ' ').trim()
					if (collapsed.length <= TOOLTIP_LABEL_MAX) return collapsed
					return collapsed.slice(0, TOOLTIP_LABEL_MAX) + '…'
				})()

				return (
					<div
						key={id}
						ref={isActive ? activeTabRef : undefined}
						onClick={() => {
							// See note on PastThreadsList above — tab clicks benefit the most
							// from the transition wrap because the swap is between two heavy threads.
							startTransition(() => {
								chatThreadsService.switchToThread(id)
							})
						}}
						// Middle-click closes, matching conventional tab UX
						// (VS Code editor tabs, browsers, etc).
						onMouseDown={(e) => {
							if (e.button === 1) {
								e.preventDefault()
								chatThreadsService.unpinThread(id)
							}
						}}
						className={`
							group flex items-center gap-1 px-2 py-0.5 rounded text-xs cursor-pointer flex-shrink-0 max-w-[110px] min-w-0 select-none
							${isActive
								? 'bg-zinc-700/10 dark:bg-zinc-300/10 text-void-fg-1'
								: 'text-void-fg-3 opacity-80 hover:opacity-100 hover:bg-zinc-700/5 dark:hover:bg-zinc-300/5'}
						`}
						data-tooltip-id='void-tooltip'
						data-tooltip-content={tooltipLabel}
						data-tooltip-place='bottom'
					>
						{isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'idle'
							? <LoaderCircle className='animate-spin shrink-0' size={10} />
							: isRunning === 'awaiting_user'
								? <MessageCircleQuestion className='shrink-0' size={10} />
								: tabIsForeign
									? <span
										className='shrink-0 inline-flex items-center'
										data-tooltip-id='void-tooltip'
										data-tooltip-content={foreignTooltip}
										data-tooltip-place='bottom'
									>
										<Lock size={10} />
									</span>
									: tabIsUnscoped
										? <span
											className='shrink-0 inline-flex items-center'
											data-tooltip-id='void-tooltip'
											data-tooltip-content={unscopedTooltip}
											data-tooltip-place='bottom'
										>
											<Globe size={10} />
										</span>
										: null}
						<span className='truncate min-w-0'>{label}</span>
						<button
							onClick={(e) => { e.stopPropagation(); chatThreadsService.unpinThread(id); }}
							className='ml-0.5 opacity-0 group-hover:opacity-100 shrink-0 rounded hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center'
							data-tooltip-id='void-tooltip'
							data-tooltip-content='Remove from tabs (thread stays in history)'
							data-tooltip-place='bottom'
						>
							<X size={10} />
						</button>
					</div>
				)
			})}
			<button
				onClick={() => {
					// Opening a new (empty) thread is cheap to render, but the unmount of
					// the OUTGOING heavy thread's bubbles + Monaco editors is the expensive
					// part. Wrapping in startTransition lets that teardown happen without
					// blocking the "+" click response.
					startTransition(() => {
						chatThreadsService.openNewThread()
					})
				}}
				className='shrink-0 ml-0.5 p-1 rounded text-void-fg-3 opacity-70 hover:opacity-100 hover:bg-zinc-700/10 dark:hover:bg-zinc-300/10'
				data-tooltip-id='void-tooltip'
				data-tooltip-content='New chat'
				data-tooltip-place='bottom'
			>
				<Plus size={12} />
			</button>
		</div>
	)
}
