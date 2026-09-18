/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { workspaceRelativeSearchPattern } from '../codespanSearchPattern.js';

// The string arithmetic that turns a file named in a chat reply into a search
// pattern the workspace search can match. The cases that matter are the ones that
// silently match nothing: an absolute path, a `./` prefix, and a path outside the
// workspace — the last of which must stay unmatched rather than fall back to a
// basename and link to a different file.

const FOLDERS = ['/Users/me/proj', '/Users/me/proj/vendor'];

suite('CodespanSearchPattern', () => {

	test('a bare name or relative path is already a pattern', () => {
		assert.strictEqual(workspaceRelativeSearchPattern('hello_metal.py', FOLDERS), 'hello_metal.py');
		assert.strictEqual(workspaceRelativeSearchPattern('docs/prd.md', FOLDERS), 'docs/prd.md');
		assert.strictEqual(workspaceRelativeSearchPattern('src/app/main.py', FOLDERS), 'src/app/main.py');
	});

	test('an absolute path inside a folder becomes a relative one', () => {
		assert.strictEqual(
			workspaceRelativeSearchPattern('/Users/me/proj/docs/prd.md', FOLDERS),
			'docs/prd.md',
		);
	});

	test('the longest matching folder wins, so nesting is respected', () => {
		// Both folders are prefixes of this path. The result must be relative to
		// `vendor`, not to its parent.
		assert.strictEqual(
			workspaceRelativeSearchPattern('/Users/me/proj/vendor/lib/a.ts', FOLDERS),
			'lib/a.ts',
		);
	});

	test('a leading ./ is dropped', () => {
		assert.strictEqual(workspaceRelativeSearchPattern('./docs/prd.md', FOLDERS), 'docs/prd.md');
		assert.strictEqual(workspaceRelativeSearchPattern('./hello.py', FOLDERS), 'hello.py');
	});

	test('an absolute path outside every folder is left alone', () => {
		// Not rewritten to `passwd`: the search must find nothing rather than match a
		// same-named file in the workspace and link somewhere unrelated.
		assert.strictEqual(workspaceRelativeSearchPattern('/etc/passwd', FOLDERS), '/etc/passwd');
		assert.strictEqual(
			workspaceRelativeSearchPattern('/opt/homebrew/opt/llvm@17/bin/clang++', FOLDERS),
			'/opt/homebrew/opt/llvm@17/bin/clang++',
		);
	});

	test('a folder path itself is not treated as a prefix of a sibling name', () => {
		// `/Users/me/project-x` starts with `/Users/me/proj` as a string but is not
		// inside that folder, so it must not be shortened.
		assert.strictEqual(workspaceRelativeSearchPattern('/Users/me/project-x/a.ts', FOLDERS), '/Users/me/project-x/a.ts');
	});

	test('a folder given with a trailing slash still matches', () => {
		assert.strictEqual(workspaceRelativeSearchPattern('/Users/me/proj/docs/a.ts', ['/Users/me/proj/']), 'docs/a.ts');
	});

	test('a span that is not a path is returned unchanged', () => {
		// These are a shell command and an expression. Neither is a file, and the
		// resolver's later matching is what rejects them — this function must not
		// quietly turn them into something else.
		assert.strictEqual(workspaceRelativeSearchPattern('python hello_metal.py', FOLDERS), 'python hello_metal.py');
		assert.strictEqual(workspaceRelativeSearchPattern('scale(0.5) * viewport', FOLDERS), 'scale(0.5) * viewport');
	});

	test('no workspace folders leaves the target unchanged', () => {
		assert.strictEqual(workspaceRelativeSearchPattern('/Users/me/proj/a.ts', []), '/Users/me/proj/a.ts');
		assert.strictEqual(workspaceRelativeSearchPattern('docs/a.ts', []), 'docs/a.ts');
	});
});
