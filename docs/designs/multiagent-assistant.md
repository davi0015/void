# Towards a Multiagent Assistant

## The bet

Today the assistant is one agent with one context window and one stream of attention. Everything it learns goes into a single append-only conversation that every subsequent request re-sends in full, and every task it is given runs to completion before the next one starts.

That is not the shape of the work it is being asked to do. Real work is parallel, hierarchical, and mostly independent — several questions can be investigated at once, most of them have nothing to do with each other, and most of what is learned along the way is scaffolding that the final answer does not need.

The bet of this document is that the assistant should be able to act as a **supervised collective** rather than a single conversationalist: a parent agent that decomposes a task, hands scoped pieces of it to child agents with their own contexts, and synthesizes bounded results back into one coherent answer — while the user watches a tree instead of reading a transcript.

The hard part is not spawning agents. Spawning agents is easy, and everyone is shipping it. The hard part is **governance**: making sure a child can never exceed its parent's authority, that autonomy cannot silently become unbounded spend, that concurrent writers cannot corrupt each other's work, that a background agent which needs approval can be answered or fails closed rather than hanging forever, and that a user supervising twelve agents can still understand what all of them are doing.

That is where the design effort belongs, and it is what this document is mostly about.

## One agent is the wrong shape for the work

The single-context agent hits three ceilings, and they are worth separating because they have different fixes.

**Context is spent on process, not on the task.** Investigating a twelve-file subsystem to make a three-line change costs twelve file bodies that persist in the conversation for the rest of the thread. The final edit is made with a context window mostly full of exploration the model no longer needs. `ThreadType`'s own comments already document the arithmetic in the existing agent loop: a turn with N tool calls fires N requests, each carrying the accumulated history, so input tokens grow O(N²) over a turn. This is not a new problem introduced by multiagent design — it is the problem that makes multiagent design attractive, and it is also the problem that a naive multiagent design makes worse.

**Independent work cannot be parallelized.** Reading eight unrelated files is serialized through one conversation because there is one conversation. Parallel *tool calls* already exist — `batchIndex`/`batchSize` on `ToolMessage`, concurrent execution in `_runConcurrentToolAndRun` — but parallel *lines of reasoning* do not. Two investigations that share no state still have to take turns.

**Attention dilutes.** A forty-thousand-token history of exploration degrades the quality of the final change independently of whether it fits in the window. There is a class of work — "find every call site of `sendLLMMessage` and report them" — whose intermediate steps have no value to the parent conversation at all. Doing it inline pollutes the parent's reasoning; doing it in a child that returns three lines of findings does not.

## What becomes possible

Three concrete shapes of work that are awkward or wasteful today:

**Parallel investigation.** "Why is the terminal test flaky?" becomes four children — one reading the test, one reading the terminal service, one checking recent history for flaky-test fixes, one running the test repeatedly — whose findings the parent synthesizes. The parent's context contains four summaries, not four file bodies and every dead end.

**Adversarial review.** The parent makes a change, then forks a reviewer child that inherits the reasoning and is asked to find what's wrong with it. The reviewer needs the parent's context, so it inherits rather than starting fresh, and its critique comes back as a bounded result that the parent can act on or reject.

**Scoped implementation.** "Add the setting to all four provider configs" becomes four children each owning a distinct file. This is the shape that requires the most care, because it introduces concurrent writers, and it is deliberately the last capability to arrive.

## The dangerous half

Every one of those capabilities has a matching failure mode, and they are the reason this is a design document rather than a feature request.

- **Cost amplification.** Delegation turns one O(N²) loop into several. A user who fans out aggressively will spend more, and if the UI does not make that visible it will feel like theft.
- **Lost updates.** Two children editing the same file concurrently lose writes. In this codebase specifically, `editCodeService` maintains DiffZones keyed by URI, globally — there is no per-agent isolation to lean on.
- **Approval deadlock.** A backgrounded child that needs approval, with nothing able to answer, hangs invisibly and holds a run open forever.
- **Unbounded autonomy.** The agent loop currently runs until the model stops calling tools. There is no cap. N children are N uncapped loops.
- **Supervision collapse.** A fan-out of twelve children must not become twelve tabs and twelve transcripts. If the user cannot see the shape of the work at a glance, the feature has made their job harder.

