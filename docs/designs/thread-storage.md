# Thread Storage

Two parts, deliberately separable:

- **Part 1 — upgrade and migrate.** Fixes the existing store: gets message bodies out of the renderer-mirrored database, repairs the load path and the compaction anchor, fixes image ownership, and bounds growth. Delivers value on its own and can ship without multiagent.
- **Part 2 — prepare for multiagent.** Additive policy on top of the same store: thread kinds, a shared residency budget, concurrency, cascade deletion, and pruning. Changes no format.

**Checkpoints are not part of this design.** The feature was removed, and nothing here stores checkpoint data. Checkpoints appear only as (a) the historical cause of the index drift in bugs 2 and 3 and (b) residue to delete during migration. See "Checkpoints: removed, not stored".

---

## Problem

Conversation data lives in `state.vscdb` — VS Code's application-scope key-value store — under key-per-message layout. **Seventeen bugs** are catalogued in this document, numbered `bug 1` through `bug 17`. The eight sections below are the ones with a narrative and cover bugs 1–9, 15 and 16; the rest are ledger entries in [1.6 Bugs fixed in Part 1](#16-bugs-fixed-in-part-1). The first is architectural; the rest are ordinary bugs.

### Bug 1 — The renderer mirrors the entire database

`IStorageService` is not a lazy store. The renderer's `Storage` pulls **every key** into a `Map` at startup:

```ts
// base/parts/storage/common/storage.ts:124, :213
private cache = new Map<string, string>()
this.cache = await this.database.getItems()
```

`getItems()` passes no filter — it transfers all keys over IPC from the main process (`platform/storage/common/storageIpc.ts:57`). So **resident bytes equal total DB bytes**, for the whole session, for every thread; the startup IPC payload scales with total message count (the mechanism behind the 1.24 GB crash in `checkpoint-storage-refactor.md`); and **lazy message loading is only half-effective** — `_ensureMessagesLoaded` defers `JSON.parse`, but the raw strings were already loaded. It saves CPU, not memory.

This is not an edge case. Agentic coding legitimately produces thousands of messages per thread. At 300 threads × 1,500 messages the renderer holds 450,000 values as UTF-16 strings: ~450 MB at 1 KB average, ~2.2 GB at 5 KB.

**The root problem is not the key layout. It is that message bodies live in a database the renderer mirrors in full.**

### Bugs 2 and 3 — The load path renumbers the message array

`_readThread(id, true)` scans up to 100,000 keys unconditionally (`:1429`), skipping gaps and `checkpoint`-role entries, and rewrites survivors as contiguous indices (`:1438-1440`), with a second cleanup scan (`:1448`).

**Cost:** a full load costs the same for 10 messages or 10,000 — the bound is a leftover from the checkpoint era, when gaps were arbitrary. The metadata-only path is fine (5 keys, `:1398`), so startup is cheap and thread *switching* is what pays.

**Correctness:** renumbering can shrink the array while `compactionBoundaryIdx` — a positional index — stays put. The only correction is gated:

```ts
// :1467
if (oldCompactionBoundaryIdx !== undefined && checkpointsBeforeBoundary > 0) {
```

`checkpointsBeforeBoundary` counts only `role === 'checkpoint'` entries. For any migrated thread those are gone, so the gate is `0` and no remap happens. The boundary keeps its number and points at a different message. The code knows — the comment two lines above reads *"Already-migrated threads can't be remapped (checkpoints gone), but the LLM code clamps via Math.min."* The clamp (`convertToLLMMessageService.ts:1497`) turns a crash into a silently wrong prompt.

### Bug 4 — Compaction can be silently dropped entirely

```ts
// :3039 and :5486
const manualCompaction = currentThread?.compactionSummary && currentThread?.compactionBoundaryIdx
    ? { summary: ..., boundaryIdx: ... }
    : undefined
```

`0` is falsy in JavaScript. If `compactionBoundaryIdx` is `0`, **compaction is dropped while `compactionSummary` sits intact in storage.** The UI still draws the divider — it tests `!== undefined` (`SidebarChat.tsx:2042`) — so the thread looks compacted while the LLM receives the full history. No error. The remap can produce exactly zero (`oldBoundary - checkpointsBeforeBoundary`), and the guarding `boundaryIdx <= 0` check (`:5396`) runs at computation time, before the remap.

### Bug 5 — A corrected remap is discarded in memory

```ts
// :1492
const existing = this.state.allThreads[threadId]      // captured BEFORE the read
const fullThread = this._readThread(threadId, true)   // applies remap, writes it to storage
if (fullThread.messages.length > 0) {
    const updatedThread = { ...existing, messages: fullThread.messages }   // spreads stale metadata
```

Storage gets the corrected boundary; memory keeps the stale one. Wrong *during* a session, correct *after* restart — the opposite direction from bug 3, which is why the symptom reads as intermittent.

### Bugs 6, 7 and 8 — Image garbage collection is thread-local but references are not

Images are written to `<userRoamingDataHome>/voidImages/<uuid>.<ext>` — **flat, with no thread directory**, despite `chatThreadServiceTypes.ts:186` documenting `<userRoamingDataHome>/voidImages/<threadId>/<uuid>.<ext>`. Code and comment disagree (`SidebarChat.tsx:747-758`).

`_deleteOrphanedImages(removedMessages, retainedMessages)` (`:4210`) only consults the two lists it is handed — one thread's messages. But `duplicateThread` clones messages *including image selections* under a new thread id (`_storeAllMessageKeys(newId, cloned.messages)`, `:4898`), so **two threads can reference the same image URIs**. Deleting or truncating in one deletes images the other still needs. Thread deletion calls `_deleteOrphanedImages(thread.messages, [])` (`:4778`) — deleting every image the thread references, shared ones included.

