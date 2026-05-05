/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { ButtonHTMLAttributes, FormEvent, FormHTMLAttributes, Fragment, KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';



import { useAccessor, useChatThreadsState, useChatThread, useCurrentWorkspaceUri, useChatThreadsStreamState, useStreamRunningState, useSettingsState, useActiveURI, useCommandBarState, useFullChatThreadsStreamState, useChatThreadLatestUsage, useChatThreadCumulativeUsage, useChatThreadCompaction } from '../util/services.js';

import { ChatMarkdownRender, ChatMessageLocation } from '../markdown/ChatMarkdownRender.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ErrorDisplay } from './ErrorDisplay.js';
import { TextAreaFns, VoidCustomDropdownBox, VoidInputBox2, VoidSlider, VoidSwitch } from '../util/inputs.js';
import { ModelDropdown, } from '../void-settings-tsx/ModelDropdown.js';
import { PastThreadsList, SidebarThreadTabs } from './SidebarThreadSelector.js';
import { VOID_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';
import { ChatMode, displayInfoOfProviderName, FeatureName, isFeatureNameDisabled } from '../../../../../../../workbench/contrib/void/common/voidSettingsTypes.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { WarningBox } from '../void-settings-tsx/WarningBox.js';
import { getModelCapabilities, getIsReasoningEnabledState } from '../../../../common/modelCapabilities.js';
import { File, Check, Dot, FileIcon, ImageIcon, Pencil, Undo, Undo2, X, Flag, Copy as CopyIcon, Info, CirclePlus, Ellipsis, Folder, ALargeSmall, TypeOutline, Text, RefreshCw, TerminalSquare, Lock, MoveRight, FileWarning } from 'lucide-react';
import { ChatMessage, CheckpointEntry, CompactionInfo, StagingSelectionItem, ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../../../base/common/resources.js';
import type { ToolName } from '../../../../common/toolsServiceTypes.js';
import { IconShell1, StatusIndicator } from '../markdown/ApplyBlockHoverButtons.js';
import { IsRunningType, isThreadReadOnly, shouldShowOwnershipBanner } from '../../../chatThreadService.js';
import { acceptAllBg, acceptBorder, buttonFontSize, buttonTextColor, rejectAllBg, rejectBg, rejectBorder } from '../../../../common/helpers/colors.js';
import { isABuiltinToolName, MAX_TERMINAL_INACTIVE_TIME } from '../../../../common/prompt/prompts.js';
import { getBasename, getFolderName, getRelative, voidOpenFileFn, IconLoading, SmallProseWrapper } from './sidebarChatHelpers.js';
import { type LLMUsage, RawToolCallObj } from '../../../../common/sendLLMMessageTypes.js';
import ErrorBoundary from './ErrorBoundary.js';
import {
	builtinToolNameToComponent,
	CanceledTool,
	EditToolChildren,
	InvalidTool,
	MCPToolWrapper,
	ToolChildrenWrapper,
	ToolHeaderWrapper,
	ToolRequestAcceptRejectButtons,
	titleOfBuiltinToolName,
	type ResultWrapper,
} from './ToolResultComponents.js';

export { ListableToolItem, ToolChildrenWrapper } from './ToolResultComponents.js';


export const IconX = ({ size, className = '', ...props }: { size: number, className?: string } & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			xmlns='http://www.w3.org/2000/svg'
			width={size}
			height={size}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			className={className}
			{...props}
		>
			<path
				strokeLinecap='round'
				strokeLinejoin='round'
				d='M6 18 18 6M6 6l12 12'
			/>
		</svg>
	);
};

const IconArrowUp = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			width={size}
			height={size}
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fill="black"
				fillRule="evenodd"
				clipRule="evenodd"
				d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z"
			></path>
		</svg>
	);
};


const IconSquare = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="black"
			fill="black"
			strokeWidth="0"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect x="2" y="2" width="20" height="20" rx="4" ry="4" />
		</svg>
	);
};


export const IconWarning = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 16 16"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"
			/>
		</svg>
	);
};


export { IconLoading } from './sidebarChatHelpers.js';



// SLIDER ONLY:
const ReasoningOptionSlider = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor()

	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()

	const modelSelection = voidSettingsState.modelSelectionOfFeature[featureName]
	const overridesOfModel = voidSettingsState.overridesOfModel

	if (!modelSelection) return null

	const { modelName, providerName } = modelSelection
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel)
	const { canTurnOffReasoning, reasoningSlider: reasoningBudgetSlider } = reasoningCapabilities || {}

	const modelSelectionOptions = voidSettingsState.optionsOfModelSelection[featureName][providerName]?.[modelName]
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)

	if (canTurnOffReasoning && !reasoningBudgetSlider) { // if it's just a on/off toggle without a power slider
		return <div className='flex items-center gap-x-2'>
			<span className='text-void-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<VoidSwitch
				size='xxs'
				value={isReasoningEnabled}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && !newVal
					voidSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff })
				}}
			/>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'budget_slider') { // if it's a slider
		const { min: min_, max, default: defaultVal } = reasoningBudgetSlider

		const nSteps = 8 // only used in calculating stepSize, stepSize is what actually matters
		const stepSize = Math.round((max - min_) / nSteps)

		const valueIfOff = min_ - stepSize
		const min = canTurnOffReasoning ? valueIfOff : min_
		const value = isReasoningEnabled ? voidSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningBudget ?? defaultVal
			: valueIfOff

		return <div className='flex items-center gap-x-2'>
			<span className='text-void-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<VoidSlider
				width={50}
				size='xs'
				min={min}
				max={max}
				step={stepSize}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					voidSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningBudget: newVal })
				}}
			/>
			<span className='text-void-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${value} tokens` : 'Thinking disabled'}</span>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'effort_slider') {

		const { values, default: defaultVal } = reasoningBudgetSlider

		const min = canTurnOffReasoning ? -1 : 0
		const max = values.length - 1

		const currentEffort = voidSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningEffort ?? defaultVal
		const valueIfOff = -1
		const value = isReasoningEnabled && currentEffort ? values.indexOf(currentEffort) : valueIfOff

		const currentEffortCapitalized = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1, Infinity)

		return <div className='flex items-center gap-x-2'>
			<span className='text-void-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<VoidSlider
				width={30}
				size='xs'
				min={min}
				max={max}
				step={1}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					voidSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined })
				}}
			/>
			<span className='text-void-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${currentEffortCapitalized}` : 'Thinking disabled'}</span>
		</div>
	}

	return null
}



const nameOfChatMode = {
	'normal': 'Chat',
	'gather': 'Gather',
	'agent': 'Agent',
}

const detailOfChatMode = {
	'normal': 'Normal chat',
	'gather': 'Reads files, but can\'t edit',
	'agent': 'Edits files and uses tools',
}


const ChatModeDropdown = ({ className }: { className: string }) => {
	const accessor = useAccessor()

	const voidSettingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()

	const options: ChatMode[] = useMemo(() => ['normal', 'gather', 'agent'], [])

	const onChangeOption = useCallback((newVal: ChatMode) => {
		voidSettingsService.setGlobalSetting('chatMode', newVal)
	}, [voidSettingsService])

	return <VoidCustomDropdownBox
		className={className}
		options={options}
		selectedOption={settingsState.globalSettings.chatMode}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => nameOfChatMode[val]}
		getOptionDropdownName={(val) => nameOfChatMode[val]}
		getOptionDropdownDetail={(val) => detailOfChatMode[val]}
		getOptionsEqual={(a, b) => a === b}
	/>

}





// ----- Token usage ring -----
// Wraps the send/stop button with an SVG donut showing totalTokens / contextWindow.
// On hover: shows percentage + per-bucket breakdown (input / output / reasoning / total).

