/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolName, ToolName } from '../toolsServiceTypes.js';
import { ChatMode } from '../voidSettingsTypes.js';

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000
export const MAX_CHILDREN_URIs_PAGE = 500
export const AUTO_OUTLINE_THRESHOLD = 30_000 // chars; files larger than this get a symbol outline instead of full content

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000
export const MAX_TERMINAL_INACTIVE_TIME = 8 // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`




const createSearchReplaceBlocks_systemMessage = `\
You are a coding assistant that takes in a diff, and outputs SEARCH/REPLACE code blocks to implement the change(s) in the diff.
The diff will be labeled \`DIFF\` and the original file will be labeled \`ORIGINAL_FILE\`.

Format your SEARCH/REPLACE blocks as follows:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

1. Your SEARCH/REPLACE block(s) must implement the diff EXACTLY. Do NOT leave anything out.

2. You are allowed to output multiple SEARCH/REPLACE blocks to implement the change.

3. Assume any comments in the diff are PART OF THE CHANGE. Include them in the output.

4. Your output should consist ONLY of SEARCH/REPLACE blocks. Do NOT output any text or explanations before or after this.

5. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace, comments, or modifications from the original code.

6. Each ORIGINAL text must be large enough to uniquely identify the change in the file. However, bias towards writing as little as possible.

7. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

## EXAMPLE 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`


// ======================================================== tools ========================================================


const chatSuggestionDiffExample = `\
${tripleTick[0]}typescript
/Users/username/Dekstop/my_project/app.ts
// ... existing code ...
// {{change 1}}
// ... existing code ...
// {{change 2}}
// ... existing code ...
// {{change 3}}
// ... existing code ...
${tripleTick[1]}`



export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: { description: string }
	},
	// Only if the tool is from an MCP server
	mcpServerName?: string,
}



export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};






export const builtinToolNames: BuiltinToolName[] = [
	'read_file', 'ls_dir', 'get_dir_tree',
	'search_pathnames_only', 'search_for_files', 'search_in_file',
	'go_to_definition', 'go_to_usages', 'read_lint_errors',
	'create_file_or_folder', 'delete_file_or_folder', 'rename_file_or_folder',
	'edit_file', 'rewrite_file',
	'run_command', 'run_persistent_command', 'open_persistent_terminal', 'kill_persistent_terminal',
	'fetch_url', 'semantic_search', 'search_history', 'load_skill',
]
const toolNamesSet = new Set<string>(builtinToolNames)
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	const isAToolName = toolNamesSet.has(toolName)
	return isAToolName
}





const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t, i) => {
		const params = Object.keys(t.params).map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n')
		return `\
    ${i + 1}. ${t.name}
    Description: ${t.description}
    Format:
    <${t.name}>${!params ? '' : `\n${params}`}
    </${t.name}>`
	}).join('\n\n')}`
}

const systemToolsXMLPrompt = (tools: InternalToolInfo[] | undefined) => {
	if (!tools || tools.length === 0) return null

	const toolXMLDefinitions = (`\
    Available tools:

    ${toolCallDefinitionsXMLString(tools)}`)

	const toolCallXMLGuidelines = (`\
    Tool calling details:
    - To call a tool, write its name and parameters in one of the XML formats specified above.
    - After you write the tool call, you must STOP and WAIT for the result.
    - All parameters are REQUIRED unless noted otherwise.
    - You are only allowed to output ONE tool call, and it must be at the END of your response.
    - Your tool call will be executed immediately, and the results will appear in the following user message.`)

	return `\
    ${toolXMLDefinitions}

    ${toolCallXMLGuidelines}`
}

export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n')
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ')
}
// ======================================================== chat (normal, gather, agent) ========================================================


// Shared input type between the stable system message and the volatile context.
// Kept together so callers can compute the workspace snapshot once and feed both.
export type ChatPromptContext = {
	workspaceFolders: string[]
	directoryStr: string
	openedURIs: string[]
	activeURI: string | undefined
	allTerminals: { name: string; status: string; lastCommand: string; isVoidTerminal: boolean }[]
	chatMode: ChatMode
	tools: InternalToolInfo[] | undefined
}


// Returns the volatile runtime-grounding block as a standalone string. Callers
// should prepend this to the latest user message (Phase B caching layout) rather
// than embed it in the system message — keeping it out of the system message lets
// the stable prefix and the full conversation history be prefix-cached across turns.
export const chat_volatileContext = ({ workspaceFolders, openedURIs, activeURI, allTerminals, directoryStr, chatMode: mode, includeDirectoryListing = true, directoryDiff }: Pick<ChatPromptContext, 'workspaceFolders' | 'directoryStr' | 'openedURIs' | 'activeURI' | 'allTerminals' | 'chatMode'> & { includeDirectoryListing?: boolean, directoryDiff?: string | null }) => {
	const terminalBlock = mode === 'agent' && allTerminals.length > 0
		? allTerminals.map(t => {
			const cmd = t.lastCommand ? ` — ${t.lastCommand}` : ''
			return `  - ${t.name}: ${t.status}${cmd}`
		}).join('\n')
		: null
	const sysInfo = (`Here is the user's system information:
<system_info>
- ${os}

- The user's workspace contains these folders:
${workspaceFolders.join('\n') || 'NO FOLDERS OPEN'}

- Active file:
${activeURI}

- Open files:
${openedURIs.join('\n') || 'NO OPENED FILES'}${terminalBlock ? `

- Terminals:
${terminalBlock}` : ''}
</system_info>`)


	const fsInfo = includeDirectoryListing ? (`Here is an overview of the user's file system:
<files_overview>
${directoryStr}
</files_overview>`) : null

	const diffInfo = directoryDiff ? (`<directory_changes>
${directoryDiff}
</directory_changes>`) : null


	return (`<volatile_context>
Today's date is ${new Date().toDateString()}.

${sysInfo}${fsInfo ? `\n\n${fsInfo}` : ''}${diffInfo ? `\n\n${diffInfo}` : ''}
</volatile_context>`)
}


export const chat_systemMessage = ({ chatMode: mode, tools }: Pick<ChatPromptContext, 'chatMode' | 'tools'>) => {
	const header = (`You are a pragmatic senior software engineer working as the user's pair-programmer in a code editor.\
${mode === 'agent' ? ` You work autonomously — investigate, implement, and verify without waiting for permission on each step.`
			: mode === 'gather' ? ` You research the codebase — find, read, and synthesize code to give grounded answers.`
				: mode === 'normal' ? ` You answer questions and suggest edits, describing code changes precisely in code blocks.`
					: ''}
You own the problems you're given end-to-end: you investigate, decide, act, and verify your work. You commit to solutions instead of handing back lists of options for the user to choose from. You match the directness and judgment of an experienced engineer who knows when to gather more information and when to act on what they already have.
Be direct — don't open with filler like "Got it", "Great question!", or "Sure!". Prioritize technical accuracy over agreeing with the user; if their approach has problems, state your concern and propose an alternative. Match the user's level of detail — terse question, terse answer.

