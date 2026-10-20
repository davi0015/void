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

**2. Inheritance.** A child's authority is its parent's, copied — never more. There is no configuration, definition or prompt that widens it, and none is needed to narrow it: the only way to widen would be to create the child with a different mode than the parent's, and creation copies it. See §5.

**3. Termination.** Every child reaches an explicit terminal status, so exhaustion is always distinguishable from completion. A bound on *spend* is deliberately not part of this reduction — §8 records why, and what it costs.

## What Void becomes

The migration is described in phases in the back half of this document, but the phases are easier to read as capability milestones, because the capability is what the user gets and the phases are just how it arrives.

| Milestone | The user can | The agent can | Governance that must exist first |
|---|---|---|---|
| **1. Governed runs** | See what a run costs and why it stopped | Hit a bound and report `blocked` instead of looping | Budgets; `blocked` as a terminal status distinct from `done`. **Not scheduled** — §8 records why |
| **2. Delegation** | Hand off work and get a summary | Spawn a child with its own capability and receive a bounded result | Inheritance (§5); depth cap; result contract; `send_message` |
| **3. Parallelism** | Watch a fan-out and steer it | Run children concurrently, message and interrupt them | Approval routing; interrupt cascade |
| **4. Context inheritance** | Ask for a review of its own reasoning | Fork a child that inherits context; route a child to a cheaper model | Prefix-cache discipline; an optional model argument on the spawn call |
| **5. Scoped implementation** | Hand out parallel edits safely | Own disjoint files across children | File partitioning; worktree isolation |

Milestone 1 is deliberately not a multiagent feature — it is useful on its own — and it is also not scheduled. With spend deprioritised (§8), nothing else waits on it.

**Storage is not a prerequisite for the first delegation.** An earlier revision claimed Milestones 2–5 depend on [`thread-storage.md`](./thread-storage.md) Part 1. That is true at fan-out scale and false at the scale Milestone 2 ships: one delegation creates one thread, and child threads use the same storage path top-level threads already use. What the storage work buys is *churn* — children created and pruned per turn rather than per week — and the point at which that matters is Milestone 3, not the first child. Child retention (pruning completed children) does ship with Milestone 2, because without it children accumulate forever.

The one storage behaviour to keep in view while delegating: every child's messages join the renderer's storage cache at startup like any other thread's, and residency is unbounded because the eviction work is parked. That is the same cost the product already pays per opened thread, multiplied by however many children persist — measurable, not yet a blocker.

## Preparatory work

Some multiagent blockers are worth removing **before** multiagent work starts, because they fix a live single-agent problem at the same time. The test for inclusion is deliberately strict — a change qualifies only if **both** hold:

1. **A user hits the problem today**, with a single agent.
2. **It removes a multiagent blocker** rather than merely relocating code.

Anything satisfying only (2) is a speculative abstraction — building the shape of a feature before its consumer exists — and is deferred.

| Change | Live problem today | Multiagent blocker removed | Risk |
|---|---|---|---|
| **Storage upgrade + migration** ([`thread-storage.md`](./thread-storage.md) Part 1) | Renderer holds every message of every thread for the whole session; loading a thread costs 100k key probes; nothing bounds growth; shared images are deleted across threads | Residency, retention base, churn headroom, plus sixteen catalogued bugs | Low |
| **Explicit thread identity on the tool call** | `search_history` reads the *visible* thread rather than the executing one (`searchHistory.tool.ts`). Verified when S6 was built: it is the only **tool** that does — the "14 sites" this row first estimated were mostly legitimate readers of the visible thread (composers, workspace normalization). The thread travels as a required argument to `callTool` alone, not as a field of `ToolCtx`: only `callTool` acts on the world, and putting it on the context meant rebuilding that context per call so two functions could carry an id they never read. The adjacent case, the approval buttons in `ToolResultComponents.tsx` resolving against `state.currentThreadId`, is unreachable until a child's prompt can be shown while the parent is on screen, so it belongs to M3 | De-multiplexing — every child tool call needs it | Low |
| **Provenance on diff areas** (`editCodeService`) | With two threads open and pending edits to the same file, `acceptOrRejectAllDiffAreas({ uri })` accepts both | The hardest blocker for writer children | Medium |
| **Budgets + `blocked` terminal status** | The agent loop runs until the model stops calling tools; a runaway tool loop costs real money | Fan-out is N unbounded loops without it | Low |
| **Parameterize `_runChatAgent`** | None directly, but it reads `chatMode` and `overridesOfModel` from global settings mid-iteration (`chatThreadService.ts:3079`) | Children need their own mode and model | Low |

**Deliberately deferred.** These have no standalone justification, and their shape depends on how delegation actually behaves — so building them now means guessing: the result contract and `SubagentOutcome` types, the global concurrency governor, notification aggregation, the child tree UI, and failure-isolation semantics.

**Dropped, not deferred.** Agent definition files, the agent index injected through `aiInstructions`, `attenuateAutoApproveMode`, and budget enforcement. §1, §5 and §8 carry the reasoning; the short version is that the parent writes the role, the child inherits the parent's authority, and spend is cheap enough not to bound.

