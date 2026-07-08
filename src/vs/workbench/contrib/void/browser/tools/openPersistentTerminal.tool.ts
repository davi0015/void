import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateOptionalStr } from './toolHelpers.js'

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

export const openPersistentTerminalToolCore: ToolDefinitionCore<'open_persistent_terminal'> = {
	name: 'open_persistent_terminal',
	description: `Use this tool when you want to run a terminal command indefinitely, like a dev server (eg \`npm run dev\`), a background listener, etc. Opens a new terminal in the user's environment which will not awaited for or killed.`,
	params: {
		cwd: { description: cwdHelper },
	},
	approvalType: 'terminal',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { cwd: cwdUnknown } = raw
		const cwd = validateOptionalStr('cwd', cwdUnknown)
		return { cwd }
	},

	callTool: async ({ cwd }, ctx) => {
		const persistentTerminalId = await ctx.terminalToolService.createPersistentTerminal({ cwd })
		return { result: { persistentTerminalId } }
	},

	stringOfResult: (_params, result) => {
		const { persistentTerminalId } = result
		return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`
	},

	title: { done: 'Opened terminal', proposed: 'Open terminal', running: 'Opening terminal' },
}
