import { URI } from '../../../../base/common/uri.js'
import { RawMCPToolCall } from './mcpServiceTypes.js';
import { Edit } from './editCodeServiceTypes.js';
import { SnakeCaseKeys } from './prompt/prompts.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';
import type { ChildThreadSummary, SubagentOutcome } from './childThreadLinkage.js';



export type TerminalResolveReason =
	| { type: 'timeout', reason: 'inactivity' | 'backstop' }
	| { type: 'done', exitCode: number }

export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}


// Approval tiers for built-in tools. Kept separate so users can opt into auto-approve at different
// safety levels:
//   - 'edits'    = reversible changes (edit_file is revertable through its diff zone's undo,
//                  create/rewrite likewise). Workspace-scoped when auto-approved (see chatThreadService).
//   - 'delete'   = irreversible destructive ops (delete_file_or_folder). Split out from 'edits' so
//                  auto-approving normal edits doesn't silently enable auto-delete. Also workspace-
//                  scoped when auto-approved.
//   - 'terminal' = run_command and persistent terminal ops. NOT workspace-scoped (commands can
//                  legitimately operate outside the workspace, e.g. `brew install`).
//   - 'MCP tools'= all MCP tools; unscoped.
export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'delete' | 'terminal' | 'MCP tools' }> = {
	'create_file_or_folder': 'edits',
	'delete_file_or_folder': 'delete',
	'rename_file_or_folder': 'edits',
	'rewrite_file': 'edits',
	'edit_file': 'edits',
	'run_command': 'terminal',
	'run_persistent_command': 'terminal',
	'open_persistent_terminal': 'terminal',
	'kill_persistent_terminal': 'terminal',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]>;


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
])

// Tools that hand work to a child agent. They are `agent`-only, and that is not a
// consequence of the approval table above: delegation needs no approval, so they
// would otherwise pass the `gather` filter (`everything not in
// approvalTypeOfBuiltinToolName`) and let a read-only investigation spawn a child
// that can write. The mode is `agent`'s alone because delegation *is* acting.
export const delegationToolNames = new Set<BuiltinToolName>(['run_subagent', 'send_message', 'list_children'])

// Tools only a *child* may use. `report_to_parent` is the child's half of the result
// contract: the parent's outcome carries what the child chose to convey, not the last
// thing it happened to type. A top-level thread has no parent to report to, so the tool
// is not in its list at all — an affordance a model cannot use is one it will misuse.
export const subagentOnlyToolNames = new Set<BuiltinToolName>(['report_to_parent'])

/**
 * Whether a chat mode may use one builtin tool.
 *
 * Pure and here rather than beside `availableTools` in `browser/`, because it is the
 * one rule in tool selection that can be wrong in a way nobody sees: `gather` is
 * read-only by construction — it keeps every tool that needs no approval — and
 * delegation needs no approval, so a child spawned from `gather` would hand a
 * read-only mode the ability to write. A rule that decides that has to be testable
 * without a running workbench.
 *
 * `normal` has no tools at all: it is the chat-only mode.
 */
export const isToolAvailableInChatMode = (
	toolName: BuiltinToolName,
	chatMode: 'agent' | 'gather' | 'normal',
	isSubagentThread = false,
): boolean => {
	// Subagent-only tools answer a different question than the mode does: *who is
	// running*. A parent has no parent to report to, so the tool is absent from its list
	// rather than present and refusing.
	if (subagentOnlyToolNames.has(toolName)) return isSubagentThread && chatMode === 'agent'
	if (chatMode === 'agent') return true
	if (chatMode === 'normal') return false
	return !(toolName in approvalTypeOfBuiltinToolName) && !delegationToolNames.has(toolName)
}


// Auto-approve mode per tier. Tri-state:
//   'off'       — always prompt
//   'workspace' — auto-approve when the target is inside an open workspace folder; prompt otherwise
//   'all'       — auto-approve regardless of path
// For tiers that don't have a meaningful workspace scope ('terminal', 'MCP tools'), 'workspace'
// is rendered in UI as a simple on/off and stored as 'all' when enabled. See
// `approvalIsWorkspaceScoped` below.
export type AutoApproveMode = 'off' | 'workspace' | 'all'

// Returns true if the tier's behavior differs between a workspace-internal vs external path.
// Only file-modification tiers are workspace-scoped today: `edits` and `delete`.
export const approvalIsWorkspaceScoped = (t: ToolApprovalType): boolean =>
	t === 'edits' || t === 'delete'

