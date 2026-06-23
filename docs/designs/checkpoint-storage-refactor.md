# Checkpoint Storage Refactor

## Problem

`state.vscdb` grows to 1.24 GB (normal: 10–50 MB), causing renderer crashes on startup/reload.

### Crash chain

1. `Storage.init()` calls `database.getItems()` which transfers **all** key-value pairs from the main process SQLite database to the renderer via IPC into an in-memory `Map`
2. With 1.24 GB of data, the renderer blocks deserializing the IPC payload → unresponsive → Electron watchdog kills it (exit code 5)
3. With multiple windows, concurrent SQLite access → `SQLITE_BUSY: database is locked` → uncaught exception in main process → all windows die

### Root cause: file snapshots stored as chat messages

Checkpoints are file snapshots for the undo/redo feature. They were stored as `role: 'checkpoint'` messages inside `thread.messages[]`, interleaved with real conversation messages in the same `void.chatMsg.*` storage keys. Each checkpoint contains `entireFileCode` — the full text of every touched file.

A single thread (`c1db57af-...`) accumulated:
- 12,958 total messages (including 1,426 checkpoints)
- Checkpoints account for **905 MB** (97% of the thread's storage)
- Individual checkpoint messages are 2–2.4 MB each (full file content)

### Why checkpoints bloat

1. **Broken dedup** — `_computeNewCheckpointInfo` compared snapshots with `===`, but `getVoidFileSnapshot()` returns a new object every call, so the check is always false. Every user checkpoint re-stored all previously-touched files even if unchanged.

2. **No expiry** — checkpoints accumulate forever. Accept/reject/reload all preserve them. Only deleted by:
   - Send new message after undoing (truncates future history)
   - Edit a previous message (deletes from that point onward)
   - Delete the thread

## Current status: checkpoint feature disabled

The checkpoint feature (undo/redo file state via "Checkpoint" buttons in chat) has been **temporarily disabled** to ship the storage/performance fix cleanly. All checkpoint creation, jump, and UI rendering code is commented out with `// checkpoint disabled — see checkpoint-storage-refactor.md`.

### What's kept (active)
- **Storage key separation** (`CHECKPOINT_KEY_PREFIX = 'void.chatCheckpoint.'`) — infrastructure ready for re-enablement
- **Migration** — old bloated checkpoint data is deleted on load in `_readThread`:
  - Old checkpoints in `void.chatMsg.*` keys (with `role === 'checkpoint'`) are skipped and compacted out
  - Old checkpoints in `void.chatCheckpoint.*` keys are deleted
  - Checkpoint keys are deleted on thread deletion (`_storeThread(undefined)`)
- **`CheckpointEntry` type** — remains in `chatThreadServiceTypes.ts`, just not in the `ChatMessage` union

### What's disabled (commented out)
- `checkpoints: CheckpointEntry[]` field on `ThreadType`
- `currCheckpointIdx` on `ThreadState`
- `jumpToCheckpointBeforeMessageIdx` — interface declaration and implementation
- `_addCheckpoint`, `_addUserCheckpoint`, `_addToolEditCheckpoint` — checkpoint creation
- `_editCheckpointInThread`, `_getCheckpointInfo`, `_computeNewCheckpointInfo`, `_getCheckpointsBetween`, `_getCheckpointBeforeMessage`, `_readCurrentCheckpoint`, `_addUserModificationsToCurrCheckpoint` — checkpoint helpers
- `_storeCheckpointKey`, `_deleteCheckpointKeysFrom` — checkpoint storage helpers
- `_pendingCheckpointKeyWrites` — pending write map
- All `_addUserCheckpoint` call sites (6 locations in agent loop)
- All `_addToolEditCheckpoint` call sites (2 locations in `_runToolCall`)
- `Checkpoint` component in `SidebarChat.tsx`
- `checkpointsOfMessageIdx` memo in `SidebarChat.tsx`
- `currCheckpointIdx` computation in `SidebarChat.tsx` (both sites)
- `isCheckpointGhost` / `isMsgAfterCheckpoint` in `_ChatBubble` / `UserMessageComponent` / `AssistantMessageComponent`
- `checkpointIdx` in render cache type, `depsMatch` check, and cache assignment
- All `<Checkpoint>` rendering in all three render paths (incremental append, scroll prepend, full rebuild)
- `currCheckpointIdx` prop on all `<ChatBubble>` call sites

### Message storage (simplified)

`messageCount` was removed — it was only needed to handle gaps from deleted checkpoint keys. With checkpoints disabled, message keys are always contiguous `0, 1, 2, ...`. The read loop reads until `undefined`:

```typescript
let writeIdx = 0
for (let i = 0; ; i++) {
    const msgRaw = this._storageService.get(MESSAGE_KEY_PREFIX + threadId + '.' + i, ...)
    if (msgRaw === undefined) break
    const msg = JSON.parse(msgRaw, ...) as any
    if (msg.role === 'checkpoint') continue // @deprecated Migration 2 — discard old checkpoint data
    if (writeIdx !== i) {
        // compact: re-store at contiguous index
        this._storageService.store(MESSAGE_KEY_PREFIX + threadId + '.' + writeIdx, ...)
        this._storageService.remove(MESSAGE_KEY_PREFIX + threadId + '.' + i, ...)
    }
    messages.push(msg)
    writeIdx++
}
```

New messages append at `messages.length`:
```typescript
const msgIdx = oldThread.messages.length
this._storeMessageKey(threadId, msgIdx, message)
```

### Why disabled

The checkpoint feature had multiple interacting bugs (broken dedup, wrong index space, stale cache, duplicate creation, grey-out not working) that consumed significant debugging effort without reaching a stable state. The core goal — fixing the database bloat crash — is achieved by the storage separation and migration alone. The checkpoint feature will be redesigned from scratch with a cleaner architecture (see below) rather than continuing to patch the existing implementation.

## Storage layout

```
state.vscdb (SQLite, loaded at startup via getItems):
  void.chatThreadIndex              — [threadId1, threadId2, ...]
  void.chatThread.<id>              — metadata (title, timestamps, model)
  void.chatUsage.<id>               — usage stats
  void.chatMsg.<id>.<n>             — conversation messages only (user/assistant/tool)
  void.chatCheckpoint.<id>.<n>      — checkpoint snapshot data (unused — infrastructure for future)
```

## Files affected

- `src/vs/workbench/contrib/void/browser/chatThreadService.ts` — checkpoint code commented out, migration kept, `messageCount` removed, read loop simplified
- `src/vs/workbench/contrib/void/common/chatThreadServiceTypes.ts` — `CheckpointEntry` type, `ChatMessage` union
- `src/vs/workbench/contrib/void/common/storageKeys.ts` — `CHECKPOINT_KEY_PREFIX`
- `src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx` — `Checkpoint` component, `checkpointsOfMessageIdx`, `currCheckpointIdx`, `isCheckpointGhost`, render cache — all commented out

## Future: checkpoint redesign

Key design decisions for the new implementation:

1. **Turn-level grouping** — group all file changes in one LLM turn (multiple tool calls) into a single before/after checkpoint pair, not per-tool-call checkpoints
2. **Pending turn checkpoint** — a mutable in-memory checkpoint that collects before-states as tools run, committed once at end of turn
3. **After-state from `_addUserCheckpoint`** — the end-of-turn checkpoint captures the final state of all changed files
4. **Dedup** — skip before-state if file unchanged since last checkpoint (old checkpoint already has it)
5. **Retention limit** — cap at N checkpoints per thread (e.g. 50), delete oldest

### Checkpoint purpose

Checkpoints exist so the LLM (and user) can revert file changes made by tool calls. They are NOT for tracking user manual edits — that's what the editor's native undo (Cmd+Z) is for. The checkpoint system only needs to track files that tools touch.

### Key insight: `_computeNewCheckpointInfo` limitation

`_computeNewCheckpointInfo` only checks files already in checkpoint history (via `lastIdxOfURI`). It cannot discover brand-new files. This means `_addToolEditCheckpoint` is the entry point that puts a file into checkpoint history — without it, `_addUserCheckpoint` can never detect changes to that file. Any redesign must ensure files enter history before they can be tracked.

## Future optimization: diff-based snapshots

Current approach stores `entireFileCode` (full file content) per checkpoint. If the LLM changes 5 lines in a 4,600-line file, the checkpoint stores all 4,600 lines (~180 KB). With 50 retained checkpoints, that's ~9 MB for a single large file.

An alternative is storing **diffs** — only the changed lines relative to the previous checkpoint. Restore would apply diffs in sequence from a base snapshot. This reduces each checkpoint from ~180 KB to ~2 KB (just the changed lines), but adds complexity:

- Restore becomes O(N) — must replay diff chain from nearest base
- Need periodic full snapshots as "base" to bound restore time
- More complex migration and storage format

Not needed now. Worth considering if conversations regularly touch very large files (10,000+ lines) or if retention limit needs to increase.