### Bug 9 — Nothing bounds growth

No retention, cap, or eviction exists anywhere in the thread layer. Messages and threads accumulate forever; images have orphan cleanup, messages do not.

### Bug 15 — Writes made shortly before quitting are silently lost

`_storeThread` does not write; it queues into `_pendingThreadWrites` and schedules a flush 500 ms out (`:1209`). A shutdown hook exists (`:978`) — but it fires too late to do anything:

```ts
this._register(this._lifecycleService.onWillShutdown(() => {
    this._flushPendingThreadWrites()
}))
```

The workbench registers its own shutdown handler during startup, **before the chat service exists**, and that handler closes storage:

```ts
// workbench/electron-sandbox/desktop.main.ts:163
workbench.onWillShutdown(event => event.join(storageService.close(), { id: 'join.closeStorage', ... }))
```

`close()` calls `doClose()` synchronously, and `doClose()` sets the closed state as its first statement — before any `await`:

```ts
// base/parts/storage/common/storage.ts:339-342
private async doClose(): Promise<void> {
    this.state = StorageState.Closed;
    await this.doFlush(0)
```

And a write to closed storage is dropped **without error** (`:264-267`):

```ts
async set(key, value, external = false): Promise<void> {
    if (this.state === StorageState.Closed) {
        return; // Return early if we are already closed
    }
```

Listeners run in registration order, so storage closes first, Void's flush runs second, and everything it writes is discarded.

**The observed symptom is diagnostic:** compact a thread and quit immediately → the compaction is gone on relaunch. Compact, send one message, *then* quit → the compaction survives. Sending takes seconds, so the 500 ms flush fires long before shutdown. **The loss window is roughly the debounce interval after any write** — which is why it presents as intermittent and why it was previously misattributed to the compaction anchor itself.

This affects all three pending maps: `_pendingThreadWrites` (metadata, including `compactionSummary` and `compactionBoundaryIdx`), `_pendingMessageKeyWrites` (message bodies), and `_pendingUsageWrites`. A message appended inside the window is lost as well, which presents as "the model lost context after I reopened."

**Fix (implemented in S1).** Two changes, because they cover different failure modes:

1. **The shutdown flush moves to `onBeforeShutdown`.** Reordering listeners within `onWillShutdown` is not a fix: storage legitimately closes last, and the workbench registers its close listener during startup, before this service exists. `onBeforeShutdown` is a strictly *earlier* lifecycle phase — the main process sends `vscode:onBeforeUnload` and waits for the veto round-trip before it sends `vscode:onWillUnload`. A flush there lands while storage is still open, and `close()`'s own final `doFlush(0)` (which, unlike the public `flush()`, does not check the closed state) persists the inserts it accumulated.

   The old `onWillShutdown` flush was then **removed rather than kept as a fallback**, because it cannot succeed in either workbench: storage is closed from a listener the workbench registers during startup — `electron-sandbox/desktop.main.ts:163` on desktop, and `onWillShutdownDisposables` for web (`browser/web.main.ts:250`, holding `storageService.close()` at `:543`) — so any later listener writes to a closed store. It cannot cover writes queued between the two phases either, for the same reason. Keeping it would have been unreachable code that read as a backstop.

2. **Compaction writes through immediately** — `_storeThreadDurably`, called at the end of `compactCurrentThread`. This hands the write to the storage layer when it completes rather than at shutdown, so it no longer depends on shutdown ordering: the workbench's own close path persists whatever storage has pending. It is not a synchronous write to disk — the storage layer debounces its own handoff (100 ms in the renderer, then again in the main process before the SQLite write), so a hard kill inside that ~200 ms window is still lost, the same exposure every other persisted setting has. What it removes is the much larger window in which a completed compaction existed only in memory.

Confirmed by driving the real app, with the debounce cancelled so that only the shutdown path could persist the write: on unmodified code the shutdown flush runs, calls `store`, and the value never lands (it is discarded by the closed-store early return); after the fix the same write lands. The same write survives an unhurried quit on unmodified code because the 500 ms debounce fires first — which is exactly why the symptom presented as intermittent.

Regression test: `test/void/durable-writes-on-quit.test.mjs`, run with `npm run test-void` — end-to-end against the real app; see `test/void/README.md`.

### Bug 16 — The restored usage value never reaches disk

After a compaction the code deliberately restores the user's last real turn's usage, so the ring does not report the internal summarization request (`:5618-5622`):

```ts
if (preCompactionLatestUsage) {
    updatedThread.latestUsage = preCompactionLatestUsage
    this.latestUsageOfThreadId[threadId] = preCompactionLatestUsage
}
```

But that only reaches memory. Nothing writes it back to the usage key, and the flush actively prefers the other source (`:1298-1307`): when a usage write is pending for a thread, metadata is written from the thread object and the **usage key is written from `_pendingUsageWrites` instead**. That map was populated by `_setLatestUsage` during the compaction stream (`:5512`, `:5515`) with the **compaction request's** usage — the full conversation plus the summarization prompt.

So the usage key ends up holding the compaction request's token count, while the live window displays the restored pre-compaction value. The two differ, and neither is the real post-compaction prompt size.

**Symptom:** the context-length ring reports one number in the live window and a different number after a reopen — in either direction, which is what makes it read as "the context length jumped" rather than as a consistent error.

**Currently display-only**, because both client-side trim paths are disabled: emergency trim is explicitly off (`convertToLLMMessageService.ts:665-669`), and the Perf 2 Light tier is dead code — `_compactToolResultsForRequest` is never called, with `:321` an explicit `void` no-op. It becomes a correctness bug the moment either is re-enabled, since `priorContentTokens` is derived from this value and feeds the size gate.