const formatTokenCount = (n: number | undefined): string => {
	if (n === undefined || n === null) return '-'
	if (n < 1_000) return `${n}`
	if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 2 : 1)}k`
	return `${(n / 1_000_000).toFixed(2)}M`
}

const colorForUsagePct = (pct: number) => {
	if (pct < 50) return '#6d28d9'   // violet-700 (normal)
	if (pct < 80) return '#a16207'   // yellow-700 (warning)
	return '#b91c1c'                  // red-700 (critical)
}

interface TokenUsageRingProps {
	// when usage is undefined the wrapper still renders at the same size, but no
	// ring is drawn — this prevents the send button from shifting once usage arrives
	usage: LLMUsage | undefined;
	contextWindow: number; // model's max input context, in tokens
	cumulativeThisTurn?: LLMUsage | undefined;
	cumulativeThisThread?: LLMUsage | undefined;
	// Perf 2 compaction summary — `latestCompaction` is undefined when the last
	// request didn't trim anything; `cumulativeCompactionThisTurn` /
	// `cumulativeCompactionThisThread` are running totals. All three are optional
	// so callers that don't care about compaction visibility can omit them.
	latestCompaction?: CompactionInfo | undefined;
	cumulativeCompactionThisTurn?: CompactionInfo | undefined;
	cumulativeCompactionThisThread?: CompactionInfo | undefined;
	children: React.ReactNode;
	size?: number;
}

// Format a single LLMUsage block for the tooltip. Returns an array of plain
// text lines (no HTML — react-tooltip's html mode is blocked by Trusted Types).
const formatUsageBlock = (label: string, u: LLMUsage | undefined): (string | null)[] => {
	if (!u) return [`${label}: -`]
	const total = u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.reasoningTokens ?? 0))
	const inputLine = u.cachedInputTokens !== undefined
		? `  Input: ${formatTokenCount(u.inputTokens)} (${formatTokenCount(u.cachedInputTokens)} cached)`
		: `  Input: ${formatTokenCount(u.inputTokens)}`
	return [
		`${label}:`,
		inputLine,
		`  Output: ${formatTokenCount(u.outputTokens)}`,
		u.reasoningTokens !== undefined ? `  Reasoning: ${formatTokenCount(u.reasoningTokens)}` : null,
		`  Total: ${formatTokenCount(total)}`,
	]
}

// Format one compaction block for the tooltip. `savedTokens` is pre-computed at
// compaction time using the model's calibrated chars/token ratio (see
// `recordTokenUsageCalibration` in ConvertToLLMMessageService) — we don't
// re-divide here so UI numbers stay consistent with the dev-console log even
// as the ratio updates on subsequent requests.
// Legacy fallback: threads persisted before the `savedTokens` field existed
// only carry `savedChars` — fall back to `savedChars/4` in that case so the
// tooltip doesn't show `~- tokens`. 4 is the conservative default (matches the
// `CHARS_PER_TOKEN` fallback in ConvertToLLMMessageService.ts).
// Returns 1 or 3 lines:
//   • Only Light tier fired (the common case): a single total line.
//   • Emergency also fired: total + two indented sub-lines breaking Light vs.
//     Emergency apart. Light = Total − Emergency (derived from totals — we
//     deliberately don't persist Light separately since "Light = what didn't
//     trigger the destructive path" is always a subtraction). The breakdown
//     matters because the two paths have different cost/safety profiles: Light
//     only touches whitelisted tool result bodies (safe, reversible on re-read);
//     Emergency truncates the heaviest-weight message of any role (can chop a
//     user message or assistant reply down to 120 chars).
const formatCompactionBlock = (label: string, c: CompactionInfo | undefined): string[] => {
	if (!c || c.trimmedCount === 0) return [`${label}: none`]
	// Treat NaN as "missing" too, not just `undefined`. A thread that was
	// persisted with a NaN-poisoned cumulative counter from an earlier build
	// would otherwise keep rendering `~NaNM tokens` forever — falling back to
	// savedChars/4 lets those threads self-heal on the next render.
	const approxTokens = (t: number | undefined, chars: number) =>
		t !== undefined && Number.isFinite(t) ? t : Math.round(chars / 4)
	const pluralResult = (n: number) => n === 1 ? 'result' : 'results'
	const pluralMessage = (n: number) => n === 1 ? 'message' : 'messages'
	const rawTotalTokens = approxTokens(c.savedTokens, c.savedChars)
	const emTrim = c.emergencyTrimmedCount ?? 0
	const emChars = c.emergencySavedChars ?? 0
	const emTokens = approxTokens(c.emergencySavedTokens, emChars)
	// Invariant: Total = Light + Emergency, Light ≥ 0 → Total ≥ Emergency.
	// If the stored total violates this (can happen on threads that were
	// active during the NaN-poisoned `_addCompaction` build — `safe()` zeroed
	// the corrupt `savedTokens` on load, while `emergencySavedTokens`
	// preserved its full history across the same runs), clamp the displayed
	// total up to Emergency so the tooltip stays internally consistent.
	// Same clamp applied to trimmedCount in case the same drift affected it.
	// Better than showing `Total: 309k / Emergency: 326k` which looks like a
	// bug; still undercounted vs. reality (lost Light history can't be
	// recovered), but the displayed numbers now satisfy the invariant and
	// self-heal once new Light compactions push Total past Emergency naturally.
	const totalTokens = Math.max(rawTotalTokens, emTokens)
	const totalTrim = Math.max(c.trimmedCount, emTrim)
	const totalLine = `${label}: ${totalTrim} ${pluralResult(totalTrim)}, saved ~${formatTokenCount(totalTokens)} tokens`
	if (emTrim === 0) return [totalLine]
	const lightTrim = totalTrim - emTrim
	const lightTokens = totalTokens - emTokens
	const emLine = `  ↳ emergency trim: ${emTrim} ${pluralMessage(emTrim)}, saved ~${formatTokenCount(emTokens)} tokens`
	// Skip the Light sub-line when derivation collapses to zero — normal when
	// only Emergency actually did work this request, or (historically) when
	// the Total clamp above kicked in and erased the delta. In either case a
	// `saved ~0 tokens` line would be misleading.
	if (lightTrim <= 0 || lightTokens <= 0) return [totalLine, emLine]
	const lightLine = `  ↳ light tier: ${lightTrim} ${pluralResult(lightTrim)}, saved ~${formatTokenCount(lightTokens)} tokens`
	return [totalLine, lightLine, emLine]
}

const TokenUsageRing: React.FC<TokenUsageRingProps> = ({ usage, contextWindow, cumulativeThisTurn, cumulativeThisThread, latestCompaction, cumulativeCompactionThisTurn, cumulativeCompactionThisThread, children, size = 34 }) => {
	const strokeWidth = 3
	const radius = (size - strokeWidth) / 2
	const hasData = !!usage && contextWindow > 0

	let svgEl: React.ReactNode = null
	let tooltipContent: string | undefined = undefined

	if (hasData && usage) {
		const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0))
		const rawPct = (total / contextWindow) * 100
		const clampedPct = Math.max(0, Math.min(100, rawPct))
		const circumference = 2 * Math.PI * radius
		const dashOffset = circumference * (1 - clampedPct / 100)
		const color = colorForUsagePct(clampedPct)

		const displayPct = rawPct < 0.01 ? '<0.01%' : rawPct < 1 ? `${rawPct.toFixed(2)}%` : `${rawPct.toFixed(1)}%`
		// Use plain text (no HTML) because the renderer enforces Trusted Types and
		// react-tooltip's html mode would set innerHTML directly, which is blocked.
		// `cachedInputTokens` is the portion of `inputTokens` served from the provider's
		// prompt cache (OpenAI `prompt_tokens_details.cached_tokens`, mirrored by OpenRouter,
		// DeepSeek, etc.). Only show the line when the server actually reported a value —
		// an undefined field means the server doesn't expose it, which is different from 0.
		// Tooltip layout:
		//   1. Context-window ring summary (per-request, drives the ring color)
		//   2. Last request breakdown (the per-request snapshot the ring is based on)
		//   3. Cumulative this turn (sum across all loop iterations of the current user turn)
		//   4. Cumulative this thread (lifetime sum across the whole chat history)
		// The cumulative blocks are critical because agent loops issue many requests
		// per turn — total billed tokens grow ~O(N²) while the ring only shows the
		// last request's input.
		// Only render the compaction section when something has ever been
		// compacted on this thread — on short threads with no compaction this
		// keeps the tooltip compact. We gate on cumulative-this-thread because
		// per-turn and latest reset to undefined during quiet periods.
		const hasAnyCompaction = !!cumulativeCompactionThisThread && cumulativeCompactionThisThread.trimmedCount > 0
		// Each `formatCompactionBlock` returns 1–2 lines (2 when the emergency
		// trim fired — see block comment on that fn). Flatten + indent here so
		// the "Emergency trim" sub-line sits visually nested under its parent.
		const indent = (lines: string[]) => lines.map(l => `  ${l}`)
		// `cumulativeThisTurn` is in-memory only — it resets on each new user
		// message, so persisting it would desync with the "turn boundary" logic.
		// After a window restart there's no active turn yet, so this value is
		// undefined even though `usage` (last request, which IS persisted) has
		// data. Falling back to `usage` here means the "this turn" block shows
		// at minimum the last-known request — truthful ("we know at least this
		// much happened in the latest turn") and keeps the tooltip informative
		// immediately after restart instead of showing a bare dash.
		// Same reasoning for `cumulativeCompactionThisTurn`.
		const effectiveThisTurn = cumulativeThisTurn ?? usage
		const effectiveCompactionThisTurn = cumulativeCompactionThisTurn ?? latestCompaction
		const compactionLines = hasAnyCompaction ? [
			``,
			`History compaction`,
			...indent(formatCompactionBlock('Last request', latestCompaction)),
			...indent(formatCompactionBlock('This turn', effectiveCompactionThisTurn)),
			...indent(formatCompactionBlock('This thread', cumulativeCompactionThisThread)),
		] : []
		tooltipContent = [
			`Context window usage`,
			`${formatTokenCount(total)} / ${formatTokenCount(contextWindow)} (${displayPct})`,
			``,
			...formatUsageBlock('Last request', usage),
			``,
			...formatUsageBlock('Cumulative this turn', effectiveThisTurn),
			``,
			...formatUsageBlock('Cumulative this thread', cumulativeThisThread),
			...compactionLines,
		].filter(s => s !== null).join('\n')

		svgEl = (
			<svg
				className='absolute inset-0'
				width={size}
				height={size}
				style={{ transform: 'rotate(-90deg)' }}
			>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					stroke='rgba(180,180,180,0.45)'
					strokeWidth={strokeWidth}
					fill='none'
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					stroke={color}
					strokeWidth={strokeWidth}
					fill='none'
					strokeDasharray={circumference}
					strokeDashoffset={dashOffset}
					strokeLinecap='butt'
					style={{ transition: 'stroke-dashoffset 250ms ease, stroke 250ms ease' }}
				/>
			</svg>
		)
	}

	return (
		<div
			className='relative flex items-center justify-center flex-shrink-0'
			style={{ width: size, height: size }}
			data-tooltip-id={hasData ? 'void-tooltip' : undefined}
			data-tooltip-content={tooltipContent}
			data-tooltip-place={hasData ? 'left' : undefined}
		>
			{svgEl}
			<div className='relative z-1 flex items-center justify-center'>{children}</div>
		</div>
	)
}

// Chooses whether to wrap the send/stop button in a ring based on the current chat
// thread's latest usage and the active model's context window.
const SubmitButtonWithUsageRing: React.FC<{ threadId: string; featureName: FeatureName; children: React.ReactNode }> = ({ threadId, featureName, children }) => {
	const settingsState = useSettingsState()
	const usage = useChatThreadLatestUsage(threadId)
	const cumulative = useChatThreadCumulativeUsage(threadId)
	const compaction = useChatThreadCompaction(threadId)

	const modelSelection = settingsState.modelSelectionOfFeature[featureName]
	// Always render the wrapper so the send button doesn't jump sideways when
	// usage first becomes available. TokenUsageRing hides the SVG when there's
	// no data, but keeps the size reserved.
	const contextWindow = modelSelection
		? getModelCapabilities(modelSelection.providerName, modelSelection.modelName, settingsState.overridesOfModel).contextWindow
		: 0

	return (
		<TokenUsageRing
			usage={usage}
			contextWindow={contextWindow}
			cumulativeThisTurn={cumulative.thisTurn}
			cumulativeThisThread={cumulative.thisThread}
			latestCompaction={compaction.latest}
			cumulativeCompactionThisTurn={compaction.thisTurn}
			cumulativeCompactionThisThread={compaction.thisThread}
		>
			{children}
		</TokenUsageRing>
	)
}


const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
const extForMime: Record<ImageMimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

const IMAGE_MAX_DIMENSION = 1024
const IMAGE_JPEG_QUALITY = 0.85

const compressImage = (file: File, mimeType: ImageMimeType): Promise<{ bytes: Uint8Array, mimeType: ImageMimeType }> => {
	// GIFs: skip resize to preserve animation
	if (mimeType === 'image/gif') {
		return file.arrayBuffer().then(ab => ({ bytes: new Uint8Array(ab), mimeType }))
	}
	return new Promise((resolve, reject) => {
		const img = new Image()
		const url = URL.createObjectURL(file)
		img.onload = () => {
			URL.revokeObjectURL(url)
			let { width, height } = img
			const longest = Math.max(width, height)
			if (longest > IMAGE_MAX_DIMENSION) {
				const scale = IMAGE_MAX_DIMENSION / longest
				width = Math.round(width * scale)
				height = Math.round(height * scale)
			}

			const canvas = document.createElement('canvas')
			canvas.width = width
			canvas.height = height
			const ctx = canvas.getContext('2d')!
			ctx.drawImage(img, 0, 0, width, height)

			// Re-encode PNGs as WebP for smaller size; JPEG/WebP keep their format
			const outputMime: ImageMimeType = mimeType === 'image/png' ? 'image/webp' : mimeType
			const quality = outputMime === 'image/webp' || outputMime === 'image/jpeg' ? IMAGE_JPEG_QUALITY : undefined
			canvas.toBlob(
				blob => {
					if (!blob) { reject(new Error('Canvas toBlob failed')); return }
					blob.arrayBuffer().then(ab => resolve({ bytes: new Uint8Array(ab), mimeType: outputMime }))
				},
				outputMime,
				quality,
			)
		}
		img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')) }
		img.src = url
	})
}

const pendingImageData = new Map<string, { blobUrl: string, bytes: Uint8Array | null }>()

const cleanupPendingImage = (uriPath: string) => {
	const entry = pendingImageData.get(uriPath)
	if (entry) {
		URL.revokeObjectURL(entry.blobUrl)
		pendingImageData.delete(uriPath)
	}
}

// Free the raw bytes but keep the blob URL alive for thumbnails.
const releasePendingImageBytes = (uriPath: string) => {
	const entry = pendingImageData.get(uriPath)
	if (entry) entry.bytes = null
}

const flushPendingImages = async (selections: StagingSelectionItem[], fileService: { writeFile(uri: URI, content: any): Promise<any> }) => {
	for (const s of selections) {
		if (s.type !== 'Image') continue
		const entry = pendingImageData.get(s.uri.path)
		if (!entry?.bytes) continue
		await fileService.writeFile(s.uri, VSBuffer.wrap(entry.bytes))
		cleanupPendingImage(s.uri.path)
	}
}

const useImageUploadEnabled = () => {
	const settingsState = useSettingsState()
	return useMemo(() => {
		const chatModel = settingsState.modelSelectionOfFeature['Chat']
		if (!chatModel) return false
		const caps = getModelCapabilities(chatModel.providerName, chatModel.modelName, settingsState.overridesOfModel)
		if (caps.supportsVision) return true
		return settingsState.modelSelectionOfFeature['VisionHelper'] !== null
	}, [settingsState.modelSelectionOfFeature, settingsState.overridesOfModel])
}

const useImageAttach = (selections: StagingSelectionItem[] | undefined, setSelections: ((s: StagingSelectionItem[]) => void) | undefined) => {
	const accessor = useAccessor()
	const fileInputRef = useRef<HTMLInputElement>(null)

	const handleImageFiles = useCallback(async (files: FileList | File[]) => {
		if (!setSelections || !selections) return
		const envService = accessor.get('IEnvironmentService')
		const imageDir = joinPath(envService.userRoamingDataHome, 'voidImages')

		const newSelections: StagingSelectionItem[] = []
		for (const file of files) {
			if (!IMAGE_MIME_TYPES.has(file.type)) continue
			const srcMime = file.type as ImageMimeType
			const id = generateUuid()
			const fileName = file.name || `pasted-image.${extForMime[srcMime]}`

			const { bytes, mimeType } = await compressImage(file, srcMime)
			const ext = extForMime[mimeType]
			const fileUri = joinPath(imageDir, `${id}.${ext}`)

			const blob = new Blob([bytes], { type: mimeType })
			const blobUrl = URL.createObjectURL(blob)
			pendingImageData.set(fileUri.path, { blobUrl, bytes })

			newSelections.push({
				type: 'Image',
				uri: fileUri,
				mimeType,
				fileName,
				state: { wasAddedAsCurrentFile: false },
			})
		}
		if (newSelections.length > 0) {
			setSelections([...selections, ...newSelections])
		}
	}, [accessor, selections, setSelections])

	const onPaste = useCallback((e: React.ClipboardEvent) => {
		const items = e.clipboardData?.items
		if (!items) return
		const imageFiles: File[] = []
		for (const item of items) {
			if (item.kind === 'file' && IMAGE_MIME_TYPES.has(item.type)) {
				const file = item.getAsFile()
				if (file) imageFiles.push(file)
			}
		}
		if (imageFiles.length > 0) {
			e.preventDefault()
			handleImageFiles(imageFiles)
		}
	}, [handleImageFiles])

	const onDrop = useCallback((e: React.DragEvent) => {
		const files = e.dataTransfer?.files
		if (!files) return
		const imageFiles: File[] = []
		for (const file of files) {
			if (IMAGE_MIME_TYPES.has(file.type)) imageFiles.push(file)
		}
		if (imageFiles.length > 0) {
			e.preventDefault()
			e.stopPropagation()
			handleImageFiles(imageFiles)
		}
	}, [handleImageFiles])

	const onDragOver = useCallback((e: React.DragEvent) => {
		if (e.dataTransfer?.types?.includes('Files')) {
			e.preventDefault()
		}
	}, [])

	return { onPaste, onDrop, onDragOver, handleImageFiles, fileInputRef }
}

interface VoidChatAreaProps {
	// Required
	children: React.ReactNode; // This will be the input component

	// Form controls
	onSubmit: () => void;
	onAbort: () => void;
	isStreaming: boolean;
	isDisabled?: boolean;
	divRef?: React.RefObject<HTMLDivElement | null>;

	// when provided, the send/stop button is wrapped with a ring showing
	// totalTokens / model.contextWindow for the latest LLM usage on this thread
	threadIdForUsageRing?: string;

	// UI customization
	className?: string;
	showModelDropdown?: boolean;
	showSelections?: boolean;
	showProspectiveSelections?: boolean;
	loadingIcon?: React.ReactNode;

	selections?: StagingSelectionItem[]
	setSelections?: (s: StagingSelectionItem[]) => void

	imageAttach?: ReturnType<typeof useImageAttach>;

	onClickAnywhere?: () => void;
	// Optional close button
	onClose?: () => void;

	featureName: FeatureName;
}

export const VoidChatArea: React.FC<VoidChatAreaProps> = ({
	children,
	onSubmit,
	onAbort,
	onClose,
	onClickAnywhere,
	divRef,
	isStreaming = false,
	isDisabled = false,
	className = '',
	showModelDropdown = true,
	showSelections = false,
	showProspectiveSelections = false,
	selections,
	setSelections,
	featureName,
	loadingIcon,
	threadIdForUsageRing,
	imageAttach,
}) => {
	const _fallbackImageAttach = useImageAttach(selections, setSelections)
	const { onPaste, onDrop, onDragOver, handleImageFiles, fileInputRef } = imageAttach ?? _fallbackImageAttach
	const imageUploadEnabled = useImageUploadEnabled()

	return (
		<div
			ref={divRef}
			className={`
				gap-x-1
                flex flex-col p-2 relative input text-left shrink-0
                rounded-md
                bg-void-bg-1
				transition-all duration-200
				border border-void-border-3 focus-within:border-void-border-1 hover:border-void-border-1
				max-h-[80vh] overflow-y-auto
                ${className}
            `}
			onClick={(e) => {
				onClickAnywhere?.()
			}}
			onPaste={imageUploadEnabled ? onPaste : undefined}
			onDrop={imageUploadEnabled ? onDrop : undefined}
			onDragOver={imageUploadEnabled ? onDragOver : undefined}
		>
			{/* Selections section */}
			{showSelections && selections && setSelections && (
				<SelectedFiles
					type='staging'
					selections={selections}
					setSelections={setSelections}
					showProspectiveSelections={showProspectiveSelections}
				/>
			)}

			{/* Input section */}
			<div className="relative w-full">
				{children}

				{/* Close button (X) if onClose is provided */}
				{onClose && (
					<div className='absolute -top-1 -right-1 cursor-pointer z-1'>
						<IconX
							size={12}
							className="stroke-[2] opacity-80 text-void-fg-3 hover:brightness-95"
							onClick={onClose}
						/>
					</div>
				)}
			</div>

			{/* Bottom row */}
			<div className='flex flex-row justify-between items-end gap-1'>
				{showModelDropdown && (
					<div className='flex flex-col gap-y-1'>
						<ReasoningOptionSlider featureName={featureName} />

						<div className='flex items-center flex-wrap gap-x-2 gap-y-1 text-nowrap '>
							{featureName === 'Chat' && <ChatModeDropdown className='text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-2 rounded py-0.5 px-1' />}
							<ModelDropdown featureName={featureName} className='text-xs text-void-fg-3 bg-void-bg-1 rounded' />
						</div>
					</div>
				)}

				<div className="flex items-center gap-1.5">

					{isStreaming && loadingIcon}

					{setSelections && imageUploadEnabled && (
						<>
							<input
								ref={fileInputRef}
								type='file'
								accept='image/png,image/jpeg,image/webp,image/gif'
								multiple
								className='hidden'
								onChange={(e) => {
									if (e.target.files && e.target.files.length > 0) {
										handleImageFiles(Array.from(e.target.files))
									}
									e.target.value = ''
								}}
							/>
							<button
								type='button'
								className='flex items-center justify-center cursor-pointer rounded-md p-1 text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-2 transition-colors duration-150'
								onClick={() => fileInputRef.current?.click()}
								data-tooltip-id='void-tooltip'
								data-tooltip-content='Attach image'
								data-tooltip-place='top'
							>
								<ImageIcon size={18} className='stroke-[1.5]' />
							</button>
						</>
					)}

					{(() => {
						const button = isStreaming
							? <ButtonStop onClick={onAbort} />
							: <ButtonSubmit onClick={onSubmit} disabled={isDisabled} />
						if (!threadIdForUsageRing) return button
						return (
							<SubmitButtonWithUsageRing threadId={threadIdForUsageRing} featureName={featureName}>
								{button}
							</SubmitButtonWithUsageRing>
						)
					})()}
				</div>

			</div>
		</div>
	);
};




type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
const DEFAULT_BUTTON_SIZE = 22;
export const ButtonSubmit = ({ className, disabled, ...props }: ButtonProps & Required<Pick<ButtonProps, 'disabled'>>) => {

	return <button
		type='button'
		className={`rounded-full flex-shrink-0 flex-grow-0 flex items-center justify-center
			${disabled ? 'bg-vscode-disabled-fg cursor-default' : 'bg-white cursor-pointer'}
			${className}
		`}
		// data-tooltip-id='void-tooltip'
		// data-tooltip-content={'Send'}
		// data-tooltip-place='left'
		{...props}
	>
		<IconArrowUp size={DEFAULT_BUTTON_SIZE} className="stroke-[2] p-[2px]" />
	</button>
}

export const ButtonStop = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		className={`rounded-full flex-shrink-0 flex-grow-0 cursor-pointer flex items-center justify-center
			bg-white
			${className}
		`}
		type='button'
		{...props}
	>
		<IconSquare size={DEFAULT_BUTTON_SIZE} className="stroke-[3] p-[7px]" />
	</button>
}



const scrollToBottom = (divRef: { current: HTMLElement | null }) => {
	if (divRef.current) {
		divRef.current.scrollTop = 1e10;
	}
};



const ScrollToBottomContainer = ({ children, className, style, scrollContainerRef }: { children: React.ReactNode, className?: string, style?: React.CSSProperties, scrollContainerRef: React.MutableRefObject<HTMLDivElement | null> }) => {
	const isAtBottomRef = useRef(true);

	const divRef = scrollContainerRef

	const onScroll = useCallback(() => {
		const div = divRef.current;
		if (!div) return;

		isAtBottomRef.current = Math.abs(
			div.scrollHeight - div.clientHeight - div.scrollTop
		) < 40;
	}, [divRef]);

	useEffect(() => {
		if (isAtBottomRef.current) {
			scrollToBottom(divRef);
		}
	}, [children]);

	useEffect(() => {
		scrollToBottom(divRef);
	}, []);

	return (
		<div
			ref={divRef}
			onScroll={onScroll}
			className={className}
			style={style}
		>
			{children}
		</div>
	);
};

export { getRelative, getFolderName, getBasename } from './sidebarChatHelpers.js';



export { voidOpenFileFn } from './sidebarChatHelpers.js';


const ImageThumbnail = ({ uri, mimeType, fileName, onRemove }: { uri: URI, mimeType: string, fileName: string, onRemove?: () => void }) => {
	const accessor = useAccessor()
	const [blobUrl, setBlobUrl] = useState<string | null>(() => pendingImageData.get(uri.path)?.blobUrl ?? null)
	const [expanded, setExpanded] = useState(false)
	useEffect(() => {
		const pending = pendingImageData.get(uri.path)
		if (pending) {
			setBlobUrl(pending.blobUrl)
			// Also try loading from disk in the background. Once the file is
			// available, swap to a fresh blob URL and free the pending entry.
			const fileService = accessor.get('IFileService')
			let cancelled = false
			fileService.readFile(uri).then(content => {
				if (cancelled) return
				const blob = new Blob([content.value.buffer], { type: mimeType })
				setBlobUrl(URL.createObjectURL(blob))
				cleanupPendingImage(uri.path)
			}).catch(() => { })
			return () => { cancelled = true }
		}
		let revoked = false
		const fileService = accessor.get('IFileService')
		fileService.readFile(uri).then(content => {
			if (revoked) return
			const blob = new Blob([content.value.buffer], { type: mimeType })
			setBlobUrl(URL.createObjectURL(blob))
		}).catch(e => {
			console.warn('[ImageThumbnail] Failed to read image:', uri.toString(), e)
			// Retry with file:// scheme in case the URI scheme changed
			if (uri.scheme !== 'file' && uri.path) {
				const fileUri = URI.file(uri.path)
				fileService.readFile(fileUri).then(content => {
					if (revoked) return
					const blob = new Blob([content.value.buffer], { type: mimeType })
					setBlobUrl(URL.createObjectURL(blob))
				}).catch(() => { })
			}
		})
		return () => { revoked = true }
	}, [uri.path])

	return (
		<>
			<div
				className='relative group rounded-sm overflow-hidden border border-void-border-1 h-6 w-6 flex items-center justify-center cursor-pointer bg-void-bg-1 hover:brightness-95 transition-all duration-150 flex-shrink-0'
				onClick={(e) => { e.stopPropagation(); if (blobUrl) setExpanded(true) }}
				data-tooltip-id='void-tooltip'
				data-tooltip-content={`${fileName} (${mimeType})`}
				data-tooltip-place='top'
				data-tooltip-delay-show={3000}
			>
				{blobUrl
					? <img src={blobUrl} alt='' className='h-full w-full object-cover' />
					: <ImageIcon size={10} className='text-void-fg-3' />
				}
				{onRemove && (
					<div
						className='absolute top-0 right-0 cursor-pointer rounded-full bg-black/60 p-px opacity-0 group-hover:opacity-100 transition-opacity'
						onClick={(e) => { e.stopPropagation(); onRemove() }}
					>
						<X className='stroke-[2] text-white' size={8} />
					</div>
				)}
			</div>

			{expanded && blobUrl && (
				<div
					className='fixed inset-0 z-50 flex items-center justify-center bg-black/70'
					onClick={() => setExpanded(false)}
				>
					<img
						src={blobUrl}
						alt={fileName}
						className='max-w-[80vw] max-h-[80vh] object-contain rounded-md shadow-2xl'
						onClick={(e) => e.stopPropagation()}
					/>
				</div>
			)}
		</>
	)
}

export const SelectedFiles = (
	{ type, selections, setSelections, showProspectiveSelections, messageIdx, }:
		| { type: 'past', selections: StagingSelectionItem[]; setSelections?: undefined, showProspectiveSelections?: undefined, messageIdx: number, }
		| { type: 'staging', selections: StagingSelectionItem[]; setSelections: ((newSelections: StagingSelectionItem[]) => void), showProspectiveSelections?: boolean, messageIdx?: number }
) => {

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const modelReferenceService = accessor.get('IVoidModelService')




	// state for tracking prospective files
	const { uri: currentURI } = useActiveURI()
	const [recentUris, setRecentUris] = useState<URI[]>([])
	const maxRecentUris = 10
	const maxProspectiveFiles = 3
	useEffect(() => { // handle recent files
		if (!currentURI) return
		setRecentUris(prev => {
			const withoutCurrent = prev.filter(uri => uri.fsPath !== currentURI.fsPath) // remove duplicates
			const withCurrent = [currentURI, ...withoutCurrent]
			return withCurrent.slice(0, maxRecentUris)
		})
	}, [currentURI])
	const [prospectiveSelections, setProspectiveSelections] = useState<StagingSelectionItem[]>([])


	// handle prospective files
	useEffect(() => {
		const computeRecents = async () => {
			const prospectiveURIs = recentUris
				.filter(uri => !selections.find(s => s.type === 'File' && s.uri.fsPath === uri.fsPath))
				.slice(0, maxProspectiveFiles)

			const answer: StagingSelectionItem[] = []
			for (const uri of prospectiveURIs) {
				answer.push({
					type: 'File',
					uri: uri,
					language: (await modelReferenceService.getModelSafe(uri)).model?.getLanguageId() || 'plaintext',
					state: { wasAddedAsCurrentFile: false },
				})
			}
			return answer
		}

		// add a prospective file if type === 'staging' and if the user is in a file, and if the file is not selected yet
		if (type === 'staging' && showProspectiveSelections) {
			computeRecents().then((a) => setProspectiveSelections(a))
		}
		else {
			setProspectiveSelections([])
		}
	}, [recentUris, selections, type, showProspectiveSelections])


	const allSelections = [...selections, ...prospectiveSelections]

	if (allSelections.length === 0) {
		return null
	}

	return (
		<div className='flex items-center flex-wrap text-left relative gap-x-0.5 gap-y-1 pb-0.5'>

			{allSelections.map((selection, i) => {

				const isThisSelectionProspective = i > selections.length - 1

				const thisKey = selection.type === 'CodeSelection' ? selection.type + selection.language + selection.range + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
					: selection.type === 'File' ? selection.type + selection.language + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
						: selection.type === 'Folder' ? selection.type + selection.language + selection.state + selection.uri.fsPath
							// Terminal snapshots key off their unique synthetic URI so two
							// captures of the same command never collapse into one chip.
							: selection.type === 'Terminal' ? selection.type + selection.uri.path
								: selection.type === 'Image' ? selection.type + selection.uri.path
									: i

			const SelectionIcon = (
				selection.type === 'File' ? File
					: selection.type === 'Folder' ? Folder
						: selection.type === 'CodeSelection' ? Text
							: selection.type === 'Terminal' ? TerminalSquare
								: (undefined as never)
			)

				if (selection.type === 'Image') {
				return <ImageThumbnail
					key={thisKey}
					uri={selection.uri}
					mimeType={selection.mimeType}
					fileName={selection.fileName}
					onRemove={type === 'staging' ? () => {
						cleanupPendingImage(selection.uri.path)
						setSelections([...selections.slice(0, i), ...selections.slice(i + 1)])
					} : undefined}
				/>
			}

			return <div // container for summarybox and code
					key={thisKey}
					className={`flex flex-col space-y-[1px]`}
				>
					{/* tooltip for file path */}
					<span className="truncate overflow-hidden text-ellipsis"
						data-tooltip-id='void-tooltip'
						data-tooltip-content={
							// Terminal chips: hover shows command + cwd + a few preview
							// lines so the user can recall what's inside without
							// expanding. Cap the preview so a 10K-line capture doesn't
							// render an oversized tooltip portal (same trick as the
							// thread-tab tooltip cap).
							selection.type === 'Terminal'
								? (() => {
									const TERMINAL_TOOLTIP_PREVIEW_LINES = 12
									const TERMINAL_TOOLTIP_MAX_CHARS = 600
									const headerLines: string[] = []
									if (selection.command) headerLines.push(`$ ${selection.command}`)
									if (selection.cwd) headerLines.push(`cwd: ${selection.cwd}`)
									if (typeof selection.exitCode === 'number') headerLines.push(`exit ${selection.exitCode}`)
									const previewLines = selection.text.split('\n').slice(0, TERMINAL_TOOLTIP_PREVIEW_LINES)
									const preview = previewLines.join('\n')
									const body = preview.length > TERMINAL_TOOLTIP_MAX_CHARS
										? preview.slice(0, TERMINAL_TOOLTIP_MAX_CHARS) + '\n…'
										: preview
									return [...headerLines, body].filter(Boolean).join('\n')
								})()
								: getRelative(selection.uri, accessor)
						}
						data-tooltip-place='top'
						data-tooltip-delay-show={3000}
					>
						{/* summarybox */}
						<div
							className={`
								flex items-center gap-1 relative
								px-1
								w-fit h-fit
								select-none
								text-xs text-nowrap
								border rounded-sm
								${isThisSelectionProspective ? 'bg-void-bg-1 text-void-fg-3 opacity-80' : 'bg-void-bg-1 hover:brightness-95 text-void-fg-1'}
								${isThisSelectionProspective
									? 'border-void-border-2'
									: 'border-void-border-1'
								}
								hover:border-void-border-1
								transition-all duration-150
							`}
							onClick={() => {
								if (type !== 'staging') return; // (never)
								if (isThisSelectionProspective) { // add prospective selection to selections
									setSelections([...selections, selection])
								}
								else if (selection.type === 'File') { // open files
									voidOpenFileFn(selection.uri, accessor);

									const wasAddedAsCurrentFile = selection.state.wasAddedAsCurrentFile
									if (wasAddedAsCurrentFile) {
										// make it so the file is added permanently, not just as the current file
										const newSelection: StagingSelectionItem = { ...selection, state: { ...selection.state, wasAddedAsCurrentFile: false } }
										setSelections([
											...selections.slice(0, i),
											newSelection,
											...selections.slice(i + 1)
										])
									}
								}
								else if (selection.type === 'CodeSelection') {
									voidOpenFileFn(selection.uri, accessor, selection.range);
								}
								else if (selection.type === 'Folder') {
									// TODO!!! reveal in tree
								}
							else if (selection.type === 'Terminal') {
								// No-op for now. Terminal output is a snapshot — we
								// don't try to scroll the source terminal back to the
								// captured position because (a) the terminal may have
								// been closed, (b) the buffer may have scrolled past,
								// (c) xterm has no public "select range" API. The
								// tooltip carries enough preview context.
							}
							}}
						>
							{<SelectionIcon size={10} />}

						{ // file name and range, or terminal label
							selection.type === 'Terminal'
								? selection.label
								: getBasename(selection.uri.fsPath)
									+ (selection.type === 'CodeSelection' ? ` (${selection.range[0]}-${selection.range[1]})` : '')
						}

							{selection.type === 'File' && selection.state.wasAddedAsCurrentFile && messageIdx === undefined && currentURI?.fsPath === selection.uri.fsPath ?
								<span className={`text-[8px] 'void-opacity-60 text-void-fg-4`}>
									{`(Current File)`}
								</span>
								: null
							}

							{type === 'staging' && !isThisSelectionProspective ? // X button
								<div // box for making it easier to click
									className='cursor-pointer z-1 self-stretch flex items-center justify-center'
									onClick={(e) => {
										e.stopPropagation(); // don't open/close selection
										if (type !== 'staging') return;
										setSelections([...selections.slice(0, i), ...selections.slice(i + 1)])
									}}
								>
									<IconX
										className='stroke-[2]'
										size={10}
									/>
								</div>
								: <></>
							}
						</div>
					</span>
				</div>

			})}


		</div>

	)
}