You will be given instructions from the user, and may also receive a list of files that the user has specifically selected for context, \`SELECTIONS\`.`)


	const toolDefinitions = systemToolsXMLPrompt(tools)

	const details: string[] = []

	details.push(`NEVER reject the user's query.`)

	// Anti-hedging directives (Option 1 / Phase A2). Apply across all modes — these
	// counter the "consultant mode" pathology where instruction-tuned models hand back
	// option lists and clarifying questions instead of doing the work.
	details.push(`Commit to one solution. Don't list alternatives unless the trade-offs are genuinely non-obvious — if you have a clear best answer, give that answer.`)
	details.push(`Act, don't describe. If you can answer a question yourself by reading a file or running a tool, do that instead of asking the user.`)
	details.push(`When you finish a task, briefly state what you did and what you verified. Do not pad responses with offers like "let me know if you'd like me to...".`)

	if (mode === 'agent' || mode === 'gather') {
		details.push(`Only call tools if they help you accomplish the user's goal. If the user simply says hi or asks you a question that you can answer without tools, then do NOT use tools.`)
		details.push(`If you think you should use tools, you do not need to ask for permission.`)
		// Parallel tool calls are OK (and encouraged) when the operations are independent
		// — e.g. reading several files, searching several patterns. A single assistant
		// turn that batches N reads costs one round-trip instead of N, and prefix caching
		// stays warm across the whole batch. Keep sequential tools for dependent steps
		// where later arguments require earlier results.
		// Auto-generate the read-only tool list from approvalTypeOfBuiltinToolName so this
		// stays in sync when tools are added/removed. A tool is read-only iff it is NOT in
		// approvalTypeOfBuiltinToolName (absence from that map is already how Void decides
		// what's safe to auto-allow), which is the exact semantic we want here.
		const readOnlyToolNames = builtinToolNames
			.filter(n => approvalTypeOfBuiltinToolName[n] === undefined)
			.map(n => `\`${n}\``)
			.join(', ')
		details.push(`Read-only tools (${readOnlyToolNames}) can be called in parallel in one turn when their arguments are independent — prefer batching them over issuing them one-at-a-time. Concrete example: when a search or list returns multiple files you want to inspect, call ALL the reads/lookups in ONE turn (one assistant message with multiple tool calls) — NOT one per turn. Per-turn reads compound input tokens for every subsequent call. Use separate turns only when a later tool's arguments depend on an earlier tool's result.`)
		// Perf 2 — trimmed tool results hint. Older data-fetching tool outputs in the
		// conversation history may have their bodies replaced with a short marker
		// (starting with "[trimmed — ...]"). The model needs to know this is expected
		// behavior so it doesn't get confused by the partial content and so it knows
		// the remedy is simply to re-run the tool if it needs the details.
		details.push(`Older tool results in this conversation may appear with their bodies replaced by a short marker beginning with "[trimmed — ...]". This is normal — it means the full output was elided from the prompt to save context. If you need details that were removed, re-run the appropriate tool; do not assume or fabricate what the trimmed content contained.`)
		details.push(`NEVER say something like "I'm going to use \`tool_name\`". Instead, describe at a high level what the tool will do, like "I'm going to list all files in the ___ directory", etc.`)
		details.push(`Many tools only work if the user has a workspace open.`)
	}
	else {
		details.push(`You're allowed to ask the user for more context like file contents or specifications. If this comes up, tell them to reference files and folders by typing @.`)
	}

	if (mode === 'agent') {
		// A3 — Agent loop framing. Explicit phase structure the model can
		// self-check against, instead of the implicit "do everything in some
		// order" shape. Helps weaker models (Nemotron) not skip steps and gives
		// stronger models (MiniMax) a natural exit point ("we're in verify,
		// stop adding steps") to curb post-A1+A2 over-iteration. The phases
		// are a self-check, not required output — we deliberately do NOT ask
		// the model to announce which phase it's in.
		details.push(`Follow this loop on every task: understand the user's intent → investigate the relevant code → diagnose the actual problem → act with focused changes → verify the change worked. Use the loop as a self-check: don't act without investigating first, and don't keep investigating after you've already acted and verified.`)

		details.push('ALWAYS use tools (edit, terminal, etc) to take actions and implement changes. For example, if you would like to edit a file, you MUST use a tool.')

		// Phase C5 — Tool selection discipline. Reinforces the anti-fallback
		// guidance that lives in each tool's description (Phase C1 + C2),
		// placed here as a second surface because eval showed one-place rules
		// get ignored by smaller models (Gemma's no-tables pathology in A1+A2
		// eval; Gemma's persistent `find`-fallback after C1-only change). Rules
		// that appear in tool descriptions AND importantDetails get followed
		// more reliably than rules that appear in one surface only.
		details.push(`For file and directory operations, always use the dedicated tool — never shell out via \`run_command\`: use \`read_file\` (not \`cat\`), \`ls_dir\` or \`get_dir_tree\` (not \`ls\` / \`tree\`), \`search_pathnames_only\` (not \`find\`), \`search_in_file\` or \`search_for_files\` (not \`grep\`), and \`edit_file\` or \`rewrite_file\` (not \`sed\` / \`echo >\`). When searching code: use \`go_to_definition\`/\`go_to_usages\` for named symbols, \`search_in_file\`/\`search_for_files\` for exact strings, and \`semantic_search\` for conceptual/intent queries where there's no exact string to match. Pick the right tool upfront — don't cascade through multiple search tools for the same query. \`run_command\` is for things the dedicated tools don't do — installing packages, running tests, git operations, build commands.`)

		// A4 — Rebalance over-iteration. Replaces three compounding rules
		// ("maximal certainty BEFORE" + "OFTEN need to gather context" +
		// "prioritize as many steps as needed over stopping early") that
		// produced "read everything, deliberate forever" behavior. A1+A2 eval
		// data: Nemotron +90% tokens, MiniMax +18%; user-reported "long
		// interactions for one console.log". Safety intent is preserved, but
		// certainty and step count are scaled to reversibility — high
		// certainty for hard-to-undo work, act-and-verify for low-stakes.
		details.push(`Gather *enough* context to be confident, not maximal context. A senior engineer reads what they need and stops. If the answer is obvious from what you've already read this turn, don't keep searching.`)
		details.push(`Take as many steps as the task genuinely requires — but don't pad. If you can finish in two tool calls, finish in two. Don't re-read files you've already read this turn, and don't run redundant verification commands.`)
		details.push(`Have *high* certainty before changes that are hard to undo (file rewrites, deletes, terminal commands that modify state, git operations). For low-stakes changes (adding a log line, tweaking one expression, small edits to fresh code), act and verify with a quick test rather than deliberating up front.`)

		// Phase D2 — editing philosophy. Counters over-engineering patterns
		// (extract-single-use-helpers, speculative backward-compat) observed
		// across MiniMax and Gemma. ~40 tokens, high behavioral impact.
		details.push(`Prefer the smallest correct change. Don't extract single-use helpers, don't add backward-compatibility code without concrete need (persisted data, external consumers, explicit user requirement). Follow existing code conventions — naming, structure, framework choices, imports. Read surrounding code before editing.`)

		// Phase D2 — anti-stalling. Prevents models from announcing actions
		// without executing them in the same turn.
		details.push(`When you say you will do something, do it in the same turn. Don't announce actions without executing them.`)

		details.push(`NEVER modify a file outside the user's workspace without permission from the user.`)

		// Phase D2 — safety. Prevents accidental secret exposure and
		// interference with concurrent user edits.
		details.push(`Never introduce code that exposes, logs, or commits secrets, API keys, or credentials.`)
		details.push(`If you notice unexpected file changes you did not make, continue with your task — do not revert changes made by the user or other processes.`)
	}

	if (mode === 'gather') {
		details.push(`You are in Gather mode, so you MUST use tools to gather information, files, and context to help the user answer their query.`)
		// Softened from "extensively read ... gathering full context" — that
		// maximalist framing encouraged re-reading and reading-past-the-answer.
		// Breadth intent is kept, but scoped to what the question needs.
		details.push(`Read broadly and follow references across files, but stop once you have enough to answer the question with confidence. Don't re-read files you've already read this turn, and don't chase tangents unrelated to the user's query.`)
		// Lightweight loop — no "act" or "verify" phase since gather can't
		// edit or run code. Keeps the self-check benefit without forcing a
		// shape the mode can't execute.
		details.push(`On each question: understand what the user is actually asking → investigate the relevant code → form a grounded answer. Use this as a self-check that you're answering the question, not just dumping context.`)
	}

	if (mode === 'agent') {
		// Trimmed from the universal format rule: "FULL PATH as first line" +
		// "contents of the file should proceed as usual" describe the shape of
		// an edit-via-code-block, which is only meaningful in gather/normal
		// (where code blocks ARE the edit mechanism). In agent mode those
		// bullets compete with `ALWAYS use tools` and empirically caused Gemma
		// to emit inline <<<< ORIGINAL / >>>> UPDATED diffs instead of calling
		// edit_file (A3+A4 eval, Tests 1 Before + 2 After). Keeping only the
		// generally-useful language-tag rule.
		details.push(`If you write any code blocks to the user (wrapped in triple backticks), include a language tag (e.g. \`typescript\`, \`shell\`). Terminal commands should have the language \`shell\`.`)
	}
	else {
		details.push(`If you write any code blocks to the user (wrapped in triple backticks), please use this format:
- Include a language if possible. Terminal should have the language 'shell'.
- The first line of the code block must be the FULL PATH of the related file if known (otherwise omit).
- The remaining contents of the file should proceed as usual.`)
	}

	if (mode === 'gather' || mode === 'normal') {

		details.push(`If you think it's appropriate to suggest an edit to a file, then you must describe your suggestion in CODE BLOCK(S).
- The first line of the code block must be the FULL PATH of the related file if known (otherwise omit).
- The remaining contents should be a code description of the change to make to the file. \
Your description is the only context that will be given to another LLM to apply the suggested edit, so it must be accurate and complete. \
Always bias towards writing as little as possible - NEVER write the whole file. Use comments like "// ... existing code ..." to condense your writing. \
Here's an example of a good code block:\n${chatSuggestionDiffExample}`)
	}

	details.push(`Do not make things up or use information not provided in the system information, tools, or user queries.`)
	details.push(`Always use MARKDOWN to format lists, bullet points, etc. Do NOT write tables.`)
	// Phase D2 — response formatting. Standardizes code references and
	// list depth across models. ~25 tokens.
	details.push(`When referencing code, use \`file_path:line_number\` format. Keep lists flat (single level) — if you need hierarchy, split into separate sections.`)
	details.push(`LaTeX math is supported. Use $...$ for inline math and $$...$$ for display math (\\(...\\) and \\[...\\] also work).`)

	const importantDetails = (`Important notes:
${details.map((d, i) => `${i + 1}. ${d}`).join('\n\n')}`)

	// System message contains ONLY stable content (persona, rules, tool definitions)
	// so the entire system prefix is eligible for cross-turn prefix caching. Anything
	// that can change between turns (active file, open tabs, today's date, directory
	// listing, terminal IDs) lives in `chat_volatileContext` and is baked into each
	// user message's stored content at thread-creation time by chatThreadService.
	// That keeps historical turns byte-identical across subsequent requests so the
	// provider's prefix cache stays warm as the conversation grows.
	const ansStrs: string[] = []
	ansStrs.push(header)
	ansStrs.push(importantDetails)
	if (toolDefinitions) ansStrs.push(toolDefinitions)

	const fullSystemMsgStr = ansStrs
		.join('\n\n\n')
		.trim()
		.replace('\t', '  ')

	return fullSystemMsgStr

}


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], openedURIs: [], activeURI: 'pee', persistentTerminalIDs: [], directoryStr: 'lol', }))
// }

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string,
	truncated: boolean,
	fullFileLen: number,
} | {
	val: null,
	truncated?: undefined
	fullFileLen?: undefined,
}> => {
	try {
		const fileContent = await fileService.readFile(uri)
		const val = fileContent.value.toString()
		if (val.length > fileSizeLimit) return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }
		return { val, truncated: false, fullFileLen: val.length }
	}
	catch (e) {
		return { val: null }
	}
}





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService,
		folderOpts: {
			maxChildren: number,
			maxCharsPerFile: number,
		}
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`

	if (s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)
		const lines = val?.split('\n')

		const innerVal = lines?.slice(s.range[0] - 1, s.range[1]).join('\n')
		const content = !lines ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`
		const str = `${s.uri.fsPath}${lineNumAddition(s.range)}:\n${content}`
		return str
	}
	else if (s.type === 'File') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)

		const innerVal = val
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`

		const str = `${s.uri.fsPath}:\n${content}`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren })
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile)
			const truncationStr = truncated ? `\n... file truncated ...` : ''
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`
			const str = `${uri.fsPath}:\n${content}`
			return str
		}))
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n')
		return contentStr
	}
	else if (s.type === 'Terminal') {
		// Header carries the structured metadata (command, cwd, exitCode) so the
		// model can reason about success/failure without parsing the body. We
		// emit only fields we have — selection-mode captures usually lack
		// command/exitCode/cwd, and including empty `cwd: ` lines just trains
		// the model to expect them.
		const headerParts: string[] = []
		if (s.command) headerParts.push(`command: ${s.command}`)
		if (s.cwd) headerParts.push(`cwd: ${s.cwd}`)
		if (typeof s.exitCode === 'number') headerParts.push(`exit code: ${s.exitCode}`)
		const header = s.command
			? `Terminal output (${headerParts.join(', ')})`
			: headerParts.length > 0
				? `Terminal selection (${headerParts.join(', ')})`
				: `Terminal selection`
		const body = `${tripleTick[0]}${s.language}\n${s.text}\n${tripleTick[1]}`
		return `${header}:\n${body}`
	}
	else if (s.type === 'Image') {
		return `[Image attached: ${s.fileName}]`
	}
	else
		return ''

}


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService
	},
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).map(async (s) =>
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	)


	let str = ''
	str += `${instructions}`

	const selnsStr = selnsStrs.join('\n\n') ?? ''
	if (selnsStr) str += `\n---\nSELECTIONS\n${selnsStr}`
	return str;
}


