# DeepSeek V4 API — implementation notes for Void

Sources: [DeepSeek API docs — Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/), corroborated against community write-ups.
Verified: Apr 2026.

This file captures everything Void needs to honour when integrating DeepSeek V4. Anything not listed here is "behaves like vanilla OpenAI Chat Completions".

---

## 1. Models

| Model | Context | Max output | Thinking | Tools | JSON mode | FIM |
|---|---|---|---|---|---|---|
| `deepseek-v4-flash` | 1M | 384K | yes (toggleable) | yes (both modes) | yes | non-thinking only |
| `deepseek-v4-pro` | 1M | 384K | yes (toggleable) | yes (both modes) | yes | non-thinking only |

Legacy aliases `deepseek-chat` and `deepseek-reasoner` are still accepted by the DeepSeek API (server-side aliases retiring after **2026-07-24 15:59 UTC**), but Void no longer exposes them in the default model list. They were removed from `defaultModelsOfProvider.deepseek` and `deepseekModelOptions` because:

- Their old Void config carried wrong context windows (64K) and inert `includeInPayload` — keeping them would mean two broken default entries shadowing the V4 ones.
- On startup, `_stateWithMergedDefaultModels` swaps any saved `type: 'default'` rows with whatever the current default list says. So existing users get migrated to the V4 entries automatically; the alias rows just disappear.
- Users who genuinely want to point at the legacy alias on the wire can still type `deepseek-chat` as a custom model name. It'll fall through to `defaultModelOptions` (4K context, no thinking) — which is the conservative behaviour we want for an unrecognized name.

## 2. Pricing (USD per 1M tokens)

| Model | Cache hit input | Cache miss input | Output |
|---|---|---|---|
| `deepseek-v4-flash` | 0.0028 | 0.14 | 0.28 |
| `deepseek-v4-pro` (standard) | 0.0145 | 1.74 | 3.48 |
| `deepseek-v4-pro` (promo until 2026-05-05) | 0.003625 | 0.435 | 0.87 |

Use **standard** in `cost` field; promo expires soon and the field is informational only.

## 3. Request payload — what to send

Base URL: `https://api.deepseek.com/v1` (already configured in Void).

Standard OpenAI Chat Completions body, plus these DeepSeek-specific fields:

### Thinking toggle (top-level body field)

```json
{
  "thinking": { "type": "enabled" }   // or "disabled"
}
```

- The `extra_body={"thinking": ...}` shown in DeepSeek's Python examples is a **Python SDK quirk** — `extra_body` is how the Python OpenAI client passes through arbitrary body fields. For raw HTTP / our TS implementation it's just a top-level field of the request body.
- Default if omitted: **enabled**. Always set explicitly to avoid silent drift.
- The same field is accepted in both Anthropic-format and OpenAI-format payloads (DeepSeek normalizes).

### Reasoning effort

```json
{ "reasoning_effort": "high" }   // or "max"
```

- Only `"high"` and `"max"` are accepted. For OpenAI-effort-slider compatibility, DeepSeek maps:
  - `"low"`, `"medium"` → `"high"`
  - `"xhigh"` → `"max"`
- Default: `"high"`. Auto-bumped to `"max"` on certain agent-style requests (Claude Code, OpenCode patterns) — server-side heuristic, not user-controllable.

### What thinking mode silently ignores

The following fields are **accepted with no error but have no effect** in thinking mode:

- `temperature`
- `top_p`
- `presence_penalty`
- `frequency_penalty`

Don't rely on them; for thinking mode, control output via `reasoning_effort` and prompt clarity instead.

### Tools

Standard OpenAI function-calling schema. Works in **both** thinking and non-thinking mode for both V4 models. No DeepSeek-specific deviation.

```json
{
  "tools": [...],
  "tool_choice": "auto"
}
```

## 4. Response payload — what comes back