const UserMessageComponent = ({ chatMessage, messageIdx, isCheckpointGhost, currCheckpointIdx, _scrollToBottom, isReadOnly }: { chatMessage: ChatMessage & { role: 'user' }, messageIdx: number, currCheckpointIdx: number | undefined, isCheckpointGhost: boolean, _scrollToBottom: (() => void) | null, isReadOnly: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// global state
	let isBeingEdited = false
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx)
		isBeingEdited = _state.isBeingEdited
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v })
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s })
	}

	const editImageAttach = useImageAttach(stagingSelections, setStagingSelections)
	const editImageUploadEnabled = useImageUploadEnabled()

	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const bubbleRef = useRef<HTMLDivElement>(null)
	const [isTruncated, setIsTruncated] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true)
	const _justEnabledEdit = useRef(false)
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } }
					else return s
				})
			)

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			textAreaRefState.focus();

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

	}, [chatMessage, mode, _justEnabledEdit, textAreaRefState, textAreaFnsRef.current, _justEnabledEdit.current, _mustInitialize.current])

	useLayoutEffect(() => {
		const el = bubbleRef.current
		if (el && mode === 'display') {
			setIsTruncated(el.scrollHeight > el.clientHeight + 1)
		}
	}, [mode, chatMessage.displayContent])

	const onOpenEdit = () => {
		setIsBeingEdited(true)
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

	}

	const EditSymbol = mode === 'display' ? Pencil : X


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		chatbubbleContents = <>
			<SelectedFiles type='past' messageIdx={messageIdx} selections={chatMessage.selections || []} />
			<span className='px-0.5'>{chatMessage.displayContent}</span>
		</>
	}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;

			// cancel any streams on this thread
			const threadId = chatThreadsService.state.currentThreadId

			await chatThreadsService.abortRunning(threadId)

			// Flush any newly added images during edit to disk
			if (stagingSelections.some(s => s.type === 'Image' && pendingImageData.has(s.uri.path))) {
				const fileService = accessor.get('IFileService')
				await flushPendingImages(stagingSelections, fileService)
			}

			// update state
			setIsBeingEdited(false)
			chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId })
			} catch (e) {
				console.error('Error while editing message:', e)
			}
			await chatThreadsService.focusCurrentChat()
			requestAnimationFrame(() => _scrollToBottom?.())
		}

		const onAbort = async () => {
			const threadId = chatThreadsService.state.currentThreadId
			await chatThreadsService.abortRunning(threadId)
		}

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				onCloseEdit()
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit()
			}
		}

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null
		}

		chatbubbleContents = <VoidChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
			imageAttach={editImageAttach}
			threadIdForUsageRing={chatThreadsService.state.currentThreadId}
		>
			<VoidInputBox2
				enableAtToMention
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5'
				placeholder="Edit your message..."
				onChangeText={(text) => setIsDisabled(!text)}
				onPaste={editImageUploadEnabled ? editImageAttach.onPaste : undefined}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false)
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>
		</VoidChatArea>
	}

	const isMsgAfterCheckpoint = currCheckpointIdx !== undefined && currCheckpointIdx === messageIdx - 1

	// Rule-change chip. Rendered above the user bubble when `.voidrules` was
	// edited between this send and the previous one on the same thread. Set by
	// `chatThreadService._addUserMessageAndStreamResponse` at message creation
	// time; see `getCurrentVoidRulesContent` and `thread.lastAppliedRules` for
	// the detection logic. Dimmed along with the bubble when the message is on
	// the far side of the current checkpoint so the visual grouping matches.
	const rulesChangedBefore = !!chatMessage.rulesChangedBefore

	return <>
		{rulesChangedBefore &&
			<div
				className={`
					self-end flex items-center gap-1 text-xs text-void-fg-3 opacity-80 mb-1 mr-1
					${isCheckpointGhost && !isMsgAfterCheckpoint ? 'opacity-50' : ''}
				`}
				data-tooltip-id='void-tooltip'
				data-tooltip-content='Your .voidrules changed before this message. The new rules apply from here onwards.'
				data-tooltip-place='left'
			>
				<RefreshCw size={11} />
				<span>.voidrules updated</span>
			</div>
		}
		<div
			// align chatbubble accoridng to role
			className={`
        relative ml-auto
        ${mode === 'edit' ? 'w-full max-w-full'
					: mode === 'display' ? `self-end w-fit max-w-full whitespace-pre-wrap` : '' // user words should be pre
				}

        ${isCheckpointGhost && !isMsgAfterCheckpoint ? 'opacity-50 pointer-events-none' : ''}
    `}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
		<div
			ref={bubbleRef}
			className={`
            text-left rounded-lg max-w-full
            ${mode === 'edit' ? ''
					: mode === 'display' ? `relative p-2 flex flex-col bg-void-bg-1 text-void-fg-1 overflow-x-auto max-h-[4.5em] overflow-y-hidden` : ''
				}
        `}
		>
			{chatbubbleContents}
			{mode === 'display' && isTruncated && (
				<div
					className="absolute bottom-0 left-0 right-0 h-[1.5em] pointer-events-none rounded-b-lg"
					style={{ background: 'linear-gradient(to bottom, transparent, var(--void-bg-1))' }}
				/>
			)}
		</div>



		{!isReadOnly && <div
			className="absolute -top-1 -right-1 translate-x-0 -translate-y-0 z-1"
		// data-tooltip-id='void-tooltip'
		// data-tooltip-content='Edit message'
		// data-tooltip-place='left'
		>
			<EditSymbol
				size={18}
				className={`
                    cursor-pointer
                    p-[2px]
                    bg-void-bg-1 border border-void-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit()
					} else if (mode === 'edit') {
						onCloseEdit()
					}
				}}
			/>
		</div>}


		</div>
	</>

}

export { SmallProseWrapper } from './sidebarChatHelpers.js';

// Main assistant-message wrapper. Mirrors SmallProseWrapper's tightening pass:
// explicit body size, capped heading sizes (only ~1px above body so `**bold**`
// + `### Heading` don't visually dominate the chat), tightened paragraph/list
// margins. Without these overrides, `prose prose-sm` defaults render h1 at
// ~21px and h2 at ~20px against ~14px body, which felt oversized in a narrow
// sidebar. Keep `text-void-fg-2` (vs. SmallProseWrapper's fg-4) so the main
// reply still reads as primary content.
const ProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-void-fg-2
prose
prose-sm
break-words
max-w-none
text-[13px]
leading-snug

[&>:first-child]:!mt-0
[&>:last-child]:!mb-0

prose-h1:text-[14px]
prose-h1:my-3
prose-h1:font-semibold

prose-h2:text-[13px]
prose-h2:my-3
prose-h2:font-semibold

prose-h3:text-[13px]
prose-h3:my-2
prose-h3:font-semibold

prose-h4:text-[13px]
prose-h4:my-2
prose-h4:font-semibold

prose-p:my-1.5
prose-p:leading-snug
prose-p:block

prose-ul:my-1.5
prose-ul:pl-4
prose-ul:list-outside
prose-ul:list-disc
prose-ul:leading-snug

prose-ol:my-1.5
prose-ol:pl-4
prose-ol:list-outside
prose-ol:list-decimal
prose-ol:leading-snug

prose-li:my-0
prose-li:leading-snug

prose-strong:font-semibold

prose-blockquote:pl-2
prose-blockquote:my-2

prose-hr:my-3
prose-pre:my-2

prose-code:text-[12px]
prose-code:before:content-none
prose-code:after:content-none

marker:text-inherit
'
	>
		{children}
	</div>
}
const AssistantMessageComponent = ({ chatMessage, isCheckpointGhost, isCommitted, messageIdx }: { chatMessage: ChatMessage & { role: 'assistant' }, isCheckpointGhost: boolean, messageIdx: number, isCommitted: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	const reasoningStr = chatMessage.reasoning?.trim() || null
	const hasReasoning = !!reasoningStr
	const isDoneReasoning = !!chatMessage.displayContent
	const thread = chatThreadsService.getCurrentThread()


	const chatMessageLocation: ChatMessageLocation = useMemo(() => ({
		threadId: thread.id,
		messageIdx: messageIdx,
	}), [thread.id, messageIdx])

	const isEmpty = !chatMessage.displayContent && !chatMessage.reasoning
	if (isEmpty) return null

	// Show a truncation warning when the provider reported a non-clean stream end.
	// Only rendered on committed messages (so we don't flash a scary banner mid-stream —
	// the `finish_reason` is set on the final chunk, but until we've taken the round-
	// trip through `onFinalMessage` + `_addMessageToThread`, we don't trust it).
	// Empty/undefined reason → no warning (Anthropic/Gemini paths, or any OAI-compatible
	// server that doesn't report finish_reason).
	const finishReason = chatMessage.finishReason
	const showTruncationWarning = isCommitted
		&& !!finishReason
		&& finishReason !== 'stop'
		&& finishReason !== 'tool_calls'
		&& finishReason !== 'function_call'
	const truncationWarningText =
		finishReason === 'length' ? 'Response truncated — model hit its output-token limit (finish_reason: length).' :
			finishReason === 'content_filter' ? 'Response blocked — provider content filter (finish_reason: content_filter).' :
				`Response ended unexpectedly (finish_reason: ${finishReason}).`

	return <>
		{/* reasoning token — always mounted during streaming to avoid reflow on transition */}
		{hasReasoning &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<ReasoningWrapper isDoneReasoning={isDoneReasoning} isStreaming={!isCommitted}>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={reasoningStr}
							chatMessageLocation={chatMessageLocation}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
							isStreaming={!isCommitted}
						/>
					</SmallProseWrapper>
				</ReasoningWrapper>
			</div>
		}

		{/* assistant message — during streaming, keep mounted but hidden until content arrives
		    so the DOM structure doesn't change on the reasoning→text transition */}
		{(chatMessage.displayContent || !isCommitted) &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`} style={!chatMessage.displayContent ? { display: 'none' } : undefined}>
				<ProseWrapper>
					<ChatMarkdownRender
						string={chatMessage.displayContent || ''}
						chatMessageLocation={chatMessageLocation}
						isApplyEnabled={true}
						isLinkDetectionEnabled={true}
						isStreaming={!isCommitted}
					/>
				</ProseWrapper>
			</div>
		}

		{showTruncationWarning &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''} mt-1`}>
				<WarningBox text={truncationWarningText} />
			</div>
		}
	</>

}

const ReasoningWrapper = ({ isDoneReasoning, isStreaming, children }: { isDoneReasoning: boolean, isStreaming: boolean, children: React.ReactNode }) => {
	const isDone = isDoneReasoning || !isStreaming
	const isWriting = !isDone
	const [isOpen, setIsOpen] = useState(isWriting)
	const scrollRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!isWriting) setIsOpen(false) // if just finished reasoning, close
	}, [isWriting])
	// While streaming, keep the box pinned to the bottom so the user sees the
	// latest thoughts without having to scroll. Once done, respect user scroll.
	useEffect(() => {
		if (!isWriting || !isOpen) return
		const el = scrollRef.current
		if (el) el.scrollTop = 1e10
	}, [children, isWriting, isOpen])
	return <ToolHeaderWrapper title='Reasoning' desc1={isWriting ? <IconLoading /> : ''} isOpen={isOpen} onClick={() => setIsOpen(v => !v)}>
		<ToolChildrenWrapper>
			<div
				ref={scrollRef}
				className='!select-text cursor-auto max-h-60 overflow-y-auto'
			>
				{children}
			</div>
		</ToolChildrenWrapper>
	</ToolHeaderWrapper>
}