---

## Data model

### The split

**`state.vscdb` keeps only small scalars. Everything list-shaped, unbounded, or derived moves to a per-thread store on disk.**

```
<globalStorageHome>/void/threads/<threadId>/
  messages.jsonl      — append-only message records
  images/<uuid>.<ext> — thread-owned image bytes
```

A main-process service behind a `void-channel-threads` channel owns the store — the pattern Void already uses six times (`-llmMessage`, `-embedding`, `-fetchUrl`, `-scm`, `-update`, `metricsMainService`).

### What `state.vscdb` holds

| Key | Value | Class | Verdict |
|---|---|---|---|
| `void.chatThreadIndex` | `string[]` of thread ids | small, grows with thread count | **keep** |
| `void.chatThread.<id>` | thread metadata (see below) | mixed; contains bulk and junk | **split** |
| `void.chatUsage.<id>` | 6 usage fields, written ~5 Hz | small | **keep as-is** |
| `void.chatMsg.<id>.<n>` | one `ChatMessage` per key | bulk | **remove → `messages.jsonl`** |
| `void.chatCheckpoint.<id>.<n>` | unused | dead | **delete (residue)** |
| `void.chatPinnedThreadsI` | pins per workspace | small | keep; children never included |
| `void.chatLastActiveThreadByWorkspaceI` | `Record<workspaceUri, threadId>` | small | keep |
| `void.pendingDiffsI` | pending diff zones | medium, no thread provenance | keep (see Non-goals) |
| `void.terminalAutoApproveI` | command-prefix allowlist | small | keep |
| `void.settingsServiceStorageII` | settings | small | keep |

Usage fields are split into their own key precisely because they change at ~5 Hz during streaming; that separation already works and is unchanged.

### Thread metadata, field by field

`_splitThreadForStorage` (`:1171`) sends everything except `messages`, `title`, and `_USAGE_FIELDS` to the metadata key. `_USAGE_FIELDS` (`:1151`) is `latestUsage`, `cumulativeUsageThisThread`, `latestCompaction`, `cumulativeCompactionThisThread`, `compactionSavedTokens`, `lastModified`. Everything else lands in metadata:

| Field | Class | Notes | Destination |
|---|---|---|---|
| `id`, `createdAt` | small | | DB |
| `customTitle` | small | | DB |
| `workspaceUri`, `workspaceLabel` | small | | DB |
| `permissionMode` | small | | DB |
| `lastUsedModelSelection` | small | | DB |
| `importedFromWorkspaceUri`, `importedFromThreadId`, `importedAt` | small | | DB |
| `compactionBoundaryIdx`, `compactionPercent` | small | anchor stays a number | DB |
| `directorySnapshot` | **bulk** | every path in the workspace | **store** (or per-workspace) |
| `compactionSummary` | **bulk** | bakes in a full directory listing | **store** |
| `frozenAiInstructions` | **bulk** | global instructions + `.voidrules` + `rulesPaths` + skills index | **store**, write-once |
| `lastAppliedRules` | medium | snapshot of `.voidrules` at last send | **store** |
| `filesWithUserChanges` | **dead + junk** | `Set<string>`; `JSON.stringify(Set)` → `{}`, and no reviver handles it (`_storageReviver` only revives URIs). Never read anywhere — declared and initialized only. **Deleted in S3** | gone |
| `state.stagingSelections` | small | staged URIs for the composer | DB |
| `state.focusedMessageIdx` | small | UI | DB |
| `state.linksOfMessageIdx` | UI, **index-keyed** | `Record<messageIdx, {name: CodespanLocation}>` — positional, so it has the same fragility class as the compaction anchor | DB, flagged |
| `state.mountedInfo` | **junk** | holds a `Promise`, a resolver function, and a ref. Persisted wholesale inside `state`, so `JSON.stringify` wrote `{"whenMounted":{},"mountedIsResolvedRef":{"current":false}}`. **Stripped in S3** — still live at runtime, excluded by `_splitThreadForStorage` | runtime only |
| `title` | ephemeral | already skipped | not persisted |

Three findings worth stating plainly, since none were previously documented:

1. **`filesWithUserChanges` was dead code that wrote `{}` into every thread's metadata.** It was a `Set`, there is no Set reviver, and nothing read it. Deleted in S3.
2. **`state.mountedInfo` is ephemeral runtime state that was being serialized as junk** into every thread's metadata, because `state` is persisted wholesale. It is *live* state — `focusCurrentChat`, `blurCurrentChat` and scroll-to-bottom all await it — so S3 strips it at serialization time rather than deleting it.
3. **`state.linksOfMessageIdx` is keyed by message index** — the same positional-identity pattern behind the compaction bugs (4 and 5).

### The message log format

`threads/<threadId>/messages.jsonl` — one JSON object per line, LF-terminated, UTF-8.

```jsonl
{"i":0,"m":{"role":"user","content":"…","displayContent":"…","selections":null,"state":{…}}}
{"i":1,"m":{"role":"assistant","displayContent":"…","reasoning":"…","anthropicReasoning":null}}
{"i":2,"m":{"role":"tool","id":"call_a","name":"read_file","type":"tool_request","params":{…}}}
```

Every record is exactly:

```ts
type LogRecord = {
  i: number          // message index within the thread
  m: ChatMessage     // the message, verbatim
}
```

`i` is the load-bearing part and is why the format works:

1. **Every write is an append.** New message, tool state transition, correction — all appends. No in-place rewrite, no read-modify-write of neighbours.
2. **The trailing-batch mutation becomes an append.** Verified: conversation data is never mutated — `editUserMessageAndStreamResponse` replaces at index K and deletes everything after K (`:4177-4182`) — and the only in-place update in the entire service is `_updateLatestTool` filling reserved `tool_request` placeholders in the trailing parallel-tool batch, the single caller of `_editMessageInThread` (`:2044`). A superseding record handles that natively.
3. **Reading cannot renumber.** The index comes from the record, not from position, so bug 3 is removed at the root rather than compensated for.

**Read semantics: fold by index, last record wins.** Duplicate `i` values are expected and correct.

**Truncation rewrites, it does not simply truncate.** The obvious implementation is `ftruncate` at the byte offset of the first record with `i >= K`. That is wrong in one case: superseding records for indices *below* K can appear later in file order than records for indices at or above K (a batch appends placeholders `3,4,5`, then supersedes `3`, `4`, `5`). Cutting at the first `i >= K` would discard a supersede for `i < K` and revert that message to an earlier state. Since truncation happens only on a user action and the thread is loaded in memory at that moment, the correct implementation is to **rewrite the file with the winning record for each `i < K`**. `ftruncate` is a valid optimisation only when no superseding record for `i < K` follows the cut point.

**Compaction of the log:** rewritten with only winning records when record count exceeds message count past a threshold — on thread seal or close, never during a run.

**Version:** `storeFormatVersion` in thread metadata, so the log stays pure data.

**`messageCount` returns to thread metadata.** `checkpoint-storage-refactor.md` removed it as a gap-tolerance hack; it returns as the authoritative file length, so the UI can paginate without reading the log.

**Operations**, deliberately minimal: `append`, `readAll`, `readRange`, `truncateFrom`, `deleteThread`, `onDidChange`.

### Message shapes

The `ChatMessage` union has four roles. Fields are classified as **durable** (needed to rebuild the LLM prompt), **UI-only** (decoration, never sent), or **bulk**.

**user**

```ts
{
  role: 'user'
  content: string          // durable — LLM-facing; volatile context (directory listing,
                           // active file) is baked in at send time and immutable after
  displayContent: string   // durable for display; what the user typed
  selections: StagingSelectionItem[] | null   // durable — attachment chips
  state: { stagingSelections: StagingSelectionItem[]; isBeingEdited: boolean }  // UI-only
  rulesChangedBefore?: boolean                // UI-only — explicitly never sent to the LLM
}
```

**assistant**

```ts
{
  role: 'assistant'
  displayContent: string                       // durable
  reasoning: string                            // durable — replayed for reasoning models
  anthropicReasoning: AnthropicReasoning[] | null          // durable — provider replay
  finishReason?: string                        // durable — provider stop reason; UI warns on 'length'
  responsesReasoning?: ResponsesReasoningRef | null        // durable — opaque Responses API replay payload
}
```

**tool** — role `'tool'`, with a discriminated union on `type`:

```ts
{
  role: 'tool'
  id: string                    // tool-call id, from the provider stream
  name: ToolName
  content: string               // durable, BULK — the LLM-facing rendering
  rawParams: RawToolParamsObj            // durable — replay
  rawParamsStr?: string         // durable — original serialized args, for byte-identical
                                // replay that preserves the provider's prefix cache
  mcpServerName: string | undefined
  batchIndex?: number; batchSize?: number   // UI-only — renders "(1/2)" grouping
} & (
  | { type: 'invalid_params';    result: null }
  | { type: 'tool_request';      result: null;   params: ToolCallParams<T> }   // transient
  | { type: 'running_now';       result: null;   params: ToolCallParams<T> }   // transient
  | { type: 'tool_error';        result: string; params: ToolCallParams<T> }
  | { type: 'success';           result: ToolResult<T>;  params: ToolCallParams<T> }
  | { type: 'rejected';          result: null;   params: ToolCallParams<T> }
)
```

Two points of rigour here:

- **`tool_request` and `running_now` are transient states**, not content. They exist so a pending approval survives a window reload (since `streamState` is explicitly not persisted). A `running_now` record is never meaningful after a restart — nothing is running — and should be treated as `tool_request` on read.
- **Deliberate redundancy.** `content` duplicates what `stringOfResult(params, result)` computes, and `rawParamsStr` duplicates `rawParams`. Both are stored on purpose: `content` is what gets replayed, and `rawParamsStr` keeps the provider's prefix cache warm across turns. Any future "normalisation" that drops them will cost either correctness or cost-per-turn.

**interrupted_streaming_tool** — decorative, UI-only:

```ts
{ role: 'interrupted_streaming_tool'; name: ToolName; mcpServerName: string | undefined }
```

Marks a tool call cancelled mid-stream. Never sent to the LLM; carries no content.

**Selections** (`StagingSelectionItem`), carried on user messages:

| Variant | Bulk? | Payload |
|---|---|---|
| `File` | no | `uri`, `language`, `state` |
| `CodeSelection` | no | `uri`, `range: [start, end]`, `language` |
| `Folder` | no | `uri` |
| `Terminal` | **yes** | `uri` (`void-terminal:/snapshot/<uuid>`), `language: 'shellscript'`, **`text`** (terminal output), `command?`, `cwd?`, `exitCode?`, `label` |
| `Image` | no | `uri` (file on disk), `mimeType`, `fileName`, `cachedDescription?` |

Note the asymmetry: **image bytes are files, but terminal snapshot text is stored inline in the message.** `Terminal.text` is a second source of bulk payload in the log and belongs in the same size-capping policy as tool results.

### Sizes and caps

