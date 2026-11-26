/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { URI } from '../../../../../base/common/uri.js'
import { isScratchUri, normalizeScratchPath, scratchEntryUri, scratchRootUri } from '../scratchPad.js'

// The scratch path is the only caller-supplied input that decides where a
// scratch write lands, so the interesting cases are the ones that try to leave
// the scratchpad. A name that is rejected must be rejected loudly: silently
// clipping it would put the file somewhere the model does not expect, and would
// make `delete_scratch` disagree with `write_scratch` about the target.

const root = URI.file('/work/project')

describe('scratchpad paths', () => {

	test('a thread scratchpad lives under .void/tmp', () => {
		assert.equal(scratchRootUri(root, 'thread-1').fsPath.replace(/\\/g, '/'), '/work/project/.void/tmp/thread-1')
	})

	test('a plain name resolves inside the scratchpad', () => {
		const entry = scratchEntryUri(scratchRootUri(root, 'thread-1'), normalizeScratchPath('probe.mjs'))
		assert.equal(entry.fsPath.replace(/\\/g, '/'), '/work/project/.void/tmp/thread-1/probe.mjs')
	})

	test('a nested name keeps its subdirectories', () => {
		assert.equal(normalizeScratchPath('logs/run.txt'), 'logs/run.txt')
	})

	test('backslashes are normalised to one separator', () => {
		assert.equal(normalizeScratchPath('logs\\run.txt'), 'logs/run.txt')
	})

	test('surrounding whitespace is not part of the name', () => {
		assert.equal(normalizeScratchPath('  probe.mjs  '), 'probe.mjs')
	})

	test('a name that tries to leave the scratchpad is rejected', () => {
		for (const name of ['../escape.mjs', 'a/../../escape.mjs', '..']) {
			assert.throws(() => normalizeScratchPath(name), /not allowed/, name)
		}
	})

	test('absolute paths and drive paths are rejected', () => {
		for (const name of ['/etc/passwd', '\\\\server\\share\\x', 'C:\\Windows\\x', 'c:/x']) {
			assert.throws(() => normalizeScratchPath(name), /relative|drive/, name)
		}
	})

	test('an empty or separator-only name is rejected', () => {
		for (const name of ['', '   ', 'logs/']) {
			assert.throws(() => normalizeScratchPath(name), /empty|separator|must name a file/, JSON.stringify(name))
		}
	})

	test('non-string names are rejected', () => {
		assert.throws(() => normalizeScratchPath(undefined), /expected a string/)
	})

	// The edit service asks this to keep a scratch write out of review. A false
	// negative there is a diff the user is asked to accept for a throwaway file,
	// and a false positive silently hides a real project change — so both sides
	// are pinned, including the case the filesystem reports differently.
	test('every path inside .void/tmp is scratch, and nothing else is', () => {
		const entry = scratchEntryUri(scratchRootUri(root, 'thread-1'), 'nested/probe.mjs')
		assert.equal(isScratchUri(entry), true, 'a file inside a thread scratchpad')
		assert.equal(isScratchUri(scratchRootUri(root, 'thread-1')), true, 'the thread root itself')
		assert.equal(isScratchUri(URI.joinPath(root, '.void', 'tmp')), true, 'the scratch root itself')
		assert.equal(isScratchUri(URI.joinPath(root, '.void', 'tmp', 'other-thread', 'x.txt')), true, 'another thread: still not a project change')

		assert.equal(isScratchUri(URI.joinPath(root, 'control.txt')), false, 'a project file');
		assert.equal(isScratchUri(URI.joinPath(root, '.void', '.gitignore')), false, 'the ignore file is not scratch content')
		assert.equal(isScratchUri(URI.joinPath(root, 'src', 'tmp', 'x.ts')), false, 'a folder that happens to be named tmp');
		assert.equal(isScratchUri(URI.joinPath(root, 'tmp', 'x.ts')), false, '.void is what makes it scratch')

		// Windows preserves the case the tool was given, and the ignore file is
		// written with a fixed case; the check must not depend on which one won.
		assert.equal(isScratchUri(URI.file('c:/work/project/.VOID/TMP/thread-1/probe.mjs')), true)
	})
})