If the preparatory work lands, Milestone 2 stops being "build child threads and the storage they need" and becomes "build child threads on substrate that already handles N."

---

The remainder of this document is the engineering specification for those milestones.

## Relationship to existing systems

Delegation is assembled from primitives that already exist. This table is load-bearing: if a row starts needing a *new* subsystem rather than a change to an existing one, that is the signal the design has drifted.

| Existing system | Reused as | Change |
|---|---|---|
| `ThreadType` (`chatThreadService.ts:123`) | child thread container | + parent linkage, `alias`, result fields (no `kind` — §2) |
| `_runChatAgent` (`chatThreadService.ts:3046`) | child execution loop | parameterized by the child thread rather than by global settings |
| `ThreadStreamState` / `IsRunningType` (`:403`, `:382`) | child run state | none — `waiting_tools` already models "parked, auto-resumes" |
| `ToolDefinitionCore` (`toolTypes.ts:61`) | new delegation tools | new tool files + registry entries |
| `ThreadPermissionMode` / `effectiveAutoApproveMode` (`toolsServiceTypes.ts:96`, `:128`) | permission inheritance | copy the parent's mode at creation; union then yields the parent's own answer |
| `QueuedMessage` / `queueUserMessage` (`:395`, `:529`) | parent→child steering | reuse as-is |
| `latestUsage` / `cumulativeUsageThisThread` (`:154`, `:162`) | cost rollup | + child→parent aggregation |
| `workspaceUri` scoping / `isThreadReadOnly` (`:209`, `:357`) | child workspace scope | inherit from parent |
| `frozenAiInstructions` (`:196`) | child system-prompt stability | inherit unchanged — there is no definition body to append (§1) |

## Architecture

### 1. Agents are prompt-scoped, not declared

There is no agent definition file and no catalogue for the model to choose from. A
subagent is an agent managed by another agent: it inherits the parent's workspace,
permission mode, model selection and frozen instructions, and its role is whatever the
parent writes in the task. That is the whole mechanism.

**This corrects an earlier revision**, which specified `.void/agents/<name>.md` files with
a frontmatter tool allowlist, a `permissionCeiling` and an index injected through
`aiInstructions`. Two things make that worse than nothing:

- **The parent always knows more than the declaration does.** It knows what the design
  says, what the codebase looks like, what "test this" means in this repository. No file
  can encode that, so the parent has to write it out regardless — the declaration becomes
  a second, staler copy of something the task text already contains.
- **Reduced capability makes the work impossible rather than safer.** A delegation asked
  to develop, test and review needs a terminal in all three cases. A child restricted
  below its parent cannot do the job it was created for, and a model that wants the job
  done routes around the restriction instead of complying with it.

The consequence is that a child's capability is **exactly the parent's**: same
`permissionMode`, same workspace, same model. Nothing is attenuated, because nothing
supplies a higher grant to attenuate. See §5, which is now a rule about inheritance
rather than a helper for narrowing.

`ChatMode = 'agent' | 'gather' | 'normal'` (`voidSettingsTypes.ts:472`) is unchanged. It
stays the user-facing mode selector for a top-level thread, and `agent` mode simply gains
the delegation tools.

**If named roles are ever wanted** — a cheap model for research, a strong one for
implementation — that is a model-selection concern and can land on top of this without a
capability system: an optional `model` argument on the spawn call, chosen by the parent.
It is not in M1 or M2.

### 2. Child threads

A child is a `ThreadType` with linkage fields added:

```ts
// added to ThreadType
parentThreadId?: string          // absent = top-level thread. This is the only
                                 // classification — see below; there is no `kind`
parentToolCallId?: string        // the run_subagent call that spawned it
alias?: string                   // the parent's name for it, e.g. "tester"
delegationDepth: number          // 0 for top-level; parent.delegationDepth + 1
resultSummary?: string           // the bounded string returned to the parent
resultStatus?: SubagentStatus
budget?: ThreadBudget            // deferred — see §8
```

**There is no `kind` field.** An earlier revision had `kind: 'user' | 'child'`, which was wrong twice over: the two values name different axes — `'user'` says whose thread it is, `'child'` says where it sits structurally — and the fact it encoded was already stored. `kind === 'child'` and `parentThreadId !== undefined` are the same statement, so two encodings could disagree, and one natural disagreement exists: a child whose parent was deleted before cascade lands. Deriving makes that state unrepresentable. "Is this a child?" is `parentThreadId !== undefined`, asked in three places — rendering, retention, and `list_children` — and answered the same way in each.

`newThreadObject` (`chatThreadService.ts:469`) grows an optional `parent` argument. Child creation **inherits** from the parent rather than consulting anything ambient: `workspaceUri` comes from the parent (ambient workspace resolution in a background context is a correctness hazard), `permissionMode` is copied unchanged, the model selection is the parent's, and `frozenAiInstructions` is inherited as-is — no definition body is appended, because there is no definition (§1).

