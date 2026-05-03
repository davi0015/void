import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage, CompactionInfo } from '../common/chatThreadServiceTypes.js';
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
import { IRequestTelemetryService } from './requestTelemetryService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { stringHash } from '../../../../base/common/hash.js';

export const EMPTY_MESSAGE = '(empty message)'



export type ImageAttachment = {
	base64: string;
	mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

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
	images?: ImageAttachment[];
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
	// Plain-text reasoning captured during the assistant turn (DeepSeek V4's
	// `reasoning_content`, OpenRouter's `reasoning`, etc.). Carried through
	// here so OpenAI-compat providers that require replay on tool-call turns
	// (DeepSeek V4 — see note-deepseek.md §5) can emit it on the wire.
	// Optional for backward-compat with chat history persisted before this
	// field existed (treated as "no reasoning was captured").
	reasoningContent?: string;
}



// Fallback chars-per-token ratio when we have no calibration data yet (first
// request against a new model, or right after startup). Kept intentionally
// pessimistic at 4 so that size-based decisions err on the side of "assume
// worse density than reality" — we'd rather compact/trim a bit too early than
// overflow the context window.
const CHARS_PER_TOKEN = 4
const TRIM_TO_LEN = 120

// Calibration policy — `ConvertToLLMMessageService` observes the provider's
// reported `inputTokens` after each request and derives an actual chars/token
// ratio from what we sent. Consumers (Perf 2 compaction gate, emergency trim,
// CompactionInfo.savedTokens) read the calibrated ratio instead of the
// hardcoded 4 so their math matches the real tokenizer for the active model.
//
// EMA smoothing prevents a single atypical request (e.g. lots of JSON vs. lots
// of code) from yanking the ratio around. Clamp bounds are a defensive guard
// against garbage inputs — no real tokenizer produces ratios outside [2, 8].
const CALIBRATION_POLICY = {
	emaAlpha: 0.3,      // weight of new observation; 1.0 = replace, 0.0 = ignore
	minRatio: 2,        // clamp lower bound (very dense: CJK, base64, minified code)
	maxRatio: 8,        // clamp upper bound (very sparse: ASCII with lots of whitespace)
} as const


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