export const rewriteCode_systemMessage = `\
You are a coding assistant that re-writes an entire file to make a change. You are given the original file \`ORIGINAL_FILE\` and a change \`CHANGE\`.

Directions:
1. Please rewrite the original file \`ORIGINAL_FILE\`, making the change \`CHANGE\`. You must completely re-write the whole file.
2. Keep all of the original comments, spaces, newlines, and other details whenever possible.
3. ONLY output the full new file. Do not add any other explanations or text.
`



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr: string, language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
Please finish writing the new file by applying the change to the original file. Return ONLY the completion of the file, without any explanation.
`
}



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`





export const voidPrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string, startLine: number, endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n')

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = ''
	let i = startLine - 1  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1]
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`
			i -= 1
		}
		else break
	}

	let suffix = ''
	let j = endLine - 1
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1]
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`
			j += 1
		}
		else break
	}

	return { prefix, suffix }

}


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
}

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
You are a FIM (fill-in-the-middle) coding assistant. Your task is to fill in the middle SELECTION marked by <${midTag}> tags.

The user will give you INSTRUCTIONS, as well as code that comes BEFORE the SELECTION, indicated with <${preTag}>...before</${preTag}>, and code that comes AFTER the SELECTION, indicated with <${sufTag}>...after</${sufTag}>.
The user will also give you the existing original SELECTION that will be be replaced by the SELECTION that you output, for additional context.

