# Tool Definition Restructuring

## Problem

Each built-in tool's definition is spread across **7 locations in 4 files**. Adding or modifying a tool requires touching all of them, and they're hundreds of lines apart within each file:

| Segment | File | Location |
|---|---|---|
| Params type | `common/toolsServiceTypes.ts` | `BuiltinToolCallParams[T]` |
| Result type | `common/toolsServiceTypes.ts` | `BuiltinToolResultType[T]` |
| Approval tier | `common/toolsServiceTypes.ts` | `approvalTypeOfBuiltinToolName[T]` |
| LLM description | `common/prompt/prompts.ts` | `builtinTools[T]` (name, description, params) |
| Validate params | `browser/toolsService.ts` | `this.validateParams[T]` |
| Call tool | `browser/toolsService.ts` | `this.callTool[T]` (~200 lines later) |
| Stringify result | `browser/toolsService.ts` | `this.stringOfResult[T]` (~400 lines later) |
| UI title | `browser/react/.../ToolResultComponents.tsx` | `titleOfBuiltinToolName[T]` |
| UI desc | `browser/react/.../ToolResultComponents.tsx` | `toolNameToDesc` switch case |
| UI resultWrapper | `browser/react/.../ToolResultComponents.tsx` | `builtinToolNameToComponent[T].resultWrapper` |

The `load_skill` work demonstrated the problem: it was added to `BuiltinToolResultType` and `builtinTools` but missed the 3 UI mappings, causing a lint error. The `tool_request` rendering bug was another symptom — the `return null` for `tool_request` was duplicated across ~12 `resultWrapper` components, and each had to be fixed individually.

## Layering constraints

Three layers with a strict import direction: `electron-main` → `common` ← `browser`.

```
common/                    — no DI services, no React, importable by everyone
├── toolsServiceTypes.ts      BuiltinToolCallParams, BuiltinToolResultType (types)
├── prompt/prompts.ts         builtinTools (LLM descriptions), availableTools()
├── sendLLMMessageTypes.ts    IPC param types (ToolParamName, RawToolParamsObj)
└── directoryStrService.ts    ShallowDirectoryItem (used by result types)

electron-main/            — LLM API calls, tool call parsing
└── llmMessage/
    ├── sendLLMMessage.impl.ts   calls availableTools() to build API tool schemas
    └── extractGrammar.ts        calls availableTools() to detect XML tool tags

browser/                  — DI services, React, importable by nobody above
├── toolsService.ts            this.validateParams, this.callTool, this.stringOfResult
├── chatThreadService.ts       uses approvalTypeOfBuiltinToolName, BuiltinToolName
├── convertToLLMMessageService.ts  uses availableTools() via sendLLMMessage
└── react/.../ToolResultComponents.tsx  titleOfBuiltinToolName, toolNameToDesc, builtinToolNameToComponent
```

### What must stay in `common/`

1. **Type declarations** (`BuiltinToolCallParams[T]`, `BuiltinToolResultType[T]`) — used in type-level computations across all three layers. These are pure type annotations, not logic.

2. **`availableTools()` and `builtinTools`** — currently called directly from `electron-main` to:
   - Build provider-specific tool schemas (OpenAI function calling, Anthropic tool_use, Gemini function declarations) in `sendLLMMessage.impl.ts`
   - Detect XML tool call tags (`<read_file>...</read_file>`) in `extractGrammar.ts`

   `electron-main` cannot import from `browser/`. So either the descriptions stay in `common/`, or we change the IPC boundary to pass the pre-resolved tool list.

### What must stay in `browser/`

3. **Execution** (`validateParams`, `callTool`, `stringOfResult`) — requires DI services (`IFileService`, `ITerminalToolService`, `IEditCodeService`, etc.) only available in the browser layer.

4. **UI** (`title`, `desc`, `resultWrapper`) — requires React and accessor hooks (`useAccessor`).

## Solution

