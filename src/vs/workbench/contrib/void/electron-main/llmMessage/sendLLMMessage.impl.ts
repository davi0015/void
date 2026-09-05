/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, type LLMUsage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import type { ToolName } from '../../common/toolsServiceTypes.js';
import { BackendProviderSettings, displayInfoOfProviderName, isBackendId, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { InternalToolInfo } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	tools: InternalToolInfo[] | undefined;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const authErrorMessage = (providerName: ProviderName, error?: any) => {
	const serverMsg = error?.error?.message || error?.message
	if (serverMsg) return `${displayInfoOfProviderName(providerName).title}: ${serverMsg}`
	return `Invalid ${displayInfoOfProviderName(providerName).title} API key.`
}

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

export const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any } }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		...includeInPayload,
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://voideditor.com', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'Void', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// ① use the user-supplied proxy if present
		// ② otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with “/v1”
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'openAICompatible') {
		const thisConfig = settingsOfProvider[providerName]
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (isBackendId(providerName)) {
		const thisConfig = settingsOfProvider[providerName] as BackendProviderSettings
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}

	else throw new Error(`Void providerName was invalid: ${providerName}.`)
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onText, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload })

	// Use non-streaming for the completions endpoint. LiteLLM and other
	// proxies cache non-streaming responses correctly, but may return
	// empty or malformed chunks when streaming cached completions.
	// FIM requests are not aborted (they complete in the background),
	// so the 2-4 second latency is acceptable.
	const abortController = new AbortController()
	_setAborter(() => abortController.abort())

	try {
		const response = await openai.completions.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix || undefined,
			stop: stopTokens,
			max_tokens: 300,
		}, { signal: abortController.signal })

		const fullText = response.choices[0]?.text ?? ''
		onText({ fullText, fullReasoning: '' })
		onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
	} catch (error) {
		if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: authErrorMessage(providerName, error), fullError: error }); }
		else { onError({ message: error + '', fullError: error }); }
	}
}


const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo

	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: {
				type: 'object',
				properties: paramsWithType,
				// required: Object.keys(params), // in strict mode, all params are required and additionalProperties is false
				// additionalProperties: false,
			},
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool
}

const openAITools = (tools: InternalToolInfo[] | undefined) => {
	const allowedTools = tools
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return openAITools
}


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown
	try { input = JSON.parse(toolParamsStr) }
	catch (e) { return null }

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	// Preserve the original argument string exactly as the model emitted it. On replay
	// we'll send this back verbatim inside `tool_calls[].function.arguments` so the
	// provider sees byte-identical content and the prefix cache stays warm.
	return { id, name, rawParams, rawParamsStr: toolParamsStr, doneParams: Object.keys(rawParams), isDone: true }
}


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------


