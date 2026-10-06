/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Whether a failed request failed because the conversation no longer fits in the
// model's context window.
//
// This matters because the two failure classes need opposite responses. A rate
// limit or a dropped connection is transient: the same request, sent again, can
// succeed — that is what `CHAT_RETRIES` is for. An overflow is a statement about
// the input: re-sending it unchanged fails identically, so the only useful
// response is to send something smaller or to stop and explain.
//
// There is no structured signal to read. Providers report this as prose in an
// error message — the LLM transport hands the loop `error + ''` (see
// `sendLLMMessage.impl.ts`), so classification is necessarily textual, and the
// patterns below are the phrasings the providers in this repo actually emit.
// Each pattern is kept narrow on purpose: matching a rate limit ("... tokens per
// minute (TPM): Limit 6000 ...") or a gRPC deadline ("context deadline
// exceeded") as an overflow would replace a working retry with a dead end.

/** One provider phrasing, with the family it comes from — for the failure message. */
type OverflowPattern = { provider: string, pattern: RegExp }

const OVERFLOW_PATTERNS: readonly OverflowPattern[] = [
	// OpenAI, Azure OpenAI, DeepSeek, Mistral, Groq, OpenRouter, xAI and most
	// OpenAI-compatible endpoints, which pass the upstream message through:
	// "This model's maximum context length is 8192 tokens. However, your messages
	// resulted in 12000 tokens." Mistral phrases it as "Prompt contains 40000
	// tokens, but the maximum context length is 32768 tokens."
	{ provider: 'openai-compatible', pattern: /(?:maximum|max)\s+(?:context|prompt)[\s_-]?(?:length|window|size)/i },

	// Anthropic: "prompt is too long: 214026 tokens > 200000 maximum", and the
	// newer "input length and `max_tokens` exceed context limit: 208377 + ...".
	{ provider: 'anthropic', pattern: /\bprompt\s+is\s+too\s+long\b/i },
	{ provider: 'anthropic', pattern: /\b(?:input|prompt)\s+(?:length|size)\b.{0,40}\bexceed(?:s|ed)?\b.{0,20}\bcontext\b/i },

	// Google Gemini: "The input token count (1196265) exceeds the maximum number
	// of tokens allowed (1048576)."
	{ provider: 'google', pattern: /\bexceeds?\s+the\s+maximum\s+number\s+of\s+tokens\b/i },

	// llama.cpp server, and Ollama's wrapper around it: "the request exceeds the
	// available context size, try increasing it" / "input length exceeds the
	// context length".
	{ provider: 'llama.cpp', pattern: /\bexceeds?\s+the\s+available\s+context\s+size\b/i },

	// Provider-neutral phrasings, adapted from the harness this repo is modelled
	// on (@deepseek-ai/dsh-llm), which classifies the same condition as a
	// non-retryable code rather than retrying it. These catch the shapes above
	// and the ones we have not seen, without matching unrelated uses of the word
	// "context": the separator plus length/window is what excludes
	// "context deadline exceeded" and "context canceled".
	{ provider: 'neutral', pattern: /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i },
	{ provider: 'neutral', pattern: /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i },
	{ provider: 'neutral', pattern: /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i },
]

/**
 * Whether the provider rejected this request for exceeding the context window.
 *
 * Accepts what the loop receives: the `{ message }` object the transport's
 * `onError` builds, a bare string, or nothing at all.
 */
export const isContextOverflowError = (error: { message?: string } | string | null | undefined): boolean => {
	const message = typeof error === 'string' ? error : error?.message
	if (!message) return false
	return OVERFLOW_PATTERNS.some(({ pattern }) => pattern.test(message))
}
