/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Multi-line terminal input.
//
// A temporary terminal is disposed the moment a call settles, and a multi-line
// command is not one command to the shell: every newline is an Enter press, so
// the shell runs the lines one after another. Settling on the first
// `onCommandFinished` therefore closed the pty while the remaining input was
// still queued: a slow line (a sleep, a test run, an install) was killed where
// it stood, and the lines after it never ran at all. This file pins the two
// consequences: the whole input runs, and a failing line fails the batch.
//
// The scenarios drive `runCommand` directly and render its result with the real
// stringifier. The subject is the settle/dispose decision, not approval or
// prompt construction, and driving the service keeps that observable without a
// model. The single-line scenario is the control that must pass in both
// directions.
//
//   npm run test-void -- --only=terminal-multiline

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

const isWindows = process.platform === 'win32'
const SLEEP = isWindows ? 'Start-Sleep -Seconds 1' : 'sleep 1'
const CD_FAIL = isWindows ? 'cd C:\\void-e2e-no-such-dir' : 'cd /void-e2e-no-such-dir'
// The value is not in the command text, so finding it in the result proves the
// last line ran and its output was captured.
const LAST_LINE = isWindows ? 'Write-Output (6*7)' : 'echo $((6*7))'

/** Runs one command through the real terminal tool and returns the model-visible string. */
function runCommand(page, command, timeoutSeconds = 30) {
	return page.evaluate(async ({ command, timeoutSeconds }) => {
		const chat = globalThis.__voidChatThreadService
		const service = chat._terminalToolService
		const tools = chat._toolsService
		const terminalId = 'e2e-' + Math.random().toString(36).slice(2)
		const params = { command, cwd: null, terminalId, timeoutSeconds }
		const startedAt = Date.now()
		const { resPromise } = await service.runCommand(command, { type: 'temporary', cwd: null, terminalId, timeoutSeconds })
		const result = await resPromise
		return {
			elapsedMs: Date.now() - startedAt,
			resolveReason: result.resolveReason,
			model: tools.stringOfResult['run_command'](params, result),
		}
	}, { command, timeoutSeconds })
}

/** A boolean that is part of the behaviour under test, so it follows VOID_EXPECT. */
function assertSubject(label, observed, t) {
	const wanted = h.expectedPersistence()
	assert.equal(observed, wanted, `${label}: expected ${wanted ? 'observed' : 'not observed'} (VOID_EXPECT=${process.env.VOID_EXPECT ?? 'present'})`)
	t.diagnostic(`${label}: ${observed ? 'observed' : 'not observed'}`)
}

describe('terminal multi-line execution', () => {
	test('every line completes before the call settles', async (t) => {
		await h.withScenario('terminal-multiline/execution', async (s) => {
			// Control: a single line must behave exactly as before.
			const single = await runCommand(s.page, 'echo solo-control')
			t.diagnostic(`single line: ${single.model}`)
			assert.equal(single.resolveReason.type, 'done')
			assert.equal(single.resolveReason.exitCode, 0)
			assert.match(single.model, /solo-control/)

			// The first subject: a slow line sits between line 1 and the write.
			// The old call settled on line 1 and disposed the pty during the sleep.
			const slow = await runCommand(s.page, [
				'echo first-line',
				SLEEP,
				'echo finished > ml-slow.txt',
				LAST_LINE,
			].join('\n'))
			t.diagnostic(`slow line (${slow.elapsedMs} ms): ${slow.model}`)
			assert.equal(slow.resolveReason.type, 'done')
			h.assertPersistence('the line after the sleep wrote its file', existsSync(join(s.dirs.workspacePath, 'ml-slow.txt')), { subject: true })
			assertSubject('the last line ran and its output reached the model', /\b42\b/.test(slow.model), t)

			// The second subject: a failing line must fail the batch, and it must
			// not stop the lines after it. The old call settled on line 1 with 0.
			const failed = await runCommand(s.page, [
				'echo ok',
				CD_FAIL,
				SLEEP,
				'echo after > ml-fail.txt',
			].join('\n'))
			t.diagnostic(`failing line (${failed.elapsedMs} ms): ${failed.model}`)
			assert.equal(failed.resolveReason.type, 'done')
			assertSubject('a failing line reports a non-zero exit code', failed.resolveReason.exitCode !== 0, t)
			h.assertPersistence('the line after the failure still ran', existsSync(join(s.dirs.workspacePath, 'ml-fail.txt')), { subject: true })
		})
	})
})
