# Handover

A snapshot of where the work stands, written to be read cold — on another machine, in a new
session, by a person or an agent. It is deliberately **not** a second specification: the designs are
the specification, and this file repeats none of their reasoning. Update it at each step, or delete
it once it stops being true.

**Snapshot: 2026-10-06, `main` at `6e2a011d`, release `v1.2.0`.**

## Where the work stands

The programme is the sequence in [`designs/multiagent-assistant.md`](./designs/multiagent-assistant.md):
S1–S10, then M1–M5, one step at a time, each accepted before the next begins.

| | State |
|---|---|
| **S1–S6** | Shipped. Shutdown durability; compaction anchoring and context accounting; checkpoint residue; value-size caps; image ownership; thread identity |
| **S7** | **Deferred by choice** — diff provenance. Needs a UI decision first: the chat footer's changed-file banner is app-wide (`voidCommandBarService.sortedURIs`), not per-thread, so scoping accept/reject to a thread means deciding what a thread-owned banner looks like and whose edits it shows |
| **S8** | Split in review. The pressure half **shipped** (#139): a provider-confirmed context overflow is classified, the request is rebuilt with old tool-result bodies trimmed, retried once, and otherwise reported with a line saying what to do. Budgets, `blocked` and the loop parameterization **moved to M2** — §8.2 gives the reason (their shape is decided by delegation) and the ordering constraint that comes with it: nothing spawns a child before a budget exists |
| **S9** | Deferred with the budget half. Children need a parameterized loop; nothing before them does |
| **S10** | **Next.** Part 1 only, in four steps — see "S10 in four steps" in [`designs/thread-storage.md`](./designs/thread-storage.md). Its scope was settled in review: Part 2's policy layer (thread kinds, sealing, child retention, shared residency budget, eviction priority, cascade) lands with its consumers in M2 and M3 |
| **M1–M5** | Not started |

**Bug ledger**: [`thread-storage.md`](./designs/thread-storage.md) §1.6, twenty rows. The rows still
open are the ones S10 owns — 1, 2, 3, 10, 19, the legacy half of 6–8 (flat-image attribution), and
bug 9's budget half. Everything else is fixed.

## The next action

**S10a — residency, and the audit that comes with it.** In this order:

1. **Build the measurement and show it red.** The gate — "renderer memory no longer scales with total
   message count" — is not assertable as written, so the measurement is part of the work; the plan is
   under "S10 in four steps". Count the message objects the renderer still retains after opening N
   threads, with heap as corroboration rather than as the signal. Today's behaviour *is* the red:
   `_loadedMessageThreadIds` (`chatThreadService.ts:1173`) is a `Set` that nothing evicts from, so N
   opened threads keep N threads' messages resident for the life of the window.
2. **Then the LRU and the audit.** Never evict a thread in `running`, `awaiting_user` or
   `waiting_tools` — the agent loop reads `state.allThreads[threadId].messages` every iteration. One
   reader is already known to break: `_getAllSeenFileURIs` (`:4298`) returns `[]` for a thread that
   is not resident, silently degrading `@`-file completion.

The procedure for any change here is the one in `AGENTS.md`: verify the mechanism in the code first,
reproduce before fixing, guard the fixture, re-run the single test and then the whole suite, prove the
assertions are not vacuous with `VOID_EXPECT=lost`, and commit with the evidence in the body.

## Open items

- **No UI string has been read by a human** since #138. The compaction dialog's preview line and
  "Compaction cancelled", the overflow error copy, the retry line and the dialog's turn count are all
  asserted at state or DOM-text level only. It is a two-minute check in the running app, and it is the
  one category where no measurement substitutes for looking.
- **The end-to-end suite can hang on contention**, not on a defect — the trap is written up in
  `AGENTS.md`. `--test-concurrency=4` in `test/void/run.mjs` is the lever, not applied because it
  costs wall clock.
- **Two remote branches have no PR here**, `feature/improve-default-value` and
  `fix/window-build-msal`, and do not exist upstream either. Left deliberately; decide whether to
  keep or delete them.
- **Merged branches are deleted**, locally and on the remote — over a hundred of them went in one
  sweep. Prose should cite the pull request, not the branch name, because the name no longer
  resolves.
- **CI runs neither test tier.** `pr-check.yml` compiles and checks hygiene; `test-void` and
  `test-node` never run there, so a green check says nothing about either.

## Picking it up on another machine

`AGENTS.md` carries the conventions, the test tiers, the harness API and the traps that have already
cost time. Practically:

- `local-setup.sh` and `.python-version` are **deliberately untracked**, so a fresh clone does not
  have them — bring them across.
- `npm install`, then `npm run compile` (or leave `npm run watch-client` running), and
  `npm run buildreact` before any test that touches the UI: the React bundles are gitignored and are
  not produced by `gulp compile`.
- **Confirm the compiled artifact before trusting a run** — `grep -c <marker> out/...js`. A count read
  while the watcher is writing can be a false zero, and the watcher can stop without saying so.
- `npm run test-node` takes seconds. `npm run test-void` takes minutes, and
  `--only=<substring>` selects one area.

## What to read for what

| Question | Document |
|---|---|
| How to work here — conventions, procedure, harness, traps | `AGENTS.md` |
| What is being built, in what order, and why | [`designs/multiagent-assistant.md`](./designs/multiagent-assistant.md) |
| The store, the migration, the bug ledger, S10's four steps | [`designs/thread-storage.md`](./designs/thread-storage.md) |
| Building, packaging, and how this fork releases | [`note.md`](./note.md) |
| The end-to-end harness API | [`../test/void/README.md`](../test/void/README.md) |
