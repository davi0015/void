import { MAX_TERMINAL_BG_COMMAND_TIME } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateProposedTerminalId } from './toolHelpers.js'

const terminalDescHelper =
	'Shell commands not covered by dedicated tools (e.g. `npm install`, `git status`, `pytest`).' +
	' Do NOT use for: reading files, listing directories, finding files, searching text, or editing files.' +
	' Avoid interactive commands that wait for input (pagers, editors, REPLs, y/n prompts).' +
	' Pipe pagers to `cat` (e.g. `git diff | cat`). If a command hangs, it may be waiting for input.'

export const runPersistentCommandToolCore: ToolDefinitionCore<'run_persistent_command'> = {
	name: 'run_persistent_command',
	description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after ${MAX_TERMINAL_BG_COMMAND_TIME} are returned, and command continues running in background). ${terminalDescHelper}`,
	params: {
		command: { description: 'The terminal command to run.' },
		persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.' },
	},
	approvalType: 'terminal',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = raw
		const command = validateStr('command', commandUnknown)
		const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
		return { command, persistentTerminalId }
	},

	callTool: async ({ command, persistentTerminalId }, ctx) => {
		const { resPromise, interrupt } = await ctx.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
		return { result: resPromise, interruptTool: interrupt }
	},

	stringOfResult: (params, result) => {
		const { resolveReason, result: result_, } = result
		const { persistentTerminalId } = params
		// success
		if (resolveReason.type === 'done') {
			return `${result_}\n(exit code ${resolveReason.exitCode})`
		}
		// bg command
		if (resolveReason.type === 'timeout') {
			if (resolveReason.reason === 'inactivity') {
				return `${result_}\nCommand timed out after ${MAX_TERMINAL_BG_COMMAND_TIME}s of no output. It may be waiting for input (e.g. a pager, y/n prompt). The terminal is still running in terminal ${persistentTerminalId}.`
			}
			return `${result_}\nCommand is still running and producing output after ${MAX_TERMINAL_BG_COMMAND_TIME}s. The terminal is still running in terminal ${persistentTerminalId}.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
