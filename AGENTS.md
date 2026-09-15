# Working in Void

Void is a VS Code fork. Read `docs/designs/` before changing storage, the chat loop, or multiagent
behaviour — those documents are the specification. `docs/designs/thread-storage.md` §1.6 is the
canonical bug ledger; cite `bug N` from that table, and note that its `Problem` section is a
narrative subset, not a second numbering. `docs/designs/multiagent-assistant.md` holds the delivery
sequence (S1–S10, then M1–M5); work proceeds in that order, one step at a time.

## Layout

| path | what |
|---|---|
| `src/vs/workbench/contrib/void/browser/` | renderer-side AI code: chat service, tools, convert-to-LLM, React UI under `react/src2/` |
| `src/vs/workbench/contrib/void/common/` | code shared by renderer and main |
| `src/vs/workbench/contrib/void/electron-main/` | main-process services and their `void-channel-*` channels |
| `src/vs/workbench/contrib/void/browser/react/out/` | prebuilt React bundles, checked in and **not** produced by `gulp compile` — run `npm run buildreact` after editing `react/src2/` |
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
  logic out of the service that hosts it.
- Node unit tests **exclude** `browser/`, `electron-sandbox/`, `electron-main/` and
  `electron-utility/` paths. A test placed beside browser code will silently not run.
- One file per **behaviour area** with several scenarios inside. Never one file per function, and
  never a per-test npm script — `npm run test-void -- --only=<substring>` selects an area.
- `test/void/README.md` documents the harness API.

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
7. **Prove the assertions are not vacuous.** `VOID_EXPECT=lost npm run test-void` must fail against
   unpatched code and pass against fixed code. If it cannot be made to fail, it proves nothing.
8. **Commit with the evidence.** Imperative subject. The body carries the mechanism, what the red
   phase observed, and how the fix was verified.

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
- `assertPersistence(label, ok, { subject })` — `subject: true` follows `VOID_EXPECT`; a control
  (no `subject`) must always pass, and says so when it does not.
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
- **Preparatory work has a test.** A change qualifies only if a user hits the problem today with a
  single agent *and* it removes a multiagent blocker. `AgentDefinition` is the instructive case: the
  type and the loop parameterization are safe, the file format is deferred.
- Automated tests assert persistence and state, never visual quality. State plainly when the UI has
  not been checked by hand rather than implying it has.