## The three pillars

Every design decision below is downstream of one of these. They are stated as properties because they are what the implementation must preserve, and because they are what the tests should assert.

**1. Isolation.** A child's exploration never enters the parent's context. Only its bounded summary crosses back. This is the entire point — a subagent that returns its transcript is a context amplifier, not an optimization, and it would make the O(N²) problem worse rather than better.

**2. Attenuation.** A child can never hold more permission than its parent. Authority only ever narrows going down the tree. There is no configuration, agent definition, or prompt that widens it.

**3. Boundedness.** Every child has a round, token, and wall-clock budget and an explicit terminal status. Autonomy is always finite, and exhaustion is always distinguishable from completion.

## What Void becomes

The migration is described in phases in the back half of this document, but the phases are easier to read as capability milestones, because the capability is what the user gets and the phases are just how it arrives.

| Milestone | The user can | The agent can | Governance that must exist first |
|---|---|---|---|
| **1. Governed runs** | See what a run costs and why it stopped | Hit a bound and report `blocked` instead of looping | Budgets; `blocked` as a terminal status distinct from `done` |
| **2. Delegation** | Hand off research and get a summary | Spawn a read-only child and receive a bounded result | Attenuation; depth cap; result contract |
| **3. Parallelism** | Watch a fan-out and steer it | Run children concurrently, message and interrupt them | Concurrency caps; approval routing; interrupt cascade |
| **4. Context inheritance** | Ask for a review of its own reasoning | Fork a child that inherits context; route children to cheaper models | Prefix-cache discipline; per-definition model selection |
| **5. Scoped implementation** | Hand out parallel edits safely | Own disjoint files across children | File partitioning; worktree isolation |

Milestone 1 is deliberately not a multiagent feature. It is the precondition that makes every later milestone safe, and it is useful on its own.

**Storage prerequisite.** Milestones 2–5 assume threads scale beyond what the current store supports. Multiagent turns thread creation from a human-rate event into a per-turn fan-out, which multiplies every bug catalogued in [`thread-storage.md`](./thread-storage.md): each child's message bodies become resident in the renderer for the whole session, per-thread key layout and churn scale with children rather than conversations, and nothing bounds growth. That work is specified there in two parts and is a **dependency of Milestone 2**, not a parallel track. Milestone 1 can proceed without it.

## Preparatory work

Some multiagent blockers are worth removing **before** multiagent work starts, because they fix a live single-agent problem at the same time. The test for inclusion is deliberately strict — a change qualifies only if **both** hold:

1. **A user hits the problem today**, with a single agent.
2. **It removes a multiagent blocker** rather than merely relocating code.

Anything satisfying only (2) is a speculative abstraction — building the shape of a feature before its consumer exists — and is deferred.

| Change | Live problem today | Multiagent blocker removed | Risk |
|---|---|---|---|
| **Storage upgrade + migration** ([`thread-storage.md`](./thread-storage.md) Part 1) | Renderer holds every message of every thread for the whole session; loading a thread costs 100k key probes; nothing bounds growth; shared images are deleted across threads | Residency, retention base, churn headroom, plus sixteen catalogued bugs | Low |
| **Explicit thread identity through `ToolCtx`** | `search_history` reads the *visible* thread rather than the executing one (`searchHistory.tool.ts:30`); 14 sites share the ambient pattern | De-multiplexing — every child tool call needs it | Low |
| **Provenance on diff areas** (`editCodeService`) | With two threads open and pending edits to the same file, `acceptOrRejectAllDiffAreas({ uri })` accepts both | The hardest blocker for writer children | Medium |
| **Budgets + `blocked` terminal status** | The agent loop runs until the model stops calling tools; a runaway tool loop costs real money | Fan-out is N unbounded loops without it | Low |
| **Parameterize `_runChatAgent`** | None directly, but it reads `chatMode` and `overridesOfModel` from global settings mid-iteration (`:2949`) | Children need their own mode and model | Low |

**Deliberately deferred.** These have no standalone justification, and their shape depends on how delegation actually behaves — so building them now means guessing: `attenuateAutoApproveMode` (dead code until a child exists), the result contract and `SubagentOutcome` types, the global concurrency governor, the `AgentDefinition` **file format and UX**, notification aggregation, the child tree UI, and failure-isolation semantics.