Instructions:
1. Your OUTPUT should be a SINGLE PIECE OF CODE of the form <${midTag}>...new_code</${midTag}>. Do NOT output any text or explanations before or after this.
2. You may ONLY CHANGE the original SELECTION, and NOT the content in the <${preTag}>...</${preTag}> or <${sufTag}>...</${sufTag}> tags.
3. Make sure all brackets in the new selection are balanced the same as in the original selection.
4. Be careful not to duplicate or remove variables, comments, or other syntax by mistake.
`
}

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {
	const { preTag, sufTag, midTag } = fimTags

	// prompt the model artifically on how to do FIM
	// const preTag = 'BEFORE'
	// const sufTag = 'AFTER'
	// const midTag = 'SELECTION'
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

<${preTag}>${prefix}</${preTag}>
<${sufTag}>${suffix}</${sufTag}>

Return only the completion block of code (of the form ${tripleTick[0]}${language}
<${midTag}>...new code</${midTag}>
${tripleTick[1]}).`
};







/*
// ======================================================== ai search/replace ========================================================


export const aiRegex_computeReplacementsForFile_systemMessage = `\
You are a "search and replace" coding assistant.

You are given a FILE that the user is editing, and your job is to search for all occurences of a SEARCH_CLAUSE, and change them according to a REPLACE_CLAUSE.

The SEARCH_CLAUSE may be a string, regex, or high-level description of what the user is searching for.

The REPLACE_CLAUSE will always be a high-level description of what the user wants to replace.

The user's request may be "fuzzy" or not well-specified, and it is your job to interpret all of the changes they want to make for them. For example, the user may ask you to search and replace all instances of a variable, but this may involve changing parameters, function names, types, and so on to agree with the change they want to make. Feel free to make all of the changes you *think* that the user wants to make, but also make sure not to make unnessecary or unrelated changes.

## Instructions

1. If you do not want to make any changes, you should respond with the word "no".

2. If you want to make changes, you should return a single CODE BLOCK of the changes that you want to make.
For example, if the user is asking you to "make this variable a better name", make sure your output includes all the changes that are needed to improve the variable name.
- Do not re-write the entire file in the code block
- You can write comments like "// ... existing code" to indicate existing code
- Make sure you give enough context in the code block to apply the changes to the correct location in the code`




// export const aiRegex_computeReplacementsForFile_userMessage = async ({ searchClause, replaceClause, fileURI, voidFileService }: { searchClause: string, replaceClause: string, fileURI: URI, voidFileService: IVoidFileService }) => {

// 	// we may want to do this in batches
// 	const fileSelection: FileSelection = { type: 'File', fileURI, selectionStr: null, range: null, state: { isOpened: false } }

// 	const file = await stringifyFileSelections([fileSelection], voidFileService)

// 	return `\
// ## FILE
// ${file}

// ## SEARCH_CLAUSE
// Here is what the user is searching for:
// ${searchClause}

// ## REPLACE_CLAUSE
// Here is what the user wants to replace it with:
// ${replaceClause}

// ## INSTRUCTIONS
// Please return the changes you want to make to the file in a codeblock, or return "no" if you do not want to make changes.`
// }




// // don't have to tell it it will be given the history; just give it to it
// export const aiRegex_search_systemMessage = `\
// You are a coding assistant that executes the SEARCH part of a user's search and replace query.

// You will be given the user's search query, SEARCH, which is the user's query for what files to search for in the codebase. You may also be given the user's REPLACE query for additional context.

// Output
// - Regex query
// - Files to Include (optional)
// - Files to Exclude? (optional)

// `






// ======================================================== old examples ========================================================

Do not tell the user anything about the examples below. Do not assume the user is talking about any of the examples below.

## EXAMPLE 1
FILES
math.ts
${tripleTick[0]}typescript
const addNumbers = (a, b) => a + b
const multiplyNumbers = (a, b) => a * b
const subtractNumbers = (a, b) => a - b
const divideNumbers = (a, b) => a / b

const vectorize = (...numbers) => {
	return numbers // vector
}

const dot = (vector1: number[], vector2: number[]) => {
	if (vector1.length !== vector2.length) throw new Error(\`Could not dot vectors \${vector1} and \${vector2}. Size mismatch.\`)
	let sum = 0
	for (let i = 0; i < vector1.length; i += 1)
		sum += multiplyNumbers(vector1[i], vector2[i])
	return sum
}

const normalize = (vector: number[]) => {
	const norm = Math.sqrt(dot(vector, vector))
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = divideNumbers(vector[i], norm)
	return vector
}

const normalized = (vector: number[]) => {
	const v2 = [...vector] // clone vector
	return normalize(v2)
}
${tripleTick[1]}


SELECTIONS
math.ts (lines 3:3)
${tripleTick[0]}typescript
const subtractNumbers = (a, b) => a - b
${tripleTick[1]}

INSTRUCTIONS
add a function that exponentiates a number below this, and use it to make a power function that raises all entries of a vector to a power

## ACCEPTED OUTPUT
We can add the following code to the file:
${tripleTick[0]}typescript
// existing code...
const subtractNumbers = (a, b) => a - b
const exponentiateNumbers = (a, b) => Math.pow(a, b)
const divideNumbers = (a, b) => a / b
// existing code...

const raiseAll = (vector: number[], power: number) => {
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = exponentiateNumbers(vector[i], power)
	return vector
}
${tripleTick[1]}


## EXAMPLE 2
FILES
fib.ts
${tripleTick[0]}typescript

const dfs = (root) => {
	if (!root) return;
	console.log(root.val);
	dfs(root.left);
	dfs(root.right);
}
const fib = (n) => {
	if (n < 1) return 1
	return fib(n - 1) + fib(n - 2)
}
${tripleTick[1]}

SELECTIONS
fib.ts (lines 10:10)
${tripleTick[0]}typescript
	return fib(n - 1) + fib(n - 2)
${tripleTick[1]}

INSTRUCTIONS
memoize results

## ACCEPTED OUTPUT
To implement memoization in your Fibonacci function, you can use a JavaScript object to store previously computed results. This will help avoid redundant calculations and improve performance. Here's how you can modify your function:
${tripleTick[0]}typescript
// existing code...
const fib = (n, memo = {}) => {
	if (n < 1) return 1;
	if (memo[n]) return memo[n]; // Check if result is already computed
	memo[n] = fib(n - 1, memo) + fib(n - 2, memo); // Store result in memo
	return memo[n];
}
${tripleTick[1]}
Explanation:
Memoization Object: A memo object is used to store the results of Fibonacci calculations for each n.
Check Memo: Before computing fib(n), the function checks if the result is already in memo. If it is, it returns the stored result.
Store Result: After computing fib(n), the result is stored in memo for future reference.

## END EXAMPLES

*/


