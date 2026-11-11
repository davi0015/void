/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isInboundPayload } from '../integrationTypes.js';

// The direction guard for the Void Integration Protocol. Everything arriving on
// the localhost socket is envelope-wrapped JSON that a proxy sent, and the
// channel's data handler routes it through this predicate before firing
// `onInbound`. A false positive here hands an outbound payload to the inbound
// consumer (type-confused at runtime after parsing); a false negative silently
// drops a real user message, which is worse — the user sees nothing happen in
// their thread and there is no error anywhere.

const inboundPayloads = [
	{ type: 'userMessage', conversationKey: 'root-1', text: 'hi', author: 'me' },
	{ type: 'approvalResponse', requestId: 'r1', approved: true },
	{ type: 'approvalResponse', requestId: 'r2', approved: false },
	{ type: 'interrupt', conversationKey: 'root-1' },
	{ type: 'newThread', conversationKey: 'root-9' },
];

const outboundPayloads = [
	{ type: 'streamDelta', conversationKey: 'root-1', textSoFar: 'partial' },
	{ type: 'toolStatus', conversationKey: 'root-1', toolName: 'read_file', mcpServerName: undefined, phase: 'success', summary: 'readFile src/foo.ts' },
	{ type: 'approvalRequest', requestId: 'r1', conversationKey: 'root-1', toolName: 'edit_file', mcpServerName: undefined, paramsSummary: 'editFile src/foo.ts' },
	{ type: 'final', conversationKey: 'root-1', text: 'done', usage: undefined },
	{ type: 'error', conversationKey: 'root-1', message: 'boom' },
];

suite('IntegrationProtocol', () => {

	test('every inbound payload type is recognized', () => {
		for (const p of inboundPayloads) {
			assert.strictEqual(isInboundPayload(p), true, `expected inbound: ${p.type}`);
		}
	});

	test('no outbound payload type is recognized', () => {
		// A proxy echoing our own messages back — or a malicious/garbled
		// payload claiming an outbound type — must never reach onInbound.
		for (const p of outboundPayloads) {
			assert.strictEqual(isInboundPayload(p), false, `expected NOT inbound: ${p.type}`);
		}
	});

	test('unknown types are rejected', () => {
		assert.strictEqual(isInboundPayload({ type: 'usermessage' }), false, 'case-sensitive');
		assert.strictEqual(isInboundPayload({ type: '' }), false, 'empty');
		assert.strictEqual(isInboundPayload({ type: 'deleteEverything' }), false, 'invented type');
	});

	test('the two payload sets do not overlap', () => {
		// Pins the actual invariant the guard maintains: the inbound and
		// outbound type literals are disjoint. If someone adds an inbound
		// type without extending the guard, this fails before anything
		// silently drops messages at runtime.
		const inboundTypes = new Set(inboundPayloads.map(p => p.type));
		const outboundTypes = new Set(outboundPayloads.map(p => p.type));
		for (const t of inboundTypes) {
			assert.strictEqual(outboundTypes.has(t), false, `type is both directions: ${t}`);
		}
		// 4 distinct types: userMessage, approvalResponse (both approved values),
		// interrupt, newThread
		assert.strictEqual(inboundTypes.size, 4, 'a new inbound type was added — extend isInboundPayload and this test');
	});
});
