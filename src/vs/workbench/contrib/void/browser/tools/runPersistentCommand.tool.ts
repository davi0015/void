import { MAX_TERMINAL_BG_COMMAND_TIME } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateProposedTerminalId } from './toolHelpers.js'

const terminalDescHelper = `This tool is for shell commands that aren't available as a dedicated tool. Do NOT use it for: reading files (use \`read_file\`), listing directories (use \`ls_dir\` or \`get_dir_tree\`), finding files by name (use \`search_pathnames_only\`), searching text inside files (use \`search_in_file\` or \`search_for_files\`), or editing files (use \`edit_file\` / \`rewrite_file\`). Use it for commands like \`npm install\`, \`git status\`, \`pytest\`, build commands, or shell operations the dedicated tools don't cover. When working with tools that open an editor (e.g. \`git diff\`), pipe to \`cat\` so the command doesn't get stuck in vim.`

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
			return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
		}
		throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
	},

	title: { done: 'Ran terminal', proposed: 'Run terminal', running: 'Running terminal' },
}