| Source | Cap today | Where |
|---|---|---|
| `read_file` result | `MAX_FILE_CHARS_PAGE = 500_000` chars | `prompts.ts:25` |
| `read_terminal` output | `MAX_TERMINAL_CHARS = 100_000` chars | `prompts.ts:30` |
| tool `content` | inherits the above | message payload |
| `Terminal.text` selection | bounded at capture | `sidebarActions.ts` (see note) |
| `directorySnapshot` | unbounded — every workspace path | thread metadata |
| `compactionSummary` | unbounded — includes a directory listing | thread metadata |
| `frozenAiInstructions` | unbounded — all rules + skills index | thread metadata |

`chatThreadServiceTypes.ts:173` states terminal text "is already truncated to `TERMINAL_SNIPPET_MAX_BYTES` at capture time" — **that constant is defined nowhere in `src/`**. Truncation does happen, in `sidebarActions.ts`: `truncateTerminalText` caps at `TERMINAL_SNIPPET_MAX_CHARS` (32 KiB), middle-out with a tail bias, and the line count is used only for the chip label. The comment named a constant that does not exist, in the wrong unit. The comment was stale, not the behaviour.

### Checkpoints: removed, not stored

**Nothing in this design stores checkpoint data, and nothing here assumes checkpoints exist.**

The previous design failed because checkpoint entries were written **interleaved between chat messages** with each one copying whole file contents. In one observed thread that was 1,426 checkpoints totalling 905 MB of a 1.24 GB database, which crashed the renderer at startup. The feature was removed.

Checkpoints appear in this document for exactly two reasons:

1. **As the historical cause of bugs 2 and 3.** Because checkpoint entries occupied real indices in `messages[]`, removing them shifted every subsequent index — which is why the load path has a remap at all, and why that remap's gate is now dead code.
2. **As residue to delete.** See the checklist below.

Residue to remove as part of Part 1. The split between the two tables is not
cosmetic: the read path has to keep tolerating legacy threads until the message
store renumbers indices, so the second group can only go once loading no longer
shifts positions.

**Removed in S3 — writing residue, nothing reads it:**

| Residue | Location |
|---|---|
| `CheckpointEntry` type | `common/chatThreadServiceTypes.ts` |
| Commented-out checkpoint blocks, dead helpers and `// checkpoint disabled` markers (65 sites: 39 in `chatThreadService.ts`, 13 each in `react/src/` and the generated `react/src2/`) | `chatThreadService.ts`, `react/src/sidebar-tsx/SidebarChat.tsx` |
| `_editCodeService` injection, which existed only for the checkpoint methods | `chatThreadService.ts` constructor |
| Forward-looking "checkpoint redesign" sections | `docs/designs/checkpoint-storage-refactor.md` |

**Deferred to S10 — the legacy read and cleanup path:**

| Residue | Location | Why it must wait |
|---|---|---|
| `role === 'checkpoint'` skip in the read loops | `chatThreadService.ts:1423`, `:1484` | Threads written before the removal still carry these records in their message keys. Without the skip they load as real messages and are sent to the model |
| `checkpointsBeforeBoundary` remap | `chatThreadService.ts:1475–1519` | It needs the checkpoint records still readable to compute the shift. It is also the fix for bug 3, so removing it early re-breaks the boundary S2 corrected |
| `CHECKPOINT_KEY_PREFIX` and the two cleanup loops that use it | `common/storageKeys.ts:37`, `chatThreadService.ts:1219–1224`, `:1505–1511` | The only thing that ever deletes `void.chatCheckpoint.*`. Removing the cleaner while keeping the reader leaves those keys orphaned forever |

The S3 acceptance gate requires that *a thread containing legacy checkpoint
records still loads*, which is what fixes this boundary. `test/void/legacy-storage-compat.test.mjs`
holds that as a control scenario: it passes before and after S3, and it is what
stops the cleanup from over-deleting.

**Removing a field from the type does not remove it from stored threads.** Every
`_readThread` return path spreads the parsed metadata into the thread, so a key an
older build wrote rides into memory, and `_splitThreadForStorage` — which
serializes every key it does not explicitly skip — writes it straight back out.
The field is resurrected on every write and never converges. Removal therefore
needs a drop at the read parse point as well, which is what
`ChatThreadService._dropLegacyThreadFields` is for. This was found by querying a
real database rather than a fixture: all 46 thread rows still carried
`filesWithUserChanges` and 40 carried `state.currCheckpointIdx`, long after both
had left the type — including rows written by the build that removed them.

The general fix is an allowlist serializer that writes only declared fields; that
is what the explicit record format in S10 provides. Until then, any field removed
from `ThreadType` needs a matching entry in `_dropLegacyThreadFields`.

If undo/revert returns as a feature, it is a separate design with its own storage decision. The one constraint this document places on it: **do not interleave snapshot records with message records again.** That single choice is what created the index drift, the dead remap, and the storage blow-up.

---

# Part 1 — Upgrade and migrate

## 1.1 Working set and residency

The renderer holds only what is active:

- `_loadedMessageThreadIds` becomes an **LRU**, not a load-once set.
- Load on activate; evict when the thread is neither viewed nor running.
- **Never evict** a thread in `running`, `awaiting_user`, or `waiting_tools` — the agent loop reads `state.allThreads[threadId].messages` each iteration; eviction mid-run breaks it. Checkable from `streamState`.
- Writes batch through the existing 500 ms coalescing (`_pendingMessageKeyWrites` → `_flushPendingThreadWrites`), so a flush becomes one channel call and one append per message.

**This requires auditing every reader of `thread.messages`.** One is already confirmed to break: `_getAllSeenFileURIs(threadId)` (`:4228`) reads the in-memory array for `@`-file MRU completion and returns `[]` for an evicted thread, silently degrading the feature. Every such reader must force-load or be reimplemented over the store. **This audit is a deliverable of Part 1, not a follow-up** — the failure mode is silent degradation, not an error.

