/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VoidFileSnapshot } from './editCodeServiceTypes.js';
import { AnthropicReasoning, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolCallParams, ToolName, ToolResult } from './toolsServiceTypes.js';


// Summary of one round of Perf 2 Light-tier history compaction — the data used to
// surface "compacted N results / saved ~Xk tokens" in the TokenUsageRing tooltip.
// Populated once per outbound LLM request by `compactToolResultsForRequest`; `null`
// for requests where compaction did not fire (size gate not met, or no trim-eligible
// tool results outside the protection zone).
//
// Cumulative variants of this type are built by `_addCompaction` (same semantics as
// LLMUsage cumulative — per-turn resets on new user message, per-thread persists).
export type CompactionInfo = {
	// Totals across BOTH compaction paths (Light tier + emergency trim). These
	// are what the UI's primary "History compaction" line reads from, and what
	// summed cumulative counters (`cumulativeCompactionThisTurn/Thread`) carry.
	trimmedCount: number   // # messages whose body we replaced or truncated
	savedChars: number     // sum of (originalBody.length - trimmedBody.length)
	// Approximate saved tokens, computed at compaction time using the model's
	// calibrated chars/token ratio (see `recordTokenUsageCalibration` in
	// `ConvertToLLMMessageService`). Stored pre-computed instead of divided
	// client-side so the UI doesn't have to duplicate the ratio logic, and so
	// we use the ratio that was current *when* the compaction ran — not the
	// current ratio at render time (they can drift as more requests land).
	savedTokens: number

	// Breakdown attributable to the *emergency trim* path (the last-resort
	// truncation inside `prepareOpenAIOrAnthropicMessages` that fires when a
	// request would otherwise overflow the context window — it slashes the
	// heaviest-weight messages to 120 chars). Tracked separately because
	// emergency trim is more destructive than Light tier (can affect user
	// messages / assistant replies, not just tool result bodies) and its firing
	// is itself diagnostic info: if it's firing, Perf 2's `sizeTriggerRatio` is
	// too loose for this model/workload. Light-tier breakdown isn't tracked
	// separately because Light = total - emergency (and "Light tier triggered"
	// is the expected, boring case — no need to highlight it).
	// All fields optional so persisted threads from before this breakdown was
	// added hydrate cleanly (treated as "all Light, no emergency").
	emergencyTrimmedCount?: number
	emergencySavedChars?: number
	emergencySavedTokens?: number
}

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	content: string; // give this result to LLM (string of value)
	id: string;
	rawParams: RawToolParamsObj;
	// Original serialized `arguments` string from the model's tool call (when available
	// from the provider stream — OpenAI-compatible only). Used on replay to send
	// byte-identical tool_calls back, preserving the provider's prefix cache.
	rawParamsStr?: string;
	mcpServerName: string | undefined; // the server name at the time of the call
	// Position of this tool within its assistant-turn batch. When a model emits multiple
	// parallel tool calls in one response, each tool message stores its 0-based index
	// (`batchIndex`) and the total count (`batchSize`). The UI uses these to render a
	// "(1/2)"-style prefix so the user can see tool grouping at a glance. Both are
	// optional — legacy single-tool responses and persisted history from before this
	// field existed simply omit them (UI treats that as a solo call, no prefix shown).
	batchIndex?: number;
	batchSize?: number;
} & (
		// in order of events:
		| { type: 'invalid_params', result: null, name: T, }

		| { type: 'tool_request', result: null, name: T, params: ToolCallParams<T>, }  // params were validated, awaiting user

		| { type: 'running_now', result: null, name: T, params: ToolCallParams<T>, }

		| { type: 'tool_error', result: string, name: T, params: ToolCallParams<T>, } // error when tool was running
		| { type: 'success', result: Awaited<ToolResult<T>>, name: T, params: ToolCallParams<T>, }
		| { type: 'rejected', result: null, name: T, params: ToolCallParams<T> }
	) // user rejected

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName: string | undefined; // the server name at the time of the call
}


// checkpoints
export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };

	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };
	};
}


// WARNING: changing this format is a big deal!!!!!! need to migrate old format to new format on users' computers so people don't get errors.
export type ChatMessage =
	| {
		role: 'user';
		content: string; // content displayed to the LLM on future calls - allowed to be '', will be replaced with (empty)
		displayContent: string; // content displayed to user  - allowed to be '', will be ignored
		selections: StagingSelectionItem[] | null; // the user's selection
		state: {
			stagingSelections: StagingSelectionItem[];
			isBeingEdited: boolean;
		}

		// UI-only metadata. Set to true when the `.voidrules` content differed
		// from `thread.lastAppliedRules` at the moment this user message was
		// sent — indicates rules changed since the prior turn. Renders a small
		// chip above this message's bubble so the user can locate *where* in a
		// conversation the rule set shifted (useful when re-reading history and
		// noticing the agent changed style/conventions part-way through).
		// Never sent to the LLM — rule content reaches the model via the system
		// message on every request, so injecting a chat-level marker would be
		// redundant and would pollute context.
		// Optional for backward-compat with chat history persisted before this
		// field existed (treated as "no change marker").
		rulesChangedBefore?: boolean
	} | {
		role: 'assistant';
		displayContent: string; // content received from LLM  - allowed to be '', will be replaced with (empty)
		reasoning: string; // reasoning from the LLM, used for step-by-step thinking

		anthropicReasoning: AnthropicReasoning[] | null; // anthropic reasoning

		// Provider-reported reason the stream ended. Populated only for OAI-compatible
		// providers today; others leave this undefined. Used by the UI to warn when a
		// response was silently truncated (typically `length` on MiniMax/OpenRouter
		// when reasoning tokens exhaust the output budget). Optional to stay backward
		// compatible with chat history persisted before this field existed.
		finishReason?: string;
	}
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry


// one of the square items that indicates a selection in a chat bubble
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean; };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
}


// a link to a symbol (an underlined link to a piece of code)
export type CodespanLocationLink = {
	uri: URI, // we handle serialization for this
	displayText: string,
	selection?: { // store as JSON so dont have to worry about serialization
		startLineNumber: number
		startColumn: number,
		endLineNumber: number
		endColumn: number,
	} | undefined
} | null
