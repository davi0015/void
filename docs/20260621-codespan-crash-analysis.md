# Renderer Crash Analysis — `shorten()` in `generateCodespanLink`

## Problem

Void's renderer process crashed repeatedly with exit code 5 (SIGTRAP on macOS, triggered by an unresponsive renderer). The crash occurred during normal chat usage — no user action beyond viewing AI responses with inline code references.

```
[error] CodeWindow: renderer process gone (reason: crashed, code: 5)
```

Two crashes were observed:
1. **2026-06-19 10:09:48** — crash dump `22bd6d58-85b5-475f-a7b9-0046a87859cd.dmp` (19MB)
2. **2026-06-19 23:44:50** — crash dump `d2dbc601-6ad1-40b7-b800-900708669c40.dmp` (828KB)

---

## Root Cause Chain

1. **React renders a chat message** containing inline code spans (e.g. `` `src/foo/bar.ts` ``)
2. **Each inline code span** creates a `CodespanWithLink` component (`ChatMarkdownRender.tsx:192`)
3. **`CodespanWithLink`** calls `chatThreadService.generateCodespanLink()` on first render if no cached link exists
4. **`generateCodespanLink`** (`chatThreadService.ts:3246`) calls `shorten(prevUriStrs)` — an O(n²) algorithm from `vs/base/common/labels.ts` that compares every path against every other path to find unique short names
5. **`shorten` runs on the renderer (main) thread** — it's synchronous JavaScript, so the entire Electron renderer is blocked while it runs
6. **As conversations grow**, `prevUris` (all files ever mentioned in the chat) grows. With 50+ files, `shorten` takes 100ms–1200ms per call
7. **Multiple codespans fire concurrently** — a single AI message might reference 10+ filenames, each triggering `generateCodespanLink`. The `shorten` calls queue up on the same thread, compounding the block time
8. **Electron's renderer watchdog** detects the unresponsive process and kills it with code 5

---

## Evidence

### Escalating Long Tasks

The renderer log shows `VERY LONG TASK` warnings climbing from ~120ms to **1187ms** just before the second crash:

| Time | Duration |
|---|---|
| 19:16 | 667ms |
| 19:32 | 670ms |
| 21:53 | 431ms |
| 23:00 | 375ms |
| 23:33 | 373ms |
| **23:34** | **1187ms** |

10 minutes later → crash at 23:44.

### `PerfSampleError` Stack Traces

Repeated errors in the renderer log, all with the same stack:

```
PerfSampleError: by <<renderer>> in shorten#workbench.desktop.main.js:46482:17
    at shorten (...)
    at ChatThreadService2.generateCodespanLink#workbench.desktop.main.js:92633:37
    at CodespanWithLink3#workbench.desktop.main.js:506723:25
    at renderWithHooks (...)
    at updateFunctionComponent (...)
    at beginWork (...)
```

These appeared at: 17:08, 17:16, 23:00 (session 2), and throughout the previous session (Jun 17–19).

### Listener Leak (Secondary)

The renderer log also shows a growing listener leak:

```
[9351] potential listener LEAK detected, having 175 listeners already
[9351] potential listener LEAK detected, having 263 listeners already
[9351] potential listener LEAK detected, having 351 listeners already
```

This contributes to memory pressure but is not the direct crash cause.

---

## Secondary Bug: Wrong Array Index

The second `shorten` call in `generateCodespanLink` (search results loop) had an indexing bug:

```typescript
// Line 3319-3320 (BEFORE fix)
for (const [idx, uri] of uris.entries()) {    // idx from search results
    if (doesUriMatchTarget(uri)) {
        const prevUriStrs = prevUris.map(uri => uri.fsPath)
        const shortenedUriStrs = shorten(prevUriStrs)    // shortened prevUris
        let displayText = shortenedUriStrs[idx]           // idx from uris, NOT prevUris!
```

When `idx >= prevUris.length`, `shortenedUriStrs[idx]` is `undefined`, and the next line (`displayText.lastIndexOf(...)`) throws a TypeError. This didn't cause the crash directly but generated additional errors in the renderer log.

---

## Fix

Replaced both `shorten()` calls with `this.getRelativeStr(uri)` — an O(1) method that strips the workspace folder prefix from the path.

**Before:**
```typescript
const prevUriStrs = prevUris.map(uri => uri.fsPath)
const shortenedUriStrs = shorten(prevUriStrs)       // O(n²), blocks renderer
let displayText = shortenedUriStrs[idx]               // wrong index in 2nd loop
const ellipsisIdx = displayText.lastIndexOf('…/');
if (ellipsisIdx >= 0) {
    displayText = displayText.slice(ellipsisIdx + 2)
}
```

