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
| vLLM / LM Studio / openAICompatible / litellm | whatever embedding model they serve |

**Model selection for semantic search**:

New global settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `semanticSearchEnabled` | `boolean` | `true` | Enable/disable |
| `semanticSearchDimensions` | `number` | `1024` | Embedding vector dimensions (Matryoshka truncation) |
| `semanticSearchBatchSize` | `number` | `64` | Chunks per API call |
| `semanticSearchConcurrency` | `number` | `16` | Parallel API calls |
| `semanticSearchChunkSize` | `number` | `2400` | Characters per chunk |
| `semanticSearchChunkOverlap` | `number` | `200` | Overlap between adjacent chunks |
| `semanticSearchMaxFileSize` | `number` | `1000000` | Skip files larger than this (bytes) |

Changing `semanticSearchDimensions`, `semanticSearchChunkSize`, `semanticSearchChunkOverlap`, or `semanticSearchMaxFileSize` invalidates the existing index and triggers a full re-index. Changing `semanticSearchBatchSize` or `semanticSearchConcurrency` takes effect on the next indexing run without invalidating the index.

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

**Critical**: `encoding_format: 'float'` must be passed to the SDK's `embeddings.create()` call. The OpenAI SDK v4+ defaults to `encoding_format: "base64"`, which some providers (litellm, sglang, vLLM) either ignore (returning floats that the SDK tries to base64-decode into zeros) or decode incorrectly, yielding all-zero vectors.

```typescript
// electron-main/embeddingChannel.ts
export type EmbedParams = { providerName: ProviderName, modelName: string, texts: string[], settingsOfProvider: SettingsOfProvider }
export type EmbedResult = { embeddings: number[][] }

export class EmbeddingChannel implements IServerChannel {
  async call(_: unknown, command: string, params: any): Promise<any> {
    if (command === 'embed') {
      const { providerName, modelName, texts, settingsOfProvider } = params as EmbedParams
      const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
      const response = await openai.embeddings.create({ model: modelName, input: texts, encoding_format: 'float' })
      return { embeddings: response.data.map(d => d.embedding) }
    }
    throw new Error(`EmbeddingChannel: command "${command}" not recognized.`)
  }
}
```

The channel also includes:
- **Empty text handling**: whitespace-only texts are replaced with a single space before sending to avoid "Input cannot be empty" 400 errors
- **Retry logic**: exponential backoff (up to 5 attempts) for 429 (rate limit) and 504 (gateway timeout) errors, with `retry-after` header support

**Registration** (in `src/vs/code/electron-main/app.ts`, same pattern as other channels):
```typescript
mainProcessElectronServer.registerChannel('void-channel-embedding', embeddingChannel)
```

### 2. SemanticIndexService

**File**: `src/vs/workbench/contrib/void/browser/semanticIndexService.ts`

#### Chunking

- Split each file into chunks of `chunkSize` chars (default 2400) with `chunkOverlap` chars overlap (default 200)
- Each chunk tracks `startLine`/`endLine` (computed from char offset → line number mapping)
- Content is sanitized to strip invalid UTF-16 surrogates that break embedding servers

#### Embedding truncation (Matryoshka)

Models like Qwen3-Embedding-8B produce 4096-dim vectors but support Matryoshka Representation Learning — the first N dimensions are a valid lower-dimension embedding. The service truncates to `embeddingDimensions` (default 1024) client-side after receiving the full vector. This reduces index size, memory usage, and search cost by ~4x without quality loss.

#### Index persistence

Stored at `<userRoamingDataHome>/voidSemanticIndex/<workspaceHash>.json`:

```typescript
interface SemanticIndex {
  version: number
  embeddingModel: string   // "providerName/modelName/d1024/c2400/o200/m1000000"
  fileHashOfUri: Record<string, string>
  mtimeOfUri: Record<string, number>
  chunks: SerializedChunk[]
}
interface SerializedChunk {
  uri: string
  startLine: number
  endLine: number
  contentHash: string
  embedding_b64: string   // base64-encoded Float32Array
}
```

**On-disk format**:
- Embeddings are stored as base64-encoded Float32Array (`embedding_b64`) instead of JSON float arrays — ~2x smaller
- Content is NOT persisted — snippets are read from source files on demand during search — reduces index size by ~40%
- File hashes and mtimes are stored for change detection

**In-memory format**:
```typescript
interface Chunk {
  uri: string
  startLine: number
  endLine: number
  content: string           // populated during indexing, empty after load from disk
  contentHash: string
  embedding: number[]       // always in memory as float array
}
```

#### Change detection on reload

1. Load index from disk — validate `version` and `embeddingModel` match current config
2. Deserialize chunks: decode base64 embeddings back to float arrays, content left empty
3. Scan workspace files, check mtime first (cheap `stat()`), then hash if mtime changed
4. Compare:
   - File hash matches stored → skip entirely
   - File hash differs → remove old chunks, re-chunk and re-embed
   - File no longer exists → remove its chunks
   - New file → chunk + embed
   - File matches `shouldSkipFile` → remove from index (handles newly-added skip extensions)
