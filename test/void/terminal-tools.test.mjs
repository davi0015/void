/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// What the agent knows about the terminal it is driving, and what driving it costs
// the user.
//
// Three things were wrong, and this file pins the two that are observable from
// outside the tool:
//
//  1. The volatile context listed running terminals but never said what shell a
//     new command would land in, so the model had to learn PowerShell vs cmd vs
//     wsl by trial and error.
//  2. Opening and running on a persistent terminal took keyboard focus, so a user
//     typing in the chat box lost their caret mid-sentence. The reveal is needed —
//     the terminal has to be attached for its xterm and command detection to exist
//     — but the focus is not.
//
//  3. A shell VS Code cannot inject shell integration into (cmd, wsl) had no
//     completion signal at all: every command resolved only by the inactivity
//     timeout, and status was unknown forever. The tool now appends an exit-code
//     marker to the command line. The last scenario covers that path.
//
// The focus scenario drives the *chat input* rather than a synthetic element.
// That matters: the reveal re-renders the sidebar, so a probe element survives a
// broken restore that the real input does not, and an earlier version of this
// test passed while the bug was still there.
//
//   npm run test-void -- --only=terminal-tools

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

/** Sends one user message and lets the stubbed model answer it. */
async function send(page, userMessage) {
	await page.evaluate(async (text) => {
		const svc = globalThis.__voidChatThreadService
		await svc.addUserMessageAndStreamResponse({ userMessage: text, threadId: svc.state.currentThreadId })
	}, userMessage)
}

/**
 * Drives one tool through the same entry the agent loop uses, and returns its row.
 *
 * `validated` is the params object a preapproved call dispatches with, so the two
 * have to agree — validation is skipped on this path, so the shape is not checked
 * for us.
 */
async function callTool(page, { name, params, validated, toolId, threadId }) {
	return page.evaluate(async ({ nameArg, paramsArg, validatedArg, idArg, threadIdArg }) => {
		const svc = globalThis.__voidChatThreadService
		const threadId = threadIdArg ?? svc.state.currentThreadId
		const res = await svc._runToolCall(threadId, nameArg, idArg, undefined, {
			preapproved: true,
			unvalidatedToolParams: paramsArg,
			validatedParams: validatedArg ?? paramsArg,
		})
		const row = svc.state.allThreads[threadId].messages.find(m => m.role === 'tool' && m.id === idArg)
		return {
			interrupted: res.interrupted === true,
			rowType: row?.type,
			rowContent: row?.content ?? '',
			rowResult: row?.type === 'success' ? row.result : undefined,
		}
	}, { nameArg: name, paramsArg: params, validatedArg: validated, idArg: toolId, threadIdArg: threadId })
}

/** True while the caret is in a chat textarea — not in xterm's hidden one. */
function focusIsInChatInput(page) {
	return page.evaluate(() => {
		const el = document.activeElement
		return !!el && el.tagName === 'TEXTAREA' && !el.closest('.xterm')
	})
}

