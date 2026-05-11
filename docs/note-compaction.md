# Thread Compaction — Design Notes

Status: **design exploration, not started**. Captured from discussion on 2026-05-03.

## Problem

At ~300k tokens the user resets the thread, losing all project context. With DeepSeek 4's 1M window the bottleneck isn't capacity — it's accumulated noise from completed tasks: debugging round-trips, intermediate `read_file`/`grep` results, small bug fixes. The user wants to keep the model "warmed up" on what was accomplished (summaries) while dropping the verbose details, without starting a new thread.

Cost is not the primary driver ($0.50/day on DeepSeek 4 with 50M cached tokens). The value is **avoiding re-read cost** when switching topics within the same project.

## Key architectural constraint

**Chat history and context history are separate and must stay separate.**

- **Chat history** = stored `ChatMessage[]` on the thread = what the UI renders. Never modified by compaction.
- **Context history** = `SimpleLLMMessage[]` built at send time by `_chatMessagesToSimpleMessages` + `compactToolResultsForRequest` + `prepareMessages`. Always derived from chat history, never stored independently.

This follows the same pattern as the existing Light-tier compaction (`compactToolResultsForRequest`), which trims tool result bodies in the outgoing copy without touching stored messages. The new feature is a more aggressive version of the same principle.

Cursor follows this pattern too — it compacts context but never modifies the chat history shown in the UI.

## Design: LLM-summarized per-task-block compaction

### Trigger

The `compact_history` tool is called by the LLM when the user asks (e.g., "compact the old tasks" or "compact turns 3 to 7"). Not automatic — the user controls when to compact.

### Task blocks

A "task block" is one user message plus all assistant/tool/checkpoint messages that follow it until the next user message:

```
Task block:
  [user₁]
  [assistant]
  [tool]*
  [assistant]*
  [checkpoint]*
  ...
  → ends at next [user₂]
```

### Two fields on the `user` ChatMessage

```typescript
| {
    role: 'user';
    content: string;
    displayContent: string;
    // ...existing fields...
    compactionSummary?: string;   // LLM-generated summary for this group
    skipInContext?: true;          // this turn is covered by a previous compaction
  }
```

**`compactionSummary`**: When set, the context builder emits `[user message, {role: 'assistant', content: summary}]` instead of converting the full task block. All assistant/tool/checkpoint messages after this user message (until the next user turn) are skipped in context.

**`skipInContext`**: When set, this user message AND its entire task block are skipped in context entirely. Used for user turns that are covered by a previous turn's `compactionSummary`.

### Per-task-block compaction (simple case)

Each user turn gets its own independent summary:

```
[user₁: compactionSummary="S1"]  → context: [user₁] [S1]
  [assistant, tool, tool, ...]   → skipped in context, shown in UI
[user₂: compactionSummary="S2"]  → context: [user₂] [S2]
  [assistant, tool, ...]         → skipped in context, shown in UI
[user₃: no flags]                → context: [user₃] [full detail...]
  [assistant, tool, ...]         → full detail in context
```

### Cross-turn compaction (multiple tasks → one summary)

When compacting user turns i, i+1, i+2 together:

```
[user₁: compactionSummary="combined summary"]  → context: [user₁] [summary]
  [assistant, tool, ...]                        → skipped
[user₂: skipInContext=true]                     → skipped entirely
  [assistant, tool, ...]                        → skipped
[user₃: skipInContext=true]                     → skipped entirely
  [assistant, tool, ...]                        → skipped
[user₄: no flags]                               → context: [user₄] [full detail]
```

Context sent to LLM: `[user₁] [combined summary] [user₄] [full detail...]`

UI: renders all messages as always. These flags only affect context building.

### Context builder changes (`_chatMessagesToSimpleMessages`)

```
for each ChatMessage:
  if role === 'user' and skipInContext → skip this message
    also skip all following non-user messages (the task block)
  if role === 'user' and compactionSummary → emit user + summary as assistant
    skip all following non-user messages (the task block)
  else → convert normally
```

## Tool design: `compact_history`

### Turn identification

The LLM needs to specify which turns to compact. Options explored:

**Option A — Position-based**: `compact_history({ keep_recent_turns: 3, summary: "..." })`. Simple but coarse — can't compact a specific topic in the middle.

**Option B — Turn-number range**: `compact_history({ from_turn: 3, to_turn: 7, summary: "..." })`. The LLM counts user messages from 1. Reliable for frontier models on conversations with <50 user turns. Tool validates indices and echoes back the user messages at boundaries for confirmation.