**Honest limit:** this bounds residency *across* threads, not the size of one active thread's context. A single 1,000-message thread still occupies memory while it runs; that is what compaction is for.

## 1.2 Compaction anchoring

The prefix `[0, boundary)` is **immutable by an existing invariant**: `editUserMessageAndStreamResponse` refuses to touch anything before the boundary (`:4165`). A positional index is therefore a legitimate durable anchor *under that invariant*. The bugs are that loading violates it (bug 3) and that `0` is treated as absent (bug 4).

Fixes, smallest first:

1. **Truthiness → `!== undefined`** at `:3039` and `:5486`, plus a post-remap clamp.
2. **Adopt corrected metadata in memory** at `:1505` — spread `fullThread`, not `existing`.
3. **Make loading index-preserving** — automatic once indices come from records.

If (3) holds, the anchor stays a number and no format migration is needed for it.

## 1.3 Images

Images become **thread-owned**, fixing the GC bug by construction:

- Path becomes `threads/<threadId>/images/<uuid>.<ext>` — matching what the comment already claims.
- **Delete thread → delete the thread directory.** Messages and images in one operation, no reference scan.
- **Truncate → sweep the removed messages' images** against the retained prefix. The thread is loaded, so this is in-memory and cheap.
- **`duplicateThread` copies image files** into the new thread's directory rather than sharing URIs.
- **Eviction must never trigger image GC.** Only deletion and truncation may. An evicted thread has `messages: []`, so a scan-based GC would conclude its images are unreferenced and delete them all. Directory ownership removes the possibility rather than guarding against it.

Also: **move out of `userRoamingDataHome`** — it is the roaming profile, settings-sync territory, the wrong place for large binaries; `globalStorageHome` is correct. `cachedDescription` stays in the message payload: small text, must survive eviction.

## 1.4 Retention for user threads

| Lever | Rationale |
|---|---|
| **Cap individual tool results and `Terminal.text` at write time** | The real driver of value size. Perf 2 compaction trims *older* results; capping at write bounds all of them |
| **Global store budget** | Warn before deleting; evict children first |
| **No message-count cap** | Agentic threads are legitimately long. Capping them destroys work |

## 1.5 Migration

Lazy and per-thread; no giant startup migration.

1. On first load under the new version, read `void.chatMsg.<id>.*`, write `messages.jsonl`, then delete the old keys. Idempotent and resumable.
2. **Strip `state.mountedInfo`** and **drop `filesWithUserChanges`** as threads are rewritten.
3. **Delete checkpoint residue** per the checklist above, including `void.chatCheckpoint.*` keys.
4. **Images:** flat `voidImages/<uuid>.<ext>` files are attributed by scanning messages. Because duplicates may share a file, attribution **copies rather than moves** when more than one thread references the same URI.
5. **`compactionBoundaryIdx` carries across unchanged** — the log's explicit indices make the old numbering valid as-is.

**Lazy is a choice about *latency*, not about *reach*.** Everything above runs inside `_readThread(id, true)`, which only `_ensureMessagesLoaded` calls — so it runs when the user opens a thread and never otherwise. Startup reads every thread metadata-only (`_readThread(id, false)` in `chatThreadService.ts`) and returns before the migration loop, which is deliberate: it keeps launch cheap. The consequence is that residue in a thread the user never reopens is never cleared, and per-thread cleanup converges to whatever the user happens to visit rather than to a fixed point.

That was measured on a real profile while fixing bug 17. 287 checkpoint records across 23 threads, and 43,691 stored codespan failures, were all still present; they reached zero only when every thread was read in full and written back. The threads holding them were old ones — the largest, 4.5 MB of metadata and 61% of everything reclaimable, had last been opened eleven weeks earlier — which is exactly the kind of thread a read-path fix never reaches.

Two rules follow, and they apply to the S10 format migration rather than to the caches here:

- **A format migration must be a pass over all threads at startup, not a read-path side effect.** It has to complete without the user's cooperation. The offset table and per-thread log are what make that affordable, and residue a user could carry forever is a correctness bug rather than untidiness.
- **Reclaiming space is a separate, one-shot step.** SQLite frees pages inside the file rather than returning them to the OS, so deleting rows does not shrink `state.vscdb`: after removing 287 rows and 48,090 cache entries the file was still its original size, with ~12 MB of free pages. A migration that intends to give space back must `VACUUM` once at the end.

**Acceptance gate:** renderer memory no longer scales with total message count; a compaction anchor survives a restart on a thread that previously drifted; no thread metadata contains `mountedInfo` or `filesWithUserChanges`.

## 1.6 Bugs fixed in Part 1

**This is the canonical bug numbering for this document.** Every `bug N` reference in this document and in [`multiagent-assistant.md`](./multiagent-assistant.md) means the row numbered `N` below.