`AgentDefinition` is the instructive case. Generalizing `ChatMode` looks like clean preparation, but its schema — allowed tools, permission ceiling, model, budgets, result format — is determined by how delegation works. Split it: the type and the loop parameterization are safe, and appear above; the file format waits.

If the preparatory work lands, Milestone 2 stops being "build child threads and the storage they need" and becomes "build child threads on substrate that already handles N."

---

The remainder of this document is the engineering specification for those milestones.

## Relationship to existing systems

Delegation is assembled from primitives that already exist. This table is load-bearing: if a row starts needing a *new* subsystem rather than a change to an existing one, that is the signal the design has drifted.

| Existing system | Reused as | Change |
|---|---|---|
| `ThreadType` (`chatThreadService.ts:140`) | child thread container | + parent linkage, agent identity, budget, result fields |
| `_runChatAgent` (`chatThreadService.ts:2916`) | child execution loop | parameterized by an `AgentDefinition` |
| `ThreadStreamState` / `IsRunningType` (`:403`, `:382`) | child run state | none — `waiting_tools` already models "parked, auto-resumes" |
| `ToolDefinitionCore` (`toolTypes.ts:61`) | new delegation tools | new tool files + registry entries |
| `ChatMode` (`voidSettingsTypes.ts:472`) | `AgentDefinition` | generalized from a closed union to a loaded definition |
| `.void/skills` + `load_skill.tool.ts` | agent definition files | new `.void/agents/` sibling, same frontmatter pattern |
| `ThreadPermissionMode` / `effectiveAutoApproveMode` (`toolsServiceTypes.ts:96`, `:128`) | permission inheritance | + attenuation (currently union-only) |
| `QueuedMessage` / `queueUserMessage` (`:395`, `:529`) | parent→child steering | reuse as-is |
| `latestUsage` / `cumulativeUsageThisThread` (`:154`, `:162`) | cost rollup | + child→parent aggregation |
| `workspaceUri` scoping / `isThreadReadOnly` (`:209`, `:357`) | child workspace scope | inherit from parent |
| `frozenAiInstructions` (`:196`) | child system-prompt stability | inherit, then extend with agent role text |

## Architecture

### 1. Agent definitions

Today `ChatMode = 'agent' | 'gather' | 'normal'` (`voidSettingsTypes.ts:472`) is a closed union that gates tool availability in `availableTools` (`toolRegistry.ts:66`) and selects a branch of `chat_systemMessage` (`prompts.ts:287`). That is a hardcoded agent definition with three entries.

Generalize it into a loaded definition, stored as files exactly like skills:

```
.void/agents/researcher.md          # workspace scope
~/.void/agents/researcher.md        # global scope (workspace overrides)
```

```markdown
---
name: researcher
description: Read-only investigation of a question across the codebase
tools: read_file, ls_dir, get_dir_tree, search_for_files, search_pathnames_only,
       search_in_file, go_to_definition, go_to_usages, semantic_search
permissionCeiling: read_only
model: null
maxRounds: 30
maxResultTokens: 2000
---
You investigate questions about this codebase and report findings.

You are read-only. Do not propose or make edits.

Return your findings as:
- **Answer**: the direct answer, 1-3 sentences.
- **Evidence**: `file_path:line_number` for each claim, with a short quoted excerpt.
- **Uncertainty**: what you could not determine.
```

```ts
export type AgentDefinition = {
  name: string
  description: string
  systemPrompt: string                              // the body
  tools: BuiltinToolName[] | 'all'                  // allowlist
  permissionCeiling: ThreadPermissionMode           // 'read_only' by default
  modelSelection: ModelSelection | null             // null = inherit parent's
  maxRounds: number
  maxResultTokens: number
}
```

The index of definitions (names + one-line descriptions) is injected via the existing `aiInstructions` path, exactly as the skills index is (`docs/designs/skills.md`). It is frozen on first send via `frozenAiInstructions`, so it stays prefix-cache stable and adds no new freeze plumbing.

`ChatMode` is not deleted. It remains the user-facing mode selector for the top-level thread; `agent` mode simply gains the delegation tools. Built-in definitions (`researcher`, `reviewer`, `planner`) ship as defaults; users add files to override or extend them.

