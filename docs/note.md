## Setup

### Prepare node
```sh
nvm install 20.18.2
```

### Mac need clang version 15.x or 16.x

Point xcode-select at the CLT (NOT the full Xcode):

```sh
sudo xcode-select -s /Library/Developer/CommandLineTools
```

Verify Clang is now 15.x or 16.x (NOT 21.x):

```sh
clang --version
```

#### Fix: Make Node + npm trust a corporate MITM CA (only needed on networks doing SSL inspection)

Skip this whole section if `npm install` / `electron install` already work. It applies when the machine is on a network that intercepts TLS (corporate proxy, zero-trust agent, etc.) and re-signs outbound HTTPS with a private root CA. Symptom: browsers work fine (they trust the root via the OS keychain) but `npm` / `node` / Electron fail with `self-signed certificate in certificate chain`, `unable to get local issuer certificate`, or similar — because Node ships its own bundled CA list and doesn't read the OS keychain.

Step 1 — Export the corporate root CA from your keychain

Quickest CLI route — dump all system roots into one PEM bundle:

```sh
# Dumps every cert in the system keychain to a PEM bundle.
# This is broad on purpose so you don't have to hunt for the exact one.
security find-certificate -a -p /Library/Keychains/System.keychain > ~/.corp-ca-bundle.pem
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> ~/.corp-ca-bundle.pem

Verify the bundle is populated and contains your corporate CA (adjust the grep terms to whatever substring identifies your org's root — e.g. part of the CA common name shown in the browser's cert details):

```sh
grep -c "BEGIN CERTIFICATE" ~/.corp-ca-bundle.pem   # should print a number > 100
openssl crl2pkcs7 -nocrl -certfile ~/.corp-ca-bundle.pem | openssl pkcs7 -print_certs -noout | grep -iE "<your-corp-substring>"
```

#### Step 2 — Tell Node about it (every shell session)

Add to ~/.zshrc:

```sh
echo '' >> ~/.zshrc
echo '# Corporate CA bundle for Node / Electron / npm' >> ~/.zshrc
echo 'export NODE_EXTRA_CA_CERTS="$HOME/.corp-ca-bundle.pem"' >> ~/.zshrc
echo 'export AWS_CA_BUNDLE="$HOME/.corp-ca-bundle.pem"' >> ~/.zshrc
echo 'export REQUESTS_CA_BUNDLE="$HOME/.corp-ca-bundle.pem"' >> ~/.zshrc
echo 'export SSL_CERT_FILE="$HOME/.corp-ca-bundle.pem"' >> ~/.zshrc
```

Then reload:

```sh
source ~/.zshrc
echo "$NODE_EXTRA_CA_CERTS"   # should print /Users/david.halim/.corp-ca-bundle.pem
```

Step 3 — Tell npm specifically

```sh
npm config set cafile "$HOME/.corp-ca-bundle.pem"
npm config get cafile   # confirm
```

#### Step 4 — Tell Electron specifically (its installer uses got, not Node's https directly, but it does honor NODE_EXTRA_CA_CERTS)

Already covered by Step 2. As an extra safety net, you can also set:

```sh
echo 'export ELECTRON_GET_USE_PROXY=true' >> ~/.zshrc
```

#### Step 5 — Clean and retry

```sh
# Clear partial install so the postinstall hooks re-run cleanly
rm -rf node_modules

# Make sure the Electron download cache from a previous broken run is gone
rm -rf ~/Library/Caches/electron

npm install
```



### Installation

```sh
npm install
```

### Running

```sh
npm run buildreact     # build React UI bundle
npm run watchreact     # start the watcher for react
npm run watch          # start the watcher (leave running)

# new terminal:
./scripts/code.sh --user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions
```

### Dev console helpers

Test helpers live in `src/vs/workbench/contrib/void/browser/chatThreadDevTools.ts`.
They are auto-registered on `globalThis` at startup (via `services.tsx`).

Open the dev console in the running Void instance (Help → Toggle Developer Tools), then:

```js
// Populate the current chat tab with 15 turns of fake user/assistant messages
// (each assistant has ~2k chars reasoning + ~2k chars display with code blocks).
// Tests: tab switching perf, sidebar resize perf, initial render cost.
__voidChatThreadService._populateTestThread(15)

// Simulate a streaming LLM response through the real render pipeline.
// Streams reasoning first, then display content with markdown/code/tables.
// Tests: editor slowdown during streaming, incremental render perf.
__voidChatThreadService._simulateStream()

// Options: charsPerChunk (default 30), intervalMs (default 40), includeReasoning (default true), repetitions (default 1)
__voidChatThreadService._simulateStream({ charsPerChunk: 50, intervalMs: 20, repetitions: 3 })

// Worst case: long history + active streaming
__voidChatThreadService._populateTestThread(15)
__voidChatThreadService._simulateStream()

// Show current chat size breakdown (chars, ~tokens, per role)
__voidChatStats()
```

To use the helpers programmatically from other modules:

```typescript
import { buildTestMessages, getStreamContent, chatStats } from './chatThreadDevTools.js'

const msgs = buildTestMessages(20)           // 20 turns of user+assistant
const { reasoning, display } = getStreamContent({ repetitions: 3 })
```

### Performance optimisations applied

- **Incremental lexer** (`ChatMarkdownRender.tsx`): During streaming, reuses frozen tokens for the
  stable prefix and only re-lexes the appended tail. Per-frame cost: O(delta) instead of O(total).
- **`React.memo` on `RenderToken`**: Frozen tokens keep stable object references from the incremental
  lexer, so React skips re-rendering them entirely. Only the last 1-2 tokens re-render per frame.
- **`useMemo` on `chatMessageLocation`** (`SidebarChat.tsx`): Prevents a new object reference from
  defeating `React.memo` on every stream update.
- **Tool call preview streaming** (`EditToolChildren`): Passes `isStreaming` so the incremental lexer
  is used for the chat-side code preview during `edit_file` / `rewrite_file` tool calls.
- **Stream throttle**: Bumped from 50ms → 100ms to give the editor more main-thread budget.
- **Per-thread storage** (`chatThreadService.ts`): Each thread is stored under its own SQLite key
  (`void.chatThread.{id}`) instead of a single blob for all threads. Saving one thread no longer
  re-serializes the entire map. A lightweight index key (`void.chatThreadIndex`) stores the list
  of thread IDs. Automatic one-time migration splits the old blob on first load.
- **Granular stream subscriptions** (`services.tsx`): Added `useStreamRunningState` hook that only
  re-renders when the `isRunning` status transitions (e.g. idle→LLM→idle), not on every content
  tick. `SidebarChat` and `CommandBarInChat` switched from `useChatThreadsStreamState` (fires every
  ~100ms during streaming) to this hook. Parent render count dropped from ~100/stream to ~2.
- **`React.memo` on container components** (`SidebarChat.tsx`, `SidebarThreadSelector.tsx`): Wrapped
  `CommandBarInChat`, `ThreadMessagesView`, `SidebarThreadTabs`, and `PastThreadsList` in
  `React.memo`. These components have stable props during streaming and were re-rendering only
  because their parent (`SidebarChat`) did. Eliminated ~100 redundant renders per stream per component.
- **Ref-based scroll tracking** (`ScrollToBottomContainer`): Replaced `useState(isAtBottom)` with
  `useRef`. Scroll events now update the ref directly without triggering React re-renders. Removed
  ~85 self-triggered re-renders per stream. Threshold increased from 4px to 40px for more robust
  auto-scroll-to-bottom detection.
- **Streaming→committed bubble DOM reuse** (`ThreadMessagesView`): Merged streaming and committed
  `ChatBubble` arrays into a single `allBubblesHTML` array so React can match the same key across
  the streaming→committed transition. Previously, React unmounted the entire streaming bubble DOM
  tree and remounted a new committed one (expensive reflow on large messages). Now it patches in
  place. Eliminated visible stutter at stream end on 90k-token conversations.
- **Lexer cache seeding on stream end** (`ChatMarkdownRender.tsx`): When the streaming `IncrementalLexer`
  finishes, its final tokens are written into the module-level LRU cache so the committed message's
  `cachedLex()` call is an instant hit. Avoids a redundant full re-lex of the entire response.
- **DiffZone reuse across agent edits** (`editCodeService.ts`): When the agent calls `edit_file` or
  `rewrite_file` on the same file multiple times, the existing DiffZone is reused instead of being
  destroyed and recreated. Diff highlights accumulate against the original baseline — overlapping
  edits merge, non-overlapping edits show separate highlights. Previously each new edit wiped all
  prior highlights via `acceptOrRejectAllDiffAreas`.
- **Deferred view zones + widgets during streaming** (`editCodeService.ts`): Red deleted-code blocks
  (`IViewZone`) and Accept/Reject inline widgets are skipped during streaming. Each `changeViewZones`
  call triggers a synchronous layout recalculation; deferring them until stream end avoids repeated
  forced reflows. Green decorations are still shown during streaming for visual feedback.
- **Batched streaming writes** (`editCodeService.ts`): Added `skipRefresh` option to `_writeURIText`.
  During streaming, `_writeStreamedDiffZoneLLMText` makes 2-4 `_writeURIText` calls per tick, each
  of which previously triggered a full clear → recompute diffs → render cycle. Now all internal
  writes skip the refresh; the caller does a single refresh at the end. Also applied to
  `_instantlyApplySRBlocks` and `instantlyRewriteFile` whose writes are followed by `onDone()`.
- **Character-level search-replace matching** (`editCodeService.ts`): `_instantlyApplySRBlocks` now
  uses exact `indexOf` for character-level positioning instead of line-level `findTextInCode`. When
  the LLM sends a partial line in the SEARCH block (e.g. `Elara` matching `Elara found a crystal...`),
  only the matched substring is replaced — the rest of the line is preserved. Falls back to
  line-level matching only when exact match fails (whitespace differences).
- **Uniqueness check on search-replace matching** (`editCodeService.ts`): Both `findTextInCode` and
  `_instantlyApplySRBlocks` now verify that the SEARCH block matches exactly one location. On the
  exact `indexOf` path, `lastIndexOf` is compared to detect duplicates. On the whitespace fallback
  path, the existing uniqueness check is preserved and a new line-boundary validation ensures the
  match covers complete lines (preventing partial-line truncation when the SEARCH block ends mid-line).
  Error messages now include match count and line numbers (up to 20 occurrences) so the agent can
  target the correct location with more context.
- **Safe fence for `read_file` result** (`toolsService.ts`): The `read_file` tool wraps file contents
  in code fences (triple backticks). When the file itself contains triple backticks (markdown files,
  template literals, docstrings), the inner backticks collide with the wrapper, mangling the content
  from the agent's perspective. `safeFence()` scans the file for the longest backtick run and uses
  one more backtick than that for the wrapper (e.g. 4 backticks if the file contains triple backticks).
  This resolves issues where the agent saw stale/corrupted content after `rewrite_file`, failed to
  match end-of-file content, or couldn't detect unclosed code fences.
- **Tool status UI cache fix** (`SidebarChat.tsx`): The `ThreadMessagesView` message cache compared
  only message count and thread-level deps to decide whether to reuse cached JSX. When a tool message
  was edited in place (e.g. `running_now` → `success`), the array length didn't change so the cache
  returned stale HTML — the "Editing file..." title never updated to "Edited file". Fixed by including
  the messages array reference in the cache check; since `_editMessageInThread` creates a new array
  via spread, the reference comparison invalidates the cache on any in-place edit.
- **Tool error reason classification** (`chatThreadService.ts`, `requestTelemetryService.ts`): Added
  `errorReason` field to `TelemetryToolEntry` so tool errors are classified by cause rather than just
  `status: 'error'`. `classifyToolError()` maps error messages to short tags: `not_unique` (SEARCH
  block matched multiple locations), `not_found` (SEARCH block didn't match anything), `has_overlap`
  (ORIGINAL blocks overlap), `file_not_found` (ENOENT), `stringify` (result serialization failure),
  `unknown`. Enables telemetry analysis to differentiate e.g. "agent needs more context" from "agent
  has stale file content" without parsing error message strings.

### Known performance issues

- **Resize / tab-switch with long chats**: Large DOM tree from fully-rendered messages causes
  expensive reflow. `content-visibility: auto` breaks `scrollTop = scrollHeight` scroll-to-bottom.
  Potential fixes: progressive rendering (render recent messages first, older ones in idle frames),
  or full message-level virtualization with an IntersectionObserver-based scroll mechanism.
- **Editor slowdown during tool execution**: The actual file write / diff-apply path — separate from
  the chat-side preview rendering. Needs investigation.

## Build

End-to-end: build a `Void.app`, wrap it in a DMG, and hand it to teammates.
Whole pipeline is ~25 min per architecture; do once per release.

### 1. Pre-build sanity (cheap, ~1 min)

Stop any running watchers — they conflict with the gulp packaging step:

```sh
npm run kill-watch-clientd
npm run kill-watch-extensionsd
# also stop ./scripts/code.sh and any `npm run watchreact` you have running
```

Build the React UI bundle (production, one-shot) and verify TypeScript compiles:

```sh
npm run buildreact
npm run compile        # gulp compile — catches type errors before the long step
```

If `npm run compile` errors out, fix it first. Catching it here saves ~25 min vs. failing inside the gulp packaging step.

### 2. Build the .app (long, ~25 min per arch)

Apple Silicon (most common, also what your dev machine uses):

```sh
npm run gulp vscode-darwin-arm64           # unminified (faster build, easier to debug)
# or
npm run gulp vscode-darwin-arm64-min       # minified (smaller bundle, slower build)
```

Intel (only needed if a teammate is still on an Intel Mac):

```sh
npm run gulp vscode-darwin-x64
```

Output lands **outside** the `void/` repo, in a sibling folder:

```
Projects/
├── void/                      # this fork
└── VSCode-darwin-arm64/
    └── Void.app               # the actual deliverable
```

Smoke-test it locally before packaging:

```sh
open ../VSCode-darwin-arm64/Void.app
```

Sanity check: chat sidebar loads, settings page opens, one test chat with a configured model returns a response.

### 3. Package as DMG (cheap, ~1 min)

One-time install of the wrapper tool:

```sh
brew install create-dmg
```

Build the DMG (run from `void/`'s parent directory):

```sh
cd ..
create-dmg "Void-1.4.9-arm64.dmg" "VSCode-darwin-arm64/Void.app"
# repeat for x64 if you built it
create-dmg "Void-1.4.9-x64.dmg"   "VSCode-darwin-x64/Void.app"
```

Bump the version string to match `product.json` `voidVersion` so teammates can tell builds apart.

### 4. Ship it

The build is **not** code-signed (no Apple Developer ID). Recipients will hit Gatekeeper on first launch. Send the DMG along with these instructions:

> 1. Open the DMG, drag **Void.app** to **Applications**, eject the DMG.
> 2. Open Terminal and run: `xattr -cr /Applications/Void.app`
> 3. Launch Void normally.

Step 2 is the only awkward part. It strips the `com.apple.quarantine` attribute that macOS auto-adds to anything coming from outside an App Store-signed source. After that, double-click works forever.

If a teammate refuses to touch the terminal, the alternative is right-click `Void.app` → **Open** → confirm the warning dialog. macOS remembers the choice for that exact app.

### Storage isolation: dev vs. compiled .app

Critical to know: dev mode (`./scripts/code.sh`) and the compiled `Void.app` use **completely separate user-data folders** on disk:

| Mode | productName used | Storage location |
|---|---|---|
| Dev (`./scripts/code.sh`) | `code-oss-dev` (forced by `VSCODE_DEV=1`) | `~/Library/Application Support/code-oss-dev/` |
| Compiled `Void.app` | `Void` (from `product.json` `nameLong`) | `~/Library/Application Support/Void/` |

Implications:
- **First launch of `Void.app` is a clean slate** — no chats, no API keys, no settings carry over from dev mode. Re-add API keys once.
- **Teammates can't accidentally inherit your secrets** — they get the same clean-slate experience.
- **API keys can't be migrated by file-copying** — they're encrypted with `IEncryptionService` (Electron `safeStorage` → macOS Keychain), and Keychain entries are scoped per bundle ID. `code-oss-dev` and `com.voideditor.code` are different identities, so even copying `state.vscdb` over wouldn't decrypt.
- **Non-secret settings can be migrated** by copying `~/Library/Application Support/code-oss-dev/User/settings.json` to `~/Library/Application Support/Void/User/settings.json` before first launch. Usually not worth the bother.

### Why not `void-builder`?

The official Void release pipeline lives in [voideditor/void-builder](https://github.com/voideditor/void-builder) (a VSCodium fork). It handles code signing, notarization, auto-updates, and Linux/Windows builds via GitHub Actions. Use it when you actually want to publish releases. For "share with a few teammates", the local-build + create-dmg + xattr instructions above are the right tradeoff.

## Benchmark
Task 0 (intro): Can you explore the void project (about fork of vscode to support agent) and describe me how to run it?
Task 1 (small/fast): "Add a console.log at the start of the chat_systemMessage function in prompts.ts that prints the mode"
Task 2 (medium): "In Settings.tsx, rename `isUnrecognizedModel` to `isModelUnrecognized` across all uses"
Task 3 (tool-heavy): "Find all files that import IVoidSettingsService and list them"
Task 4 (agentic/cert-style): "Run ./script.sh and diagnose any SSL/cert issue you see"
Task 5 (marathon): "Explain how prompt caching works in prompts.ts by reading the relevant files"

## Model behavior notes (empirical)

Findings from direct `generateContent` curl tests against Google AI Studio. Useful for model selection and for grounding roadmap decisions.

### Gemma 3 27B IT (AI Studio)

- **No native reasoning.** No `<think>` tags, no `thought: true` parts, no `thoughtsTokenCount`.
- **Hedging/consultant output style** — lists multiple options, ends with "provide more info so I can help further". Baked into the instruction tuning; prompt engineering can reduce but not eliminate.
- **Output-token reporting bug (Google-side).** `usageMetadata` only returns `promptTokenCount` and `totalTokenCount == promptTokenCount`, omitting `candidatesTokenCount` entirely. Void's token ring will show 0 output tokens for Gemma 3. Not a Void bug.
- **No prefix caching.** Confirmed — see caching test below.

### Gemma 4 26B A4B IT (AI Studio)

- **Native reasoning via Gemini's `thought: true` part flag** (not `<think>` tags). Response contains two parts: one marked `thought: true` (planning/hedging), one without (final answer).
- **Output quality markedly better than Gemma 3.** The hedging lives in the thought part; the final answer is concrete, action-oriented, and structured. This is the "targeted" behavior small open models usually lack.
- **Token reporting works correctly.** `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, and `totalTokenCount` all populated.
- **Prefix caching works** — requires ~3 requests to warm up (vs. 2 for Gemini 2.5 Flash Lite). Hit size and block granularity match Gemini-tier models once active.

### Caching test (2786-token identical prefix, same-session repeat, 2s gap)

| Model | First request showing cache | Cached size | Hit % |
|---|---|---|---|
| `gemini-2.5-flash-lite` | request 2 | 2042 | 73% |
| `gemma-4-26b-a4b-it` | request 3 | 2037 | 73% |
| `gemma-4-31b-it` | request 4 | 2037 | 73% |

Conclusions:
- **All three models share the same cache infrastructure** — identical block granularity (~1024 tokens), identical post-warm-up hit size (~2037 tokens), identical 73% hit ratio on this prompt.
- **Warm-up latency scales with model size.** Bigger / denser models need more requests before the cache commit becomes visible. Likely a serving-infrastructure propagation delay rather than a model-level feature gate. In real Void usage this is a non-issue — by turn 4 of any normal conversation, cache is live on every Gemini-API model.
- Earlier belief that "Gemma doesn't cache" was wrong; it was a 2-request test artifact on Gemma.
- TTL undocumented, in the ~minutes range.
- Gemma 3 27B IT not tested for caching (likely similar; skipped since Gemma 4 dominates on quality regardless).

### Recommended default

With caching confirmed on all Gemma 4 variants, the case for a hybrid workflow weakens considerably. **Gemma 4 31B IT as the default** for most Void work:
- Good reasoning quality (via `thought: true` parts)
- Caches (after 4-request warm-up)
- Free tier on AI Studio
- Works with Void today (modulo the known fixes in "Next" below)

Switch to:
- `gemma-4-26b-a4b-it` — slightly faster cache warm-up (3 reqs vs 4), comparable quality in a sparse-MoE package; worth testing as a daily driver if 31B feels slow.
- `gemini-2.5-flash-lite` — fastest cache warm-up (2 reqs), cheapest paid tier, no reasoning.
- `gemini-2.5-flash` / `gemini-2.5-pro` — when tasks exceed Gemma 4's capability ceiling.

Gemma 3 27B IT: deprecated by Gemma 4 on every axis tested.

## Long-session observations (empirical, MiniMax 2.5 via OpenRouter / opencode)

- **Server-side cache cap around ~160k input tokens.** Cache hits are healthy under ~130k (typical gap a few hundred tokens), then `cached_tokens` cleanly drops to 0 on subsequent requests. Binary cliff, not gradual decay — strongly suggests the provider stops attempting prefix matching past an internal cap rather than the prefix diverging client-side. Not a Void bug. Mitigation lives client-side: history compaction / per-tool-result trimming.
- **Renderer slowdown on long threads.** UI becomes laggy after ~50+ messages, especially during streaming. Suspected: every streamed chunk re-renders the full message list; large tool blobs (`read_file` outputs, edit diffs) re-run markdown parsing + syntax highlighting on each render. Needs a profiler pass — likely fixed via memoization + render throttling + virtualization.
- **Quadratic billing in tool-heavy turns; linear UI display.** Agent loop with N tool calls triggers N sequential requests, each carrying the full history + accumulating tool results. Tokens summed across all N requests = O(N²). The `TokenUsageRing` shows only the latest request's input tokens (O(N)), so the displayed number understates real billing significantly on long agent loops. Two-pronged fix: surface cumulative tokens in the tooltip (honesty), reduce N via parallel tool calls + tool-result trimming (substance).
- **Cross-thread file state.** File edits propagate **via the filesystem**, not via shared in-memory chat state. Phase B bakes volatile context (file listing, open tabs, active URI, date, terminals) into each user message at the moment of send, so a new user message in any thread reflects current workspace state. File *contents* are only seen via `read_file` tool calls — older tool results in other threads stay stale until the agent reads again.

## Prompt evaluation logs

Empirical baselines and deltas from running the Benchmark tasks against real models. Used to ground prompt-phase decisions instead of guessing.

### Phase A1+A2 evaluation (in progress)

**Setup.** Two Void instances side-by-side, same workspace, same model settings. Tasks 0, 3, 5 from the Benchmark section. One chat window per model, three tasks run sequentially. Reasoning + tool calls captured implicitly via UI; final response text manually copied for scoring.

**Phase A1+A2 = Option 1 patch:**
- A1: Persona shift in `chat_systemMessage` header from "expert coding agent" to "senior software engineer working as the user's pair-programmer", with explicit end-to-end ownership framing.
- A2: Three new directives added near top of `importantDetails`, applying across all modes: (1) commit to one solution, (2) act don't describe, (3) brief completion summary, no padded offers.

**Baseline (BEFORE A1+A2)** — captured on three models:

| Task | Model | Hedges¹ | Trail-off² | Clarifying Q? | Correct? | Tool efficiency³ | Total chat tokens |
|---|---|---|---|---|---|---|---|
| 0 (intro) | Nemotron | Med (4–5) | **Yes** | No | Yes | Good | — |
| 3 (tool-heavy) | Nemotron | None | No | No | Yes (16 files, dedup'd) | Good | — |
| 5 (marathon) | Nemotron | Med | No | No | Partial⁴ | Good | 40k |
| 0 | Gemma 4 26B | Low | No | No | Yes | Good | — |
| 3 | Gemma 4 26B | None | No | No | Yes (16 files) | Good | — |
| 5 | Gemma 4 26B | **High** | No | No | Eventual | **Bad — visible search loop** | 75k |
| 0 | MiniMax 2.5 | Low | No | No | Yes | Good | — |
| 3 | MiniMax 2.5 | None | No | No | Yes (table format; small "18 total" arithmetic slip vs 16 in the table) | Good | — |
| 5 | MiniMax 2.5 | Low | No | No | Partial⁴ | Med — ~6 reads/searches | 76k |

¹ count of "could", "maybe", "perhaps", "alternatively", "however", "let me know", "would you like", "I think", "potentially", "likely", "if the user is".
² ends with "let me know if you want me to..." or similar offer.
³ subjective: did the model converge with minimum tool calls.
⁴ Models can't know about Phase 1/B caching architecture from reading the code — they correctly identify message-trimming + provider cache pricing entries, but miss the prompt-structure-as-caching-mechanism. Not a hedging issue, model knowledge limit. Won't be fixed by A1+A2.

**Pre-after predictions / expectations:**

- *Strong A1+A2 signal candidate:* Nemotron Task 0's "Would you like me to help you with anything specific..." trail-off should disappear. This is the textbook A2 directive #3 target.
- *Medium signal:* Gemma 4 Task 5 hedge density should drop somewhat. Search-loop will likely persist (driven by existing "ALWAYS have maximal certainty" / "OFTEN need to gather context" / "as many steps as you need" rules — A1+A2 don't touch these; A4 does).
- *Minimal signal expected on MiniMax 2.5:* already has zero trail-offs, low hedge density, decisive tone. The only remaining pathology (Task 5 search-loop) is the over-iteration pull, not hedging. **MiniMax-after may look essentially identical to MiniMax-before, and that's the expected result, not a Phase A failure** — it's the data point that justifies Option 2 with A4 as headline.
- *Not expected to fix:* Task 5 partial-answer correctness (Nemotron and MiniMax both miss Phase B caching mechanism — model knowledge gap, not prompt fixable).

**AFTER A1+A2 results:**

| Task | Model | Hedges¹ | Trail-off² | Q? | Correct? | Tool eff.³ | Total chat tokens | Δ vs before |
|---|---|---|---|---|---|---|---|---|
| 0 | Nemotron | Low–Med | **No** (caveat about HOW_TO_CONTRIBUTE.md, but no "let me know") | No | Yes | Good | 76k | trail-off **gone**; tokens **+90%** |
| 3 | Nemotron | None | No | No | Yes (15 imports + note re: def file) | Good | — (within 76k chat) | flat |
| 5 | Nemotron | Low | No | No | Better — 4 explicit efficiency mechanisms | Good | — | quality up, hedging down |
| 0 | Gemma 4 26B | Low ("Not Recommended" caveat on local exec) | No | No | Yes — **minor slip**: "outside of your HOW_TO_CONTRIBUTE.md directory" (should be "outside your project directory"); reasoning blended two source files | Good — 3 focused reads (root → README → HOW_TO_CONTRIBUTE) | 55k | flat in length, **cleaner reasoning structure** (visible "I will..." action-statements via Gemini `thought:` parts) |
| 3 | Gemma 4 26B | None | No | No | Yes (15 imports, **explicitly verifies** def file before excluding) | Good | — | small quality lift — reasoning more rigorous than before's blind dedup |
| 5 | Gemma 4 26B | None | No | No | Correct but **shallow** ("not in this file, probably elsewhere") | **Excellent — only 2 reads** | — | search-loop **drastically reduced** |
| 0 | MiniMax 2.5 | — | — | — | **Response truncated** at "Press" — copy-paste artifact or model cutoff unclear | — | 90k | tokens **+18%** for the chat |
| 3 | MiniMax 2.5 | None | No | No | Yes (16 files, **no table** — categorized bullets) | Good | — | **no-tables rule now followed** (vs before) |
| 5 | MiniMax 2.5 | None | No | No | Better — identifies Checkpoint System (missed in baseline) plus 6 mechanisms | Med — ~6 reads | — | depth up, hedging same |

Gemma 4 26B total chat tokens: **75k → 55k (−27%)**, win spans all 3 tasks not just Task 5.

**Wins (clear evidence):**
- A2 directive #3 hits the trail-off pathology — Nemotron Task 0 went from "Would you like me to help you with anything specific..." to a clean ending. Direct, predicted, confirmed.
- Gemma 4 26B improved across **all 3 tasks**, not just Task 5. Task 0 has cleaner action-statement reasoning, Task 3 explicitly verifies the def file before excluding it (more rigorous than baseline's silent dedup), Task 5 search-loop went from 5+ self-doubting iterations to 2 clean reads. **Total chat tokens 75k → 55k (−27%).** Bigger than predicted; A1+A2 incidentally improved over-iteration on the small/uncertain model, which I'd expected only A4 could touch.
- MiniMax 2.5 Task 3 *finally followed* the `Do NOT write tables` rule (categorized bullet groups instead of a markdown table). May be coincidence, but worth a follow-up: persona shift may have re-anchored which rules feel authoritative.
- MiniMax 2.5 Task 5 went deeper and surfaced a real feature (Checkpoint System) it missed in baseline.

**Losses / surprises:**
- **Nemotron total tokens nearly doubled** (40k → 76k). Likely cause: persona "senior engineer who investigates, decides, acts" + "Act, don't describe" interpreted as *do more work* rather than *do work decisively*. Task 0 in particular ballooned in length even though style improved. Concerning if Nemotron is a daily driver.
- **MiniMax 2.5 tokens up +18%** (76k → 90k). Same root cause — Task 5 went deeper, more reads. The depth is real value (Checkpoint System discovery) but it's also real cost.
- **Gemma 4 Task 5 became too shallow.** Before: looped but eventually surfaced static/dynamic prompt ordering analysis. After: gives up at "not in this file, probably elsewhere". Trade: less hedging but less usefulness on marathon tasks.
- **Gemma 4 Task 0 small reasoning slip.** Closing sentence said "outside of your HOW_TO_CONTRIBUTE.md directory" instead of "outside your project directory" — model blended the two source files it had just read. New failure mode possibly induced by "act don't describe" pushing the model to commit to a summary even when its mental model is fuzzy. One data point, watch in future runs.

**Interpretation.** A1+A2 worked on the *stylistic* axis (decisive endings, less hedging, fewer self-doubt loops) but partly miscalibrated the *work-volume* axis in opposite directions on different model sizes:
- Small/uncertain models (Gemma 4) → less work, sometimes too little.
- Capable models (Nemotron, MiniMax 2.5) → more work, sometimes too much.

The persona shift to "senior engineer who owns problems end-to-end" reads to a small model as "don't agonize, commit" but reads to a capable model as "be thorough, leave no stone unturned". Same sentence, opposite calibration.

This is exactly what A4 (re-balance over-iteration rules) was designed to handle — pair a "stop reading once confident" instruction with a "but verify before claiming done" guard. The case for A4 in Option 2 is **stronger** after this evaluation, not weaker.

**Decision against pre-committed criteria:**
- *Keep A1+A2*: ✅ MET. Two clear wins (Nemotron trail-off, Gemma loop), no correctness regressions. Keep as new baseline.
- *Go straight to A4 instead of A1+A2*: ❌ NOT MET — Gemma loop actually improved a lot. A1+A2 wasn't redundant.
- *Revert*: ❌ NOT MET — token increases on 2/3 models is a real cost, but correctness held and stylistic wins are real. Net positive.

**Next action (post-follow-up tests).** A4 urgency downgraded — MiniMax day-to-day is healthy under A1+A2 (Test 1 trivial edit at 3 tool calls; Test 2 fresh-chat Task 0 looks like baseline). Recommended priority order is now: **Perf 3 (cumulative token display) ✅ → Perf 1 (UI profiling) → A3+A4 + unenforceable-rules audit**. Prompt phase A3+A4 is still worth doing but is no longer the most painful gap; Perf items hit daily user pain harder for less effort.

**After Perf 3 ships:** verify in-product by sending a multi-tool-call agent turn and reading the tooltip — "Cumulative this turn" should be noticeably larger than "Last request" (typically 3–5× on a loop with 4 tool calls). If "Cumulative this thread" doesn't survive a reload, check the persistence path (`_storeAllThreads` should already serialize the new field via `ThreadType`).

**Open data-quality items (status update after follow-up tests):**
- ~~MiniMax Task 0 truncated mid-sentence — copy-paste artifact or model cutoff?~~ **RESOLVED** — re-run in fresh chat completed cleanly in 13k tokens. Was a copy-paste artifact. The fresh-chat response is also notably shorter than the polluted-chat version and lacks the "Note: project currently in paused maintenance state" caveat — implies the post-A1+A2 token inflation on MiniMax is partly chat-history-amplification (model picking up tone from accumulated context), not pure prompt-induced over-reading.
- Nemotron token doubling — still unverified. Lower priority since user doesn't run Nemotron day-to-day.

**Follow-up test: A4-urgency check (MiniMax, Task 1 — trivial console.log edit):**
- **3 tool calls (2 reads + 1 search)** to add a single console.log to a known function. Output decisive and accurate ("function is now on line 429... will log CHAT MODE: agent etc.").
- 3 calls is **borderline acceptable, not pathological** — theoretical minimum for "find file → edit" is 2; the extra read is conservative-but-defensible "verify position before editing" behavior.
- Combined with Test 2's evidence that fresh chats look much closer to baseline behavior, **A4 is no longer urgent**. Downgrades from "headline next prompt change" to "useful eventual cleanup, mainly for Gemma marathon tasks". MiniMax day-to-day experience under A1+A2 is healthy.

### Tangential observations from the BEFORE run (not Phase A1+A2 related)

- **`Always use MARKDOWN to format lists, bullet points, etc. Do NOT write tables.` rule has zero compliance on capable models.** MiniMax 2.5 used a markdown table for Task 3 despite the rule being in `importantDetails`. Two hypotheses: (a) the rule is buried at position ~16 in a long list and large models drift on late rules, (b) tables are too useful for tabular data and the model overrides the rule from training intuition. If we actually care about no-tables, reposition early in the list or restate near every place the model is likely to want one. If we don't care, drop the rule entirely — keeping unenforceable rules in the system message just teaches the model the prompt isn't authoritative. (Backlog item.)
- **Token-cost asymmetry across models on the same tasks** (40k Nemotron vs 75k Gemma vs 76k MiniMax for the same 3 tasks). Gemma's overhead is almost entirely Task 5 search-loop. MiniMax's overhead is more controlled but still visible. This is direct empirical confirmation that Perf 4 (parallel tool calls) + Option 2 / A4 (re-balance over-iteration) are aimed at the right pathology — small but consistent reduction here would compound massively on real workloads.
- **Redundant file re-reads within a single user turn** (MiniMax, anecdotal, post-Perf-4): on a trivial "add one more console.log" follow-up in an already-open chat, the agent did multiple `read_file` calls on the same file in the same turn before committing to an edit — once to locate a function and again with slightly different line ranges to "verify". The extra reads are individually cheap but they (a) compound with the token-inflation A1+A2 already introduced on capable models (see above), (b) waste one of the two round-trips Perf 4 buys us when the second read isn't actually independent of the first, and (c) feel laggy in the UI even though billing-wise it's fine. Worth noting as direct evidence for A4 (rebalance over-iteration): the "ALWAYS have maximal certainty BEFORE you make it" + "OFTEN need to gather context before making a change" pair is reading, to this model, as "always double-check reads before editing" even on single-line edits. Cheaper fix than full A4 if A4 slips: a one-liner to `importantDetails` like "If you've just read a file in this turn and haven't edited it, don't re-read it — edit directly." Not building that yet — collecting evidence first.

### A3 + A4 eval

Q1: In src/vs/workbench/contrib/void/common/prompt/prompts.ts, add a console.log at the start of the chat_systemMessage function that prints the chatMode parameter. Use the label "[chat_systemMessage] mode:".
Q2: In src/vs/workbench/contrib/void/common/prompt/prompts.ts, find the line that contains "NEVER reject the user's query" and change the word "reject" to "refuse" on that line. Only change that one word.
Q3: What does the chat_systemMessage function in src/vs/workbench/contrib/void/common/prompt/prompts.ts do?

#### Before
Test 1 (Minimax): 4 tool calls, last 10.8k in / 66 out, total 50.8k in / 717 out, output is `console.log('[chat_systemMessage] mode:', mode);`
Test 1 (Gemma): 1 tool calls, last 22.4k in / 353 out, total 33k in / 589 out, it doesn't call the tool to edit, only mention a typescript text with <<<< ORIGINAL ... >>> UPDATED text which is not wrong but not calling tool (only after repeated several times it can produce log)
Test 1 (Metronom): 7 tool calls, last 23.9k in / 128 out, total 167.9k in / 4.81k out, output is `console.log("[chat_systemMessage] mode:", mode);`

Test 2 (Minimax): 2 tool calls, last 10k in / 50 out, total 29.4k in / 303 out, reject is correctly changed to refuse
Test 2 (Gemma): 2 tool calls, last 11k in / 40 out, total 32.3 in / 375 out, reject is correctly changed to refuse
Test 2 (Metronom): 7 tool calls, last 23k in / 1.01k out, total 165.7k in / 3.52k out, fail to make the correct change, `detail.push` was removed, agent tried to fix but failed and got "Response ended unexpectedly (finish_reason: error)." error at the end (which means we verify that unexpected termination feature is correct)

Test 3 (Minimax): 3 tool calls, last 10.9k in / 307 out, total 39.1k in / 581 out, the agent manages to explain about the function about comprehensive system prompt for void chat system
Test 3 (Gemma): 1 tool calls, last 21.2k in / 572 out, total 30.8k in / 642 out, the agent manages to explain about the function about comprehensive and contexst aware system prompt for LLM used in void
Test 3 (Metronom): 1 tool calls, last 20.1k in / 682 out, total 29.2k in / 831 out, the agent manages to explain about the function about comprehensive system prompt for void chat system

#### After:
Test 1 (Minimax): 2 tool calls, last 20.6k in / 70 out, total 50.6k in / 715 out, output is `console.log('[chat_systemMessage] mode:', mode);`
Test 1 (Gemma): 2 tool calls, last 23.1k in / 59 out, total 56.2k in / 880 out, output is `console.log(`[chat_systemMessage] mode: ${mode}`);`
Test 1 (Metronom): 3 tool calls, last 33.1k in / 139 out, total 86.9k in / 1.47k out, output is `console.log("[chat_systemMessage] mode:", mode);`, it performs read -> write -> read

Test 2 (Minimax): 2 tool calls, last 10k in / 76 out, total 29.6k in / 346 out, reject is correctly changed to refuse
Test 2 (Gemma): 1 tool calls, last 10.9k in / 169 out, total 21.621.6 in / 256 out, failed to call edit tool, what is shown is a typescript text on the chat output which is correct
Test 2 (Metronom): 4 tool calls, last 21.9k in / 175 out, total 96.8k in / 915 out, reject is correctly changed to refuse, read -> search -> edit -> read

Test 3 (Minimax): 1 tool calls, last 19.3k in / 482 out, total 28k in / 569 out, the agent manages to explain about the function that generates the system prompt that gets sent to the LLM for chat modes
Test 3 (Gemma): 1 tool calls, last 21.3k in / 730 out, total 31k in / 800 out, the agent manages to explain about the function that builds a structured system message that defines how the AI should behave and what information it has access to
Test 3 (Metronom): 1 tool calls, last 20.2k in / 656 out, total 29.5k in / 756 out, the agent manages to explain about the function that generates comprehensive system prompt for the LLM based on the current chat mode and workspace context

#### After code-block scoping fix (variant iii):

After seeing the Test 2 (Gemma) After regression above (2 calls worked → 1 call + inline `<<<<<<< ORIGINAL / >>>>>>> UPDATED` diff, no `edit_file`), traced the cause to the universal code-block-format rule in `importantDetails`:

> "If you write any code blocks to the user... The first line of the code block must be the FULL PATH... The remaining contents of the file should proceed as usual."

In agent mode this competes with `ALWAYS use tools` — Gemma picked the shorter path (inline diff) because the format rule *describes* the exact shape of an edit-via-code-block. Gather/normal modes need that rule (code blocks ARE their edit mechanism); agent mode doesn't.

Fix: scope the full format rule to gather/normal; in agent mode keep only the language-tag rule.

Gemma re-run on Tests 1 + 2 (Minimax / Nemotron not re-run — didn't exhibit the bug):
Test 1 (Gemma): 2 tool calls, read + edit. Still emits a `<<<<<<< ORIGINAL / >>>>>>> UPDATED` code block in chat AS WELL AS making the edit — but the edit succeeds. Inline diff went from being the *substitute* for the edit → being chatter alongside the edit. Functional progress; token cost is small and Gemma's inline-diff bias is training-level, not prompt-fixable without risking the README-freeze case.
Test 2 (Gemma): 4 tool calls, search → read → edit → search. Edit succeeds. The trailing `search` is the A4 bullet 2 gap ("don't run redundant verification") not fully landing on Gemma — same pattern Nemotron Test 2 showed (read → search → edit → read). Both weak models do a post-edit lookback; not worth further tuning.

### Final verdict — A3+A4 + code-block scoping: SHIP.

Summary table across all three phases:

| Model × Test | Original baseline | After A3+A4 | After (iii) |
|---|---|---|---|
| Nemotron T1 | 7 calls, 167.9k in | 3 calls, 86.9k in (**−48%**) | (not re-run — worked) |
| Nemotron T2 | 7-call FAILURE + unexpected termination | 4-call SUCCESS, 96.8k in (**−42%**) | (not re-run) |
| MiniMax T1 | 4 calls | **2 calls (−50%)** | (not re-run) |
| MiniMax T3 gather | 3 calls, 39.1k in | **1 call, 28k in (−67% / −28%)** | (not re-run) |
| Gemma T1 | broken (no edit, inline diff only) | 2 calls, tool call works | 2 calls + inline diff chatter, tool call works ✅ |
| Gemma T2 | 2 calls, worked | 1 call, inline diff only (regression) | 4 calls, search→read→edit→search, edit works ✅ |

Remaining known quirks, all accepted (not worth further tuning):
- Nemotron: post-edit re-read / search (A4 bullet 2 partial land on weakest model).
- Gemma: inline `<<<<<<< ORIGINAL / >>>>>>> UPDATED` scratchpad in chat even when also calling edit_file. Training-level bias.
- Gemma: post-edit verify `search` call on Test 2. Same as Nemotron pattern.

### C1 Eval

Q. Find all .ts files directly under src/vs/workbench/contrib/void/browser/.

Before:
Resp Minimax: 1 tool calls, inspect folder, last 9.97k in / 582 out, total 19.7k in / 674 out, run successfully listing _dummyContrib.ts etc
Resp Gemma: 1 tool calls, terminal (find with maxdepth 1), last 11.3k in / 655 out, total 22k in / 693 out, run successfully listing down src/vs/workbench/contrib/void/browser/_dummyContrib.ts etc
Resp Nemotron: 2 tool calls, inspect and terminal ls, last 10.9k in / 256 out, total 32k in / 2.87k out, run successfully listing down _dummyContrib.ts etc

After:
Resp Minimax: 1 tool, inspect folder, last 9.96k in / 286 out, total 19.6k in, 370 out, run successfully listing _dummyContrib.ts etc
Resp Gemma: 1 tool calls, terminal (find with maxdepth 1), last 11.3k in / 654 out, total 22k in / 692 out, run successfully listing down src/vs/workbench/contrib/void/browser/_dummyContrib.ts etc
Resp Nemotron: 1 tool calls inspect folder, last 9.96k in / 643 out, total 19.6k in / 733 out, run successfully listing down _dummyContrib.ts etc

### C2 + C3 + C5 eval

Q: Find all .ts files directly under src/vs/workbench/contrib/void/browser/.
After:
Resp Minimax: 1 tool, inspect folder, last 10.1k in / 591 out, total 19.9k in, 690 out, run successfully listing _dummyContrib.ts etc
Resp Gemma: 1 tool calls, inspect folder, last 11.1k in / 301 out, total 21.8k in / 327 out, run successfully listing down _dummyContrib.ts etc
Resp Nemotron: 1 tool calls inspect folder, last 10.8k in / 902 out, total 21.2k in / 1.68k out, run successfully listing down _dummyContrib.ts etc


Q: Search for where chat_systemMessage is used in the codebase.

Before:
Resp Minimax: 3 tool calls, search + read convertToLLMMessageService.ts + read prompt.ts, last 30.2k in / 86 out, total 70.2k in / 206 out, mentioned used in convertToLLMMessageService.ts` and defined in prompt prompt.ts
Resp Gemma: 4 tool calls, search + read convertToLLMMessageService.ts + read prompt.ts + terminal grep -r chat_systemMessage, last 31k in / 145 out, total 101.2k in / 797 out, mentioned used in convertToLLMMessageService.ts` and defined in prompt prompt.ts
Resp Nemotron: 4 tool calls, search + read convertToLLMMessageService.ts + read prompt.ts + search again, last 28.9k in / 373 out, total 96.2k in / 1.42k out, mentioned used in convertToLLMMessageService.ts` and defined in prompt prompt.ts (both with the function signature)

After:
Resp Minimax: 2 tool calls, search + (read convertToLLMMessageService.ts + read prompt.ts) in parallel, last 27.6 in / 515 out, total 47.4k in / 714 out, mentioned used in convertToLLMMessageService.ts` and defined in prompt prompt.ts
Resp Gemma: 3 tool calls, search + read convertToLLMMessageService.ts + read prompt.ts, last 30.4k in / 89 out, total 74.6k in / 245 out, mentioned used in convertToLLMMessageService.ts
Resp Nemotron: 3 tool calls, search + read convertToLLMMessageService.ts + read prompt.ts, last 28.8k in / 267 out, total 71.5k in / 851 out, mentioned used in convertToLLMMessageService.ts

## Roadmap

### Done

- **Drag-and-drop model reordering** in the model selector.
- **Drag-and-drop tab reordering** in the chat tab strip — `IChatThreadService.reorderPinnedThread(source, target, position: 'before'|'after')` mirrors `reorderCustomModel`'s shape and routes through `_setPinsForCurrentWorkspace` so persistence + the cross-window pin listener apply for free. UI uses native HTML5 DnD with a custom horizontal-only drag ghost (native drag image suppressed via `setDragImage(invisibleEl)`; ghost is `absolute`-positioned inside the strip's outer wrapper with imperative X-only movement on `onDrag`, Y locked to its initial value so the tab can never leave the strip). Swap model is "adjacent neighbor with live baseline + cached layout": at dragStart we snapshot every tab's width, the leftmost slot's viewport-left, and the inter-tab gap into `dragLayoutRef`; each `onDragOver` derives slot positions arithmetically from `liveOrder + dragLayoutRef` (no rect reads on neighbors) and swaps while the ghost center is past the *combined* midpoint (`(source.left + neighbor.right) / 2` for right, symmetric for left). The threshold check runs in a `while` loop so a fast cursor that crosses several midpoints in a single `dragover` chains all the swaps in one event; one `setLiveOrder` commits the cumulative result. On drop we translate `liveOrder` back to the service's `(source, target, position)` API. Foreign tabs are reorderable (pin order is per-window state, no underlying thread mutation); drag is disabled while any tab is being inline-renamed. **Slide animation** is a single `pendingFlipsRef` queue consumed by a `useLayoutEffect`: each swap pushes one entry per shifted neighbor with constant `dx = ±(sourceWidth + gap)` (rect-free, immune to a previous swap's still-animating transform leaking into the next read), and on drop we push one entry for the source tab using `fromLeft = ghost.getBoundingClientRect().left` so it slides from the ghost's last position to its final slot — the effect resolves `dx` at apply-time as `fromLeft - newLeft` so it's self-correcting against batched vs. async `tabs` updates. All slides are `transform: translateX(dx) → translateX(0)` over 120ms ease-out. Source tab is hidden via inline `style={{ opacity: 0 }}` during drag (inline beats `opacity-80` and `hover:opacity-100` on non-active tabs which a class would tie or lose to). `dropHandledRef` flag suppresses the post-`drop` `dragend` cleanup so the queued release-FLIP isn't wiped before the next render. Cancellation paths (Esc / off-strip drop) hit the full `clearDragState`, which also wipes any in-flight transforms so a canceled swap doesn't leave a tab visually offset.
- **Conversation tabs** (scrollable, add/remove from tabs while keeping in history).
- **Editable tab labels + minimal tab strip scrollbar** — `ThreadType` gained a `customTitle?: string` override; `IChatThreadService.setThreadCustomTitle(threadId, title)` is the single mutation entry, normalizing whitespace-only input back to `undefined` (storage stays minimal — field disappears when reset) and gated by `_isThreadMutationBlocked` so foreign threads can't be renamed from this window. Tab UI in `SidebarThreadSelector.tsx` enters rename via double-click or right-click → `IContextMenuService` (Rename / Reset to default name / Close tab) — using the platform context menu service avoids any third-party dep and gets native positioning + keyboard nav for free. Inline `<input>` swaps in for the label span when editing; Enter commits, Esc cancels, blur commits, focus auto-selects. The history sidebar (`PastThreadsList`) honors the same `customTitle` cascade so a renamed tab carries the new label into history. Separately, the tab strip's heavy default OS scrollbar (~14–17px on macOS) is hidden via the "padding + negative margin + clip" technique: an outer wrapper has `overflow-hidden` and the inner strip gets `pb-3 -mb-3` so its scrollbar is painted 12px below its effective bottom edge and clipped by the wrapper. Reliable on macOS where Webkit's overlay scrollbar can ignore both `::-webkit-scrollbar { display: none }` and 0-width overrides in recent Electron versions — the earlier CSS-only attempts (`scrollbar-width: none` + display:none on the pseudo-element, even with !important and matching CSS-variable overrides) didn't suppress the macOS overlay reliably. Wheel-to-horizontal scroll handler stays wired; matches VS Code's editor-tab look.
- **Per-conversation model persistence** — switching tabs restores the model previously used in that conversation.
- **Per-thread token tracking** — input / output / reasoning / cached input tokens displayed via `TokenUsageRing` in the sidebar.
- **OpenAI-compatible tool calling defaults** — added `applyProviderToolFormatDefault` so that `openAICompatible` and `openRouter` providers default to `'openai-style'` instead of XML fallback when a user adds an unrecognized model.
- **Per-provider `defaultSpecialToolFormat` refactor** — moved the provider-specific default off `getModelCapabilities` and onto each provider's `VoidStaticProviderInfo` block. Global default is now `'openai-style'`; `anthropic` and `gemini` opt out with their native formats. Eliminates the silent XML-fallback footgun for any unrecognized model on any OAI-compat-speaking provider.
- **Prompt Phase 1 (caching, initial pass)** — reordered `chat_systemMessage` so all volatile content (today's date, `sysInfo`, `fsInfo`) is grouped at the end inside `<volatile_context>`, allowing the stable prefix (persona, rules, tool defs) to be prefix-cached by providers across turns. (Full caching win requires Phase B below.)
- **Override dialog cleanup**:
  - Removed `specialToolFormat` from the placeholder JSON (it's auto-applied now, no need to suggest the user types it).
  - Status line surfaces the auto-picked format ("Defaulting to OpenAI-style tool calling based on the OpenAI-Compatible provider...").
  - "Advanced — see the sourcecode" link is always visible (not gated by override toggle), with concrete examples of overridable fields.
  - Removed special-cased preset buttons for tool format (no field deserves more UI weight than others).
- **`validateURI` relative-path resolution** (`toolsService.ts`) — relative paths like `README.md` or `src/foo.ts` now resolve against the current workspace root via `URI.joinPath`, instead of getting mangled into `file:///README.md` (filesystem root). Scheme-qualified URIs and absolute paths keep their prior behavior. The workspace-aware `validateURI` / `validateOptionalURI` are defined as closures inside the constructor so all 11 call sites stay terse; the module-level raw helpers got renamed to `validateURIWithRoot` / `validateOptionalURIWithRoot` to make the "you must pass a root yourself" contract explicit. Levels the playing field between frontier models (which natively use absolute paths from `fsInfo`) and weaker ones like Gemma (which naturally produce bare filenames), eliminating the pathological `run_command` fallback loop.
- **Gemini `thought: true` part splitting** (`sendLLMMessage.impl.ts`) — replaced the `chunk.text` shortcut with a manual per-part iteration over `chunk.candidates[0].content.parts[]`. Parts with `thought === true` now accumulate into `fullReasoningSoFar` (fed to the existing `ReasoningWrapper` UI); plain text parts accumulate into `fullTextSoFar`. Gemma 4's internal reasoning no longer leaks into the visible answer or gets replayed in stored history every turn. Defensive against chunks without `candidates` (final-usage chunks), empty `parts` arrays, and non-text parts (functionCall / inlineData are skipped).
- **Gemini `cachedContentTokenCount` extraction** (`sendLLMMessage.impl.ts`) — added `cachedInputTokens: usageMetadata.cachedContentTokenCount` to the `latestUsage` block. `TokenUsageRing` now shows cache hits for every Gemini-API model (Gemma 4 26B/31B, Gemini 2.5 Pro/Flash/Flash Lite). Required for measuring whether Phase B moves the needle.
- **`ReasoningWrapper` scrolling containment** (`SidebarChat.tsx`) — added `max-h-60 overflow-y-auto` plus an auto-scroll-to-bottom effect so long chains of thought don't balloon the chat. Streaming reasoning is visible and pinned to the latest token; once reasoning completes, the panel auto-collapses (unchanged prior behavior). User can re-expand to review.
- **Gemini usage metadata per-field merge** (`sendLLMMessage.impl.ts`) — wholesale-replacing `latestUsage` on every chunk caused `cachedInputTokens` to flicker to `undefined` whenever Google's streaming API dropped the field from a later chunk (confirmed live: cache ring showed 15k mid-stream, then emptied on final chunk). Switched to per-field `??` merge so values persist across chunks but never erase. `??` (not `||`) was chosen so a legitimate `0` from Google isn't overwritten by a stale non-zero carry-over. Scope is Gemini only; OpenAI emits usage once at end, Anthropic doesn't populate `latestUsage` at all (separate backlog item).
- **Prompt Phase B (caching-aware layout)** — moved `volatile_context` out of `chat_systemMessage` entirely. Split into two exports: `chat_systemMessage` returns only stable content (persona, rules, tool definitions); `chat_volatileContext` returns the volatile block as a standalone string. `convertToLLMMessageService._generateChatSystemAndVolatile` computes both in one pass (workspace context gathered once). `prepareLLMChatMessages` then prepends the volatile block to the **last user message** in the `llmMessages` array (fresh local copy — persisted chat history and UI state untouched, so users never see `<volatile_context>` in their own bubbles). Dropped the "Here is context that may change between turns:" narration prefix since the XML tag is self-describing and reads oddly inside a user message. Final layout becomes `[stable sys][history][volatile + new user]`, letting Gemini prefix-cache the entire history across turns instead of breaking the cache after the first volatile byte. This is the fix for the "cache disappears on turn 2" pathology observed live.
- **Prompt Phase A3+A4 + code-block scoping (agent-loop framing + re-balance over-iteration + mode-scoped code-block format)** — `prompts.ts` `chat_systemMessage → importantDetails`. Three coordinated changes, empirically validated against the three benchmark tasks on all three models (see "A3 + A4 eval" in evaluation logs section).
  - **Agent block:** new **A3 loop bullet** ("understand → investigate → diagnose → act → verify, use as a self-check") inserted before the existing `ALWAYS use tools` rule, as a self-check shape only — the model is explicitly told not to announce which phase it's in. **A4 replaces** the compounding trio ("maximal certainty BEFORE" + "OFTEN gather context" + "prioritize as many steps as needed over stopping early") with three rebalanced bullets: (1) *enough* context not maximal, stop once the answer is obvious from what's already read; (2) take as many steps as genuinely required — don't pad, don't re-read same-turn, don't run redundant verification; (3) high certainty for hard-to-undo work (rewrites, deletes, terminal state changes, git), act-and-verify for low-stakes (log lines, one-expression tweaks). Safety rules (`ALWAYS use tools`, `NEVER modify outside workspace`) kept unchanged in position.
  - **Gather block** (scope expansion past the original agent-only plan, because gather's `"extensively read ... gathering full context"` framing was actively pulling in the opposite direction from A4): softened to `"read broadly and follow references, but stop once you have enough to answer, don't re-read same-turn"`; added lightweight loop (understand → investigate → form grounded answer — no act/verify since gather can't edit or run). Normal/chat left untouched — A1+A2 already covers its main pathology.
  - **Code-block scoping (variant iii, added after A3+A4 eval surfaced a Gemma regression on Test 2):** the universal `"First line of code block must be FULL PATH + remaining contents of the file should proceed as usual"` rule competed with `ALWAYS use tools` in agent mode. Gemma picked the shorter path (inline `<<<<<<< ORIGINAL / >>>>>>> UPDATED` diff) because the format rule literally *describes* the shape of an edit-via-code-block. Scoped the full format rule to `gather/normal` (where code blocks ARE the edit mechanism); agent mode keeps only the language-tag bullet. Pure removal of confusing signal, no new prohibition added.
  - **Measured deltas** (all three tasks, fresh chats, A3+A4 eval section has raw data):
    - Nemotron T1: 7 calls 167.9k in → 3 calls 86.9k in (**−48% total tokens**). The +90% A1+A2 inflation on capable-but-over-iterating models largely closed.
    - Nemotron T2: 7-call failure + `Response ended unexpectedly` → 4-call success, 165.7k → 96.8k in (**−42%**).
    - MiniMax T1: 4 → 2 calls (**−50%** tool calls, tokens flat — work packed into fewer rounds rather than eliminated; latency + round-trip win even without raw token savings).
    - MiniMax T3 (gather): 3 → 1 calls (**−67% tool calls, −28% tokens**). Gather-mode "read everything" pathology collapsed while answer stayed grounded.
    - Gemma T1: broken (inline diff only, no edit) → broken with A3+A4 alone → **working with (iii)** (2 calls read+edit, still emits inline scratchpad diff but edit happens). Inline diff went from substitute-for-edit → chatter-alongside-edit.
    - Gemma T2: 2 calls working → regressed to 1 call inline-diff-only with A3+A4 alone → **recovered to 4 calls search→read→edit→search with (iii)**. Trailing search is A4 bullet 2 gap (same pattern Nemotron shows).
  - **Accepted residual quirks** (not worth further tuning):
    - Nemotron + Gemma both do a post-edit re-read/search on Test 2. A4 bullet 2 ("don't run redundant verification") only fully lands on strong models (MiniMax). Weaker models have a training-level verify-after-action bias; tightening the rule further would risk suppressing *legitimate* verification (e.g. running a test after a real change).
    - Gemma emits the inline `<<<<<<< ORIGINAL / >>>>>>> UPDATED` block as a scratchpad even when calling `edit_file` correctly. Training bias; a prompt rule strong enough to suppress it would risk the README-freeze failure mode (model unable to write file-contents code blocks at all).
  - Files: `prompts.ts` (`chat_systemMessage` — agent/gather `if` blocks rewritten, universal code-block-format rule split into agent vs gather/normal branches). Net prompt length change: +1 bullet in each of agent and gather blocks, code-block rule unchanged in size but now mode-scoped.
- **Prompt Phase C — Tool selection & usage discipline (C1+C2+C3+C5+C6; C4 deferred)** — `prompts.ts`, target: the Gemma-class terminal-fallback pathology (using `run_command` with `cat`/`ls`/`find`/`grep` instead of dedicated tools). Empirically validated in two stages against the three models (see "C1 Eval" + "C2 + C3 + C5 eval" in evaluation logs section).
  - **Design insight from A1+A2 eval carried forward**: rules that appear in only one place get ignored by smaller models (the no-tables pathology). Phase C applies the same rule in three coordinated surfaces (tool description → `importantDetails` → anti-fallback helper) so small models get the same signal from multiple angles. This turned out to be necessary — C1 alone didn't move Gemma (see below).
  - **C1 — Rewrite `terminalDescHelper`**: the shared helper embedded in `run_command` and `run_persistent_command` descriptions. Was `"You can use this tool to run any command: sed, grep, etc. Do not edit any files with this tool"` — literally encouraged terminal use for search. Now enumerates the dedicated tools and what each replaces (`read_file` not `cat`, `ls_dir`/`get_dir_tree` not `ls`, `search_pathnames_only` not `find`, `search_in_file`/`search_for_files` not `grep`, `edit_file`/`rewrite_file` not `sed`/`echo >`), and lists what `run_command` IS for (`npm install`, `git status`, `pytest`, builds, etc.). Keeps the `git diff → cat` editor-trap note.
  - **C2 — Decision-rule framing on 5 context-gathering tools**: rewrote `read_file`, `ls_dir`, `search_pathnames_only`, `search_for_files`, `search_in_file` descriptions from capability-only (`"Returns full contents of a given file"`) to the `"Use this to [purpose]. [Context / disambiguation from sibling tool]. Never use \`run_command\` with \`X\` — this tool is the correct choice."` pattern. Each description tells a small model (a) when to pick it, (b) when a different dedicated tool would be better, and (c) that the terminal is NOT an acceptable substitute. `get_dir_tree` was already in decision-rule shape; left untouched.
  - **C3 — Concrete param examples**: replaced `uriParam`'s `"The FULL path to the ${object}."` with `"Path to the ${object}. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`)."` Small models don't reliably parse what "FULL" means; examples land where prose doesn't. Same treatment for `ls_dir.uri` (workspace-root framing) and `search_pathnames_only.include_pattern` (`\`*.ts\``, `\`src/**\`` examples). Preserved the `start_line`/`end_line` "do NOT fill in unless specifically given" guardrail — known load-bearing (Gemma hallucinates line numbers without it).
  - **C5 — Tool-selection rule in agent `importantDetails`**: new bullet after `ALWAYS use tools`, giving the full 11-pair mapping of intent → correct tool (same list as C1's helper text, but in the rules surface rather than the tool-description surface). Deliberate redundancy with C1 and C2 — the whole point of Phase C.
  - **C6 — Parallel-reads concrete example** (scope expansion, added after C1+C2+C3+C5 eval surfaced Gemma and Nemotron doing serial reads where MiniMax batched): extended the existing parallel-tool-calling rule (from Perf 4) with `"Concrete example: when a search or list returns multiple files you want to inspect, read ALL of them in ONE turn (one assistant message with multiple \`read_file\` tool calls) — NOT one per turn. Per-turn reads compound input tokens for every subsequent call."` Gemma batches cleanly when told to explicitly (Perf 4 eval), but defaults to serial when the task doesn't mention it — the C6 example makes the post-search-multi-read case explicit.
  - **Measured deltas** (two-stage eval, fresh chats, same "find .ts files under browser/" and "where is chat_systemMessage used" prompts each time):
    - **Test 1 (find .ts files)**: Gemma **`find` terminal → `ls_dir`** after C2+C3+C5 (C1-alone was insufficient — key data point). Gemma output tokens also −53% (693 → 327) because structured tool output replaces prose-reformatting of raw terminal text. Nemotron went from 2-call ls_dir+terminal to 1-call ls_dir after C1 alone (−39% total tokens). MiniMax held throughout.
    - **Test 2 (find usages of chat_systemMessage)**: Gemma **`grep -r` terminal → `search_for_files`** after C2+C3+C5 (101.2k → 74.6k in, **−26%**; output −69%). Nemotron dropped the trailing redundant `search again` (4 calls → 3, 96.2k → 71.5k, **−26%**). MiniMax moved from serial to parallel reads post-C (3 calls → 2 with batched reads, 70.2k → 47.4k, **−32%**) — C2's tighter tool descriptions incidentally helped MiniMax's batching decision.
  - **C4 deliberately deferred**: WARNING framing on `rewrite_file` / `delete_file_or_folder` was drafted but not applied. Rationale: the write-tool silent-failure fix earlier in this session (toolsService `fileService.exists` check) handles the missing-file case, and we haven't observed `rewrite_file` misuse on *existing* files since A3+A4 shipped. Adding preventive hardening for a pathology we haven't seen dilutes attention across the prompt without a confirmed win. Re-open if `rewrite_file` misuse surfaces in daily use post-fork-switch — the drafts are preserved in the eval-section commit for quick reintroduction.
  - **Accepted residual quirk**: C6 (parallel-reads example) **did not move Gemma or Nemotron on natural prompts** (tested post-ship). Both models still read serially after a search unless the user prompt explicitly says "in parallel" (Perf 4 pattern). Conclusion: post-search parallel-batching is a model-capability issue, not a prompt-words issue — adding further instructions is unlikely to help. Left the C6 bullet in place (harmless, ~1 sentence, may help on future stronger models) but stopped iterating.
  - Files: `prompts.ts` — one helper const (`terminalDescHelper`), five tool descriptions, two param descriptions (`uriParam` helper + one inline), one new bullet in agent `importantDetails`, one extension to the existing parallel-tool rule. ~15 line-level edits. No other files touched, fully revertable.
- **Phase E1 — `go_to_definition` / `go_to_usages` LSP tools** — two new read-only builtin tools that bridge monaco's `getDefinitionsAtPosition` / `getReferencesAtPosition` into the agent's tool call surface. Target: stop weaker models from "fishing with grep" (3–5 `search_in_file` calls to locate where a named symbol is defined or used) and give the agent precise LSP semantics that handle aliased imports, re-exports, and overloaded references correctly in one call.
  - **Wiring**: new entries in `BuiltinToolCallParams` / `BuiltinToolResultType` (`toolsServiceTypes.ts`); full validator/body/stringifier triple in `toolsService.ts` with `ILanguageFeaturesService` captured in the constructor; title + description + `resultWrapper` entries in `SidebarChat.tsx` — clicking a result row opens the file at the target range. Pagination shared with `search_for_files` (`MAX_CHILDREN_URIs_PAGE`). Pre-initializes target models in the body so the stringifier can sync-read preview lines per location.
  - **`line` is optional, not required** (this was an iteration during the session — initial strict-line version shipped first, then relaxed after the first eval showed Gemma hallucinating `line=1`). Resolution strategy: if `line` is given AND in-range AND the symbol is on that line (word-boundary match), use it; else fall back to scanning the file for the first whole-word occurrence. Errors only when the symbol doesn't appear anywhere in the file. Uses `\b${escaped}\b` instead of `lineContent.indexOf(symbolName)` to prevent `foo` matching inside `fooBar` (seen with `validateNumber` inside `validateNumberAbs` style substrings). Two helpers at module scope: `findFirstSymbolOccurrence` and `resolveSymbolPosition` (wrapper that tries the hint, falls back to scan).
  - **Error-path UX**: if no LSP definition/reference provider is registered for the file's language (e.g. `.md`, random config files), body throws an actionable error message naming the fallback tool — `"No LSP definition provider is registered for markdown files. Use search_in_file or search_for_files with \`X\` as the query instead."` — so the agent recovers cleanly in one turn instead of stalling.
  - **Auto-gen parallel-tool list** (small Phase C follow-on while editing the prompt anyway): replaced the hand-enumerated "example with `read_file`" in the C6 bullet with a list computed at prompt-build time — `builtinToolNames.filter(n => approvalTypeOfBuiltinToolName[n] === undefined)` enumerates everything that isn't `edits` / `delete` / `terminal` / `MCP tools`. Single source of truth: absence from the approval map already means "no approval needed, i.e. read-only", so new read-only tools show up in the parallel guidance automatically. ~20 extra tokens per request vs. the prior vague wording, future-proof.
  - **Prompt push (three surfaces, same Phase C multi-surface pattern)**:
    1. Tool descriptions: enumerate the scenarios where LSP wins ("answer a question, inspect a function before calling it, follow an import to its real source, resolve what a re-export actually points to"), name the alternative tools that are noisier, and call out the no-LSP fallback.
    2. `line` param description explicitly recommends passing it when known and marks it REQUIRED for disambiguation (shadowing, overloads, re-assignment), while documenting when omit-is-safe (distinctive names only; risky for `i`, `x`, `result`, `run`).
    3. New C5 `importantDetails` bullet — task-centric not user-centric (learned during session that "when the user asks" framing was too narrow; agent-initiated navigation is the more common case): *"To locate a NAMED function / class / variable / type — whether to inspect its definition or find all its usages — always use `go_to_definition` / `go_to_usages`; use `search_in_file` / `search_for_files` only for free-text or conceptual queries (…'find TODOs', 'any references to auth cookies') where there is no specific identifier to resolve."* Plus redirect sentence appended to `search_in_file` and `search_for_files` descriptions: *"For locating where a NAMED … is defined or used, use `go_to_definition` / `go_to_usages` instead — LSP is precise where text search is noisy."*
  - **Measured deltas** (natural-prompt test: *"Where is `validateNumber` defined? It's used inside `src/vs/workbench/contrib/void/browser/toolsService.ts`."* — no explicit "use go_to_definition" hint, same prompt across all three models):
    - **MiniMax**: 1 LSP call, 3 steps total (reasoning → `go_to_definition` with `line` omitted → answer). Fallback scan resolved the position; agent picked up the tool description cleanly. **Ideal flow.**
    - **Gemma**: 0 LSP calls, 3 steps total (reasoning → `read_file` → answer). Ignored the LSP tools entirely, read the file and eyeball-located the definition. Not broken, just not improved.
    - **Nemotron**: 0 LSP calls, 5+ steps, 4 tool calls (`read_file` → `search_for_files` → `search_in_file` → `read_file` ranged). Worst case — went full grep-party, never reached for LSP.
  - **Accepted residual quirk** (same capability ceiling as C6): prescriptive tool-selection rules move strong models (MiniMax) but do **not** move Gemma or Nemotron on natural prompts, even with three coordinated prompt surfaces pushing toward the tool. Conclusion: this is a base-model capability issue (tool-selection is one of the hardest things smaller models do — pretraining bias toward `grep`/search dominates), not a prompt-words issue. Further prompt weight would have diminishing returns and risks over-correction (agent calling `go_to_definition` for free-text queries like "find TODOs" where there's no identifier to resolve). Stopped iterating. Net effect is still a clear win: MiniMax users get 1-call LSP flows where they previously had 4-call grep flows; Gemma / Nemotron users get the tool as an **escape hatch** when they explicitly mention it in prompts (no regression, baseline unchanged). Tool is genuinely useful for re-export chains, overloaded declarations, and aliased imports — cases where lexical search is wrong, not just noisier.
  - **Design decisions and rejections during session**:
    - Rejected making `line` required with a "suggested line" error message (would still cost a round-trip per hallucination; silent fallback strictly better UX).
    - Rejected adding few-shot examples of `go_to_definition` calls in the prompt (models over-fit to example symbol names, prompt bloat).
    - Rejected auto-routing `search_in_file` calls for exact symbol names to LSP internally (violates agent control, hides behavior, fragile).
    - Rejected adding an explicit `kind: 'read' | 'edit' | 'terminal'` field on `InternalToolInfo` in favor of reusing `approvalTypeOfBuiltinToolName` for read-only inference (no duplication, no drift risk).
    - Skipped `go_to_implementation` and `go_to_type_definition` for now — revisit if daily use surfaces need. `includeDeclaration: true` hardcoded for `go_to_usages` (matches VS Code `Shift+F12` default), no param.
  - Files: `toolsServiceTypes.ts` (2 type entries), `toolsService.ts` (2 validators + 2 bodies + 2 stringifiers + `ILanguageFeaturesService` injection + 2 helper funcs + 1 import line), `prompts.ts` (2 tool definitions, 1 C5 bullet rewrite, 2 description redirects, 1 auto-gen parallel list), `SidebarChat.tsx` (2 title entries, 2 desc entries, 2 resultWrapper renderers). One commit, ~300 lines of diff, ~150 of which are the new React tool-renderers.
- **Prompt Phase A1+A2 (Option 1: persona shift + anti-hedging)** — `prompts.ts` `chat_systemMessage`: header reframed from "expert coding agent" to "senior software engineer working as the user's pair-programmer" with explicit end-to-end ownership clause; three new directives near top of `importantDetails` apply across all modes: (1) commit to one solution / don't list alternatives unless trade-offs are non-obvious, (2) act don't describe, (3) brief completion summary, no padded "let me know if you'd like me to..." offers. Empirically validated against 3 models (Nemotron, Gemma 4 26B, MiniMax 2.5) on benchmark Tasks 0/3/5 — see "Prompt evaluation logs" section. Headline wins: Nemotron Task 0 trail-off eliminated; Gemma 4 search-loop on Task 5 dropped from 5+ self-doubting iterations to 2 clean reads (−27% total chat tokens). Headline cost: capable models (Nemotron, MiniMax) read the persona shift as license to be more thorough → +18% to +90% token totals on those models. Net positive (correctness held; stylistic wins real), kept as new baseline. Token-volume side-effect motivates A4 (re-balance over-iteration rules) as the immediate next prompt step.
- **Perf 4 — Parallel tool calls per turn (end-to-end)** ✅ DONE. Root cause: `sendLLMMessage.impl.ts` had hardcoded `if (index !== 0) continue` on the OAI-compat tool_calls aggregator, `tools[0]` on the Anthropic path, and `functionCalls[0]` on the Gemini path — silently dropping every tool after the first when a model emitted a batch. Downstream types and the agent loop all assumed a single tool per assistant turn, so fixing the aggregators alone wasn't enough: the full pipeline had to be arrayified. Scope of the change: (1) `OnText` + `OnFinalMessage` now carry `toolCalls?: RawToolCallObj[]` instead of `toolCall?: RawToolCallObj`. (2) All three provider paths rewritten to aggregate tools by index/id into a `Map<index, {name, argsStr, id}>` (OAI-compat, Anthropic) or a deduped append-list (Gemini), with `onText` streaming the in-progress array and `onFinalMessage` emitting the parsed final array. (3) `streamState.toolCallsSoFar` became an array; the agent loop pre-adds every tool in the batch to the thread as a `tool_request` with `batchIndex`/`batchSize` (UI numbering metadata), then serially drains via `_tryDrainPendingBatch`. Approval / reject pause between tools — `approveLatestToolRequest` advances to the first pending row; `rejectLatestToolRequest` gained a `resumeAgent: boolean` flag: the reject button marks ALL pending tools in the batch as rejected and resumes the loop so the model can react, while `abortRunning` uses `resumeAgent: false` to terminate cleanly. (4) `convertToLLMMessageService.ts` was still assuming one-tool-per-assistant on replay — fixed: OpenAI path appends to the assistant's `tool_calls` instead of overwriting; Anthropic path appends `tool_use` blocks walking back to the assistant (not just `prevMsg`); Gemini path tracks tool names by id (`Map<id, name>`) so `functionResponse.name` always matches the paired `functionCall.name` (the previous single-variable approach mislabeled all but the last tool in a batch); XML fallback concatenates all consecutive tool messages, not just `next`. (5) UI: `SidebarChat.tsx` `getTitle` prefixes `(i/N)` for batched tools; `ChatBubble` takes `firstPendingToolRequestIdx` so only the earliest pending tool_request in the trailing batch shows approve/reject buttons — the rest render as stacked progress rows. (6) Prompt: replaced `Only use ONE tool call at a time.` in `chat_systemMessage` with an explicit invitation to batch independent operations ("You can call multiple tools in a single turn when the operations are independent... use separate turns when a later tool's arguments depend on an earlier tool's result"). XML-fallback path keeps its one-tool rule — grammar extraction only parses one tag at a time, the constraint is technical. (7) Telemetry: `captureLLMEvent` now emits `toolCallCount` and comma-joined `toolCallNames` instead of a single `toolCallName`. Empirically validated across 3 models on the "read prompts.ts, sendLLMMessage.impl.ts, and chatThreadService.ts in parallel" prompt: **Gemma 4 batches cleanly** (3-tool `search_pathnames_only` → 3-tool `read_file`, 2 round-trips total); **MiniMax 2.5 partially batches** (one mixed search+read batch in turn 1, clean 2-tool read batch in turn 2); **Nemotron never batches** — 8+ solo tool calls on the same task, confirming it's a small-model capability ceiling rather than a prompt issue. The UI's `(i/N)` prefix + stacked progress rows + single-active-approve-button all render correctly across all three models. Files touched: `sendLLMMessageTypes.ts`, `sendLLMMessage.impl.ts`, `sendLLMMessage.ts`, `extractGrammar.ts`, `chatThreadServiceTypes.ts`, `chatThreadService.ts`, `convertToLLMMessageService.ts`, `SidebarChat.tsx`, `prompts.ts`.

### Next — Performance & billing-honesty (promoted from backlog)

Driven by long-session observations above. These hit before the prompt phases because they're what's actually painful day-to-day.

**Perf 1 — Renderer perf for long chats** ✅ DONE (Fix B + C + A + F + G shipped; Fix D + E deferred)

Root cause identified by Chrome DevTools profiling over two rounds: the dominant cost of tab-switching long chats was **Monaco editor lifecycle churn AND forced full-subtree remount**, not React memoization. Every fenced code block and tool-result block mounts a full `CodeEditorWidget` (scrollbars, sashes, hover providers, TextMate tokenizer worker, autorun observers), and threads with many tool results (`run_command`, `read_file`, `grep`, etc.) mount dozens per thread. On top of that, `<Fragment key={threadId}>` wrapping the entire `SidebarChat` return forced a full React unmount/remount of every bubble on every tab switch — which meant Fix B's "remove the `ScrollToBottomContainer` key" had little effect in isolation, because the outer key was still nuking the tree. Fix G below closes that loop.

Fixes shipped:

*Fix B — remove the `key` forcing remount.* Removed `key={'messages' + currentThreadId}` from `ScrollToBottomContainer` in `SidebarChat.tsx` so React reconciles message instances in place instead of unmount/remount. Added an explicit `useEffect(() => scrollToBottom(...), [threadId, scrollContainerRef])` so the "land at bottom on tab switch" UX still fires even though the mount-time effect inside `ScrollToBottomContainer` no longer re-runs on switch. Files: `SidebarChat.tsx`. Small on its own because the real cost was Monaco disposables, not reconciliation.

*Fix C — lazy-mount Monaco per block.* Added `LazyBlockCode` in `util/inputs.tsx`: an `IntersectionObserver`-gated wrapper (500px rootMargin) that renders a plain `<pre><code>` placeholder with the same outer container styling until the block scrolls near the viewport, then upgrades monotonically to the real `BlockCode` (the expensive work is the mount, not the continued existence). Swapped all chat call-sites: both `BlockCode` usages in `ChatMarkdownRender.tsx` (with and without `BlockCodeApplyWrapper`) and the terminal tool-result `BlockCode` in `SidebarChat.tsx`. Gated the underlying `BlockCode` by removing its `export` so only `LazyBlockCode` can reach it — prevents accidentally reintroducing the regression from a future call-site.

*Fix A — module-level `marked.lexer` cache.* In `ChatMarkdownRender.tsx`, replaced per-render `marked.lexer(string)` with a module-scoped `Map<string, Token[]>` keyed on the post-`replaceAll('\n•', '\n\n•')` string. LRU-ish eviction at 500 entries using JS Map insertion order (refreshed on hit). Cache survives component unmount/remount. Smaller than hoped in practice because lex wasn't actually a top-10 hot function — the dominant cost after Fix C is React element creation + diffing, not lexing — but it's correct, zero-risk, and a small positive.

*Fix F — `startTransition` on tab clicks.* Wrapped `chatThreadsService.switchToThread(id)` and `chatThreadsService.openNewThread()` calls in `SidebarThreadSelector.tsx` (three call sites) with `React.startTransition`. Marks the resulting state update as low-priority/interruptible: the click + tab-highlight commit paint immediately while React renders the new thread in the background and yields between chunks. Reshapes the cost (no "dead zone" feel during render), doesn't reduce total work. User feedback after this alone: "improves a little" — confirming transition was working but the 200 ms real-work cost was still the main pain, motivating Fix G.

*Fix G — LRU parallel thread cache + drop the outer `Fragment key={threadId}`.* The real win for tab switching. Root cause found after profiling + code audit: `<Fragment key={threadId}>` wrapping the entire `SidebarChat` return was force-remounting every `ChatBubble` on every switch, re-running all Monaco mounts + markdown lexes + React reconciliation — so Fix B's container-level key removal was mostly a no-op. Can't just remove the outer key though: several `ChatBubble` internal `useState`s (file-details open, tool-row expand, edit-mode state) would then leak across threads because bubbles are keyed by index. Solution: extract `ThreadMessagesView` (per-thread messages + streaming + error UI) and render one instance per cached thread id in parallel inside `SidebarChat`, stacked with `position: absolute inset-0` and hidden via `hidden=true` for non-active threads. Each cached thread owns its own `ScrollToBottomContainer`, its own scroll-ref, and its own `useChatThreadsStreamState` subscription, so per-thread state is isolated *by construction* — no need for the big-hammer outer key. LRU cap of 5 (oldest evicted) keeps memory bounded, and `display: none` causes `IntersectionObserver` to report not-intersecting for `LazyBlockCode` in hidden threads, so Monaco editors don't mount for off-screen threads. Added an explicit `useEffect(() => setInstructionsAreEmpty(true), [currentThread.id])` to preserve the submit-button reset that the outer key used to provide side-effectively. Files: `SidebarChat.tsx` (new `ThreadMessagesView` component + LRU state + per-thread scroll-ref map + parallel render). Known edge case: switching *through* landing page (empty thread) temporarily unmounts cached views since `landingPageContent` doesn't render the parallel block — returning to a cached thread after that pays the first-visit cost again. Acceptable.

Landing state (verified by two Chrome DevTools profiles, same 20s tab-switch workload on threads of ~80k and ~50k tokens, pre-Fix F/G):
- `trackDisposable` self: **758 ms → 2.3 ms** (−99.7%)
- `Event: pointerover` total: 7.08 s → 1.81 s (−74%)
- `Recalculate style` self: 1.21 s → 774 ms (−36%)
- `Layerize` self: 784 ms → 198 ms (−75%)
- JS heap peak: 345 MB → 220–231 MB (−33%)
- INP per tab-switch click: 1,503 ms → ~1,000 ms

After Fix F+G (measured by user perception, not re-profiled): tab switches between two cached (recently-visited) threads are now effectively instantaneous — only the `hidden` attribute flips, no React reconciliation, no layout, no Monaco churn. First visit to a cold thread still pays the one-time mount cost (~200 ms), after which it stays cheap. User feedback post-commit: **"performance is good"**, no further Perf 1 work requested.

Deferred fixes (still not shipped; re-open only if symptoms return):

*Fix D — `React.memo` on `ChatBubble`.* Would help streaming (the streaming bubble updates many times per second while other bubbles are identical), but would **not** help tab switching (`chatMessage` prop reference changes for every bubble on switch). Re-open if streaming jank becomes the dominant complaint.

*Fix E — virtualize the message list (`react-virtuoso`).* After Fix G the cache absorbs the tab-switch cost entirely for recent threads, and the first-visit cost is bounded per thread — so virtualization is no longer on the critical path. Re-open only if threads grow past ~200 turns and first-visit + scroll performance degrades, or if the user reports jank we can't trace to anything else.

~~**Quality 1 — Surface `finish_reason` on OpenAI-compatible streams**~~ ✅ DONE (shipped alongside Perf 4 plumbing). `_sendOpenAICompatibleChat` now tracks the last non-empty `finish_reason` seen during the stream and forwards it through `onFinalMessage` as `finishReason?: string`. Clean completions (`stop` / `tool_calls` / `function_call`) render silently; anything else (primarily `length` from MiniMax clipping against `max_tokens`, also `content_filter` or gateway-specific values) surfaces a visible warning on the assistant message so the user knows the response was truncated instead of seeing a spinner stop mid-sentence. Scope is OAI-compat only — Anthropic and Gemini paths leave the field undefined, which renders as "no warning" (same as before). Files: `sendLLMMessageTypes.ts`, `sendLLMMessage.impl.ts`, `chatThreadService.ts`, `SidebarChat.tsx`. Not yet tested live on a genuinely-truncated MiniMax response — user notes it's hard to force truncation on-demand; assumed-working until a real case surfaces.

**Perf 2 — History compaction / summarization** (Light tier ✅ DONE; Heavy tier deferred)
- Addressed the 160k cache cliff and quadratic billing in long agent threads by trimming the *bodies* of stale data-fetching tool results (keeping envelopes intact so `tool_call_id` linking stays valid on replay).
- Shipped (Light tier):
  - New `compactToolResultsForRequest` helper in `convertToLLMMessageService.ts`, called from `prepareLLMChatMessages` right after `_chatMessagesToSimpleMessages` and before provider-specific conversion. All policy constants live in the `COMPACTION_POLICY` object at module scope — no inline magic numbers in the logic.
  - Trim whitelist: `read_file`, `ls_dir`, `get_dir_tree`, `search_pathnames_only`, `search_for_files`, `search_in_file`, `read_lint_errors`, `run_command`, `run_persistent_command`. Write-side tools (`edit_file` / `rewrite_file` / `create_file_or_folder` / `delete_file_or_folder`) and MCP tools are NEVER trimmed.
  - **Two-gate trigger design:**
    - *Gate 0 — Size*: compaction only fires once `totalChars ≥ contextWindow * CHARS_PER_TOKEN * sizeTriggerRatio` (default 0.5). Keeps the prefix cache pristine on short threads where trimming would break cache for no real savings; kicks in before MiniMax's 160k cache cliff on larger windows.
    - *Gate 1 — Structural protection boundary*: larger of two policies wins.
      - `protectRecentTurns = 5` (last 5 user-message boundaries + everything after them).
      - `protectLastMessages = 30` (last 30 entries regardless of role). **Critical** for single-user agent-mode threads where the user-turn policy alone would resolve to "protect nothing" and silently skip compaction. This was the bug diagnosed from the MiniMax RAG session screenshot (116k-token request, 97.7% cache hit, zero compaction firing despite the target scenario).
  - Size gates for per-message eligibility: only trim bodies ≥60 lines OR ≥2000 chars (small reads pass through untouched — the marker itself costs tokens).
  - Trim shape: `[trimmed — <tool> <uri/pattern/command>, originally N lines / M chars. Re-run the tool if you need the full content.]` + first 30 lines + `... (content trimmed) ...` + last 10 lines. Preserves first/last context for model orientation without carrying the middle.
  - Prompt hint added to agent/gather `importantDetails`: "Older tool results in this conversation may appear with their bodies replaced by a short marker beginning with `[trimmed — ...]`. This is normal … re-run the appropriate tool; do not assume or fabricate what the trimmed content contained." Teaches the model the marker semantics and the remedy in one line.
  - Non-destructive: compaction operates on the in-memory `SimpleLLMMessage[]` copy only; the on-disk `ChatMessage[]` and the UI always show full original content. Users can expand any tool result in the sidebar to see what was actually read.
  - Dev diagnostics: per-request `console.log` reports trim count, bytes/tokens saved, and the boundary index used — so the user can see the policy firing and understand which gate triggered when tuning.
  - **User-visible compaction telemetry** (added after Light tier shipped): `compactToolResultsForRequest` now returns a `CompactionInfo { trimmedCount, savedChars, savedTokens }` alongside the trimmed messages. `chatThreadService` records it per-request via `_recordCompaction`, maintained as three parallel counters matching the token-usage pattern: `latestCompactionOfThreadId` (last request), `cumulativeCompactionThisTurnOfThreadId` (resets on each new user message, via `_resetCumulativeThisTurn`), and `cumulativeCompactionThisThreadOfThreadId` (persisted on `ThreadType` so it survives reloads). Surfaced in the `TokenUsageRing` tooltip as a "History compaction" section (last request / this turn / this thread), shown only when the thread has ever been compacted to keep the tooltip compact on short threads. Files: `chatThreadServiceTypes.ts`, `convertToLLMMessageService.ts`, `chatThreadService.ts`, `services.tsx`, `SidebarChat.tsx`.
  - **Token-based triggers + chars/token calibration (replaces hardcoded 4:1 ratio)** — two-part change that (a) makes overflow / size decisions reason in tokens directly using the provider's real numbers, and (b) calibrates the chars↔tokens conversion for the cases that genuinely need it. Old code expressed every decision as a chars inequality with a hardcoded `/ 4` estimator baked in. New design:
    - **`ConvertToLLMMessageService` state**: per-model `charsPerToken` ratio, updated via EMA (`emaAlpha=0.3`, clamp `[2, 8]`) from the provider-reported `usage.inputTokens` every time an LLM request resolves. Converges on the real tokenizer within ~3 turns. Fallback 4 on first request. In-memory only (YAGNI-deferred persistence).
    - **`priorContentTokens` pass-through**: `chatThreadService._runChatAgent` reads the thread's `latestUsage.inputTokens + latestUsage.outputTokens` and passes the sum into `prepareLLMChatMessages → compactToolResultsForRequest / prepareOpenAIOrAnthropicMessages`. The sum is the exact token count of the conversation at the moment the last request completed: `inputTokens` = what the last request sent, `outputTokens` = the assistant reply that was generated and is now in history. Every one of those tokens is also in THIS request's input (history is append-only within a turn) — so the sum is a tight, exact lower bound on current-request input tokens. The only thing still estimated is the delta (new tool results, new user message), handled by the chars/ratio floor inside `Math.max`.
    - **Two-stage decision shape** used by both the Perf 2 compaction size gate and the emergency trim:
      1. "Do we need to trim?" → answered in **tokens**, as `estimatedTokens = max(priorContentTokens ?? 0, totalChars / calibratedRatio)` vs. a token threshold (`contextWindow * sizeTriggerRatio` for the compaction gate; `contextWindow - reservedOut` for the emergency trim). `max` is the safe compromise — `priorContentTokens` wins in the common case (exact tokenizer count for the bulk of the content); chars/ratio wins when a big new message is glued in; on a model switch, larger-of-two is the safer (over-trim, not under-trim) side.
      2. "How many chars to cut?" → answered in chars (unavoidable: the trim loop operates on strings). Converted from the token overflow via the calibrated ratio, floored at 5_000 chars to guard against pathological budgets.
    - **Why not go fully token-based?** The trim LOOP cuts strings character by character (`content.slice(...)`, `content.substring(..., 120)`), and there's no cheap way to cut by token count without running a tokenizer in-process on every message. So the decision is tokens (accurate) and the action is chars with a calibrated conversion (good-enough proxy).
    - **`CompactionInfo.savedTokens`** is now computed *at compaction time* using the calibrated ratio and stored on the info object, instead of dividing `savedChars / 4` at render time. Summed counters (`cumulativeCompactionThisTurn/Thread`) preserve per-request accuracy — each request's `savedTokens` used the ratio current at that moment; summing doesn't smear everything with today's ratio.
  - Diagnostic `console.log` on every calibration update reports observed vs. clamped vs. running-EMA ratios so the user can watch it converge. Files: `convertToLLMMessageService.ts` (state + `recordTokenUsageCalibration` + `CALIBRATION_POLICY` + `priorContentTokens` plumbing + token-based trigger rewrites), `chatThreadService.ts` (feeds `usage.inputTokens` back from `onFinalMessage`; pulls `latestUsage.inputTokens + latestUsage.outputTokens` forward into the next request as `priorContentTokens`; captures `sentChars` per request), `chatThreadServiceTypes.ts` (`savedTokens` field on `CompactionInfo`), `SidebarChat.tsx` (reads pre-computed `savedTokens` directly).
  - **Emergency-trim visibility (Option B)**: the destructive truncation inside `prepareOpenAIOrAnthropicMessages` (last-resort path that chops the heaviest-weight message to 120 chars when a request would otherwise overflow the context window) now reports what it did. `prepareOpenAIOrAnthropicMessages` counts `emergencyTrimmedCount / emergencySavedChars / emergencySavedTokens` inside its trim loop and returns an `emergencyInfo` alongside `messages / separateSystemMessage`; `prepareLLMChatMessages` merges it into the returned `CompactionInfo` (totals are summed with the Light-tier info; emergency-specific fields are kept on the side as optional props so persisted pre-breakdown threads hydrate cleanly). `_addCompaction` in `chatThreadService` sums the emergency sub-fields when rolling up per-turn / per-thread counters, omitting them when both sides are zero to keep the shape identical to pure-Light tallies. The `TokenUsageRing` tooltip's `formatCompactionBlock` now returns 1–2 lines: the total first, and — only when emergency fired — a second indented `↳ emergency trim: N messages, saved ~X tokens` sub-line. This makes Perf 2's one failure mode (sizeTriggerRatio too loose for a given model → emergency fires as a safety net) visible in-product, not just in dev console. Files: `chatThreadServiceTypes.ts` (`emergencyTrimmedCount` / `emergencySavedChars` / `emergencySavedTokens` optionals on `CompactionInfo`), `convertToLLMMessageService.ts` (loop instrumentation + return-type updates), `chatThreadService.ts` (`_addCompaction` sum), `SidebarChat.tsx` (two-line render + `indent()` helper).
  - **Bugfixes observed on first real use**:
    - **`saved ~- tokens` for legacy threads**: `savedTokens` is a newer field; threads whose `cumulativeCompactionThisThread` was persisted before the field existed hydrate with `savedTokens: undefined` → rendered as `-`. Fixed client-side in `formatCompactionBlock` via an `approxTokens(savedTokens, savedChars)` fallback that divides `savedChars / 4` when the field is absent. Cheaper than a migration pass and handles any future edge cases too.
    - **`Cumulative this turn: -` after window restart**: the per-turn cumulative counter is an in-memory map that resets on each new user message (by design — it's tied to the current turn, which is a session-level concept). After a restart with no new message yet, it's undefined while `latestUsage` (persisted) still has data, so the tooltip showed a bare dash. Fixed at the render site with `effectiveThisTurn = cumulativeThisTurn ?? usage` — "the current turn accumulated at least as much as the last known request". Same fallback applied to `cumulativeCompactionThisTurn`. Not persisting the counter itself because the reset boundary ("new user message") is the part that would be hard to get right across restarts, and the fallback is already honest.
- Deferred (Heavy tier — LLM-generated structural summarization): not built. Tradeoffs were summary hallucination risk, extra LLM cost per compaction, cache-breaking at an unpredictable point, and hard-to-debug "why did the model forget X?" failures. Defer indefinitely unless Light tier proves insufficient in daily use.
- Also deferred: manual "compact now" button, user-facing policy knobs, provider-specific cliff overrides (e.g. lower `sizeTriggerRatio` for MiniMax/OpenRouter). Revisit if the static policy shows gaps.
- Files: `convertToLLMMessageService.ts`, `prompts.ts`.

**Perf 3 — Truth-in-billing in `TokenUsageRing`** ✅ DONE
- Status: shipped. Tooltip now shows three blocks — last request, cumulative this turn (reset on every new user message), cumulative this thread (persisted across reloads alongside `latestUsage`).
- Implementation note: needed *more* state than originally guessed. The transcript-stored `LLMUsage` was a single `latestUsage` slot per thread, overwritten on each request — no per-message accumulation. Added two new in-memory maps on `chatThreadService` (`cumulativeUsageThisTurnOfThreadId`, `cumulativeUsageThisThreadOfThreadId`) plus two private "baseline" maps that hold the locked-in cumulative from prior finalized requests in the loop. `_setLatestUsage` recomputes cumulative as `baseline + currentRequestRunningTotal` (so streaming-time updates don't double-count), and `_lockInCurrentRequestUsage` (called from `onFinalMessage`) rolls the per-request total into the baseline. New `useChatThreadCumulativeUsage(threadId)` hook in `services.tsx` mirrors both maps to React.
- Files: `chatThreadService.ts`, `chatThreadServiceTypes.ts` (added `cumulativeUsageThisThread?` to `ThreadType`), `services.tsx` (hook + listener mirroring), `SidebarChat.tsx` (`TokenUsageRing` props + `formatUsageBlock` helper).
- Known gap: aborted/errored requests aren't locked into the baseline (latestUsage stays at the partial, but next successful request will overwrite without summing). Acceptable for v1 since the partial is still visible in "last request" and the "this thread" total still reflects everything that succeeded. Can refine if it matters in practice.

~~**Perf 4 — Encourage parallel tool calls per turn**~~ ✅ DONE (see entry in Done above). Shipped end-to-end: aggregator fix in all three provider paths, arrayified types + agent loop, message-conversion replay fix, UI `(i/N)` prefix + stacked progress rows, prompt updated to encourage batching independent ops. Validated empirically — Gemma batches cleanly, MiniMax partially batches, Nemotron doesn't (model capability ceiling, not prompt).

**Write-tool silent-failure fix — `rewrite_file` / `edit_file` on missing files** ✅ DONE
- Root cause: `voidModelService.initializeModel` wraps `createModelReference` in a `try { … } catch (e) { console.log(…) }`, so `FileNotFound` (and every other error) silently resolves. Downstream `editCodeService.instantlyRewriteFile` / `instantlyApplySearchReplaceBlocks` call `_startStreamingDiffZone`, which does `if (!model) return` — another silent return. The tool handler then resolves `lintErrorsPromise` with no errors and `stringOfResult.rewrite_file` reports `Change successfully made to <path>`. **Nothing hits disk.** Surfaced as "MiniMax says it wrote the RAG files but the workspace is empty" — multiple agent iterations lost to the model thinking earlier writes succeeded and moving on.
- Why not fix the root (`initializeModel`): the silent catch is shared by 6 call sites across `toolsService`, `convertToLLMMessageWorkbenchContrib`, `editCodeServiceInterface`, `voidCommandBarService`, `editCodeService`, and the service itself. Some of those (diff-preview, command-bar) may legitimately rely on non-throw semantics when a file isn't yet resolved. Tighter + safer to fix at the tool boundary where the semantics are clear-cut.
- Fix: add `fileService.exists(uri)` check at the top of each write tool, with path-specific recovery:
  - `rewrite_file` on missing file → `fileService.createFile(uri)` first, then proceed. Natural extension of the tool's semantics ("produce a file with these contents"); aligns with how most agents instinctively use it as one-shot create+fill. Removes the `create_file_or_folder → rewrite_file` dance that MiniMax was getting wrong half the time.
  - `edit_file` on missing file → throw `"File not found at <path>. edit_file requires an existing file to apply search/replace blocks against. Use rewrite_file to create a new file with full contents, or create_file_or_folder first then edit_file."` Auto-creating an empty file would be worse — every search block would fail to match, silently producing a no-op again. The error message names both recovery paths so the agent can self-correct without user intervention.
- Validated: single `rewrite_file` call on a non-existent `hello.js` now succeeds as one tool card (no preceding `create_file_or_folder`), where before today it silently no-op'd while showing "Change successfully made". File: `toolsService.ts`.
- Deferred follow-up: consider replacing `initializeModel`'s `console.log(…)` catch with a typed rethrow that distinguishes `FileNotFound` (expected at certain call sites) from other errors (should propagate). Would surface the same class of bug earlier if it recurs on non-tool code paths (e.g. edit-preview, sticky-scroll). Low priority since the current bug is contained.

**DeepSeek `reasoning_content` empty-string round-trip fix** ✅ DONE
- Symptom: under DeepSeek V4 thinking mode, the next request after a tool round-trip + checkpoint resume failed with `400 — The reasoning_content in the thinking mode must be passed back to the API`. Reproducible on the "edit tool → checkpoint → continue" flow; intermittent because it depended on whether the model emitted a non-empty reasoning blob on the post-tool follow-up reply.
- Root cause (two halves of the same bug): post-tool short replies (the "Done."-style follow-up that DeepSeek often returns after a tool result) arrive captured with `reasoning: ""` — the field is present in the response payload but no `delta.reasoning_content` chunks stream in, so the aggregator ends up with an empty string. Two truthy-checks in `convertToLLMMessageService.ts` then collapsed `""` to "no field": (1) `_chatMessagesToSimpleMessages` did `m.reasoning ? m.reasoning : undefined`, dropping the signal at forward time; (2) `prepareMessages_openai_tools` gated emission with `if (currMsg.reasoningContent)`, dropping it again on the wire. Result: an assistant turn that **was** captured under thinking mode replayed without `reasoning_content`, which DeepSeek's API rejects per §5 of `note-deepseek.md`.
- Why our own §5 was wrong (and got fixed alongside the code): the prior version of `note-deepseek.md` claimed *"only assistants with stored reasoning need to replay it"*, which read "stored" as "non-empty content". The live API treats *captured under thinking mode* — including empty captures — as the constraint. Note rewritten to spell this out.
- Fix: pass `m.reasoning` through verbatim and gate emission on `currMsg.reasoningContent !== undefined` instead of truthy. Empty strings now round-trip as `reasoning_content: ""` (DeepSeek accepts this); `undefined` (legacy pre-feature history or non-thinking turns) still skips. Two-line semantic change, large comment delta. Files: `convertToLLMMessageService.ts`. Diagnosed via temporary `[reasoning-cap]` (post-stream aggregator) + `[reasoning-emit]` (pre-wire serializer) `console.log` pairs that confirmed the empty-string drop was happening at the conversion layer, not the capture layer; logs removed before commit.
- Open follow-up (low priority, currently working): `supportsOAICompatReasoningContent` is provider-only, so we emit `reasoning_content: ""` even when the *current* request is non-thinking but a prior turn was captured under thinking. Live API has tolerated this so far; if a non-thinking DeepSeek request ever 400s on this, refine the gate to also depend on whether the current request has `thinking: { type: 'enabled' }` in `includeInPayload`.

### Next — Workspace-scoped chats (in progress, 5 commits)

Goal: chat history lives "in the workspace", not as one global pile. Default thread list shows current workspace's chats + legacy unscoped; other workspaces' chats are visible as **read-only** in an "Other workspaces" group, with explicit Copy/Move actions to bring them into the current workspace.

**Design decisions locked in (do NOT relitigate without revisiting):**

- **Storage stays APPLICATION-scoped**, threads gain a `workspaceUri` tag. True `StorageScope.WORKSPACE` was rejected because requirement #3 (browse other workspaces' chats) is incompatible with VS Code's storage model — `IStorageService` only exposes the *current* workspace's data. Workspace boundary is therefore a logical filter, not physical separation.
- **Default list filter**: `thread.workspaceUri === currentWorkspaceUri || thread.workspaceUri === undefined`. Legacy unscoped threads stay visible in every workspace's list until explicitly Move-d (= claimed) or Copy-ed elsewhere. No auto-tag on first-message-in-legacy-thread (rejected for predictability).
- **Read-only mode** for cross-workspace viewing. Disables: send, edit-message, retry, abort, checkpoint restore, approve/reject on tool requests, pin button, model-selection dropdown. Read operations (scroll, expand tool result body, click file references to open) all stay enabled. Implicitly handles cross-workspace checkpoint-restore safety (no special guard needed).
- **Copy and Move both available** in the read-only banner, Copy as primary action.
  - **Copy** = deep clone with fresh `id`, set `workspaceUri/workspaceLabel` to current, stamp `importedFromWorkspaceUri/importedFromThreadId/importedAt`, **reset `latestUsage` / `cumulativeUsageThisThread` / `cumulativeCompactionThisThread` to undefined** (cost-of-foreign-work shouldn't count in this workspace's books). Original thread untouched.
  - **Move** = in-place re-tag (`workspaceUri` + `workspaceLabel` only). Counters preserved, no provenance stamps (the thread *is* the original, just relocated). Source workspace loses it.
- **Visual indicators (icons + hover tooltips, NOT title text)**: lock icon for read-only foreign threads ("From workspace X (read-only)"); imported icon for threads with `importedFromWorkspaceUri` set ("Imported from workspace X on Y"). Title text stays clean — handles "two threads with the same title" via icon distinction, not by polluting titles with "(imported from X)".
- **Per-workspace `currentThreadId`**: `lastActiveThreadIdByWorkspace: Record<workspaceUri, threadId>`. Restored on workspace switch. Lives in its own APPLICATION-scoped storage key (separate from threads blob, no migration risk).
- **Pinning gated on `!isReadOnly`**. Pin display also filtered by `workspaceUri` so pinned threads from workspace A don't clutter workspace B's tab strip.
- **Workspace identity**: URI string of folder (single-folder) or `.code-workspace` file (multi-root); empty-window → undefined. Renaming a folder breaks the link (accepted edge case — recovery is one Move-here from "Other workspaces"). Workspace label captured at creation = basename, not derived dynamically (so threads from a deleted workspace still show a sensible group name).

**Open follow-ups (deferred):**

- Title-collision suffix on copy was rejected (use icon instead); revisit if users complain.
- Bulk import ("import all threads from workspace X"). Skip until requested.
- Cross-workspace search (find a thread by content across all workspaces). Skip — import picker is already a search UI over titles.
- Export thread to JSON for cross-machine backup. Different feature, separate concern.
- Storage growth from copies: not optimised. Threads ~50–500KB; 20 imports = ~10MB extra. Only revisit if telemetry shows ballooning.

**Commit plan:**

- **Commit 1 — Schema + workspace stamp at creation.** Add `workspaceUri?` / `workspaceLabel?` / `importedFromWorkspaceUri?` / `importedFromThreadId?` / `importedAt?` to `ThreadType`. `newThreadObject` accepts identity from caller; `openNewThread` reads `IWorkspaceContextService` and passes through. Legacy threads remain undefined-everywhere (backward compat). **Zero user-visible change.** No filter, no UI, no storage layout changes.
- **Commit 2 — Default list filter + per-workspace `currentThreadId` + pin filter.** Tab strip + history sidebar + pinned-thread row filter to `workspaceUri === current || === undefined`. Add `LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY` (separate APPLICATION-scoped key); restore last-active per workspace on switch, fallback to newest editable, fallback to landing page. **First user-impacting commit** — foreign threads disappear from default view.
- **Commit 3 — Read-only mode infrastructure.** Add `isReadOnly` derived flag (`!!thread.workspaceUri && thread.workspaceUri !== currentWorkspaceUri`). Gate every mutation in `SidebarChat.tsx` and downstream. Unobservable in isolation (no foreign threads visible until commit 4) — focused review of "did we cover every mutation point".
- **Commit 4 — "Other workspaces" group + read-only banner + Copy/Move actions.** Foreign threads surface in history under "Other workspaces" group, sub-grouped by workspace label, all collapsed by default. Click → opens read-only with banner + Copy/Move buttons. `copyThreadToCurrentWorkspace` and `moveThreadToCurrentWorkspace` implementations. **Feature-complete commit.**
- **Commit 5 — Visual indicators on tab strip.** Lock icon + tooltip for read-only foreign; Globe icon + tooltip for unscoped. Reuses the existing leading-icon slot (running-state spinner takes precedence). Imported icon dropped — see commit 5 notes. Polish-only.
- **(Optional) Commit 6 — Roadmap entry move.** Move this section into the Done block once everything ships, with measured outcomes / any deviations from plan called out.

**All shipped: Phase E commits 1-5, per-workspace pin refactor, read-only revert, and Tier-1 follow-up #1 (multi-window state sync — `7faec235`, on `main` via PR #26 squash `d9ade47f`). Optional Commit 6 (move this whole section into Done with outcomes summary) still pending.**

**Tier-1 follow-up #1 implementation notes (multi-window state sync):**

- Pre-existing problem: `ChatThreadService` reads its three storage slots once at construction and never subscribes to `onDidChangeValue`. With pre-Phase-E code, the global pin list was the only cross-window state worth syncing, and pinning was infrequent enough that no one complained about the staleness. Phase E makes Move/Copy a much more attractive cross-workspace action — it's the first time it's *expected* that one window's edit shows up in another without reload — so the staleness becomes visible.
- Two listeners added in the constructor, one per small dict slot:
  - `PINNED_THREADS_STORAGE_KEY`: re-reads `_pinnedThreadIdsByWorkspace`, replaces in-memory contents in-place (preserves the stable reference in case some private path captured it), and refreshes `state.pinnedThreadIds` projection if the current-workspace bucket actually changed. The cheap diff (length + every-id-equal) avoids gratuitous React re-renders when an *external* change touches some other workspace's bucket but leaves ours alone.
  - `LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY`: re-reads the dict, replaces in-memory. Deliberately does NOT auto-switch the current thread on update — yanking focus because another window switched would be jarring at best and lost-work at worst (mid-typing). The fresh map is consulted naturally by `_normalizeCurrentThreadInScope` on the next reload/workspace-change, which is the right time for it to take effect.
- Both listeners gate on `e.external === true`. The storage service fires the same event for local writes too, so without the filter every `_storePinnedThreadIdsByWorkspace` call would round-trip back into a re-read. With the filter, local writes update state synchronously (fast path) and only foreign writes pay the read-back cost.
- Listeners use the per-key registration form (`onDidChangeValue(scope, KEY, this._store)`) rather than a single all-keys listener with internal switching. Two reasons: (1) each handler is small and independent, and (2) per-key registration means the storage service can route only the relevant events to us, instead of every APPLICATION-scope write.
- **Deliberately did NOT listen on `THREAD_STORAGE_KEY`** (the threads blob). Each window's blob write is its own snapshot of the full thread map — if window A streams thread Z to completion and writes the blob, window B (which has been streaming the same Z but is half a second behind) would have its in-memory live progress overwritten by A's stale snapshot. Per-thread storage keys would fix this, but it's a much larger refactor (storage layout, migration, snapshot consistency for `_storeAllThreads`) and the user-facing pain is much smaller — "see threads created in another window" is a cold start, not an active session, problem. Documented in the listener comment so future work knows what's missing.
- Three-window test plan: open same workspace in W1+W2, pin a thread in W1 → W2 sees it appear in <1s. Unpin in W1 → W2's tab disappears. Move a foreign thread from W2 (workspace B) to W1 (workspace A) → W2's "Other workspaces → A" group entry disappears, W1's tab strip gains the Move'd thread. Reload neither window during the test.

**Commit 5 implementation notes:**

- The tab strip already had a leading-icon slot (loader / awaiting-user) that fires only while a thread is running. Reused that slot as a 4-way cascade rather than adding a second icon column — tabs are clipped to ~110px and a second column would crowd the label. Running always wins (transient, time-sensitive). When idle: foreign → `Lock`; unscoped (in workspaced window) → `Globe`; same workspace → nothing (matches the pre-Phase-E look, no churn for normal users).
- Both indicators only apply in workspaced windows. Empty windows (no workspace open) have no reference frame to call something "foreign" against — the predicate `isThreadReadOnly` already short-circuits there, and `tabIsUnscoped` gates on `currentWorkspaceUri` truthy. So opening Void with no folder shows naked tabs, same as before.
- Icon span carries its own `data-tooltip-id`/`data-tooltip-content`. The outer tab keeps the message-preview tooltip (which is the only thing shown when hovering the label area). React-tooltip's nearest-ancestor delegation means hovering the icon directly reveals the provenance tooltip without flickering between the two. The trade-off: users who hover the icon get *only* the provenance text, not the message preview — small price for a focused affordance.
- Foreign tooltip mirrors the chat-body banner copy ("Read-only — owned by …") so the user gets the same explanation whether they hover the tab or click into it. Falls back through `workspaceLabel` → `workspaceUri` → "another workspace" so nothing renders as "undefined" if a thread was tagged before the label was captured.
- Unscoped tooltip explicitly mentions claim-on-engagement ("Sending a message will claim it for this workspace") because the icon disappears the moment the user sends — without explanation that's mysterious. The history-sidebar banner offers the same Claim affordance for users who don't want the implicit pathway.
- Did NOT add an "imported" indicator (the original Commit 5 plan had it). Imported threads are editable and same-workspace; once Copy completes they're indistinguishable from native threads functionally, and the provenance is visible in the message history if needed. Adding a third icon variant for a permanent badge on otherwise-normal threads felt like noise. The two-variant design matches user feedback ("2 types: other workspace, unscoped").

**Commit 2 implementation notes (record so the next session doesn't re-derive):**

- New file: `LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY` in `storageKeys.ts` (separate slot from threads blob; small frequently-touched dict shouldn't reflate the big payload).
- `ThreadsState` gained `currentWorkspaceUri?: string`. Resolved exactly once at service construction (`_getCurrentWorkspaceIdentity`), held in state so React consumers (`useChatThreadsState`) get it for free without re-injecting `IWorkspaceContextService` everywhere.
- Exported helper `isThreadInWorkspaceScope(thread, currentWorkspaceUri)` is the single source of truth for the rule "same workspace OR unscoped is in scope". Used in: constructor restore-validation, `openNewThread` empty-thread reuse gate, history list filter, pinned-tab filter. Same logic lands in commit 3 (`isReadOnly` is its negation, restricted to non-undefined `thread.workspaceUri`).
- Service gained private `_lastActiveThreadIdByWorkspace: Record<workspaceUri, threadId>` + read/write. Constructor hydrates from storage, then `_restoreLastActiveThreadForCurrentWorkspace()` validates (entry exists / thread exists / still in scope) and either calls `switchToThread` or self-heals by deleting the stale entry. On miss it falls through to the existing `openNewThread()`.
- `switchToThread` writes `{ wsUri → threadId }` to the map and persists (skipped on empty windows; only persists when the value actually changes). This is the only place outside the constructor that touches the map.
- `openNewThread`'s empty-thread reuse path now requires `isThreadInWorkspaceScope` — it never silently hijacks an empty thread tagged to a different workspace. Unscoped empties remain fair game for reuse.
- React filters live in `SidebarThreadSelector.tsx`: `PastThreadsList` and `SidebarThreadTabs` both read `currentWorkspaceUri` from state and apply `isThreadInWorkspaceScope`.
- Reload requirement: `ChatThreadService` is an instantiated singleton — its constructor only runs once per window. Restoring last-active and stamping `currentWorkspaceUri` therefore needs a window reload (Cmd+R) after pulling the change; full server restart not required because the watcher recompiles in place.

**Commit 2 follow-up: claim-on-engagement (shipped in same commit, not deferred):**

Initial commit-2 behavior treated unscoped threads as "visible in every workspace until Move-d". This was wrong in practice — testing showed two failure modes that both produced the same user-visible bug ("threads from workspace A appear as tabs in workspace B"):

1. **Reuse-path leak**: `openNewThread` with a pre-Phase-E empty thread sitting around reuses it via `switchToThread` without ever going through `newThreadObject`, so the workspace tag never gets written. A thread the user genuinely created "in workspace A" ends up untagged → visible everywhere. Hits every existing user during the migration window.
2. **Legacy-non-empty leak**: pre-Phase-E threads with messages already in them are untagged forever; the spec said "they show up in every workspace until Move-d via commit 4 UI". User mental model rejected this: "I made this in workspace X, why is it everywhere?".

Fix: new private helper `_claimThreadForCurrentWorkspaceIfUnscoped(threadId)` on the service. Tags an unscoped thread with the current workspace's identity. No-op when the thread is already tagged (any workspace) or the window is empty-window. Wired in at two engagement points:

- **`openNewThread` reuse branch** — claim before `switchToThread`, so reusing an unscoped empty thread immediately tags it. Closes failure mode 1 at the source.
- **`_addUserMessageAndStreamResponse` top** — claim before any of the message-sending plumbing fires. Closes failure mode 2 the next time the user sends a message in a legacy thread, no migration UI required.

Semantics: last-engaged wins. If you flip workspaces and send a message in an unscoped thread from workspace B, the thread becomes B's. This matches what the user was actually trying to do; no scenario where a legitimately shared thread regresses.

Not wired in (decided): `editUserMessageAndStreamResponse`, `duplicateThread`, `switchToThread`, `pinThread`. Engagement was scoped to "user actively says something" (send / first interaction). Pure navigation (switch, edit-without-resend, pin) is a non-event for claim purposes — otherwise just clicking through history would silently re-tag threads.

**Commit 2 follow-up (continued): untitled-multi-root window leak.**

After the claim-on-engagement fix, testing turned up a *third* failure mode also producing untagged threads. VS Code's `toWorkspaceIdentifier(workspace)` returns three shapes:
- `{ id, uri }` — single-folder workspace.
- `{ id, configPath }` — multi-root `.code-workspace` file.
- `{ id }` only — empty window OR **untitled multi-root** (multiple folders dragged into one window but not yet saved as a `.code-workspace`).

The original `_getCurrentWorkspaceIdentity` only handled the first two and returned `{}` (treat as empty window) for the third shape. So a user creating a thread in an untitled multi-root window got `workspaceUri = undefined` even though they were clearly "in a workspace". That's how `363980c4` ("what time is it?") ended up untagged despite being created via `newThreadObject`.

Fix: detect the untitled-multi-root case by checking `workspace.folders.length > 0` after both other branches miss, and synthesize a stable scoping key from `workspace.id` with a `void-untitled-workspace://` prefix (so it can't accidentally collide with a real folder URI in storage / Move actions later). Label = first folder's basename + `(+N)` if there are more.

Edge case (accepted): saving an untitled multi-root window as a `.code-workspace` mints a new `id` and existing threads stay tagged to the old synthetic key. They become "foreign" to the saved workspace and can be Moved over via commit 4 UI. Cheap to live with; alternative is migrating tags on save which we haven't built.

**Other open in commit 2 (resolved during debug session):**

- Originally deferred: cleanup of `_lastActiveThreadIdByWorkspace` entries on `deleteThread`. Got promoted to in-scope after observing "closed threads keep reappearing on reload" — the stale entry was being honored on next startup, not self-healing. Fix shipped: `_clearLastActiveEntriesForThread` called from both `unpinThread` and `deleteThread`.
- Startup landing strategy was rewritten end-of-session: `_normalizeCurrentThreadInScope` now prioritises *pinned* in-scope threads via `_landOnThread` (no auto-pin), only falling through to `openNewThread` (which auto-pins) when the workspace genuinely has nothing to show. Fixes "refresh creates a new chat" and "refresh creates a chat without a tab".

**Commit 2 follow-up: per-workspace pin storage (model correction).**

User feedback after commit-3 work surfaced a deeper modeling error: "a chat can be opened by more than 1 workspace, whether it is editable or not is another problem, whether a chat is opened or not is only scoped to that workspace". The original commit-2 implementation kept pin storage as a single global `string[]` and patched the symptom (tab strip filter applies `isThreadInWorkspaceScope`). That filter was always papering over the wrong shape — it produced the user-reported "unscoped chat opened from history appears in both workspaces' tab strips" symptom because unscoped is universally in-scope, so a single global pin necessarily renders in every workspace.

Refactor (in-place to commit 2, since it's the same idea applied to the right data structure):

- New private map `_pinnedThreadIdsByWorkspace: Record<workspaceUri, threadId[]>` is the source of truth. Empty-window pins live under sentinel key `''`.
- `state.pinnedThreadIds` is now a *projection* of the current workspace's bucket. React consumers stay unchanged.
- All pin/unpin/reorder/delete paths funnel through one helper, `_setPinsForCurrentWorkspace(newPins, extraStateUpdate?)`, that updates map + projection + storage atomically. Avoids the three-way drift bugs that're easy to introduce when each method copy-pastes the persistence triple.
- `deleteThread` is the only operation that touches *all* buckets (thread is gone for everyone), iterating `Object.keys(_pinnedThreadIdsByWorkspace)`.
- `unpinThread` clears the per-workspace last-active map for *current workspace only* (not all workspaces, as it did before). Other workspaces may still legitimately have the thread pinned + last-active; their state stands.
- Tab strip filter in `SidebarThreadSelector.tsx` drops the `isThreadInWorkspaceScope` check — the per-workspace bucket is already correctly scoped by construction. A foreign thread that does appear here was explicitly opened by the user (read-only via commit 3's gates).
- `_normalizeCurrentThreadInScope` cascade simplified: per-workspace pin storage means "in scope" check on pinned candidates is redundant. A foreign-yet-pinned thread is now a legitimate landing spot — user pinned it here, locking-out-of-mutations is commit 3's job.

Storage migration (one-shot, runs at construction): if `chatPinnedThreadsI` value is the legacy array shape, distribute each id to its `thread.workspaceUri` bucket; drop unscoped pins (no obvious workspace to assign to; user's natural recovery is re-clicking from history). The next pin/unpin re-serializes under the new shape.

What this changes for `switchToThread` semantics: opening a foreign or unscoped thread from history auto-pins to *current workspace's bucket only*. The other workspace's tab strip is unaffected. This is the entire fix for the "unscoped chat in both workspace tabs" symptom.

**Commit 3 implementation notes (read-only mode infrastructure):**

Goal: enforce "foreign threads cannot mutate" at the *service* layer, so commit 4's UI banner + Copy/Move flow can be built on top without worrying about a UI bug ever corrupting cross-workspace data. Commit 3 is unobservable in isolation (commit 2 already filtered foreign threads out of the default view; nothing in commit 3 makes them reachable yet).

Why service-level instead of UI-only: a disabled button is one bug-fix away from being clickable, and every clickable mutation entry then has to be audited again. A guard at the service entry holds regardless of what the UI does, including programmatic callers (toolbar shortcuts, future extension API surfaces, etc.). UI-level disabling lands later in commit 4 alongside the banner — the visuals are wasted noise without the foreign-thread surface to apply them to.

Predicate (`isThreadReadOnly`, exported next to `isThreadInWorkspaceScope`):
- Returns true only when the thread is explicitly tagged to a *different* workspace.
- Unscoped threads (`workspaceUri === undefined`) are NOT read-only — they're shared until claim-on-engagement or Move. This is the deliberate negation pair to `isThreadInWorkspaceScope`'s "unscoped is in scope".
- Empty windows (`currentWorkspaceUri === undefined`) have no "foreign" reference frame — nothing is read-only. Otherwise opening Void without a workspace would lock every existing thread against editing.

Centralising helper on the service: `_isThreadMutationBlocked(threadId, op)`. Returns true + logs a `console.warn` with the op name and the workspace pair when it fires. Each gated entry calls it as a one-liner. Two reasons to centralise vs. inlining:
1. Future change to "read-only" definition (e.g. allowing edits in shared workspaces) only edits one place.
2. The console warning is the only diagnostic we have for "UI bug let a click through" once commit 4 ships — wanted it on every entry uniformly.

Gated entry points (all in `chatThreadService.ts`):
- `addUserMessageAndStreamResponse` — primary send path. Block early before checkpoint-truncation.
- `editUserMessageAndStreamResponse` — edit-and-resend. Same severity as send.
- `approveLatestToolRequest` — resumes the agent loop, which appends messages to the thread.
- `rejectLatestToolRequest` — gated only when `resumeAgent === true` (user-initiated UI button). Allowed when `resumeAgent === false` (called from `abortRunning` cleanup) — `abortRunning` itself is allowed because terminating a stream that shouldn't have started is preferable to leaving it running on a thread we now refuse to mutate.
- `jumpToCheckpointBeforeMessageIdx` — most destructive entry in the set: writes file snapshots back to *real* disk paths in the current workspace. A foreign-thread restore would clobber THIS workspace's files with snapshots taken in a different one. Must be gated.
- `addNewStagingSelection` / `popStagingSelections` — staging selections feed into the next user-message send. Gating them isn't strictly safety-critical (the send is gated downstream) but prevents weird "I @-referenced a file in the wrong workspace's foreign thread, then Moved it, and the staging now points at a path that doesn't exist" edge case.

Not gated (with rationale):
- `deleteThread` — list management, doesn't mutate thread *content*. Allows the user to delete trash from any workspace's history without first switching to it.
- `duplicateThread` — creates a new thread; source isn't mutated. The duplicate inherits the source's `workspaceUri`, so it stays foreign — but Copy/Move (commit 4) is the proper claim-on-duplicate path; this is just preserving existing duplicate semantics.
- `abortRunning` — defensive cleanup. Should never fire on a foreign thread (no stream started → nothing to abort), but if it somehow does, we want the cleanup to complete.
- `setCurrentlyFocusedMessageIdx`, `setCurrentThreadState` (raw), `setCurrentMessageState` (raw) — UI-state mutations (focus, scroll, mountedInfo). Harmless on read-only; the truly destructive paths that flow through these (sends, etc.) are gated separately above them.

Testing plan: unobservable in isolation as designed. Verification deferred to commit 4 — once foreign threads have a path to be visible/clickable, exercise each gated action and confirm (a) no thread mutation, (b) the `console.warn` fires once per attempt.

**Commit 4 implementation notes ("Other workspaces" history group + read-only banner + Copy/Move):**

The feature-complete commit. Surfaces foreign + unscoped threads in the history sidebar under a collapsible "Other workspaces" group, adds a read-only banner with Copy/Move actions to the chat body, and implements the two service methods that actually move data between workspaces. This is the commit that makes commits 2 and 3 observable end-to-end.

*History list partition* (`partitionThreadsByWorkspaceScope` in `SidebarThreadSelector.tsx`):
- Strict equality on `workspaceUri` for the "own" bucket — *not* `isThreadInWorkspaceScope`. Unscoped threads (workspaceUri === undefined) no longer mix into the default list; they live under "Other workspaces → Unscoped" alongside foreign threads. Cleaner mental model: default = strictly current workspace, everything else is one click deeper.
- Foreign bucket keyed by `thread.workspaceUri` (real workspace URI / `.code-workspace` configPath / synthetic `void-untitled-workspace://` from commit 2's untitled-multi-root fix). The empty-string sentinel is reused for unscoped, so the bucket key matches the same scoping key the service uses internally — nothing has to translate between display and storage.
- `Map` (not plain object) preserves insertion order so groups render in lastModified-recency order rather than alphabetical-by-key noise.

*UI state* — both expansion levels are in-memory only (no persistence). Top-level "Other workspaces" defaults collapsed each reload; per-bucket sub-groups default *expanded* once the parent opens (avoids cascade-of-clicks when you've already committed to looking under there). Decided against persisting either across reloads — the cost of one click on each session is small, and a persistent expanded state would cause flicker on first paint after restoring 50+ entries.

*Copy semantics* (`copyThreadToCurrentWorkspace`):
- Fresh `id` via `generateUuid` so source's id remains traceable.
- Workspace stamp set to current via `_getCurrentWorkspaceIdentity()`.
- `importedFromWorkspaceUri` / `importedFromThreadId` / `importedAt` provenance — already on `ThreadType` from commit 1, finally used.
- Usage telemetry reset to undefined (`latestUsage`, `cumulativeUsageThisThread`, `latestCompaction`, `cumulativeCompactionThisThread`) — those numbers accrued on requests that ran in another workspace's context and would be misleading if carried over. The TokenUsageRing reads from these fields so it goes blank-then-rebuilds-on-next-send. In-memory mirror maps are also cleaned defensively.
- Messages, checkpoints, model selection, staging selections all carry over verbatim. Copy is "give me a working duplicate to riff on", not "fresh start with the same prompt".
- Auto-pin + switch via `switchToThread` rather than open-coding — keeps the auto-pin / lastActive / model-restore side-effects flowing through the established channel.

*Move semantics* (`moveThreadToCurrentWorkspace`):
- Re-tags `workspaceUri` + `workspaceLabel` in place. Same id, same messages, no telemetry reset (lifetime cost belongs to the user, not the workspace it accumulated in).
- Cleans up the *origin* workspace's pin bucket and last-active pointer for this thread — once re-tagged, the thread is foreign to its origin per the new model, and a leftover pin would render an out-of-place tab in that workspace's strip on its next reload.
- No-op + just-switch when the source already belongs to current workspace (defensive — banner shouldn't even offer Move in that case, but direct API calls might).

*Banner trigger separated from read-only* (`ReadOnlyForeignThreadBanner` in `SidebarChat.tsx`):
- Shows above `messagesHTML` whenever `shouldShowOwnershipBanner(currentThread, currentWorkspaceUri)` returns true — strict workspace mismatch (same predicate the history partition uses), so it fires for **both** foreign workspaces AND unscoped threads in a workspaced window.
- Read-only gating uses the *narrower* `isThreadReadOnly` (foreign only, unscoped excluded). Service guards from commit 3 still gate every mutation entry on the same narrower predicate; unscoped sends + edits flow through normally and `_claimThreadForCurrentWorkspaceIfUnscoped` re-tags them on first engagement.
- Owner label cascades: real `workspaceLabel` → `workspaceUri` string → "Unscoped" sentinel. Matches the heading used by `partitionThreadsByWorkspaceScope`, so the banner agrees with the history group the user clicked through.
- Two visual variants based on `isUnscoped`. Foreign: lock icon, "Read-only — owned by X" + "Move here" (re-tags, source loses default-view access; input gated). Unscoped: info icon, "Not tied to a workspace yet — editable, claim to keep it here" + "Claim here" (input still works; banner is the explicit/discoverable counterpart to claim-on-send). Copy is identical in both.

*Why banner ≠ read-only* (final design after iteration):
- First draft: banner triggered on `isThreadReadOnly` and unscoped was treated as read-only. Felt symmetric, but broke unscoped editability — claim-on-send couldn't fire because the service guard ran first, and users lost the ability to keep using the empty-window-created threads they'd accumulated.
- Final: two predicates with overlapping but distinct meanings. `shouldShowOwnershipBanner` (broad) drives the UI affordance ("this isn't yours, want to claim?"); `isThreadReadOnly` (narrow) drives the lockdown ("this is someone else's, don't touch"). Empty windows skip both — no reference frame.
- Truth table:
  - same workspace        → banner: no,  read-only: no  (normal)
  - foreign workspace     → banner: yes, read-only: yes (Copy / Move; input gated)
  - unscoped + workspaced → banner: yes, read-only: no  (Copy / Claim; input editable + claim-on-send)
  - empty window          → banner: no,  read-only: no  (no reference frame)

*In-bubble edit pencil also gated*:
- `UserMessageComponent` renders a small Pencil button (top-right of each user message) that re-opens the message for editing. Originally always rendered when hovered. With service-level gates in place, clicking it on a foreign thread silently no-ops, which is worse UX than not showing it.
- Threaded `threadIsReadOnly` from `ThreadMessagesView` → `ChatBubble` → `_ChatBubble` → `UserMessageComponent` (single subscription at the view level rather than per-bubble re-subscription). When true: Pencil hidden, the bubble itself loses `cursor-pointer` + the click-to-edit handler. The `<textarea>`-based edit mode is unreachable from the UI; the service guard is now defense-in-depth, not the only defense.

*Why landing-page banner is unnecessary*: foreign threads opened from "Other workspaces" go through `switchToThread` which auto-pins + sets `currentThreadId`. Landing page only renders for threads with zero messages, but the partition filter excludes empty threads from "Other workspaces" entirely — so a foreign thread on the landing page is unreachable through normal navigation. Skipping that branch saves a defensive code path that has no test surface.

### Capability audit vs. Cursor (post-Phase-C, pre-daily-use)

Asked "what brings Void to the next level?" → audited the codebase to separate "actually missing" from "assumed missing". Outcome:

*Already in Void (don't rebuild)* — confirmed by grep + reading the relevant services:
- **Fast Apply / apply model path** — `featureNames = ['Chat', 'Ctrl+K', 'Autocomplete', 'Apply', 'SCM']` in `voidSettingsTypes.ts`; `enableFastApply: true` default; retry logic (3x) + user-facing error on failure in `editCodeService.ts`; dropdown for Fast Apply method in Settings. The Cursor-analog is already shipped.
- **Checkpoint / undo** — `CheckpointEntry` type in `chatThreadServiceTypes.ts` (`type: 'user_edit' | 'tool_edit'`, `voidFileSnapshotOfURI`, `userModifications`); full `_addCheckpoint` / `_getCheckpointBeforeMessage` / `_readCurrentCheckpoint` plumbing in `chatThreadService.ts`; `Checkpoint` UI component in `SidebarChat.tsx`. Full per-message snapshot-and-restore infrastructure exists.
- **Autocomplete (Tab)** — `autocompleteService.ts` with LRU cache, 500ms debounce, FIM prompt via `prompts.ts` line 861, multiple prediction types (`single-line-fill-middle`, `single-line-redo-suffix`, `multi-line-start-on-next-line`), parenthesis balancing, prefix-cache-friendly trimming. Non-trivial, thoughtful implementation; not a "Cursor-Tab-replacement-pending" gap.
- **Ctrl+K inline edit** — named feature with its own model selector.
- **SCM (commit message generation)** — named feature.
- **Tool suite** — 13 builtin tools including `read_lint_errors`, `run_persistent_command`, `open_persistent_terminal`, `kill_persistent_terminal`. Pagination baked into context-gathering tools. MCP integration for extensibility.
- *Plus our recent additions:* compaction (Perf 2), parallel tool calls (Perf 4), emergency trim + telemetry, write-tool silent-failure fix, Phase A1+A2 / A3+A4 / C prompt work.

*Actually missing* (grounded in grep, not guesswork):
- **Codebase indexing / semantic search** — zero matches for `embedding` / `vector` / `semantic search` outside of code-sample string literals. No embedding pipeline, no vector store, no `semantic_search` tool. This is the single biggest capability gap vs. Cursor — every "agent made wrong lexical query → got nothing → retried with different keywords" symptom in our eval logs traces back here.
- **`.cursor/rules` / `AGENTS.md` auto-loading** — no matches for `.cursor/rules`, `.cursorrules`, `AGENTS.md`, or `.mdc` parsing in the Void codebase. Per-project conventions have to be pasted into chat manually each time. The prompt-injection plumbing (`chat_systemMessage` composition) already exists in `prompts.ts` — the missing piece is just the file watcher + parser + frontmatter matcher.
- **`@`-mention variety** — only `File` / `Folder` / `CodeSelection` in `StagingSelectionItem`. Missing: `@git-diff`, `@recent-changes` (modified since last commit), `@problems` (current diagnostics), `@terminal`, `@pr`, `@web`, `@docs`, `@codebase`. Each missing type is a workflow where the user pastes context manually today.
- ~~**LSP navigation tools (`go_to_definition`, `go_to_usages`)**~~ ✅ DONE — fully implemented in `prompts.ts` (tool definitions + descriptions) and `toolsService.ts` (execution). Tested across MiniMax (ideal 1-call flow), Gemma (ignored LSP, used read_file), Nemotron (grep-party, never reached for LSP). Base-model capability issue for weaker models, not a prompt issue. See "Prompt Phase C6+C7" section for details.
- **Web / doc fetch tool** — no `web_search`, no `fetch_web`, no URL fetcher. MCP covers this if you install a server; nothing built-in.
- **Image input in chat** — no evidence in the chat flow. Not verified exhaustively but nothing surfaced in the audit.

### Next — Path X: Tier-2 daily-use wins (Phase E)

Path decision from the audit: **do the small, concrete wins first, then decide on indexing based on daily-use data.** Alternative (Path Y = commit to indexing / Phase F first) is not ruled out, but starting with the cheap items has better risk/reward — delivers working stuff in days, gives real data on whether semantic search is genuinely needed.

**Phase E — Three small daily-use wins, independently shippable.** Ordered by ROI per hour (highest first).

~~**E1 — Revive `go_to_definition` / `go_to_usages` as LLM tools**~~ ✅ DONE — see entry in Done section above. Shipped with optional-`line` fallback scan (word-boundary match), three-surface prompt push (tool descriptions + C5 `importantDetails` bullet + redirect lines in `search_in_file` / `search_for_files`), and auto-gen parallel-tool list derived from `approvalTypeOfBuiltinToolName`. Validated empirically on a natural "where is `validateNumber` defined" prompt: **MiniMax** uses the tool in 1 call (ideal), **Gemma / Nemotron** ignore it and fall back to read/grep (same capability ceiling as C6 parallel-reads — strong models adopt prescriptive tool rules, weaker ones don't, regardless of prompt weight). Net: clear win for MiniMax users, zero regression for others, tool remains as explicit escape hatch. Stopped iterating on the prompt — further weight risks over-correction (calling LSP for free-text queries where there's no identifier to resolve).

~~**E2 — `.cursor/rules` / `AGENTS.md` auto-loading**~~ **Reconsidered — redundant with `.voidrules`; pivoted to fixing `.voidrules` reliability + change-awareness instead.**
- Original plan (watch `.cursor/rules/*.mdc`, parse frontmatter, mirror Cursor rule-selection semantics) was dropped after noticing Void already has `.voidrules` doing the exact same thing: workspace-root file → text → injected into the system prompt via `GUIDELINES (from the user's .voidrules file):\n{contents}` (see `prepareOpenAIOrAnthropicMessages` in `convertToLLMMessageService.ts`). Adding a second convention would just fragment the mental model. Frontmatter/glob-matching/selection semantics are a "nice-to-have" that can sit in E3's successor; daily-use pain was actually elsewhere.

**E2' — `.voidrules` fix: always-fresh read + rule-change chip** ✅ DONE (user request pivot) — **RECONSIDER: token cost**
- *Pain observed*: edited `.voidrules`, sent a new chat, rules weren't applied. Neither new threads nor existing threads picked up edits until a full Void restart. No UI signal either way — silent.
- *Root cause*: `_getVoidRulesFileContents()` read rules from a cached `ITextModel` populated once at startup (or on workspace folder change) by `convertToLLMMessageWorkbenchContrib.ts → voidModelService.initializeModel()`. Two failure modes: (1) if `.voidrules` didn't exist at launch, `createModelReference` threw `FileNotFound`, the silent `catch` in `initializeModel` swallowed it, the model reference was never registered, and no watcher re-tried if the file was created later — `getModel()` returned `null` forever that session; (2) even when the model did exist, in-memory `getValue()` wasn't reliably reflecting external disk edits in practice. Symptom: "I just modified the rule and opened a thread — new thread needs to read the rule, right?"
- *Fix* (A + B):
  - **Direct file read on every chat request** — new `_getVoidRulesFileContentsFromDisk()` uses `IFileService.readFile(uri)` on `.voidrules` from every workspace folder, concatenated with `\n\n`. Sub-millisecond for a tiny file; bypasses the model cache entirely. Wired into a new async `_getCombinedAIInstructionsAsync()` awaited by `prepareLLMChatMessages`. The sync `_getCombinedAIInstructions()` + `_getVoidRulesFileContentsSync()` are kept for `prepareLLMSimpleMessages` (Fast Apply / Quick Edit / SCM) so those 4 sync call sites don't need to go async — those flows don't benefit meaningfully from always-fresh rules anyway, and their sync control flow would cascade a lot of refactoring otherwise.
  - **Console log (Option A, dev-visible)** — first read this session logs `[void rules] loaded .voidrules (N chars)`; any subsequent change logs `[void rules] .voidrules changed (was N → M chars)`. Tracked via a module-level `_lastLoggedRulesContent` on the service instance, not persisted. Debug-forever for ~3 lines of code; no production impact since no UI surfaces it.
  - **Per-thread rule-change chip (Option B, UI)** — new optional fields: `UserChatMessage.rulesChangedBefore?: boolean` + `ThreadType.lastAppliedRules?: string` (both persisted, both backward-compat). On each user-message send, `chatThreadService._addUserMessageAndStreamResponse` calls `IConvertToLLMMessageService.getCurrentVoidRulesContent()`, compares against `thread.lastAppliedRules`, and sets `rulesChangedBefore: true` on the outgoing message iff `lastAppliedRules` is defined AND differs. First message on a thread never flags (no baseline → everything would look "new"). A new `_setThreadLastAppliedRules()` helper persists the current snapshot with the usual equality-skip pattern. `SidebarChat.UserMessageComponent` renders a small self-end `🔄 .voidrules updated` chip above the bubble when the flag is set, with a tooltip explaining "Your .voidrules changed before this message. The new rules apply from here onwards." Dims with the bubble when the message is on the far side of the current checkpoint.
- *What the agent sees*: nothing new — just the current rules, same as before, on every request via the system message. The chip is purely a user-facing affordance for "where in the conversation did my rules shift?". Deliberately NOT injected as a chat-level marker; that would pollute context and duplicate what the system message already carries.
- *Files*: `convertToLLMMessageService.ts` (IFileService injection + async disk read + console log + `getCurrentVoidRulesContent` interface method), `chatThreadServiceTypes.ts` (`rulesChangedBefore?` on user `ChatMessage`), `chatThreadService.ts` (`lastAppliedRules?` on `ThreadType` + `_setThreadLastAppliedRules` + detection call in `_addUserMessageAndStreamResponse`), `SidebarChat.tsx` (chip render + `RefreshCw` import). `convertToLLMMessageWorkbenchContrib.ts` left as-is — still needed to pre-init the cached model for the sync path.
- *Restart note*: full Void quit + relaunch required after upgrade (not Cmd+R) because `ConvertToLLMMessageService` is a `registerSingleton` and a new constructor dep (`IFileService`) was added.

**`.voidrules` format — quick reference**
- **Free-form text**, injected verbatim into the system message under `GUIDELINES (from the user's .voidrules file):\n{contents}`. No parser, no frontmatter, no schema. Multi-folder workspaces concatenate with `\n\n`. The global `aiInstructions` setting is prepended with `\n\n` before the file content.
- **Markdown works best** — LLMs parse it natively. Headings (`## Code style`), bullets, numbered lists, code fences all render cleanly in the agent's context.
- **Be concrete and scoped.** `"prefer async/await over .then()"` lands; `"write good code"` doesn't. Rules that apply repo-wide belong here; one-off task instructions belong in the chat message.
- **Don't duplicate tool instructions.** The system prompt already covers tool usage; redefining it here just fights with the maintained version.
- **Keep it short** if possible. Every request carries the full `.voidrules` content (no compaction, no trimming — it's part of the stable system-message prefix). 500-2000 chars is the sweet spot; multi-KB rule files inflate every turn's input tokens.
- Example that works well:
  ```markdown
  ## Code style
  - TypeScript: no `any`, prefer `unknown` + narrowing
  - Use named exports, avoid default exports

  ## When editing
  - Never modify files under `dist/` or `node_modules/`
  - Update tests alongside behavior changes

  ## When answering
  - Show file paths as `src/foo/bar.ts`, not absolute paths
  - Cite line numbers when referring to existing code
  ```
- Mental model: `.voidrules` is a *standing system-prompt addendum*, not a chat message. Phrase it as instructions to the model, not as a note to yourself.

**E2' token cost concern — cache-busting on rule edit (post-ship observation)** ✅ DONE (freeze-on-first-send)
- **Critical problem with current design**: `.voidrules` is embedded in the system message (the stable prefix). When the user edits `.voidrules` mid-session, the system message changes → `sysHash` flips → the **entire prefix cache is invalidated**. On a 200K-token conversation, a 2K-char rule edit causes the next request to pay for 200K+ uncached input tokens. The rules change is 2K; the cache miss cost is 200K. This is the wrong trade-off.
- **Root cause**: rules are in the wrong layer — or rather, they were being re-read from disk on every request, so any edit mid-session would immediately change the system message prefix and bust the cache.
- **Chosen fix (simpler than the original deferred plan)**: freeze rules after the thread's first send. No architectural change to where rules sit in the prompt; they stay in the system message prefix.
  - **Freeze mechanism**: on the first user send, `_addUserMessageAndStreamResponse` calls `getCombinedAIInstructionsAsync()` and stores the result as `ThreadType.frozenAiInstructions` (persisted). On every subsequent LLM request, `_runChatAgent` passes `frozenAiInstructions` to `prepareLLMChatMessages`, which uses it instead of re-reading from disk. The system message prefix is now byte-identical across turns on the same thread, keeping the provider's prefix cache warm.
  - **Rules-outdated indicator**: a `useRulesOutdated` React hook polls `getCurrentVoidRulesContent()` every 5 seconds and compares with `thread.lastAppliedRules`. When a mismatch is detected, a yellow banner appears above the input: `.voidrules changed on disk (at HH:MM)`. The timestamp is the moment the mismatch was first detected (within the poll window). Tooltip explains: "Rules are frozen for this thread. To apply the new rules, ask the agent to `read_file .voidrules`."
  - **No re-apply button**: the user manually instructs the agent to `read_file .voidrules` if they want the model to see updated rules. This keeps the system prompt stable while giving the user full control.
  - **Cache impact**: prefix cache is never busted by rule edits mid-thread. The only cache miss is on thread creation (new prefix). Edits to `.voidrules` are visible via the indicator but don't affect token costs.
  - **Multi-root folder labels**: in multi-root workspaces, each folder's `.voidrules` is prefixed with `[Rules for <folder>/]:` so the model can distinguish which rules apply to which repo. Single-folder workspaces are unchanged (no label). Applied to both the async disk-read path (chat) and the sync cached-model path (Fast Apply / Quick Edit).
  - *Files*: `convertToLLMMessageService.ts` (`frozenAiInstructions` param on `prepareLLMChatMessages`, new `getCombinedAIInstructionsAsync` public method, per-folder labels in `_getVoidRulesFileContentsFromDisk` and `_getVoidRulesFileContentsSync`), `chatThreadService.ts` (`frozenAiInstructions` field on `ThreadType`, `_setThreadFrozenAiInstructions` helper, freeze logic in `_addUserMessageAndStreamResponse`, pass-through in `_runChatAgent`), `SidebarChat.tsx` (`useRulesOutdated` hook + `RulesOutdatedBanner` component).

**E3 — Expanded `@`-mentions** (~1 day split across types)
- Two new `StagingSelectionItem` variants: `'GitDiff'` (args: `{ ref?: string }`, defaults to `HEAD`) and `'Problems'` (current diagnostics, scoped by optional folder URI). Resolver produces text content at attach-time, injected into the user message as a code block with a `[git diff @HEAD]` or `[problems in <path>]` header.
- Skip `@web` / `@docs` — redundant with MCP. Skip `@codebase` — that's Phase F (indexing).
- Skip `@pr` — niche, depends on `gh` CLI availability.
- Skip `@recent-changes` — mostly redundant with `@git-diff` once that lands.
- Impact: stop pasting `git diff` output and TypeScript error lists into chat manually.
- Risk: low. Pure context-plumbing, no model-behavior changes. Main work is the UI picker to surface the new types.

**E4 — Per-request telemetry log (Option A, pivoted from E3)** ✅ DONE
- *Pivot rationale*: user skipped E3 (`@git-diff`, `@problems`) after noting they never use git-diff as a mention even in Cursor. New primary goal stated: "minimise total token consumption for solving any questions." Rather than add features, we're building the instrumentation to diagnose token-waste — everything else downstream depends on being able to measure it.
- *What it logs*: one JSONL line per phase (`request` / `response`) per LLM chat call, into `<userRoamingDataHome>/voidRequestLogs/thread-<threadId>.jsonl`. Different threads → different files (user requirement, also simplifies correlation analysis). No message bodies, tool contents, file paths, or user text — only shape and counters, so files are safe to hand to external tooling or paste into an analysis session.
- *Four phases*:
  - `request` — fires right before the LLM call. Shape only, no bodies.
  - `response` — fires on `onFinalMessage` / `onError` / `onAbort`. Includes provider usage and the tool calls the model emitted.
  - `tool` — one line per tool execution (built-in + MCP), attributed to the `rid` of the LLM request that emitted the call.
  - `sysDiff` — fires ONLY when `sysHash` differs from the previous request on the same thread (Option B, sysDiff-on-flip). Carries a line-level diff of the two system messages so the offending bytes are visible. Zero extra bytes in the happy path. Capped at 8 KB combined content with proportional truncation on pathological flips.
- *Request-line fields*: `t`, `rid`, `tid`, `mode`, `provider`, `model`, `sysHash` (stringHash of post-rules-merge system message — **the cache-leak detector**), `sysLen`, `rulesLen`, `msgCount`, `sentChars`, `historyLen`, `lastMsgLen`, `lastMsgRole`, `compaction?` (`{trimmed, savedChars, savedTokens, emergencyTrimmed?, emergencySavedChars?, emergencySavedTokens?}`, omitted when nothing trimmed).
- *Response-line fields*: `t`, `rid`, `tid`, `status` (`ok` / `aborted` / `error`), `finishReason`, `durMs`, `usage.{in,out,cached,reasoning}`, `tools?` (`[{name, paramsLen, mcp?}]`, omitted when none), `errorMsg` (≤200 chars, no PII).
- *Tool-line fields*: `t`, `rid?`, `tid`, `name`, `status` (`ok` / `error` / `invalid_params` / `interrupted`), `paramsLen`, `resultLen?`, `durMs`, `mcp?`. `durMs` covers validation + auto-approval path + execution + stringification (human approval wait NOT included — the approved-re-entry path starts its own timer).
- *sysDiff-line fields*: `t`, `rid` (new), `prevRid?`, `tid`, `prevSysHash`, `newSysHash`, `prefixLines`, `suffixLines`, `oldLen`, `newLen`, `oldMid` (diverging lines from previous), `newMid` (diverging lines from new), `truncated?`. Emitted only on flip; carries literal prompt-section lines (non-user content in the common case, but may include `.voidrules` if that's what changed — dogfooding tag it).
- *Key signals unlocked for analysis*:
  - `sysHash` stable across consecutive requests on the same thread ↔ prefix-cache-friendly. If it changes when `.voidrules` didn't → system prompt has hidden volatility and every turn busts the cache. When a flip fires, the adjacent `sysDiff` line shows exactly which bytes drifted — `oldMid` / `newMid` point at the volatility source so it can be fixed at the prompt-assembly layer.
  - `usage.cached / usage.in` over many turns → empirical cache-hit rate per provider. If 0 across many turns on models that should support it (OpenAI-compat with `prompt_tokens_details.cached_tokens`, DeepSeek, etc.) → something's wrong upstream (request ordering, headers, whitespace drift).
  - `sentChars / usage.in` → empirical chars/token ratio per model; validates the calibration loop and the `charsPerToken` floor used by compaction/emergency-trim.
  - **Cost decomposition per turn**: `sysLen + historyLen + lastMsgLen ≈ sentChars`. If `historyLen` dominates → compaction / summarization ROI. If `sysLen` dominates → tool-prompt / rules pruning ROI. If `lastMsgLen` dominates on `lastMsgRole='tool'` → that tool's result is oversized (cross-ref with tool-phase `resultLen` distribution).
  - **Agent-loop depth per user send**: count request lines with `lastMsgRole='tool'` between two `lastMsgRole='user'` lines. One user message triggering 8+ LLM calls is the single biggest token multiplier; reveals over-iteration.
  - **Tool usage profile** (aggregate tool-phase lines):
    - frequency per `name` → which tools earn their prompt weight vs. which are noise. Candidates for prompt pruning if rarely called.
    - distribution of `resultLen` per `name` → which tools bloat the next turn's history. Candidates for compaction policy tuning.
    - failure rate per `name` (`status != 'ok'`) → wasted retry tokens; candidate for param-schema tightening or description clarification.
    - `paramsLen` distribution per `name` → spots models that stuff huge arguments (e.g. pasting whole code blocks into `replace_string`).
  - **Compaction effectiveness**: when `compaction` is present on request N, compare sysHash + sentChars on request N+1 to gauge "did compaction actually save bytes, and did it break the prefix cache?"
  - **Output inflation**: `usage.out / usage.in` — high ratios mean the model is yapping; `reasoning` share of `out` shows invisible thinking cost on reasoning models.
- *Rotation*: per-thread file capped at 5 MB; when exceeded, current file is moved to `thread-<id>.prev.jsonl` (overwriting any existing prev) and the live file starts fresh. Keeps ~2× cap per thread, unbounded thread count overall — delete threads or the whole folder to reclaim.
- *Write discipline*: in-memory append + 250ms debounced flush so a burst of agent-loop iterations coalesces into one read-concat-write. I/O failures retried up to 3× with re-queued lines; after that the batch is dropped with a `console.warn` to avoid unbounded buffer growth on persistent errors (e.g. disk full).
- *Files*: new `requestTelemetryService.ts` (interface + impl + singleton registration); `convertToLLMMessageService.ts` (inject service, accept `threadId`, emit request line, return `telemetryRequestId`); `chatThreadService.ts` (inject service, pass `threadId` through, log response line on `onFinalMessage` / `onError` / `onAbort`); `void.contribution.ts` (side-effect import to trigger registration).
- *Ephemeral callers*: `prepareLLMChatMessages` only logs when `threadId` is supplied. Commit-message generation, Fast Apply, Quick Edit, etc. don't pass one → they stay out of the per-thread files, keeping the log thread-scoped.
- *Restart note*: full Void quit + relaunch required (new singleton + new constructor deps on two eager services).
- *Next step after collecting a few sessions' worth of data*: eyeball `sysHash` stability and `cached` hit rate. If we see unexpected hash flips → hunt down the volatility source (probably something in `chat_systemMessage` / `chat_volatileContext` / rules injection that looks static but isn't). If `cached` is always 0 on providers that should populate it → audit the request path for header/whitespace drift. Either finding directly informs the next concrete token-reduction change.

**E5 — Auto-outline `read_file` for large files** ✅ done (core logic shipped)
- *Driving observation*: comparison with Zed's agent (see "Reference — Zed agent comparison" below) showed they auto-substitute a tree-sitter symbol outline for `read_file` when the file body exceeds 16 KB. This attacks the "agent reads a whole 3,000-line file when it only needs one function" pathology directly via **behavior change** rather than via prompt rule.
- *What shipped*:
  - `AUTO_OUTLINE_THRESHOLD = 30_000` chars in `prompts.ts`.
  - `BuiltinToolResultType['read_file']` changed to a discriminated union (`outlined: true | false`) in `toolsServiceTypes.ts`.
  - Three-tier fallback in `toolsService.ts`:
    1. **LSP `DocumentSymbolProvider`** — hierarchical symbol outline with `[Lstart-end]` ranges via `renderSymbolOutline()`. Works for all languages with a registered provider (TypeScript, Python, C++, etc.).
    2. **Markdown heading parse** — `renderMarkdownHeadingOutline()` scans for `#` headings with line ranges. Fires for `.md`/`.mdx` files when no LSP provider is available.
    3. **1KB truncation fallback** — for files with neither LSP nor markdown headings (lockfiles, plain text, etc.), returns the first 1024 chars with a "no outline available" header.
  - Anti-loop framing in `stringOfResult.read_file`: "Do NOT retry without line numbers — you will get the same outline."
  - UI hint in `SidebarChat.tsx`: `(outline)` label on outlined results.
  - `force_full` param was **dropped** — the agent's escape hatch is simply providing explicit `start_line`/`end_line`, which bypasses the outline path entirely.
- *Measured results* (DeepSeek R1-0528-Qwen3-8B, pricing: input $0.14/M, output $0.28/M, cached $0.0028/M):
  - Uncached tokens (the expensive input): **-27%** across a 2-question test (56.5k → 41.4k).
  - Total tokens sent went up +55% (more round-trips), but mostly cached.
  - Net input cost: **-22%** ($0.0082 → $0.0064). Savings compound on longer conversations since the outline (~2k chars) pollutes history far less than a full file dump (~170k chars).
- *Still pending (follow-up commits)*:
  - Rewrite `read_file` tool description in `prompts.ts` to document outline behavior to the model.
  - Settings toggle to enable/disable auto-outline.

**E6 — Selective prompt audit vs. Zed reference** (held — evidence-driven, post-E5 telemetry)
- *Premise*: after E5 ships and we have ~1 week of E4 telemetry showing the new `read_file` distribution, audit whether any `importantDetails` bullets have become redundant with the new behavior. The Zed reference comparison gives candidate trims; E4 telemetry tells us which trims are safe vs. which would re-open known model regressions.
- *Three Zed-isms worth borrowing if telemetry supports it*:
  - **Communication block** (terse: "be conversational, second-person user / first-person self, format markdown, NEVER lie, refrain from apologizing"). Compact replacement for some of the implicit tone guidance currently distributed across `importantDetails`. Zed gets ~5 lines from this where Void implicitly spends ~3 bullets.
  - **"DO NOT use tools to access items already available in the context section."** Void doesn't have this explicitly. Pairs naturally with the staging-selection / `@`-mention surface — if the user already attached `foo.ts`, agent shouldn't `read_file` it again at turn 1. Small clear win.
  - **Diagnostics rules**: "1–2 attempts at fixing diagnostics, then defer to the user. Never simplify code just to solve diagnostics." Pairs with `read_lint_errors`. Currently nothing in Void's prompt frames the iteration ceiling on lint-fix loops, and we've seen Nemotron + Gemma chase diagnostics into degenerate state on hard cases.
- *Three Zed-isms NOT to borrow*:
  - **Path-based code-block format** (`` ```path/to/file.ext#L123-456 ``). Renderer-coupled to Zed's chat UI; would break Void's existing `BlockCode` / `LazyBlockCode` rendering and the apply-button flow. Aggressive constraint with no clear payoff.
  - **Worktree-root-name path framing** ("path should always start with name of root directory"). Zed's project model is multi-worktree by design; Void's is workspace-relative. Adopting this would force a path-translation layer for no gain.
  - **`spawn_agent` sub-agent tool** (and the multi-agent delegation prompt section). Overkill for Void's current scope; the prompt section is non-trivial token weight; adds a whole new failure surface (sub-agent budget, isolated context, delegation scope policy).
- *Hard guardrail*: do NOT strip Phase A1+A2 / A3+A4 / Phase C bullets without a re-run of the benchmark Tasks 0/1/3/5 on Gemma 4 / MiniMax / Nemotron. Each one was measured into existence; removing them blind is a regression risk. The Zed reference is for *additions and replacements*, not for greenfield rewriting.
- *Out of scope*: deciding whether to merge `search_in_file` + `search_for_files` into a single `grep`-style tool (Zed's pattern). That's a tool-surface refactor with its own eval needs; track separately if the audit surfaces it as worthwhile.

**E7 — `fetch_url` built-in tool** ✅ DONE
- *Pain*: user pastes a link to docs / GitHub issue / API reference in chat, agent can't access it.
- *Implementation*: new built-in tool `fetch_url({ url })`. Agent calls it when it needs web content.
  - **IPC channel** (`fetchUrlChannel.ts`): runs in Electron main process (unrestricted network). HTTP fetch with 15s timeout, `User-Agent` header, redirect following.
  - **HTML → Markdown pipeline**: `linkedom` (DOM parser) → `@mozilla/readability` (article extraction) → `turndown` (HTML-to-Markdown). Strips nav/ads/footer, keeps article body. 30k char limit.
  - **Non-HTML fallback**: JSON/plain text returned as-is (truncated to limit).
  - **Browser-side service** (`fetchUrlService.ts`): `IFetchUrlService` proxies calls to main process via `void-channel-fetchUrl`.
  - **Tool registration**: `prompts.ts` (definition), `toolsServiceTypes.ts` (params/result types), `toolsService.ts` (validate/call/stringify).
  - **UI component** (`ToolResultComponents.tsx`): shows page title, URL (clickable), and a 500-char Markdown preview of the fetched content.
  - **Read-only**: no approval needed, available in both `gather` and `agent` modes.
- *Refactoring side-effects*:
  - Extracted shared helpers (`IconLoading`, `getRelative`, `getFolderName`, `getBasename`, `voidOpenFileFn`, `SmallProseWrapper`) from `SidebarChat.tsx` into `sidebarChatHelpers.tsx` to break a circular dependency between `SidebarChat.tsx` ↔ `ToolResultComponents.tsx`.
  - Fixed `.voidrules` banner showing a misleading timestamp on refresh (now omits time for pre-existing mismatches, only shows time when the change is detected during the session).
- *Tested*: GitHub issue page — Readability correctly extracted issue body, stripped GitHub chrome (nav, sidebar, footer). ~3-4k tokens of noise removed.
- *Future refinement*: GitHub issue comments may be missed by Readability (it treats the issue body as the "article"). Could add domain-specific fallback for `github.com` URLs to capture comments. Not needed for v1 — covers docs, blog posts, API refs, and issue bodies well.

**E8 — Search in chat** (planned)
- *Pain*: long threads have no way to find specific content. User has to scroll manually. Ctrl+F in the IDE searches the editor, not the chat panel.
- *Design*: search bar overlay (Ctrl+F or a search icon in the chat header). Matches against `displayContent` of all messages in the current thread. Highlights matches, arrow keys / Enter to navigate between them, scroll-to-match. Simple substring or case-insensitive text matching (no regex needed).
- *Dependency*: easier to implement before E9 (viewport rendering), since all messages are currently in the DOM and can be searched/highlighted directly.
- *Complexity*: Medium.
- *Priority*: **2nd** — do before virtualization while all messages are in the DOM.

**E9 — Viewport-based rendering (virtualized scroll)** ✅ DONE
- *Pain*: long threads (100+ messages with code blocks, diffs, tool results) slow down rendering. All messages are in the DOM even when off-screen.
- *Design*: lazy mount/unmount from the top — start with the newest message, adaptively fill the viewport (3× `VIEWPORT_FILL_FACTOR`), then expand/trim on scroll. `mountStart` state controls first mounted index; `previousMessages.slice(mountStart)` renders only the visible+buffered range. Scroll down to newest is always fast (few DOM nodes); scroll up loads history on demand.
- *Final approach — `flex-col` + wrapper-spacer + ResizeObserver*: messages render inside a wrapper `spacerRef` div with `overflow: hidden` and height controlled via direct DOM manipulation. Three complementary layers handle scroll stability:
  1. **`useLayoutEffect` sync** — fires synchronously on `mountStart`/`totalCount` changes. On expand (delta > 0): grow wrapper first, then `scrollTop += delta`. On trim (delta < 0): `scrollTop += delta` first, then shrink wrapper. This ordering prevents the browser from clamping `scrollTop`.
  2. **`ResizeObserver` on `contentRef`** — catches content height changes outside of expand/trim (e.g., `LazyBlockCode` placeholder → Monaco swap). Syncs wrapper height and compensates `scrollTop` immediately. Skips `scrollTop` compensation when panel width changed (reflow from resize should not shift the viewport). Uses a `mountChangeRef` flag to avoid double-adjustment with the `useLayoutEffect`.
  3. **`LazyBlockCode` height-lock** — minimizes the delta at source. Captures the placeholder's `offsetHeight` before the swap, locks the wrapper's `height`, clears via `onReady` callback after Monaco's first `resize()`.
- *Approach explored & reverted — `flex-direction: column-reverse`*: puts `scrollTop=0` at the bottom (newest). Old messages live at the far end of the scroll range — adding/removing them doesn't affect `scrollTop` (zero manual scroll compensation). Proved via logging that `scrollDelta=0` on every expand — the approach is correct. However, **column-reverse anchors at the bottom**: when the user scrolls far up and resizes the window, the shift is much larger than with a top-anchored layout. Normal `flex-col` (top-anchored) is closer to the viewport when scrolled up, so resize shifts are small. Reverted in favor of wrapper-spacer approach.
- *Interaction with E8*: search needs to be able to scroll to and mount messages that are outside the current viewport window.
- *Files*: `SidebarChat.tsx` (wrapper-spacer virtualization, `useLayoutEffect` sync, `ResizeObserver`, scroll handler), `inputs.tsx` (`LazyBlockCode` height-lock fix, `BlockCode` `onReady` callback).

**E10 — Sticky question header** ✅ DONE
- *Pain*: in long conversations, after scrolling down into the response, the user loses sight of which question the assistant is answering. They have to scroll back up to re-read the question.
- *Design*: a sticky overlay that pins the last user message that scrolled above the viewport top. Uses direct DOM manipulation (no React re-renders on scroll). Detects user messages via `data-user-msg-idx` attribute and `getBoundingClientRect()`. Triggers as soon as the message's top edge crosses the viewport top (`rect.top < containerTop`) so the transition is seamless — no gap where the message disappears before the sticky appears.
- *Push effect*: when the next user message approaches the top, the sticky header's `maxHeight` shrinks so it clips from the bottom, creating a "push up and out" animation.
- *Trimmed messages*: messages virtualized out of the DOM (`mountStart > 0`) are checked via `previousMessagesRef` to ensure the sticky still shows the correct question even when the original element is unmounted.
- *Files*: `SidebarChat.tsx` (`updateStickyQuestion` callback, `stickyHeaderRef`/`stickyTextRef` refs, scroll handler integration, absolute overlay in JSX).

**E11 — LaTeX / math equation rendering in chat** ✅ DONE
- *Pain*: math-heavy responses (physics, ML, optimization) render formulas as raw `$\frac{a}{b}$` text — unreadable.
- *Implementation*: KaTeX (`katex` npm package) renders `$...$` (inline), `$$...$$` (display), `\(...\)`, and `\[...\]` delimiters. Single unified regex (`LATEX_RE_SOURCE`) handles all four delimiter types in one pass.
- *Rendering pipeline*:
  - `splitLatexSegments()` splits paragraph `raw` text into `{type: 'text' | 'latex', content}` segments.
  - Text segments go through `ChatMarkdownRender` with `inPTag={true}` so markdown formatting (bold, italic, code) is preserved between equations.
  - LaTeX segments go through `LatexRender` which uses `katex.render()` (DOM-based, not `renderToString`) to write directly to a ref element. This avoids `innerHTML` / `dangerouslySetInnerHTML` which are blocked by VS Code's Trusted Types CSP.
- *Output mode*: `output: 'html'` with KaTeX CSS loaded via `vscode-file://` protocol. CSS `<link>` tag injected at module init, path derived from `document.baseURI` → `node_modules/katex/dist/katex.min.css`. Font `url()` paths resolve correctly since the browser resolves them relative to the CSS file location.
- *Iterations before landing*:
  1. `dangerouslySetInnerHTML` → blocked by Trusted Types CSP.
  2. `trustedTypes.createPolicy('voidKatex')` → policy name not in CSP allowlist.
  3. `katex.render()` + `output: 'mathml'` → works but accent rendering (`\hat{}`, `\tilde{}`) poor (browser MathML engine vs KaTeX's math fonts).
  4. `katex.render()` + `output: 'html'` + CSS via `vscode-file://` → final solution, proper font rendering.
- *System prompt*: added LaTeX support hint to `importantDetails` in `prompts.ts` so the agent knows it can use math notation.
- *Files*: `ChatMarkdownRender.tsx` (KaTeX import, CSS loader, `LatexRender` component, `splitLatexSegments`, paragraph handler), `prompts.ts` (LaTeX hint), `package.json` (`katex` dependency).

**Execution order & commit strategy**
- E1 ✅ done (own commit). E2 pivoted into E2' (`.voidrules` fix + chip) ✅ done (own commit). E2' cache-busting fix (freeze-on-first-send + indicator) ✅ done. E4 (per-request telemetry) ✅ done (own commit) — supersedes E3. E5 ✅ core logic shipped (own commit).
- E9 ✅ done (viewport rendering + code block height fix). E10 ✅ done (sticky question header). E11 ✅ done (LaTeX rendering). D2 ✅ done (editing philosophy + formatting). D3 ✅ done (agent persona). **Up next**: E8 (search in chat). E5 dog-food continues passively. E6 evaluation after E5 data. E7 ✅ shipped.
- **After E5 dog-food**: evaluate E4 telemetry data (resultLen distribution on `read_file`, follow-up-with-ranges hit rate) before deciding whether E6 is worth doing.
- After each phase, dog-food with a one-day daily-use window before committing the next. If a phase's real-world impact is smaller than projected (or reveals a different problem), the later phases can be resequenced / dropped.
- Phase D deferred below — no observed pain to justify it.
- Phase F (indexing) held pending Phase E daily-use data.

**Phase D — Output structure (optional polish, deferred)**
- Ask the model to emit `<plan>...</plan>` blocks at the start of multi-step tasks, with per-step checkbox markers.
- Parse plan blocks in `ChatMarkdownRender` and render as collapsible checklists (Cursor/Claude Code style).
- Honest caveat: this is UI polish, not a capability upgrade. No concrete pain in eval logs or prior sessions points to it. Re-open only if daily use reveals "lost track of what the agent was doing on a long task" as a recurring symptom.

**Phase F — Codebase indexing / semantic search (held)**
- The single biggest capability gap vs. Cursor (see audit above). Not deferred because it's unimportant — held pending Phase E daily-use data, because the Phase E tools (especially LSP + rules) might partially substitute for semantic search on small/medium codebases.
- Rough scope (to refine when this actually starts): local embeddings via Ollama's `/api/embeddings` endpoint (no external services, reuses existing Ollama infra); SQLite-backed vector store; file-watcher-driven incremental reindex with debounce; new `semantic_search` tool in `prompts.ts` alongside the lexical tools (hybrid, not replacement); `.gitignore` + `.voidignore` respect.
- Estimated: ~1-2 weeks of focused work. Not a weekend project.
- Decision trigger: after ~2 weeks of Phase-E-enabled daily use, if the symptom "agent fished for the right keyword via lexical search" still dominates the pain log → commit to Phase F. If Phase E subsumes it → keep deferred.

### Reference — OpenCode + Oh-My-OpenAgent + Karpathy LLM Wiki analysis (May 2026)

Audited three external codebases/docs against Void's objective ("code editor first with chat panel"):
- **OpenCode** (`/Users/david.halim/Documents/Projects/opencode`): open-source TUI AI coding agent. Monorepo, Bun/Effect-ts, SQLite, ai-sdk. 7 model-specific system prompt variants.
- **Oh-My-OpenAgent** (`/Users/david.halim/Documents/Projects/oh-my-openagent`): plugin for OpenCode adding multi-agent orchestration (Sisyphus/Hephaestus/Prometheus/Atlas), category-based model routing, hash-anchored edits, skills system, team mode.
- **Karpathy's LLM Wiki** (`docs/karpathy-llm-wiki.md`): pattern for persistent LLM-maintained knowledge bases — raw sources → wiki layer → schema. Relevant in spirit (compounding context vs re-deriving per query).

**Feature analysis — what's worth building:**

| Priority | Feature | Source | Rationale |
|---|---|---|---|
| **High** | Prompt Phase D2 (editing philosophy + formatting) | OpenCode GPT/Gemini prompts | ~125 new tokens: editing philosophy ("minimal changes", "don't extract single-use helpers", "no speculative backward-compat"), response formatting ("flat lists", "`file:line` code refs"), security reminder, anti-stalling. High behavioral impact, no eval risk. |
| **High** | Shadow-git checkpointing | OpenCode `snapshot/index.ts` | Per-agent-turn file snapshots via shadow git. Undo agent actions without touching user's git. Huge trust builder. |
| **High** | Auto-approve mode for read-only tools | OmO Ralph Loop / ultrawork | Toggle that auto-approves reads/searches, prompts only for writes. Reduces friction for experienced users. |
| **High** | Per-task model routing | OmO category system | Classify user intent (simple edit vs architecture vs frontend) and auto-select best model from configured set. Void already has per-conversation model persistence — this is the next step. |
| Medium | Heavy-tier compaction with anchored summaries | OpenCode `compaction.ts` | LLM-generated summary replacing old messages. Anchored pattern (update previous summary, don't regenerate) is cheaper and more stable. Extends existing Light tier. |
| Medium | Additional LSP tools (`documentSymbol`, `workspaceSymbol`) | OpenCode `lsp.ts` | `documentSymbol` = file overview without reading full body. `workspaceSymbol` = project-wide symbol search. Reduces grep-fishing. |
| Medium | Project Context Cache | Karpathy Wiki insight | Persistent LLM-maintained project summary (architecture, key files, conventions). Updated incrementally on file changes. Consulted at query time instead of expensive grep/read cycles. |
| Lower | Hash-anchored edits | OmO Hashline | Content-hash tags per line. Edits reference hashes — stale reads rejected. Trade-off: reliability vs token cost. Prototype for weaker models. |
| Lower | Workspace profiles | OmO skills (simplified) | Project-type-aware prompt extensions. Detect React/Python/etc and load relevant guidance. |
| Lower | Codebase health check | Karpathy "Lint" operation | Slash command: audit for stale TODOs, dead code, inconsistent patterns. |

**Prompt comparison — Void vs OpenCode vs OmO:**

Void's prompt architecture is stronger in two critical ways:
1. **Phase B caching layout** (`[stable sys][history][volatile + user]`): neither OpenCode nor OmO does this. They embed environment info in the system prompt, breaking prefix cache on every turn.
2. **Empirically validated rules**: each bullet (A1-A4, C1-C6, E1) has eval data against multiple models with token counts and success rates. OpenCode and OmO prompts are designed by intuition.

Gaps identified in Void's prompt (actionable additions for Phase D2):
- **No editing philosophy.** OpenCode GPT: "best changes are often the smallest", "keep things in one function unless composable", "don't add backward-compat code without concrete need". Void has nothing equivalent — model defaults to over-engineering.
- **No response formatting rules.** OpenCode GPT: "flat lists only", "short Title Case headers", "inline code for paths/functions". Void only says "use MARKDOWN, no tables".
- **No code reference format.** OpenCode: "When referencing code, use `file_path:line_number`." Void models default to inconsistent styles.
- **No security reminder.** "Never introduce code that exposes or logs secrets." ~15 tokens.
- **No anti-stalling.** OmO beast: "When you say you will do X, actually do X in the same turn." ~15 tokens.
- **No concurrent-edit safety.** OpenCode GPT: "If you notice unexpected changes you did not make, continue with your task. NEVER revert." ~25 tokens.

What NOT to adopt:
- Output length caps ("fewer than 4 lines") — too restrictive for IDE.
- Model-specific prompt variants — maintenance burden outweighs benefit; Void's single prompt is already eval-validated across models.
- Intent verbalization (OmO "I detect [type] intent") — adds latency and visible noise.
- TodoWrite emphasis (OpenCode Anthropic) — clutters output for IDE context.
- Beast-mode aggressive autonomy ("EXTENSIVE INTERNET RESEARCH") — too aggressive for local code editing.

**Phase D2 — Prompt editing philosophy + response formatting** ✅ *Implemented*

Concrete additions to `chat_systemMessage` in `prompts.ts`:

1. **Editing philosophy** (agent mode only, after A4 bullets):
   - Prefer the smallest correct change. Don't extract single-use helpers, don't add backward-compatibility code without concrete need (persisted data, external consumers, explicit requirement).
   - Follow existing code conventions: naming, structure, framework choices, imports. Read surrounding code before editing.

2. **Response formatting** (all modes, after markdown bullet):
   - When referencing code, use `file_path:line_number` format.
   - Keep lists flat (single level). If you need hierarchy, split into separate sections.

3. **Safety** (agent mode, after workspace permission bullet):
   - Never introduce code that exposes, logs, or commits secrets, API keys, or credentials.
   - If you notice unexpected file changes you did not make, continue with your task — do not revert changes made by the user or other processes.

4. **Anti-stalling** (agent mode, in action rules):
   - When you say you will do something, do it in the same turn. Don't announce actions without executing them.

Estimated total: ~125 tokens added to system message.

Files: `prompts.ts` (`chat_systemMessage` — new bullets in `importantDetails`).

**Phase D3 — Agent persona improvement** ✅ *Implemented*

Sharpen persona identity and communication style in the `header` of `chat_systemMessage`. Sources: OpenCode GPT/default prompts, OmO Sisyphus, Zed agent. Filtered for IDE chat agent relevance — no CLI, multi-agent, or output-cap patterns.

Changes to `header` in `prompts.ts`:

1. **Persona identity**: "a senior software engineer" → "a pragmatic senior software engineer ... in a code editor". Anchors character to IDE context.

2. **Per-mode role voice** (replaces generic "focused on developing/searching/coding" clauses):
   - **agent**: "You work autonomously — investigate, implement, and verify without waiting for permission on each step."
   - **gather**: "You research the codebase — find, read, and synthesize code to give grounded answers."
   - **normal**: "You answer questions and suggest edits, describing code changes precisely in code blocks."

3. **Communication style block** (new paragraph after ownership, ~45 tokens):
   - Anti-flattery: don't open with "Got it", "Great question!", "Sure!".
   - Professional objectivity: prioritize technical accuracy over agreeing with the user; state concerns and propose alternatives.
   - Style matching: terse question → terse answer.

No overlap with `importantDetails` — existing anti-hedging (A2), anti-padding (A2), honesty, and editing philosophy (D2) bullets untouched. ~45 tokens added to stable system prefix (cacheable).

Files: `prompts.ts` (`chat_systemMessage` — `header` const, lines 512-520).

### Backend (named endpoint) support ✅ *Implemented*

**Goal:** Let users configure multiple named OpenAI-compatible endpoints ("backends") — e.g. corporate proxies, self-hosted models — and use them alongside built-in providers without special-casing.

**Architecture:**
- `BackendId = \`backend_${string}\``, `BackendProtocol = 'openAI' | 'anthropic' | 'gemini'`, `ProviderName = BuiltInProviderName | BackendId`.
- Backends stored in `state.backends: Record<BackendId, BackendProviderSettings>`, merged into `settingsOfProvider` at runtime by `_validatedModelState`, stripped before persisting in `_storeState`. Runtime code accesses `settingsOfProvider[providerName]` uniformly for both built-in and backend providers.
- `displayInfoOfProviderName` resolves backend display names via a module-level `_backendDisplayNames` registry, populated by `registerBackendDisplayNames` (called in both browser and main processes).

**What shipped:**
- Settings UI: Backends tab for creating/editing/deleting backends (endpoint, API key, headers, protocol, display name).
- Models tab: backend models shown alongside built-in provider models; add/toggle/delete/reorder all work.
- LLM dispatch: `sendLLMMessage.ts` routes backends to the correct implementation based on `protocol`. `newOpenAICompatibleSDK`, `sendAnthropicChat`, `sendGeminiChat` all handle backend settings (endpoint, apiKey, headers).
- Error messages: 401 errors now show actual server message instead of generic "Invalid API key". Backend display names shown in errors via main-process registry.
- `modelCapabilities` falls back to protocol-based lookup for backends.

**Files modified:** `voidSettingsTypes.ts`, `voidSettingsService.ts`, `modelCapabilities.ts`, `sendLLMMessage.ts`, `sendLLMMessage.impl.ts`, `Settings.tsx`, `ModelDropdown.tsx`.

### Model defaults improvements ✅ *Implemented*

- **Unrecognized model defaults**: `contextWindow` 4k→128k, `reservedOutputTokenSpace` 4k→8k, `supportsSystemMessage` false→`'system-role'`. Affects all unrecognized models including backend models.
- **Advanced settings dialog**: Now shows all default values including `false` (was filtered by truthy check).
- **DeepSeek V4 reasoning effort**: Added `reasoning_effort` slider with values `['high', 'max']` (default `'high'`). Payload includes both `thinking: { type: 'enabled' }` and `reasoning_effort` when reasoning is on.
- **Auth error messages**: 401 errors now show the actual server message instead of generic "Invalid API key" for all protocols.

### Reference — Zed agent comparison (read for inspiration, partial harvest planned via E5/E6)

Audited Zed's `crates/agent` (added to workspace as `Projects/zed`) against ours in Apr 2026. The user's hypothesis going in was "Zed feels more token-efficient." Confirmed; here's where the gap actually lives.

**Headline numbers**:
| | Void | Zed |
|---|---|---|
| System prompt source | `prompts.ts` 1212 lines (`chat_systemMessage` ~155-line generator) | `crates/agent/src/templates/system_prompt.hbs` 233 lines |
| Rendered system prompt (rough) | ~3–4k tokens incl. XML tool defs / ~1.5–2k stable + native tool schemas | ~700–1,200 tokens whole thing |
| `read_file` on a 3,000-line TS file | Returns full body (paginates at 500k chars, basically never triggers) | Returns symbol outline auto-substituted at 16,384 byte threshold; tool description and result text both reinforce "use line numbers to read specific symbols, do NOT retry without ranges" |
| Tool description style | Paragraph per tool + reinforced `importantDetails` C5 bullet + `terminalDescHelper` enumerating alternatives (Phase C three-surface pattern) | 5–15 lines per tool, no reinforcement section |
| Sent on every turn (system + tool defs) | ~2.5–3× larger than Zed's | baseline |

**Why Zed is more compact, by design choice (not laziness)**:
- **Auto-outline-on-read replaces a prompt rule with deterministic behavior.** Their `outline.rs:10` constant (`AUTO_OUTLINE_SIZE: 16384`) does what our A4 bullet ("don't re-read files you've already read this turn") + Phase C5 ("don't shell out to `cat`") do *partially* — Zed gets it 100% by making the tool itself refuse to dump the whole body. Behavior > rules for token efficiency every time.
- **Single `edit_file` with `mode: 'edit'|'create'|'overwrite'`** instead of three separate tools (Void: `edit_file` + `rewrite_file` + `create_file_or_folder`). One description tax instead of three.
- **Single `grep` tool** covers what Void splits into `search_in_file` + `search_for_files` (project-wide regex with optional `include_pattern` glob). Same effective coverage, fewer descriptions.
- **No LSP nav tools** (`go_to_definition`/`go_to_usages`); Zed relies on grep + auto-outline. They're betting strong models (Claude/GPT) figure it out from the outline; Void's E1 was earned because Gemma/Nemotron need explicit help.
- **`update_plan` tool exists** (Phase D in Void's roadmap, deferred). Zed's planning prompt section is conditional on the tool being available, so it doesn't tax prompts where the user disabled it.

**Why Zed-style minimalism would NOT just port wholesale**:
- **Different model distribution.** Zed targets Claude/GPT primarily (their owned cloud). Void supports Gemma 4 / Nemotron / MiniMax / DeepSeek alongside the frontier models. Phase A1+A2 / A3+A4 / Phase C eval data shows Gemma-class models fall back to `grep -r` for symbol search and run redundant verification commands without the C5 + A4 bullets. Trimming to Zed's line count would re-open the regressions those phases closed. Zed presumably has the same regressions on weaker models; we just don't have data on Zed running them, and they may not care.
- **Earned bullets, not arbitrary bullets.** Every line in `chat_systemMessage`'s `importantDetails` traces to a measured eval. The list looks bloaty until you read each entry's `note.md` rationale. Stripping based on aesthetic is a regression-machine.
- **Phase B caching layout** (`[stable sys][history][volatile + user]`) is a Void-only optimization Zed doesn't do. Trimming `chat_systemMessage` indiscriminately could break the prefix-cache contract — anything volatile that sneaks back into the system message busts cache for the whole thread.
- **Mode-specific guidance** (agent / gather / normal) is a Void-only structural choice. Zed has one mode. Folding modes together is a separate decision with its own eval needs; not a Zed-comparison consequence.

**What's actionable to borrow** (with concrete plan):
- **Auto-outline `read_file`** — see E5 above. ✅ Shipped. Measured 22% input cost reduction, 27% uncached token reduction.
- **Communication block compactness** — extract general tone rules into a brief leading section; modest token savings; held for E6.
- **"Don't refetch context already in conversation" rule** — explicit in Zed, implicit in Void via A4. Worth lifting verbatim in E6.
- **Diagnostics 2-attempts-then-defer rule** — pairs with `read_lint_errors`; addresses an under-covered failure mode (lint-fix loops on hard cases). E6 candidate.

**What NOT to borrow**:
- **Path-based code-block format** (`` ```path/to/file.ext#L123-456 ``). Renderer-coupled to Zed's chat UI. Would break Void's existing apply-button + `LazyBlockCode` flow. Aggressive constraint with no clear payoff.
- **Worktree-root-name path framing**. Zed's project model is multi-worktree; Void's is workspace-relative. Adopting this would force a path-translation layer for zero gain.
- **`spawn_agent` sub-agent tool**. Overkill for current scope; non-trivial prompt weight; adds a delegation/budget/scope policy surface we don't need yet.
- **Outright prompt minimalism**. Earned bullets lose model coverage on weaker models. The Zed reference is for additions and replacements, not greenfield rewriting.

**Open evaluation questions (post-E5)**:
- After E5 ships, does median `read_file` `resultLen` drop on E4 telemetry? Target: 30%+ reduction on files > threshold. If less, threshold's wrong or the agent isn't following up with ranged reads.
- Does the agent successfully follow an outline result with a ranged read in **the next turn** (no wasted retries, no full-file re-reads)? Watch for model × model variance: MiniMax/Claude likely yes, Gemma/Nemotron may need stronger anti-loop wording in the result text.
- Does outline-mode adoption let us safely trim any A4 bullets in E6, or do they continue to land on semantic over-iteration (running redundant verification, post-edit re-search) that auto-outline doesn't address?

### Reference — side experiment in `/Users/david.halim/Documents/Projects/test/void` (not committed, not decided)

Separate scratch clone where an alternative `prompts.ts` was drafted against *upstream* main (so it does not include A1+A2 or Phase B from our fork). Nothing here is a plan of record — keeping it as input material for when Phase C / A3+A4 is actually worked on.

*Patterns worth borrowing when Phase C lands:*
- `"Use this to [purpose]. [Context]. [Qualifier]"` framing on every tool description. Gives weaker models (Gemma, Nemotron) a decision rule, not just a capability statement. Current descriptions are capability-only.
- Concrete examples in param descriptions rather than prose constraints. E.g. `search_pathnames_only.include_pattern`: `"(e.g., '*.ts' to only TypeScript files)"` instead of `"Only fill this in if you need to limit your search because there were too many results"`. Examples land with capable models where prose doesn't (matches the "unenforceable rules" observation on the no-tables rule).
- WARNING-style shaping on destructive tools: `rewrite_file` gets `"WARNING: This deletes all existing content - use edit_file for targeted changes instead."`; `delete_file_or_folder` gets `"Use with caution - consider backing up or confirming with the user before deleting important files."` Cheap, high-signal.
- Thematic section comments inside `builtinTools` (e.g. `// --- Context Gathering Tools ---`, `// --- File Editing Tools ---`, `// --- Terminal/Shell Tools ---`) — code-only, invisible to the model, but makes the file easier to edit correctly.

*Structural ideas worth borrowing when Phase A3+A4 lands:*
- Thematic grouping inside `importantDetails` (quality/certainty / safety / planning / tool-usage sub-sections) reads cleaner than a flat numbered list, and makes it easier to spot over-iteration compounding across rules that look unrelated individually.
- Per-mode role descriptions with distinct voices (agent = "autonomous... take ownership... see through to completion" / gather = "research assistant" / normal = "coding assistant") is cleaner than a single branched paragraph. Compatible with A1+A2's senior-engineer persona if we keep the pair-programmer framing at the top and specialize the tone per mode underneath.
- `"Verify your changes work by running tests or commands when appropriate"` is a concrete gap in the current prompt — agent mode has "maximal certainty BEFORE" but nothing about post-hoc verification. Small, targeted addition; pairs naturally with A4's rebalancing.

*Things to explicitly NOT copy when borrowing from this reference:*
- Do not drop the `start_line` / `end_line` "Do NOT fill this field in unless you were specifically given exact line numbers" guardrail. That rule exists because Gemma/Nemotron hallucinate line numbers. The reference version replaces it with plain `"Line number to start reading from. Defaults to beginning of file."` — a regression on the models we care most about.
- Do not stack 5 new analytical rules (`"explore more files"`, `"think step-by-step"`, `"break down complex tasks"`, `"think through the full impact"`, `"when uncertain explore more"`) on top of existing `"maximal certainty BEFORE"` + `"as many steps as needed"`. The Phase A1+A2 evaluation already documented this exact compounding (Nemotron +90% tokens; MiniMax +18%; Gemma search-loop). A4's job is to **rebalance** — every new rule should retire or rephrase an existing one, not pile on.
- Do not drop the A2 anti-hedging directives (commit-to-one-solution / act-don't-describe / no-padded-offers). A2 eliminated Nemotron's trail-off; losing them would re-open that.
- `console.log('CHAT MODE:', mode)` in the reference is leftover smoke-test debug from Task 1. Not prompt content.
- Reordering to `[role][tools][sysInfo][importantDetails][fsInfo]` is fine for behavior but would need to play nicely with Phase B's caching layout (`[stable sys][history][volatile + user]`). Worth checking that nothing volatile sneaks into `sysInfo` if we adopt this ordering.

*Open evaluation questions (for when we actually do Phase C / A3+A4):*
- Benchmark Tasks 0/1/3/5 on MiniMax + Gemma 4 26B + Nemotron against the reference version vs our current A1+A2 baseline, to ground the "borrow these patterns" decisions in data instead of taste.
- Specifically: did MiniMax's TTFT regress with the longer, more directive tool descriptions? (Longer system message → more bytes to process before first output token. Could matter on MiniMax where TTFT is already slow.)

### Verification

After each prompt phase, rerun the benchmark tasks (see Benchmark section) on Gemma 4 31B with fixed random seed / temperature settings, and record: task completion rate, hedge-word count in responses, tool-call efficiency (useful calls vs. retries), and cached-token ratio. Phase A should bump completion rate and drop hedge words. Phase B should bump cache ratio on long sessions. Phase C should drop terminal-tool usage for file ops. Phase D is subjective — judge by whether the plan UI actually helps you track progress.

### Next — Image support in chat (design sketch)

**Goal:** Let users paste/drag-drop images into the chatbox. If the primary model supports vision, send the image natively. If not, a configured "vision helper" model describes the image at send time, and the text description is included instead.

**Step 1 (MVP): Native image upload for Gemma / Gemini** ✅ *Implemented*
- Added `Image` type to `StagingSelectionItem` (disk-backed via URI, no inline base64 in DB):
  ```
  { type: 'Image'; uri: URI;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    fileName: string; state: { wasAddedAsCurrentFile: false } }
  ```
- ✅ Paste (`onPaste`) and drag-drop (`onDrop`) handlers in `VoidChatArea` save image to disk (`voidImages/<uuid>.<ext>`) and create staging item.
- ✅ Image chip in staging area with `ImageIcon`, filename label, and tooltip showing `fileName (mimeType)`.
- ✅ `convertToLLMMessageService._chatMessagesToSimpleMessages` reads image files from disk and attaches `ImageAttachment[]` to user `SimpleLLMMessage`.
- ✅ OpenAI-compat path: user messages with images emit structured `content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:...' } }]`.
- ✅ Gemini path: injects `{ inlineData: { mimeType, data } }` into user message parts after Anthropic→Gemini conversion.
- ✅ `supportsVision?: boolean` added to `VoidStaticModelInfo`. Set `true` for all Gemini models, GPT-4o, GPT-4o-mini. Default `false`.
- ✅ `messageOfSelection` returns `[Image attached: <fileName>]` for text-only fallback.
- **Test:** Paste a screenshot into the chatbox with Gemma/Gemini selected → model should see and respond to the image content.

**Step 2: Vision helper fallback** ✅ *Implemented*
- ✅ Added `'VisionHelper'` to `featureNames` as a new feature slot with its own model dropdown in Settings.
- ✅ `modelFilterOfFeatureName['VisionHelper']` filters to only show models with `supportsVision: true`.
- ✅ Settings UI section under the SCM section with a `ModelDropdown` for selecting the helper model.
- ✅ Vision helper prompt (`visionHelper_systemMessage`, `visionHelper_userMessage`) uses "visual assistant for another AI" framing.
- ✅ At send time (`chatThreadService._addUserMessageAndStreamResponse`):
  - Checks if any staged items are `Image` type.
  - If primary Chat model supports vision → images go through natively (no change).
  - If primary model does NOT support vision AND a VisionHelper model is configured:
    - Fires a one-shot `sendLLMMessage` call per image with the image as a multimodal content part.
    - Injects description into `ChatMessage.content` (LLM-facing) with delimited format:
      `[Image: filename]\n--- start description ---\n<description>\n--- end description ---`
    - `displayContent` stays as the user's original text — user sees the image thumbnail via selections.
    - Description is persisted in `content` so it's not re-generated on subsequent turns.
  - If no VisionHelper configured → placeholder text asking user to configure one.
- **Latency:** The vision helper call happens at send time. Typically 1-3s for Gemini Flash.

**Step 3: Polish**
- ✅ Image preview in chat bubbles — 24x24 thumbnail with click-to-expand lightbox.
- ✅ Multiple images per message — works out of the box via staging selections.
- ✅ Compress/resize large images at paste time — Canvas API resizes to max 1024px on longest side, PNGs re-encoded as WebP, JPEG/WebP at 0.85 quality. GIFs skipped to preserve animation.
- ✅ Images stored on disk with URI reference (not inline in DB). Deferred write: in-memory blob until send, then flushed to `voidImages/<uuid>.<ext>`.
- ✅ Image lifecycle management — image files deleted when messages/threads are removed. Single `_deleteOrphanedImages` function handles all deletion paths (thread delete, edit, checkpoint restore). Uses retained-set comparison so shared images are never prematurely deleted.
- ✅ Vision helper + native LLM read from memory first — both `_describeImagesWithHelper` and `_chatMessagesToSimpleMessages` check `pendingImageBytes` map before falling back to disk. Bytes flow from React layer → `addUserMessageAndStreamResponse` → thread-keyed map → `prepareLLMChatMessages`. Cleared after first agent-loop request.
- ✅ Transactional image flush — disk write happens after message persist (inside `_addUserMessageAndStreamResponse`), not before. In-memory bytes are available for both vision helper and native LLM, so no dependency on disk write completing.
- ✅ Per-image description caching — `cachedDescription` field on Image selection type. Descriptions travel with selections on edit (no regex parsing from content). Only new/replaced images need re-describing; unchanged images reuse their cached description.
- ✅ Vision helper prompt with conversation context — user's current message is passed as a "context hint" so the helper prioritizes relevant parts of the image (e.g. error text when user says "fix this"). Explicit "do NOT answer" guard prevents the helper from trying to respond to the user's question.

**Architecture notes:**
- The `StagingSelectionItem` approach means images flow through the same staging → message pipeline as files and code selections. No new message types needed.
- The vision helper is a separate, isolated LLM call — it doesn't share context with the main conversation. This keeps it simple but means it can't tailor descriptions to the conversation.
- Token cost: a 512x512 image costs ~250-500 tokens as a vision input. A text description from the helper is typically 200-500 chars (~50-100 tokens). The helper approach is ~5x cheaper in subsequent turns since the description doesn't grow with re-reads.

### Backlog / Open ideas

- **`read_file` contract clarity** — the tool description claims "Returns full contents of a given file" but actually paginates at `MAX_FILE_CHARS_PAGE`. Weak models distrust the "truncated" output and fall back to terminal `cat`. Fix: update description to "Returns contents of a file, paginated. If truncated, increment `page_number` to continue." and document `page_number` properly. User deprioritized this for now since most daily files fit in one page; revisit if cross-chunk reads start causing friction.
- **`toOpenAICompatibleTool` unused `paramsWithType`** — `sendLLMMessage.impl.ts` builds a properly-typed properties map on lines 214–215 but then uses the raw untyped `params` on line 225. Minor code bug: OpenAI-style tool schemas go out without `type: 'string'` on each property. Most OAI-compatible servers tolerate this, but it's strictly worse than the Gemini path's schema. Two-line cleanup.
- **Anthropic token usage tracking** — `sendAnthropicChat` currently doesn't populate `latestUsage`, so Claude models display nothing in the `TokenUsageRing`. Would mirror the existing OAI/Gemini pattern.
- ~~**True summarization / compaction**~~ — promoted to Next → Perf 2 above.
- **Per-provider `defaultSupportsSystemMessage`** — same pattern as `defaultSpecialToolFormat`. Lower priority — most providers already get the right value via the regex fallback hitting `openSourceModelOptions_assumingOAICompat`. Only matters for truly unrecognized model names. Honest impact: small reduction in instruction-following + slightly worse caching, not a visible breakage.
- **Endpoint profiles / capability bundles** — once we have 2+ per-provider default fields, replace the ad-hoc `default<Field>` slots with a single `endpointProfile: Partial<VoidStaticModelInfo>` slot, plus named bundles like `OAI_COMPAT_PROFILE`, `ANTHROPIC_PROFILE`, `GEMINI_PROFILE`. The profile captures "this kind of wire-protocol endpoint behaves this way" once and is reused across all providers that share it. Resolution chain becomes: `globalDefaults → endpointProfile → perProviderOverride → perModelEntry → regexFallback → userOverride`. Defer until we'd otherwise be repeating the same field across 3+ providers — until then YAGNI.
- **Strip cross-provider `gemini-style` leak** — `extensiveModelOptionsFallback` returns `'gemini-style'` for Gemini-named models even when served via OAI-compat providers (vLLM, lmStudio, liteLLM, openAICompatible). Only `openRouter` overrides this. Fix: stop setting `specialToolFormat` in the regex fallback at all and let the provider's `defaultSpecialToolFormat` fill it in.
- **Strip redundant per-model `specialToolFormat` declarations** — every recognized model currently restates the format that matches its provider's default. Pure cleanup, zero behavior change after the per-provider refactor.
- **Refactor provider/model message conversion pipeline** — currently Gemini messages are built by first converting `SimpleLLMMessage → AnthropicLLMChatMessage` via `prepareOpenAIOrAnthropicMessages`, then `AnthropicLLMChatMessage → GeminiLLMChatMessage` via `prepareGeminiMessages`. This two-step chain drops custom fields (e.g. `images`) in the intermediate representation, forcing workarounds like the pre-collect/post-inject dance for image attachments. Refactor to give each provider its own direct `SimpleLLMMessage → ProviderMessage` converter, or carry a richer intermediate type that preserves all fields through the pipeline.
- **`supportsTools: boolean` per model** — separates "does this model support tool calling" from "what format" so the rare model that genuinely can't call tools can be encoded explicitly instead of relying on `specialToolFormat: undefined` (which is now ambiguous).
- **Audit `importantDetails` for unenforceable rules** — empirically observed during Phase A1+A2 baseline that capable models (e.g. MiniMax 2.5) ignore `Do NOT write tables` for tabular data. Likely cause: late position in a long numbered list. Two fixes worth considering: (a) reposition genuinely-important rules early in the list and demote optional style preferences to a separate "style preferences" block the model can break, (b) drop rules we don't actually enforce — every ignored rule teaches the model the system message isn't authoritative, weakening compliance on rules we *do* care about. Cheap pass, ~30 min, do as part of Option 2 prompt rewrite.
- ~~**Surface `finish_reason` on OpenAI-compatible streams**~~ — promoted to Next → Quality 1 above.
