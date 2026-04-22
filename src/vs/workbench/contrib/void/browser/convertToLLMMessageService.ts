import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage, chat_volatileContext } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';

export const EMPTY_MESSAGE = '(empty message)'



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
	// Original serialized arguments string from the model's tool call (OpenAI-compat
	// only). When present, used verbatim on replay to keep the provider's prefix cache
	// matching across turns. Falls back to JSON.stringify(rawParams) when absent.
	rawParamsStr?: string;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120


// ======================================================================================
// Perf 2 — Light-tier history compaction
// ======================================================================================
//
// Bodies of old data-fetching tool results (read_file / grep / ls_dir / run_command / …)
// are the single biggest source of request bloat in long agent threads. We trim those
// bodies in-place on the outgoing simple-message array *before* provider-specific
// conversion runs — keeping the tool_call envelope intact (so tool_call_id linking
// stays valid on replay) but replacing the big middle with a short header + first/last
// slice so the model can still orient without carrying full file contents forward.
//
// Design notes:
//   - Only applied to the chat flow (`prepareLLMChatMessages`), not to `prepareLLMSimpleMessages`
//     (autocomplete / apply / rewrite) which don't accumulate tool-call history.
//   - Never mutates the stored on-disk `ChatMessage[]` — operates on the in-memory
//     SimpleLLMMessage[] copy; the UI always shows the original content.
//   - Write-side tools (edit_file / rewrite_file / create / delete) are NOT trimmed:
//     their results are small event records, and they're important for continuity.
//   - MCP tools are NOT trimmed (unknown semantics; safer to leave alone until we have
//     per-server whitelisting).
//   - Two-trigger design:
//       Gate 0 (size): skip entirely on small requests — the cache-break cost from
//       trimming isn't worth it until the request is large enough that request-size
//       reduction actually matters. Tied to `contextWindow * sizeTriggerRatio`.
//       Gate 1 (structural): compute a protection boundary as the larger of
//       "last N user turns" and "last N messages". The message-count fallback is
//       critical for agent-mode threads (single user message, long tool burst)
//       where user-turn protection alone would protect nothing.
//
// See Perf 2 entry in mynote.md for the full rationale and deferred Heavy-tier plan.

const TRIMMABLE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_pathnames_only',
	'search_for_files',
	'search_in_file',
	'read_lint_errors',
	'run_command',
	'run_persistent_command',
])

const COMPACTION_POLICY = {
	// --- When compaction runs at all -----------------------------------------------
	// Size gate — skip compaction entirely on small/medium requests. Expressed as a
	// fraction of the model's context window (converted to chars via CHARS_PER_TOKEN).
	// Rationale: trimming breaks the provider's prefix cache at the trim point, so on
	// short threads where the cache is working well and we're nowhere near the cliff,
	// the rebuild cost outweighs the token savings. Only pay that cost once the thread
	// is big enough that reducing request size actually matters. 0.5 == "kick in once
	// roughly half the context is used" — stays well clear of MiniMax's 160k cache
	// cliff on a ~250k model while preserving the common-case fast path on short chats.
	sizeTriggerRatio: 0.5,

	// --- Protection zone (what we keep full-fidelity) ------------------------------
	// Two independent protections; the larger (more inclusive) one wins. Combined,
	// they correctly handle both chat-heavy threads (many user turns) AND agent-mode
	// threads (a single user message followed by long tool bursts).
	//
	//   protectRecentTurns    — last N user-message boundaries; the "conversation"
	//                           working memory on chat-style threads.
	//   protectLastMessages   — last N total messages regardless of role; the
	//                           "in-progress agent burst" safety net. Critical for
	//                           single-user agent flows where `protectRecentTurns`
	//                           alone would leave the entire history trimmable.
	protectRecentTurns: 5,
	protectLastMessages: 30,

	// --- Trim shape (per message) --------------------------------------------------
	// When a tool body is trimmed, keep this many lines from the start (imports /
	// top-of-file context) and the end (exports / last-modified region). Tuned so
	// a typical source file still gives the model enough shape to orient.
	keepFirstLines: 30,
	keepLastLines: 10,

	// --- Per-message eligibility ---------------------------------------------------
	// Don't bother trimming bodies smaller than BOTH thresholds — the saved tokens
	// don't justify the extra bytes the marker itself costs. These gates keep short
	// `ls_dir`, single-line `grep`, and tiny file reads fully intact.
	minBodyLinesToTrim: 60,
	minBodyCharsToTrim: 2_000,
} as const