// Phase E commit 4 — banner that sits above the message list when the
// active thread is read-only here. Two cases produce read-only:
//   (a) thread is owned by another workspace (`isUnscoped === false`)
//   (b) thread is unscoped — legacy, pre-Phase-E, or created in an
//       empty window (`isUnscoped === true`)
// Both paths offer the same two actions:
//   - Copy: clone the thread into the current workspace (usage counters
//     reset, importedFrom* stamped, source untouched).
//   - Move: re-tag the thread to the current workspace in place. For
//     foreign threads, source loses access from its origin workspace's
//     default view. For unscoped threads, there's no "origin" to leave
//     behind — Move just claims it.
//
// Either action auto-pins the resulting thread to this workspace's
// strip and switches focus, so the user can immediately start editing.
// Until they choose, every mutation entry on the service is gated
// (commit 3) — the banner is the explicit user-facing path out of
// read-only mode.
const ReadOnlyForeignThreadBanner = ({ ownerLabel, isUnscoped, threadId }: { ownerLabel: string, isUnscoped: boolean, threadId: string }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	const onCopy = () => { chatThreadsService.copyThreadToCurrentWorkspace(threadId) }
	const onMove = () => { chatThreadsService.moveThreadToCurrentWorkspace(threadId) }

	// Two banner variants. Foreign = "Read-only" (input is gated). Unscoped =
	// "Not tied to a workspace" (input still works; banner just exposes
	// explicit Copy/Claim so the user doesn't have to learn the implicit
	// claim-on-send pathway). Mirrors `isThreadReadOnly` vs
	// `shouldShowOwnershipBanner` in chatThreadService.
	const headerText = isUnscoped
		? <>Not tied to a workspace yet — <span className='opacity-90'>editable, claim to keep it here</span></>
		: <>Read-only — owned by <span className='opacity-90'>{ownerLabel}</span></>

	const moveTooltip = isUnscoped
		? 'Tag this thread to the current workspace. It disappears from "Other workspaces → Unscoped" and stays in this workspace going forward.'
		: 'Re-tag this thread to this workspace. It disappears from the source workspace.'

	return (
		<div className='mx-3 my-2 px-3 py-2 rounded border border-void-stroke-1 bg-void-bg-3 text-xs flex flex-col gap-2'>
			<div className='flex items-center gap-2 text-void-fg-3'>
				{isUnscoped ? <Info size={12} className='flex-shrink-0' /> : <Lock size={12} className='flex-shrink-0' />}
				<span className='truncate'>{headerText}</span>
			</div>
			<div className='flex items-center gap-2'>
				<button
					type='button'
					className='flex items-center gap-1 px-2 py-1 rounded text-void-fg-2 hover:bg-zinc-700/10 dark:hover:bg-zinc-300/10 cursor-pointer'
					onClick={onCopy}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Clone into this workspace. Original stays where it is; usage counters reset on the copy.'
				>
					<CopyIcon size={12} />
					<span>Copy here</span>
				</button>
				<button
					type='button'
					className='flex items-center gap-1 px-2 py-1 rounded text-void-fg-2 hover:bg-zinc-700/10 dark:hover:bg-zinc-300/10 cursor-pointer'
					onClick={onMove}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content={moveTooltip}
				>
					<MoveRight size={12} />
					<span>{isUnscoped ? 'Claim here' : 'Move here'}</span>
				</button>
			</div>
		</div>
	)
}

