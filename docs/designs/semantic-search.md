# Semantic Search

## Problem

All current search tools are **lexical** — they match exact strings or symbol names. There is no tool that finds code by **meaning**. Queries like "where is error handling", "authentication flow", or "retry logic" force the agent into 3–5 rounds of keyword fishing with `search_in_file`, trying different word choices. This wastes tokens and often misses code that uses different naming for the same concept.

## Solution

Add a `semantic_search` tool backed by a local embedding index. The agent sends a natural-language query, gets back ranked code chunks by semantic similarity.

## Tool selection model

No fallback chain — each tool has a clear best case. The agent picks upfront based on what it knows:

| What the agent has | Right tool |
|---|---|
| Exact symbol name | `go_to_definition` / `go_to_usages` |
| Exact string or regex | `search_in_file` / `search_for_files` |
| Concept, intent, or description | `semantic_search` |

When uncertain, the agent can call all three in parallel (existing parallel tool calling) and merge results in one round-trip.

## Architecture

### 1. Embedding models as part of the existing model system

Embedding models are just regular models in the existing provider model lists, with new capability flags. This follows the same pattern as `supportsFIM` (gates which models appear in the Autocomplete dropdown) and `supportsVision` (gates VisionHelper).

**New fields on `VoidStaticModelInfo`** (`modelCapabilities.ts`):

```typescript
supportsEmbedding: boolean  // whether this model can produce embeddings
supportsChat?: boolean     // defaults to true; false for embedding-only models
```

- `supportsEmbedding` — like `supportsFIM`, a capability gate. Embedding models (e.g. `text-embedding-3-small`, `nomic-embed-text`) have `supportsEmbedding: true`.
- `supportsChat` — defaults to `true` (existing behavior). Set to `false` for embedding-only models that can't do chat completion. The model selector shows "This model does not support chat" when a user tries to use it for Chat/Ctrl+K/Apply/SCM.

**Adding embedding models** — users add them manually, same as any custom model:

1. Type the model name in the provider's model list (e.g. `text-embedding-3-small` on OpenAI, `nomic-embed-text` on Ollama)
2. Set the override: `supportsEmbedding: true`, `supportsChat: false`

Common choices:

| Provider | Model name |
|---|---|
| openAI | `text-embedding-3-small` |
| openRouter | `openai/text-embedding-3-small` |
| ollama | `nomic-embed-text` |
| vLLM / LM Studio / openAICompatible | whatever embedding model they serve |

**Model selection for semantic search**:

New global settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `semanticSearchEnabled` | `boolean` | `true` | Enable/disable |
| `semanticSearchModel` | `ModelSelection \| null` | `null` | Which model to use for embeddings. `null` = auto-pick first available model with `supportsEmbedding: true`. |

`ModelSelection` is `{ providerName, modelName }` — same type used for Chat, Autocomplete, etc. The settings UI shows a filtered dropdown (only models with `supportsEmbedding: true`), exactly like Autocomplete shows only FIM models.

**Feature filter** (in `voidSettingsService.ts`, same pattern as Autocomplete/VisionHelper):

```typescript
// In modelFilterOfFeatureName
'SemanticSearch': {
  filter: (o, opts) => getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel).supportsEmbedding,
  emptyMessage: { message: 'No models support embeddings', priority: 'fallback' }
}
```

**Embedding HTTP call — IPC channel pattern**

The embedding HTTP call must run in the **electron-main** process (same as LLM message calls and URL fetching), not the browser process. This follows the exact same IPC channel pattern as `fetchUrlChannel`:

1. **`electron-main/embeddingChannel.ts`** (new) — runs in main process, has access to `newOpenAICompatibleSDK` and network
2. **`common/embeddingService.ts`** (new) — browser-side service, proxies calls to main process via IPC

Single protocol — OpenAI `/v1/embeddings`. All supported providers (including Ollama) already expose this endpoint. The main-process channel reuses `newOpenAICompatibleSDK` to construct the OpenAI client with the right `baseURL` and auth for each provider.

