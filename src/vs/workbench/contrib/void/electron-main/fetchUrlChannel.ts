/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const MAX_FETCH_CONTENT_CHARS = 30_000
const FETCH_TIMEOUT_MS = 15_000

export type FetchUrlParams = { url: string }
export type FetchUrlResult = { title: string; content: string; url: string }

export class FetchUrlChannel implements IServerChannel {

	listen(_: unknown, _event: string): Event<any> {
		throw new Error(`FetchUrlChannel has no events.`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'fetchUrl') {
			return this._fetchUrl(params as FetchUrlParams);
		}
		throw new Error(`FetchUrlChannel: command "${command}" not recognized.`);
	}

	private async _fetchUrl(params: FetchUrlParams): Promise<FetchUrlResult> {
		const { url } = params;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; VoidIDE/1.0)',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
				redirect: 'follow',
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const contentType = response.headers.get('content-type') ?? '';
			const rawBody = await response.text();

			// Non-HTML: return as-is (JSON, plain text, etc.)
			if (!contentType.includes('html')) {
				return {
					title: url,
					content: rawBody.substring(0, MAX_FETCH_CONTENT_CHARS),
					url,
				};
			}

			// Parse HTML into a DOM
			const { document } = parseHTML(rawBody);

			// Try Readability first
			const reader = new Readability(document as any);
			const article = reader.parse();

			let title: string;
			let html: string;

			if (article && article.content) {
				title = article.title || url;
				html = article.content;
			} else {
				// Fallback: strip non-content tags, use the body
				title = document.title || url;
				for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript']) {
					for (const el of document.querySelectorAll(tag)) {
						el.remove();
					}
				}
				html = document.body?.innerHTML ?? rawBody;
			}

			// Convert HTML to Markdown
			const turndown = new TurndownService({
				headingStyle: 'atx',
				codeBlockStyle: 'fenced',
				bulletListMarker: '-',
			});
			let markdown = turndown.turndown(html);

			if (markdown.length > MAX_FETCH_CONTENT_CHARS) {
				markdown = markdown.substring(0, MAX_FETCH_CONTENT_CHARS) + '\n\n[Content truncated]';
			}

			return { title, content: markdown, url };

		} finally {
			clearTimeout(timer);
		}
	}
}