describe('terminal tooling', () => {

	test('the prompt names the shell a new command will run in', async (t) => {
		await h.withScenario('terminal-tools/shell', async (s) => {
			const page = s.page
			await h.ensureModelSelection(page)
			await h.stubLLM(page, 'ok')
			await send(page, 'what shell will you use?')
			await h.waitForRunEnd(page)

			const requests = await h.capturedLLMRequests(page)
			const named = /Default shell/i.test(requests)
			const at = requests.indexOf('Open files:')
			t.diagnostic('context: ' + (at < 0 ? 'NO SYSTEM_INFO IN REQUEST' : requests.slice(at, at + 160)))

			assert.ok(
				named,
				'the volatile context never says which shell a command will run in, so the model has to ' +
				'discover PowerShell vs cmd vs wsl by running something and reading the error',
			)
		})
	})

	test('opening and running a persistent command leaves focus in the chat input', async (t) => {
		await h.withScenario('terminal-tools/focus-' + Date.now(), async (s) => {
			const page = s.page


			const focusedBefore = await page.evaluate(() => {
				const chat = [...document.querySelectorAll('textarea')].find(el => !el.closest('.xterm') && el.offsetParent !== null)
				chat?.focus()
				const el = document.activeElement
				return !!el && el.tagName === 'TEXTAREA' && !el.closest('.xterm')
			})
			assert.ok(focusedBefore, 'the fixture could not focus the chat input, so the scenario proves nothing')

			const focusedBeforeTool = await focusIsInChatInput(page)
			t.diagnostic('focus just before open: ' + focusedBeforeTool)
			const opened = await callTool(page, {
				name: 'open_persistent_terminal',
				params: { cwd: null },
				validated: { cwd: null },
				toolId: 'call-open',
			})
			t.diagnostic(`open: ${opened.rowType} ${JSON.stringify(opened.rowResult)}`)
			assert.equal(opened.rowType, 'success', `the terminal did not open: ${opened.rowContent.slice(0, 300)}`)
			const terminalId = opened.rowResult?.persistentTerminalId
			assert.ok(terminalId, 'the tool returned no terminal id')




			const afterOpen = await focusIsInChatInput(page)
			t.diagnostic(`focus in the chat after open: ${afterOpen}`)
			assert.ok(afterOpen, 'opening the terminal moved keyboard focus out of the chat input')

			const ran = await callTool(page, {
				name: 'run_persistent_command',
				params: { command: 'echo focus-probe', persistentTerminalId: terminalId, timeoutSeconds: 8 },
				validated: { command: 'echo focus-probe', persistentTerminalId: terminalId, timeoutSeconds: 8 },
				toolId: 'call-run',
			})
			t.diagnostic(`run: ${ran.rowType} interrupted=${ran.interrupted}`)

			// What the agent reads about this terminal on its next turn. A finished
			// command must leave a state the model can act on: idle, or a running-
			// prefixed line while one executes; unknown tells it nothing about
			// whether the terminal is free.
			await h.ensureModelSelection(page)
			await h.stubLLM(page, 'ok')
			await send(page, 'what terminals do you see?')
			await h.waitForRunEnd(page)
			const reqs = await h.capturedLLMRequests(page)
			const at = reqs.indexOf('- Terminals:')
			const block = at < 0 ? '' : reqs.slice(at, at + 200)
			t.diagnostic('terminals block: ' + (block || 'NOT PRESENT'))
			assert.ok(block, 'the prompt does not list the terminal at all')
			assert.ok(
				!/Void Agent: unknown/.test(block),
				'a terminal that just ran a command is reported as unknown, so the model cannot tell whether it is free',
			)
			const afterRun = await focusIsInChatInput(page)
			t.diagnostic(`focus in the chat after run: ${afterRun}`)
			assert.ok(
				afterRun,
				'running a command moved keyboard focus into the terminal, so a user typing in the chat box ' +
				'loses their caret mid-sentence',
			)
		})
	})

	/**
	 * Completion in a shell VS Code cannot inject shell integration into.
	 *
	 * cmd and wsl never get a CommandDetection capability, so `onCommandFinished`
	 * never fires and a command used to resolve only when the inactivity timeout
	 * expired: an `echo` cost the whole `timeout_seconds` and came back as
	 * unanswered. The tool appends an exit-code marker to the command line
	 * (`& call echo ...` for cmd, `; echo "...:$?"` for a POSIX shell) and
	 * resolves on it, which also gives the terminal a status again.
	 */
	test('a shell without shell integration still reports completion', async (t) => {
		await h.withScenario('terminal-tools/sentinel-' + Date.now(), async (s) => {
			const page = s.page

			const setup = await page.evaluate(async () => {
				const tts = globalThis.__voidChatThreadService._terminalToolService
				const termService = tts.terminalService
				const profileService = termService._terminalProfileService
				await profileService.profilesReady
				const find = (re) => profileService.availableProfiles.find(p => re.test(p.profileName))
				const cmdProfile = find(/^Command Prompt$/)
				if (!cmdProfile) return { error: 'no Command Prompt profile in this build' }
				// WSL profiles come from `wsl.exe -l -q`, which is given one second and
				// times out on a loaded machine. Retry instead of quietly dropping the
				// POSIX subject — a skipped subject proves nothing.
				let wslProfile = find(/\(WSL\)$/)
				for (let attempt = 0; !wslProfile && attempt < 3; attempt++) {
					profileService.refreshAvailableProfiles()
					await new Promise(r => setTimeout(r, 2000))
					wslProfile = find(/\(WSL\)$/)
				}
				const cmd = await termService.createTerminal({ config: cmdProfile })
				const undriven = await termService.createTerminal({ config: cmdProfile })
				const wsl = wslProfile ? await termService.createTerminal({ config: wslProfile }) : undefined
				tts.persistentTerminalInstanceOfId['71'] = cmd
				tts.persistentTerminalInstanceOfId['72'] = undriven
				if (wsl) tts.persistentTerminalInstanceOfId['73'] = wsl
				// Let the shells reach their prompt before the tool writes to them.
				await new Promise(r => setTimeout(r, 4000))
				return {
					hasWsl: !!wsl,
					undriven: tts._getTerminalStatus(undriven),
					cmd: tts._getTerminalStatus(cmd),
				}
			})
			t.diagnostic('setup: ' + JSON.stringify(setup))
			assert.ok(!setup.error, setup.error)

			// Controls: a shell we have never driven has nothing to report, and must
			// keep saying so. They pass whatever the marker does.
			assert.equal(setup.undriven, 'unknown', 'a terminal that has never run a command must not claim a state')
			assert.equal(setup.cmd, 'unknown', 'a fresh cmd terminal has no completion to report either')

			const run = (terminalId, command, timeoutSeconds) => page.evaluate(async ({ id, cmd, timeout }) => {
				const tts = globalThis.__voidChatThreadService._terminalToolService
				const started = Date.now()
				const { resPromise } = await tts.runCommand(cmd, { type: 'persistent', persistentTerminalId: id, timeoutSeconds: timeout })
				const res = await resPromise
				return {
					ms: Date.now() - started,
					reason: res.resolveReason,
					result: String(res.result),
					status: tts._getTerminalStatus(tts.persistentTerminalInstanceOfId[id]),
				}
			}, { id: terminalId, cmd: command, timeout: timeoutSeconds })

			const wanted = h.expectedPersistence()
			const check = async (label, terminalId, timeoutSeconds) => {
				const out = await run(terminalId, 'echo sentinel-probe', timeoutSeconds)
				t.diagnostic(`${label}: ${out.ms}ms reason=${JSON.stringify(out.reason)} status=${out.status} result=${JSON.stringify(out.result.slice(-120))}`)
				// True in both directions: the command's output reached the model and
				// the marker itself did not.
				assert.ok(out.result.includes('sentinel-probe'), `${label}: the output of the command is missing`)
				assert.ok(!out.result.includes('__VOID_DONE_'), `${label}: the completion marker leaked into the result`)
				assert.equal(
					out.reason.type === 'done' && out.status === 'idle',
					wanted,
					`${label}: ${wanted ? 'the command must report completion and leave the terminal idle' : 'with no marker the command can only fall back to the timeout'} (VOID_EXPECT=${process.env.VOID_EXPECT ?? 'present'})`,
				)
			}

			await check('cmd', '71', 8)

			if (setup.hasWsl) await check('wsl', '73', 12)
			else t.diagnostic('wsl: no WSL profile in this build — the cmd subject still covers completion, but not the POSIX marker')
		})
	})
})