```typescript
// electron-main/embeddingChannel.ts
export type EmbedParams = { providerName: ProviderName, modelName: string, texts: string[], settingsOfProvider: SettingsOfProvider }
export type EmbedResult = { embeddings: number[][] }

export class EmbeddingChannel implements IServerChannel {
  async call(_: unknown, command: string, params: any): Promise<any> {
    if (command === 'embed') {
      const { providerName, modelName, texts, settingsOfProvider } = params as EmbedParams
      const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
      const response = await openai.embeddings.create({ model: modelName, input: texts })
      return { embeddings: response.data.map(d => d.embedding) }
    }
    throw new Error(`EmbeddingChannel: command "${command}" not recognized.`)
  }
}
```

```typescript
// common/embeddingService.ts — browser-side IPC proxy
export interface IEmbeddingService {
  readonly _serviceBrand: undefined
  embed(providerName: ProviderName, modelName: string, texts: string[]): Promise<number[][]>
}

export class EmbeddingService implements IEmbeddingService {
  private readonly channel: IChannel
  constructor(@IMainProcessService mainProcessService: IMainProcessService) {
    this.channel = mainProcessService.getChannel('void-channel-embedding')
  }
  async embed(providerName: ProviderName, modelName: string, texts: string[]): Promise<number[][]> {
    const result = await this.channel.call('embed', { providerName, modelName, texts, settingsOfProvider: /* from IVoidSettingsService */ })
    return result.embeddings
  }
}
```

**Registration** (in `src/vs/code/electron-main/app.ts`, same pattern as other channels):
```typescript
mainProcessElectronServer.registerChannel('void-channel-embedding', embeddingChannel)
```

This covers OpenAI, Ollama (`endpoint/v1/embeddings`), vLLM, LM Studio, LiteLLM, OpenRouter, and any generic backend — all via the same OpenAI-compatible call.

### 2. SemanticIndexService

**File**: `src/vs/workbench/contrib/void/browser/semanticIndexService.ts`

#### Chunking

- Split each file into chunks of ~300 tokens (~1200 chars) with 50-token overlap
- Each chunk: `{ uri, startLine, endLine, content, contentHash, embedding? }`
- Code: split by empty lines or symbol boundaries (use `DocumentSymbolProvider` when available, fall back to line-count)
- Markdown: split by headings

#### Index persistence

Stored at `<userRoamingDataHome>/voidSemanticIndex/<workspaceHash>.json`:

```typescript
interface SemanticIndex {
  version: number
  embeddingModel: string   // "providerName/modelName"
  fileHashOfUri: Record<string, string>   // full-file content hash
  chunks: Chunk[]
}
interface Chunk {
  uri: string
  startLine: number
  endLine: number
  content: string
  contentHash: string
  embedding: number[]
}
```

#### Change detection on reload

1. Load index from disk — all chunks + hashes + embeddings in memory
2. Scan workspace files — hash each file's full content
3. Compare:
   - File hash matches stored → skip entirely
   - File hash differs → re-chunk that file, compare chunk-level hashes
     - Chunk hash matches → keep existing embedding
     - Chunk hash differs → re-embed only that chunk
   - File no longer exists → remove its chunks
   - New file → chunk + embed
4. Invalidate entire index if `embeddingModel` changes (different model = different vector space)

#### File watcher (live updates)

- Use `IFileService.onDidFilesChange` + debounce 5s
- Re-chunk changed files, re-embed changed chunks, update index in memory + persist

#### Excluded paths

- `.git/`, `node_modules/`, `build/`, `out/`, `dist/`, `.tmp/`
- Binary files (detected by extension or null-byte check)
- Files >1MB
- VS Code's `ISearchService` exclusion (respects `.gitignore`)

#### Search

- Embed the query via the `embed()` function above
- Cosine similarity against all chunk embeddings
- Return top-K results (default K=10)
- Optional `include_pattern` glob filter (e.g. `src/**`)

Interface:

```typescript
interface ISemanticIndexService {
  search(query: string, nResults: number, includePattern?: string): Promise<SemanticSearchResult[]>
  readonly indexStatus: IndexStatus  // 'idle' | 'indexing' | 'ready'
  readonly indexProgress: { indexed: number, total: number }
}

interface SemanticSearchResult {
  uri: URI
  startLine: number
  endLine: number
  snippet: string
  score: number
}
```

### 3. semantic_search tool

**Params**:

```typescript
{
  query: string
  n_results?: number        // default 10
  include_pattern?: string  // glob, e.g. "src/**"
}
```

