import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore } from './toolTypes.js'
import { validateNumber } from './toolHelpers.js'

// Addressable by id or by name. The id is what `open_persistent_terminal` hands back and it
// is unique; a name is whatever the terminal displays, and a user can open a terminal with
// the same title. This tool used to take a name only, so the id a caller already held was
// rejected and a shared name silently read the *other* terminal.

export const readTerminalToolCore: ToolDefinitionCore<'read_terminal'> = {
	name: 'read_terminal',
	description: `Reads the scrollback buffer of a terminal (Void or user-created). Returns the terminal output, current status (idle/running/exited), and command history with exit codes. Use this to check on a persistent terminal after a timeout, inspect a dev server's logs, or see output from a user-created terminal.

Address it with \`terminal_id\` when you created it with \`open_persistent_terminal\` - that call returns the id, and the id is unique. Use \`terminal_name\` for a terminal you did not create (the names are listed in the system info under "Terminals"); a name that several terminals share is refused rather than guessed, and the error tells you to use the id. Pass \`last_n_commands\` to retrieve output from only the last N commands (useful when the full buffer is too long or truncated). This is the follow-up when \`run_persistent_command\` reports a command is still running - re-call it to check completion; never run sleep/wait commands to wait.`,
	params: {
		terminal_id: { description: 'The id of a persistent terminal, as returned by `open_persistent_terminal` (e.g. "2"). Prefer this when you have it: it cannot be ambiguous.' },
		terminal_name: { description: 'The display name of a terminal, as shown in the system info under "Terminals". Refused if more than one terminal has that name.' },
		last_n_commands: { description: 'Optional. If provided, returns only the output of the last N commands (e.g. 1 for just the most recent command, 3 for the last three). Omit to get the full scrollback buffer and full command history.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj) => {
		const terminalId = typeof raw.terminal_id === 'string' && raw.terminal_id.trim() ? raw.terminal_id.trim() : undefined
		const terminalName = typeof raw.terminal_name === 'string' && raw.terminal_name.trim() ? raw.terminal_name.trim() : undefined
		if (!terminalId && !terminalName) {
			throw new Error('read_terminal needs terminal_id (the id open_persistent_terminal returned) or terminal_name (a name from the system info under "Terminals").')
		}
		const lastNCommands = validateNumber(raw.last_n_commands, { default: null })
		return { terminalId, terminalName, lastNCommands }
	},

	callTool: async ({ terminalId, terminalName, lastNCommands }, ctx) => {
		const result = await ctx.terminalToolService.readTerminalByHandle({ terminalId, terminalName }, lastNCommands)
		return { result }
	},

	stringOfResult: (params, result) => {
		const { output, status, commands } = result
		const label = params.terminalId !== undefined ? `id ${params.terminalId}` : `"${params.terminalName}"`
		let str = `Terminal: ${label}\nStatus: ${status}`
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