### 2. Child threads

A child is a `ThreadType` with linkage fields added:

```ts
// added to ThreadType
parentThreadId?: string          // absent = top-level thread
parentToolCallId?: string        // the run_subagent call that spawned it
agentName?: string               // resolved AgentDefinition name
delegationDepth: number          // 0 for top-level; parent.delegationDepth + 1
budget?: ThreadBudget
resultSummary?: string           // the bounded string returned to the parent
resultStatus?: SubagentStatus
```

`newThreadObject` (`chatThreadService.ts:469`) grows an optional `parent` argument. Child creation sets `workspaceUri` from the parent — never from ambient context, because ambient workspace resolution in a background context is a correctness hazard — copies `permissionMode` down through attenuation, and inherits `frozenAiInstructions` with the agent's `systemPrompt` appended.

Children are not added to `pinnedThreadIds` (a UI tab concept), but they are persisted through the existing per-thread storage path so they survive reload and are inspectable. `_isThreadMutationBlocked` and `isThreadReadOnly` apply unchanged.

### 3. The delegation tools

Two tools, deliberately separate, because the semantics differ in the way that matters most — context cost.

**`run_subagent`** — fresh context. The child starts with an empty `messages` array and only the task text.

```ts
'run_subagent': {
  agent_name: string       // from the agent index
  task: string             // the instruction; self-contained
  context?: string         // optional supporting text the parent must hand over explicitly
  wait: boolean            // true = block this tool call; false = background, returns a handle
}
```

**`fork_subagent`** — inherits context. The child starts with a copy of the parent's `messages` up to the current index.

```ts
'fork_subagent': {
  agent_name: string
  task: string
  wait: boolean
}
```

`fork_subagent` is the expensive verb: it duplicates the parent's entire history into a second thread, so its token cost scales with whatever the parent has accumulated. It is for review and continuation, where the child genuinely needs the parent's reasoning — not a cheaper way to write a normal delegation. Splitting them into two verbs rather than one tool with a flag is deliberate: the fresh/fork choice is the highest-leverage decision a delegating model makes, and it deserves a distinct name and description.

Both are registered in `toolDefinitionOfToolName` (`toolRegistry.ts:30`) and gated to `ChatMode === 'agent'` in `availableTools` (`toolRegistry.ts:66`). Neither is in `approvalTypeOfBuiltinToolName` — the delegation itself needs no approval; the child's own tool calls are gated by the child's attenuated permissions, which is the correct place for the decision.

### 4. The result contract

The result contract is where isolation is actually enforced, so it is specified tightly.

```ts
export type SubagentStatus = 'done' | 'blocked' | 'budget_exceeded' | 'error' | 'rejected'

export type SubagentOutcome = {
  status: SubagentStatus
  summary: string           // the ONLY text the parent sees — hard-capped at maxResultTokens
  filesTouched: string[]    // workspace-relative paths
  childThreadId: string     // for the UI's "open transcript" link
  usage: LLMUsage           // rolled up into the parent
  error?: string
}
```

`stringOfResult` renders this as compact text — Void's convention, where `stringOfResult` returns LLM-facing prose rather than JSON. The parent never receives the child's `messages`, tool results, or reasoning.

A child that exceeds `maxResultTokens` is truncated with an explicit marker rather than silently cut, reusing the `[trimmed — ...]` convention already established for Perf 2 compaction, so the model has a known remedy: ask a narrower follow-up, or read the specific file itself.

### 5. Permission attenuation

This is where the existing code is actively wrong for delegation and must change.

`effectiveAutoApproveMode` (`toolsServiceTypes.ts:128`) combines the global config with a thread's `ThreadPermissionMode` via `combineAutoApproveModes` (`:121`), which returns the more permissive of the two. Union semantics are correct for a user-opened thread — a chat may grant more than config. They are exactly backwards for a child.

Add the dual:

```ts
// in toolsServiceTypes.ts, mirroring combineAutoApproveModes
export const attenuateAutoApproveMode = (parent: AutoApproveMode, child: AutoApproveMode): AutoApproveMode =>
  _autoApproveModeRank[parent] <= _autoApproveModeRank[child] ? parent : child
```

A child's effective mode for a tier is the minimum of three inputs:

```
min( global config , parent thread grant , agent definition permissionCeiling )
```

Properties that must hold:

- A `read_only` parent produces `read_only` children regardless of what the child's agent definition asks for. A definition can narrow permissions, never widen them.
- `permissionCeiling: read_only` is the default for every agent definition, including user-authored ones. Escalation is opt-in per definition.
- **A child never auto-approves merely because it is backgrounded.** If a child needs approval and the parent is running unattended, the parent parks in `waiting_tools` and the approval surfaces on the child thread in the UI through the existing notification path (`_notifyAwaitingApproval`, `:3734`). If nothing can answer, the call fails closed.
- `delegationDepth` gates nesting. Milestone 2 ships depth 1: a child may not delegate further. Enforced in `validateParams`, not in prose, because prose is advisory and validation is not.

### 6. Fan-out, concurrency, and caps

Void already streams parallel tool calls and runs them concurrently (`_concurrentRunningCountOfThreadId`, `_fireConcurrentTerminal`, `_waitForConcurrentTools`). Delegation rides that machinery rather than introducing a scheduler: a model that emits three `run_subagent` calls in one assistant turn gets three children running concurrently, joined by the existing batch-drain path (`_tryDrainPendingBatch`, `:2124`).

Caps, all configurable, all enforced in code:

| Cap | Default | Rationale |
|---|---|---|
| Concurrent children per parent | 4 | Bounds cost spike and provider rate-limit pressure |
| Total children per parent turn | 12 | Bounds a runaway fan-out |
| Delegation depth | 1 | Recursive delegation explodes cost with little quality gain |
| Child rounds | 30 | Matches `maxRounds` in the definition |
| Child result tokens | 2000 | Bounds parent context growth per child |

A declarative **batch** call is the preferred way for a model to fan out, because models are unreliable at orchestrating fan-out turn by turn — they lose track of children, serialize them, or re-delegate redundantly. Milestone 3 adds a single-call form expressing "run these N tasks, join, return all results." A JS-sandboxed workflow engine is deliberately deferred (see Non-goals).

### 7. Steering and lifecycle

A child that can only be fire-and-forget is a function call. A child that can be steered is a collaborator. The substrate already exists: `QueuedMessage` and `queueUserMessage` (`:395`, `:529`) capture text plus selections plus model override, and the queued head auto-sends when the current run ends. Parent→child messaging is therefore a queued message on the child thread, with no new mechanism.

Exposed to the parent as:

- `send_message(child_thread_id, message)` — steers a running child at its next step boundary, or starts a turn on an idle child.
- `interrupt_child(child_thread_id)` — stops the child's current turn only; the child remains steppable. Mirrors existing `abortRunning` semantics.
- `list_children()` — live status snapshot. Not a polling mechanism: the parent is notified when a child settles, consistent with how the rest of Void's concurrent tools resolve.

`_interruptConcurrentTools` (`:2601`) extends to cascade into children on parent abort, so cancelling the parent does not leave orphaned children burning tokens.

### 8. Budgets and the blocked state

Void's agent loop currently runs until the model stops calling tools, with no bound. Delegation multiplies exactly the quantity that makes this dangerous, so a budget is a precondition for everything else.

```ts
export type ThreadBudget = {
  maxRounds: number
  maxTokens: number
  maxWallClockMs: number
  spentRounds: number
  spentTokens: number
  startedAt: number
}
```

Checked once per loop iteration in `_runChatAgent`, before the next request is prepared. On exhaustion the loop stops cleanly and the thread lands in a terminal state rather than being killed mid-stream.

`IsRunningType` (`:382`) already contains `waiting_tools` — "parked: batch drained, background concurrent tools still running (auto-resumes, nothing to approve)" — which is precisely the parent-waiting-on-children state. The addition needed is a `blocked` outcome distinguishable from `done`, so a parent can tell "the child finished the task" from "the child stopped because it hit a wall or a bound." Status is reported through the existing `_notifyAwaitingApproval` / `_notifyDone` notification path.

### 9. Cost rollup

`latestUsage` and `cumulativeUsageThisThread` (`:154`, `:162`) are per-thread. Child spend must roll up into the parent's cumulative figure, or a user's bill will not match the thread they were watching.