**Result**: `{ results: SemanticSearchResult[] }`

**Stringifier**: same format as `search_for_files` — ranked list with file path, line range, snippet preview, and relevance score.

**Approval**: read-only, no approval needed.

**Tool description** (in `prompts.ts`):

> Use this to find code by meaning or intent, not exact string match. Best for conceptual queries like 'error handling', 'authentication flow', 'retry logic', or 'how does the agent loop work'. For exact symbol names use `go_to_definition`/`go_to_usages`; for exact strings use `search_in_file`/`search_for_files`. Never use `run_command` with `grep` for conceptual searches — this tool is the correct choice.

**Prompt surfaces** (three-surface pattern from Phase C):

1. **Tool description** — above
2. **Redirect lines** appended to `search_in_file` and `search_for_files` descriptions: *"For conceptual or intent-based queries where there's no exact string to match, use `semantic_search` instead."*
3. **`importantDetails` bullet**: *"When searching code: use `go_to_definition`/`go_to_usages` for named symbols, `search_in_file`/`search_for_files` for exact strings, and `semantic_search` for conceptual/intent queries. Pick the right tool upfront — don't cascade through multiple search tools for the same query."*
4. **Tool-selection rule** in `importantDetails` updated — add `semantic_search` to the existing intent→tool mapping

### 4. UI

Minimal for v1:

- **Model selector** — new "Semantic Search" section in Void Settings with a model dropdown filtered by `supportsEmbedding: true` (same UI as the Autocomplete model selector, filtered by `supportsFIM`)
- **Indexing progress** — small status line in sidebar: "Indexing... 234/1200 files" (only while indexing, disappears when ready)
- **Embedding-only models** — when selected for Chat/Ctrl+K/Apply/SCM, show "This model does not support chat" (same pattern as "No models support FIM" for Autocomplete)
- No separate search UI — the tool is agent-only

### 5. Hardware requirements

Any machine that runs VS Code can handle this:

| Component | Requirement |
|---|---|
| API backend | Zero extra hardware |
| Ollama (CPU) | Any modern CPU, ~50ms/chunk |
| RAM for index (2k files) | ~60MB for embeddings |
| RAM for index (10k files) | ~300MB for embeddings |
| Disk (2k files) | ~60MB JSON index |
| Disk (10k files) | ~300MB JSON index |

## Prerequisites

### Ollama (local, free, no API key)

1. Install: `brew install ollama` or download from ollama.com
2. Start server: `ollama serve` (runs automatically as a Mac app)
3. Pull the embedding model: `ollama pull nomic-embed-text` (274MB download, runs on CPU)
4. In Void settings: select Ollama provider → `nomic-embed-text` → done

No API key needed. All data stays local. Indexing a 2000-file repo takes ~1–2 minutes on CPU.

### OpenAI-compatible API (remote, needs API key)

1. Have an API key for OpenAI, OpenRouter, LiteLLM, vLLM, LM Studio, or any OpenAI-compatible provider
2. In Void settings: fill in the provider's API key + endpoint → select `text-embedding-3-small` (or your provider's embedding model) → done

API costs for embedding are negligible — `text-embedding-3-small` is $0.02/1M tokens. Indexing a 2000-file repo (~10k chunks × ~300 tokens each) costs < $0.01.

### Data storage

| Path | Content |
|---|---|
| `~/Library/Application Support/Void/voidSemanticIndex/<workspaceHash>.json` (macOS) | Per-workspace index: chunk metadata + embeddings + file hashes |
| Linux: `~/.config/Void/voidSemanticIndex/...` | Same |
| Windows: `%APPDATA%/Void/voidSemanticIndex/...` | Same |

- One JSON file per workspace, auto-created on first index
- Size: ~60MB for 2000 files, ~300MB for 10k files
- Safe to delete — the index rebuilds from scratch on next session
- Auto-updated on file changes (debounced 5s)

## Infra changes (outside `src/vs/workbench/contrib/void`)

Only **one file** needs modification outside the void contrib directory — same as every previous Void channel:

| File | Change |
|---|---|
| `src/vs/code/electron-main/app.ts` | Import `EmbeddingChannel` + register `void-channel-embedding` channel (2 lines) |

