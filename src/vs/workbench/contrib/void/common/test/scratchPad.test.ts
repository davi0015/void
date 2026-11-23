/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { URI } from '../../../../../base/common/uri.js'
import { normalizeScratchPath, scratchEntryUri, scratchRootUri } from '../scratchPad.js'

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
})
