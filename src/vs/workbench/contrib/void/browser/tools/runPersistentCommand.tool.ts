import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_TIMEOUT_SECONDS } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateProposedTerminalId, validateTimeoutSeconds } from './toolHelpers.js'

const terminalDescHelper =
	'Shell commands not covered by dedicated tools (e.g. `npm install`, `git status`, `pytest`).' +
	' Do NOT use for: reading files, listing directories, finding files, searching text, or editing files.' +
	' Avoid interactive commands that wait for input (pagers, editors, REPLs, y/n prompts).' +
	' Pipe pagers to `cat` (e.g. `git diff | cat`). If a command hangs, it may be waiting for input.'

const timeoutHelper =
	`Optional. Inactivity timeout in whole seconds — results are returned after this long with no new output, while the command keeps running in the background. Defaults to ${MAX_TERMINAL_BG_COMMAND_TIME}. ` +
	`Raise it (up to ${MAX_TERMINAL_TIMEOUT_SECONDS}) when waiting on a long-running command. ` +
	`Do not raise it when a command seems stuck: silence usually means it is waiting for input.`

export const runPersistentCommandToolCore: ToolDefinitionCore<'run_persistent_command'> = {
	name: 'run_persistent_command',
	description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (returns results after \`timeout_seconds\` with no output — defaults to ${MAX_TERMINAL_BG_COMMAND_TIME}s — and the command keeps running in the background). ${terminalDescHelper}`,
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
		const timeoutSeconds = validateTimeoutSeconds(timeoutSecondsUnknown, MAX_TERMINAL_BG_COMMAND_TIME)
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
				return `${result_}\nCommand timed out after ${timeoutSeconds}s of no output. It may be waiting for input (e.g. a pager, y/n prompt). The terminal is still running in terminal ${persistentTerminalId}.`
			}
			// The backstop fires at 2x the inactivity timeout (see
			// terminalToolService) — reflect that here so the LLM knows the
			// actual maximum wait, not just the quiet window.
			return `${result_}\nCommand is still running and producing output after ${timeoutSeconds * 2}s. The terminal is still running in terminal ${persistentTerminalId}.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