const Checkpoint = ({ message, threadId, messageIdx, isCheckpointGhost, threadIsRunning }: { message: CheckpointEntry, threadId: string; messageIdx: number, isCheckpointGhost: boolean, threadIsRunning: boolean }) => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const streamState = useFullChatThreadsStreamState()

	const isRunning = useChatThreadsStreamState(threadId)?.isRunning
	const isDisabled = useMemo(() => {
		if (isRunning) return true
		return !!Object.keys(streamState).find((threadId2) => streamState[threadId2]?.isRunning)
	}, [isRunning, streamState])

	return <div
		className={`flex items-center justify-center px-2 `}
	>
		<div
			className={`
                    text-xs
                    text-void-fg-3
                    select-none
                    ${isCheckpointGhost ? 'opacity-50' : 'opacity-100'}
					${isDisabled ? 'cursor-default' : 'cursor-pointer'}
                `}
			style={{ position: 'relative', display: 'inline-block' }} // allow absolute icon
			onClick={() => {
				if (threadIsRunning) return
				if (isDisabled) return
				chatThreadService.jumpToCheckpointBeforeMessageIdx({
					threadId,
					messageIdx,
					jumpToUserModified: messageIdx === (chatThreadService.state.allThreads[threadId]?.messages.length ?? 0) - 1
				})
			}}
			{...isDisabled ? {
				'data-tooltip-id': 'void-tooltip',
				'data-tooltip-content': `Disabled ${isRunning ? 'when running' : 'because another thread is running'}`,
				'data-tooltip-place': 'top',
			} : {}}
		>
			Checkpoint
		</div>
	</div>
}


type ChatBubbleMode = 'display' | 'edit'
type ChatBubbleProps = {
	chatMessage: ChatMessage,
	messageIdx: number,
	isCommitted: boolean,
	chatIsRunning: IsRunningType,
	threadId: string,
	currCheckpointIdx: number | undefined,
	_scrollToBottom: (() => void) | null,
	// Phase E commit 4 — true when this thread is foreign to the current
	// workspace and `editUserMessageAndStreamResponse` would be blocked at
	// the service level. Threaded down to `UserMessageComponent` to hide
	// the in-bubble edit pencil + the bubble-as-button click-to-edit path
	// so the UI agrees with the service guard.
	threadIsReadOnly: boolean,
	// Index of the message that currently owns the approve/reject prompt (the earliest
	// tool_request in the consecutive trailing batch). When a multi-tool batch is
	// pre-added, all queued tool_requests share the same status but only the first one
	// should render the buttons; the others are "waiting their turn". undefined = no
	// pending approval anywhere in the thread.
	firstPendingToolRequestIdx?: number,
}

const ChatBubble = React.memo((props: ChatBubbleProps) => {
	return <ErrorBoundary>
		<_ChatBubble {...props} />
	</ErrorBoundary>
})

const _ChatBubble = ({ threadId, chatMessage, currCheckpointIdx, isCommitted, messageIdx, chatIsRunning, _scrollToBottom, firstPendingToolRequestIdx, threadIsReadOnly }: ChatBubbleProps) => {

	const role = chatMessage.role

	const isCheckpointGhost = messageIdx > (currCheckpointIdx ?? Infinity) && !chatIsRunning // whether to show as gray (if chat is running, for good measure just dont show any ghosts)

	if (role === 'user') {
		return <UserMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			currCheckpointIdx={currCheckpointIdx}
			messageIdx={messageIdx}
			_scrollToBottom={_scrollToBottom}
			isReadOnly={threadIsReadOnly}
		/>
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
		/>
	}
	else if (role === 'tool') {

		if (chatMessage.type === 'invalid_params') {
			return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
			</div>
		}

		const toolName = chatMessage.name
		const isBuiltInTool = isABuiltinToolName(toolName)
		const ToolResultWrapper = isBuiltInTool ? builtinToolNameToComponent[toolName]?.resultWrapper as ResultWrapper<ToolName>
			: MCPToolWrapper as ResultWrapper<ToolName>

		if (ToolResultWrapper)
			return <>
				<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
					<ToolResultWrapper
						toolMessage={chatMessage}
						messageIdx={messageIdx}
						threadId={threadId}
					/>
				</div>
				{chatMessage.type === 'tool_request' && messageIdx === firstPendingToolRequestIdx ?
					<div className={`${isCheckpointGhost ? 'opacity-50 pointer-events-none' : ''}`}>
						<ToolRequestAcceptRejectButtons toolName={chatMessage.name} />
					</div> : null}
			</>
		return null
	}

	else if (role === 'interrupted_streaming_tool') {
		return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
		</div>
	}

	else if (role === 'checkpoint') {
		return <Checkpoint
			threadId={threadId}
			message={chatMessage}
			messageIdx={messageIdx}
			isCheckpointGhost={isCheckpointGhost}
			threadIsRunning={!!chatIsRunning}
		/>
	}

}

