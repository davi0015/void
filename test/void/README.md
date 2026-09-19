# Void end-to-end tests

Tests that drive the real application (Electron under Playwright) and assert
against what actually reached disk.

```
npm run test-void                          # every test/void/*.test.mjs
npm run test-void -- --only=durable        # files matching a substring
node test/void/run.mjs --only=durable      # same, without npm in the way
VOID_EXPECT=lost npm run test-void         # invert subject assertions (see below)
VOID_SHOW_TEST_WINDOWS=1 npm run test-void # show the windows (see below)
```

There is deliberately no per-test npm script. One entry point plus `--only`
covers both "run everything" and "run this area", and per-file aliases would
multiply with every new test file.

**What you see while it runs.** This is not a progress view and the windows are
not worth watching: each scenario is a fresh app that shows a landing page for the
second before the test moves on, and the tests assert on what reached storage
rather than on anything painted. The terminal output is what tells you what is
running.

- **By default nothing appears.** On macOS the app is launched from an accessory
  bundle (no Dock tile, never activated) and its window is made transparent,
  unfocusable and click-through at creation. This is the mode for running the
  suite while you work.
- **`VOID_SHOW_TEST_WINDOWS=1` disables all of that** and leaves the window alone,
  so it is a normal window you can drag and click in. It takes focus, because that
  is what an interactive window does. For when a test fails and you want to look at
  the app.

Either way there are about thirty launches — one per scenario, seven files at once
— so the windows come and go quickly.

Requires a compiled build (`npm run compile`). The runner checks this up front and
says so.

## Where a test belongs

Pick the tier by what the test needs, not by what it is about:

| The test needs… | Put it in | Run with |
|---|---|---|
| Only pure logic — no services, no disk, no window | `src/vs/workbench/contrib/void/common/test/*.test.ts` | `npm run test-node` |
| A running workbench: services, storage, lifecycle, shutdown/reload, anything that spans a restart | `test/void/*.test.mjs` | `npm run test-void` |

Prefer the node tier. It is seconds instead of minutes, and it is the reason the
storage work extracts its logic into a dependency-free module — logic that lives
inside a service can only be exercised by booting an app.

One file per **behaviour area**, with several scenarios inside it — not one file
per function. A file here costs a real app launch per scenario (~1 min), so group
scenarios that share a subject and split only when the setup genuinely differs.

## Using the harness

`harness.mjs` holds everything that would otherwise be copy-pasted between
files. Nothing in it is a test.

```js
import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

before(() => h.preflight())

describe('some behaviour', () => {
  test('does the thing', async (t) => {
    await h.withScenario('group/scenario', async (s) => {
      await h.instrumentThreadStorage(s.page)         // makes storage writes observable
      const { threadId } = await s.page.evaluate(() => { /* drive the app */ })
      await s.close()                                  // graceful quit
      assert.match(s.readThread(threadId), /expected/) // assert on what persisted
    })
  })
})
```

What it provides:

- `createProfile` / `launchVoid` / `withScenario` — throwaway profiles. Pass the
  same dirs to `launchVoid` again to test across a restart; `withScenario` gives
  you a fresh app and always tears it down.
- `s.close()` and `s.kill()` — graceful quit (runs shutdown handlers) versus a hard
  kill (runs none). The distinction is usually the point of the test.
- `s.readKey` / `s.readThread` / `s.listKeys` — read the application store
  directly, so assertions are about persistence rather than in-memory state.
- `instrumentThreadStorage` — logs every thread write with a `landed` flag.
  `Storage.set()` returns early when the store is closed, so `landed=false` is
  direct evidence that a write was silently discarded.
- `cancelFlushScheduler` — removes the race against the 500ms write-coalescing
  timer. Cancel it, assert the write is still queued, then quit: now the test
  asks specifically whether *shutdown* persists it.
- `stubLLM` / `seedTestThread` / `ensureModelSelection` — run the real agent and
  compaction code paths with no network, no API key and no model configuration.
  Only the transport is faked.

Two habits worth keeping:

**Guard the setup.** Assert the preconditions your scenario depends on — that the
write really was still queued, that the compaction really produced a summary. A
scenario that silently fails to set up its own situation reports a confident,
wrong answer.

**Assert on the control.** `assertPersistence(label, ok, { subject: true })` marks
a write as the subject under test; leave `subject` off for a control that must
always succeed. A failing control means the harness is unsound, and says so,
rather than blaming the behaviour under test.

`assertAbsent(label, ok, { subject: true })` is the mirror, for a change whose
subject is a *removal* — junk kept out of storage rather than a value written to
it. Pass the absence itself (`!('mountedInfo' in parsed)`) as `ok`.

## Demonstrating a bug

Two directions, and they are easy to confuse:

- **The red phase** is the default mode against unmodified code: the subject
  assertion must **fail**, for the stated reason. That is what shows the bug is
  real and the test can see it.
- **The sensitivity check** is `VOID_EXPECT=lost`, which inverts every `subject`
  assertion. Against the *same fixed* code it must **fail** — "lost" asks it to
  expect a bug that is no longer there. If it still passes, the assertion was
  vacuous. Controls never follow `VOID_EXPECT`, so they pass in both modes; that
  is what distinguishes them from subjects.

```
npm run test-void                                     # fixed code: must pass
VOID_EXPECT=lost npm run test-void                    # fixed code: must fail
git stash && npm run compile && npm run test-void     # unmodified: must fail
git stash pop && npm run compile
```
