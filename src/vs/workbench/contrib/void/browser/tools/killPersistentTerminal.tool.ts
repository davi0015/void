import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateProposedTerminalId } from './toolHelpers.js'

export const killPersistentTerminalToolCore: ToolDefinitionCore<'kill_persistent_terminal'> = {
	name: 'kill_persistent_terminal',
	description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
	params: {
		persistent_terminal_id: { description: `The ID of the persistent terminal.` },
	},
	approvalType: 'terminal',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { persistent_terminal_id: terminalIdUnknown } = raw
		const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown)
		return { persistentTerminalId }
	},

	callTool: async ({ persistentTerminalId }, ctx) => {
		await ctx.terminalToolService.killPersistentTerminal(persistentTerminalId)
		return { result: {} }
	},

	stringOfResult: (params, _result) => {
		return `Successfully closed terminal "${params.persistentTerminalId}".`
	},

	title: { done: 'Killed terminal', proposed: 'Kill terminal', running: 'Killing terminal' },
}