`alias` exists because a UUID is a poor thing to hold across a long conversation. The parent coins it when it spawns the child and uses it in `send_message`, and it is what the child's card shows. It is an ergonomic name, not an identity: `childThreadId` remains the key.

Children are not added to `pinnedThreadIds` (a UI tab concept), but they are persisted through the existing per-thread storage path so they survive reload and are inspectable. `_isThreadMutationBlocked` and `isThreadReadOnly` apply unchanged.

**Nothing prunes a child.** An earlier revision gave children a retention policy — prunable N days after completion — on the reasoning that they are created at machine rate. That reasoning does not survive contact with the product: user threads already accumulate forever, that has been fine, and no measurement says otherwise. A background deleter that removes conversations the user never asked to lose is a worse default than a large database, and it would be the first destructive policy in the thread layer. Children are durable like any other thread; deleting a parent takes its children with it (later work, alongside cascade), and that is a user action rather than a policy. If thread count ever becomes a measured problem, the fix is chosen from a number, not pre-built.

### 3. The delegation tools

Three tools: spawn a child, continue one, and recover the list of what exists.

**`run_subagent`** — fresh context. The child starts with an empty `messages` array and only the task text.

```ts
'run_subagent': {
  alias: string            // a short name the parent chooses, e.g. "tester"
  task: string             // the instruction; self-contained, and it *is* the child's role
  wait: boolean            // true = block this tool call; false = background, returns a handle
}
```

There is no `agent_name`, because there is no catalogue (§1). The `task` is the role.

**Hand over by file, not by paste.** A child starts empty, so the parent has to give it
whatever it needs. When the artefact already exists — a design document, a failing test, a
diff — the task should name the file rather than inline its contents. Pasting spends the
parent's context re-typing work it already did, which is the opposite of the point; `task`
is for the instruction and the short facts, a file reference is for the artefact.

**`send_message`** — continue a child that already exists. Appends a user message to that
thread and runs it again.

```ts
'send_message': {
  childThreadId: string    // or `alias`
  message: string
}
```

This is nearly free once children are threads: a child is a conversation that already
persists, reloads and renders like any other, so a follow-up is an ordinary turn. It is
what makes delegation iterative rather than one-shot — a parent that asks for development
and then asks the same child to fix what the tests found is holding one conversation in
two parts.

**`list_children`** — derived from `parentThreadId`. It exists because the handles have to
survive the parent's own compaction: once a long conversation is summarised, the ids it
learned from earlier tool results are gone. Deriving the list from stored linkage makes
recovery always possible, so this is a correctness affordance rather than a convenience.

All three are registered in `toolDefinitionOfToolName` (`toolRegistry.ts:30`) and gated to
`ChatMode === 'agent'` in `availableTools` (`toolRegistry.ts:66`). None is in
`approvalTypeOfBuiltinToolName` — delegating needs no approval, and the child's own tool
calls are gated by its own permission mode, which is the parent's.

**`fork_subagent`** is deferred to M4. It inherits the parent's messages, so its cost scales
with whatever the parent accumulated; it belongs with the context-inheritance work, not
with basic delegation. Splitting the fresh and forked verbs rather than flagging one tool
stays deliberate: the choice is the highest-leverage decision a delegating model makes.

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

### 5. Permissions are inherited, not attenuated

A child's permission mode **is** its parent's. There is no third input and no helper to
compute a minimum, because nothing supplies a child with a higher grant than its parent
already has — see §1, which removes the definition file that used to carry a
`permissionCeiling`.

`effectiveAutoApproveMode` (`toolsServiceTypes.ts:128`) combines global config with a
thread's `ThreadPermissionMode` via `combineAutoApproveModes` (`:121`), returning the more
permissive of the two. Union semantics are correct here and need no dual: a child holding
the parent's mode unions to the same answer the parent unions to, so child and parent are
neither more nor less permissive than one another. The earlier revision added an
`attenuateAutoApproveMode` minimum of three inputs; with the ceiling gone it would compute
that same answer, so it is not written.

Three properties still have to hold, and none of them is about narrowing:

- **Delegation must not widen.** A child created with a default mode instead of the
  parent's would be the bug the helper above would have hidden. Child creation copies
  `permissionMode` from the parent; that copy is the whole enforcement.
- **A child never auto-approves merely because it is backgrounded.** If a child needs
  approval while the parent runs unattended, the parent parks in `waiting_tools` and the
  approval surfaces on the child thread through the existing notification path
  (`_notifyAwaitingApproval`, `:3734`). If nothing can answer, the call fails closed.
- `delegationDepth` gates nesting. Milestone 2 ships depth 1: a child may not delegate
  further. Enforced in `validateParams`, not in prose, because prose is advisory and
  validation is not.

**The known sharp edge, stated rather than guarded.** Because a child can do anything its
parent can, a child can write — and two children running at once can write to the same
file. File partitioning and worktree isolation are M5. Until then the safe use is
delegation whose work is disjoint, sequential, or read-only, and the tool description says
so: the model does the partitioning, and it can only do that if it knows the hazard exists.

