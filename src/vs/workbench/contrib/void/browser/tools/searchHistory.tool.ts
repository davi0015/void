import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import type { ChatMessage } from '../../common/chatThreadServiceTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateNumber, isFalsy } from './toolHelpers.js'

export const searchHistoryToolCore: ToolDefinitionCore<'search_history'> = {
	name: 'search_history',
	description: `Searches the current conversation history for messages matching a text query and/or structured filters. Returns matching messages with surrounding context. Use this when the user asks about something that happened earlier in the conversation, when you need to recall a previous tool call, or when you want to find past errors or results.`,
	params: {
		query: { description: `Text to search for across all message content (user messages, assistant messages, tool params, and tool results). Case-insensitive. Pass null to skip text filtering.` },
		tool_name: { description: `Filter to only return tool calls with this name (e.g. "run_command", "edit_file"). Pass null to include all message types.` },
		result_status: { description: `Filter tool calls by result status: "error" for failed tool calls, "success" for successful ones. Pass null to include all.` },
		context_radius: { description: `Number of messages before and after each match to include for context. Default is 3.` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { query: queryUnknown, tool_name: toolNameUnknown, result_status: resultStatusUnknown, context_radius: contextRadiusUnknown } = raw
		const query = isFalsy(queryUnknown) ? null : validateStr('query', queryUnknown)
		const toolName = isFalsy(toolNameUnknown) ? null : validateStr('toolName', toolNameUnknown)
		const resultStatus = isFalsy(resultStatusUnknown) ? null : (resultStatusUnknown === 'error' || resultStatusUnknown === 'success' ? resultStatusUnknown : null) as 'error' | 'success' | null
		const contextRadiusRaw = validateNumber(contextRadiusUnknown, { default: 3 })
		const contextRadius = Math.max(1, Math.min(contextRadiusRaw ?? 3, 10))
		return { query, toolName, resultStatus, contextRadius }
	},

	callTool: async ({ query, toolName, resultStatus, contextRadius }, ctx) => {
		const { IChatThreadService } = await import('../chatThreadService.js')
		const chatThreadService = ctx.instantiationService.invokeFunction(accessor => accessor.get(IChatThreadService))
		const thread = chatThreadService.getCurrentThread()
		if (!thread) {
			return { result: { matches: 'No active conversation thread.', totalMatches: 0 } }
		}
		const messages = thread.messages
		const queryLower = query?.toLowerCase() ?? null

		// Find matching message indices
		const matchIndices: number[] = []

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]

			// Filter by tool_name
			if (toolName && msg.role !== 'tool') continue
			if (toolName && msg.role === 'tool' && msg.name !== toolName) continue

			// Filter by result_status
			if (resultStatus && msg.role !== 'tool') continue
			if (resultStatus && msg.role === 'tool') {
				if (resultStatus === 'error' && msg.type !== 'tool_error') continue
				if (resultStatus === 'success' && msg.type !== 'success') continue
			}

			// Text search
			if (queryLower) {
				let textToSearch = ''
				if (msg.role === 'user') textToSearch = (msg.content ?? '') + ' ' + (msg.displayContent ?? '')
				else if (msg.role === 'assistant') textToSearch = (msg.displayContent ?? '') + ' ' + (msg.reasoning ?? '')
				else if (msg.role === 'tool') {
					textToSearch = (msg.content ?? '')
						+ ' ' + JSON.stringify(msg.rawParams ?? {})
						+ ' ' + (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? {}))
				}

				if (!textToSearch.toLowerCase().includes(queryLower)) continue
			}

			// If no filters at all, skip (don't return everything)
			if (!queryLower && !toolName && !resultStatus) continue

			matchIndices.push(i)
		}

		if (matchIndices.length === 0) {
			return { result: { matches: 'No matching messages found.', totalMatches: 0 } }
		}

		// Build context windows around matches, merging overlapping ranges
		const maxMatches = 20
		const limitedIndices = matchIndices.slice(0, maxMatches)

		// Collect unique message indices to include
		const includeIndices = new Set<number>()
		for (const idx of limitedIndices) {
			for (let j = Math.max(0, idx - contextRadius); j <= Math.min(messages.length - 1, idx + contextRadius); j++) {
				includeIndices.add(j)
			}
		}

		// Format messages
		const formatMessage = (msg: ChatMessage, idx: number): string => {
			const prefix = `[${idx}]`
			if (msg.role === 'user') {
				return `${prefix} [USER]: ${(msg.displayContent || msg.content || '(empty)').slice(0, 500)}`
			} else if (msg.role === 'assistant') {
				const content = msg.displayContent || msg.reasoning || '(empty)'
				const reasoning = (!msg.displayContent && msg.reasoning) ? '' : msg.reasoning ? `\n  Reasoning: ${msg.reasoning.slice(0, 300)}` : ''
				return `${prefix} [ASSISTANT]: ${content.slice(0, 500)}${reasoning}`
			} else if (msg.role === 'tool') {
				const paramsStr = JSON.stringify(msg.rawParams ?? {}).slice(0, 300)
				const resultStr = ('result' in msg ? (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? {})) : '(no result yet)').slice(0, 500)
				return `${prefix} [TOOL:${msg.name} type=${msg.type}]: params=${paramsStr}\n  result=${resultStr}`
			} else if (msg.role === 'interrupted_streaming_tool') {
				return `${prefix} [INTERRUPTED:${msg.name}]`
			} else {
				return `${prefix} [UNKNOWN]`
			}
		}

		const sortedIndices = Array.from(includeIndices).sort((a, b) => a - b)
		const formattedLines = sortedIndices.map(idx => formatMessage(messages[idx], idx))
		const matches = formattedLines.join('\n\n')

		return { result: { matches, totalMatches: matchIndices.length } }
	},

	stringOfResult: (_params, result) => {
		const totalStr = result.totalMatches > 20 ? ` (showing first 20 of ${result.totalMatches})` : ''
		return `Found ${result.totalMatches} matching message(s)${totalStr}:\n\n${result.matches}`
	},

	title: { done: 'Searched history', proposed: 'Search history', running: 'Searching history' },
}
