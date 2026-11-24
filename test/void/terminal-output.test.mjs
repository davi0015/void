/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Terminal output capture.
//
// `TerminalCommand.getOutput()` reads the xterm buffer between the command's
// executed and end markers. The buffer is a display surface: it hard-wraps at
// the terminal width and keeps only its last ~1,030 rows, so a large output
// arrives with its head silently missing. The prompt and the echoed command can
// also precede the output when the marker sits on the command line. The shell
// integration's C/D markers bracket the command's execution in the raw pty
// stream, and that window is the output itself.
//
// The long-output scenario is the subject: a 300 KB file read back cannot fit
// in the scrollback, so an unpatched call loses its head. The prompt/echo
// prefix is only recorded by the short scenario — where the executed marker
// lands decides whether it appears, and that is not stable enough to assert.
//
//   npm run test-void -- --only=terminal-output

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

const isWindows = process.platform === 'win32'
const READ_LONG = isWindows ? 'Get-Content -LiteralPath head-check.json -Raw' : 'cat head-check.json'

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

describe('terminal output capture', () => {
	test('a result is the output, not the terminal rendering', async (t) => {
		await h.withScenario('terminal-output/capture', async (s) => {
			// 300 KB cannot fit in the scrollback at any terminal width, so an
			// unpatched call returns a tail with the head missing.
			const headToken = 'HEAD-' + Math.random().toString(36).slice(2)
			const tailToken = 'TAIL-' + Math.random().toString(36).slice(2)
			const fixture = JSON.stringify({ head: headToken, body: 'x'.repeat(300_000), tail: tailToken })
			writeFileSync(join(s.dirs.workspacePath, 'head-check.json'), fixture)

			const long = await runCommand(s.page, READ_LONG, 60)
			t.diagnostic(`long output: ${long.elapsedMs} ms, ${long.model.length} chars`)
			assert.equal(long.resolveReason.type, 'done')
			assertSubject('the head of a long output reaches the model', long.model.includes(headToken), t)
			assert.equal(long.model.includes(tailToken), true, 'control: the tail must be present in both directions')

			const short = await runCommand(s.page, 'echo out-alpha')
			t.diagnostic(`short output: ${short.model}`)
			assert.equal(short.resolveReason.type, 'done')
			assert.equal(short.model.includes('out-alpha'), true, 'control: the output is present')
			// Recorded, not asserted: the prompt/echo prefix depends on where the
			// executed marker lands, which is not stable across shells or runs.
			t.diagnostic(`first body line: ${JSON.stringify((short.model.split('\n')[1] ?? '').trim())}`)
		})
	})

	test('output that arrives after the start marker still reaches the model', async (t) => {
		await h.withScenario('terminal-output/late', async (s) => {
			// The shell integration parses a chunk and fires `onCommandFinished`
			// during that parse; `onData` for the same chunk fires afterwards. If the
			// tracker is fed from `onData`, a command whose output lands in the same
			// chunk as its `D` marker is still "collecting" when the finish handler
			// runs, so the window it hands back is empty and the output is lost. A
			// process that takes a moment to start (node) makes that the normal case.
			const token = 'LATE-' + Math.random().toString(36).slice(2)
			const command = isWindows
				? `Start-Sleep -Milliseconds 300; Write-Output "${token}"`
				: `sleep 0.3; echo ${token}`
			const late = await runCommand(s.page, command)
			t.diagnostic(`late output (${late.elapsedMs} ms): ${JSON.stringify(late.model)}`)
			assert.equal(late.resolveReason.type, 'done', 'control: the command settled on the done marker')
			assertSubject('output produced after the start marker reaches the model', late.model.includes(token), t)
		})
	})
})
