/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { FetchUrlParams, FetchUrlResult } from '../electron-main/fetchUrlChannel.js';

export interface IFetchUrlService {
	readonly _serviceBrand: undefined;
	fetchUrl(url: string): Promise<FetchUrlResult>;
}

export const IFetchUrlService = createDecorator<IFetchUrlService>('fetchUrlService');

export class FetchUrlService implements IFetchUrlService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		this.channel = mainProcessService.getChannel('void-channel-fetchUrl');
	}

	async fetchUrl(url: string): Promise<FetchUrlResult> {
		const params: FetchUrlParams = { url };
		return this.channel.call('fetchUrl', params);
	}
}

registerSingleton(IFetchUrlService, FetchUrlService, InstantiationType.Delayed);
