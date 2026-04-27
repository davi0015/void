/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton, IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useFullChatThreadsStreamState, useSettingsState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, Copy, Icon, LoaderCircle, MessageCircleQuestion, Plus, Trash2, UserCheck, X } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';


const numInitialThreads = 3

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);

	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

	const threadsState = useChatThreadsState()
	const { allThreads } = threadsState

	const streamState = useFullChatThreadsStreamState()

	const runningThreadIds: { [threadId: string]: IsRunningType | undefined } = {}
	for (const threadId in streamState) {
		const isRunning = streamState[threadId]?.isRunning
		if (isRunning) { runningThreadIds[threadId] = isRunning }
	}

	if (!allThreads) {
		return <div key="error" className="p-1">{`Error accessing chat history.`}</div>;
	}

	// sorted by most recent to least recent
	const sortedThreadIds = Object.keys(allThreads ?? {})
		.sort((threadId1, threadId2) => (allThreads[threadId1]?.lastModified ?? 0) > (allThreads[threadId2]?.lastModified ?? 0) ? -1 : 1)
		.filter(threadId => (allThreads![threadId]?.messages.length ?? 0) !== 0)

	// Get only first 5 threads if not showing all
	const hasMoreThreads = sortedThreadIds.length > numInitialThreads;
	const displayThreads = showAll ? sortedThreadIds : sortedThreadIds.slice(0, numInitialThreads);

	return (
		<div className={`flex flex-col mb-2 gap-2 w-full text-nowrap text-void-fg-3 select-none relative ${className}`}>
			{displayThreads.length === 0 // this should never happen
				? <></>
				: displayThreads.map((threadId, i) => {
					const pastThread = allThreads[threadId];
					if (!pastThread) {
						return <div key={i} className="p-1">{`Error accessing chat history.`}</div>;
					}

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
				})
			}

			{hasMoreThreads && !showAll && (
				<div
					className="text-void-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(true)}
				>
					Show {sortedThreadIds.length - numInitialThreads} more...
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
		</div>
	);
};





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

	const { allThreads, currentThreadId, pinnedThreadIds } = threadsState

	// Defensive filter: only render tabs whose thread still exists. Stale ids
	// are pruned at load time too (see ChatThreadService constructor), but this
	// guards against any in-memory drift between deleteThread and a re-render.
	const tabs = (pinnedThreadIds ?? []).filter(id => !!allThreads[id])

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