5. Invalidate entire index if `embeddingModel` or `INDEX_VERSION` changes

#### File watcher (live updates)

- Use `IFileService.onDidFilesChange` + `RunOnceScheduler` debounce 5s
- Pending changes collected in a `Set<string>`, processed after initial indexing completes
- Re-chunk changed files, re-embed changed chunks, update index in memory + persist
- Looping pattern handles rapid saves correctly

#### Excluded paths

Binary extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.ico`, `.webp`, `.tiff`, `.svg`, `.mp3`, `.mp4`, `.wav`, `.avi`, `.mov`, `.wmv`, `.zip`, `.tar`, `.gz`, `.rar`, `.7z`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.sqlite`, `.db`, `.exe`, `.dll`, `.so`, `.dylib`, `.class`, `.o`, `.pyc`

Skip extensions: `.lock`, `.map`, `.css`, `.min.js`, `.min.css`, `.log`, `.env`, `.ini`, `.cfg`, `.conf`, `.snap`, `.patch`, `.diff`, `.csv`, `.tsv`, `.xml`, `.proto`, `.plist`, `.xcodeproj`, `.xcworkspace`, `.dockerignore`, `.gitignore`, `.eslintignore`, `.egg-info`, `.scpt`, `.applescript`, `.nib`, `.xib`, `.storyboard`, `.pbxproj`, `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`

Skip filenames: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `.ds_store`, `thumbs.db`, `dependency_links.txt`, `not-zip-safe`

Directories: excluded via `getAllUrisInDirectory` which applies `.gitignore` and VS Code exclusion rules internally.

Files larger than `maxFileSize` (default 1MB) are also skipped.

#### Embedding pipeline

- Batching: chunks are grouped into batches of `batchSize` (default 64) for API calls
- Concurrency: sliding window with `concurrency` (default 16) parallel requests — launches a new batch as soon as one completes
- Failed chunks are re-queued at the end and retried in subsequent passes until all succeed
- Each batch retries up to 5 times with exponential backoff on network errors
- 120-second timeout per embedding request to prevent indefinite hangs
- Incremental save every 4 batches — progress is preserved if Void crashes
- Pending file hashes are only promoted to permanent state when ALL chunks for a file are embedded
- Partial files (some chunks succeeded, some failed) have their hash promoted so successful chunks aren't re-embedded on next load

#### Search

- Embed the query via the `embed()` function
- Truncate query embedding to match stored chunk dimensions
- Cosine similarity against all chunk embeddings
- Return top-K results (default K=10)
- Optional `include_pattern` glob filter
- Works during indexing — returns partial results with `indexStatus` and `indexProgress`
- Snippets are read from source files on demand using `startLine`/`endLine`

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
  indexStatus: IndexStatus
  indexProgress: { indexed: number, total: number }
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

**Stringifier**: ranked list with file path, line range, snippet preview, and relevance score. When results are partial (index still building), adds: "Note: Index is still being built (50/980 files indexed). Results may be incomplete."

**Approval**: read-only, no approval needed.

**Tool description** (in `prompts.ts`):

> Use this to find code by meaning or intent, not exact string match. Best for conceptual queries like 'error handling', 'authentication flow', 'retry logic', or 'how does the agent loop work'. For exact symbol names use `go_to_definition`/`go_to_usages`; for exact strings use `search_in_file`/`search_for_files`. Never use `run_command` with `grep` for conceptual searches — this tool is the correct choice.

**Prompt surfaces** (three-surface pattern):

1. **Tool description** — above
2. **Redirect lines** appended to `search_in_file` and `search_for_files` descriptions: *"For conceptual or intent-based queries where there's no exact string to match, use `semantic_search` instead."*
3. **`importantDetails` bullet**: *"When searching code: use `go_to_definition`/`go_to_usages` for named symbols, `search_in_file`/`search_for_files` for exact strings, and `semantic_search` for conceptual/intent queries. Pick the right tool upfront — don't cascade through multiple search tools for the same query."*

### 4. UI

- **Model selector** — "Semantic Search" section in Void Settings with a model dropdown filtered by `supportsEmbedding: true`
- **Enable/disable toggle** — `semanticSearchEnabled` switch
- **Advanced settings** — Dimensions, Batch size, Concurrency, Chunk size, Chunk overlap, Max file size (shown when enabled)
- **Indexing progress** — small status line in sidebar: "Scanning files..." or "Indexing X/Y" (only while indexing, disappears when ready)
- **Partial result indicator** — tool results show "Results (indexing 50/980)" when search returns partial results
- **Embedding-only models** — filtered out of Chat/Ctrl+K/Apply/SCM dropdowns when `supportsChat === false`