### 6. Fan-out and concurrency

Void already streams parallel tool calls and runs them concurrently (`_concurrentRunningCountOfThreadId`, `_fireConcurrentTerminal`, `_waitForConcurrentTools`). Delegation rides that machinery rather than introducing a scheduler: a model that emits three `run_subagent` calls in one assistant turn gets three children running concurrently, joined by the existing batch-drain path (`_tryDrainPendingBatch`, `:2124`). Nothing needs building for the parallel case — it is what the tool loop already does with any parallel call.

**No count cap in M2.** An earlier revision specified four configurable caps here. Three were cost bounds, and cost is not worth building a limiter for (§8): a runaway is cheaper than the machinery that prevents it. The fourth, a count cap, has no measured justification either — the reference implementation this design is checked against has no run budget and no spawn limit at all, and models self-limit to a handful in practice.

The one structural limit that stays is **`delegationDepth: 1`**, and it is a shape rather than a cap: nesting is where capability stops being explainable, so M2 forbids it in `validateParams`.

Caps get revisited with M3, where concurrency is first-class and there is something to measure — specifically the 500 ms write-coalescing window, where N children flushing at once is an IPC burst that can be *observed* rather than predicted. Measure it there; do not pre-build the limiter.

The hazard that does need saying, because it is not about cost: **concurrent children can write to the same file.** §5 carries it, the tool description carries it, and the fix — partitioning, worktrees — is M5. Until then the model partitions by choosing disjoint work, which is exactly the judgement a delegating agent is being asked to exercise.

A declarative **batch** call — "run these N tasks, join, return all results" — remains the M3 form, because models are unreliable at orchestrating fan-out turn by turn: they lose track of children, serialize them, or re-delegate redundantly. It is a convenience over the same machinery, not a second one.

### 7. Steering and lifecycle

A child that can only be fire-and-forget is a function call. A child that can be steered is a collaborator. The substrate already exists: `QueuedMessage` and `queueUserMessage` (`:395`, `:529`) capture text plus selections plus model override, and the queued head auto-sends when the current run ends. Parent→child messaging is therefore a queued message on the child thread, with no new mechanism.

Exposed to the parent as:

- `send_message(child_thread_id, message)` — steers a running child at its next step boundary, or starts a turn on an idle child.
- `interrupt_child(child_thread_id)` — stops the child's current turn only; the child remains steppable. Mirrors existing `abortRunning` semantics.
- `list_children()` — live status snapshot. Not a polling mechanism: the parent is notified when a child settles, consistent with how the rest of Void's concurrent tools resolve.

`_interruptConcurrentTools` (`:2601`) extends to cascade into children on parent abort, so cancelling the parent does not leave orphaned children burning tokens.

### 8. Budgets, context pressure, and the blocked state

Void's agent loop runs until the model stops calling tools, with no bound. Delegation multiplies exactly the quantity that makes this dangerous, so a bound is a precondition for everything else — but the two halves of that sentence turned out to have different fates.

**Context pressure is implemented** (§8.1). It is a live single-agent defect, it needs no decision about what a run may *spend*, and the compaction work it builds on has already landed.

**Budgets and `blocked` are deprioritised, not deferred** (§8.2). They are not in any milestone. LLM spend is low enough that a runaway loop costs less than the machinery to prevent one, and the reference implementation this design is checked against carries no run budget at all. What remains load-bearing is the *ordering constraint* in §8.2, which no longer binds anything because nothing is scheduled behind it.

The consequence is worth stating plainly: **nothing bounds a run.** A delegated child inherits that, so a looping child is bounded only by its provider's own limits. That is an accepted trade rather than an oversight, and it is the first thing to revisit if spend ever becomes visible to users.

#### 8.1 Context pressure relief

Relief is a ladder, cheapest first: prune tool-result bodies (no model call, request image only, stored messages untouched), and summarise the oldest legal span only if pruning did not bring the request under the threshold. What is implemented is the first rung — written, switched off, with its policy table beside it — plus the reaction to a provider-confirmed overflow:

| Step | Behaviour |
|---|---|
| **Classify** | A provider error is tested for the phrasings that mean "this does not fit" (`common/contextOverflow.ts`). Until now every failure was retried identically, so an overflow was sent three times (`CHAT_RETRIES`), 2.5 s apart (`RETRY_DELAY`), each attempt guaranteed to fail the same way |
| **Relieve** | The request is rebuilt through `_compactToolResultsForRequest` with its size gate forced, trimming old tool-result bodies to a head, a marker and a tail. No model call, no stored message touched |
| **Retry once** | Only if the rebuild actually trimmed something. If it did not, a second attempt would be the same request again, so the run skips straight to the error |
| **Otherwise** | The run stops with the provider's message *and* a line saying what to do about it (`CONTEXT_OVERFLOW_MESSAGE`) |