**Option C — List mode first**: `compact_history({ action: "list" })` returns numbered user turns, then `compact_history({ from_turn: 3, to_turn: 7, summary: "..." })` to execute. Two calls but precise.

**Recommendation**: Option B for v1. The LLM can count its own turns. Add validation in the tool implementation that echoes back boundary messages in the result.

### Summarization

The LLM generates the summary itself as part of calling the tool — it already has the full conversation in context and knows what was accomplished. No separate summarization LLM call needed.

The summary should capture:
- What was accomplished (outcomes, not process)
- Key decisions made and why
- Files created/modified (if relevant to the outcome)
- Important context for future tasks

Should NOT include: debugging steps, intermediate errors, tool call details.

### Tool parameters

```typescript
compact_history({
  from_turn: number,        // first user turn to compact (1-indexed)
  to_turn: number,          // last user turn to compact (inclusive)
  summary: string,          // LLM-generated summary of the compacted work
})
```

Tool result echoes back the compacted turns for verification:
```
"Compacted turns 3-7.
  Turn 3: 'what about ScrollToBottomContainer...'
  Turn 7: 'ok, it looks good now...'
  5 task blocks replaced with summary."
```

## Edge cases

### Edit a message within a compacted range

Current edit behavior: `messages.slice(0, messageIdx)` — everything after the edited message is deleted. The compaction flags on messages before the edit point are preserved. If a `skipInContext` message is edited (sliced away), the `compactionSummary` on an earlier message may become stale (it referenced work that's now being redone). Options:
- Auto-clear the `compactionSummary` when any of its dependent `skipInContext` messages are deleted. Requires knowing which `skipInContext` messages belong to which `compactionSummary`.
- Let it be stale and let the user re-compact. Simpler.

### Re-compaction

Compacting a range that includes already-compacted turns works naturally:
- If user₃ already has `compactionSummary`, and you now compact user₁-user₅ together, user₁ gets the new combined `compactionSummary`, user₃'s old `compactionSummary` is cleared and replaced with `skipInContext`.
- No nesting — just overwrite the flags.

### JSONL export

Trivial — `compactionSummary` and `skipInContext` are just optional fields on the user message. Exporters can include them as metadata or ignore them. The full chat history (all messages) is always present.

### Prefix cache behavior

Compaction changes the context layout → cache miss from the first compacted message onward. But:
- System message prefix stays cached
- One-time rebuild cost is trivial (~$0.01)
- Subsequent requests build new cache on the shorter prefix
- Net win: can go 6-8x more turns before hitting 300k again

## Relationship to existing Light-tier compaction

The existing `compactToolResultsForRequest` (Perf 2) and this feature are complementary, not competing:

| | Light-tier (existing) | Thread compaction (new) |
|---|---|---|
| Trigger | Automatic (size gate) | User-triggered via tool |
| Scope | Individual tool result bodies | Entire task blocks |
| Granularity | Per-message | Per-user-turn |
| Stored messages | Untouched | Untouched (flags only) |
| Context modification | Trims bodies, keeps envelopes | Replaces blocks with summaries |
| Reversible | Yes (per-request, stateless) | Yes (clear flags) |

Both operate on the context layer only. Light-tier handles the automatic "don't send stale grep results" case. Thread compaction handles the user-driven "I'm done with this topic, summarize it" case.

## Open questions

- **Should compaction be a tool or a UI feature?** Tool is more natural (user says "compact the old work" in chat), but UI selection (click start/end markers) is more precise for range selection. Could support both.
- **Model for summarization**: The chat model generates the summary inline (it already has context). No separate LLM call needed. But if we wanted automatic compaction in the future, a separate cheap model might be better.
- **Turn counting reliability**: Frontier models count 10-15 turns accurately. At 50+ turns, accuracy may degrade. The list-mode fallback (Option C) handles this but adds a round-trip.
- **Stale summary on edit**: When a user edits a message and `skipInContext` messages get sliced away, the associated `compactionSummary` becomes partially stale. Auto-clearing requires dependency tracking. Manual re-compact is simpler for v1.

## Files that would be modified

- `chatThreadServiceTypes.ts` — add `compactionSummary` and `skipInContext` to user message type
- `convertToLLMMessageService.ts` — update `_chatMessagesToSimpleMessages` to respect the flags
- `toolsServiceTypes.ts` — add `compact_history` tool type
- `toolsService.ts` — implement `compact_history` tool (validates turns, sets flags on messages)
- `prompts.ts` — add `compact_history` tool definition
- `SidebarChat.tsx` — render compaction indicator on compacted bubbles (optional visual badge)
