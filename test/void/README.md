# Void end-to-end tests

Tests that drive the real application (Electron under Playwright) and assert
against what actually reached disk.

```
npm run test-void                          # every test/void/*.test.mjs
npm run test-void -- --only=durable        # files matching a substring
node test/void/run.mjs --only=durable      # same, without npm in the way
VOID_EXPECT=lost npm run test-void         # invert subject assertions (see below)
```

There is deliberately no per-test npm script. One entry point plus `--only`
covers both "run everything" and "run this area", and per-file aliases would
multiply with every new test file.

Requires a compiled build and a downloaded Electron (`npm run compile`,
`npm run electron`). The runner checks this up front and says so.

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

## Demonstrating a bug

`VOID_EXPECT=lost` inverts every `subject` assertion, so the same suite that
passes on fixed code must fail on unmodified code:

```
git stash && npm run compile && VOID_EXPECT=lost npm run test-void   # must fail
git stash pop && npm run compile && npm run test-void                # must pass
```