**The trigger is the provider, not a pre-flight estimate.** Two size valves already exist in `convertToLLMMessageService.ts` and both are switched off with their reasons written beside them — the Light-tier tool-body pruner (`:244`) and the emergency message trim (`:674`). The first is off because trimming breaks the provider's prefix cache at the trim point, and at 500k+ the miss costs more than the saving; the second because "silently truncating messages … loses context without the user's knowledge. Better to let the request fail so the user can manually compact or start a new thread." Both arguments are about paying a price on a request that *works*. Neither survives a request the provider has already rejected: there is no warm cache to protect, and the failure the user would otherwise be handed is the thing the trim prevents. So relief fires on a confirmed overflow and on nothing else — which also keeps the second comment's intent, since bodies are trimmed with the marker and tooltip the pruner already produces, while no message is dropped and no summary is silently substituted.

Relief is remembered for the rest of the run: once the thread is known not to fit, later requests in that run are built relieved, because history only grows within a run and each iteration would otherwise buy a failed request to rediscover it. Nothing is persisted, so the next turn starts from an unrelieved request.

Measured on the fixture in `test/void/context-overflow-relief.test.mjs` — eight turns of four `read_file` calls, a provider that rejects every request — against unpatched code: three attempts of 131,803 chars and no relief. With the change: two attempts, 131,803 then 100,223, and a run that stops with the explanation instead of only the provider's text.

Two rungs of the original ladder are **not** implemented, and both belong to §8.2: summarising the oldest legal span automatically, and the `blocked` outcome for a run that cannot be relieved. Until then an unrelievable overflow ends as an error — which is what the disabled emergency trim's own comment asks for.

**The reference implementation.** DeepSeek Harness checks pressure from a listener on `agent/pre-step`, so it runs before every request in the loop — a twenty-tool turn gets twenty chances to condense, though a tool already running is never interrupted. Its shipped policy (`@deepseek-ai/dsh-compaction-basic`): condense at `thresholdRatio` 0.8 of the routed model's context window and keep the newest `retainRatio` 0.16 verbatim, or an absolute `retainTokens`; per-model overrides validated at load. The free rung runs first — `dsh-compaction-tool-result-pruner` rewrites any tool result over 8,192 chars to a 4,096-char head, a marker and a 1,024-char tail, and summarisation is skipped entirely when that relieves the pressure. Then one extra condensation attempt, and a second listener on `agent/request-error` that reacts to a provider-confirmed overflow by condensing maximally and retrying once — the shape §8.1 implements. The summarisation call replays the system prompt, tool schemas and shadowed messages verbatim, so only its trailing instruction is cache-cold. A selected span must be balanced — never splitting a step's tool-call/result pair — and never shadows the system message. Condensed content stays in the session log: condensation is a surface replacement, not a deletion, and a replayed session reproduces the exact conversation.

The proactive trigger point, the summarisation rung, and the log-as-truth and per-model retention policies are what remain unimplemented; the last two wait for the message store in S10.

**A boundary must be a legal cut.** Compaction replaces `[0, boundaryIdx)` with a summary, so the boundary decides what the model loses. Two defects met in that one index:

- `_computeManualCompactionBoundary` returned `max(turnBoundary, messages.length − protectMessages)`. The turn rule already means what the slider says — the start of the N-th-from-last user message — but a `max` on the boundary is a `min` on retention, so the fixed `protectMessages: 10` capped the verbatim tail at ten array entries whatever the user chose. In an agent thread, where one step is `1 + N` entries, that cap always won: "keep last 3 turns" delivered about one and a half steps. The dialog never passed the value; it is a copy of the trim path's protection rule (`convertToLLMMessageService.ts:207`), where trimming bodies has no such consequence.
- Cutting by position meant the boundary could land inside an assistant message's tool batch. Half the results were summarised away together with the assistant that made the calls — its own text and reasoning included — and the survivors arrived verbatim, where the projection's synthetic acknowledgement (`convertToLLMMessageService.ts:1531`, "Understood. Continuing with the context above.") is now the nearest preceding assistant, so `prepareMessages_openai_tools` (`:358`) attached the rebuilt `tool_calls` to *it*. The request stayed well-formed, so this was never a malformed-request bug; it was a request claiming the model called tools it has no record of calling, over a summary that also described some of the same results. Measured against unpatched code: a 22-message thread whose last turn made twelve tool calls compacted to `kept 10/22`, with the kept tail opening on a tool result and ten calls declared by that acknowledgement.

The boundary is therefore a legal cut by construction: the start of the N-th-from-last turn, whole turns only. When those turns exceed `retentionTokens`, a fallback fills the verbatim tail newest-first at **group** granularity — an assistant message plus the results it requested, never split — so a turn with a hundred tool calls is still compactable and its newest steps survive. `planCompaction` (`common/compactionBoundary.ts`) returns the boundary together with what it keeps and drops; the compaction, the dialog's preview and the re-planning of a stored boundary all call it, so the preview cannot drift from the outcome and boundaries already stored by the old rule are re-planned into a legal cut when they are used.

#### 8.2 Budgets and `blocked` (not scheduled)

