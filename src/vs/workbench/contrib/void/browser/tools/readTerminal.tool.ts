import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr } from './toolHelpers.js'

export const readTerminalToolCore: ToolDefinitionCore<'read_terminal'> = {
	name: 'read_terminal',
	description: `Reads the scrollback buffer of any terminal (Void or user-created). Returns the terminal output, current status (idle/running/exited), and command history with exit codes. Use this to check on a persistent terminal after a timeout, inspect a dev server's logs, or see output from a user-created terminal. The terminal names are shown in the system info under "Terminals".`,
	params: {
		terminal_name: { description: 'The name of the terminal to read, as shown in the system info under "Terminals".' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { terminal_name: terminalNameUnknown } = raw
		const terminalName = validateStr('terminal_name', terminalNameUnknown)
		return { terminalName }
	},

	callTool: async ({ terminalName }, ctx) => {
		const result = await ctx.terminalToolService.readTerminalByName(terminalName)
		return { result }
	},

	stringOfResult: (params, result) => {
		const { output, status, commands } = result
		let str = `Terminal: ${params.terminalName}\nStatus: ${status}`
		if (commands.length > 0) {
			str += `\nCommand history:`
			for (const cmd of commands) {
				const exitStr = cmd.exitCode === null ? '(running)' : `(exit ${cmd.exitCode})`
				str += `\n  - ${cmd.command} ${exitStr} ${cmd.duration}ms`
			}
		}
		str += `\n\nOutput:\n${output}`
		return str
	},

	title: { done: 'Read terminal', proposed: 'Read terminal', running: 'Reading terminal' },
}
