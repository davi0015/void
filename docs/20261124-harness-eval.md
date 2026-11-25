# Harness evaluation, 2026-11-24

A second session ran a live probe of the orchestrator against the litellm fork: an
orchestrator spawning children, children reporting verbatim timestamps, terminals
driven from the agent side. This file records what it found, which claims were checked
against this repository, and what is still open. The evaluation's own document and its
P0-P2 requirement list live with that session; only claims that touch code here are
restated.

**Status when this lands.** Findings 1 and 2 are fixed in the same change as this
note: `read_terminal` takes the `terminal_id` that `open_persistent_terminal` returns
and refuses an ambiguous name, and `run_persistent_command` takes `interrupt_first` to
send Ctrl-C before a command. Finding 3 is still open (its exit-status shape was never
reproduced), finding 4 does not reproduce here, finding 5 changes with the asynchronous
work, and finding 6 is still unmeasured. The rows below record the evaluation as it
stood on 2026-11-24.

## Findings, and their status here

| # | finding | status | where |
|-|-|-|-|
| 1 | `read_terminal` cannot read the terminal that `open_persistent_terminal` returned: it takes a display **name**, so the returned id is rejected, and a colliding name silently reads another terminal | **confirmed, fixed here** | `readTerminal.tool.ts:9` (param is `terminal_name`), `openPersistentTerminal.tool.ts:22` (returns `persistentTerminalId`), lookup by name at `terminalToolService.ts:490` |
| 2 | a paste mangled into a continuation prompt wedges a persistent terminal, and the only remedy is killing it | **confirmed, fixed here** - `interrupt_first` on `run_persistent_command` now sends Ctrl-C; nothing in the tree sent `\x03`; `kill_persistent_terminal` is the sole escape | |
| 3 | `run_persistent_command` reported `(exit code 0)` for a command still running | **plausible, not reproduced** - the result contract has no "still running" answer beyond `timeout`, `done` always prints a code, and a terminal exit with no recorded code becomes `0` | `runPersistentCommand.tool.ts:44`, `terminalToolService.ts:850` |
| 4 | children are told about `run_subagent` / `send_message` / `list_children` that they cannot call | **not reproducible on 1.6.0** - see below | |
| 5 | `run_subagent` calls in one turn run sequentially | **by design**, and stated in the tool description | `runSubagent.tool.ts:36` |
| 6 | user interrupt during a synchronous spawn; a background job spanning a turn boundary | **unmeasured** | |

## Finding 4: a child counted 25 tools, and quoted the orchestrator's prose

The probe asked a child to enumerate its callable functions and got 25. That is
exactly the `agent` set - 28 builtin tools minus the three on the top rung
(`delegationToolNames`, `toolsServiceTypes.ts:110-127`) - so the step-down ran and the
schema was correct.

The prose is generated from the same value. One `chatMode` is computed per run
(`chatThreadService.ts:4038-4041`) and used for both the tool block and the system
message (`convertToLLMMessageService.ts:1285-1286`); the delegation persona and rules
are gated on `mode === 'orchestrator'` (`prompts.ts:300`, `:419-427`). The child's
`parentThreadId` is written to state before its run starts
(`chatThreadService.ts:3697-3706`), so there is no window in which it reads as
top-level.

So a child on this build cannot receive the orchestrator sentence from the harness. The
quoted sentence arrived as text the child inherits and cannot distinguish from harness
prose: the workspace rules file - which the probe verified children inherit - or the
parent's `task` brief. That is a different defect: inherited content asserting
capabilities the child does not have, with no marker saying which prose is the harness.

It still deserves a guard, because prose and schema are coupled only by both consulting
one `chatMode`, and a mode is a proxy for capability that per-child models and tool
subsets are designed to weaken. The guard is a node test: for each mode, the prompt
mentions delegation iff the delegation tools are available in that mode. It passes
today; it fails the day the coupling breaks.

## User-facing observations, same day

Four from the user, all in the delegation row rather than in the harness:

1. A running delegation shows only "Subagent working" and the alias. The row renders a
   bare header for `running_now` (`ToolResultComponents.tsx:2028`), while the child's
   own thread - what it is doing right now - is already in `allThreads`.
2. The report arrives expanded (`defaultOpen`, `ToolResultComponents.tsx:2045` and
   `:2070`).
3. A child that pauses for approval and resumes fires "Void finished" for itself. The
   normal path is suppressed through `onRun` (`chatThreadService.ts:5122`,
   `:3805`); the three resume paths wrap unconditionally (`:3041`, `:3134`, `:3294`).
   The guard is per call site rather than per concept.
4. The only way into a child is the notification. An "Open transcript" link exists
   (`ToolResultComponents.tsx:1104`) but only inside the expanded body after the run
   ends, and the comment at `:2042` still claims there is no link. Children are hidden
   from the tab strip by design (`SidebarThreadSelector.tsx:71`), so the parent row has
   to be the door.

## Open

- Provenance of finding 4: one child, no workspace rules file, a task that never says
  "subagent", then read the system message the request actually carried
  (`capturedLLMRequests` in `test/void/subagent-delegation.test.mjs`). Present - the
  harness is at fault; absent - inherited content.
- Finding 3 needs the probe's exact command and `timeout_seconds` before it becomes a
  fix rather than a hypothesis.
- Finding 6 remains unmeasured; both scenarios need the same probe protocol.
