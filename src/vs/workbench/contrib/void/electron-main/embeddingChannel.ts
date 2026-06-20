/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// IPC channel for embedding calls. Runs in the electron-main process
// where network access and the OpenAI SDK are available.
// Registered in app.ts alongside the other Void channels.

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { newOpenAICompatibleSDK } from './llmMessage/sendLLMMessage.impl.js';
import type { ProviderName, SettingsOfProvider } from '../common/voidSettingsTypes.js';

export type EmbedParams = {
	providerName: ProviderName;
	modelName: string;
	texts: string[];
	settingsOfProvider: SettingsOfProvider;
}

export type EmbedResult = {
	embeddings: number[][];
}

export class EmbeddingChannel implements IServerChannel {

	listen(_: unknown, _event: string): Event<any> {
		throw new Error(`EmbeddingChannel has no events.`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'embed') {
			return this._embed(params as EmbedParams);
		}
		throw new Error(`EmbeddingChannel: command "${command}" not recognized.`);
	}

	private async _embed(params: EmbedParams): Promise<EmbedResult> {
		const { providerName, modelName, texts, settingsOfProvider } = params;

		// Filter out empty/whitespace-only texts — embedding servers reject them
		const nonEmptyTexts = texts.map(t => t.trim()).filter(t => t.length > 0)
		if (nonEmptyTexts.length === 0) {
			return { embeddings: texts.map(() => []) }
		}

		// Replace empty/whitespace-only texts with a single space to preserve index mapping
		const processedTexts = texts.map(t => t.trim().length > 0 ? t : ' ')
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider });

		// Retry on rate limit (429) and gateway timeout (504) with exponential backoff
		const maxRetries = 5
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				// encoding_format: 'float' — the SDK defaults to 'base64' which some
				// providers (litellm, sglang, vLLM) decode incorrectly, yielding all-zero vectors
				const response = await openai.embeddings.create({ model: modelName, input: processedTexts, encoding_format: 'float' });
				const embeddings = response.data.map((d: { embedding: number[] }) => d.embedding)
				// Map back: originally-empty texts get zero vector, non-empty get their embedding
				let embedIdx = 0
				const result = texts.map(t => t.trim().length > 0 ? embeddings[embedIdx++] ?? [] : [])
				return { embeddings: result }
			} catch (e: any) {
				const isRetryable = e?.status === 429 || e?.status === 504
					|| e?.message?.includes('429') || e?.message?.includes('504')
				if (isRetryable && attempt < maxRetries - 1) {
					const retryAfter = e?.headers?.['retry-after']
					const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000
					await new Promise<void>(resolve => setTimeout(resolve, delay))
					continue
				}
				throw e
			}
		}
		throw new Error('Max retries exceeded')
	}
}