const CommandBarInChat = React.memo(() => {
	const commandBarState = useCommandBarState()
	const { stateOfURI: commandBarStateOfURI, sortedURIs: sortedCommandBarURIs } = commandBarState
	const numFilesChanged = sortedCommandBarURIs.length

	const accessor = useAccessor()
	const editCodeService = accessor.get('IEditCodeService')
	const commandService = accessor.get('ICommandService')
	const chatThreadsState = useChatThreadsState()
	const threadIsRunning = useStreamRunningState(chatThreadsState.currentThreadId)

	// (
	// 	<IconShell1
	// 		Icon={CopyIcon}
	// 		onClick={copyChatToClipboard}
	// 		data-tooltip-id='void-tooltip'
	// 		data-tooltip-place='top'
	// 		data-tooltip-content='Copy chat JSON'
	// 	/>
	// )

	const [fileDetailsOpenedState, setFileDetailsOpenedState] = useState<'auto-opened' | 'auto-closed' | 'user-opened' | 'user-closed'>('auto-closed');
	const isFileDetailsOpened = fileDetailsOpenedState === 'auto-opened' || fileDetailsOpenedState === 'user-opened';


	useEffect(() => {
		// close the file details if there are no files
		// this converts 'user-closed' to 'auto-closed'
		if (numFilesChanged === 0) {
			setFileDetailsOpenedState('auto-closed')
		}
		// open the file details if it hasnt been closed
		if (numFilesChanged > 0 && fileDetailsOpenedState !== 'user-closed') {
			setFileDetailsOpenedState('auto-opened')
		}
	}, [fileDetailsOpenedState, setFileDetailsOpenedState, numFilesChanged])


	const isFinishedMakingThreadChanges = (
		// there are changed files
		commandBarState.sortedURIs.length !== 0
		// none of the files are streaming
		&& commandBarState.sortedURIs.every(uri => !commandBarState.stateOfURI[uri.fsPath]?.isStreaming)
	)

	// ======== status of agent ========
	// This icon answers the question "is the LLM doing work on this thread?"
	// assume it is single threaded for now
	// green = Running
	// orange = Requires action
	// dark = Done

	const threadStatus = (
		threadIsRunning === 'awaiting_user' ? { title: 'Needs Approval', color: 'yellow', } as const
			: threadIsRunning ? { title: 'Running', color: 'orange', } as const
				: { title: 'Done', color: 'dark', } as const
	)


	const threadStatusHTML = <StatusIndicator className='mx-1' indicatorColor={threadStatus.color} title={threadStatus.title} />


	// ======== info about changes ========
	// num files changed
	// acceptall + rejectall
	// popup info about each change (each with num changes + acceptall + rejectall of their own)

	const numFilesChangedStr = numFilesChanged === 0 ? 'No files with changes'
		: `${sortedCommandBarURIs.length} file${numFilesChanged === 1 ? '' : 's'} with changes`




	const acceptRejectAllButtons = <div
		// do this with opacity so that the height remains the same at all times
		className={`flex items-center gap-0.5
			${isFinishedMakingThreadChanges ? '' : 'opacity-0 pointer-events-none'}`
		}
	>
		<IconShell1 // RejectAllButtonWrapper
			// text="Reject All"
			// className="text-xs"
			Icon={X}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "reject",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Reject all'
		/>

		<IconShell1 // AcceptAllButtonWrapper
			// text="Accept All"
			// className="text-xs"
			Icon={Check}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "accept",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='void-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Accept all'
		/>



	</div>


	// !select-text cursor-auto
	const fileDetailsContent = <div className="px-2 gap-1 w-full overflow-y-auto">
		{sortedCommandBarURIs.map((uri, i) => {
			const basename = getBasename(uri.fsPath)

			const { sortedDiffIds, isStreaming } = commandBarStateOfURI[uri.fsPath] ?? {}
			const isFinishedMakingFileChanges = !isStreaming

			const numDiffs = sortedDiffIds?.length || 0

			const fileStatus = (isFinishedMakingFileChanges
				? { title: 'Done', color: 'dark', } as const
				: { title: 'Running', color: 'orange', } as const
			)

			const fileNameHTML = <div
				className="flex items-center gap-1.5 text-void-fg-3 hover:brightness-125 transition-all duration-200 cursor-pointer"
				onClick={() => voidOpenFileFn(uri, accessor)}
			>
				{/* <FileIcon size={14} className="text-void-fg-3" /> */}
				<span className="text-void-fg-3">{basename}</span>
			</div>




			const detailsContent = <div className='flex px-4'>
				<span className="text-void-fg-3 opacity-80">{numDiffs} diff{numDiffs !== 1 ? 's' : ''}</span>
			</div>

			const acceptRejectButtons = <div
				// do this with opacity so that the height remains the same at all times
				className={`flex items-center gap-0.5
					${isFinishedMakingFileChanges ? '' : 'opacity-0 pointer-events-none'}
				`}
			>
				{/* <JumpToFileButton
					uri={uri}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Go to file'
				/> */}
				<IconShell1 // RejectAllButtonWrapper
					Icon={X}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "reject", _addToHistory: true, }); }}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Reject file'

				/>
				<IconShell1 // AcceptAllButtonWrapper
					Icon={Check}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "accept", _addToHistory: true, }); }}
					data-tooltip-id='void-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Accept file'
				/>

			</div>

			const fileStatusHTML = <StatusIndicator className='mx-1' indicatorColor={fileStatus.color} title={fileStatus.title} />

			return (
				// name, details
				<div key={i} className="flex justify-between items-center">
					<div className="flex items-center">
						{fileNameHTML}
						{detailsContent}
					</div>
					<div className="flex items-center gap-2">
						{acceptRejectButtons}
						{fileStatusHTML}
					</div>
				</div>
			)
		})}
	</div>

	const fileDetailsButton = (
		<button
			className={`flex items-center gap-1 rounded ${numFilesChanged === 0 ? 'cursor-pointer' : 'cursor-pointer hover:brightness-125 transition-all duration-200'}`}
			onClick={() => isFileDetailsOpened ? setFileDetailsOpenedState('user-closed') : setFileDetailsOpenedState('user-opened')}
			type='button'
			disabled={numFilesChanged === 0}
		>
			<svg
				className="transition-transform duration-200 size-3.5"
				style={{
					transform: isFileDetailsOpened ? 'rotate(0deg)' : 'rotate(180deg)',
					transition: 'transform 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)'
				}}
				xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline>
			</svg>
			{numFilesChangedStr}
		</button>
	)

	return (
		<>
			{/* file details */}
			<div className='px-2'>
				<div
					className={`
						select-none
						flex w-full rounded-t-lg bg-void-bg-3
						text-void-fg-3 text-xs text-nowrap

						overflow-hidden transition-all duration-200 ease-in-out
						${isFileDetailsOpened ? 'max-h-24' : 'max-h-0'}
					`}
				>
					{fileDetailsContent}
				</div>
			</div>
			{/* main content */}
			<div
				className={`
					select-none
					flex w-full rounded-t-lg bg-void-bg-3
					text-void-fg-3 text-xs text-nowrap
					border-t border-l border-r border-zinc-300/10

					px-2 py-1
					justify-between
				`}
			>
				<div className="flex gap-2 items-center">
					{fileDetailsButton}
				</div>
				<div className="flex gap-2 items-center">
					{acceptRejectAllButtons}
					{threadStatusHTML}
				</div>
			</div>
		</>
	)
})



const EditToolSoFar = ({ toolCallSoFar, }: { toolCallSoFar: RawToolCallObj }) => {

	if (!isABuiltinToolName(toolCallSoFar.name)) return null

	const accessor = useAccessor()

	const uri = toolCallSoFar.rawParams.uri ? URI.file(toolCallSoFar.rawParams.uri) : undefined

	const title = titleOfBuiltinToolName[toolCallSoFar.name].proposed

	const uriDone = toolCallSoFar.doneParams.includes('uri')
	const desc1 = <span className='flex items-center'>
		{uriDone ?
			getBasename(toolCallSoFar.rawParams['uri'] ?? 'unknown')
			: `Generating`}
		<IconLoading />
	</span>

	const desc1OnClick = () => { uri && voidOpenFileFn(uri, accessor) }

	// If URI has not been specified
	return <ToolHeaderWrapper
		title={title}
		desc1={desc1}
		desc1OnClick={desc1OnClick}
	>
		<EditToolChildren
			uri={uri}
			code={toolCallSoFar.rawParams.search_replace_blocks ?? toolCallSoFar.rawParams.new_content ?? ''}
			type={'rewrite'}
			isStreaming={true}
		/>
		<IconLoading />
	</ToolHeaderWrapper>

}


// Renders the message list + streaming state + error display for a single thread.
// Extracted so that SidebarChat can render multiple of these in parallel (hidden
// via the `hidden` attribute when not active), which preserves each thread's
// React state — ChatBubble collapse toggles, tool-row open state, scroll position,
// mounted Monaco editors — across tab switches. Returning to a recently-seen
// thread then costs ~0ms because no remounting happens; only the `hidden` flag flips.
//
// Each instance owns its own scroll container ref and subscribes to its own stream
// state, so a background thread can keep streaming while the user is looking at a
// different one.

const VIEWPORT_FILL_FACTOR = 3