When a child settles, add its `usage` into the parent's cumulative counters and into the currently-active turn baseline (`_cumulativeThisTurnBaselineOfThreadId`, `:1825`). The `TokenUsageRing` then reflects true delegation cost, and per-child spend stays visible on the child thread itself.

### 10. UI and observability

Void's existing UI — tabs, pinned threads, unread badges, notifications, the approval flow — is an advantage here, so children should not be hidden behind a private channel.

- Child threads render as real threads with an agent badge and a parent indicator; the parent's tool call renders a nested, collapsed child card with live status, mirroring how concurrent terminal tools already render.
- A transcript link on every `run_subagent` result jumps to the child thread, so delegation is always explainable — you can see why a child concluded what it did without that reasoning occupying the parent's context.
- A parent→children tree in the sidebar makes fan-out legible at a glance.
- Child runs use the existing notification path, subject to `notifyOnApproval` / `notifyOnDone` and the notification-sound settings.

## Design decisions

- **A child is a `ThreadType`, not a new execution engine.** Reusing `_runChatAgent` means approvals, cancellation, compaction, telemetry, and persistence are inherited rather than reimplemented. A second loop would drift from the first within two releases. Cost: `_runChatAgent` must be parameterized — it currently reads `chatMode` and `overridesOfModel` from global settings at `:2949` — which is a contained refactor.

- **Two tools rather than one with a flag.** The fresh/fork distinction has opposite cost profiles and is the highest-leverage choice the model makes. A distinct verb with a distinct description gives it a better chance of choosing correctly than a boolean buried in a schema.

- **The result contract is bounded and structured; the transcript never crosses.** This is the difference between delegation that reduces context pressure and delegation that multiplies it. Given that `ThreadType`'s comments already document O(N²) input growth, an unbounded result contract would turn one bad property into a worse one.

- **Read-only children by default; writers are opt-in.** Two independent blockers, and the second is worse than the first. `editCodeService` keys DiffZones by URI globally, so two children editing one file is a lost-update race. More seriously, diff areas carry **no thread or agent provenance**: `acceptOrRejectAllDiffAreas({ uri })` accepts or rejects every pending change at that URI regardless of which thread produced it, so with concurrent children the user cannot approve one child's work without approving another's, and `interruptURIStreaming({ uri })` can cancel a different thread's stream. Separately, the `edits` auto-approve tier justifies itself on reversibility (`toolsServiceTypes.ts:26-29` — "edit_file always revertable via checkpoint"), and checkpoints have been removed, so that premise is currently false. Milestone 2 ships read-only children only; writer children arrive in Milestone 5 and require provenance and reversibility first.

- **Attenuation, not union.** `combineAutoApproveModes` is correct for user-opened threads and wrong for children; a child needs the minimum of three inputs. This is a deliberate divergence from an existing helper rather than a reuse of it, and it is the single most important safety property in the design.

- **Budgets before fan-out.** Fan-out demos well, which is exactly why it should not go first. Without a round/token cap and a `blocked` state, N children are N unbounded loops. The budget is small and unglamorous and it is Milestone 1.

- **Declarative batch before a workflow engine.** A JS-sandboxed orchestration language captures a lot of power and a lot of surface area. A single-call declarative fan-out captures most of the practical value at a fraction of the complexity, and keeps orchestration inside the tool-call protocol the model already understands.

- **Children inherit workspace scope, never ambient scope.** `isThreadReadOnly` (`:357`) already gives a principled answer for cross-workspace threads; a child should not be able to resolve a different workspace than its parent.

- **Nesting is capped in validation, not in prose.** Instructions to "don't recurse" are advisory; `validateParams` is not.

## Files to change

All within `src/vs/workbench/contrib/void` unless noted.