// Pick a short, model-useful label for the trim header (e.g. `read_file src/foo.ts`).
// Falls back to just the tool name when no obvious identifying param exists.
const _labelForTrimHeader = (toolName: string, rawParams: RawToolParamsObj | undefined): string => {
	if (!rawParams) return toolName
	const rp = rawParams as { [k: string]: unknown }
	const candidate =
		(typeof rp.uri === 'string' && rp.uri) ||
		(typeof rp.path === 'string' && rp.path) ||
		(typeof rp.pattern === 'string' && rp.pattern) ||
		(typeof rp.query === 'string' && rp.query) ||
		(typeof rp.command === 'string' && rp.command) ||
		''
	return candidate ? `${toolName} ${candidate}` : toolName
}

// Total content-char count for the request, used by the size gate.
const _totalContentChars = (messages: SimpleLLMMessage[]): number => {
	let total = 0
	for (const m of messages) total += m.content?.length ?? 0
	return total
}

// Protection boundary: any message at index < boundary is trim-eligible (subject to
// role/name/size checks); any message at index >= boundary is kept full-fidelity.
// We compute two boundaries and return the MORE trim-eligible (larger index) one,
// so both chat-style and agent-style threads are protected correctly.
const _computeProtectionBoundary = (messages: SimpleLLMMessage[]): number => {
	// 1) "Last N user turns" — walk back from the end, stop once we've seen N user
	//    messages; the index of the N-th is the user-turn boundary.
	let userCount = 0
	let userTurnBoundary = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			userCount++
			if (userCount >= COMPACTION_POLICY.protectRecentTurns) {
				userTurnBoundary = i
				break
			}
		}
	}
	// Fewer than N user messages in the whole thread → fallback to 0 (no user-turn
	// protection) and let the message-count policy below carry the weight. This is
	// the case that was silently broken before: single-user agent-mode threads.
	if (userCount < COMPACTION_POLICY.protectRecentTurns) userTurnBoundary = 0

	// 2) "Last N messages" — simple index-based protection. Critical for single-user
	//    agent bursts where the user-turn policy alone would protect nothing.
	const messageCountBoundary = Math.max(0, messages.length - COMPACTION_POLICY.protectLastMessages)

	// Take the LARGER (more trim-eligible) — whichever policy wants to protect less
	// of the tail is the binding one for this request.
	return Math.max(userTurnBoundary, messageCountBoundary)
}