**After:**
```typescript
const displayText = this.getRelativeStr(uri) ?? uri.fsPath   // O(1), no blocking
```

### What Changed

- Removed `import { shorten } from '../../../../base/common/labels.js'`
- Replaced both `shorten()` call blocks (lines 3293-3299 and 3319-3327) with `this.getRelativeStr(uri) ?? uri.fsPath`
- `getRelativeStr` returns the workspace-relative path (e.g. `/src/foo/bar.ts`), falling back to the full fsPath if outside the workspace

### What This Fixes

1. **Renderer crash** — no more O(n²) synchronous calls blocking the renderer thread
2. **Wrong array index bug** — eliminated entirely by not using `shorten` with mismatched arrays

---

## Remaining Improvements

These are not crash-causing but could improve `generateCodespanLink` further:

1. **No deduplication** — if the same codespan appears multiple times in a message (e.g. `foo.ts` mentioned 5 times), `generateCodespanLink` runs 5 times instead of checking the cache first
2. **`function-or-class` branch is unbounded** — iterates all `prevUris` with no limit, calling `findMatches` + definition providers for each. For conversations touching 50+ files, this is slow sequential async work
3. **No cancellation** — if the component unmounts (user scrolls, switches threads), the async work continues
4. **Listener leak** — the growing listener count (175 → 351) suggests an event subscription leak somewhere in Void's code, separate from this crash

---

## Architecture Reference

### Codespan Link Resolution Flow

```
AI response with inline code (`src/foo/bar.ts`)
  → React renders <CodespanWithLink>
      → getCodespanLink()  ← check cache (linksOfMessageIdx)
          if cached → return link immediately
          if not cached → generateCodespanLink() async
              ↓
      file-or-folder branch:
          1. Check prevUris (files seen in conversation) for match
             → getRelativeStr(uri) for display text    ← [VOID FIX] was shorten()
          2. If not found, search codebase via search_pathnames_only
             → getRelativeStr(uri) for display text    ← [VOID FIX] was shorten()

      function-or-class branch:
          1. For each prevUri, open model → findMatches → definition providers
          2. Return first definition found
              ↓
      → addCodespanLink()  ← store in linksOfMessageIdx cache
      → setDidComputeCodespanLink(true)  ← trigger re-render
```

### `shorten()` Algorithm Complexity

`shorten(paths[], separator)` from `vs/base/common/labels.ts`:

- For each path, tries every possible subpath length (1..n segments)
- For each subpath, checks against all other paths for uniqueness
- Worst case: O(n² × m) where n = number of paths, m = max segment depth
- Designed for small arrays (e.g. editor tabs) — not for potentially hundreds of file URIs from a chat conversation

### `getRelativeStr()` Algorithm Complexity

`getRelativeStr(uri)` from `chatThreadService.ts`:

- Checks `isInsideWorkspace(uri)` — O(f) where f = number of workspace folders
- Strips the workspace folder prefix — O(1) string replace
- Total: O(f) ≈ O(1) in practice (typically 1-3 workspace folders)

---

## Log Locations

| What | Path |
|---|---|
| Main process log | `~/Library/Application Support/Void/logs/<timestamp>/main.log` |
| Renderer log | `.../logs/<timestamp>/window<N>/renderer.log` |
| Extension host log | `.../logs/<timestamp>/window<N>/exthost/exthost.log` |
| Crash dumps | `~/Library/Application Support/Void/Crashpad/pending/` |

### Crash Dump Analysis

The `.dmp` files are binary minidumps. To get a human-readable stack trace:

```shell
# Option 1: minidump-stackwalk (cargo install minidump-stackwalk)
minidump-stackwalk ~/Library/Application\ Support/Void/Crashpad/pending/<id>.dmp

# Option 2: lldb
lldb -c ~/Library/Application\ Support/Void/Crashpad/pending/<id>.dmp
(lldb) bt
```

### Key Log Patterns

```shell
# Find renderer crash events
grep "renderer process gone" ~/Library/Application\ Support/Void/logs/*/main.log

# Find shorten/generateCodespanLink errors
grep "shorten#\|generateCodespanLink#" ~/Library/Application\ Support/Void/logs/*/window*/renderer.log

# Find very long tasks
grep "VERY LONG TASK" ~/Library/Application\ Support/Void/logs/*/window*/renderer.log

# Find listener leaks
grep "listener LEAK" ~/Library/Application\ Support/Void/logs/*/window*/renderer.log
```

---

## Files Modified

- `src/vs/workbench/contrib/void/browser/chatThreadService.ts` — removed `shorten` import, replaced both `shorten()` calls with `getRelativeStr()`
