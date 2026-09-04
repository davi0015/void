import { generateUuid } from '../../../../../base/common/uuid.js'
import { DEFAULT_TERMINAL_TIMEOUT_SECONDS, MAX_TERMINAL_TIMEOUT_SECONDS } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateOptionalStr, validateTimeoutSeconds } from './toolHelpers.js'

const terminalDescHelper =
	'Shell commands not covered by dedicated tools (e.g. `npm install`, `git status`, `pytest`).' +
	' Do NOT use for: reading files, listing directories, finding files, searching text, or editing files.' +
	' Avoid interactive commands that wait for input (pagers, editors, REPLs, y/n prompts).' +
	' Pipe pagers to `cat` (e.g. `git diff | cat`). If a command hangs, it may be waiting for input.'

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

const timeoutHelper =
	`Optional. Inactivity timeout in whole seconds — the command is killed after this long with no new output. Defaults to ${DEFAULT_TERMINAL_TIMEOUT_SECONDS}. ` +
	`Raise it (up to ${MAX_TERMINAL_TIMEOUT_SECONDS}) only for commands that legitimately run long with sparse output (installs, builds, test suites). ` +
	`Do not raise it when a command seems stuck: silence usually means it is waiting for input, and it will still be killed at the timeout.`

export const runCommandToolCore: ToolDefinitionCore<'run_command'> = {
	name: 'run_command',
	description: `Runs a terminal command and waits for the result (kills the command after \`timeout_seconds\` with no output — defaults to ${DEFAULT_TERMINAL_TIMEOUT_SECONDS}s). ${terminalDescHelper}`,
	params: {
		command: { description: 'The terminal command to run.' },
		cwd: { description: cwdHelper },
		timeout_seconds: { description: timeoutHelper },
	},
	approvalType: 'terminal',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { command: commandUnknown, cwd: cwdUnknown, timeout_seconds: timeoutSecondsUnknown } = raw
		const command = validateStr('command', commandUnknown)
		const cwd = validateOptionalStr('cwd', cwdUnknown)
		const timeoutSeconds = validateTimeoutSeconds(timeoutSecondsUnknown, DEFAULT_TERMINAL_TIMEOUT_SECONDS)
		const terminalId = generateUuid()
		return { command, cwd, terminalId, timeoutSeconds }
	},

	callTool: async ({ command, cwd, terminalId, timeoutSeconds }, ctx) => {
		const { resPromise, interrupt } = await ctx.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId, timeoutSeconds })
		return { result: resPromise, interruptTool: interrupt }
	},

	stringOfResult: (params, result) => {
		const { resolveReason, result: result_, } = result
		const { timeoutSeconds } = params
		// success
		if (resolveReason.type === 'done') {
			return `${result_}\n(exit code ${resolveReason.exitCode})`
		}
		// normal command
		if (resolveReason.type === 'timeout') {
			if (resolveReason.reason === 'inactivity') {
				return `${result_}\nCommand timed out after ${timeoutSeconds}s of no output. It may be waiting for input (e.g. a pager, y/n prompt). The terminal was killed. To try with more time, pass a larger \`timeout_seconds\` (up to ${MAX_TERMINAL_TIMEOUT_SECONDS}s), or open a persistent terminal and run the command there.`
			}
			return `${result_}\nCommand timed out after ${timeoutSeconds}s. The terminal was killed.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