| # | Bug | Fixed by |
|---|---|---|
| 1 | Renderer mirrors all message bodies | Messages leave `IStorageService` |
| 2 | 100k-key load scan | No key scan; offset table |
| 3 | Load path renumbers indices | Explicit `i` per record |
| 4 | Compaction silently dropped when boundary is `0` | `!== undefined` + clamp |
| 5 | Corrected remap discarded in memory | Spread `fullThread` |
| 6 | Cross-thread image deletion | Thread-owned image directories |
| 7 | Image path contradicts its own comment | Thread directory, as documented |
| 8 | Images in the roaming profile | Moved to `globalStorageHome` |
| 9 | Unbounded growth | Tool-result and `Terminal.text` caps + budget |
| 10 | `_getAllSeenFileURIs` breaks under eviction | Reader audit |
| 11 | `filesWithUserChanges` dead field serialized as `{}` | Deleted |
| 12 | `state.mountedInfo` persisted as junk | Stripped before persist |
| 13 | `TERMINAL_SNIPPET_MAX_BYTES` comment cites a non-existent constant | Comment corrected |
| 14 | Stale claims in `checkpoint-storage-refactor.md` | Corrected alongside |
| 15 | Writes within the ~500 ms debounce of quitting are silently dropped (compaction, messages, usage) | Flush on `onBeforeShutdown`, which precedes the workbench's storage close; compaction additionally writes through immediately |
| 16 | Restored post-compaction usage never written to the usage key; ring differs between live and reopened windows | Write the restored value back, or clear the thread's pending usage write before `_storeThread` |
| 17 | A failed codespan resolution was stored as `null` and read back as a cache hit, so a span that failed once — cold language server, unready index, file not yet mentioned — stayed dead for the life of the thread; the dead entries were never reclaimed either | Failures held for the session in `_failedCodespanLinks` and never written; `common/codespanLinkCache.ts` decides what counts as a hit, and drops unresolved and out-of-range entries on write |

---

# Part 2 — Prepare for multiagent

Part 2 changes **no format**. It adds policy, fields, and lifecycle on top of Part 1's store.

## 2.1 Thread kinds and the policy layer

Add `kind: 'user' | 'child'` to thread metadata. The store does not care; policy does.

| Concern | `user` | `child` |
|---|---|---|
| Retention | Durable, no message cap | N days after completion, then prunable |
| Eviction priority | Last | First |
| Pinned tab strip | Eligible | Excluded — `pinnedThreadIds` is a UI concept |
| Working set | Normal | Shared budget with parent |
| Sealing | On close | On completion |

## 2.2 Shared residency budget

Part 1's LRU is per-thread. A fan-out runs the parent plus several children at once, so the budget becomes **global with a priority order**:

```
viewed thread  >  running parent  >  running children  >  idle children
```

Never evict anything in `running`, `awaiting_user`, or `waiting_tools`. A completed child drops to the lowest priority immediately.

## 2.3 Eviction and GC stay absolutely separate

Under single-agent an eviction/GC mix-up is latent. Under multiagent it is routine: children are created, completed, and evicted constantly, and an evicted thread has `messages: []`.

**Eviction drops memory. Only deletion and truncation delete bytes.** Directory ownership makes accidental image deletion structurally impossible, but any future scan-based GC reintroduces it. This is the most important invariant in Part 2.

## 2.4 Concurrency and churn

- **One writer per log.** The main process serializes per thread; concurrent children never contend on a file. No locking.
- **Bound concurrent channel calls.** A fan-out of 12 children each flushing on the 500 ms tick produces an IPC burst. Backpressure or a coalescing window is required, not optional.
- **Directory sharding.** Thousands of child directories in one parent degrades filesystem operations. Shard by id prefix (`threads/<id[0:2]>/<id>/`) if counts grow past a few thousand — cheap now, awkward to retrofit.
- **Cheap create/delete is a requirement.** A fan-out creates and destroys many directories per turn.

## 2.5 Linkage, cascade, and traversal

Linkage fields are small scalars in `state.vscdb` metadata, which is already fully mirrored — so **no new index is needed**:

- `parentThreadId`, `parentToolCallId`, `delegationDepth`, `kind`.
- **Cascade deletion:** deleting a parent deletes its children's directories. Child lookup is a metadata scan, bounded by thread count.
- **Tree traversal for the UI:** parent → children, again from metadata.
- **Pruning sweeper:** selects children by metadata timestamps alone, without opening a single log.

That metadata-only property is what keeps Part 2 cheap.

## 2.6 Cost rollup

Child spend rolls into the parent's cumulative counters and the active turn baseline (`_cumulativeThisTurnBaselineOfThreadId`, `:1825`). Both live in `state.vscdb`, so rollup is unaffected by eviction and needs no store access.

## 2.7 What does not change

- The log format, the service, and the channel.
- The image layout — a child's images live in the child's directory by the same rule.
- The working-set mechanism — extended with a global budget, not replaced.
- The compaction anchor — a number, per Part 1.
- Migration — nothing to migrate; `kind` and linkage are new optional fields, and existing threads are `user` threads by definition.

**Acceptance gate:** a fan-out of 12 children creates, runs, seals, and prunes without unbounded renderer growth, and deleting the parent removes children and their images.

---

## Design decisions

- **A log, not a database.** The verified data model is append-only with suffix truncation and a bounded trailing-batch fill, which a log matches exactly. SQLite in main was the leading candidate; it was rejected because its strongest argument — cross-thread image reference queries — is removed by making images thread-owned. It also has no in-repo precedent (exactly one `CREATE TABLE` exists, in the base storage layer) and would need a schema migration each time the `ChatMessage` union grows, which it has repeatedly.

- **The log is the source of truth; indexes are derived.** Cross-thread search, if wanted, becomes a rebuildable sidecar over the logs — not a reason to make the log a database.

- **The log logic is a pure module, not a service.** Parsing, folding by index, truncation, the offset table, and the migration transforms belong in a dependency-free module that the main-process channel merely wraps. This is a testability decision as much as a structural one: it puts the riskiest logic — truncation with superseding records below K, fold-by-index semantics, retention arithmetic — under plain-Node unit tests (`npm run test-node`, which runs mocha with no Electron and no display), leaving the channel as a thin adapter. The alternative — logic living inside services that need a running app to exercise — is why the current compaction bugs (4 and 5) were only found by reading.

- **Explicit index per record.** Load-bearing: every mutation becomes an append, and renumbering becomes impossible rather than merely avoided.

