/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { InternalToolInfo } from './prompt/prompts.js'
import { ToolName, ToolParamName } from './toolsServiceTypes.js'
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel, ProviderName, RefreshableProviderName, SettingsOfProvider } from './voidSettingsTypes.js'


export const errorDetails = (fullError: Error | null): string | null => {
	if (fullError === null) {
		return null
	}
	else if (typeof fullError === 'object') {
		if (Object.keys(fullError).length === 0) return null
		return JSON.stringify(fullError, null, 2)
	}
	else if (typeof fullError === 'string') {
		return null
	}
	return null
}

export const getErrorMessage: (error: unknown) => string = (error) => {
	if (error instanceof Error) return `${error.name}: ${error.message}`
	return error + ''
}



export type AnthropicLLMChatMessage = {
	role: 'assistant',
	content: string | (AnthropicReasoning | { type: 'text'; text: string }
		| { type: 'tool_use'; name: string; input: Record<string, any>; id: string; }
	)[];
} | {
	role: 'user',
	content: string | (
		{ type: 'text'; text: string; } | { type: 'tool_result'; tool_use_id: string; content: string; }
	)[]
}
export type OpenAILLMChatMessage = {
	role: 'system' | 'developer';
	content: string;
} | {
	role: 'user';
	content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
} | {
	role: 'assistant',
	content: string | (AnthropicReasoning | { type: 'text'; text: string })[];
	tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string; } }[];
	// DeepSeek V4 thinking-mode requires `reasoning_content` to be replayed on
	// every prior assistant message that produced one (or the API returns 400).
	// Applies to all thinking-mode turns, not just tool-call ones — the published
	// docs say otherwise but the live API rejects non-replay outright. See
	// note-deepseek.md §5. Only emitted for providers we know consume this field
	// — for everyone else it'd be unspecified noise on the wire.
	reasoning_content?: string;
} | {
	role: 'tool',
	content: string;
	tool_call_id: string;
}

export type GeminiLLMChatMessage = {
	role: 'model'
	parts: (
		| { text: string; }
		| { functionCall: { id: string; name: ToolName, args: Record<string, unknown> } }
	)[];
} | {
	role: 'user';
	parts: (
		| { text: string; }
		| { functionResponse: { id: string; name: ToolName, response: { output: string } } }
		| { inlineData: { mimeType: string; data: string } }
	)[];
}

export type LLMChatMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage | GeminiLLMChatMessage



export type LLMFIMMessage = {
	prefix: string;
	suffix: string;
	stopTokens: string[];
}


export type RawToolParamsObj = {
	[paramName in ToolParamName<ToolName>]?: string;
}
export type RawToolCallObj = {
	name: ToolName;
	rawParams: RawToolParamsObj;
	// Original serialized `arguments` string as the model emitted it (OpenAI-compatible
	// path only — Anthropic/Gemini deliver tool input as structured JSON with no raw
	// source string). Preserved so that on replay we can send byte-identical content
	// back to the provider, which keeps the prefix cache warm past the tool call.
	// Absent/undefined when not available; callers should fall back to JSON.stringify(rawParams).
	rawParamsStr?: string;
	doneParams: ToolParamName<ToolName>[];
	id: string;
	isDone: boolean;
};

export type AnthropicReasoning = ({ type: 'thinking'; thinking: any; signature: string; } | { type: 'redacted_thinking', data: any })

// Token usage reported by the provider. All fields optional because providers expose
// different subsets (e.g. Anthropic streams input/output separately; OpenAI only at end with
// stream_options.include_usage; Gemini gives it via usageMetadata; Ollama on the final chunk).
export type LLMUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	// Portion of `inputTokens` that was served from prompt/context cache.
	// Populated by OpenAI-compatible servers via `usage.prompt_tokens_details.cached_tokens`
	// (OpenAI's implicit prompt cache; DeepSeek and a few others mirror the schema).
	// Undefined on servers that don't return the field.
	cachedInputTokens?: number;
}

// `toolCalls` is an ordered list. Providers that support parallel/batched tool calling
// (OpenAI, Anthropic, Gemini) may emit multiple tools in a single assistant turn. A
// single-tool response is represented as a length-1 array; no tools as an empty array
// (or `undefined` for brevity). The ordering is preserved from the provider — Void
// executes them serially in that order.
export type OnText = (p: { fullText: string; fullReasoning: string; toolCalls?: RawToolCallObj[]; usage?: LLMUsage }) => void