| File | Change |
|---|---|
| `common/voidSettingsTypes.ts` | Add `AgentDefinition`, `ThreadBudget`, `SubagentStatus`, `SubagentOutcome` types |
| `common/toolsServiceTypes.ts` | Add `run_subagent` / `fork_subagent` params + results to the two type maps; add `attenuateAutoApproveMode` |
| `common/prompt/prompts.ts` | Add delegation tool definitions and the agent-index section to `chat_systemMessage` |
| `browser/tools/runSubagent.tool.ts` | **New** — spawn/await a fresh-context child, enforce depth and caps |
| `browser/tools/forkSubagent.tool.ts` | **New** — spawn a context-inheriting child |
| `browser/tools/childSteering.tool.ts` | **New** — `send_message`, `interrupt_child`, `list_children` |
| `browser/tools/agentDefinitionService.ts` | **New** — load/parse `.void/agents/*.md`, workspace overrides global, build the index |
| `browser/tools/toolRegistry.ts` | Register new tools; gate to `chatMode === 'agent'` in `availableTools` |
| `browser/chatThreadService.ts` | Child-thread creation; `_runChatAgent` parameterization; budget enforcement; blocked status; usage rollup; child cascade on interrupt |
| `browser/convertToLLMMessageService.ts` | Agent index appended to the `aiInstructions` path alongside the skills index |
| `browser/react/src2/sidebar-tsx/` | Child thread cards, parent/child tree, transcript link, agent badge |
| `docs/designs/multiagent-assistant.md` | This document |

## Delivery sequence

**Execution is a single sequential list: S1 → S10, then M1 → M5.** Each entry ships and is accepted on its own before the next begins.

Serial execution is a deliberate choice. It keeps each acceptance gate meaningful — there is one variable in flight at a time — and it lands the riskiest change (S10, a format migration over real user data) last, on ground where the correctness bugs are already fixed and the dead scaffolding is gone. The cost is that multiagent lands later than a parallel schedule would; that is accepted.

This sequence is *execution order*. The capability milestones in the table earlier describe what the user gets; the two are related but not the same list.