Two kinds of limit, checked at the same point — once per loop iteration in `_runChatAgent`, before the next request is prepared:

| Limit | Measured against | Outcome | Status |
|---|---|---|---|
| Context pressure | the size of the request about to be sent | **relieve**, then continue | reactive relief shipped (§8.1); the pre-flight check is not |
| Rounds, tokens, wall clock | spend so far in this run | **stop** as `blocked`, with the reason that tripped | not implemented |

```ts
// The planned shape. Not implemented: no field of this type exists in the tree.
export type ThreadBudget = {
  maxRounds: number
  maxTokens: number
  maxWallClockMs: number
  retentionTokens: number   // how much history stays verbatim
  spentRounds: number
  spentTokens: number
  startedAt: number
}
```

`IsRunningType` (`chatThreadService.ts:360`) already contains `waiting_tools` — "parked: batch drained, background concurrent tools still running (auto-resumes, nothing to approve)" — which is precisely the parent-waiting-on-children state. What is missing is `blocked` and its reason. Three sites currently read `undefined` as "over" and would have to tell "finished" from "stopped at a bound": the unread dot (`:3524`), the queued-message drain (`:3534`), and the completion notification (`_shouldNotify('done')`, `:3731`).

**What the reference implementation does not have.** Reading DSH's installed packages rather than its compaction behaviour alone changes the argument for deferring: it has no run budget at all. Its delegation tool takes `description`, `prompt`, optional `provider` / `model` / `reasoning_effort`, and `run_in_background` — nothing about spend. `dsh-agent-loop` is `while (true)`, and `maxSteps`, `maxRounds`, `maxTurns`, `stepLimit` and `roundLimit` do not appear anywhere in the installed tree. What bounds a run there is context, through compaction; what answers a looping model is `dsh-repeat-tool-reminder`, advisory reminders at 3, 5 and 8 consecutive identical calls that explicitly never veto; and the only wall clock is a per-**tool-call** deadline from `dsh-tool-call-timeout-policy`. Its retry policy — which the overflow work here follows — lists `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and `TRANSPORT` as retryable, and deliberately not a context overflow.

That is evidence for deferring, not permission to skip. The plausible homes for a budget are not equivalent — a global setting caps the user's own runs, a thread property needs the user to think about limits at thread creation, and a spawn argument needs the delegation call to exist — and the reference implementation's answer (none of the above; bound the context, steer the loop, show the spend) is a design position this document has not taken yet. Two shapes worth choosing between when it does: a *hard* cap that ends a run as `blocked`, or *visible spend with an explicit stop*, which is closer to what DSH does and closer to what a user with one runaway loop actually wants.

**The ordering constraint is retired.** It read: nothing may spawn a child before a budget exists, because N children are N loops. With budgets unscheduled, that constraint binds nothing — and reversing it deliberately is the point: the loop being unbounded is a cost exposure rather than a correctness bug, and the cost is accepted (§8). If spend ever becomes visible to users, the constraint comes back with it, and it comes back *before* fan-out, not after.

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

- **A child is a `ThreadType`, not a new execution engine.** Reusing `_runChatAgent` means approvals, cancellation, compaction, telemetry, and persistence are inherited rather than reimplemented. A second loop would drift from the first within two releases. Cost: `_runChatAgent` must be parameterized — it currently reads `chatMode` and `overridesOfModel` from global settings at `chatThreadService.ts:3079` — which is a contained refactor.

- **The result contract is bounded and structured; the transcript never crosses.** This is the difference between delegation that reduces context pressure and delegation that multiplies it. Given that `ThreadType`'s comments already document O(N²) input growth, an unbounded result contract would turn one bad property into a worse one.

- **Inheritance, not attenuation.** `combineAutoApproveModes`' union is correct for a child that holds its parent's mode: it lands on the same answer the parent lands on, so a child is never more permissive than its parent and no minimum helper is needed. The safety property is enforced at creation — copy `permissionMode` from the parent — and that copy is the whole of it.

- **Capability is not the safety boundary; provenance is.** A child can do what its parent can, and that is deliberate (§1). What *is* unsafe about writers is not their permission but the lack of provenance: `editCodeService` keys DiffZones by URI globally, so two children editing one file is a lost-update race, and diff areas carry no thread attribution — `acceptOrRejectAllDiffAreas({ uri })` accepts every pending change at that URI regardless of which child produced it. Separately, the `edits` auto-approve tier justifies itself on reversibility (`toolsServiceTypes.ts:26-29` — "edit_file always revertable via checkpoint") and checkpoints have been removed, so that premise is currently false. This is why **parallel writers** wait for Milestone 5, not why children are restricted: a single child writing, or several writing disjoint files, is no more dangerous than the parent doing it.

- **Spend is not bounded, deliberately.** Fan-out is N unbounded loops, and the earlier revision answered that with budgets before fan-out. LLM cost is low enough that the limiter costs more than the runaway it prevents, so budgets are unscheduled (§8) and the risk is accepted and recorded rather than mitigated.