const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, tools, separateSystemMessage, overridesOfModel }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(tools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// instance — `includeInPayload` is intentionally NOT passed to the SDK constructor.
	// Constructor `ClientOptions` is a closed set (apiKey, baseURL, defaultHeaders, etc.);
	// arbitrary fields like `reasoning_effort` / `thinking` are silently dropped there.
	// They belong in the per-request body below alongside `additionalOpenAIPayload`.
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: messages as any,
		stream: true,
		// Ask the server to emit a final usage chunk. Per the OpenAI spec this adds a
		// trailing chunk with `choices: []` and a populated `usage`. Most OAI-compatible
		// servers (DeepSeek, OpenRouter, Groq, vLLM, LM Studio, LiteLLM, etc.) honor this;
		// ones that don't just ignore the field and we get no usage, same as before.
		// Declared before the spreads so `additionalOpenAIPayload` / `includeInPayload`
		// can override if a particular model/provider needs a different setting.
		stream_options: { include_usage: true },
		...nativeToolsObj,
		...additionalOpenAIPayload,
		// Reasoning-related body fields (e.g. DeepSeek's `thinking: { type: 'enabled' }`,
		// OpenAI's `reasoning_effort`) come from the model's `providerReasoningIOSettings.input.includeInPayload`
		// and MUST land in the request body, not the SDK constructor.
		...includeInPayload,
		// max_completion_tokens: maxTokens,
	} as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming

	// open source models - manually parse think tokens
	const { nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = !!openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, tools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// Tool-call buffers keyed by `tool_calls[].index` from the delta. OpenAI's streaming spec
	// allows multiple tool calls in one assistant turn, each identified by its own numeric index,
	// with chunks interleaved arbitrarily (index=0 chunk, index=1 chunk, index=0 chunk again...).
	// We previously dropped everything past index 0, which silently corrupted parallel tool-call
	// responses from GPT-4+, MiniMax, and other providers that batch. Using a Map keyed by index
	// handles out-of-order chunks correctly. On final, we sort by index to preserve the
	// provider's intended execution order.
	const toolBuffers = new Map<number, { name: string; argsStr: string; id: string }>()
	const getOrCreateToolBuffer = (index: number) => {
		let buf = toolBuffers.get(index)
		if (!buf) { buf = { name: '', argsStr: '', id: '' }; toolBuffers.set(index, buf) }
		return buf
	}

	// Usage only arrives in the final chunk (and only if the server honored
	// stream_options.include_usage). `chunk.usage` is typed as `| null` there.
	let latestUsage: LLMUsage | undefined = undefined

	// The provider's own termination reason. We keep the *last* non-empty value seen
	// across the stream — every content-carrying chunk has `finish_reason: null` until
	// the final one, which carries e.g. `'stop'`, `'tool_calls'`, `'length'`,
	// `'content_filter'`, or a provider-specific value. Without this, a `length`
	// truncation (common on MiniMax via OpenRouter when reasoning tokens eat the output
	// budget) looks identical to a normal completion to the UI — spinner stops,
	// message cuts off mid-word, no warning shown.
	let lastFinishReason: string | undefined = undefined

	openai.chat.completions
		.create(options)
		.then(async response => {
			_setAborter(() => response.controller.abort())

			// when receive text
			for await (const chunk of response) {
				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText

				// finish_reason: first choice only. Most chunks have `null`; keep what
				// we've got if this one is null/empty, overwrite if it's set. Some gateways
				// (OpenRouter) occasionally emit a finish_reason in a chunk that still
				// has content, so we intentionally don't `break` — keep consuming until
				// the stream actually ends.
				const chunkFinishReason = chunk.choices[0]?.finish_reason
				if (chunkFinishReason) lastFinishReason = chunkFinishReason

				// tool calls — aggregate by index. A single chunk may include deltas for multiple
				// indices (rare but valid), and a single index's pieces may arrive across many
				// chunks (the common case). `id` is typically present only on the first chunk
				// for a given index; `arguments` streams incrementally.
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const index = tool.index
					if (index === undefined) continue
					const buf = getOrCreateToolBuffer(index)
					buf.name += tool.function?.name ?? ''
					buf.argsStr += tool.function?.arguments ?? ''
					buf.id += tool.id ?? ''
				}


				// reasoning — nameOfFieldInDelta may be a single field or a list of candidates
				// (some gateways like OpenRouter use `reasoning`, others like DeepSeek use
				// `reasoning_content`). Take the first non-empty one this chunk provides.
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					const fields = Array.isArray(nameOfReasoningFieldInDelta) ? nameOfReasoningFieldInDelta : [nameOfReasoningFieldInDelta]
					for (const f of fields) {
						// @ts-ignore
						const val = (chunk.choices[0]?.delta?.[f] || '') + ''
						if (val) { newReasoning = val; break }
					}
					fullReasoningSoFar += newReasoning
				}

				// usage — present only on the final chunk (which typically has empty choices).
				// `prompt_tokens_details.cached_tokens` is OpenAI's implicit prompt-cache hit
				// count; non-OpenAI servers that mimic the schema (DeepSeek, OpenRouter-for-
				// OpenAI-routed models, some vLLM deployments) populate it too.
				if (chunk.usage) {
					latestUsage = {
						inputTokens: chunk.usage.prompt_tokens,
						outputTokens: chunk.usage.completion_tokens,
						totalTokens: chunk.usage.total_tokens,
						reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
						cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
					}
				}

				// Build the in-progress toolCalls snapshot for UI streaming. We only emit entries
				// for buffers that have at least a name (argument-only deltas for an as-yet-
				// unnamed tool are still accumulating). Indices are sorted so the UI's rendered
				// order matches the provider's intended execution order.
				const inProgressToolCalls: RawToolCallObj[] = Array.from(toolBuffers.entries())
					.filter(([_i, buf]) => !!buf.name)
					.sort(([a], [b]) => a - b)
					.map(([_i, buf]) => ({ name: buf.name as ToolName, rawParams: {}, isDone: false, doneParams: [], id: buf.id }))

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCalls: inProgressToolCalls.length > 0 ? inProgressToolCalls : undefined,
					usage: latestUsage,
				})

			}
			// on final: parse each completed tool buffer. `rawToolCallObjOfParamsStr` returns
			// null on malformed JSON or non-object inputs — we skip those rather than crashing
			// the whole turn, but log for diagnosis.
			const finalToolCalls: RawToolCallObj[] = Array.from(toolBuffers.entries())
				.sort(([a], [b]) => a - b)
				.map(([_i, buf]) => rawToolCallObjOfParamsStr(buf.name, buf.argsStr, buf.id))
				.filter((t): t is RawToolCallObj => t !== null)

			if (!fullTextSoFar && !fullReasoningSoFar && finalToolCalls.length === 0) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
			}
			else {
				onFinalMessage({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					anthropicReasoning: null,
					usage: latestUsage,
					finishReason: lastFinishReason,
					toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
				});
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: authErrorMessage(providerName, error), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}