- **Transient tool states are stored, not derived.** `tool_request` is persisted so a pending approval survives reload, since `streamState` is not persisted. `running_now` is stored but meaningless after restart and read as `tool_request`.

- **Redundancy in tool messages is deliberate.** `content` and `rawParamsStr` are derivable in principle, but dropping them costs replay fidelity and prefix-cache warmth.

- **Thread-owned images.** Copy-on-duplicate converts an unsolvable cross-thread reference problem into a directory deletion.

- **Eviction and GC separated absolutely.** See 2.3.

- **Two parts, one format.** Part 2 adds policy without touching the format, so it can follow independently.

- **No message-count cap for user threads.** Retention is expressed as value-size and child-window policy, not length caps.

## Files to change

| File | Part | Change |
|---|---|---|
| `common/threadStoreService.ts` | 1 | **New** — `IThreadStoreService`, channel client |
| `electron-main/threadStoreChannel.ts` | 1 | **New** — log append/read/truncate/delete in main |
| `browser/chatThreadService.ts` | 1 | Store-backed I/O; LRU working set; compaction fixes; image ownership; strip `mountedInfo`; drop `filesWithUserChanges`; remove checkpoint residue |
| `common/chatThreadServiceTypes.ts` | 1 | Delete `CheckpointEntry`; correct the `TERMINAL_SNIPPET_MAX_BYTES` comment |
| `common/storageKeys.ts` | 1 | Deprecate `MESSAGE_KEY_PREFIX`, remove `CHECKPOINT_KEY_PREFIX` |
| `browser/tools/searchHistory.tool.ts` | 1 | Read from the store, not the ambient thread |
| `browser/react/src2/sidebar-tsx/SidebarChat.tsx` | 1 | Image write path; partial render |
| `docs/designs/checkpoint-storage-refactor.md` | 1 | Correct stale claims; drop the redesign section |
| `common/chatThreadServiceTypes.ts` | 2 | `kind`, `parentThreadId`, `parentToolCallId`, `delegationDepth` |
| `browser/chatThreadService.ts` | 2 | Global working-set budget; cascade deletion; child pruning; cost rollup |
| `browser/react/src2/sidebar-tsx/` | 2 | Child threads in a tree, not the pin strip |

## Delivery

Execution order is a single sequential list — S1 → S10, then the multiagent milestones — maintained in [`multiagent-assistant.md`](./multiagent-assistant.md#delivery-sequence). It is not duplicated here.

This document's work maps onto that sequence as follows:

| Step | Covers | Part |
|---|---|---|
| **S1** | Bug 15 (shutdown durability) | 1 |
| **S2** | Bugs 4, 5, 16 (compaction anchoring and context accounting) | 1 |
| **S3** | Checkpoint residue; bugs 11, 12, 13, 14 (dead field, junk field, stale comments and doc) | 1 |
| **S4** | Bug 9, caps half (value-size caps) | 1 |
| **S5** | Bugs 6, 7, 8 (cross-thread deletion, path, location) | 1 |
| **S10** | Bugs 1, 2, 3, 10 (the store, the load path, the reader audit); plus all of Part 2 — thread kinds, retention policy, shared residency budget, cascade deletion, pruning | 1 + 2 |

Bug numbers are canonical in both documents — see [1.6 Bugs fixed in Part 1](#16-bugs-fixed-in-part-1).

S6–S9 are not storage work; they are cross-cutting preparation recorded in the program sequence.

Note that Part 2 is not a separate delivery step. Its policy layer (kinds, retention, shared budget, cascade) ships inside **S10**, because the claim that Part 2 changes no format is what makes it addable there rather than a milestone of its own. If Part 2 turns out to need a format change, that is the signal this document's Part 1 design was wrong.

## Non-goals

- **A second database.** The log plus `state.vscdb` is the whole storage layer.
- **Cross-thread search.** Per-thread is what the product does; a global index is a separate, rebuildable concern.
- **Message-count caps on user threads.**
- **Image bytes in messages.** They are files and stay files.
- **Checkpoint storage.** Removed, and not reinstated here.
- **Fixing `void.pendingDiffsI` thread provenance.** Diffs are stored globally with no thread attribution, which blocks review of concurrent writers — but it is an `editCodeService` concern, tracked with the multiagent design, not a storage-format concern.
- **Compressing the log.** Measure first; value caps are the better lever.
- **A format change in Part 2.** If Part 2 needs one, Part 1's design was wrong.

## Risks

- **Reader audit is load-bearing.** Any code deriving state from `thread.messages` breaks silently under eviction. `_getAllSeenFileURIs` is one confirmed instance; the audit must be exhaustive.
- **Eviction/GC interaction.** The most dangerous path, routine under multiagent.
- **Log growth from duplicate records.** Tool batches append superseding records. Compaction on seal bounds it; a thread that never seals can grow. Needs a threshold, not just a trigger.
- **Truncation correctness.** Naive `ftruncate` can revert a superseded message below K; truncation must rewrite the winning prefix.
- **Migration on real data.** Two migrations touching every thread, with duplication making image attribution non-trivial. Both must be idempotent and resumable.
- **Multi-window invalidation.** `onDidChangeItemsExternal` no longer covers messages; the channel must provide an equivalent.
- **Losing `IStorageService` guarantees.** Atomic per-key writes and cross-window sync come free today; the log must supply atomic appends, explicit change broadcast, and — the guarantee actually being lost today — **durability at shutdown**. Any new store must not inherit the current failure mode where a write inside the debounce window is discarded without error when the window closes.
- **Partial reads need offsets.** Reading a tail window needs the offset table, which needs a read. A footer index or a byte-length hint in metadata avoids the first full parse.
- **IPC burst under fan-out.** The most likely source of jank once multiagent ships.