This follows the exact same pattern as the existing Void channels (`void-channel-llmMessage`, `void-channel-fetchUrl`, `void-channel-scm`, `void-channel-mcp`). The import points into `src/vs/workbench/contrib/void/electron-main/embeddingChannel.ts` — all implementation lives in the void contrib.

## File summary (within `src/vs/workbench/contrib/void`)

| File | Change |
|---|---|
| `common/modelCapabilities.ts` | Add `supportsEmbedding`, `supportsChat` to `VoidStaticModelInfo`; add default embedding models to provider lists; add to `modelOverrideKeys` |
| `common/voidSettingsTypes.ts` | Add `SemanticSearch` to `featureNames`; add `semanticSearchEnabled` + `semanticSearchModel` to `GlobalSettings` |
| `common/voidSettingsService.ts` | Add `SemanticSearch` entry in `modelFilterOfFeatureName`; gate chat features against `supportsChat === false` |
| `electron-main/embeddingChannel.ts` | New — main-process IPC channel for embedding calls via `newOpenAICompatibleSDK` |
| `common/embeddingService.ts` | New — browser-side IPC proxy for embedding calls |
| `browser/semanticIndexService.ts` | New — chunking, indexing, file watching, vector search, persistence |
| `common/prompt/prompts.ts` | Tool definition + description + prompt surfaces |
| `common/toolsServiceTypes.ts` | Params/result types for `semantic_search` |
| `browser/toolsService.ts` | Validate/call/stringify |
| `browser/react/src/sidebar-tsx/SidebarChat.tsx` | Tool result renderer |
| `browser/void.contribution.ts` | Service registration |

## Implementation plan (commit-by-commit)

### Commit 1 — Model capabilities

Add `supportsEmbedding` and `supportsChat` to the model system. No behavior change yet — just the types and data.

- `common/modelCapabilities.ts`:
  - Add `supportsEmbedding: boolean` and `supportsChat?: boolean` to `VoidStaticModelInfo`
  - Add `supportsEmbedding` and `supportsChat` to `modelOverrideKeys`
  - No hardcoded embedding models — users add them manually with `supportsEmbedding: true` override
- `common/voidSettingsTypes.ts`:
  - Add `'SemanticSearch'` to `featureNames`
  - Add `semanticSearchEnabled: boolean` (default `true`) to `GlobalSettings`
  - Add `semanticSearchModel: ModelSelection | null` (default `null`) to `GlobalSettings`
  - Add `displayInfoOfFeatureName` entry for `SemanticSearch`
- `common/voidSettingsService.ts`:
  - Add `SemanticSearch` entry in `modelFilterOfFeatureName` filtering by `supportsEmbedding`
  - Gate Chat/Ctrl+K/Apply/SCM filters to reject models with `supportsChat === false`

**Validation**: existing behavior unchanged. New models appear in provider model lists but don't affect any feature selector yet (SemanticSearch feature isn't wired to UI yet).

---

### Commit 2 — Embedding IPC channel + SemanticIndexService core (chunking + search in memory)

The embedding call infrastructure and the indexing/search engine. No tool yet.

- `electron-main/embeddingChannel.ts` (new file):
  - `EmbeddingChannel` implementing `IServerChannel`
  - `embed` command: receive `{ providerName, modelName, texts, settingsOfProvider }`, construct OpenAI SDK via `newOpenAICompatibleSDK`, call `/v1/embeddings`, return `{ embeddings: number[][] }`
  - Reuses the exact same SDK construction logic as chat — one path for all providers

- `common/embeddingService.ts` (new file):
  - `IEmbeddingService` interface + `EmbeddingService` implementation
  - Browser-side IPC proxy: `embed(providerName, modelName, texts)` → `channel.call('embed', ...)`
  - Reads `settingsOfProvider` from `IVoidSettingsService` and passes it to the main process
  - Registered as singleton

- `src/vs/code/electron-main/app.ts`:
  - Register `void-channel-embedding` channel (one line, same pattern as `void-channel-fetchUrl`)