// ------------ OPENAI RESPONSES (backends only) ------------

// Translate the browser layer's LLM chat messages (+ separate system
// message) into Responses API `instructions` + `input`. Backends on the
// responses protocol always produce OpenAI-style messages (openai-style is
// the default tool format for unrecognized providers), so only those
// shapes are translated — anything else is skipped, never fatal.
const responsesInputOfLLMMessages = (messages: LLMChatMessage[], separateSystemMessage: string | undefined): { instructions: string | undefined, input: OpenAI.Responses.ResponseInput } => {
	const instructionParts: string[] = []
	if (separateSystemMessage) instructionParts.push(separateSystemMessage)
	const input: OpenAI.Responses.ResponseInput = []
	for (const msg of messages) {
		if (msg.role === 'system' || msg.role === 'developer') {
			if (typeof msg.content === 'string' && msg.content) instructionParts.push(msg.content)
			continue
		}
		if (msg.role === 'user') {
			// Gemini-shaped messages carry `parts` instead of `content` —
			// they never occur on this protocol; skip them.
			if (!('content' in msg)) continue
			if (typeof msg.content === 'string') {
				input.push({ role: 'user', content: msg.content })
				continue
			}
			// content parts — text + images only; anything else skipped
			const content: OpenAI.Responses.ResponseInputContent[] = []
			for (const part of msg.content) {
				if (part.type === 'text') content.push({ type: 'input_text', text: part.text })
				else if (part.type === 'image_url') content.push({ type: 'input_image', image_url: part.image_url.url, detail: 'auto' })
			}
			if (content.length > 0) input.push({ role: 'user', content })
			continue
		}
		if (msg.role === 'assistant') {
			if (typeof msg.content === 'string') {
				if (msg.content) input.push({ role: 'assistant', content: msg.content })
			}
			else {
				// array content is unusual here, but carry any text parts
				const texts: string[] = []
				for (const part of msg.content) {
					if (part.type === 'text' && 'text' in part && typeof part.text === 'string') texts.push(part.text)
				}
				if (texts.length > 0) input.push({ role: 'assistant', content: texts.join('\n') })
			}
			// prior tool calls replay as function_call items so the next
			// turn's outputs can match them by call_id (see below)
			if ('tool_calls' in msg && msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
				}
			}
			continue
		}
		if (msg.role === 'tool') {
			// `tool_call_id` is the Responses call_id from the previous
			// turn (stored as the tool's id) — echo it back verbatim so
			// the backend can pair output with call.
			input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: msg.content })
			continue
		}
	}
	const instructions = instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined
	return { instructions, input }
}