Bug numbers are canonical across both documents — see [`thread-storage.md` §1.6](./thread-storage.md#16-bugs-fixed-in-part-1).

| ID | Ships | Acceptance gate |
|---|---|---|
| **S1** | Durable writes on quit — pending writes are persisted, so a compaction can no longer be lost by quitting immediately (bug 15) | Compact → quit within 500 ms → relaunch → compaction intact |
| **S2** | Compaction and context accounting — never silently dropped when the boundary is `0`; the corrected boundary reaches memory; the context ring reports one number (bugs 4, 5, 16) | Ring identical live and after reopen; a compacted thread still sends its summary |
| **S3** | Residue and cleanup — `CheckpointEntry`, the 65 `// checkpoint disabled` markers and the dead helpers they guard, and `filesWithUserChanges` removed; `state.mountedInfo` stripped before persist; stale doc and comment claims corrected (bugs 11, 12, 13, 14). The checkpoint **read and cleanup** path is deliberately retained — see below | No `checkpoint disabled` markers remain; a thread containing legacy checkpoint keys still loads; no persisted metadata carries `mountedInfo` |
| **S4** | Value-size caps — `read_file` results and `Terminal.text` snapshots bounded at write time (bug 9, caps half) | An oversized result is stored under the cap with no agent-visible regression |
| **S5** | Image ownership — thread-owned image directories, copy-on-duplicate, move off the roaming profile (bugs 6, 7, 8) | Duplicate a thread with images, delete one, the other's images still render |
| **S6** | Thread identity — tools act on the executing thread rather than the viewed one | A tool invoked on a non-visible thread reads that thread's conversation |
| **S7** | Diff provenance — diff areas carry their originating thread; accept, reject and interrupt are scoped to it | Two threads with pending edits to one file: accepting in one leaves the other pending |
| **S8** | Budgets, `blocked`, and loop parameterization — a run stops at a round/token/wall-clock bound and reports why; `_runChatAgent` takes mode and model as arguments rather than reading global settings mid-iteration (**includes S9**) | A synthetic unbounded loop stops at the bound and reports `blocked`; single-agent behaviour otherwise byte-identical |
| **S9** | Loop parameterization — *ships inside S8*, listed separately only to keep this sequence aligned with the numbering used during review | Behaviour byte-identical |
| **S10** | Message store, migration, and bounded residency — message bodies leave the mirrored database; memory scales with active threads; load cost scales with thread size; per-thread lazy migration with a read fallback; store budget (bugs 1, 2, 3, 10) | Renderer memory no longer scales with total message count; a 5,000-message thread opens within budget; threads created before the change still open |
| **M1** | Agent definitions and attenuation — `AgentDefinition` file format and loader; agent index injected via `aiInstructions`; `attenuateAutoApproveMode`. *Capability milestone 1 ("governed runs") arrives earlier, with S8 — which delivers budgets, `blocked`, and the loop seam* | Existing single-agent behaviour byte-identical; budget defaults non-binding |
| **M2** | Delegation (read-only) — `run_subagent`; child threads with linkage, attenuated permissions, depth-1 enforcement, bounded result contract, cost rollup, child rendering with a transcript link | A research task delegated to a child measurably reduces parent peak context versus the same task inline |
| **M3** | Parallelism and control — batched fan-out in one call; concurrency and total-children caps; `send_message` / `interrupt_child` / `list_children`; parent→child tree UI; interrupt cascade; approval routing for non-visible children; failure isolation; aggregate status; shared residency budget | A fan-out of 12 children creates, runs, seals and prunes without unbounded renderer growth; one child failing leaves siblings and the parent usable |
| **M4** | Context inheritance and routing — `fork_subagent`; per-definition `modelSelection`; declarative pipeline and parallel stages | A fork inherits the parent's compaction state consistently, not raw pre-boundary messages |
| **M5** | Scoped implementation — writer children with explicit file partitioning; worktree-per-child isolation; optional JS orchestration sandbox | Deleting a parent removes children and their images; parallel writers do not lose updates |

**Scope correction in S3.** S3 removes the checkpoint *writing* residue. It deliberately keeps the read and cleanup path — the two `role === 'checkpoint'` skips in the load loops, the `checkpointsBeforeBoundary` remap, and the `CHECKPOINT_KEY_PREFIX` cleanup loops — because S3's own gate requires that a thread containing legacy checkpoint records still loads, and because the remap *is* the bug-3 fix. Removing them here would load checkpoint records into the conversation, leave the compaction boundary off by the number of records in front of it, and partially undo S2. Those four sites move to S10, where the message store renumbers indices and the tolerance stops being reachable. See [`thread-storage.md`](./thread-storage.md#checkpoints-removed-not-stored).

## Non-goals

- **A second execution engine.** One loop, parameterized.
- **A JS orchestration sandbox.** Deferred; the declarative batch must prove insufficient first.
- **Purpose-built fresh-agent iteration loops.** The workspace is already durable memory; the gap is budget bounds, not a new loop type.
- **Full child transcripts returned to the parent.** Never, by construction.
- **Auto-approval inside background children.** Never.
- **Recursive delegation beyond depth 1.** Not without evidence that it pays for itself.
- **N agents in one git worktree by default.** Not without explicit partitioning.

## Risks

- **Cost amplification.** The dominant risk. Delegation turns one O(N²) loop into several. Mitigated by Milestone 1 budgets, the concurrent-children cap, the bounded result contract, and cost rollup — but the honest position is that aggressive fan-out costs more, and the UI must make that visible rather than surprising.

- **Concurrent writes to the same file.** DiffZones are keyed by URI; two writers on one file lose updates. Mitigated by shipping Milestone 2 read-only and requiring explicit partitioning before writer children.

- **Weak-model orchestration.** Weaker models already show unreliable behavior with parallel reads and skills; delegation asks more of them. Consistent with existing Void philosophy (`skills.md`, "Model compliance"), the expectation is that strong models use it well and weak ones mostly won't. The failure mode is benign — a model that never delegates behaves exactly as today.

- **Approval deadlock.** An unattended child that needs approval must fail closed rather than hang. Requires the parent to park in a state the UI surfaces and the notification path to fire; if neither happens, the child hangs invisibly.

- **Prefix-cache disruption.** Appending agent role text to an inherited `frozenAiInstructions` changes the prefix, so a fork's first request is cache-cold. Acceptable once per child; unacceptable per request, so the freeze must happen once at child creation.

- **Persistence and migration.** New `ThreadType` fields are optional and must hydrate cleanly from existing persisted threads, following the established backward-compat convention (`emergencyTrimmedCount?`, `finishReason?`, and similar). Child threads created by an older build are top-level threads, which is a correct and harmless degradation.

- **Supervision collapse.** A fan-out of twelve children must not produce twelve tabs. Children belong in a tree, not the pin strip; `pinnedThreadIds` is a user-facing tab concept and children must not be auto-pinned. This is the risk that decides whether the feature feels like leverage or like noise.
