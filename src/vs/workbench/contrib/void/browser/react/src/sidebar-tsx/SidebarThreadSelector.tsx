/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { CopyButton, IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useFullChatThreadsStreamState, useSettingsState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, ChevronDown, ChevronRight, Copy, Globe, Icon, LoaderCircle, Lock, MessageCircleQuestion, Plus, Trash2, UserCheck, X } from 'lucide-react';
import { isThreadReadOnly, IsRunningType, ThreadType } from '../../../chatThreadService.js';
import { Separator } from '../../../../../../../base/common/actions.js';


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

	// Same label cascade as the tab strip: user-set custom title beats the
	// auto-derived first-user-message text. Keeps the two surfaces in sync
	// when the user renames a tab — the history entry follows.
	let firstMsg = null;
	const customTitle = pastThread.customTitle?.trim();
	if (customTitle) {
		firstMsg = customTitle;
	} else {
		const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');
		if (firstUserMsgIdx !== -1) {
			const firsUsertMsgObj = pastThread.messages[firstUserMsgIdx];
			firstMsg = firsUsertMsgObj.role === 'user' && firsUsertMsgObj.displayContent || '';
		} else {
			firstMsg = '""';
		}
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
	const contextMenuService = accessor.get('IContextMenuService')

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

	// Inline tab rename state. Only one tab can be edited at a time so a
	// single (id, value) pair on the parent suffices — avoids per-tab
	// useState that would re-mount on every state update. Editing is
	// entered via double-click or the right-click context menu's "Rename".
	const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
	const [editValue, setEditValue] = useState<string>('')
	const startRename = (id: string, seedLabel: string) => {
		setEditValue(seedLabel)
		setEditingThreadId(id)
	}
	const commitRename = () => {
		if (editingThreadId == null) return
		// Pass through `setThreadCustomTitle`'s normalization — empty /
		// whitespace clears the override (resets to first-message label).
		chatThreadsService.setThreadCustomTitle(editingThreadId, editValue)
		setEditingThreadId(null)
		setEditValue('')
	}
	const cancelRename = () => {
		setEditingThreadId(null)
		setEditValue('')
	}
	const isEditingAny = editingThreadId !== null

	// Drag-and-drop reorder. Model is "adjacent neighbor swap with a live
	// baseline":
	//   dragSource — threadId being dragged (null when not dragging).
	//   liveOrder  — currently-displayed order during a drag. Starts as a
	//                copy of `tabs` on dragStart; each swap mutates it; on
	//                drop we commit it via the service.
	// Each onDragOver re-reads live DOM rects, so after a swap the next
	// event sees the new layout — no original-rect bookkeeping needed.
	//
	// Vertical-axis lock: native drag image is suppressed (1×1 invisible
	// element via setDragImage). We render our own ghost absolute-positioned
	// inside `stripContainerRef` and imperatively move it on the X axis
	// only — Y is locked so the dragged tab can never leave the strip.
	const [dragSource, setDragSource] = useState<string | null>(null)
	const [liveOrder, setLiveOrder] = useState<string[] | null>(null)
	const stripContainerRef = useRef<HTMLDivElement | null>(null)
	const ghostElRef = useRef<HTMLDivElement | null>(null)
	const ghostMetricsRef = useRef<{
		// Cursor's offset inside the source tab when drag started (so the
		// ghost stays anchored to the same pixel under the cursor).
		offsetX: number
		// Ghost's locked vertical position + size — all in container-relative
		// coords (container = outer strip wrapper, position: relative).
		top: number
		width: number
		height: number
		initialLeft: number
		// Horizontal travel clamp: ghost can't go left of the first tab's
		// left edge or right of the last tab's right edge.
		minLeft: number
		maxLeft: number
		// Container's viewport-left, used to translate cursor.clientX into
		// container-relative left during onDrag.
		containerLeft: number
	}>({
		offsetX: 0, top: 0, width: 0, height: 0,
		initialLeft: 0, minLeft: 0, maxLeft: 0, containerLeft: 0,
	})
	// Apply the captured ghost position before paint so the first frame
	// after `dragSource` becomes set shows the ghost exactly over the
	// source tab — no jump.
	useLayoutEffect(() => {
		if (dragSource && ghostElRef.current) {
			const m = ghostMetricsRef.current
			const el = ghostElRef.current
			el.style.left = `${m.initialLeft}px`
			el.style.top = `${m.top}px`
			el.style.width = `${m.width}px`
			el.style.height = `${m.height}px`
		}
	}, [dragSource])
	const clearDragState = () => {
		setDragSource(null)
		setLiveOrder(null)
	}

	// During a drag, render in the live order. Outside of a drag, the
	// service-backed `tabs` array is the source of truth.
	const renderedTabs = liveOrder ?? tabs

	// Nothing meaningful to render if there are no pinned threads. The `+`
	// button below still shows so the user can always start a new chat, even
	// if they unpinned everything (edge case; unpinThread auto-opens a new
	// thread in that situation anyway).
	const showNothing = tabs.length === 0

	return (
		// The horizontal scrollbar is hidden via the "padding + negative
		// margin + clip" technique. The inner strip gets `pb-3 -mb-3`
		// (12px of internal padding minus 12px of layout height) so its
		// scrollbar is painted 12px below its effective bottom edge, and
		// this outer wrapper's `overflow-hidden` clips that stray 12px.
		// This works reliably on macOS where Webkit's overlay scrollbar
		// can ignore `::-webkit-scrollbar { display: none }` in recent
		// Electron versions.
		// `relative` makes this the positioning context for the drag ghost
		// (rendered as a sibling of the inner strip below). The inner strip
		// can scroll horizontally; the ghost lives in this outer wrapper's
		// non-scrolling coord system so its `left` doesn't slide with
		// scroll.
		<div ref={stripContainerRef} className='border-b border-void-border-2 flex-shrink-0 overflow-hidden relative'>
			<div
				className='flex items-center gap-0.5 px-1 py-1 overflow-x-auto overflow-y-hidden pb-3 -mb-3'
				// Translate vertical wheel events to horizontal scroll so the
				// strip is usable with a regular mouse wheel; touchpads
				// already scroll horizontally natively.
				onWheel={(e) => {
					if (e.deltaY !== 0 && e.deltaX === 0) {
						e.currentTarget.scrollLeft += e.deltaY
					}
				}}
				// Container-level handlers own all the swap + drop logic;
				// per-tab handlers below only deal with starting the drag.
				// dragover bubbles up from any tab the cursor crosses, so a
				// single handler here is enough — and re-querying live DOM
				// rects each event means we never get out of sync with the
				// visual layout (the React re-render after each swap moves
				// the tabs, so the next event sees fresh midpoints).
				onDragOver={dragSource ? (e) => {
					e.preventDefault()
					e.dataTransfer.dropEffect = 'move'

					const mm = ghostMetricsRef.current
					const ghostCenter = (e.clientX - mm.offsetX) + mm.width / 2

					const order = liveOrder ?? tabs
					const srcIdx = order.indexOf(dragSource)
					if (srcIdx === -1) return

					const container = stripContainerRef.current
					if (!container) return

					// Threshold for swapping with a neighbor is the COMBINED
					// midpoint of the source and that neighbor (treat the
					// pair as one rectangle, take its center). For two tabs
					// of widths x and y sitting adjacent, this lands at
					// `(x + y) / 2` from their combined left edge — i.e. the
					// swap fires the moment the dragged tab has overlapped
					// the neighbor more than it still covers its own slot.
					// Earlier than each-tab-midpoint, more in line with how
					// the user reads "the dragged tab has crossed past".
					const sourceEl = container.querySelector<HTMLElement>(`[data-tab-id="${dragSource}"]`)
					if (!sourceEl) return
					const sourceRect = sourceEl.getBoundingClientRect()

					// Right-neighbor swap. Combined midpoint = (source.left + neighbor.right) / 2.
					if (srcIdx < order.length - 1) {
						const rightId = order[srcIdx + 1]
						const rightEl = container.querySelector<HTMLElement>(`[data-tab-id="${rightId}"]`)
						if (rightEl) {
							const r = rightEl.getBoundingClientRect()
							const combinedMid = (sourceRect.left + r.right) / 2
							if (ghostCenter > combinedMid) {
								const next = [...order]
								next[srcIdx] = rightId
								next[srcIdx + 1] = dragSource
								setLiveOrder(next)
								return
							}
						}
					}
					// Left-neighbor swap. Combined midpoint = (neighbor.left + source.right) / 2.
					if (srcIdx > 0) {
						const leftId = order[srcIdx - 1]
						const leftEl = container.querySelector<HTMLElement>(`[data-tab-id="${leftId}"]`)
						if (leftEl) {
							const r = leftEl.getBoundingClientRect()
							const combinedMid = (r.left + sourceRect.right) / 2
							if (ghostCenter < combinedMid) {
								const next = [...order]
								next[srcIdx] = leftId
								next[srcIdx - 1] = dragSource
								setLiveOrder(next)
								return
							}
						}
					}
				} : undefined}
				onDrop={dragSource ? (e) => {
					e.preventDefault()
					// Translate the live order back to the service's
					// (source, target, position) signature: place source
					// `after` its left neighbor when it has one, else
					// `before` its right neighbor. Either expression
					// describes the same final position.
					if (liveOrder) {
						const newIdx = liveOrder.indexOf(dragSource)
						if (newIdx > 0) {
							chatThreadsService.reorderPinnedThread(dragSource, liveOrder[newIdx - 1], 'after')
						} else if (newIdx === 0 && liveOrder.length > 1) {
							chatThreadsService.reorderPinnedThread(dragSource, liveOrder[1], 'before')
						}
					}
					clearDragState()
				} : undefined}
			>
				{showNothing ? null : renderedTabs.map(id => {
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

					// Label cascade: user-set custom title (trimmed, non-empty) wins;
					// otherwise fall back to first user message's displayContent;
					// otherwise "New Chat" so empty threads aren't blank. The
					// custom title is editable via double-click or right-click →
					// Rename. Whitespace-only customTitle resets to default.
					const customTitle = t.customTitle?.trim()
					const firstUser = t.messages.find(m => m.role === 'user')
					const firstMsgLabel = firstUser && firstUser.role === 'user' && firstUser.displayContent
						? firstUser.displayContent
						: 'New Chat'
					const label = customTitle || firstMsgLabel
					const isEditingThis = editingThreadId === id

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

					// Source tab dimmed at its current liveOrder slot so the
					// user sees what's being dragged. The visual feedback
					// for the drop position is the live swap itself.
					const isDragSource = dragSource === id

					return (
						<div
							key={id}
							ref={isActive ? activeTabRef : undefined}
							// data-tab-id lets the container's onDragOver
							// re-query live midpoints each event.
							data-tab-id={id}
							// Disabled while ANY tab is being inline-renamed so
							// the drag doesn't steal focus / drop unsaved input.
							draggable={!isEditingAny}
							onDragStart={(e) => {
								if (isEditingAny) { e.preventDefault(); return }
								e.dataTransfer.effectAllowed = 'move'
								e.dataTransfer.setData('text/plain', id)

								// Suppress the native drag image — we render
								// our own horizontal-only ghost. The element
								// has to be in the DOM for setDragImage to
								// snapshot it, but it's invisible and removed
								// on the next tick.
								const invisible = document.createElement('div')
								invisible.style.cssText = 'width:1px;height:1px;position:fixed;top:-1000px;opacity:0;pointer-events:none;'
								document.body.appendChild(invisible)
								e.dataTransfer.setDragImage(invisible, 0, 0)
								setTimeout(() => { invisible.remove() }, 0)

								const rect = e.currentTarget.getBoundingClientRect()
								const container = stripContainerRef.current
								const containerRect = container?.getBoundingClientRect()
								const cLeft = containerRect?.left ?? 0
								const cTop = containerRect?.top ?? 0

								// Clamp horizontal travel to the first/last
								// tab's edges so the ghost can't escape the
								// strip. Only the first/last rects are needed
								// here — per-event swap thresholds come from
								// live DOM queries in the container handler.
								let minLeft = rect.left - cLeft
								let maxLeft = rect.left - cLeft
								if (container) {
									const tabEls = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'))
									if (tabEls.length > 0) {
										const firstR = tabEls[0].getBoundingClientRect()
										const lastR = tabEls[tabEls.length - 1].getBoundingClientRect()
										minLeft = firstR.left - cLeft
										maxLeft = (lastR.right - cLeft) - rect.width
									}
								}

								ghostMetricsRef.current = {
									offsetX: e.clientX - rect.left,
									top: rect.top - cTop,
									width: rect.width,
									height: rect.height,
									initialLeft: rect.left - cLeft,
									minLeft,
									maxLeft,
									containerLeft: cLeft,
								}

								setDragSource(id)
								setLiveOrder([...tabs])
							}}
							onDrag={(e) => {
								// clientX is 0 on the terminal dragend event — ignore
								// that frame (would snap the ghost to the left edge).
								const el = ghostElRef.current
								const mm = ghostMetricsRef.current
								if (el && e.clientX > 0) {
									const desired = (e.clientX - mm.offsetX) - mm.containerLeft
									const clamped = Math.max(mm.minLeft, Math.min(mm.maxLeft, desired))
									el.style.left = `${clamped}px`
									el.style.top = `${mm.top}px` // lock Y
								}
							}}
							// Always clear on dragend so a drop outside any tab
							// (e.g. off-strip, ESC cancel) doesn't leave stale state.
							onDragEnd={clearDragState}
							onClick={() => {
								// Don't switch threads while editing this tab's label —
								// the input lives inside the same div, so the click that
								// landed inside the textbox would otherwise trigger a
								// switch and lose unsaved input.
								if (isEditingThis) return
								// See note on PastThreadsList above — tab clicks benefit the most
								// from the transition wrap because the swap is between two heavy threads.
								startTransition(() => {
									chatThreadsService.switchToThread(id)
								})
							}}
							// Double-click → enter rename mode. Mirrors VS Code's
							// editor-tab rename UX. Single-click switches (above);
							// double-click is detected after the second click, so
							// the user briefly switches to the tab before entering
							// rename — that's intentional, gives them visual
							// confirmation of which tab they're editing.
							onDoubleClick={(e) => {
								e.stopPropagation()
								if (tabIsForeign) return // read-only foreign threads can't be renamed from this window
								startRename(id, customTitle || firstMsgLabel)
							}}
							// Right-click → Rename / Reset / Unpin. Uses the VS Code
							// platform context menu service (already in the React
							// accessor as `IContextMenuService`) so we get native
							// positioning, keyboard nav, and edge-flipping for free
							// — no third-party dep, no inline portal positioning.
							onContextMenu={(e) => {
								e.preventDefault()
								e.stopPropagation()
								const x = e.clientX
								const y = e.clientY
								contextMenuService.showContextMenu({
									getAnchor: () => ({ x, y }),
									getActions: () => [
										{
											id: 'void.tab.rename',
											label: 'Rename',
											tooltip: '',
											class: undefined,
											// Foreign tabs are read-only — service guard would
											// no-op anyway, but disable the menu item too so the
											// affordance matches reality.
											enabled: !tabIsForeign,
											run: () => startRename(id, customTitle || firstMsgLabel),
										},
										{
											id: 'void.tab.resetTitle',
											label: 'Reset to default name',
											tooltip: '',
											class: undefined,
											enabled: !tabIsForeign && !!customTitle,
											run: () => chatThreadsService.setThreadCustomTitle(id, undefined),
										},
										new Separator(),
										{
											id: 'void.tab.unpin',
											label: 'Close tab',
											tooltip: '',
											class: undefined,
											enabled: true,
											run: () => chatThreadsService.unpinThread(id),
										},
									],
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
								group flex items-center gap-1 px-2 py-0.5 rounded text-xs ${isEditingThis ? '' : 'cursor-pointer'} flex-shrink-0 max-w-[110px] min-w-0 select-none
								${isActive
									? 'bg-zinc-700/10 dark:bg-zinc-300/10 text-void-fg-1'
									: 'text-void-fg-3 opacity-80 hover:opacity-100 hover:bg-zinc-700/5 dark:hover:bg-zinc-300/5'}
								${isDragSource ? 'opacity-40' : ''}
							`}
							data-tooltip-id='void-tooltip'
							data-tooltip-content={isEditingThis ? '' : tooltipLabel}
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
							{isEditingThis ? (
								<input
									type='text'
									value={editValue}
									autoFocus
									onChange={(e) => setEditValue(e.target.value)}
									onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
										if (e.key === 'Enter') { e.preventDefault(); commitRename() }
										else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
										// Stop bubbling so global shortcuts (e.g. cmd+L
										// for chat focus) don't fire mid-rename.
										else { e.stopPropagation() }
									}}
									onBlur={commitRename}
									// Defensive: clicks inside the input should never
									// reach the parent div (which switches threads).
									onClick={(e) => e.stopPropagation()}
									onMouseDown={(e) => e.stopPropagation()}
									onDoubleClick={(e) => e.stopPropagation()}
									className='min-w-0 flex-1 bg-transparent outline-none border-b border-void-border-1 text-xs text-void-fg-1 px-0.5'
									// onFocus selects all so users can immediately start
									// typing to overwrite. select() runs after focus
									// settles to ensure the selection sticks.
									onFocus={(e) => e.currentTarget.select()}
								/>
							) : (
								<span className='truncate min-w-0'>{label}</span>
							)}
							<button
								onClick={(e) => { e.stopPropagation(); chatThreadsService.unpinThread(id); }}
								className={`ml-0.5 ${isEditingThis ? 'opacity-0 pointer-events-none' : 'opacity-0 group-hover:opacity-100'} shrink-0 rounded hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center`}
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
			{/* Custom drag ghost — mounted only while dragging, absolute-
			    positioned in the strip's outer wrapper. `useLayoutEffect`
			    on `dragSource` applies the captured initial position before
			    paint; subsequent frames are positioned imperatively from
			    `onDrag` (so we don't re-render on every drag tick). */}
			{dragSource ? (() => {
				const t = allThreads[dragSource]
				if (!t) return null
				const customTitle = t.customTitle?.trim()
				const firstUser = t.messages.find(m => m.role === 'user')
				const firstMsgLabel = firstUser && firstUser.role === 'user' && firstUser.displayContent ? firstUser.displayContent : 'New Chat'
				const ghostLabel = customTitle || firstMsgLabel
				return (
					<div
						ref={ghostElRef}
						className='absolute pointer-events-none flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-void-bg-2 text-void-fg-1 border border-void-border-1 shadow-md max-w-[110px] min-w-0 select-none opacity-90 z-10'
					>
						<span className='truncate min-w-0'>{ghostLabel}</span>
					</div>
				)
			})() : null}
		</div>
	)
}