// Normalizes stored auto-approve values to the tri-state enum. Accepts the legacy boolean shape
// that was written before the tri-state was introduced:
//   true  → 'workspace' (safe default — opt into 'all' explicitly via the radio)
//   false → 'off'
export const normalizeAutoApproveMode = (raw: AutoApproveMode | boolean | undefined): AutoApproveMode => {
	if (raw === undefined) return 'off'
	if (typeof raw === 'boolean') return raw ? 'workspace' : 'off'
	return raw
}


// ===== Per-chat (per-thread) permission modes =====
//
// A coarse, user-facing permission level selectable per chat thread from the
// chat input box (same row as model selection). It acts as an *additional*
// source of auto-approval on top of the global per-tier `autoApprove` config:
// the effective mode per tier is whichever of the two allows more ("union"
// semantics — a chat can grant more than config, never less).
//   - 'read_only'      → grants nothing. Approval is governed by config +
//                        the per-workspace terminal allowlist, exactly like
//                        threads created before this feature existed.
//   - 'workspace_write'→ auto-approves workspace-scoped file edits and
//                        deletes (tier modes 'workspace'). Terminal and MCP
//                        tools are NOT granted — commands stay governed by
//                        config + allowlist; pick 'full_access' for those.
//   - 'full_access'    → auto-approves every tier ('all').
export type ThreadPermissionMode = 'read_only' | 'workspace_write' | 'full_access'

export const threadPermissionModes: ThreadPermissionMode[] = ['read_only', 'workspace_write', 'full_access']

// Per-tier auto-approve mode granted by each thread permission mode. Keys are
// ordered exactly like `toolApprovalTypes`' members; the 'terminal' and
// 'MCP tools' entries for 'workspace_write' are deliberately 'off' (see above).
export const threadModeToTierAutoApprove: { [mode in ThreadPermissionMode]: { [approvalType in ToolApprovalType]: AutoApproveMode } } = {
	'read_only': { 'edits': 'off', 'delete': 'off', 'terminal': 'off', 'MCP tools': 'off' },
	'workspace_write': { 'edits': 'workspace', 'delete': 'workspace', 'terminal': 'off', 'MCP tools': 'off' },
	'full_access': { 'edits': 'all', 'delete': 'all', 'terminal': 'all', 'MCP tools': 'all' },
}

// Normalizes a persisted thread permission mode. Anything unknown (including
// `undefined` — threads persisted before this feature existed) maps to
// 'read_only', which grants nothing and therefore preserves pre-feature
// behavior exactly.
export const normalizeThreadPermissionMode = (raw: ThreadPermissionMode | undefined): ThreadPermissionMode => {
	if (raw === 'workspace_write' || raw === 'full_access') return raw
	return 'read_only'
}

// Returns the more permissive of two auto-approve modes. Used to combine the
// global config mode with the per-thread grant: "whichever allows access".
const _autoApproveModeRank: { [mode in AutoApproveMode]: number } = { 'off': 0, 'workspace': 1, 'all': 2 }
export const combineAutoApproveModes = (a: AutoApproveMode, b: AutoApproveMode): AutoApproveMode =>
	_autoApproveModeRank[a] >= _autoApproveModeRank[b] ? a : b

// Effective per-tier auto-approve mode for a tool call on a thread: the more
// permissive of the global config mode and the thread's permission-mode grant.
// Single place where the union semantics live, shared by the approval gate in
// `chatThreadService` and the UI that pre-hides buttons for auto-approved tools.
export const effectiveAutoApproveMode = (
	approvalType: ToolApprovalType,
	configMode: AutoApproveMode | boolean | undefined,
	threadMode: ThreadPermissionMode | undefined,
): AutoApproveMode => {
	const config = normalizeAutoApproveMode(configMode)
	const grant = threadModeToTierAutoApprove[normalizeThreadPermissionMode(threadMode)][approvalType]
	return combineAutoApproveModes(config, grant)
}




// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	'read_file': { uri: URI, startLine: number | null, endLine: number | null, pageNumber: number },
	'ls_dir': { uri: URI, pageNumber: number },
	'get_dir_tree': { uri: URI },
	'search_pathnames_only': { query: string, includePattern: string | null, pageNumber: number },
	'search_for_files': { query: string, isRegex: boolean, searchInFolder: URI | null, pageNumber: number },
	'search_in_file': { uri: URI, query: string, isRegex: boolean },
	'go_to_definition': { uri: URI, symbolName: string, line: number | null },
	'go_to_usages': { uri: URI, symbolName: string, line: number | null, pageNumber: number },
	'read_lint_errors': { uri: URI },
	// ---
	'rewrite_file': { uri: URI, newContent: string },
	'edit_file': { uri: URI, edits: Edit[] },
	'create_file_or_folder': { uri: URI, isFolder: boolean },
	'delete_file_or_folder': { uri: URI, isRecursive: boolean, isFolder: boolean },
	'rename_file_or_folder': { sourceUri: URI, targetUri: URI, overwrite: boolean },
	// ---
	'run_command': { command: string; cwd: string | null, terminalId: string, timeoutSeconds: number },
	'open_persistent_terminal': { cwd: string | null },
	'run_persistent_command': { command: string; persistentTerminalId: string, timeoutSeconds: number },
	'kill_persistent_terminal': { persistentTerminalId: string },
	// --- terminal read ---
	'read_terminal': { terminalName: string, lastNCommands: number | null },
	// --- web ---
	'fetch_url': { url: string },
	// --- semantic search ---
	'semantic_search': { query: string, nResults: number, includePattern: string | null },
	// --- history ---
	'search_history': { query: string | null, toolName: string | null, resultStatus: 'error' | 'success' | null, contextRadius: number },
	// --- skills ---
	'load_skill': { skillName: string },
	// --- delegation ---
	// `task` is the child's whole role: there is no agent catalogue to choose from,
	// so the instruction *is* the definition. `alias` is the name the parent will
	// use to address this child again (`send_message`) and to read its card.
	'run_subagent': { alias: string, task: string },
	// Addressing is by id *or* alias, because the two fail differently: an alias is
	// what the parent coined and can carry in prose, and the id is what `list_children`
	// returns after a compaction has eaten the alias. Exactly one is required.
	'send_message': { childThreadId: string | null, alias: string | null, message: string },
	'list_children': {},
	// The child's own verb. Its argument is what the parent receives, which is why it is a
	// deliberate summary rather than whatever the child happened to say last.
	'report_to_parent': { summary: string },
}

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	'read_file': { outlined: false, fileContents: string, totalFileLen: number, totalNumLines: number, hasNextPage: boolean }
		| { outlined: true, outlineText: string, totalFileLen: number, totalNumLines: number },
	'ls_dir': { children: ShallowDirectoryItem[] | null, hasNextPage: boolean, hasPrevPage: boolean, itemsRemaining: number },
	'get_dir_tree': { str: string, },
	'search_pathnames_only': { uris: URI[], hasNextPage: boolean },
	'search_for_files': { uris: URI[], hasNextPage: boolean },
	'search_in_file': { lines: number[], lineContentOfLineNumber: Record<number, string> },
	'go_to_definition': { locations: { uri: URI, line: number, column: number }[] },
	'go_to_usages': { locations: { uri: URI, line: number, column: number }[], hasNextPage: boolean },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'create_file_or_folder': {},
	'delete_file_or_folder': {},
	'rename_file_or_folder': {},
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; },
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason; },
	'open_persistent_terminal': { persistentTerminalId: string },
	'kill_persistent_terminal': {},
	// --- terminal read ---
	'read_terminal': { output: string, status: string, commands: { command: string, exitCode: number | null, duration: number }[] },
	// --- semantic search ---
	'semantic_search': { results: { uri: URI, startLine: number, endLine: number, snippet: string, score: number, indexStatus: string, indexProgress: { indexed: number, total: number } }[], noResultReason?: string },
	// --- web ---
	'fetch_url': { title: string, content: string, url: string },
	// --- history ---
	'search_history': { matches: string, totalMatches: number },
	// --- skills ---
	'load_skill': { content: string },
	// --- delegation ---
	// The bounded result the parent receives. Not the child's transcript — see
	// `SubagentOutcome`.
	'run_subagent': SubagentOutcome,
	// Same contract: continuing a child reports how *that* turn ended, not a
	// different shape the parent would have to learn.
	'send_message': SubagentOutcome,
	'list_children': { children: ChildThreadSummary[] },
	'report_to_parent': { received: true },
}


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof SnakeCaseKeys<BuiltinToolCallParams[T]>
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName]


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string
