import { generateUuid } from '../../../../../base/common/uuid.js'
import { MAX_TERMINAL_INACTIVE_TIME } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateOptionalStr } from './toolHelpers.js'

const terminalDescHelper = `This tool is for shell commands that aren't available as a dedicated tool. Do NOT use it for: reading files (use \`read_file\`), listing directories (use \`ls_dir\` or \`get_dir_tree\`), finding files by name (use \`search_pathnames_only\`), searching text inside files (use \`search_in_file\` or \`search_for_files\`), or editing files (use \`edit_file\` / \`rewrite_file\`). Use it for commands like \`npm install\`, \`git status\`, \`pytest\`, build commands, or shell operations the dedicated tools don't cover. When working with tools that open an editor (e.g. \`git diff\`), pipe to \`cat\` so the command doesn't get stuck in vim.`

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
			return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