// Returns a new message array with old, trimmable tool bodies replaced by a short
// trim marker, plus a summary of what was done (surfaced in the TokenUsageRing
// tooltip so the user has visibility into when/why requests shrunk).
// Pure function — does not mutate the input. `info === null` means no compaction
// happened this request (size gate not met, or no trim-eligible messages).
const compactToolResultsForRequest = (
	messages: SimpleLLMMessage[],
	{ contextWindow, charsPerToken, priorContentTokens }: { contextWindow: number, charsPerToken: number, priorContentTokens?: number },
): { messages: SimpleLLMMessage[], info: CompactionInfo | null } => {
	// Gate 0 — size-based. Don't trim anything on small requests; the cache break
	// cost would outweigh the savings. Reasoned in tokens (not chars) so the
	// threshold means the same thing across models with different tokenizers.
	//
	// Estimate current-request tokens as the max of:
	//   (a) `priorContentTokens` = the previous request's `inputTokens + outputTokens`
	//       — the provider's exact tokenizer output for everything that was in
	//       play at the end of the last request. Every one of those tokens is
	//       also in THIS request's input (append-only history within a turn).
	//   (b) `totalChars / calibratedRatio` — ratio-based estimate over the full
	//       current message array, which *does* cover the delta (new tool
	//       results, new user message) that (a) doesn't know about.
	//
	// Max is the safe compromise: in the common agent-loop case where the delta
	// is small, (a) wins and we use exact numbers; when a big new tool result
	// lands, (b)'s estimate exceeds (a) and covers the jump; on a model switch
	// (a) is stale from a different tokenizer — larger-of-two is still the safer
	// (over-trim, not under-trim) side.
	const totalChars = _totalContentChars(messages)
	const estimatedTokens = Math.max(priorContentTokens ?? 0, totalChars / charsPerToken)
	const sizeTriggerTokens = contextWindow * COMPACTION_POLICY.sizeTriggerRatio
	if (estimatedTokens < sizeTriggerTokens) return { messages, info: null }

	// Gate 1 — structural. Compute the protection boundary (larger of the two
	// policies, see `_computeProtectionBoundary`). If nothing sits before the
	// boundary, there's nothing to trim.
	const boundaryIdx = _computeProtectionBoundary(messages)
	if (boundaryIdx <= 0) return { messages, info: null }

	let trimmedCount = 0
	let savedChars = 0
	const out = messages.map((m, idx): SimpleLLMMessage => {
		if (idx >= boundaryIdx) return m
		// IMPORTANT for DeepSeek thinking + tools: this stage trims tool-RESULT bodies
		// only — assistant messages (and their `reasoningContent`) flow through
		// untouched, so the §5 replay constraint (every prior assistant's
		// reasoning_content must round-trip) stays satisfied. If a future tier ever
		// DROPS historical messages (not just trims content), it MUST drop the
		// tool-call assistant + its `tool` followers as a unit — orphaning the tool
		// messages alone would break tool_call_id linking AND lose reasoning_content,
		// both of which are 400-triggers on DeepSeek V4. See note-deepseek.md §5.
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
		trimmedCount++
		savedChars += body.length - newContent.length
		return { ...m, content: newContent }
	})

	if (trimmedCount === 0) return { messages, info: null }

	const savedTokens = Math.round(savedChars / charsPerToken)

	// Best-effort diagnostics so the user can see compaction firing in the dev console
	// when they're tuning thresholds. Uses the same calibrated ratio that the
	// CompactionInfo reports, so log and tooltip numbers match.
	try {
		console.log(`[void compaction] trimmed ${trimmedCount} stale tool result(s); saved ~${savedChars.toLocaleString()} chars (~${savedTokens.toLocaleString()} tokens @ ${charsPerToken.toFixed(2)} chars/tok); boundary=${boundaryIdx}/${messages.length}`)
	} catch { }

	return { messages: out, info: { trimmedCount, savedChars, savedTokens } }
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


const prepareMessages_openai_tools = (
	messages: SimpleLLMMessage[],
	// Emit `reasoning_content` on assistant messages that captured it. DeepSeek V4
	// thinking mode REQUIRES this on every prior assistant turn that produced
	// reasoning, regardless of whether the turn had tool calls (otherwise: 400).
	// Other OpenAI-compat providers don't consume the field and might surface it
	// as "unknown property" warnings, so we only opt in by provider.
	// See note-deepseek.md §5 for the exact constraint and why we don't optimise
	// non-tool turns away.
	supportsOAICompatReasoningContent: boolean,
): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role === 'assistant') {
			// Push a fresh shape (don't carry SimpleLLMMessage-only fields like
			// `anthropicReasoning` onto the wire). `tool_calls` is added later in
			// the tool-walk below if this assistant called any tools.
			const out: OpenAILLMChatMessage & { role: 'assistant' } = {
				role: 'assistant',
				content: currMsg.content,
			}
			if (supportsOAICompatReasoningContent && currMsg.reasoningContent !== undefined) {
				// DeepSeek V4 thinking mode: replay reasoning_content on EVERY
				// prior assistant turn captured under thinking mode, regardless
				// of whether it had tool_calls AND regardless of whether the
				// model actually produced any reasoning text. The published docs
				// claim a "Case A vs Case B" split (only tool-call turns require
				// it), but the live API returns 400 "The reasoning_content in
				// the thinking mode must be passed back to the API" if the field
				// is missing on ANY prior thinking-mode turn — including the
				// short "Done."-style follow-ups that come back from the model
				// with an empty reasoning blob after a tool round-trip.
				// Hence the `!== undefined` gate (vs truthy): an explicit empty
				// string means "captured, model said nothing" and must round-trip
				// as `reasoning_content: ""`. Only `undefined` (= field never
				// captured, e.g. legacy history or non-thinking turn) skips emit.
				// The recommended pattern from the docs is to append
				// `response.choices[0].message` verbatim, which carries content +
				// reasoning_content + tool_calls together. We do exactly that.
				// Cost trade-off: input tokens grow by the size of all stored
				// reasoning blobs in the thread. The prefix cache mitigates this
				// because the field bytes stay identical turn-to-turn.
				out.reasoning_content = currMsg.reasoningContent
			}
			newMessages.push(out)
			continue
		}

		if (currMsg.role === 'user') {
			if (currMsg.images && currMsg.images.length > 0) {
				const parts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [
					{ type: 'text', text: currMsg.content },
					...currMsg.images.map(img => ({
						type: 'image_url' as const,
						image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
					})),
				]
				newMessages.push({ role: 'user', content: parts })
			} else {
				newMessages.push({ role: 'user', content: currMsg.content })
			}
			continue
		}

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg as any)
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
	charsPerToken,
	priorContentTokens,
	providerName,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	charsPerToken: number,
	priorContentTokens?: number,
	// Threaded through so `prepareMessages_openai_tools` can opt-in to
	// `reasoning_content` round-trip on assistant messages (DeepSeek V4 only,
	// today). See `prepareMessages_openai_tools` for the gate.
	providerName?: ProviderName,
}): {
	messages: AnthropicOrOpenAILLMMessage[],
	separateSystemMessage: string | undefined,
	// Populated only when the emergency trim loop actually truncated one or more
	// messages (rare in practice, since Perf 2 Light-tier normally keeps us
	// under budget). Consumed by `prepareLLMChatMessages` and merged into the
	// returned `CompactionInfo` so the tooltip can surface a dedicated
	// "Emergency trim: …" line. `undefined` when the destructive path didn't
	// run, distinct from `{…count:0}` for cheaper caller checks.
	emergencyInfo?: { emergencyTrimmedCount: number, emergencySavedChars: number, emergencySavedTokens: number },
} => {

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

	// TWO-STAGE DECISION:
	//
	// Stage 1 — "Do we need to trim?" — answered in TOKENS using the max of
	//   (a) `priorContentTokens` (= last request's inputTokens + outputTokens =
	//       exact token count of everything in the conversation at the moment
	//       the last request completed — all of which is also in THIS request's
	//       input since history is append-only), and
	//   (b) `totalLen / calibratedRatio` — ratio-based estimate over the full
	//       current message array, which covers the per-turn delta (new tool
	//       results / user message) that (a) doesn't know about.
	// Same reasoning as the compaction size gate in `compactToolResultsForRequest`.
	const budgetTokens = contextWindow - reservedOutputTokenSpace
	const estimatedTokens = Math.max(priorContentTokens ?? 0, totalLen / charsPerToken)
	const willOverflow = estimatedTokens > budgetTokens

	// Stage 2 — "How many chars to cut?" — answered in chars because the trim
	// loop below operates on strings. Target remaining chars = budget-in-tokens
	// × calibrated ratio, floored at 5_000 to guard against pathological
	// budgets (malformed/zero contextWindow) causing us to trim everything.
	// The ratio conversion here is unavoidable — you can only cut strings by
	// character count, not by token count.
	const charsNeedToTrim = willOverflow
		? totalLen - Math.max(budgetTokens * charsPerToken, 5_000)
		: 0


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	// Track what the emergency trim actually did so we can surface it in the
	// CompactionInfo returned alongside the messages. Emergency trim is more
	// destructive than Light tier (can truncate user messages / assistant replies
	// to 120 chars, not just tool result bodies), so when it fires the user
	// should see it in the tooltip — both for trust and for diagnostics (if this
	// keeps firing, Perf 2's `sizeTriggerRatio` is too loose for this model).
	//
	// TODO(deepseek-thinking): emergency trim is NOT aware of `reasoningContent`
	// weight on assistant messages. On thinking-mode threads, reasoning_content
	// can be 5-10× larger than the visible `content` text, so trimming `content`
	// to 120 chars saves almost nothing while the reasoning blob keeps the request
	// over budget. Future option when we hit this: include `reasoningContent.length`
	// in `weight()` and trim it directly. DeepSeek requires byte-exact replay of
	// every prior reasoning blob (note-deepseek.md §5), so any trim of an old
	// reasoning_content WILL produce a 400. The pragmatic stance is "trim and
	// accept the 400; the user retries" — a deliberate degradation under context
	// pressure rather than a bug. Defer until telemetry shows this firing.
	let emergencyTrimmedCount = 0
	let emergencySavedChars = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]
		const origLen = m.content.length

		// if can finish here, do
		const numCharsWillTrim = m.content.length - TRIM_TO_LEN
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
			emergencyTrimmedCount += 1
			emergencySavedChars += origLen - m.content.length
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
		emergencyTrimmedCount += 1
		emergencySavedChars += origLen - m.content.length
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// Token count is computed here with the calibrated ratio so the reported
	// value matches how the compaction size gate / token-usage tooltip reason
	// about tokens everywhere else. Deliberately NOT derived client-side from
	// savedChars so cumulative counters preserve per-request accuracy (ratio can
	// drift as more requests land and the EMA updates).
	const emergencySavedTokens = Math.round(emergencySavedChars / charsPerToken)

	if (emergencyTrimmedCount > 0) {
		// Dev diagnostic — user-visible feedback goes through the tooltip, but
		// logging here too helps when investigating "why did emergency trim fire
		// despite Perf 2 being on?" — usually the answer is `sizeTriggerRatio`
		// is too loose for this particular model's real context window.
		try {
			console.log(`[void emergency-trim] truncated ${emergencyTrimmedCount} message(s); saved ~${emergencySavedChars.toLocaleString()} chars (~${emergencySavedTokens.toLocaleString()} tokens @ ${charsPerToken.toFixed(2)} chars/tok)`)
		} catch { }
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
		// Per-provider opt-in for `reasoning_content` round-trip on assistant messages.
		// Today: DeepSeek V4 (required for thinking + tools — see note-deepseek.md §5).
		// Other providers may need it later (e.g. OpenRouter routes that proxy to
		// DeepSeek); extend this set rather than making it a model-level capability
		// so we can flip whole providers at once.
		const supportsOAICompatReasoningContent = providerName === 'deepseek'
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[], supportsOAICompatReasoningContent)
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

	// Return emergency info only when it actually fired so callers can cheaply
	// check `if (emergencyInfo)` rather than comparing zeros.
	const emergencyInfo = emergencyTrimmedCount > 0
		? { emergencyTrimmedCount, emergencySavedChars, emergencySavedTokens }
		: undefined

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
		emergencyInfo,
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
	providerName: ProviderName,
	charsPerToken: number,
	priorContentTokens?: number,
}): {
	messages: LLMChatMessage[],
	separateSystemMessage: string | undefined,
	// Forwarded from `prepareOpenAIOrAnthropicMessages` so `prepareLLMChatMessages`
	// can merge emergency-trim counts into the returned CompactionInfo. Undefined
	// when emergency trim didn't fire (the common / expected case).
	emergencyInfo?: { emergencyTrimmedCount: number, emergencySavedChars: number, emergencySavedTokens: number },
} => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		// Collect images from SimpleLLMMessage before the intermediate Anthropic
		// conversion, then strip them so prepareOpenAIOrAnthropicMessages doesn't
		// generate image_url content parts (which Gemini and text-only providers
		// don't understand). We re-inject them as Gemini inlineData below.
		const imagesByMsgIndex = new Map<number, ImageAttachment[]>()
		let userIdx = 0
		const messagesWithoutImages = params.messages.map(m => {
			if (m.role === 'user') {
				if (m.images && m.images.length > 0) imagesByMsgIndex.set(userIdx, m.images)
				userIdx++
				return { ...m, images: undefined }
			}
			return m
		})

		const res = prepareOpenAIOrAnthropicMessages({ ...params, messages: messagesWithoutImages, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)

		// Inject images into Gemini user messages
		if (imagesByMsgIndex.size > 0) {
			let geminiUserIdx = 0
			for (const m of messages2) {
				if (m.role === 'user') {
					const imgs = imagesByMsgIndex.get(geminiUserIdx)
					if (imgs) {
						for (const img of imgs) {
							m.parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } })
						}
					}
					geminiUserIdx++
				}
			}
		}
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage, emergencyInfo: res.emergencyInfo }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	// prepareLLMChatMessages also returns `sentChars` — the character count we
	// measured on the final messages array — so the caller (chatThreadService)
	// can feed it back into `recordTokenUsageCalibration` once the provider
	// reports `inputTokens`, closing the calibration loop.
	//
	// `priorContentTokens` is the token count of everything that was in play at
	// the end of the *previous* request on this thread: `inputTokens` (what the
	// last request sent) + `outputTokens` (the assistant reply that was generated
	// and is now in history). Together they're the exact token count of the
	// conversation state at the moment the last request completed — every one of
	// those tokens is also in THIS request's input (history is append-only within
	// a turn). The only thing we're still estimating is the delta added since
	// (new tool results, new user message), which the chars/ratio floor covers.
	// Undefined on the first request of a thread.
	// `threadId` is optional only so existing callers compile — pass it whenever
	// you have it (chat agent loop always does) so the per-request telemetry log
	// can route the entry to the right thread file. `telemetryRequestId` in the
	// result is the rid the caller must echo back to `IRequestTelemetryService.logResponse`
	// so request and response lines can be paired during analysis.
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, priorContentTokens?: number, threadId?: string }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined, compactionInfo: CompactionInfo | null, sentChars: number, telemetryRequestId?: string }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
	// Called by chat creation paths to snapshot runtime grounding (date, open files,
	// active URI, directory listing, terminal IDs) into a user message at storage time.
	// Baking volatile into the stored content (rather than prepending at send time)
	// keeps prior turns byte-identical across requests so the provider's prefix cache
	// stays warm turn-over-turn.
	generateChatVolatileContext: (opts: { chatMode: ChatMode }) => Promise<string>

	// Called by `chatThreadService` after each LLM response resolves with a
	// reported `inputTokens`. Updates the per-model chars/token ratio via EMA
	// so subsequent compaction and emergency-trim decisions use data from the
	// actual tokenizer instead of the hardcoded 4 fallback. Silently no-ops on
	// missing/invalid inputs so callers can pass what they have without
	// guarding every field.
	recordTokenUsageCalibration(opts: { providerName: string, modelName: string, sentChars: number, reportedInputTokens: number | undefined }): void

	// Returns the current combined `.voidrules` file content (all workspace
	// folders concatenated, `\n\n` separated). Reads fresh from disk on every
	// call — see `_getVoidRulesFileContentsFromDisk` for the rationale. Used
	// by chatThreadService for per-thread rule-change detection so a UI chip
	// can be rendered on user messages sent after a rule edit. The LLM
	// already receives current rules via the system message on every
	// request — this getter exists purely to drive the UI affordance.
	getCurrentVoidRulesContent(): Promise<string>
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	// Calibrated chars/token ratio, keyed by `${providerName}:${modelName}`.
	// Populated by `recordTokenUsageCalibration`. Not persisted across reloads
	// (first request after startup uses the fallback 4; ratio converges within
	// 2-3 requests thanks to EMA weighting).
	private readonly _charsPerTokenByModel = new Map<string, number>()

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IFileService private readonly fileService: IFileService,
		@IRequestTelemetryService private readonly requestTelemetryService: IRequestTelemetryService,
	) {
		super()
	}

	private _calibrationKey(providerName: string, modelName: string): string {
		return `${providerName}:${modelName}`
	}

	// Returns the calibrated chars/token ratio for the given model, falling back
	// to the conservative `CHARS_PER_TOKEN` default if we haven't observed a
	// request against this model yet in the current session.
	private _getCharsPerToken(providerName: string, modelName: string): number {
		return this._charsPerTokenByModel.get(this._calibrationKey(providerName, modelName)) ?? CHARS_PER_TOKEN
	}

	recordTokenUsageCalibration: IConvertToLLMMessageService['recordTokenUsageCalibration'] = ({ providerName, modelName, sentChars, reportedInputTokens }) => {
		// Defensive: skip garbage inputs. `reportedInputTokens` is optional upstream
		// (some providers don't send usage). Tiny `sentChars` (<1k) yields noisy
		// ratios — skip until we have meaningful data to average over.
		if (!reportedInputTokens || reportedInputTokens <= 0) return
		if (sentChars < 1_000) return

		const observed = sentChars / reportedInputTokens
		// Defensive clamp against outliers (compression bugs, encoding surprises,
		// provider double-counting). Real tokenizers sit in ~[2.5, 6].
		const clamped = Math.max(CALIBRATION_POLICY.minRatio, Math.min(CALIBRATION_POLICY.maxRatio, observed))

		const key = this._calibrationKey(providerName, modelName)
		const prev = this._charsPerTokenByModel.get(key)
		// First observation = adopt-as-is; subsequent observations blend with EMA.
		// Blending prevents a single outlier request (e.g. a turn dominated by
		// base64-encoded content) from permanently warping the ratio.
		const next = prev === undefined
			? clamped
			: CALIBRATION_POLICY.emaAlpha * clamped + (1 - CALIBRATION_POLICY.emaAlpha) * prev
		this._charsPerTokenByModel.set(key, next)

		// Dev diagnostic — helpful when debugging "why did compaction fire at
		// different sizes on different models". Low volume (one log per request).
		try {
			console.log(`[void calibration] ${key}: observed=${observed.toFixed(2)} (clamped=${clamped.toFixed(2)}) → ratio=${next.toFixed(2)} chars/token`)
		} catch { }
	}

	// Read .voidrules files fresh from disk on every call. Previously backed by a
	// cached ITextModel (initialized once at startup), which had two silent-failure
	// modes: (1) if `.voidrules` didn't exist at launch the model reference was
	// never created and creating the file later wouldn't re-init; (2) even with a
	// live model reference, external disk edits weren't always propagated to the
	// cached `model.getValue()` in practice. Direct file read is ~sub-ms for this
	// tiny file and eliminates both failure modes: editing `.voidrules` mid-session
	// is picked up by the very next request, no restart needed.
	//
	// Kept sync variant `_getVoidRulesFileContentsSync` below for `prepareLLMSimpleMessages`
	// (Fast Apply / Quick Edit / SCM) which is called from sync control flow —
	// retains prior cached-model behavior (no behavior change for those flows).
	private _lastLoggedRulesContent: string | undefined = undefined // for change-log only, not correctness
	private async _getVoidRulesFileContentsFromDisk(): Promise<string> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const parts: string[] = [];
		for (const folder of workspaceFolders) {
			const uri = URI.joinPath(folder.uri, '.voidrules')
			try {
				if (!(await this.fileService.exists(uri))) continue
				const content = await this.fileService.readFile(uri)
				parts.push(content.value.toString())
			} catch { /* unreadable — skip this folder */ }
		}
		const combined = parts.join('\n\n').trim()

		// Dev-visible rule logging (Option A). Silent when rules are empty; logs
		// char count on every read (for "were rules applied?"); logs a change
		// marker when content differs from the last read (for "did my edit take?").
		try {
			if (combined) {
				if (this._lastLoggedRulesContent !== undefined && this._lastLoggedRulesContent !== combined) {
					console.log(`[void rules] .voidrules changed (was ${this._lastLoggedRulesContent.length} → ${combined.length} chars)`)
				} else if (this._lastLoggedRulesContent === undefined) {
					console.log(`[void rules] loaded .voidrules (${combined.length} chars)`)
				}
			}
		} catch { }
		this._lastLoggedRulesContent = combined

		return combined
	}

	// Legacy sync reader — preserved for `prepareLLMSimpleMessages` call sites
	// (Fast Apply / Quick Edit / SCM) that run from sync control flow. Uses the
	// cached ITextModel populated by the workbench contribution at startup; picks
	// up in-editor edits to `.voidrules` but not mid-session file-creation. The
	// chat flow uses the async disk-read variant above which has no such caveat.
	private _getVoidRulesFileContentsSync(): string {
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

	// Async combined-instructions getter used by the chat flow. Reads `.voidrules`
	// fresh on every request so rules edits take effect immediately on the next
	// user message (no Void restart, no thread recreate).
	private async _getCombinedAIInstructionsAsync(): Promise<string> {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = await this._getVoidRulesFileContentsFromDisk();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)
		return ans.join('\n\n')
	}

	// Sync combined-instructions getter — same shape as the async version but
	// reads `.voidrules` from the cached ITextModel. See
	// `_getVoidRulesFileContentsSync` for the caching caveat.
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContentsSync();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)
		return ans.join('\n\n')
	}

	// Exposed so chatThreadService can compare current rules against the per-thread
	// `lastAppliedRules` snapshot and mark a user message with `rulesChangedBefore`
	// when content differs. Purely a UI affordance — the rule content reaches the
	// LLM via the system message in `prepareLLMChatMessages` regardless.
	getCurrentVoidRulesContent: IConvertToLLMMessageService['getCurrentVoidRulesContent'] = async () => {
		return this._getVoidRulesFileContentsFromDisk();
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

	private async _chatMessagesToSimpleMessages(chatMessages: ChatMessage[], opts?: { supportsVision?: boolean }): Promise<SimpleLLMMessage[]> {
		const simpleLLMMessages: SimpleLLMMessage[] = []
		const attachImages = opts?.supportsVision === true

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
					// Pass the persisted `reasoning` text through verbatim, including
					// `""`. The downstream `prepareMessages_openai_tools` gate distinguishes
					// `undefined` (no reasoning field captured — old history from before
					// this feature, or non-thinking-mode turns) from `""` (captured under
					// thinking mode but the model emitted no reasoning text — common on
					// short follow-up replies after a tool round-trip). DeepSeek V4
					// thinking mode requires `reasoning_content` to be present on EVERY
					// prior thinking-mode assistant message, even if empty, so we must
					// preserve the empty-string signal here.
					reasoningContent: m.reasoning,
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
				const images: ImageAttachment[] = []
				if (attachImages) {
					const imageSelections = m.selections?.filter(s => s.type === 'Image') ?? []
					for (const s of imageSelections) {
						if (s.type !== 'Image') continue
						try {
							const content = await this.fileService.readFile(s.uri)
							const bytes = content.value.buffer
							let binary = ''
							for (let bi = 0; bi < bytes.length; bi++) binary += String.fromCharCode(bytes[bi])
							const base64 = btoa(binary)
							images.push({ base64, mimeType: s.mimeType })
						} catch {
							// image file may have been deleted; skip silently
						}
					}
				}
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					images: images.length > 0 ? images : undefined,
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

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName]?.[modelSelection.providerName]?.[modelSelection.modelName]

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
			charsPerToken: this._getCharsPerToken(providerName, modelName),
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, priorContentTokens, threadId }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined, compactionInfo: null, sentChars: 0 }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
			supportsVision,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings;
		const fullSystemMessage = this._generateChatSystemMessage(chatMode, specialToolFormat)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Async path reads `.voidrules` fresh from disk — picks up edits
		// mid-session on the very next user message, no Void restart needed.
		const aiInstructions = await this._getCombinedAIInstructionsAsync();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		// Model-calibrated chars/token ratio for the active model. Shared across
		// compaction gate, emergency trim, and savedTokens display so all three
		// agree on what "a token" means for this specific model. First request
		// against a new model falls back to 4; subsequent requests use EMA-smoothed
		// observations (see `recordTokenUsageCalibration`).
		const charsPerToken = this._getCharsPerToken(providerName, modelName)
		// Volatile context is baked into user messages at thread-creation time
		// (see `chatThreadService._addUserMessageAndStreamResponse`). At send time
		// the stored content is passed through verbatim so each past turn is
		// byte-identical to what was sent before, keeping the provider's prefix
		// cache warm across turns.
		const llmMessagesRaw = await this._chatMessagesToSimpleMessages(chatMessages, { supportsVision })
		// Perf 2 — Light-tier history compaction. Trims bodies of old data-fetching
		// tool results (read_file / grep / ls_dir / run_command / …) outside the
		// protection zone (larger of "last 5 user turns" and "last 30 messages").
		// Only fires once the request crosses `sizeTriggerRatio * contextWindow`
		// so short threads keep a pristine prefix cache. Keeps envelopes
		// (tool_call_id linking) intact so protocol replay stays valid; UI
		// continues to show originals.
		const { messages: llmMessages, info: compactionInfo } = compactToolResultsForRequest(llmMessagesRaw, { contextWindow, charsPerToken, priorContentTokens })

		const { messages, separateSystemMessage, emergencyInfo } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
			charsPerToken,
			priorContentTokens,
		})

		// Measure sentChars on the final prepared messages so the calibration loop
		// uses the same unit the emergency trim and compaction gate already reason in
		// (content.length sums). Doesn't include provider-added wrapping (tool schema,
		// system prompt formatting) — that biases the observed ratio slightly low
		// which makes `savedTokens` over-estimate by ~3-5%. Accept as "good enough".
		// Handles all three message shapes: OpenAI/Anthropic use `content`
		// (string | part[]), Gemini uses `parts`. Only counts text payloads —
		// structural fields (role, ids, function names) are ignored since they're
		// small and constant-per-message.
		// Per-message char counter; reused for both sentChars totals and the
		// history/lastMsg breakdown the telemetry log needs for cost decomposition.
		// Handles all three message shapes (OpenAI/Anthropic `content`, Gemini `parts`).
		const charsOfMessage = (m: LLMChatMessage): number => {
			let n = 0
			if ('content' in m) {
				const c = m.content
				if (typeof c === 'string') { n += c.length }
				else if (Array.isArray(c)) {
					for (const p of c) {
						if ('text' in p && typeof p.text === 'string') n += p.text.length
						else if ('content' in p && typeof p.content === 'string') n += p.content.length  // anthropic tool_result
					}
				}
			}
			else if ('parts' in m) {
				for (const p of m.parts) {
					if ('text' in p && typeof p.text === 'string') n += p.text.length
				}
			}
			return n
		}
		let sentChars = 0
		let historyLen = 0
		let lastMsgLen = 0
		let lastMsgRole = ''
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i]
			const n = charsOfMessage(m)
			sentChars += n
			if (i === messages.length - 1) {
				lastMsgLen = n
				// Role field exists on every shape; cast is safe but defensive.
				lastMsgRole = (m as { role?: string }).role ?? ''
			} else {
				historyLen += n
			}
		}

		// Merge Light-tier compaction info with emergency-trim info into one
		// CompactionInfo so downstream (chatThreadService / UI) only has to carry
		// one object. Totals are summed so the "Last request: N results" line in
		// the tooltip covers both paths; emergency-specific fields are kept on
		// the side so the UI can surface a second "Emergency trim: …" line when
		// the destructive path fired (and only then).
		let mergedCompactionInfo: CompactionInfo | null = compactionInfo
		if (emergencyInfo) {
			const base = compactionInfo ?? { trimmedCount: 0, savedChars: 0, savedTokens: 0 }
			mergedCompactionInfo = {
				trimmedCount: base.trimmedCount + emergencyInfo.emergencyTrimmedCount,
				savedChars: base.savedChars + emergencyInfo.emergencySavedChars,
				savedTokens: base.savedTokens + emergencyInfo.emergencySavedTokens,
				emergencyTrimmedCount: emergencyInfo.emergencyTrimmedCount,
				emergencySavedChars: emergencyInfo.emergencySavedChars,
				emergencySavedTokens: emergencyInfo.emergencySavedTokens,
			}
		}

		// Per-request telemetry (Option A): emit a "request" line so offline analysis
		// can spot prefix-cache leaks (sysHash changing when it shouldn't), track
		// empirical chars/token ratios (sentChars vs usage.in on the response line),
		// and correlate outcomes across long dogfooding sessions. We only log when
		// the caller supplied a threadId — ephemeral/one-off callers (e.g. commit
		// message generation) stay out of the per-thread log files.
		let telemetryRequestId: string | undefined = undefined;
		if (threadId) {
			telemetryRequestId = generateUuid();
			// Hash the system message post-rules-merge, pre-folding. If this hash
			// changes across consecutive requests on the same thread while .voidrules
			// is unchanged, the system prompt is not byte-stable and the provider's
			// prefix cache will miss every turn.
			const sysHashSource = systemMessage;
			// Fold merged compactionInfo (Perf 2 light + emergency trim) into the
			// telemetry shape. Omit the whole field when no trimming fired so the
			// log only flags actual events, not "we checked and did nothing".
			const compactionForTelemetry = mergedCompactionInfo && mergedCompactionInfo.trimmedCount > 0 ? {
				trimmed: mergedCompactionInfo.trimmedCount,
				savedChars: mergedCompactionInfo.savedChars,
				savedTokens: mergedCompactionInfo.savedTokens,
				emergencyTrimmed: mergedCompactionInfo.emergencyTrimmedCount,
				emergencySavedChars: mergedCompactionInfo.emergencySavedChars,
				emergencySavedTokens: mergedCompactionInfo.emergencySavedTokens,
			} : undefined;
			this.requestTelemetryService.logRequest({
				phase: 'request',
				t: new Date().toISOString(),
				rid: telemetryRequestId,
				tid: threadId,
				mode: chatMode,
				provider: providerName,
				model: modelName,
				sysHash: stringHash(sysHashSource, 0),
				sysLen: sysHashSource.length,
				rulesLen: aiInstructions.length,
				msgCount: messages.length,
				sentChars,
				historyLen,
				lastMsgLen,
				lastMsgRole,
				compaction: compactionForTelemetry,
			}, {
				// Opt-in content capture (Option B): the service keeps this string
				// in memory only to diff against the next request. No content lands
				// in the log unless sysHash flips — which is exactly the cache-leak
				// scenario we're trying to debug.
				systemMessage: sysHashSource,
			});
		}

		return { messages, separateSystemMessage, compactionInfo: mergedCompactionInfo, sentChars, telemetryRequestId };
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