// Returns a new array with old, trimmable tool bodies replaced by a short trim marker.
// Pure function — does not mutate the input.
const compactToolResultsForRequest = (
	messages: SimpleLLMMessage[],
	{ contextWindow }: { contextWindow: number },
): SimpleLLMMessage[] => {
	// Gate 0 — size-based. Don't trim anything on small requests; the cache break
	// cost would outweigh the savings. Trigger is expressed as a fraction of the
	// model's context window, converted to chars via the same CHARS_PER_TOKEN ratio
	// the emergency trim uses (so both policies reason in a consistent unit).
	const sizeTriggerChars = contextWindow * CHARS_PER_TOKEN * COMPACTION_POLICY.sizeTriggerRatio
	const totalChars = _totalContentChars(messages)
	if (totalChars < sizeTriggerChars) return messages

	// Gate 1 — structural. Compute the protection boundary (larger of the two
	// policies, see `_computeProtectionBoundary`). If nothing sits before the
	// boundary, there's nothing to trim.
	const boundaryIdx = _computeProtectionBoundary(messages)
	if (boundaryIdx <= 0) return messages

	let trimmed = 0
	const out = messages.map((m, idx): SimpleLLMMessage => {
		if (idx >= boundaryIdx) return m
		if (m.role !== 'tool') return m
		if (!TRIMMABLE_TOOL_NAMES.has(m.name)) return m
		const body = m.content
		if (!body) return m

		const lines = body.split('\n')
		if (lines.length < COMPACTION_POLICY.minBodyLinesToTrim && body.length < COMPACTION_POLICY.minBodyCharsToTrim) return m

		const head = lines.slice(0, COMPACTION_POLICY.keepFirstLines).join('\n')
		const tail = lines.slice(-COMPACTION_POLICY.keepLastLines).join('\n')
		const label = _labelForTrimHeader(m.name, m.rawParams)
		const newContent = `[trimmed — ${label}, originally ${lines.length} lines / ${body.length} chars. Re-run the tool if you need the full content.]
First ${COMPACTION_POLICY.keepFirstLines} lines:
${head}
... (content trimmed) ...
Last ${COMPACTION_POLICY.keepLastLines} lines:
${tail}`
		trimmed++
		return { ...m, content: newContent }
	})

	// Best-effort diagnostics so the user can see compaction firing in the dev console
	// when they're tuning thresholds. Guarded behind a tiny counter so we don't spam
	// on turns where nothing was trimmed.
	if (trimmed > 0) {
		try {
			const totalCharsAfter = _totalContentChars(out)
			const savedChars = totalChars - totalCharsAfter
			console.log(`[void compaction] trimmed ${trimmed} stale tool result(s); saved ~${savedChars.toLocaleString()} chars (~${Math.round(savedChars / CHARS_PER_TOKEN).toLocaleString()} tokens); boundary=${boundaryIdx}/${messages.length}`)
		} catch { }
	}
	return out
}




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// Walk back through newMessages to find the assistant that called this tool. For a
		// solo tool this is always the immediately-prior message; for a batched response
		// (N parallel tool calls) we need to append to the same assistant across N tool
		// messages — the previous implementation overwrote tool_calls each time and only
		// the LAST tool in a batch survived, corrupting replay bytes + the provider's cache.
		let assistantIdx = -1
		for (let j = newMessages.length - 1; j >= 0; j--) {
			const m = newMessages[j]
			if (m.role === 'assistant') { assistantIdx = j; break }
			// Stop at any non-tool, non-assistant message (should never happen since we only
			// push assistant/tool/user through here in order, but keep the safety rail).
			if (m.role !== 'tool') break
		}
		if (assistantIdx >= 0) {
			const asstMsg = newMessages[assistantIdx] as OpenAILLMChatMessage & { role: 'assistant' }
			// Prefer the model's original serialized argument string when we have it
			// (OpenAI-compatible providers expose it in the streaming delta). Sending
			// byte-identical bytes back preserves the provider's prefix cache past the
			// tool call. Fall back to re-serializing when the raw string is unavailable
			// (e.g. conversations from before this field existed, or non-OpenAI provenance).
			const newCall = {
				type: 'function' as const,
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: currMsg.rawParamsStr ?? JSON.stringify(currMsg.rawParams)
				}
			}
			asstMsg.tool_calls = [...(asstMsg.tool_calls ?? []), newCall]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				}
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages[i] = {
				role: 'user',
				content: currMsg.content,
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// Walk back to the assistant that owned this tool call. For a batched turn
			// (multiple parallel tool calls on one assistant), each tool message appends
			// its own `tool_use` block to the same assistant's content array, and Anthropic
			// sees the full batch as one assistant turn. Previously only the first tool
			// was attached (prevMsg check) and the rest silently orphaned, which made
			// replay of batched turns fail validation.
			let assistantIdx = -1
			for (let j = i - 1; j >= 0; j--) {
				const m = newMessages[j]
				if (!m) continue
				if (m.role === 'assistant') { assistantIdx = j; break }
				// Skip over previously-converted tool rows (now user messages with tool_result);
				// anything else means we walked past the batch boundary.
				if (m.role !== 'user') break
				const isToolResultUser = Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')
				if (!isToolResultUser) break
			}
			if (assistantIdx >= 0) {
				const asstMsg = newMessages[assistantIdx] as AnthropicLLMChatMessage & { role: 'assistant' }
				if (typeof asstMsg.content === 'string') asstMsg.content = [{ type: 'text', text: asstMsg.content }]
				asstMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			}
			continue
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// Re-serialize every consecutive tool message after this assistant as XML and
			// concatenate them back onto the assistant content. Multi-tool batches may land
			// in history (e.g. if the user switches from a native-tool-calling model into a
			// grammar-based one); only appending `next` would lose tool calls 2..N.
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			for (let k = i + 1; k < messages.length; k++) {
				const followUp = messages[k]
				if (followUp.role !== 'tool') break
				content = `${content}\n\n${reParsedToolXMLString(followUp.name, followUp.rawParams)}`
			}
			// For backward compatibility of the void-format assumption we keep `next` only
			// reference intact below (it's still used by the batch-rebuild loop at the
			// tool-result step).
			void next

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .voidrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	)


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		// if can finish here, do
		const numCharsWillTrim = m.content.length - TRIM_TO_LEN
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = c.text || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	// Map tool_use id → tool name, populated as we encounter `tool_use` parts on
	// assistant turns. functionResponse entries later (on user turns) look their name up
	// by id so batched turns resolve each response to the correct call. Previously a
	// single `latestToolName` was tracked, which broke when one assistant emitted N
	// parallel tools: the Nth name won, and all earlier functionResponse parts were
	// mislabeled (Gemini rejects these with "function name mismatch").
	const toolNameById = new Map<string, ToolName>()
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						toolNameById.set(c.id, c.name)
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						const resolvedName = toolNameById.get(c.tool_use_id)
						if (!resolvedName) return null
						return { functionResponse: { id: c.tool_use_id, name: resolvedName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
	// Called by chat creation paths to snapshot runtime grounding (date, open files,
	// active URI, directory listing, terminal IDs) into a user message at storage time.
	// Baking volatile into the stored content (rather than prepending at send time)
	// keeps prior turns byte-identical across requests so the provider's prefix cache
	// stays warm turn-over-turn.
	generateChatVolatileContext: (opts: { chatMode: ChatMode }) => Promise<string>
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
	) {
		super()
	}

	// Read .voidrules files from workspace folders
	private _getVoidRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let voidRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.voidrules')
				const { model } = this.voidModelService.getModel(uri)
				if (!model) continue
				voidRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return voidRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .voidrules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)
		return ans.join('\n\n')
	}


	// Computes the stable system message and the volatile-context block in one pass.
	// The stable system message contains only cacheable content (persona, rules, tool
	// definitions). The volatile block (runtime grounding: date, open files, active
	// URI, directory listing, terminal IDs) is generated separately via
	// `generateChatVolatileContext` and baked into the user message at storage time
	// by the chat thread creation path — that keeps historical turns byte-identical
	// across requests so the provider's prefix cache stays warm.
	private _generateChatSystemMessage = (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined) => {
		const includeXMLToolDefinitions = !specialToolFormat
		const mcpTools = this.mcpService.getMCPTools()
		return chat_systemMessage({ chatMode, mcpTools, includeXMLToolDefinitions })
	}

	generateChatVolatileContext: IConvertToLLMMessageService['generateChatVolatileContext'] = async ({ chatMode }) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)
		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;
		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'gather' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		})
		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		return chat_volatileContext({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode })
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
					rawParamsStr: m.rawParamsStr,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings;
		const fullSystemMessage = this._generateChatSystemMessage(chatMode, specialToolFormat)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		// Volatile context is baked into user messages at thread-creation time
		// (see `chatThreadService._addUserMessageAndStreamResponse`). At send time
		// the stored content is passed through verbatim so each past turn is
		// byte-identical to what was sent before, keeping the provider's prefix
		// cache warm across turns.
		const llmMessagesRaw = this._chatMessagesToSimpleMessages(chatMessages)
		// Perf 2 — Light-tier history compaction. Trims bodies of old data-fetching
		// tool results (read_file / grep / ls_dir / run_command / …) outside the
		// protection zone (larger of "last 5 user turns" and "last 30 messages").
		// Only fires once the request crosses `sizeTriggerRatio * contextWindow`
		// so short threads keep a pristine prefix cache. Keeps envelopes
		// (tool_call_id linking) intact so protocol replay stays valid; UI
		// continues to show originals.
		const llmMessages = compactToolResultsForRequest(llmMessagesRaw, { contextWindow })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/