// `finishReason` is the provider's own reason for ending the stream. OpenAI-compatible
// servers return one of `stop` / `tool_calls` / `function_call` / `length` / `content_filter`
// in `choices[0].finish_reason`. Clean completions (`stop`/`tool_calls`/`function_call`) are
// treated as normal; the field only exists so the UI can warn the user when a stream ends
// for a reason that silently truncates the response (primarily `length` when a provider
// clips against `max_tokens`, but also `content_filter` or unknown gateway-specific values).
// Populated only by OAI-compatible providers right now — Anthropic / Gemini paths leave this
// undefined, which renders as "no warning" (the same as before this was added).
//
// `toolCalls` — see `OnText` above. Empty/undefined on pure-text responses.
export type OnFinalMessage = (p: { fullText: string; fullReasoning: string; toolCalls?: RawToolCallObj[]; anthropicReasoning: AnthropicReasoning[] | null; usage?: LLMUsage; finishReason?: string }) => void
export type OnError = (p: { message: string; fullError: Error | null }) => void
export type OnAbort = () => void
export type AbortRef = { current: (() => void) | null }


// service types
type SendLLMType = {
	messagesType: 'chatMessages';
	messages: LLMChatMessage[]; // the type of raw chat messages that we send to Anthropic, OAI, etc
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
} | {
	messagesType: 'FIMMessage';
	messages: LLMFIMMessage;
	separateSystemMessage?: undefined;
	chatMode?: undefined;
}
export type ServiceSendLLMMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	logging: { loggingName: string, loggingExtras?: { [k: string]: any } };
	modelSelection: ModelSelection | null;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	onAbort: OnAbort;
} & SendLLMType;

// params to the true sendLLMMessage function
export type SendLLMMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	logging: { loggingName: string, loggingExtras?: { [k: string]: any } };
	abortRef: AbortRef;

	modelSelection: ModelSelection;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;

	settingsOfProvider: SettingsOfProvider;
	mcpTools: InternalToolInfo[] | undefined;
} & SendLLMType



// can't send functions across a proxy, use listeners instead
export type BlockedMainLLMMessageParams = 'onText' | 'onFinalMessage' | 'onError' | 'abortRef'
export type MainSendLLMMessageParams = Omit<SendLLMMessageParams, BlockedMainLLMMessageParams> & { requestId: string } & SendLLMType

export type MainLLMMessageAbortParams = { requestId: string }

export type EventLLMMessageOnTextParams = Parameters<OnText>[0] & { requestId: string }
export type EventLLMMessageOnFinalMessageParams = Parameters<OnFinalMessage>[0] & { requestId: string }
export type EventLLMMessageOnErrorParams = Parameters<OnError>[0] & { requestId: string }

// service -> main -> internal -> event (back to main)
// (browser)









// These are from 'ollama' SDK
interface OllamaModelDetails {
	parent_model: string;
	format: string;
	family: string;
	families: string[];
	parameter_size: string;
	quantization_level: string;
}

export type OllamaModelResponse = {
	name: string;
	modified_at: Date;
	size: number;
	digest: string;
	details: OllamaModelDetails;
	expires_at: Date;
	size_vram: number;
}

export type OpenaiCompatibleModelResponse = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}



// params to the true list fn
export type ModelListParams<ModelResponse> = {
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	onSuccess: (param: { models: ModelResponse[] }) => void;
	onError: (param: { error: string }) => void;
}

// params to the service
export type ServiceModelListParams<modelResponse> = {
	providerName: RefreshableProviderName;
	onSuccess: (param: { models: modelResponse[] }) => void;
	onError: (param: { error: any }) => void;
}

type BlockedMainModelListParams = 'onSuccess' | 'onError'
export type MainModelListParams<modelResponse> = Omit<ModelListParams<modelResponse>, BlockedMainModelListParams> & { providerName: RefreshableProviderName, requestId: string }

export type EventModelListOnSuccessParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onSuccess']>[0] & { requestId: string }
export type EventModelListOnErrorParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onError']>[0] & { requestId: string }