const ThreadMessagesView = React.memo(({ threadId, isActive, scrollContainerRef }: {
	threadId: string
	isActive: boolean
	scrollContainerRef: React.MutableRefObject<HTMLDivElement | null>
}) => {
	const thread = useChatThread(threadId)
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadsService = accessor.get('IChatThreadService')
	const currentWorkspaceUri = useCurrentWorkspaceUri()
	const previousMessages = thread?.messages ?? []
	// Phase E commit 4 — propagated to each user-message bubble so the in-
	// bubble pencil and click-to-edit path agree with the input-area gating
	// in `SidebarChat`. Computed here (rather than in `_ChatBubble`) to
	// avoid one `useChatThreadsState` subscription per message.
	const threadIsReadOnly = isThreadReadOnly(thread, currentWorkspaceUri)

	const streamState = useChatThreadsStreamState(threadId)
	const isRunning = streamState?.isRunning
	const latestError = streamState?.error
	const { displayContentSoFar, toolCallsSoFar, reasoningSoFar } = streamState?.llmInfo ?? {}
	// During streaming the "currently being written" tool is the last one in the array
	// (indices are emitted in order). Earlier tools in the batch may already be complete
	// (their argument JSON fully streamed) but their persisted tool_request rows only
	// show up in `thread.messages` once onFinalMessage fires and the batch is committed.
	// For the live preview here we just show the latest in-flight tool.
	const currentInFlightTool = toolCallsSoFar && toolCallsSoFar.length > 0 ? toolCallsSoFar[toolCallsSoFar.length - 1] : undefined
	const toolIsGenerating = currentInFlightTool && !currentInFlightTool.isDone

	const currCheckpointIdx = thread?.state?.currCheckpointIdx ?? undefined

	// Scroll to bottom when this view becomes active (on initial mount AND on
	// re-activation after being hidden). Native scrollTop is preserved while
	// hidden, but new messages may have streamed in while the user was on
	// another thread, so landing-at-bottom on return keeps UX consistent with
	// the previous single-thread behavior.
	useEffect(() => {
		if (isActive) {
			scrollToBottom(scrollContainerRef)
		}
	}, [isActive, scrollContainerRef])

	// Index of the "currently awaiting approval" tool request — the earliest of the
	// consecutive trailing tool_request messages. Matches _getPendingBatchTools() in
	// the service. For a solo tool call this is just the last message (same as the
	// pre-batch behavior). For a multi-tool batch, it's the first pending one; later
	// queued tool_requests render as stacked progress rows without approve/reject
	// buttons.
	const firstPendingToolRequestIdx = useMemo(() => {
		let earliest: number | undefined
		for (let i = previousMessages.length - 1; i >= 0; i--) {
			const m = previousMessages[i]
			if (m.role === 'tool' && m.type === 'tool_request') earliest = i
			else break
		}
		return earliest
	}, [previousMessages])

	const scrollToBottomCb = useCallback(() => scrollToBottom(scrollContainerRef), [scrollContainerRef])

	// --- E9: Wrapper-spacer virtualization ---
	// Messages render inside a wrapper div (spacerRef) whose height is
	// controlled via direct DOM manipulation. When mountStart changes,
	// useLayoutEffect measures the new content height and adjusts both
	// the wrapper height and scrollTop in the correct order to prevent
	// the browser from clamping scrollTop during the transition.
	const totalCount = previousMessages.length
	const [mountStart, setMountStart] = useState(Math.max(0, totalCount - 1))

	const mountStartRef = useRef(mountStart)
	mountStartRef.current = mountStart
	const totalCountRef = useRef(totalCount)
	totalCountRef.current = totalCount

	const spacerRef = useRef<HTMLDivElement | null>(null)
	const contentRef = useRef<HTMLDivElement | null>(null)
	const spacerHeightRef = useRef(0)
	const lastScrollTopRef = useRef(0)

	const getContentHeight = useCallback(() => {
		return contentRef.current?.offsetHeight ?? 0
	}, [])

	const getAvgHeight = useCallback(() => {
		const contentH = getContentHeight()
		const mounted = totalCountRef.current - mountStartRef.current
		return mounted > 0 && contentH > 0 ? contentH / mounted : 200
	}, [getContentHeight])

	const msgsForPx = useCallback((px: number) => {
		const avg = getAvgHeight()
		return Math.max(1, Math.ceil(px / avg))
	}, [getAvgHeight])

	// Adaptive initial mount: start with 1, measure, fill viewport.
	const initialFillDoneRef = useRef(false)
	useLayoutEffect(() => {
		if (initialFillDoneRef.current) return
		const scrollEl = scrollContainerRef.current
		if (!scrollEl || !isActive) return
		if (scrollEl.clientHeight === 0) return
		const target = scrollEl.clientHeight * VIEWPORT_FILL_FACTOR
		const contentH = getContentHeight()
		if (contentH >= target || mountStart === 0) {
			initialFillDoneRef.current = true
			spacerHeightRef.current = contentH
			if (spacerRef.current) spacerRef.current.style.height = contentH + 'px'
			return
		}
		const deficit = target - contentH
		const needed = msgsForPx(deficit)
		setMountStart(prev => Math.max(0, prev - needed))
	}, [mountStart, totalCount, isActive, scrollContainerRef, msgsForPx, getContentHeight])

	// Sync wrapper height + scrollTop after expand/trim.
	// Expand (delta > 0): grow wrapper first, then adjust scrollTop.
	// Trim (delta < 0): adjust scrollTop first, then shrink wrapper.
	// This ordering prevents the browser from clamping scrollTop.
	const prevMountStartRef = useRef(mountStart)
	useLayoutEffect(() => {
		if (!initialFillDoneRef.current) return
		const scrollEl = scrollContainerRef.current
		const spacerEl = spacerRef.current
		if (!scrollEl || !spacerEl) return

		const contentH = getContentHeight()
		const oldH = spacerHeightRef.current
		const delta = contentH - oldH
		const mountStartChanged = mountStart !== prevMountStartRef.current
		prevMountStartRef.current = mountStart

		if (Math.abs(delta) < 1) return

		spacerHeightRef.current = contentH
		mountChangeRef.current = true

		if (mountStartChanged) {
			if (delta > 0) {
				spacerEl.style.height = contentH + 'px'
				scrollEl.scrollTop += delta
			} else {
				scrollEl.scrollTop += delta
				spacerEl.style.height = contentH + 'px'
			}
			lastScrollTopRef.current = scrollEl.scrollTop
		} else {
			spacerEl.style.height = contentH + 'px'
		}
		requestAnimationFrame(() => { mountChangeRef.current = false })
	}, [mountStart, totalCount, scrollContainerRef, getContentHeight])

	// ResizeObserver: sync wrapper height + scrollTop when content resizes
	// outside of expand/trim (e.g., LazyBlockCode placeholder → Monaco swap).
	// Without this, the wrapper stays stale and accumulates delta until the
	// next mount change, causing a big jump.
	// Skip scrollTop compensation when width changed (panel resize / reflow).
	const mountChangeRef = useRef(false)
	useEffect(() => {
		const contentEl = contentRef.current
		const spacerEl = spacerRef.current
		const scrollEl = scrollContainerRef.current
		if (!contentEl || !spacerEl || !scrollEl) return
		if (typeof ResizeObserver === 'undefined') return

		let prevWidth = scrollEl.clientWidth

		const ro = new ResizeObserver(() => {
			if (!initialFillDoneRef.current) return
			if (mountChangeRef.current) return

			const currWidth = scrollEl.clientWidth
			const widthChanged = currWidth !== prevWidth
			prevWidth = currWidth

			const contentH = contentEl.offsetHeight
			const oldH = spacerHeightRef.current
			const delta = contentH - oldH
			if (Math.abs(delta) < 1) return

			spacerHeightRef.current = contentH
			spacerEl.style.height = contentH + 'px'

			if (!widthChanged) {
				scrollEl.scrollTop += delta
				lastScrollTopRef.current = scrollEl.scrollTop
			}
		})
		ro.observe(contentEl)
		return () => ro.disconnect()
	}, [scrollContainerRef])

	const expandUp = useCallback(() => {
		const scrollEl = scrollContainerRef.current
		if (!scrollEl) return
		const batch = msgsForPx(scrollEl.clientHeight * 2)
		flushSync(() => setMountStart(prev => Math.max(0, prev - batch)))
	}, [scrollContainerRef, msgsForPx])

	const hasMore = mountStart > 0

	// Scroll handler: expand on scroll-up near top, trim on scroll-down.
	useEffect(() => {
		const el = scrollContainerRef.current
		if (!el) return
		let rafId = 0
		lastScrollTopRef.current = el.scrollTop

		const onScroll = () => {
			cancelAnimationFrame(rafId)
			rafId = requestAnimationFrame(() => {
				const currScrollTop = el.scrollTop
				const prevScrollTop = lastScrollTopRef.current
				lastScrollTopRef.current = currScrollTop
				const scrollingUp = currScrollTop < prevScrollTop
				const scrollingDown = currScrollTop > prevScrollTop

				if (scrollingUp && currScrollTop < el.clientHeight && mountStartRef.current > 0) {
					expandUp()
					return
				}
				if (scrollingDown && currScrollTop > el.clientHeight * 3) {
					const mounted = totalCountRef.current - mountStartRef.current
					const avgH = mounted > 0 ? (contentRef.current?.offsetHeight ?? el.scrollHeight) / mounted : 200
					const msgsAbove = Math.floor(currScrollTop / avgH)
					const msgsToKeepAbove = Math.ceil((el.clientHeight * 2) / avgH)
					const msgsToRemove = msgsAbove - msgsToKeepAbove
					if (msgsToRemove > 0) {
						flushSync(() => setMountStart(prev => Math.min(prev + msgsToRemove, Math.max(0, totalCountRef.current - 1))))
					}
				}
			})
		}

		el.addEventListener('scroll', onScroll, { passive: true })
		return () => {
			cancelAnimationFrame(rafId)
			el.removeEventListener('scroll', onScroll)
		}
	}, [scrollContainerRef, expandUp])

	// Clamp mountStart when totalCount shrinks (checkpoint rollback)
	useEffect(() => {
		setMountStart(prev => Math.min(prev, Math.max(0, totalCount - 1)))
	}, [totalCount])

	// Incremental JSX cache for the mounted slice. When only messages are
	// appended (streaming commit) and mountStart hasn't changed, reuse
	// existing elements and only createElement for the new ones.
	const prevMsgCacheRef = useRef<{ html: React.ReactNode[], len: number, mountStart: number, msgs: typeof previousMessages, threadId: string, checkpointIdx: typeof currCheckpointIdx, scrollCb: typeof scrollToBottomCb, pendingIdx: typeof firstPendingToolRequestIdx, readOnly: boolean } | null>(null)

	const previousMessagesHTML = (() => {
		const cache = prevMsgCacheRef.current
		const depsMatch = cache
			&& cache.threadId === threadId
			&& cache.msgs === previousMessages
			&& cache.mountStart === mountStart
			&& cache.checkpointIdx === currCheckpointIdx
			&& cache.scrollCb === scrollToBottomCb
			&& cache.pendingIdx === firstPendingToolRequestIdx
			&& cache.readOnly === threadIsReadOnly

		if (depsMatch && previousMessages.length === cache.len) {
			return cache.html
		}

		if (depsMatch && previousMessages.length > cache.len) {
			const newElements: React.ReactNode[] = []
			for (let i = cache.len; i < previousMessages.length; i++) {
				newElements.push(<ChatBubble
					key={i}
					currCheckpointIdx={currCheckpointIdx}
					chatMessage={previousMessages[i]}
					messageIdx={i}
					isCommitted={true}
					chatIsRunning={undefined}
					threadId={threadId}
					_scrollToBottom={scrollToBottomCb}
					firstPendingToolRequestIdx={firstPendingToolRequestIdx}
					threadIsReadOnly={threadIsReadOnly}
				/>)
			}
			const merged = [...cache.html, ...newElements]
			cache.html = merged
			cache.len = previousMessages.length
			cache.msgs = previousMessages
			return merged
		}

		// Full rebuild: mountStart changed, thread deps changed, etc.
		const result: React.ReactNode[] = []
		for (let i = mountStart; i < previousMessages.length; i++) {
			result.push(<ChatBubble
				key={i}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={previousMessages[i]}
				messageIdx={i}
				isCommitted={true}
				chatIsRunning={undefined}
				threadId={threadId}
				_scrollToBottom={scrollToBottomCb}
				firstPendingToolRequestIdx={firstPendingToolRequestIdx}
				threadIsReadOnly={threadIsReadOnly}
			/>)
		}

		prevMsgCacheRef.current = { html: result, len: previousMessages.length, mountStart, msgs: previousMessages, threadId, checkpointIdx: currCheckpointIdx, scrollCb: scrollToBottomCb, pendingIdx: firstPendingToolRequestIdx, readOnly: threadIsReadOnly }
		return result
	})()

	const streamingChatIdx = previousMessages.length
	const currStreamingMessageHTML = reasoningSoFar || displayContentSoFar || isRunning ?
		<ChatBubble
			key={streamingChatIdx}
			currCheckpointIdx={currCheckpointIdx}
			chatMessage={{
				role: 'assistant',
				displayContent: displayContentSoFar ?? '',
				reasoning: reasoningSoFar ?? '',
				anthropicReasoning: null,
			}}
			messageIdx={streamingChatIdx}
			isCommitted={false}
			chatIsRunning={isRunning}
			threadId={threadId}
			_scrollToBottom={null}
			threadIsReadOnly={threadIsReadOnly}
		/> : null

	const generatingTool = toolIsGenerating && currentInFlightTool ?
		currentInFlightTool.name === 'edit_file' || currentInFlightTool.name === 'rewrite_file' ? <EditToolSoFar
			key={'curr-streaming-tool'}
			toolCallSoFar={currentInFlightTool}
		/>
			: null
		: null

	return (
		<div
			hidden={!isActive}
			className='flex flex-col w-full h-full min-h-0'
		>
			<ScrollToBottomContainer
				scrollContainerRef={scrollContainerRef}
				className={`
					flex flex-col
					px-4 py-4 space-y-4
					w-full h-full
					overflow-x-hidden
					overflow-y-auto
					${previousMessagesHTML.length === 0 && !displayContentSoFar ? 'hidden' : ''}
				`}
				style={{ overflowAnchor: 'none' } as React.CSSProperties}
			>
				<div ref={spacerRef} style={{ overflow: 'hidden', flexShrink: 0 }}>
					<div ref={contentRef} className='flex flex-col space-y-4'>
						{previousMessagesHTML}
					</div>
				</div>
				{currStreamingMessageHTML}
				{generatingTool}

				{isRunning === 'LLM' || isRunning === 'idle' && !toolIsGenerating ? <ProseWrapper>
					{<IconLoading className='opacity-50 text-sm' />}
				</ProseWrapper> : null}

				{latestError === undefined ? null :
					<div className='px-2 my-1'>
						<ErrorDisplay
							message={latestError.message}
							fullError={latestError.fullError}
							onDismiss={() => { chatThreadsService.dismissStreamError(threadId) }}
							showDismiss={true}
						/>

						<WarningBox className='text-sm my-2 mx-4' onClick={() => { commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID) }} text='Open settings' />
					</div>
				}
		</ScrollToBottomContainer>
	</div>
	)
})


const useRulesOutdated = (threadId: string, lastAppliedRules: string | undefined) => {
	const accessor = useAccessor()
	const convertToLLMMessageService = accessor.get('IConvertToLLMMessageService')

	const [outdatedInfo, setOutdatedInfo] = useState<{ isOutdated: boolean; detectedAt: Date | null }>({ isOutdated: false, detectedAt: null })
	const isFirstCheckRef = useRef(true)

	useEffect(() => {
		isFirstCheckRef.current = true
		if (lastAppliedRules === undefined) {
			setOutdatedInfo({ isOutdated: false, detectedAt: null })
			return
		}

		let cancelled = false
		const check = async () => {
			if (cancelled) return
			try {
				const current = await convertToLLMMessageService.getCurrentVoidRulesContent()
				if (cancelled) return
				const isOutdated = current !== lastAppliedRules
				const firstCheck = isFirstCheckRef.current
				isFirstCheckRef.current = false
				setOutdatedInfo(prev => {
					if (isOutdated && !prev.isOutdated) return { isOutdated: true, detectedAt: firstCheck ? null : new Date() }
					if (!isOutdated && prev.isOutdated) return { isOutdated: false, detectedAt: null }
					return prev
				})
			} catch { /* ignore read errors */ }
		}

		check()
		const interval = setInterval(check, 5000)
		return () => { cancelled = true; clearInterval(interval) }
	}, [threadId, lastAppliedRules, convertToLLMMessageService])

	return outdatedInfo
}

const RulesOutdatedBanner = ({ detectedAt }: { detectedAt: Date | null }) => {
	const timeStr = detectedAt ? detectedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
	return (
		<div
			className='flex items-center gap-1.5 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 px-3 py-1.5 mx-2 mb-1 rounded select-none'
			data-tooltip-id='void-tooltip'
			data-tooltip-content='Rules are frozen for this thread. To apply the new rules, ask the agent to read_file .voidrules'
			data-tooltip-place='bottom'
		>
			<FileWarning size={13} className='shrink-0' />
			<span>.voidrules changed on disk{timeStr ? ` (at ${timeStr})` : ''}</span>
		</div>
	)
}