One file per tool in `browser/tools/`, containing all segments: description, approval, execution, and UI. The LLM descriptions are decoupled from `electron-main` by passing the resolved tool list across the IPC boundary instead of having `electron-main` compute it.

Type declarations stay in `common/toolsServiceTypes.ts` — they're type annotations, not logic. Each tool file references its types from there.

### Tool definition type

```typescript
// browser/tools/toolTypes.tsx
import React from 'react'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName, ToolApprovalType } from '../../common/toolsServiceTypes.js'
import { URI } from '../../../../../base/common/uri.js'

// All DI services any tool might need. Passed by the registry; individual tools
// pick what they need and ignore the rest.
export type ToolCtx = {
	fileService: IFileService
	voidModelService: IVoidModelService
	terminalToolService: ITerminalToolService
	editCodeService: IEditCodeService
	workspaceContextService: IWorkspaceContextService
	pathService: IPathService
	searchService: ISearchService
	markerService: IMarkerService
	languageFeaturesService: ILanguageFeaturesService
	commandService: ICommandService
	settingsService: IVoidSettingsService
	// ...
}

export type ToolDefinition<T extends BuiltinToolName> = {
	// --- LLM-facing ---
	name: T
	description: string
	params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }>

	// --- Approval ---
	approvalType: ToolApprovalType | undefined

	// --- Backend ---
	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => BuiltinToolCallParams[T]
	callTool: (params: BuiltinToolCallParams[T], ctx: ToolCtx) => Promise<{
		result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>
		interruptTool?: () => void
	}>
	stringOfResult: (params: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string

	// --- UI ---
	title: { done: React.ReactNode, proposed: React.ReactNode, running: React.ReactNode }
	desc: (params: BuiltinToolCallParams[T], accessor: ReturnType<typeof useAccessor>) => {
		desc1: React.ReactNode
		desc1Info?: string
	}
	resultWrapper: (props: WrapperProps<T>) => React.ReactNode
}
```

### Example tool file

```typescript
// browser/tools/readFile.tool.tsx
export const readFileTool: ToolDefinition<'read_file'> = {
	name: 'read_file',
	description: `Use this to read a file's contents when you need to inspect, quote, or reason about code...`,
	params: {
		uri: { description: 'Path to the file...' },
		start_line: { description: 'Optional. Line number to start reading from...' },
		end_line: { description: 'Optional. Line number to stop reading at...' },
		page_number: { description: 'Optional. The page number of the result. Default is 1.' },
	},
	approvalType: undefined,

	validateParams: (raw, ctx) => {
		const { uri: uriStr, start_line, end_line, page_number } = raw
		const uri = ctx.validateURI(uriStr)  // helper on ctx
		const pageNumber = validatePageNum(page_number)
		// ...
		return { uri, startLine, endLine, pageNumber }
	},

	callTool: async ({ uri, startLine, endLine, pageNumber }, ctx) => {
		await ctx.voidModelService.initializeModel(uri)
		const { model } = await ctx.voidModelService.getModelSafe(uri)
		// ...
		return { result: { outlined: false, fileContents, totalFileLen, totalNumLines, hasNextPage } }
	},

	stringOfResult: (params, result) => {
		if (result.outlined) return `SUCCESS: File outline...`
		return `${params.uri.fsPath}\n${fence}\n${result.fileContents}\n${fence}`
	},

	title: { done: 'Read file', proposed: 'Read file', running: loadingTitleWrapper('Reading file') },
	desc: (params, accessor) => ({
		desc1: getBasename(params.uri.fsPath),
		desc1Info: getRelative(params.uri, accessor),
	}),
	resultWrapper: ({ toolMessage }) => {
		// ... existing resultWrapper logic
	},
}
```

### Registry

```typescript
// browser/tools/toolRegistry.tsx
import { readFileTool } from './readFile.tool.tsx'
import { editFileTool } from './editFile.tool.tsx'
import { runCommandTool } from './runCommand.tool.tsx'
// ... all tools

