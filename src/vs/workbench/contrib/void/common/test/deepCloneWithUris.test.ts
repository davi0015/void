/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { deepClone } from '../../../../../base/common/objects.js';
import { deepCloneWithUris } from '../deepCloneWithUris.js';

// The clone `duplicateThread` and `copyThreadToCurrentWorkspace` use. What it has to
// preserve is URI *identity*, which a plain `deepClone` does not: the components
// survive as own properties while `fsPath` and `toJSON` — prototype getters — do not.
// The last test pins that difference explicitly, so the reason this module exists is
// checked rather than remembered.

const file = () => URI.file('/Users/me/proj/docs/notes.md');

suite('DeepCloneWithUris', () => {

	test('a uri comes back as a uri', () => {
		const original = file();
		const clone = deepCloneWithUris({ uri: original });

		assert.ok(clone.uri instanceof URI);
		assert.strictEqual(clone.uri.fsPath, original.fsPath, 'the clone lost fsPath');
		assert.strictEqual(clone.uri.path, original.path);
	});

	test('a uri nested in an array survives', () => {
		// Messages hold selections in arrays, and tool params hold a uri inside a
		// params object — both need to work, so the recursion is not optional.
		const original = file();
		const clone = deepCloneWithUris({ selections: [{ type: 'File', uri: original }] });

		assert.ok(clone.selections[0].uri instanceof URI);
		assert.strictEqual(clone.selections[0].uri.fsPath, original.fsPath);
	});

	test('the serialised form carries $mid, so storage can revive it', () => {
		// `_storageReviver` revives only `$mid === 1`. Without it the persisted copy
		// never becomes a uri again, which is the half of this that outlives the
		// session.
		const json = JSON.stringify({ uri: deepCloneWithUris({ uri: file() }).uri });
		assert.match(json, /"\$mid":1/, `the clone serialised without $mid: ${json}`);
	});

	test('plain data is copied rather than shared', () => {
		// The reason the source is cloned at all: the copy is edited in place
		// (`_copyOwnedImages` reassigns `selection.uri`) and must not reach back.
		const source = { messages: [{ content: 'hello', selections: [{ type: 'File' }] }] };
		const clone = deepCloneWithUris(source);

		assert.notStrictEqual(clone, source);
		assert.notStrictEqual(clone.messages, source.messages);
		assert.notStrictEqual(clone.messages[0], source.messages[0]);

		clone.messages[0].content = 'changed';
		assert.strictEqual(source.messages[0].content, 'hello', 'the clone wrote through to the source');
	});

	test('the uri itself is shared, which is safe because it is immutable', () => {
		// Replacing a property on the clone cannot reach the source, and nothing
		// mutates a uri in place, so copying one would only cost memory.
		const original = file();
		assert.strictEqual(deepCloneWithUris({ uri: original }).uri, original);
	});

	test('primitives, null and arrays pass through as they would in deepClone', () => {
		assert.strictEqual(deepCloneWithUris('text'), 'text');
		assert.strictEqual(deepCloneWithUris(7), 7);
		assert.strictEqual(deepCloneWithUris(null), null);
		assert.strictEqual(deepCloneWithUris(undefined), undefined);

		const array = deepCloneWithUris([1, [2, 3]]);
		assert.deepStrictEqual(array, [1, [2, 3]]);
		assert.notStrictEqual(array[1], deepCloneWithUris([1, [2, 3]])[1]);
	});

	test('a plain deepClone is what this exists to avoid', () => {
		// The control. If `deepClone` ever stops stripping the prototype, this test
		// fails and the module — and the comment at its top — needs rereading
		// rather than quietly staying in place for no reason.
		const cloned = deepClone({ uri: file() }).uri as any;
		assert.strictEqual(cloned.fsPath, undefined, 'deepClone now preserves fsPath; the premise of this module has changed');
		assert.doesNotMatch(JSON.stringify({ uri: cloned }), /"\$mid":1/);
	});
});
