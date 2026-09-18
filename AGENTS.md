# Working in Void

Void is a VS Code fork. Read `docs/designs/` before changing storage, the chat loop, or multiagent
behaviour — those documents are the specification. `docs/designs/thread-storage.md` §1.6 is the
canonical bug ledger; cite `bug N` from that table, and note that its `Problem` section is a
narrative subset, not a second numbering. `docs/designs/multiagent-assistant.md` holds the delivery
sequence (S1–S10, then M1–M5); work proceeds in that order, one step at a time.

## Layout

| path | what |
|---|---|
| `src/vs/workbench/contrib/void/browser/` | renderer-side AI code: chat service, tools, convert-to-LLM, React UI under `react/src/` |
| `src/vs/workbench/contrib/void/common/` | code shared by renderer and main |
| `src/vs/workbench/contrib/void/electron-main/` | main-process services and their `void-channel-*` channels |
| `src/vs/workbench/contrib/void/browser/react/src/` | React UI source. Edit **this**, not `src2/` |
| `src/vs/workbench/contrib/void/browser/react/src2/` | generated from `react/src/` by `scope-tailwind` — and it reformats. Gitignored; edit it and the next build overwrites you |
| `src/vs/workbench/contrib/void/browser/react/out/` | built React bundles. Also gitignored, and **not** produced by `gulp compile`. CI runs `npm run buildreact`, which regenerates `src2/` then bundles `out/` — run it yourself after editing `react/src/`, and before any end-to-end test that depends on UI code |
| `test/void/` | end-to-end tests (this fork's own tier) |
| `docs/designs/` | design documents |

## Where a test belongs

Decide by what the test needs, not by what it is about.

| needs | put it in | run with |
|---|---|---|
| only pure logic — no services, no disk, no window | `src/vs/workbench/contrib/void/common/test/*.test.ts` | `npm run test-node` |
| a running workbench: services, storage, lifecycle, shutdown or reload, anything spanning a restart | `test/void/*.test.mjs` | `npm run test-void` |

- The node tier takes seconds, the end-to-end tier minutes. Prefer node, and extract pure logic into
  a dependency-free module when that is what it takes — that is why the storage work keeps its log
  logic out of the service that hosts it, and why the changed-file stepper's arithmetic lives in
  `common/commandBarStepper.ts` rather than in the React component that renders it.
- Node unit tests **exclude** `browser/`, `electron-sandbox/`, `electron-main/` and
  `electron-utility/` paths. A test placed beside browser code will silently not run.
- One file per **behaviour area** with several scenarios inside. Never one file per function, and
  never a per-test npm script — `npm run test-void -- --only=<substring>` selects an area.
- `test/void/README.md` documents the harness API.
- **A node test still proves the logic runs.** `common/test/*.test.ts` is discovered by
  `npm run test-node` (it globs `out/**/test/**/*.test.js`), so a new file there is live, not
  decorative — confirm your suite appears in the run before trusting it.

## Procedure for a fix

1. **Verify the mechanism in the code before trusting any description of it** — doc, comment, or
   report. Check the line, the call site, the ordering. Comments in this repo are frequently stale;
   correct them in the same change when you find one.
2. **Reproduce first.** Write the failing test before the fix and run it against unpatched code.
3. **Confirm it fails for the stated reason**, not for a setup error. Read the failure text: a test
   that fails because its fixture never built the situation proves nothing about the product.
4. **Guard the fixture.** Assert the preconditions the scenario depends on, and include a control
   scenario that must pass in every configuration. A scenario that silently fails to set up reports
   a confident, wrong answer.
5. **Fix.**
6. **Re-run the single test, then the whole suite** (`npm run test-void`) to catch regressions.
7. **Prove the assertions are not vacuous.** `VOID_EXPECT=lost` inverts the subject assertions, so
   it must **pass against unpatched code and fail against fixed code**. That inversion is the proof
   an assertion tracks the behaviour; `VOID_EXPECT=present` (the default) is the normal direction.
   Controls never follow `VOID_EXPECT` and must pass in both. If a subject cannot be made to fail
   under `lost`, it proves nothing.
8. **Commit with the evidence.** Imperative subject. The body carries the mechanism, what the red
   phase observed, and how the fix was verified.

## Explaining a change

The reader has the repository open and can read the code. What they cannot read is your reasoning,
and they are usually asking because something did not match what they expected. Assume competence,
not context.

- **Order it: background, then the bug, then the example.** One line each on which part of the system
  this touches and what is wrong with it, *before* any walkthrough. An explanation that opens on the
  mechanism makes the reader reconstruct the subject from its symptoms. S5 was explained that way:
  five steps of duplicate-and-delete before the reader was told that images live in a single flat
  shared folder and that cleanup scans one thread's messages. The walkthrough was accurate and still
  unreadable.
- **Let the worked example carry the mechanism, and name the abstraction after it.** One real input
  walked through the code — a chat message, a filename, a row — lands where a summary does not.
  Measurements are evidence for a point, not the point; put them after it.
- **Give a number with its precondition.** "2.17 MB reclaimed" is wrong without "…if every thread is
  written"; "0 bytes" is wrong without "…on reload, which writes nothing". Three answers in one
  session quoted a measurement without its precondition and all three had to be corrected. If the
  number needs a sentence to be true, the sentence is part of the number.
- **Check what the repository already does before proposing to build it.** A design described here as
  future work — a pressure-gated tool-result trim — already existed as `_compactToolResultsForRequest`,
  switched off, with the reason written beside it. Proposing to write it wasted the reader's time and
  made the earlier explanation wrong.
- **Answer the question that was asked.** If it has two readings, answer both in a line each rather
  than picking one and elaborating. If part of it is unverified — the UI, a hypothesis — say which
  part, once.
- **When correcting yourself, state the correction and stop.** Do not restate the wrong version at
  length, and do not re-describe a substantive error as a matter of wording.

## Build-state discipline

`npm run watch-client` runs in this checkout and rebuilds `src/**/*.ts` within seconds of an edit.
Plain scripts (`test/void/*.mjs`), docs and `.tmp/` are not compiled at all.

- **Never assume a run measured the code you just edited.** Confirm the compiled artifact, e.g.
  `grep -c _storeThreadDurably out/vs/workbench/contrib/void/browser/chatThreadService.js`.
- To measure pre-fix behaviour: revert the source (`git checkout main -- <file>`), wait for the
  rebuild, and confirm the marker count in `out/` is `0` **before** running. Restore afterwards with
  `git checkout HEAD -- <file>`.
- **Do not switch branches while a test is running.** The watcher rebuilds and the run straddles two
  builds; this has already produced one invalid measurement.
- **Switching branches leaves the other branch's compiled tests in `out/`.** The watcher compiles, it
  does not delete, and the node tier globs `out/**/test/**/*.test.js` — so a suite from the branch
  you just left keeps running and keeps passing. That inflates the count and reports on code the
  branch does not contain: a chore branch off `main` measured 4510 when its own source had 4497,
  the extra 13 being the previous branch's suite. Check `grep -c <SuiteName> <run output>` against
  what the branch's `src/` actually holds, or delete the stale files from `out/` before measuring.
- A full recompile leaves `out/` incomplete for about 75 seconds. `npm run test-void` refuses to run
  with a clear message, which is not a test failure.
- `out/` is gitignored. Build (`npm run compile`) before any end-to-end test.

## End-to-end harness (`test/void/harness.mjs`)

Reuse it. Do not rebuild launch plumbing per test.

- `withScenario(name, fn)` — fresh profile and app, always torn down. Use `createProfile` +
  `launchVoid` when a scenario needs **two sessions on one profile** to test across a restart.
- `s.close()` (graceful, runs shutdown handlers) versus `s.kill()` (hard, runs none). That
  distinction is usually the point of the test.
- `s.readKey` / `s.readThread` / `s.listKeys` — assert on what reached `state.vscdb`, not on
  in-memory state.
- `instrumentThreadStorage(page)` — logs every thread write with a `landed` flag. `landed=false` is
  direct proof that a write was accepted and then silently discarded.
- `cancelFlushScheduler(page)` — removes the race against the 500 ms write-coalescing timer, making
  "did shutdown persist this?" a deterministic question.
- `stubLLM(page, text)` + `capturedLLMRequests(page)` — drive the real agent and compaction paths
  with no network, key or model, and assert what the model was actually sent.
- `assertPersistence(label, ok, { subject })` / `assertAbsent(label, ok, { subject })` — the pair for
  changes that add a write and changes that remove one. `subject: true` follows `VOID_EXPECT`; a
  control (no `subject`) must always pass, and says so when it does not.
- Electron needs `--no-sandbox` in this environment; the harness supplies it plus the repo's
  platform flags. Tests run under `node:test` through `run.mjs` — never invoke bare `node --test`,
  which would execute non-test files under `test/`.

## Conventions

- Branches: `<type>/<kebab-description>`, with types `feature/`, `fix/`, `chore/`. There is no
  `docs/` prefix; documentation changes go on `chore/`. Squash-merge is used, so branch SHAs do not
  survive into `main`.
- Commits: imperative subject, evidence in the body. Husky runs `precommit` (hygiene) on commit.
- Rewriting published history requires `git push --force-with-lease=<ref>:<expected-sha>` naming the
  exact SHA previously pushed.
- Design documents go on their own branch, separate from the fix they describe. Merge the fix first,
  or the document references files that do not exist on `main` yet.
- `local-setup.sh` and `.python-version` are deliberately untracked (see `.git/info/exclude`). Do
  not commit them; the setup script runs `rm -rf node_modules package-lock.json` unconditionally.

## Traps that have already cost time

- **`0` is falsy.** Anchor and boundary indices (`compactionBoundaryIdx` and its relatives) must be
  tested with `!== undefined`. One such bug had three sites, and the third — in a *different file* —
  was the one actually suppressing the behaviour, so fixing the documented two changed nothing.
- **Lifecycle registration order decides whether a shutdown write survives.** The workbench closes
  storage from its own `onWillShutdown` listener, registered during startup before any contrib
  service exists, and `Storage.set()` returns early once closed. A contrib flush on `onWillShutdown`
  therefore always runs too late and is dropped without error. Flush on `onBeforeShutdown`, which is
  a strictly earlier phase.
- **"Durable" is not "on disk".** `storageService.store()` updates the renderer cache synchronously,
  then the renderer and the main process each debounce for about 100 ms before SQLite. A hard kill
  inside that window still loses the write.
- **Thread writes are coalesced for 500 ms** into `_pendingThreadWrites`, `_pendingUsageWrites` and
  `_pendingMessageKeyWrites`. `_flushPendingThreadWrites` drains all three, and `_pendingUsageWrites`
  takes precedence over the thread's own usage at flush time.
- **Do not spread a freshly read thread over the in-memory one.** The persisted copy can be older
  than memory while a write is still inside the coalescing window. Propagate the one field that was
  corrected instead.
- **`react/src2/` and `react/out/` are both gitignored build output.** `src2/` is generated from
  `react/src/` by `scope-tailwind`, so editing `src2/` is work the next build throws away, and a
  change made only there never reaches the commit. Edit `react/src/`, run `npm run buildreact`, and
  check `git status` — if the React change is real, the only tracked file that moves is under
  `react/src/`. A comment-only React edit should leave `out/` byte-identical; that is a cheap way to
  prove the edit was inert.
- **Preparatory work has a test.** A change qualifies only if a user hits the problem today with a
  single agent *and* it removes a multiagent blocker. `AgentDefinition` is the instructive case: the
  type and the loop parameterization are safe, the file format is deferred.
- Automated tests assert persistence and state, never visual quality. State plainly when the UI has
  not been checked by hand rather than implying it has.