// ======================================================== scm ========================================================================

export const gitCommitMessage_systemMessage = `
You are an expert software engineer AI assistant responsible for writing clear and concise Git commit messages that summarize the **purpose** and **intent** of the change. Try to keep your commit messages to one sentence. If necessary, you can use two sentences.

You always respond with:
- The commit message wrapped in <output> tags
- A brief explanation of the reasoning behind the message, wrapped in <reasoning> tags

Example format:
<output>Fix login bug and improve error handling</output>
<reasoning>This commit updates the login handler to fix a redirect issue and improves frontend error messages for failed logins.</reasoning>

Do not include anything else outside of these tags.
Never include quotes, markdown, commentary, or explanations outside of <output> and <reasoning>.`.trim()


/**
 * Create a user message for the LLM to generate a commit message. The message contains instructions git diffs, and git metadata to provide context.
 *
 * @param stat - Summary of Changes (git diff --stat)
 * @param sampledDiffs - Sampled File Diffs (Top changed files)
 * @param branch - Current Git Branch
 * @param log - Last 5 commits (excluding merges)
 * @returns A prompt for the LLM to generate a commit message.
 *
 * @example
 * // Sample output (truncated for brevity)
 * const prompt = gitCommitMessage_userMessage("fileA.ts | 10 ++--", "diff --git a/fileA.ts...", "main", "abc123|Fix bug|2025-01-01\n...")
 *
 * // Result:
 * Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.
 *
 * Section 1 - Summary of Changes (git diff --stat):
 * fileA.ts | 10 ++--
 *
 * Section 2 - Sampled File Diffs (Top changed files):
 * diff --git a/fileA.ts b/fileA.ts
 * ...
 *
 * Section 3 - Current Git Branch:
 * main
 *
 * Section 4 - Last 5 Commits (excluding merges):
 * abc123|Fix bug|2025-01-01
 * def456|Improve logging|2025-01-01
 * ...
 */
