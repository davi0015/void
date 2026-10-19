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
//
// The platform-specific cases pin their rules explicitly rather than exercising whatever
// one the suite happens to run on, because the rules differ in a way that is invisible
// from either side alone: Windows folds separators and case, POSIX must fold neither.
// The general cases before them pass no option and so do run under the ambient platform.
// They are invariant rather than pinned — `/` fixtures on which folding is a no-op, so
// every one answers the same on either OS, which is what makes them safe to run anywhere
// instead of merely passing here.

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

	// Windows. The folders arrive as `fsPath`s while the target is whatever the model
	// typed, so the two disagree on separators and on the drive's case by construction
	// — and on POSIX they never do. Every fixture above uses `/` and matches
	// case-sensitively, which is why the absolute-path case could be broken there for
	// as long as it was: the unit tier never saw a backslash.
	const WIN_FOLDERS = ['c:\\Users\\me\\proj', 'c:\\Users\\me\\proj\\vendor'];

	test('windows: an absolute path inside a folder becomes a relative one', () => {
		assert.strictEqual(
			workspaceRelativeSearchPattern('C:\\Users\\me\\proj\\docs\\prd.md', WIN_FOLDERS, { windows: true }),
			'docs/prd.md',
		);
	});

	test('windows: separators and case may differ between the folder and the target', () => {
		// The drive letter and the directory casing come from different sources — a
		// `fsPath` from the workspace service, the target from the model's reply — so
		// neither side can be assumed to match the other.
		assert.strictEqual(
			workspaceRelativeSearchPattern('C:/Users/Me/Proj/Docs/Prd.md', WIN_FOLDERS, { windows: true }),
			'Docs/Prd.md',
		);
	});

	test('windows: the longest matching folder still wins', () => {
		assert.strictEqual(
			workspaceRelativeSearchPattern('C:\\Users\\me\\proj\\vendor\\lib\\a.ts', WIN_FOLDERS, { windows: true }),
			'lib/a.ts',
		);
	});

	test('windows: a path outside every folder is left alone', () => {
		assert.strictEqual(
			workspaceRelativeSearchPattern('D:\\other\\a.ts', WIN_FOLDERS, { windows: true }),
			'D:\\other\\a.ts',
		);
	});

	test('windows: a .\\ prefix is dropped', () => {
		assert.strictEqual(
			workspaceRelativeSearchPattern('.\\docs\\prd.md', WIN_FOLDERS, { windows: true }),
			'docs/prd.md',
		);
	});

	// The other direction, and the reason folding is platform-gated rather than
	// unconditional: on POSIX a backslash is an ordinary filename character and `Proj`
	// is not `proj`. Folding always would "fix Windows" by matching files that are not
	// there.
	test('posix: case still matters', () => {
		assert.strictEqual(
			workspaceRelativeSearchPattern('/Users/me/Proj/docs/a.ts', FOLDERS, { windows: false }),
			'/Users/me/Proj/docs/a.ts',
		);
	});

	test('posix: a backslash is a filename character, not a separator', () => {
		// One file named `proj\docs\a.ts` sitting in `/Users/me`, not a path into the
		// folder. Folding separators would shorten it and match the wrong file.
		assert.strictEqual(
			workspaceRelativeSearchPattern('/Users/me/proj\\docs\\a.ts', FOLDERS, { windows: false }),
			'/Users/me/proj\\docs\\a.ts',
		);
	});
});
