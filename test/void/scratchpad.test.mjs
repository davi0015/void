/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The scratchpad is the one place an agent write is not a project change.
//
// A change is what the user reviews: it appears in the command bar's list and
// waits for accept or reject. A probe script has nothing to review — it is not a
// deliverable and nobody wants to accept it file by file — so `write_scratch`
// writes directly and never creates a diff zone. This file pins that with a
// control: the same content written through `rewrite_file` *is* tracked, which is
// what proves the assertion can see a change at all.
//
// It also pins the boundary that makes "non-reviewable" safe: the name is the
// only caller input, so it cannot reach a project file. A traversal name must
// fail, not be clipped into the scratchpad, because a silently rewritten path
// would put the file somewhere the model does not expect.
//
//   npm run test-void -- --only=scratchpad

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

let toolCounter = 0

/** Runs one tool through the dispatch path the agent loop uses. */
async function callTool(page, name, params) {
	const toolId = `scratch-e2e-${++toolCounter}`
	return page.evaluate(async ({ nameArg, paramsArg, idArg }) => {
		const svc = globalThis.__voidChatThreadService
		const threadId = svc.state.currentThreadId
		// A preapproved call is dispatched with the params it was approved with, so
		// a tool that takes a URI must receive a resolved one. The scratch tools are
		// given the raw params on purpose: their own guard is what must reject a
		// traversal, not only the schema.
		const validated = nameArg === 'rewrite_file'
			? svc._toolsService.validateParams[nameArg](paramsArg)
			: paramsArg
		const res = await svc._runToolCall(threadId, nameArg, idArg, undefined, {
			preapproved: true,
			unvalidatedToolParams: paramsArg,
			validatedParams: validated,
		})
		const row = svc.state.allThreads[threadId].messages.find(m => m.role === 'tool' && m.id === idArg)
		const commandBar = svc._toolsService.commandBarService
		return {
			interrupted: res.interrupted === true,
			rowType: row?.type,
			rowContent: row?.content ?? '',
			threadId,
			changedPaths: (commandBar.sortedURIs ?? []).map(u => u.fsPath),
		}
	}, { nameArg: name, paramsArg: params, idArg: toolId })
}

describe('agent scratchpad', () => {
	test('scratch writes are not project changes, and project writes still are', async (t) => {
		await h.withScenario('scratchpad/write', async (s) => {
			// Subject: a scratch write must succeed, land under .void/tmp/<thread>,
			// and create no diff entry for the user to accept.
			const scratch = await callTool(s.page, 'write_scratch', { path: 'probe.mjs', content: 'console.log("scratch")\n' })
			t.diagnostic(`write_scratch: ${scratch.rowType} ${scratch.rowContent.slice(0, 160)}`)
			assert.equal(scratch.rowType, 'success', `the scratch write failed: ${scratch.rowContent}`)

			const scratchPath = join(s.dirs.workspacePath, '.void', 'tmp', scratch.threadId, 'probe.mjs')
			assert.ok(existsSync(scratchPath), `no scratch file at ${scratchPath}`)
			assert.equal(readFileSync(scratchPath, 'utf8'), 'console.log("scratch")\n')
			// URI.file lowercases the drive letter on Windows ("c:\..."), and the
			// test's own join() keeps it uppercase — compare without case.
			assert.ok(scratch.rowContent.toLowerCase().includes(scratchPath.toLowerCase()), 'the result must name the absolute path it wrote')
			// Follows VOID_EXPECT: under `lost` the scratch file must be *present*
			// among the files awaiting review. That is the inversion that proves this
			// assertion tracks the behaviour instead of always reading "absent".
			h.assertAbsent('a scratch file does not appear among the files awaiting review', !scratch.changedPaths.some(p => p.endsWith('probe.mjs')), { subject: true })
			assert.ok(scratch.rowContent.includes('.gitignore') || existsSync(join(s.dirs.workspacePath, '.void', '.gitignore')), 'the scratchpad must be kept out of git')

			// Control: a project write by the same route must show up for review. It
			// passes in every configuration, so a scratch assertion that stopped
			// seeing diffs would not pass silently.
			const control = await callTool(s.page, 'rewrite_file', { uri: 'control.txt', new_content: 'project change\n' })
			t.diagnostic(`rewrite_file: ${control.rowType}`)
			assert.equal(control.rowType, 'success', `the control write failed: ${control.rowContent}`)
			assert.ok(control.changedPaths.some(p => p.endsWith('control.txt')), 'the control write must appear among the files awaiting review')

			// The name cannot reach outside the scratchpad: a traversal has to fail
			// loudly, and nothing may be written at the workspace root.
			const escape = await callTool(s.page, 'write_scratch', { path: '../escape.mjs', content: 'nope' })
			t.diagnostic(`traversal: ${escape.rowType} ${escape.rowContent.slice(0, 120)}`)
			assert.equal(escape.rowType, 'tool_error', 'a name that climbs out of the scratchpad must be rejected')
			assert.ok(!existsSync(join(s.dirs.workspacePath, 'escape.mjs')), 'a rejected traversal must not write the file')

			// Scratch files are the agent's to remove; project files are not.
			const deleted = await callTool(s.page, 'delete_scratch', { path: 'probe.mjs' })
			t.diagnostic(`delete_scratch: ${deleted.rowType}`)
			assert.equal(deleted.rowType, 'success', `delete_scratch failed: ${deleted.rowContent}`)
			assert.ok(!existsSync(scratchPath), 'delete_scratch must remove the file')

			const protectedFile = await callTool(s.page, 'delete_scratch', { path: '../../control.txt' })
			t.diagnostic(`delete_scratch traversal: ${protectedFile.rowType}`)
			assert.equal(protectedFile.rowType, 'tool_error', 'delete_scratch must not reach a project file')
			assert.ok(existsSync(join(s.dirs.workspacePath, 'control.txt')), 'the project file must still be there')
		})
	})
})