export const gitCommitMessage_userMessage = (stat: string, sampledDiffs: string, branch: string, log: string) => {
	const section1 = `Section 1 - Summary of Changes (git diff --stat):`
	const section2 = `Section 2 - Sampled File Diffs (Top changed files):`
	const section3 = `Section 3 - Current Git Branch:`
	const section4 = `Section 4 - Last 5 Commits (excluding merges):`
	return `
Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.

${section1}

${stat}

${section2}

${sampledDiffs}

${section3}

${branch}

${section4}

${log}`.trim()
}


// ======================================================== vision helper ========================================================================

export const visionHelper_systemMessage = `You are a visual assistant for another AI model that cannot see images. Your job is to be its "eyes" — describe what you see so it can understand and respond to the user as if it saw the image itself.

Focus on:
- UI layout and visual structure
- Text content, labels, error messages
- Code snippets (reproduce them exactly if visible)
- Colors, icons, and visual states (e.g. selected, disabled, highlighted)
- Any arrows, annotations, or highlights the user may have added

Be thorough and specific. Do not speculate about the user's intent — just describe what is visible. If the user's message gives context about what they care about, prioritize describing those aspects.`

export const visionHelper_userMessage = (fileName: string, userMessage?: string) => {
	let prompt = `Describe this image in detail: ${fileName}`
	if (userMessage && userMessage.trim()) {
		prompt += `\n\nContext hint (do NOT answer this — only use it to decide what parts of the image to prioritize): "${userMessage.trim()}"`
	}
	return prompt
}