- **Distinct verbs for fresh and forked delegation.** The fresh/fork distinction has opposite cost profiles and is the highest-leverage choice the model makes, so each deserves its own name and description rather than a boolean in a schema. `fork_subagent` arrives with M4, where context inheritance is the subject.

- **Declarative batch before a workflow engine.** A JS-sandboxed orchestration language captures a lot of power and a lot of surface area. A single-call declarative fan-out captures most of the practical value at a fraction of the complexity, and keeps orchestration inside the tool-call protocol the model already understands.

- **Children inherit workspace scope, never ambient scope.** `isThreadReadOnly` (`:357`) already gives a principled answer for cross-workspace threads; a child should not be able to resolve a different workspace than its parent.

- **Nesting is capped in validation, not in prose.** Instructions to "don't recurse" are advisory; `validateParams` is not.

## Files to change

All within `src/vs/workbench/contrib/void` unless noted.

| File | Change |
|---|---|
| `common/voidSettingsTypes.ts` | Add `SubagentStatus`, `SubagentOutcome` types, and the child linkage fields on `ThreadType` |
| `common/toolsServiceTypes.ts` | Add `run_subagent`, `send_message` and `list_children` params + results to the two type maps |
| `common/prompt/prompts.ts` | Add the delegation tool definitions to `chat_systemMessage`, including the concurrent-writer caveat (§5) |
| `browser/tools/runSubagent.tool.ts` | **New** — spawn a fresh-context child; enforce depth 1 |
| `browser/tools/childSteering.tool.ts` | **New** — `send_message`, `list_children` |
| `browser/tools/toolRegistry.ts` | Register new tools; gate to `chatMode === 'agent'` in `availableTools` |
| `browser/chatThreadService.ts` | Child-thread creation with inherited context; `_runChatAgent` parameterization; usage rollup; child cascade on interrupt; retention |
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
| **S5** | Image ownership — thread-owned image directories, copy-on-duplicate, move off the roaming profile (bugs 6, 7, 8). Governs images written from here on; the files already in `voidImages/` are left alone and migrate in S10 | Duplicate a thread with images, delete one, the other's images still render |
| **S6** | Thread identity — tools act on the executing thread rather than the viewed one | A tool invoked on a non-visible thread reads that thread's conversation |
| **S7** | Diff provenance — diff areas carry their originating thread; accept, reject and interrupt are scoped to it | Two threads with pending edits to one file: accepting in one leaves the other pending |
| **S8** | Context pressure relief — a request the provider rejects for exceeding the context window is classified as an overflow rather than retried unchanged, rebuilt with old tool-result bodies trimmed (request image only), and retried once; when nothing is trimable the run stops after one attempt and says what to do. **Split by review:** budgets, `blocked` and the proactive per-iteration check moved to M2, where a spawn call decides their shape — see §8 | A thread whose request does not fit is relieved and continues; an unrelievable overflow stops once with an explanation, instead of three identical attempts |
| **S9** | Loop parameterization — *ships inside S8*, listed separately only to keep this sequence aligned with the numbering used during review. **Deferred with the budget half**: children need a parameterized loop, nothing before them does | Behaviour byte-identical |
| **S10** | Message store, migration, and bounded residency — message bodies leave the mirrored database; memory scales with active threads; load cost scales with thread size; per-thread lazy migration with a read fallback; **the image migration S5 defers** — the flat `voidImages/` directory attributed to its threads and reclaimed (bugs 1, 2, 3, 10, and the legacy half of 6, 7, 8) | Renderer memory no longer scales with total message count; a 5,000-message thread opens within budget; threads created before the change still open; after a pass over a profile holding flat images, `voidImages/` holds none and every image still renders |
| **M1** | **Folded into M2.** Was agent definitions and attenuation; both are dropped (§1, §5), and what remained had no consumer before a child exists. Budgets were deferred out of S8 and are now deprioritised entirely (§8) | — |
| **M2** | Delegation — child threads with parent linkage, `alias` and full inheritance of the parent's context; `run_subagent`; `send_message` and `list_children`, so delegation is iterative and recoverable; depth-1 in `validateParams`; bounded result contract; cost rollup; child rendering with a transcript link. **No roles, no attenuated permissions, and nothing prunes a child** — a child's capability is its parent's and its data is as durable as a user thread's (§1, §2) | Design, develop, test and review a feature through children, and the parent's peak context stays below what doing the same work inline needs |
| **M3** | Parallelism and control — batched fan-out in one call; `interrupt_child`; parent→child tree UI; interrupt cascade; approval routing for non-visible children; failure isolation; aggregate status; **the shared residency budget, eviction priority and cascade** ([`thread-storage.md`](./thread-storage.md) §2.2). Caps and the residency budget are measured here rather than pre-built (§6) | A fan-out of a dozen children creates, runs, seals and prunes without unbounded renderer growth; one child failing leaves siblings and the parent usable |
| **M4** | Context inheritance and routing — `fork_subagent`; an optional model argument on the spawn call, so a parent can route a child to a cheaper model; declarative pipeline and parallel stages | A fork inherits the parent's compaction state consistently, not raw pre-boundary messages |
| **M5** | Scoped implementation — writer children with explicit file partitioning; worktree-per-child isolation; optional JS orchestration sandbox | Deleting a parent removes children and their images; parallel writers do not lose updates |