export const sendOpenAIResponsesChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, tools, separateSystemMessage, overridesOfModel }: SendChatParams_Internal) => {
	const {
		modelName,
		additionalOpenAIPayload,
		reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// reasoning — same think-tag handling as the chat path; the text-level
	// wrapper works unchanged on streamed responses text.
	const { openSourceThinkTags } = reasoningCapabilities || {}

	// NOTE: providerReasoningIOSettings.input.includeInPayload is deliberately
	// NOT applied here. Those fields (e.g. reasoning_effort) are shaped for
	// Chat Completions; the Responses API takes reasoning config under
	// `reasoning: {...}` instead. additionalOpenAIPayload (model-specific
	// extras) still applies below.
	const { instructions, input } = responsesInputOfLLMMessages(messages, separateSystemMessage)

	// tools — same function schemas as the chat path; only the envelope
	// differs (Responses FunctionTool instead of ChatCompletionTool).
	// `strict` stays off: our schemas have no `required` list (same reason
	// it's commented out in toOpenAICompatibleTool).
	const chatTools = openAITools(tools)
	const responsesTools: OpenAI.Responses.FunctionTool[] | undefined = chatTools?.map(t => ({
		type: 'function' as const,
		name: t.function.name,
		description: t.function.description,
		parameters: t.function.parameters as Record<string, unknown>,
		strict: false,
	}))

	// open-source models - manually parse think tokens (same as chat path)
	if (openSourceThinkTags) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	const options = {
		model: modelName,
		instructions,
		input,
		stream: true,
		// Stateless per request — Void replays full history every turn, so
		// nothing should be retained server-side.
		store: false,
		// Ask for reasoning summaries so thinking models have something to
		// show in the UI (streamed as summary deltas + returned on the
		// reasoning output items below). Costs a few output tokens; placed
		// before the spreads so model extras can override it.
		reasoning: { summary: 'auto' },
		...(responsesTools ? { tools: responsesTools } : {}),
		...additionalOpenAIPayload,
	} as OpenAI.Responses.ResponseCreateParamsStreaming

	let fullTextSoFar = ''
	let fullReasoningSoFar = ''

	// Tool-call buffers keyed by the stream's output_index (present on both
	// `output_item.added` and `function_call_arguments.delta` for the same
	// call). The authoritative call list comes from the final response
	// object; buffers drive the in-progress UI snapshot and cover backends
	// that end the stream without one.
	const toolBuffers = new Map<number, { call_id: string; name: string; argsStr: string }>()
	const getOrCreateToolBuffer = (index: number) => {
		let buf = toolBuffers.get(index)
		if (!buf) { buf = { call_id: '', name: '', argsStr: '' }; toolBuffers.set(index, buf) }
		return buf
	}

	// Usage only arrives on the final response object (nothing mid-stream).
	let latestUsage: LLMUsage | undefined = undefined

	// Truncation signal for the UI warning (mirrors the chat path's
	// finish_reason handling: only non-clean endings are reported).
	let incompleteReason: string | undefined = undefined

	let finalResponse: OpenAI.Responses.Response | undefined = undefined

	openai.responses
		.create(options)
		.then(async response => {
			_setAborter(() => response.controller.abort())

			for await (const event of response) {
				if (event.type === 'response.output_text.delta') {
					fullTextSoFar += event.delta
				}
				// Reasoning summary streaming (requested via `reasoning.summary`
				// above) — feeds the thinking UI live; the final output's
				// reasoning items overwrite authoritatively below.
				else if (event.type === 'response.reasoning_summary_text.delta') {
					fullReasoningSoFar += event.delta
				}
				else if (event.type === 'response.output_item.added') {
					if (event.item.type === 'function_call') {
						const buf = getOrCreateToolBuffer(event.output_index)
						if (event.item.call_id) buf.call_id = event.item.call_id
						if (event.item.name) buf.name = event.item.name
					}
				}
				else if (event.type === 'response.function_call_arguments.delta') {
					getOrCreateToolBuffer(event.output_index).argsStr += event.delta
				}
				else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
					finalResponse = event.response
					const reason = event.response.incomplete_details?.reason
					// Map to the chat path's finish_reason vocabulary so the
					// UI's truncation warning fires identically.
					if (reason === 'max_output_tokens') incompleteReason = 'length'
					else if (reason) incompleteReason = reason
				}
				else if (event.type === 'response.failed') {
					const errMsg = (failedMsgOfResponseError(event.response.error)) ?? 'The model failed to produce a response.'
					onError({ message: errMsg, fullError: null })
					return
				}
				else if (event.type === 'error') {
					onError({ message: event.message || 'Responses stream error.', fullError: null })
					return
				}

				// In-progress tool snapshot for UI streaming (same contract
				// as the chat path: only named calls, provider order).
				const inProgressToolCalls: RawToolCallObj[] = Array.from(toolBuffers.entries())
					.filter(([_i, buf]) => !!buf.name)
					.sort(([a], [b]) => a - b)
					.map(([_i, buf]) => ({ name: buf.name as ToolName, rawParams: {}, isDone: false, doneParams: [], id: buf.call_id }))

				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCalls: inProgressToolCalls.length > 0 ? inProgressToolCalls : undefined,
					usage: latestUsage,
				})
			}

			// Authoritative pass over the final response object when present.
			// Deltas and the completed object should agree; the object wins.
			// Streamed buffers fill gaps for backends that end the stream
			// without a completed object.
			const authoritativeCalls: { call_id: string; name: string; argsStr: string }[] = []
			if (finalResponse) {
				const texts: string[] = []
				const reasoningTexts: string[] = []
				for (const item of finalResponse.output ?? []) {
					if (item.type === 'message') {
						for (const c of item.content) {
							if (c.type === 'output_text') texts.push(c.text)
						}
					}
					else if (item.type === 'function_call') {
						authoritativeCalls.push({ call_id: item.call_id, name: item.name, argsStr: item.arguments })
					}
					else if (item.type === 'reasoning') {
						for (const s of item.summary ?? []) {
							if (s.type === 'summary_text' && s.text) reasoningTexts.push(s.text)
						}
					}
				}
				if (texts.length > 0) fullTextSoFar = texts.join('')
				if (reasoningTexts.length > 0) fullReasoningSoFar = reasoningTexts.join('\n')
				if (finalResponse.usage) {
					latestUsage = {
						inputTokens: finalResponse.usage.input_tokens,
						outputTokens: finalResponse.usage.output_tokens,
						totalTokens: finalResponse.usage.total_tokens,
						reasoningTokens: finalResponse.usage.output_tokens_details?.reasoning_tokens,
						cachedInputTokens: finalResponse.usage.input_tokens_details?.cached_tokens,
					}
				}
			}
			const seenCallIds = new Set(authoritativeCalls.map(c => c.call_id))
			for (const [_i, buf] of toolBuffers) {
				if (buf.name && !seenCallIds.has(buf.call_id)) {
					authoritativeCalls.push({ call_id: buf.call_id, name: buf.name, argsStr: buf.argsStr })
					seenCallIds.add(buf.call_id)
				}
			}
			// Parse each completed call; malformed JSON is skipped (same as
			// the chat path) rather than failing the whole turn.
			const finalToolCalls: RawToolCallObj[] = authoritativeCalls
				.map(c => rawToolCallObjOfParamsStr(c.name, c.argsStr, c.call_id))
				.filter((t): t is RawToolCallObj => t !== null)

			if (!fullTextSoFar && !fullReasoningSoFar && finalToolCalls.length === 0) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
			}
			else {
				onFinalMessage({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					anthropicReasoning: null,
					usage: latestUsage,
					finishReason: incompleteReason ?? 'stop',
					toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
				});
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: authErrorMessage(providerName, error), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}