### Non-streaming

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "<final answer>",
      "reasoning_content": "<chain of thought>",
      "tool_calls": [...]
    }
  }]
}
```

`reasoning_content` is at the **same level as `content`**, not nested.

### Streaming

Each chunk has:

```json
{
  "choices": [{
    "delta": {
      "content": "...",
      "reasoning_content": "...",
      "tool_calls": [...]
    }
  }]
}
```

`reasoning_content` streams **first**, then `content`. Parser must accumulate them into separate buffers. Void already does this via `providerReasoningIOSettings.output.nameOfFieldInDelta: 'reasoning_content'`.

## 5. Multi-turn rules — THE critical constraint

This is where Void will need careful work. The rule depends on whether tool calls occurred:

### Case A — assistant turn had NO tool calls

Across user message boundaries, you may **drop** `reasoning_content` from the prior assistant turn. If you pass it back, the API ignores it. No 400.

### Case B — assistant turn HAD tool calls

You **must** preserve `reasoning_content` on every prior assistant message that had `tool_calls`, **forever** in that thread. The exact wording from the docs:

> "for turns that do perform tool calls, the `reasoning_content` must be fully passed back to the API in all subsequent requests."
>
> "If your code does not correctly pass back `reasoning_content`, the API will return a 400 error."

This applies:

1. **Within an active agent loop** — every sub-turn of "model proposes tool → app executes → app returns tool result → model continues" must include the prior assistant messages' full `reasoning_content` so the model can continue its CoT chain.
2. **After a new user message** — even after the agent loop ended and the user typed something new, if any earlier assistant turn in the thread had tool calls, those reasoning blobs **stay in the history forever**.

The recommended pattern from the docs is the simplest: append `response.choices[0].message` verbatim, which carries `content`, `reasoning_content`, and `tool_calls` together. The non-tool-call cleanup (Case A) becomes a separate optional pass.

## 6. What Void does today

All five integration items are landed. Summary of where each lives so future edits stay coherent:

### 6.1 Wire-level reasoning toggle

- `_sendOpenAICompatibleChat` (`electron-main/llmMessage/sendLLMMessage.impl.ts`) spreads `includeInPayload` into the per-request body alongside `additionalOpenAIPayload`. The previous code path passed it to the OpenAI SDK constructor (`ClientOptions`), where arbitrary fields are silently dropped — that bug also kept OpenAI's `reasoning_effort` slider inert for the o-series.
  - The constructor helper `newOpenAICompatibleSDK` no longer accepts `includeInPayload`. Don't reintroduce it; that's the trap.
  - FIM has the same shape but no caller uses reasoning-on-FIM today, so we left it as-is.
- DeepSeek's payload contribution is `deepseekIncludeInPayloadReasoning` in `modelCapabilities.ts`: emits `{ thinking: { type: 'enabled' } }` when reasoning is on and `{ thinking: { type: 'disabled' } }` when off. Always emit explicitly — DeepSeek's default-on is bad for reproducibility and a stable byte-identical field across turns helps the prefix cache.

### 6.2 Sliderless reasoning UI

- `SendableReasoningInfo` (`modelCapabilities.ts`) gained an `enabled_no_slider` variant for models with on/off thinking but no effort/budget. `getSendableReasoningInfo` returns it whenever `reasoningCapabilities.canTurnOffReasoning` is true and no `reasoningSlider` is declared.
- DeepSeek V4 entries declare `reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true }` with no slider — so the chat sidebar shows a thinking toggle, no slider knob.

### 6.3 V4 model registration

- `_deepseekV4SharedCaps` carries the shared shape (1M context, 384K reserved output, `system-role`, `openai-style` tools, sliderless thinking). `deepseek-v4-flash` and `deepseek-v4-pro` only differ in `cost`. If a third V4 SKU lands, extend `_deepseekV4SharedCaps` once and add the SKU as a one-liner with its own price.
- `defaultModelsOfProvider.deepseek` is the same two names. The merge in `_stateWithMergedDefaultModels` migrates pre-V4 saved profiles automatically (see §1).

### 6.4 Receive-side reasoning capture

`reasoning_content` streams in via the existing `providerReasoningIOSettings.output.nameOfFieldInDelta: 'reasoning_content'` plumbing — no change needed. The streaming reader gates on provider-level config independently of model-level `reasoningCapabilities`, so capture works for any DeepSeek model name on this provider, including custom ones a user types in.

### 6.5 History round-trip — Case B compliance

This was the audit risk in the original plan. It's resolved end-to-end:

1. `ChatMessage.reasoning` (already persisted by the chat thread) gets forwarded into `SimpleLLMMessage.reasoningContent` in `_chatMessagesToSimpleMessages` (`browser/convertToLLMMessageService.ts`).
2. `OpenAILLMChatMessage` (`common/sendLLMMessageTypes.ts`) gained an optional `reasoning_content` field on the assistant variant.
3. `prepareMessages_openai_tools` takes a `supportsOAICompatReasoningContent` flag (true only for `providerName === 'deepseek'`) and emits `reasoning_content` on assistant turns **only if that turn called tools** — detected by lookahead for an immediately-following `role: 'tool'` message in the well-formed Simple message stream.

The lookahead is the optimisation we agreed on: drop `reasoning_content` from non-tool assistant turns (Case A — API ignores it, saves input tokens) and keep it forever on tool-call assistant turns (Case B — API requires it). The more aggressive "only the latest tool call needs reasoning" idea was rejected because docs explicitly say "all subsequent requests" must include it for every prior tool-call turn.

### 6.6 Compaction interaction (latent risks documented)

- **Light-tier compaction** (`compactToolResultsForRequest`) only trims tool-result bodies, never assistant messages. Assistant `reasoningContent` flows through untouched — Case B stays satisfied. Comment in-source warns future contributors that any *message-dropping* tier MUST drop the tool-call assistant + its `tool` followers as a unit (orphaning either side breaks `tool_call_id` linking AND/OR loses reasoning, both 400-triggers).
- **Emergency trim** in `prepareOpenAIOrAnthropicMessages` is currently blind to `reasoningContent` weight. On thinking-heavy threads, reasoning blobs can be 5–10× the visible `content`, so trimming `content` to 120 chars saves nothing. TODO comment in-source describes the two future options (include reasoning in `weight()` but only for Case A turns; or drop reasoning from old Case B turns under emergency pressure, accepting the 400 risk). Deferred until telemetry shows it firing.

## 7. Settings UI behaviour

Few UI gotchas worth knowing, surfaced while testing the V4 rollout:

- **Two DeepSeek rows are correct.** They're `flash` and `pro`. Only `cost` differs between them (not visible in the override panel since `cost` isn't in `modelOverrideKeys`), so they look near-identical in the "Change Defaults" modal. That's expected — DeepSeek V4 SKUs share capabilities by design.
- **Default-row migration on launch.** `_stateWithMergedDefaultModels` runs every load and replaces the previous default-tagged rows with the current `defaultModelsOfProvider` list. Custom-tagged or autodetected rows are preserved. A user with `deepseek-chat` in their saved settings (tagged `default`) will silently lose that row and gain `deepseek-v4-flash`/`deepseek-v4-pro` instead.
- **"Minimal" placeholder for V4 in the override panel** is normal: the placeholder iterates `modelOverrideKeys` with a truthy filter (`Settings.tsx:239`), so `supportsFIM: false` and `additionalOpenAIPayload: undefined` are skipped, leaving four fields (`contextWindow`, `reservedOutputTokenSpace`, `supportsSystemMessage`, `reasoningCapabilities`). That's the same shape as `gpt-4.1` or `claude-sonnet-4-0`.
- **"Model not recognized by Void" for a V4 name** would mean the saved row is a stale custom entry, not the registered default — most likely created before the V4 entries shipped. Fix: delete the row in Settings and re-add from defaults, or remove the user-data dir.

## 8. Cost / telemetry notes

- DeepSeek's `prompt_tokens_details.cached_tokens` populates the same way OpenAI does — Void's existing telemetry capture path works unchanged.
- Cache pricing is significant on V4 (cache hit is ~50× cheaper than miss on flash). Prefix-cache hygiene we already track via `sysHash` matters more here than on most providers; Case B's "send reasoning_content byte-identically every turn" rule is incidentally great for cache stability — don't normalize/strip whitespace from it on the wire.
- Output tokens charge in dollars not cents — `deepseek-v4-pro` output at $3.48/M is in the same neighbourhood as Sonnet. Easy to misread the table; don't.

## 9. Open questions to confirm against real traffic

This laptop has no DeepSeek access; everything below is best-effort against docs and needs verification once a real key runs through.

- **`prompt_tokens_details.cached_tokens` populated for V4?** Docs imply yes; first V4 request in the telemetry log will tell us. If not, the cached-token panel will under-count for DeepSeek specifically.
- **`reasoning_effort: "max"` cost/latency impact.** Docs hint complex agent loops auto-bump to `max` server-side. Currently we don't expose effort for V4 (sliderless toggle), but if telemetry shows wide latency variance even with thinking on, the server-side auto-bump is the likely cause.
- **Case B reasoning_content size growth.** A long agent loop with many tool calls accumulates reasoning blobs forever. Watch for emergency-trim hits on DeepSeek threads — see §6.6. If real, escalate the TODO into a real implementation.
- **Stream chunk ordering on parallel tool calls.** Docs say `reasoning_content` precedes `content`; not specified what happens with `tool_calls` deltas relative to either. Our reader handles them as independent streams so it shouldn't matter, but worth eyeballing the first multi-tool turn.
