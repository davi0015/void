/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mergeRecordWrites, mergeSettingsWrites } from '../storageMerge.js';

// The arithmetic of a whole-blob write conflict.
//
// `base` is what this writer last read or wrote, `ours` is what it is about to write,
// and `persisted` is what storage holds now. The contract is one sentence — a key that
// did not change locally keeps the persisted value, a key that changed locally wins —
// and three of the cases below are the ones a naive `{...persisted, ...ours}` gets
// wrong: an untouched key overwritten by a stale copy, a deletion resurrected by the
// persisted blob, and a list compared by identity instead of by content.

suite('StorageMerge', () => {

	test('an untouched key keeps the value another writer stored', () => {
		const base = { 'file:///a': ['thread-1'] }
		const ours = { 'file:///a': ['thread-1'] } // this window changed nothing
		const persisted = { 'file:///a': ['thread-1'], 'file:///b': ['thread-2'] }

		assert.deepStrictEqual(
			mergeRecordWrites(persisted, base, ours),
			{ 'file:///a': ['thread-1'], 'file:///b': ['thread-2'] },
		);
	});

	test('a key this writer changed wins over the persisted value', () => {
		const base = { 'file:///a': ['thread-1'] }
		const ours = { 'file:///a': ['thread-1', 'thread-2'] }
		const persisted = { 'file:///a': ['thread-1', 'thread-9'] }

		assert.deepStrictEqual(
			mergeRecordWrites(persisted, base, ours),
			{ 'file:///a': ['thread-1', 'thread-2'] },
		);
	});

	test('a key this writer removed stays removed', () => {
		const base = { 'file:///a': ['thread-1'], 'file:///b': ['thread-2'] }
		const ours = { 'file:///a': ['thread-1'] }
		const persisted = { 'file:///a': ['thread-1'], 'file:///b': ['thread-2'] }

		const merged = mergeRecordWrites(persisted, base, ours)
		assert.deepStrictEqual(merged, { 'file:///a': ['thread-1'] },
			'the persisted blob resurrected a key this window deleted');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, 'file:///b'), false);
	});

	test('a list is compared by content, so an untouched list keeps the persisted value', () => {
		const base = { 'file:///a': ['thread-1', 'thread-2'] }
		const ours = { 'file:///a': ['thread-1', 'thread-2'] } // separately built, same bytes
		const persisted = { 'file:///a': ['thread-1', 'thread-2', 'thread-3'] }

		assert.deepStrictEqual(
			mergeRecordWrites(persisted, base, ours),
			{ 'file:///a': ['thread-1', 'thread-2', 'thread-3'] },
		);
	});

	test('a reordered list is a local change', () => {
		const base = { 'file:///a': ['thread-1', 'thread-2'] }
		const ours = { 'file:///a': ['thread-2', 'thread-1'] }
		const persisted = { 'file:///a': ['thread-1', 'thread-2'] }

		assert.deepStrictEqual(
			mergeRecordWrites(persisted, base, ours),
			{ 'file:///a': ['thread-2', 'thread-1'] },
		);
	});

	test('settings: a map field is merged per key, not replaced whole', () => {
		const base = {
			globalSettings: { chatMode: 'agent', autoApprove: false },
			settingsOfProvider: { anthropic: { models: ['a'], endpoint: '' } },
		}
		const ours = {
			globalSettings: { chatMode: 'orchestrator', autoApprove: false },
			settingsOfProvider: { anthropic: { models: ['a', 'b'], endpoint: '' } },
		}
		const persisted = {
			globalSettings: { chatMode: 'agent', autoApprove: true },
			settingsOfProvider: { anthropic: { models: ['a'], endpoint: '' }, openAI: { models: ['gpt'], apiKey: 'k' } },
		}

		const merged = mergeSettingsWrites(persisted, base, ours) as any
		assert.strictEqual(merged.globalSettings.chatMode, 'orchestrator', 'this window changed the mode, so it wins')
		assert.strictEqual(merged.globalSettings.autoApprove, true, 'this window did not touch autoApprove, so the other window keeps it')
		assert.deepStrictEqual(merged.settingsOfProvider.anthropic.models, ['a', 'b'], 'the provider this window edited moved')
		assert.deepStrictEqual(merged.settingsOfProvider.openAI, { models: ['gpt'], apiKey: 'k' },
			'a provider this window never touched was dropped by the map-level overwrite')
	});

	test('settings: an untouched field keeps the persisted value', () => {
		const base = { modelSelectionOfFeature: { Chat: null, Apply: null } }
		const ours = { modelSelectionOfFeature: { Chat: null, Apply: null } }
		const persisted = { modelSelectionOfFeature: { Chat: { providerName: 'openAI', modelName: 'gpt' }, Apply: null } }

		const merged = mergeSettingsWrites(persisted, base, ours) as any
		assert.deepStrictEqual(merged.modelSelectionOfFeature.Chat, { providerName: 'openAI', modelName: 'gpt' },
			'a model another window selected was overwritten by this window\'s stale copy')
	});
})