### 5. Hardware requirements

Any machine that runs VS Code can handle this:

| Component | Requirement |
|---|---|
| API backend | Zero extra hardware |
| Ollama (CPU) | Any modern CPU, ~50ms/chunk |
| RAM for index (2k files) | ~30MB for embeddings |
| RAM for index (10k files) | ~150MB for embeddings |
| Disk (2k files) | ~30MB index |
| Disk (10k files) | ~150MB index |

Index sizes are approximate for 1024-dim embeddings with base64 encoding, no content stored.

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

### GPU cluster (sglang/litellm)

1. Deploy an embedding model (e.g. `Qwen3-Embedding-8B`) via sglang or vLLM behind a litellm proxy
2. Configure litellm as an OpenAI-compatible backend in Void settings
3. Tune `batchSize` (64-128) and `concurrency` (4-16) to match your cluster's throughput and rate limits

Note: sglang/vLLM may not support the `dimensions` parameter — the service handles this by truncating client-side (Matryoshka). `encoding_format: 'float'` is required because these servers don't properly handle the SDK's default `base64` encoding.

### Data storage

| Path | Content |
|---|---|
| `~/Library/Application Support/Void/voidSemanticIndex/<workspaceHash>.json` (macOS) | Per-workspace index: chunk metadata + embeddings + file hashes |
| Linux: `~/.config/Void/voidSemanticIndex/...` | Same |
| Windows: `%APPDATA%/Void/voidSemanticIndex/...` | Same |

- One JSON file per workspace, auto-created on first index
- Safe to delete — the index rebuilds from scratch on next session
- Auto-updated on file changes (debounced 5s)

## Infra changes (outside `src/vs/workbench/contrib/void`)

Only **one file** needs modification outside the void contrib directory:

| File | Change |
|---|---|
| `src/vs/code/electron-main/app.ts` | Import `EmbeddingChannel` + register `void-channel-embedding` channel (2 lines) |

Also one export change:

| File | Change |
|---|---|
| `src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts` | `const newOpenAICompatibleSDK` → `export const newOpenAICompatibleSDK` |

## File summary (within `src/vs/workbench/contrib/void`)

| File | Change |
|---|---|
| `common/modelCapabilities.ts` | Add `supportsEmbedding`, `supportsChat` to `VoidStaticModelInfo`; add to `modelOverrideKeys` |
| `common/voidSettingsTypes.ts` | Add `SemanticSearch` to `featureNames`; add semantic search settings to `GlobalSettings` |
| `common/voidSettingsService.ts` | Add `SemanticSearch` entry in `modelFilterOfFeatureName`; gate chat features against `supportsChat === false`; migration for new settings |
| `electron-main/embeddingChannel.ts` | New — main-process IPC channel for embedding calls via `newOpenAICompatibleSDK` |
| `electron-main/llmMessage/sendLLMMessage.impl.ts` | Export `newOpenAICompatibleSDK` |
| `common/embeddingService.ts` | New — browser-side IPC proxy for embedding calls |
| `browser/semanticIndexService.ts` | New — chunking, indexing, file watching, vector search, persistence |
| `common/prompt/prompts.ts` | Tool definition + description + prompt surfaces |
| `common/toolsServiceTypes.ts` | Params/result types for `semantic_search` |
| `browser/toolsService.ts` | Validate/call/stringify |
| `browser/react/src/void-settings-tsx/Settings.tsx` | Semantic search settings section with model dropdown + advanced settings |
| `browser/react/src/sidebar-tsx/SidebarChat.tsx` | Indexing progress indicator |
| `browser/react/src/sidebar-tsx/ToolResultComponents.tsx` | Result renderer for `semantic_search` tool results |
| `browser/react/src/util/services.tsx` | `useSemanticIndexState` hook |

## Known limitations

- **JSON index format** — O(N²) total serialization work across an indexing run (every incremental save rewrites the entire file). Acceptable for repos under 10k files (~150MB index). For larger repos, a split JSON+binary or SQLite format would be needed.
- **Precision** — semantic search finds the right file and region, but is not a precision navigation tool. For exact symbol/line matching, the agent should follow up with `search_in_file` or `read_file`.
- **No hardcoded embedding models** — users must add models manually with `supportsEmbedding: true` override.
- **sglang/vLLM `dimensions` parameter** — not supported by all servers; client-side Matryoshka truncation is used as a fallback.

## Future work

- Split JSON+binary index format (small metadata JSON + append-only embeddings binary) to eliminate O(N²) saves
- SQLite backend for repos >10k files
- Gemini embeddings support (`/v1/models/:model:embedContent`)
- Hybrid search (merge semantic + lexical with reciprocal rank fusion)
- User-facing search UI (not just agent tool)
- Smarter file selection (skip test files, generated code, locale files)