// Safely extract a message from a failed response's error payload, which
// varies by backend. Returns null when there's nothing readable.
const failedMsgOfResponseError = (error: OpenAI.Responses.Response['error']): string | null => {
	if (!error || typeof error !== 'object') return null
	const message = (error as { message?: unknown }).message
	return typeof message === 'string' && message ? message : null
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }
	return {
		name: name,
		description: description,
		input_schema: {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool
}

const anthropicTools = (tools: InternalToolInfo[] | undefined) => {
	const allowedTools = tools
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	return anthropicTools
}



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, tools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const thisConfig = settingsOfProvider[providerName] as { apiKey: string; endpoint?: string }
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(tools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true,
		...(isBackendId(providerName) && thisConfig.endpoint ? { baseURL: thisConfig.endpoint } : {}),
	});

	const stream = anthropic.messages.stream({
		system: separateSystemMessage ?? undefined,
		messages: messages as AnthropicLLMChatMessage[],
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, tools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	// Tool-call buffers keyed by Anthropic's content-block `index`. Anthropic streams each
	// tool as its own `content_block_start` (with name+id) followed by `content_block_delta`
	// events carrying `input_json_delta` chunks — both tagged with the same numeric `index`.
	// We previously only kept the first tool (`tools[0]` at finalMessage), silently dropping
	// any parallel tool_use blocks. Map<index, ...> preserves ordering and the per-tool id.
	const anthropicToolBuffers = new Map<number, { name: string; argsStr: string; id: string }>()
	const getOrCreateAnthropicTool = (index: number) => {
		let buf = anthropicToolBuffers.get(index)
		if (!buf) { buf = { name: '', argsStr: '', id: '' }; anthropicToolBuffers.set(index, buf) }
		return buf
	}

	const runOnText = () => {
		const inProgressToolCalls: RawToolCallObj[] = Array.from(anthropicToolBuffers.entries())
			.filter(([_i, buf]) => !!buf.name)
			.sort(([a], [b]) => a - b)
			.map(([_i, buf]) => ({ name: buf.name as ToolName, rawParams: {}, isDone: false, doneParams: [], id: buf.id || 'dummy' }))
		onText({
			fullText,
			fullReasoning,
			toolCalls: inProgressToolCalls.length > 0 ? inProgressToolCalls : undefined,
		})
	}
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				// Anthropic gives the tool name+id in the start block and the JSON input in
				// subsequent input_json_delta events keyed to the same `e.index`.
				const buf = getOrCreateAnthropicTool(e.index)
				buf.name += e.content_block.name ?? ''
				buf.id += e.content_block.id ?? ''
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				// partial_json is a string delta scoped to the current content block (e.index).
				// See https://docs.anthropic.com/en/api/messages-streaming
				const buf = getOrCreateAnthropicTool(e.index)
				buf.argsStr += e.delta.partial_json ?? ''
				runOnText()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		// Iterate ALL tool_use blocks in document order (response.content preserves ordering).
		// Previous behavior only used `tools[0]`, which silently dropped parallel tool calls.
		const tools = response.content.filter(c => c.type === 'tool_use')
		const finalToolCalls: RawToolCallObj[] = tools
			.map(t => rawToolCallObjOfAnthropicParams(t))
			.filter((t): t is RawToolCallObj => t !== null)

		onFinalMessage({
			fullText,
			fullReasoning,
			anthropicReasoning,
			toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
		})
	})
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: authErrorMessage(providerName, error), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Void if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	return {
		name,
		description,
		parameters: {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

const geminiTools = (tools: InternalToolInfo[] | undefined): GeminiTool[] | null => {
	const allowedTools = tools
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const geminiTool: GeminiTool = { functionDeclarations: functionDecls, }
	return [geminiTool]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	tools,
}: SendChatParams_Internal) => {

	const thisConfig = settingsOfProvider[providerName] as { apiKey: string }

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(tools)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, tools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// Tool-call buffer — Gemini emits each functionCall as a fully-formed object (not a
	// streamed partial like OpenAI/Anthropic), so we just accumulate them. Each chunk's
	// `chunk.functionCalls` may contain zero or more calls. We track by (name + JSON args)
	// to dedupe in case a later chunk repeats an earlier call (the SDK occasionally does
	// this in the final summary chunk). Ordering is preserved by first-appearance.
	type GeminiToolBuf = { name: string; argsStr: string; id: string }
	const geminiToolCalls: GeminiToolBuf[] = []
	const geminiToolSeen = new Set<string>()

	// Gemini reports token usage via chunk.usageMetadata. It typically appears in the last
	// chunk(s), but we keep the latest seen so we always forward the freshest values.
	let latestUsage: LLMUsage | undefined = undefined

	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			// Process the stream
			for await (const chunk of stream) {
				// message — split thought-tagged parts from answer parts.
				// Gemini 2.5 Pro / Gemma 4 route internal reasoning through parts with
				// `thought: true`; the visible answer lives in plain text parts. Using
				// `chunk.text` (SDK shortcut) would concatenate both, polluting the
				// chat view and the stored message history.
				const parts = chunk.candidates?.[0]?.content?.parts
				if (parts) {
					for (const part of parts) {
						if (typeof part.text !== 'string') continue // skip functionCall / inlineData / etc.
						if (part.thought === true) fullReasoningSoFar += part.text
						else fullTextSoFar += part.text
					}
				}

				// tool calls — iterate ALL functionCalls in the chunk. Previously we only kept
				// `functionCalls[0]`, silently dropping any parallel tool emission (e.g. a model
				// asking to read three files at once). Dedupe across chunks by (id || name+args).
				const functionCalls = chunk.functionCalls
				if (functionCalls && functionCalls.length > 0) {
					for (const fc of functionCalls) {
						const name = fc.name ?? ''
						const argsStr = JSON.stringify(fc.args ?? {})
						const id = fc.id ?? ''
						const key = id || `${name}::${argsStr}`
						if (geminiToolSeen.has(key)) continue
						geminiToolSeen.add(key)
						geminiToolCalls.push({ name, argsStr, id })
					}
				}

				// usage (Gemini exposes promptTokenCount / candidatesTokenCount / totalTokenCount /
				// thoughtsTokenCount / cachedContentTokenCount via usageMetadata). Multiple
				// chunks can carry usageMetadata during a stream, and the field set is NOT
				// consistent across chunks — notably, cachedContentTokenCount often appears
				// on an early chunk and is absent from the final summary. Merge per-field
				// with `??` so we preserve the best value seen so far instead of flickering
				// to `undefined` when Google stops reporting a field.
				const usageMetadata = chunk.usageMetadata
				if (usageMetadata) {
					latestUsage = {
						inputTokens: usageMetadata.promptTokenCount ?? latestUsage?.inputTokens,
						outputTokens: usageMetadata.candidatesTokenCount ?? latestUsage?.outputTokens,
						totalTokens: usageMetadata.totalTokenCount ?? latestUsage?.totalTokens,
						reasoningTokens: usageMetadata.thoughtsTokenCount ?? latestUsage?.reasoningTokens,
						cachedInputTokens: usageMetadata.cachedContentTokenCount ?? latestUsage?.cachedInputTokens,
					}
				}

				// Build the in-progress tool-call snapshot for UI streaming. Gemini tool calls
				// are already complete when they appear in a chunk, but we still surface them
				// via onText so the UI can render them as they arrive rather than only at end.
				const inProgressToolCalls: RawToolCallObj[] = geminiToolCalls.map(buf => ({
					name: buf.name as ToolName,
					rawParams: {},
					isDone: false,
					doneParams: [],
					id: buf.id,
				}))

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCalls: inProgressToolCalls.length > 0 ? inProgressToolCalls : undefined,
					usage: latestUsage,
				})
			}

			// on final — parse each accumulated tool buffer into a full RawToolCallObj.
			// Empty ids are filled with a UUID so downstream code (which keys tool-result
			// messages by id) doesn't collide across tools. Malformed JSON args are skipped.
			const finalToolCalls: RawToolCallObj[] = geminiToolCalls
				.map(buf => rawToolCallObjOfParamsStr(buf.name, buf.argsStr, buf.id || generateUuid()))
				.filter((t): t is RawToolCallObj => t !== null)

			if (!fullTextSoFar && !fullReasoningSoFar && finalToolCalls.length === 0) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
			} else {
				onFinalMessage({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					anthropicReasoning: null,
					usage: latestUsage,
					toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
				});
			}
		})
		.catch(error => {
			const message = error?.message
			if (typeof message === 'string') {

				if (error.message?.includes('API key')) {
					onError({ message: authErrorMessage(providerName, error), fullError: error });
				}
				else if (error?.message?.includes('429')) {
					onError({ message: 'Rate limit reached. ' + error, fullError: error });
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
