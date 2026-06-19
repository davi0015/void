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

		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider });
		const response = await openai.embeddings.create({ model: modelName, input: texts });
		return { embeddings: response.data.map((d: { embedding: number[] }) => d.embedding) };
	}
}