- `browser/semanticIndexService.ts` (new file):
  - `ISemanticIndexService` interface
  - Chunking logic: split file content into ~1200-char chunks with 200-char overlap, track `startLine`/`endLine`
  - Uses `IEmbeddingService.embed()` for embedding calls
  - Cosine similarity search: embed query, compare against all chunk embeddings, return top-K
  - `search(query, nResults, includePattern?)` method
  - `indexWorkspace()` method: scan workspace files via `IFileService`, chunk each file, embed all chunks via `IEmbeddingService`, store in memory
  - `indexStatus` and `indexProgress` observables
  - Excluded paths logic (`.git/`, `node_modules/`, binary detection, >1MB files)
  - Service registration in `void.contribution.ts`

**Validation**: service can be instantiated, `indexWorkspace()` can be called manually, `search()` returns ranked results. No tool or UI yet — test by calling the service directly from dev console.

---

### Commit 3 — Index persistence + change detection

Persist the index to disk and incrementally update on reload and file changes.

- `browser/semanticIndexService.ts`:
  - `SemanticIndex` and `Chunk` types
  - `saveIndex()`: write to `<userRoamingDataHome>/voidSemanticIndex/<workspaceHash>.json`
  - `loadIndex()`: read from disk, validate `version` and `embeddingModel`
  - Change detection on load: hash each workspace file, compare with stored `fileHashOfUri`, re-chunk/re-embed only changed chunks
  - Full index invalidation when `embeddingModel` changes
  - File watcher: `IFileService.onDidFilesChange` + 5s debounce → re-chunk/re-embed changed files → update in memory + persist
  - `contentHash` per chunk (MD5 of chunk content) for chunk-level dedup

**Validation**: index persists across restarts. Change a file, restart, verify only that file's chunks were re-embedded. File watcher picks up live changes.

---

### Commit 4 — `semantic_search` tool

Wire the tool into the agent's tool surface.

- `common/toolsServiceTypes.ts`:
  - Add `semantic_search` to `BuiltinToolCallParams` and `BuiltinToolResultType`
  - Params: `{ query: string, n_results?: number, include_pattern?: string }`
  - Result: `{ results: SemanticSearchResult[] }`
  - Add to `approvalTypeOfBuiltinToolName` as read-only (no approval needed)
- `browser/toolsService.ts`:
  - Validator: `query` (required string), `n_results` (optional number, default 10), `include_pattern` (optional string)
  - Body: call `semanticIndexService.search()`, handle `indexStatus !== 'ready'` (throw "Index not ready" error)
  - Stringifier: format results as ranked list with `uri:line-range  snippet  (score: N.NN)`
- `common/prompt/prompts.ts`:
  - Tool definition with description
  - Redirect lines on `search_in_file` and `search_for_files`
  - `importantDetails` bullet for search tool selection
  - Update tool-selection rule in agent block

**Validation**: agent can call `semantic_search` and get ranked results. Compare with `search_for_files` on conceptual queries.

---

### Commit 5 — Settings UI + indexing progress

Wire up the settings UI and add a progress indicator.

- `browser/react/src/void-settings-tsx/Settings.tsx`:
  - New "Semantic Search" section with model dropdown (filtered by `supportsEmbedding`)
  - Enable/disable toggle (`semanticSearchEnabled`)
- `browser/react/src/sidebar-tsx/SidebarChat.tsx`:
  - Indexing progress indicator: small status line "Indexing... 234/1200 files" (visible only during indexing, fades when `indexStatus === 'ready'`)
- `browser/react/src/sidebar-tsx/ToolResultComponents.tsx`:
  - Result renderer for `semantic_search` tool results

**Validation**: full end-to-end. User can select an embedding model in settings, see indexing progress, and the agent can call `semantic_search` in chat.

---

### Commit 6 — `supportsChat` gating in UI

Prevent embedding-only models from being selected for chat features.

- `browser/react/src/void-settings-tsx/Settings.tsx`:
  - Chat/Ctrl+K/Apply/SCM model dropdowns show "This model does not support chat" for models with `supportsChat === false`
- `browser/react/src/void-settings-tsx/ModelDropdown.tsx`:
  - Filter out `supportsChat === false` models from chat feature dropdowns, or show them greyed out with the message

**Validation**: embedding-only models can't be accidentally selected for Chat. They only appear in the Semantic Search dropdown.

---

### Future (not in initial PR)

- SQLite backend for repos >10k files
- Gemini embeddings support (`/v1/models/:model:embedContent`)
- Hybrid search (merge semantic + lexical with reciprocal rank fusion)
- User-facing search UI (not just agent tool)