**Scope correction in S3.** S3 removes the checkpoint *writing* residue. It deliberately keeps the read and cleanup path — the two `role === 'checkpoint'` skips in the load loops, the `checkpointsBeforeBoundary` remap, and the `CHECKPOINT_KEY_PREFIX` cleanup loops — because S3's own gate requires that a thread containing legacy checkpoint records still loads, and because the remap *is* the bug-3 fix. Removing them here would load checkpoint records into the conversation, leave the compaction boundary off by the number of records in front of it, and partially undo S2. Those four sites move to S10, where the message store renumbers indices and the tolerance stops being reachable. See [`thread-storage.md`](./thread-storage.md#checkpoints-removed-not-stored).

**A pre-S8 fix ships on its own branch.** The manual compaction boundary was capped at ten messages and cut by position, so it could slice an assistant message's tool batch in half: part of the batch was summarised together with the assistant's own text and reasoning, and the surviving results reached the next request attached to the projection's synthetic acknowledgement rather than to the assistant that made the calls. It is **not** an S8 deliverable — no budgets, no `blocked`, and it is not the automatic trigger §8.1 later added — and it is not covered by S8's gate. It rode on `fix/compaction-turns-not-messages` (#138) because the summarisation rung §8.2 still owes is built on the same primitive: a boundary that is a legal cut, planned by `planCompaction`. A reader wondering why a compaction fix appears in the multiagent sequence should find this paragraph rather than infer it from §8. See [`thread-storage.md`](./thread-storage.md) §1.6 for the log-growth defect found alongside it.

**An independent defect shipped on S5's branch.** Bug 18 — the selector's Duplicate persisted no message keys, so its copies came back empty after a restart — is **not** part of image ownership and is not covered by S5's gate. It rides on S5 only because S5 hands that method the copy-on-duplicate treatment and copies image bytes for it, and bytes written for a conversation that will not survive a restart are only leaked. It is recorded as its own ledger row in [`thread-storage.md`](./thread-storage.md) §1.6, with its own acceptance scenario, and should be read and reviewed as a separate change: it alters what Duplicate persists, which no image path depends on. A reader looking for why S5's branch touches `duplicateThread` should find this paragraph rather than infer it from the row above.

## Non-goals

- **A second execution engine.** One loop, parameterized.
- **A JS orchestration sandbox.** Deferred; the declarative batch must prove insufficient first.
- **Purpose-built fresh-agent iteration loops.** The workspace is already durable memory; the gap is budget bounds, not a new loop type.
- **Full child transcripts returned to the parent.** Never, by construction.
- **Auto-approval inside background children.** Never.
- **Recursive delegation beyond depth 1.** Not without evidence that it pays for itself.
- **N agents in one git worktree by default.** Not without explicit partitioning.

## Risks

- **Cost amplification.** Delegation turns one O(N²) loop into several. **Accepted rather than mitigated**: budgets are unscheduled (§8), so the remaining bounds are the bounded result contract and cost rollup — the latter only makes spend *visible*, it does not cap it. The honest position is that aggressive fan-out costs more, and the UI must show that rather than surprise anyone.

- **Concurrent writes to the same file.** DiffZones are keyed by URI; two writers on one file lose updates, and diff areas carry no thread provenance, so approving one child's edits approves any other child's at the same URI. Children are not restricted below their parent (§1), so this is managed by the model partitioning its own work until Milestone 5 builds the isolation. The tool description says so explicitly.

- **Weak-model orchestration.** Weaker models already show unreliable behavior with parallel reads and skills; delegation asks more of them. Consistent with existing Void philosophy (`skills.md`, "Model compliance"), the expectation is that strong models use it well and weak ones mostly won't. The failure mode is benign — a model that never delegates behaves exactly as today.

- **Approval deadlock.** An unattended child that needs approval must fail closed rather than hang. Requires the parent to park in a state the UI surfaces and the notification path to fire; if neither happens, the child hangs invisibly.

- **Prefix-cache disruption on fork.** A forked child that appends anything to an inherited `frozenAiInstructions` changes the prefix, so its first request is cache-cold. Acceptable once per child; unacceptable per request, so any such append must happen once at child creation. Basic delegation is unaffected — a `run_subagent` child starts empty and inherits nothing.

- **Persistence and migration.** New `ThreadType` fields are optional and must hydrate cleanly from existing persisted threads, following the established backward-compat convention (`emergencyTrimmedCount?`, `finishReason?`, and similar). Child threads created by an older build are top-level threads, which is a correct and harmless degradation.

- **Supervision collapse.** A fan-out of twelve children must not produce twelve tabs. Children belong in a tree, not the pin strip; `pinnedThreadIds` is a user-facing tab concept and children must not be auto-pinned. This is the risk that decides whether the feature feels like leverage or like noise.