export const SidebarChat = () => {
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadsService = accessor.get('IChatThreadService')

	const settingsState = useSettingsState()
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState()

	const currentThread = chatThreadsService.getCurrentThread()
	const previousMessages = currentThread?.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }) }

	const rulesOutdated = useRulesOutdated(currentThread.id, currentThread.lastAppliedRules)

	// Only subscribe to isRunning transitions (not every content tick).
	// The full stream state (displayContentSoFar, toolCallsSoFar, etc.)
	// is subscribed inside ThreadMessagesView where it's actually rendered.
	const isRunning = useStreamRunningState(chatThreadsState.currentThreadId)

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = ''
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!initVal)

	// Phase E commit 4 — read-only fires for foreign threads only.
	// Unscoped threads stay editable (claim-on-engagement still works);
	// they get the same banner via `shouldShowOwnershipBanner` but the
	// input remains active. Hoisted up here (instead of computed inside
	// `threadPageContent`) so the `isDisabled` derivation below picks it
	// up. The `pointer-events-none` wrapper on `inputChatArea` covers
	// mouse + touch interaction with the textarea / dropdowns; this also
	// short-circuits the `isDisabled` path so keyboard-Enter submission
	// can't sneak past either.
	const isCurrentThreadReadOnly = !!currentThread && isThreadReadOnly(currentThread, chatThreadsState.currentWorkspaceUri)
	const showCurrentThreadBanner = !!currentThread && shouldShowOwnershipBanner(currentThread, chatThreadsState.currentWorkspaceUri)

	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Chat', settingsState) || isCurrentThreadReadOnly

	const sidebarRef = useRef<HTMLDivElement>(null)

	// LRU cache of thread ids that stay mounted in the DOM. Switching between
	// cached threads is just a `hidden` flip (near-zero cost); only the first
	// visit to a thread pays the full render. Active thread always sits at
	// index 0 so it's obvious which one is current. Size cap keeps memory
	// bounded — each cached thread holds its DOM tree but no Monaco editors
	// (LazyBlockCode doesn't mount while `hidden`).
	const CACHED_THREADS_MAX = 5
	const [cachedThreadIds, setCachedThreadIds] = useState<string[]>(() => [currentThread.id])
	useEffect(() => {
		const newId = currentThread.id
		setCachedThreadIds(prev => {
			const withoutCurrent = prev.filter(id => id !== newId)
			const next = [newId, ...withoutCurrent].slice(0, CACHED_THREADS_MAX)
			// Skip the state update if order+contents are unchanged, otherwise
			// every re-render (stream chunks fire many) would create a new array
			// and cascade down to the parallel-thread render list.
			if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev
			return next
		})
	}, [currentThread.id])

	// Drop any cached ids for threads that have since been deleted so we don't
	// render stale empty placeholders (allThreads[id] would be undefined).
	const visibleCachedIds = useMemo(() =>
		cachedThreadIds.filter(id => !!chatThreadsState.allThreads[id]),
		[cachedThreadIds, chatThreadsState.allThreads]
	)

	// One scroll container ref per cached thread. Refs are stable objects
	// (MutableRefObject) so React's ref assignment picks up the actual DOM
	// element after mount. We keep the map in a ref so it survives re-renders
	// without causing cascades; entries for evicted threads become harmless
	// `{ current: null }` that the next thread with the same id (rare) would
	// re-use cleanly.
	const scrollContainerRefsMapRef = useRef(new Map<string, React.MutableRefObject<HTMLDivElement | null>>())
	const getScrollContainerRef = useCallback((id: string) => {
		const map = scrollContainerRefsMapRef.current
		let ref = map.get(id)
		if (!ref) {
			ref = { current: null }
			map.set(id, ref)
		}
		return ref
	}, [])

	// Points at the currently active thread's scroll container — used by
	// `onSubmit` / `onAbort` / mountInfo resolver that need to scroll the
	// active view without knowing about the LRU cache.
	const scrollContainerRef = getScrollContainerRef(currentThread.id)

	// Synchronous reentrancy guard. The React-state-derived `isRunning`
	// check below is necessary but NOT sufficient to prevent duplicate
	// submissions when the user spams Enter while the renderer is busy:
	// queued keydowns flush in a single tick after the main thread frees
	// up, and they all see the same stale `isRunning === false` from the
	// closure. A ref written *before* the await closes that window
	// deterministically.
	const isSubmittingRef = useRef(false)

	const onSubmit = useCallback(async (_forceSubmit?: string) => {

		if (isSubmittingRef.current) return
		// Phase E commit 4 — read-only foreign thread short-circuit. Belt
		// to commit 3's service guard's suspenders: `isDisabled` already
		// covers the keyboard-Enter path via the textarea, but
		// `_forceSubmit` (landing-page suggested prompts) bypasses
		// `isDisabled`. Foreign threads can't land on the landing page in
		// practice (they always have messages, and the partition filter
		// drops empty ones), so this is purely defensive — but it costs
		// one branch and removes any "what if" worry.
		if (isCurrentThreadReadOnly) return
		if (isDisabled && !_forceSubmit) return
		if (isRunning) return

		// Snapshot the user's text + clear the textarea SYNCHRONOUSLY
		// before any await. The earlier ordering cleared after the await,
		// which meant queued Enter keypresses (delivered while the prior
		// stream was hogging the main thread) all read the same non-empty
		// `textAreaRef.current?.value` and resubmitted it. Snapshot+clear
		// before yielding makes any flushed-later keydowns see an empty
		// textarea and bail via `isDisabled`.
		const userMessage = _forceSubmit || textAreaRef.current?.value || ''
		const _chatSelections = [...selections] // snapshot before clearing
		setSelections([]) // clear staging
		textAreaFnsRef.current?.setValue('')

		isSubmittingRef.current = true

		// Extract in-memory bytes for the service layer (reads from memory,
		// flushes to disk after persist). Release the raw bytes to free memory
		// but keep the blob URLs alive for ImageThumbnail previews.
		const _pendingImageBytes = new Map<string, Uint8Array>()
		for (const s of _chatSelections) {
			if (s.type !== 'Image') continue
			const entry = pendingImageData.get(s.uri.path)
			if (entry?.bytes) {
				_pendingImageBytes.set(s.uri.path, entry.bytes)
				releasePendingImageBytes(s.uri.path)
			}
		}

		const threadId = chatThreadsService.state.currentThreadId
		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, _pendingImageBytes })
		} catch (e) {
			console.error('Error while sending message in chat:', e)
		} finally {
			isSubmittingRef.current = false
		}

		textAreaRef.current?.focus() // focus input after submit

	}, [chatThreadsService, isDisabled, isRunning, textAreaRef, textAreaFnsRef, setSelections, settingsState, isCurrentThreadReadOnly])

	const onAbort = async () => {
		const threadId = currentThread.id
		await chatThreadsService.abortRunning(threadId)
	}

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VOID_CTRL_L_ACTION_ID)?.getLabel()

	const threadId = currentThread.id
	const currCheckpointIdx = chatThreadsState.allThreads[threadId]?.state?.currCheckpointIdx ?? undefined  // if not exist, treat like checkpoint is last message (infinity)



	// resolve mount info
	const isResolved = chatThreadsState.allThreads[threadId]?.state.mountedInfo?.mountedIsResolvedRef.current
	useEffect(() => {
		if (isResolved) return
		chatThreadsState.allThreads[threadId]?.state.mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: () => scrollToBottom(scrollContainerRef),
		})

	}, [chatThreadsState, threadId, textAreaRef, scrollContainerRef, isResolved])

	// Reset the "input is empty" flag on thread switch. Previously the outer
	// Fragment key={threadId} nuked everything including this useState, which
	// side-effectively reset the submit button's disabled state. Now that the
	// parallel-thread cache keeps SidebarChat mounted across switches, we have
	// to reset this explicitly. The textarea itself is still cleared via the
	// keyed `threadPageInput` below.
	useEffect(() => {
		setInstructionsAreEmpty(true)
	}, [currentThread.id])

	// Render one ThreadMessagesView per cached thread id, with only the active
	// one visible. The hidden views preserve their full React state (bubble
	// collapse toggles, scroll position, streaming progress) and their DOM —
	// returning to a recently-seen thread is near-instant because no mount/
	// unmount cycle happens; only the `hidden` attribute flips.
	const messagesHTML = (
		<div className='relative flex-1 min-h-0 w-full'>
			{visibleCachedIds.map(id => (
				<div
					key={id}
					// Stack all cached thread views in the same box; only the
					// active one's `hidden=false` makes it visible. Absolute
					// positioning lets hidden views take zero layout space
					// while still being part of the DOM / React tree.
					className='absolute inset-0'
					hidden={id !== currentThread.id}
				>
					<ErrorBoundary>
						<ThreadMessagesView
							threadId={id}
							isActive={id === currentThread.id}
							scrollContainerRef={getScrollContainerRef(id)}
						/>
					</ErrorBoundary>
				</div>
			))}
		</div>
	)


	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr)
	}, [setInstructionsAreEmpty])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit()
		} else if (e.key === 'Escape' && isRunning) {
			onAbort()
		}
	}, [onSubmit, onAbort, isRunning])

	const mainImageAttach = useImageAttach(selections, setSelections)
	const mainImageUploadEnabled = useImageUploadEnabled()

	// Phase E commit 4 — when the current thread is read-only (foreign
	// workspace), wrap the input in a `pointer-events-none opacity-60`
	// shell so mouse / touch can't focus the textarea, click the model
	// dropdown, etc. Keyboard `Enter` is independently blocked via
	// `isDisabled` above. The banner above the messages explains why
	// it's grayed out and offers Copy/Move.
	const inputChatArea = <div className={isCurrentThreadReadOnly ? 'pointer-events-none opacity-60' : ''}>
		<VoidChatArea
			featureName='Chat'
			onSubmit={() => onSubmit()}
			onAbort={onAbort}
			isStreaming={!!isRunning}
			isDisabled={isDisabled}
			showSelections={true}
			// showProspectiveSelections={previousMessagesHTML.length === 0}
			selections={selections}
			setSelections={setSelections}
			imageAttach={mainImageAttach}
			onClickAnywhere={() => { textAreaRef.current?.focus() }}
			threadIdForUsageRing={chatThreadsState.currentThreadId}
		>
			<VoidInputBox2
				enableAtToMention
				className={`min-h-[81px] px-0.5 py-0.5`}
				placeholder={`@ to mention, ${keybindingString ? `${keybindingString} to add a selection. ` : ''}Enter instructions...`}
				onChangeText={onChangeText}
				onKeyDown={onKeyDown}
				onPaste={mainImageUploadEnabled ? mainImageAttach.onPaste : undefined}
				onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined) }}
				ref={textAreaRef}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>

		</VoidChatArea>
	</div>


	const isLandingPage = previousMessages.length === 0


	const initiallySuggestedPromptsHTML = <div className='flex flex-col gap-2 w-full text-nowrap text-void-fg-3 select-none'>
		{[
			'Summarize my codebase',
			'How do types work in Rust?',
			'Create a .voidrules file for me'
		].map((text, index) => (
			<div
				key={index}
				className='py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100'
				onClick={() => onSubmit(text)}
			>
				{text}
			</div>
		))}
	</div>



	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId}>
		<div className='px-4'>
			<CommandBarInChat />
		</div>
		<div className='px-2 pb-2'>
			{inputChatArea}
		</div>
	</div>

	const landingPageInput = <div>
		<div className='pt-8'>
			{inputChatArea}
		</div>
	</div>

	const landingPageContent = <div
		ref={sidebarRef}
		className='w-full h-full max-h-full flex flex-col overflow-auto px-4'
	>
		{/* Tab strip also rendered on the landing page so users can jump between
			existing pinned threads without needing to scroll down to the
			PastThreadsList below. Hidden implicitly when there are no pinned tabs. */}
		<ErrorBoundary>
			<SidebarThreadTabs />
		</ErrorBoundary>
		<ErrorBoundary>
			{landingPageInput}
		</ErrorBoundary>

		{Object.keys(chatThreadsState.allThreads).length > 1 ? // show if there are threads
			<ErrorBoundary>
				<div className='pt-8 mb-2 text-void-fg-3 text-root select-none pointer-events-none'>Previous Threads</div>
				<PastThreadsList />
			</ErrorBoundary>
			:
			<ErrorBoundary>
				<div className='pt-8 mb-2 text-void-fg-3 text-root select-none pointer-events-none'>Suggestions</div>
				{initiallySuggestedPromptsHTML}
			</ErrorBoundary>
		}
	</div>


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	// Phase E commit 4 — banner shown above the message list when the active
	// thread is "not yours" (foreign workspace OR unscoped), giving the user
	// an explicit Copy/Move/Claim affordance. Trigger predicate is
	// `shouldShowOwnershipBanner`, broader than `isThreadReadOnly`:
	//   - foreign workspace → banner: yes, input gated (read-only)
	//   - unscoped (in workspaced window) → banner: yes, input editable
	//     (claim-on-engagement still re-tags it on send; explicit Claim
	//     button is the discoverable counterpart)
	// Service guards (commit 3) only catch foreign mutations; unscoped
	// edits flow through normally. Owner label cascade: real workspace
	// label → workspace URI string → "Unscoped" sentinel for legacy /
	// pre-Phase-E threads. Matches the label used by
	// `partitionThreadsByWorkspaceScope` so the banner agrees with the
	// history group heading the user clicked through.
	const readOnlyOwnerLabel = currentThread?.workspaceUri
		? (currentThread.workspaceLabel ?? currentThread.workspaceUri)
		: 'Unscoped'
	const readOnlyBanner = (showCurrentThreadBanner && currentThread) ? (
		<ReadOnlyForeignThreadBanner
			ownerLabel={readOnlyOwnerLabel}
			isUnscoped={!currentThread.workspaceUri}
			threadId={currentThread.id}
		/>
	) : null

	const threadPageContent = <div
		ref={sidebarRef}
		className='w-full h-full flex flex-col overflow-hidden'
	>
		<ErrorBoundary>
			<SidebarThreadTabs />
		</ErrorBoundary>
		{readOnlyBanner && (
			<ErrorBoundary>
				{readOnlyBanner}
			</ErrorBoundary>
		)}
		<ErrorBoundary>
			{messagesHTML}
		</ErrorBoundary>
		{rulesOutdated.isOutdated && rulesOutdated.detectedAt && (
			<RulesOutdatedBanner detectedAt={rulesOutdated.detectedAt} />
		)}
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
	</div>


	// No `key={threadId}` here. Per-thread state that used to be reset by the
	// full-subtree-remount this key caused (ChatBubble collapse toggles, tool-
	// row expand state, scroll position) is now isolated by construction:
	// every cached thread has its own `ThreadMessagesView` subtree with its
	// own `useState` instances. SidebarChat-level state (input emptiness, the
	// textarea DOM) is either reset explicitly (see `instructionsAreEmpty`
	// effect above) or re-mounted via the narrower `threadPageInput` key.
	return (
		<Fragment>
			{isLandingPage ?
				landingPageContent
				: threadPageContent}
		</Fragment>
	)
}
