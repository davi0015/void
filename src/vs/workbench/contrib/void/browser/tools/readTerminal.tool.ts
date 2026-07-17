import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateNumber } from './toolHelpers.js'

export const readTerminalToolCore: ToolDefinitionCore<'read_terminal'> = {
	name: 'read_terminal',
	description: `Reads the scrollback buffer of any terminal (Void or user-created). Returns the terminal output, current status (idle/running/exited), and command history with exit codes. Use this to check on a persistent terminal after a timeout, inspect a dev server's logs, or see output from a user-created terminal. The terminal names are shown in the system info under "Terminals". Pass last_n_commands to retrieve output from only the last N commands (useful when the full buffer is too long or truncated).`,
	params: {
		terminal_name: { description: 'The name of the terminal to read, as shown in the system info under "Terminals".' },
		last_n_commands: { description: 'Optional. If provided, returns only the output of the last N commands (e.g. 1 for just the most recent command, 3 for the last three). Omit to get the full scrollback buffer and full command history.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { terminal_name: terminalNameUnknown, last_n_commands: lastNCommandsUnknown } = raw
		const terminalName = validateStr('terminal_name', terminalNameUnknown)
		const lastNCommands = validateNumber(lastNCommandsUnknown, { default: null })
		return { terminalName, lastNCommands }
	},

	callTool: async ({ terminalName, lastNCommands }, ctx) => {
		const result = await ctx.terminalToolService.readTerminalByName(terminalName, lastNCommands)
		return { result }
	},

	stringOfResult: (params, result) => {
		const { output, status, commands } = result
		let str = `Terminal: ${params.terminalName}\nStatus: ${status}`
		if (commands.length > 0) {
			str += `\nCommand history:`
			for (let i = 0; i < commands.length; i++) {
				const cmd = commands[i]
				const exitStr = cmd.exitCode === null ? '(running)' : `(exit ${cmd.exitCode})`
				str += `\n  - ${cmd.command} ${exitStr} ${cmd.duration}ms`
			}
		}
		str += `\n\nOutput:\n${output}`
		return str
	},

	title: { done: 'Read terminal', proposed: 'Read terminal', running: 'Reading terminal' },
}
