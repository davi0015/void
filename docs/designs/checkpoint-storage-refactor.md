# Checkpoint Storage Refactor

## Problem

`state.vscdb` grows to 1.24 GB (normal: 10–50 MB), causing renderer crashes on startup/reload.

### Crash chain

1. `Storage.init()` calls `database.getItems()` which transfers **all** key-value pairs from the main process SQLite database to the renderer via IPC into an in-memory `Map`
2. With 1.24 GB of data, the renderer blocks deserializing the IPC payload → unresponsive → Electron watchdog kills it (exit code 5)
3. With multiple windows, concurrent SQLite access → `SQLITE_BUSY: database is locked` → uncaught exception in main process → all windows die

### Root cause: file snapshots stored as chat messages

Checkpoints are file snapshots for the undo/redo feature. They are stored as `role: 'checkpoint'` messages inside `thread.messages[]`, interleaved with real conversation messages in the same `void.chatMsg.*` storage keys. Each checkpoint contains `entireFileCode` — the full text of every touched file.

A single thread (`c1db57af-...`) accumulated:
- 12,958 total messages (including 1,426 checkpoints)
- Checkpoints account for **905 MB** (97% of the thread's storage)
- Individual checkpoint messages are 2–2.4 MB each (full file content)

### Why checkpoints bloat

1. **Broken dedup** — `_computeNewCheckpointInfo` (line 2626) compares snapshots with `===`, but `getVoidFileSnapshot()` returns a new object every call, so the check is always false. Every user checkpoint re-stores all previously-touched files even if unchanged.

2. **No expiry** — checkpoints accumulate forever. Accept/reject/reload all preserve them. Only deleted by:
   - Send new message after undoing (truncates future history)
   - Edit a previous message (deletes from that point onward)
   - Delete the thread

## Architecture: separate chat history from file history

### The fundamental problem

Checkpoints and chat messages are two independent concerns coupled by a bad implementation choice:

| | Chat messages | File history (checkpoints) |
|---|---|---|
| **Content** | Text, tool calls/results | Full file snapshots |
| **Purpose** | Conversation + LLM context | Undo/redo file state |
| **Loaded at startup** | Yes (UI needs them) | No (only needed on undo click) |
| **Sent to LLM** | Yes | Never |
| **Size** | Small (~2 KB each) | Huge (~635 KB each) |

The only coupling is **UI placement** — the "Checkpoint" button renders between chat messages in the timeline. But that's a rendering concern, not a data model concern. The checkpoint doesn't read the message before or after it. It doesn't use message content. The `messageIdx` passed to `jumpToCheckpointBeforeMessageIdx` is just "where am I in the list" — purely positional.

### New storage layout

```
state.vscdb (SQLite, loaded at startup via getItems):
  void.chatThreadIndex              — [threadId1, threadId2, ...]
  void.chatThread.<id>              — metadata (title, timestamps, model, messageCount)
  void.chatUsage.<id>               — usage stats
  void.chatMsg.<id>.<n>             — conversation messages only (user/assistant/tool)
  void.chatCheckpoint.<id>.<n>      — checkpoint snapshot data (independent sequence)
```

- Chat messages contain only conversation data — no `role: 'checkpoint'` entries
- Checkpoints are a flat, independently-numbered timeline within each thread
- `currCheckpointIdx` points into the checkpoint sequence, not the message array
- Undo/redo navigates the checkpoint sequence (checkpoint 5 → 4, or → 6)
- No interleaving — the UI computes visual placement from sequence order

### Message index management

Messages are stored as `void.chatMsg.<threadId>.<n>` where `<n>` is a monotonically increasing index. New messages always append at the last index:

```typescript
const nextIdx = thread.messageCount  // tracked in thread metadata
this._storageService.store(MESSAGE_KEY_PREFIX + threadId + '.' + nextIdx, ...)
thread.messageCount = nextIdx + 1
```

The read loop uses `messageCount` instead of breaking on undefined, so deleted checkpoint keys (gaps) are skipped:

```typescript
for (let i = 0; i < thread.messageCount; i++) {
    const msgRaw = this._storageService.get(MESSAGE_KEY_PREFIX + threadId + '.' + i, ...)
    if (!msgRaw) continue  // skip gaps (deleted checkpoints, etc.)
    messages.push(JSON.parse(msgRaw, ...))
}
```

No renumbering needed. Delete checkpoint keys freely, gaps are harmless.

### Checkpoint entry type

```typescript
// Before (interleaved in messages array):
export type CheckpointEntry = {
  role: 'checkpoint';
  type: 'user_edit' | 'tool_edit';
  voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };
  userModifications: { voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } };
}

// After (independent storage, not a ChatMessage):
export type CheckpointEntry = {
  type: 'user_edit' | 'tool_edit';
  filePaths: string[];  // which files this checkpoint snapshots (for navigation)
  voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined };
  userModifications: { voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } };
}
```

The `role` field is removed — checkpoints are no longer `ChatMessage` variants.

## Implementation plan

### Phase 0 — Automatic migration (in code, for all users)

No manual script needed. Migration runs automatically in `ChatThreadService._readThread` on the first load after the fix ships.

Since `getItems()` already loads everything into the in-memory `Map`, gaps from deleted checkpoint keys are harmless. The migration:

1. Read all messages using the old sequential loop (break on undefined)
2. Filter out `role === 'checkpoint'` messages — delete their storage keys
3. Store `messageCount` (number of remaining conversation messages) in thread metadata
4. Future reads use `messageCount` loop (skip gaps) instead of break-on-undefined

For extreme bloat (1+ GB), the first cold start still crashes during `getItems()` IPC transfer. The auto-restart with warm OS cache survives, migration runs, old checkpoint keys are deleted, and subsequent startups are clean. This is acceptable — one crash for existing users with extreme bloat, then clean forever.

### Commit 1 — Fix checkpoint dedup (P0, 1-line change)

**File**: `src/vs/workbench/contrib/void/browser/chatThreadService.ts`, `_computeNewCheckpointInfo`

**Change**: Replace `===` reference equality with `entireFileCode` string comparison.

```typescript
// Before (broken — always false, new object every call):
if (oldVoidFileSnapshot === voidFileSnapshot) continue

// After:
if (oldVoidFileSnapshot.entireFileCode === voidFileSnapshot.entireFileCode) continue
```

**Impact**: Stops 90% of new bloat from recurring. User checkpoints will only store files that actually changed.

### Commit 2 — Separate file history from chat messages (P0, refactor)

Remove checkpoints from `thread.messages[]` and store them independently.

#### Type changes (`chatThreadServiceTypes.ts`)

- Remove `CheckpointEntry` from the `ChatMessage` union type
- `CheckpointEntry` becomes a standalone type (no `role: 'checkpoint'`)
- Add `messageCount: number` to thread type (for gap-safe read loop)
- Add `checkpointCount: number` and `currCheckpointIdx: number | null` to thread state (for checkpoint navigation)

#### Storage changes (`chatThreadService.ts`)

- **`_addCheckpoint`**: Write checkpoint to `void.chatCheckpoint.<threadId>.<checkpointCount>` instead of appending to messages array. Increment `checkpointCount`.
- **`_readThread`**: Use `messageCount` loop (skip gaps) for messages. Load checkpoints separately from `void.chatCheckpoint.*` keys.
- **`_storeThread(undefined)` / `_deleteMessageKeysFrom`**: Also delete checkpoint keys for the thread.
- **`jumpToCheckpointBeforeMessageIdx`**: Renamed to `jumpToCheckpoint`. Navigation uses checkpoint sequence numbers, not message indices.
- **`_getCheckpointsBetween`**: Reads from checkpoint keys instead of scanning message array.
- **`_computeNewCheckpointInfo`**: Reads from checkpoint keys for dedup comparison.
- **`_makeUsStandOnCheckpoint`**: Creates checkpoint in independent store.
- **Truncation on undo-then-send**: Truncates chat messages and checkpoints separately. For messages: delete keys from the truncation point onward, update `messageCount`. For checkpoints: delete keys, update `checkpointCount`.

#### Migration (automatic, in `_readThread`)

Old checkpoint messages (with `role === 'checkpoint'`) in `void.chatMsg.*` are detected on load:

1. Read all messages using old sequential loop (break on undefined)
2. Separate into conversation messages and old checkpoints
3. Delete old checkpoint keys from `void.chatMsg.*`
4. Store `messageCount = conversationMessages.length` in thread metadata
5. Old checkpoint snapshots are discarded (undo history for old checkpoints is lost — acceptable since they were causing crashes)

### Commit 3 — Checkpoint retention limit (P1)

Keep only the last N checkpoints per thread (e.g. 50). When a new checkpoint is created and `checkpointCount > N`, delete the oldest checkpoint key and decrement the base offset.

Consistent with existing behavior — truncation already deletes old checkpoints. This adds proactive cleanup for long conversations where no truncation occurs.

Worst case with retention: 50 checkpoints × ~200 KB = ~10 MB.

## Files affected

- `src/vs/workbench/contrib/void/browser/chatThreadService.ts` — checkpoint create/read/delete/navigation paths, read loop, migration
- `src/vs/workbench/contrib/void/common/chatThreadServiceTypes.ts` — `CheckpointEntry` type, `ChatMessage` union, thread type
- `src/vs/workbench/contrib/void/common/storageKeys.ts` — new key prefixes
- `src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx` — `Checkpoint` component, navigation calls

## Priority

| Priority | Task | Type | Impact |
|----------|------|------|--------|
| P0 | Automatic migration | In-code | Strips 905 MB of old checkpoints for all existing users |
| P0 | Commit 1: Fix dedup | 1-line code change | Stops 90% of new bloat |
| P0 | Commit 2: Separate file history | Refactor | Checkpoints no longer in message array, independent storage |
| P1 | Commit 3: Retention limit | Code | Caps checkpoint count for long conversations |

## Future optimization: diff-based snapshots

Current approach stores `entireFileCode` (full file content) per checkpoint. If the LLM changes 5 lines in a 4,600-line file, the checkpoint stores all 4,600 lines (~180 KB). With 50 retained checkpoints, that's ~9 MB for a single large file.

An alternative is storing **diffs** — only the changed lines relative to the previous checkpoint. Restore would apply diffs in sequence from a base snapshot. This reduces each checkpoint from ~180 KB to ~2 KB (just the changed lines), but adds complexity:

- Restore becomes O(N) — must replay diff chain from nearest base
- Need periodic full snapshots as "base" to bound restore time
- More complex migration and storage format

Not needed now — `===` fix + retention limit keeps storage at ~10 MB. Worth considering if conversations regularly touch very large files (10,000+ lines) or if retention limit needs to increase.
