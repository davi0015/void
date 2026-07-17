import { generateUuid } from '../../../../../base/common/uuid.js'
import { MAX_TERMINAL_INACTIVE_TIME } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateOptionalStr } from './toolHelpers.js'

const terminalDescHelper =
	'Shell commands not covered by dedicated tools (e.g. `npm install`, `git status`, `pytest`).' +
	' Do NOT use for: reading files, listing directories, finding files, searching text, or editing files.' +
	' Avoid interactive commands that wait for input (pagers, editors, REPLs, y/n prompts).' +
	' Pipe pagers to `cat` (e.g. `git diff | cat`). If a command hangs, it may be waiting for input.'

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

export const runCommandToolCore: ToolDefinitionCore<'run_command'> = {
	name: 'run_command',
	description: `Runs a terminal command and waits for the result (times out after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity). ${terminalDescHelper}`,
	params: {
		command: { description: 'The terminal command to run.' },
		cwd: { description: cwdHelper },
	},
	approvalType: 'terminal',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { command: commandUnknown, cwd: cwdUnknown } = raw
		const command = validateStr('command', commandUnknown)
		const cwd = validateOptionalStr('cwd', cwdUnknown)
		const terminalId = generateUuid()
		return { command, cwd, terminalId }
	},

	callTool: async ({ command, cwd, terminalId }, ctx) => {
		const { resPromise, interrupt } = await ctx.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
		return { result: resPromise, interruptTool: interrupt }
	},

	stringOfResult: (_params, result) => {
		const { resolveReason, result: result_, } = result
		// success
		if (resolveReason.type === 'done') {
			return `${result_}\n(exit code ${resolveReason.exitCode})`
		}
		// normal command
		if (resolveReason.type === 'timeout') {
			if (resolveReason.reason === 'inactivity') {
				return `${result_}\nCommand timed out after ${MAX_TERMINAL_INACTIVE_TIME}s of no output. It may be waiting for input (e.g. a pager, y/n prompt). The terminal was killed. To try with more time, open a persistent terminal and run the command there.`
			}
			return `${result_}\nCommand timed out after ${MAX_TERMINAL_INACTIVE_TIME}s. The terminal was killed.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
