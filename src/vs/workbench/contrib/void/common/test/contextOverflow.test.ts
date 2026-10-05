/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isContextOverflowError } from '../contextOverflow.js'

// The messages below are the strings the providers in this repo actually return,
// as they arrive at the loop: `sendLLMMessage.impl.ts` does
// `onError({ message: error + '' })`, so an SDK error arrives stringified and a
// provider-reported stream error arrives as its own text.
//
// The negatives matter as much as the positives. Classifying a rate limit or a
// gRPC deadline as an overflow replaces a retry that works with a dead end, so
// every pattern has a near-miss it must leave alone.

describe('context overflow classification', () => {

	describe('requests that do not fit', () => {
		const overflows: [string, string][] = [
			['openai',
				"Error: 400 This model's maximum context length is 8192 tokens. However, your messages resulted in 12000 tokens. Please reduce the length of the messages."],
			['openai (responses)',
				"Error: 400 {'error': {'message': \"This model's maximum context length is 128000 tokens. However, your messages resulted in 137628 tokens.\", 'type': 'invalid_request_error'}}"],
			['deepseek',
				"Error: 400 This model's maximum context length is 65536 tokens. However, you requested 70000 tokens"],
			['mistral',
				'Error: 400 Prompt contains 40000 tokens, but the maximum context length is 32768 tokens'],
			['openrouter',
				"Error: 400 This endpoint's maximum context length is 128000 tokens. However, you requested about 200000 tokens"],
			['anthropic',
				'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 214026 tokens > 200000 maximum"}}'],
			['anthropic (max_tokens)',
				'Error: 400 input length and `max_tokens` exceed context limit: 208377 + 32000 > 227328'],
			['google',
				'Error: 400 INVALID_ARGUMENT: The input token count (1196265) exceeds the maximum number of tokens allowed (1048576).'],
			['llama.cpp',
				'Error: 400 the request exceeds the available context size, try increasing it'],
			['ollama',
				'Error: 400 input length exceeds the context length'],
			['error code',
				'Error: 400 context_length_exceeded'],
			['neutral phrasing',
				'Error: 400 Request is too long for this model context'],
		]

		for (const [provider, message] of overflows) {
			test(`${provider} is classified as an overflow`, () => {
				assert.equal(isContextOverflowError({ message }), true, message.slice(0, 80))
			})
		}
	})

	describe('failures that must keep retrying', () => {
		const transient: [string, string][] = [
			['groq rate limit',
				'Error: 429 Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` on tokens per minute (TPM): Limit 6000, Used 5500, Requested 1200. Please try again in 4s.'],
			['openai rate limit',
				'Error: 429 You exceeded your current quota, please check your plan and billing details.'],
			['gRPC deadline',
				'Error: context deadline exceeded'],
			['gRPC cancellation',
				'Error: context canceled'],
			['output token cap',
				"Error: 400 Invalid 'max_tokens': 9000. This model supports at most 8192 completion tokens."],
			['credit balance',
				'Error: 400 Your credit balance is too low to access the Anthropic API.'],
			['overloaded',
				'Error: 503 The engine is currently overloaded, please try again later'],
			['auth',
				'Error: 401 Incorrect API key provided: sk-abc***. You can find your API key at https://platform.openai.com/account/api-keys.'],
			['missing model',
				'Error: 404 The model `gpt-5-turbo` does not exist or you do not have access to it.'],
			['empty response',
				'Void: Response from model was empty.'],
			['batch size limit',
				'Error: 400 Request too large for the batch API: at most 50000 requests per batch'],
		]

		for (const [why, message] of transient) {
			test(`${why} is not classified as an overflow`, () => {
				assert.equal(isContextOverflowError({ message }), false, message.slice(0, 80))
			})
		}
	})

	describe('shapes other than a message object', () => {
		test('accepts a bare string', () => {
			assert.equal(isContextOverflowError('Error: 400 context_length_exceeded'), true)
		})

		test('treats a missing or empty message as not an overflow', () => {
			assert.equal(isContextOverflowError(undefined), false)
			assert.equal(isContextOverflowError(null), false)
			assert.equal(isContextOverflowError({}), false)
			assert.equal(isContextOverflowError(''), false)
		})
	})
})