export const toolDefinitionOfToolName: { [T in BuiltinToolName]: ToolDefinition<T> } = {
	read_file: readFileTool,
	edit_file: editFileTool,
	run_command: runCommandTool,
	// ...
}
```

`toolsService.ts` builds `ToolCtx` from its injected services and delegates to `toolDefinitionOfToolName[T].validateParams(params, ctx)` etc. `ToolResultComponents.tsx` reads `title`, `desc`, `resultWrapper` from the same registry.

### IPC boundary change

Currently `electron-main` calls `availableTools(chatMode, mcpTools)` to compute the tool list. Change: the browser layer computes it and passes the result.

**Before:**
```typescript
// SendLLMMessageParams includes:
chatMode: ChatMode | null
mcpTools: InternalToolInfo[] | undefined
// electron-main calls: availableTools(chatMode, mcpTools)
```

**After:**
```typescript
// SendLLMMessageParams includes:
tools: InternalToolInfo[] | undefined  // pre-resolved by browser layer
// electron-main uses tools directly
```

The browser layer (chatThreadService or convertToLLMMessageService) calls `availableTools(chatMode, mcpTools)` — now living in `browser/` — and passes the resolved `InternalToolInfo[]` to `sendLLMMessage`. Electron-main receives it and uses it directly for:
- Building provider-specific schemas (`toOpenAICompatibleTool`, Anthropic/Gemini equivalents)
- XML tag detection in `extractGrammar.ts`

`chatMode` and `mcpTools` are dropped from the IPC params entirely. Currently `extractGrammar.ts` has `if (!chatMode) return ...` followed by `if (!tools) return ...` — these are redundant since `availableTools(null, ...)` already returns `undefined`. With the pre-resolved list, the `!chatMode` guard collapses into `!tools`. Similarly, `openAITools(chatMode, mcpTools)` and `anthropicTools(chatMode, mcpTools)` become `openAITools(tools)` and `anthropicTools(tools)` — pure formatting, no filtering.

Electron-main becomes completely tool-agnostic: zero knowledge of which tools are builtin vs. MCP, what the chat mode is, or how filtering works. This decouples `electron-main` from `builtinTools` and `availableTools()`, allowing both to move to `browser/`.

### What stays in `common/`

- `common/toolsServiceTypes.ts` — type declarations only:
  - `BuiltinToolCallParams` (params type per tool)
  - `BuiltinToolResultType` (result type per tool)
  - `BuiltinToolName` (derived from `BuiltinToolResultType`)
  - `ToolName`, `ToolParamName` (used by `sendLLMMessageTypes.ts`)
- `common/prompt/prompts.ts` — constants and prompt strings not specific to any one tool:
  - `MAX_FILE_CHARS_PAGE`, `MAX_DIRSTR_CHARS_*`, etc. (shared constants)
  - `chat_systemMessage`, `chat_volatileContext` (system prompt composition)
  - `searchReplaceBlockTemplate`, `editsTool_description` (used by `edit_file` tool description — could move to tool file, but also referenced by the system prompt)
- `common/sendLLMMessageTypes.ts` — `InternalToolInfo` type (used by IPC params), `RawToolParamsObj`, `RawToolCallObj`

### What moves to `browser/`

- `builtinTools` (LLM descriptions) → per-tool files in `browser/tools/`
- `availableTools()` → `browser/tools/toolRegistry.tsx` (or a helper in the same dir)
- `approvalTypeOfBuiltinToolName` → per-tool files (each tool declares its own `approvalType`)
- `titleOfBuiltinToolName`, `toolNameToDesc`, `builtinToolNameToComponent` → per-tool files (each tool declares its own `title`, `desc`, `resultWrapper`)
- `this.validateParams`, `this.callTool`, `this.stringOfResult` in `toolsService.ts` → per-tool files; `toolsService.ts` becomes a thin delegator

## Design decisions

- **One file per tool, not one file per segment** — the goal is co-location. A tool's description, execution, and UI change together. Splitting them by segment reintroduces the fragmentation we're eliminating. One `.tool.tsx` file per tool means adding a tool = creating one file + adding one type entry.

- **`.tsx` not `.ts`** — the `resultWrapper` segment uses JSX. The file must be `.tsx`. `toolsService.ts` (which runs in the extension host) will import these files, transitively importing React. This is safe: `toolsService` is already in the `browser/` layer where React is available, and the React imports are module-level only — `toolsService` never invokes React components.

- **`ToolCtx` instead of `this`** — currently `callTool` functions close over `this.fileService`, `this.terminalToolService`, etc. Moving them out of the class requires passing services explicitly. `ToolCtx` is a flat bag of all services any tool might need. Individual tools pick what they use. This is the same pattern used by VS Code's command handlers. `ctx` also carries helper functions like `validateURI` that currently close over `workspaceContextService`.

- **Pass tool list via IPC, don't compute in electron-main** — `electron-main` needs the tool list for schema generation and XML parsing, but doesn't need to know *which* tools are available (that's a browser-layer decision based on chat mode + MCP config). Passing the pre-resolved list is cleaner: the browser layer owns the filtering logic, electron-main just formats whatever it receives.

- **Types stay as type declarations in `common/`** — `BuiltinToolCallParams[T]` and `BuiltinToolResultType[T]` are used in generic constraints across all three layers. They're type annotations, not logic. Moving them would break the type system's ability to relate tool params to tool results. Keeping them in `common/` and having tool files reference them is the correct boundary.

- **`BuiltinToolParamName` simplification** — currently `toolsServiceTypes.ts` imports `builtinTools` from `prompts.ts` to compute `BuiltinToolParamName` (param names per tool, derived from the description's `params` keys). With descriptions moving to `browser/`, this type computation breaks. `BuiltinToolParamName` is only used to define `ToolParamName`, which types param names as strings from the LLM. Simplify `ToolParamName<T>` to `string` — the type safety on param names is cosmetic (LLM output is parsed at runtime anyway), and it removes the last `common/` → `builtinTools` dependency.

- **No per-tool subdirectories** — 22 `.tool.tsx` files in one `browser/tools/` directory is manageable. Subdirectories (e.g., `browser/tools/read/`, `browser/tools/edit/`) add navigation overhead without benefit at this scale.

## Migration plan

Incremental — each step produces a working build. No big-bang rewrite.

### Step 1: IPC boundary change (1 commit)

Change `SendLLMMessageParams` to include `tools: InternalToolInfo[] | undefined`. Browser layer computes `availableTools(chatMode, mcpTools)` and passes the result. Electron-main uses the passed list. `availableTools()` stays in `common/` for now — just called from browser instead of electron-main.

This step is independently shippable and decouples electron-main from tool definitions.

### Step 2: Create tool infrastructure (1 commit)

Create `browser/tools/toolTypes.tsx` (`ToolDefinition`, `ToolCtx`, `WrapperProps` re-export) and `browser/tools/toolRegistry.tsx` (empty registry, populated in later steps). Move `approvalTypeOfBuiltinToolName` logic into the registry as a derived map. Add `validateURI` and other helpers to `ToolCtx`.

### Step 3: Convert tools incrementally (3-4 commits)

Convert tools in batches of 5-6. Each batch:
1. Create `.tool.tsx` files for the batch (move description, validate, call, stringify, title, desc, resultWrapper from the old locations)
2. Register them in `toolRegistry.tsx`
3. Update `toolsService.ts` to delegate to the registry for converted tools
4. Update `ToolResultComponents.tsx` to delegate to the registry for converted tools
5. Remove old entries from `builtinTools`, `validateParams`, `callTool`, `stringOfResult`, `titleOfBuiltinToolName`, `toolNameToDesc`, `builtinToolNameToComponent`

Suggested batches:
- Batch 1: `read_file`, `ls_dir`, `get_dir_tree`, `search_pathnames_only`, `search_for_files`, `search_in_file` (read/search tools)
- Batch 2: `go_to_definition`, `go_to_usages`, `read_lint_errors`, `semantic_search`, `search_history`, `fetch_url`, `load_skill` (read-only tools)
- Batch 3: `edit_file`, `rewrite_file`, `create_file_or_folder`, `delete_file_or_folder`, `rename_file_or_folder` (editing tools)
- Batch 4: `run_command`, `run_persistent_command`, `open_persistent_terminal`, `kill_persistent_terminal` (terminal tools)

### Step 4: Cleanup (1 commit)

- Remove `builtinTools` from `prompts.ts` (descriptions now in tool files)
- Remove `availableTools()` from `prompts.ts`, move to `browser/tools/`
- Remove `approvalTypeOfBuiltinToolName` from `toolsServiceTypes.ts`
- Simplify `BuiltinToolParamName` / `ToolParamName` to `string`
- Remove old `validateParams` / `callTool` / `stringOfResult` maps from `toolsService.ts` (now thin delegators)
- Remove old `titleOfBuiltinToolName` / `toolNameToDesc` / `builtinToolNameToComponent` from `ToolResultComponents.tsx`
- Move tool-specific constants (`MAX_FILE_CHARS_PAGE`, `MAX_TERMINAL_CHARS`, etc.) to their tool files

## File structure after migration

```
browser/tools/
├── toolTypes.tsx              # ToolDefinition<T>, ToolCtx, shared types
├── toolRegistry.tsx           # toolDefinitionOfToolName, availableTools()
├── readFile.tool.tsx
├── lsDir.tool.tsx
├── getDirTree.tool.tsx
├── searchPathnamesOnly.tool.tsx
├── searchForFiles.tool.tsx
├── searchInFile.tool.tsx
├── goToDefinition.tool.tsx
├── goToUsages.tool.tsx
├── readLintErrors.tool.tsx
├── semanticSearch.tool.tsx
├── searchHistory.tool.tsx
├── fetchUrl.tool.tsx
├── loadSkill.tool.tsx
├── editFile.tool.tsx
├── rewriteFile.tool.tsx
├── createFileOrFolder.tool.tsx
├── deleteFileOrFolder.tool.tsx
├── renameFileOrFolder.tool.tsx
├── runCommand.tool.tsx
├── runPersistentCommand.tool.tsx
├── openPersistentTerminal.tool.tsx
└── killPersistentTerminal.tool.tsx

