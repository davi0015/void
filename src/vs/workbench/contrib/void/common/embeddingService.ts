/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Browser-side IPC proxy for embedding calls. Routes through the main process
// via void-channel-embedding (same pattern as fetchUrlService).

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { ProviderName, SettingsOfProvider } from './voidSettingsTypes.js';
import type { EmbedParams, EmbedResult } from '../electron-main/embeddingChannel.js';

export interface IEmbeddingService {
	readonly _serviceBrand: undefined;
	embed(providerName: ProviderName, modelName: string, texts: string[], settingsOfProvider: SettingsOfProvider): Promise<number[][]>;
}

export const IEmbeddingService = createDecorator<IEmbeddingService>('embeddingService');

export class EmbeddingService implements IEmbeddingService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		this.channel = mainProcessService.getChannel('void-channel-embedding');
	}

	async embed(providerName: ProviderName, modelName: string, texts: string[], settingsOfProvider: SettingsOfProvider): Promise<number[][]> {
		const params: EmbedParams = { providerName, modelName, texts, settingsOfProvider };
		const result: EmbedResult = await this.channel.call('embed', params);
		return result.embeddings;
	}
}

registerSingleton(IEmbeddingService, EmbeddingService, InstantiationType.Delayed);
