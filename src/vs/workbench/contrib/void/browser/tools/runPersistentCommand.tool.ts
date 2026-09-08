import { MAX_TERMINAL_TIMEOUT_SECONDS } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateProposedTerminalId, validateTimeoutSeconds } from './toolHelpers.js'

const terminalDescHelper =
	'Shell commands not covered by dedicated tools (e.g. `npm install`, `git status`, `pytest`).' +
	' Do NOT use for: reading files, listing directories, finding files, searching text, editing files, or moving/renaming/deleting files or folders — use the dedicated tools instead (pending diffs and review UI only follow file-service moves, not shell `mv`/`rm`).' +
	' Avoid interactive commands that wait for input (pagers, editors, REPLs, y/n prompts).' +
	' Pipe pagers to `cat` (e.g. `git diff | cat`). If a command hangs, it may be waiting for input.'

const timeoutHelper =
	`Optional. Seconds to wait for the command to finish — defaults to ${MAX_TERMINAL_TIMEOUT_SECONDS} (waits for completion). ` +
	`Pass a smaller value for commands that never exit (dev servers, watch mode) or to stop waiting early: results return after that long with no new output while the command keeps running in the background. ` +
	`Silence usually means the command is waiting for input — avoid interactive commands (see below).`

export const runPersistentCommandToolCore: ToolDefinitionCore<'run_persistent_command'> = {
	name: 'run_persistent_command',
	description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal. Waits until the command finishes (up to ${MAX_TERMINAL_TIMEOUT_SECONDS}s). For commands that never exit (dev servers, watch mode), pass a small \`timeout_seconds\` (e.g. 30) to return early while it keeps running in the background. If the result says the command is still running, check on it later with read_terminal (no sleep/wait commands — they change nothing and only waste a step). ${terminalDescHelper}`,
	params: {
		command: { description: 'The terminal command to run.' },
		persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.' },
		timeout_seconds: { description: timeoutHelper },
	},
	approvalType: 'terminal',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown, timeout_seconds: timeoutSecondsUnknown } = raw
		const command = validateStr('command', commandUnknown)
		const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
		const timeoutSeconds = validateTimeoutSeconds(timeoutSecondsUnknown, MAX_TERMINAL_TIMEOUT_SECONDS)
		return { command, persistentTerminalId, timeoutSeconds }
	},

	callTool: async ({ command, persistentTerminalId, timeoutSeconds }, ctx) => {
		const { resPromise, interrupt } = await ctx.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId, timeoutSeconds })
		return { result: resPromise, interruptTool: interrupt }
	},

	stringOfResult: (params, result) => {
		const { resolveReason, result: result_, } = result
		const { persistentTerminalId, timeoutSeconds } = params
		// success
		if (resolveReason.type === 'done') {
			return `${result_}\n(exit code ${resolveReason.exitCode})`
		}
		// bg command
		if (resolveReason.type === 'timeout') {
			if (resolveReason.reason === 'inactivity') {
				return `${result_}\nCommand timed out after ${timeoutSeconds}s of no output. It may be waiting for input (e.g. a pager, y/n prompt). The command keeps running in terminal ${persistentTerminalId} — check it later with read_terminal. Do NOT run sleep or any wait command to wait for it.`
			}
			// The backstop is a fixed total-wait cap (see terminalToolService),
			// independent of the silence window.
			return `${result_}\nCommand is still running after the maximum wait (${MAX_TERMINAL_TIMEOUT_SECONDS}s). The command keeps running in terminal ${persistentTerminalId} — check it later with read_terminal. Do NOT run sleep or any wait command to wait for it.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