common/
├── toolsServiceTypes.ts       # BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName (types only)
├── prompt/prompts.ts          # system prompt, constants, search-replace template (no tool definitions)
└── sendLLMMessageTypes.ts     # InternalToolInfo, RawToolParamsObj, IPC params (now includes tools: InternalToolInfo[])

browser/
├── toolsService.ts            # thin delegator: builds ToolCtx, delegates to toolDefinitionOfToolName
└── react/.../ToolResultComponents.tsx  # thin delegator: reads title/desc/resultWrapper from registry
```

## Risks

- **React import in execution path** — `toolsService.ts` will import `.tool.tsx` files that import React. If any code path in the extension host (not browser) imports `toolsService`, it would pull in React. Mitigation: verified that `toolsService` is browser-layer only (not imported from `electron-main/`). The React import is module-level only; `toolsService` never renders components.

- **IPC serialization of `InternalToolInfo[]`** — passing the tool list across IPC means it must be serializable. `InternalToolInfo` is `{ name, description, params, mcpServerName? }` — all strings and plain objects. Already serializable (MCP tools are already passed this way).

- **Migration complexity** — 22 tools across 3-4 batches is mechanical but tedious. Each batch is independently testable. Risk of introducing subtle bugs during the move (e.g., closing over a service that's no longer in scope). Mitigation: each batch is a separate commit, test after each.

- **`ToolParamName` simplification** — changing `ToolParamName<T>` from a derived union to `string` loses type safety on param names. The only consumers are `RawToolParamsObj` and `RawToolCallObj` in `sendLLMMessageTypes.ts`, which parse LLM output at runtime. The type safety was cosmetic — the runtime validation in `validateParams` is the real check.
