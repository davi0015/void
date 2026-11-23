# External Chat Integration via a Generic Conversation Channel

First adapter: **Teams** (uses already-available sanctioned plumbing — a workflow webhook that posts as a bot into threads, and authenticated message reads). Slack is a later adapter, gated on workspace app-install approval.

## Problem

Users want to interact with Void threads from Slack: send a message in a Slack thread, have it routed to the correct Void thread, and have Void's response forwarded back — without the editor being focused (or, eventually, without it being open). Two hard constraints shape the design:

1. **Slack's transport is hostile to desktop apps.** The Events API requires a public HTTPS endpoint, signature verification, and a 3-second ack. A desktop editor behind NAT can't satisfy any of that. Slack messages also arrive whether or not Void is running.
2. **Tool results must never leave the machine raw.** `readFile` results, terminal output, and lint errors frequently contain secrets or large file contents. Whatever leaves Void must be presentation-safe by construction.

## Solution

A **separate proxy** (the "Slack bridge") between Slack and Void, plus a narrow **conversation-level integration channel** in Void. The split:

- Void exposes a generic protocol: send a user message in, receive throttled stream deltas / tool status summaries / approval requests / final text out. No Slack concepts anywhere in Void.
- The proxy owns 100% of Slack: app credentials, Socket Mode / Events API, `thread_ts` bookkeeping, Block Kit rendering, rate limits, message chunking, and durable queueing when Void is offline.

The proxy is not just architectural cleanliness — it absorbs problems that would otherwise leak into Void:

- **Transport flexibility**: Socket Mode (outbound websocket — works from a laptop, no public URL) vs a hosted public endpoint become interchangeable; Void speaks the same protocol either way.
- **Buffering**: Slack messages arrive while Void is closed. The proxy owns the durable queue and replays on connect. (Same model as VS Code tunnels, which this repo's `cli/` already has machinery for.)
- **Credentials**: Slack signing secrets and bot tokens live in one place, not on every workstation.
- **Slack's shape**: Block Kit, 3s acks, ~1 msg/sec bursts, `chat.update` for in-place edits — none of this belongs in `chatThreadService.ts`.

## Architecture

```
Teams ──(workflow webhook: post to thread;  authenticated read: see replies)──┐
                                                                              ▶ proxy ──(Void Integration Protocol, ws)──▶ Void
Slack ──(Socket Mode ws; requires app-install approval)─────────────────────┘

  Void side:
    browser/integrationService.ts
      └── rides on IChatThreadService
    electron-main/integrationChannel.ts
      └── ws server (v1, local) or ws client (v2, remote)
```

The proxy's adapter is a pluggable module: Teams (day one, existing plumbing) and Slack (approval-gated) both reduce to two functions — `readInbound()` for messages+replies, and `postToConversation()` for outbound. Void sees neither.

### Teams adapter mechanics (validated live, 2026-11-11)

The sync model differs from the naive "poll everything" in one important way, discovered by testing:

- **Channel-level `messages/delta` returns roots only — replies are never included**, not in the initial sync nor incrementally. There is no working `replies/delta` endpoint (400).
- **But when a reply is posted, the ROOT is re-delivered on the deltaLink** — i.e. the root doubles as a thread-changed signal.
- So the daemon's loop is: hold one channel deltaLink, poll every ~5s; for each returned root, unknown → new task (bind `conversationKey` = root id), known → fetch `GET /messages/{rootId}/replies` and dispatch replies with `id > last_seen` (per-thread watermark; ids are monotonic). Only threads with actual activity cost a `/replies` call — no N+1 across all threads.
- **The `/replies` listing returns newest-first** (verified live). Combined with the watermark this makes scan cost proportional to *new replies*, not thread length: walk pages newest→oldest, stop at the first `id <= watermark`. **First sight of a thread must never use watermark 0** — that replays the thread's whole history as "new" (found in live use: an old thread became active and the agent answered days-old messages). Since ids are globally monotonic across roots and replies, the daemon records a *floor* (highest id at initial sync) and uses it as the watermark for not-yet-watermarked threads; genuinely new replies (id > floor) still dispatch.
- **Rendered HTML subset (validated live 2026-11-14)**: works — `<b>`, `<i>`, `<s>`, `<u>`, `<h1>`–`<h3>`, `<blockquote>`, `<ul>/<ol>/<li>`, `<table>`, `<hr>`, `<code>` + `&nbsp;` indentation, `<span style="color:…">`; does NOT work — `<details>/<summary>` (stripped server-side: **no expandable content via plain HTML** — expandable requires Adaptive Cards via a "Post card" flow action), `<font color>` (renders black), `<h1>`–`<h3>` on mobile (all render the same size — use `<b style="font-size:…">` instead, explicit inline sizes survive both clients). Still true from earlier validation: `<pre>` breaks, `\n` stripped, leading spaces collapse.
- Webhook sends: `replyTo` = root id, one-level-deep threading only; 202 with no body means posting failures are only visible in the flow's run history, never to the caller.
- Author filtering must be null-safe: `from` can be `null`, and `{application: null, user: null}` occurs on system events. Compare `from.user.id` (not displayName) against the configured user.
- Duplicates: messages posted around deltaLink creation can appear in both the sync and the next incremental call — idempotent dispatch by message id required.

The Void side follows the existing browser↔electron-main channel pattern (`sendLLMMessageChannel.ts`: requestId + typed events, since functions can't cross the proxy boundary).

## Protocol

Defined in `common/integrationTypes.ts`. Two message families:

```typescript
// proxy → void
export type IntegrationInbound =
	| { type: 'userMessage'; conversationKey: string; text: string; author: string; threadId?: string; permissionMode?: ThreadPermissionMode }
	| { type: 'approvalResponse'; requestId: string; approved: boolean }
	| { type: 'interrupt'; conversationKey: string }
	| { type: 'newThread'; conversationKey: string; workspaceHint?: string }
	| { type: 'setThreadPermissionMode'; conversationKey: string; threadId: string; permissionMode: ThreadPermissionMode }
	| { type: 'conversationBound'; conversationKey: string; threadId: string }

// void → proxy — all presentation-safe (see Redaction)
export type IntegrationOutbound =
	| { type: 'streamDelta'; conversationKey: string; textSoFar: string }
	| { type: 'toolStatus'; conversationKey: string; toolName: ToolName; mcpServerName: string | undefined; phase: 'running' | 'success' | 'error'; summary: string }
	| { type: 'approvalRequest'; requestId: string; conversationKey: string; toolName: ToolName; mcpServerName: string | undefined; paramsSummary: string }
	| { type: 'final'; conversationKey: string; text: string; usage?: LLMUsage }
	| { type: 'error'; conversationKey: string; message: string }
	| { type: 'bound'; conversationKey: string; threadId: string }
	| { type: 'createConversation'; threadId: string; title?: string }
```

`userMessage.threadId` (optional) is the proxy's remembered binding; `bound` is Void's notification whenever a binding is (re)established — together they make the durable `voidThreadIdOfConversationKey` map survive Void restarts: the proxy sends what it remembers, Void adopts it or creates a new thread and tells the proxy which.

`userMessage.permissionMode` lets a proxy with channel-level authorization (e.g. a private Teams channel whose members are trusted for unattended tool use) grant the thread's mode *synchronously before the turn starts* — applying it after dispatch loses to a state race in the turn's snapshot. The same grant is re-applied on `bound` (reactively) and on connect (pre-warm, via `setThreadPermissionMode` carrying the proxy's remembered `threadId`) so it survives app restarts and session-mirror emptiness.

Bindings can also be created from the editor side, two ways. Explicit: the "Mirror Current Chat to an External Chat" command sends `createConversation {threadId}`. Automatic: when a turn completes on a thread with no bound conversation, the service sends `createConversation` and HOLDS the final until the proxy's `conversationBound` brings back the key, then delivers it — so an editor-started thread's first completed turn sprouts the conversation and posts its result into it (error/aborted turns never do; mid-turn events start flowing from the next turn). The proxy is idempotent on threadId (re-confirms a remembered binding rather than minting a duplicate), so app restarts converge on the existing external thread. Note this makes conversation creation automatic for editor threads in workspaces a proxy serves — deliberate, per user request; the proxy remains the policy holder and may ignore createConversation.

**Reaching a specific window / workspace:** one workspace = one port = one proxy connection. The port is derived deterministically by both sides — `base + hash('file://' + workspacePath) % 1000` (int32 rolling hash) — so the proxy needs no discovery: it computes where a window for that workspace *will* listen and dials until one does. Dev builds use base **5757**, released builds **4757** (so the same workspace open in both apps never contends for one port; the proxy's channel config picks the app via `portBase`). Workspace identity matches thread-scoping: single folder → the folder, saved `.code-workspace` → the workspace *file*, untitled multi-root → the first folder. The `hello` handshake authenticates the proxy with a **pairing token** — a per-installation secret (application storage; "Void: Show External Chat Pairing Token" copies it).

- `conversationKey` is an opaque string chosen by the proxy (for the Slack adapter: the `(channel_id, thread_ts)` pair, stable for the lifetime of a Slack thread). Void never parses it.
- `streamDelta` is throttled to ~1/sec by the proxy before calling `chat.update` (Slack rate limits); Void can emit freely.
- Ack/replay semantics are designed in from day one (each inbound message acked; unacked outbound events re-deliverable) so v2's remote proxy can queue while Void is offline, even though v1 (local) doesn't need it yet.

## Routing: conversation → thread

- Void threads gain an optional persisted `externalOrigin` field on `ThreadType` (per-thread storage, same migration path as other optional fields like `rulesChangedBefore`).
- The proxy owns the durable mappings `voidThreadIdOfConversationKey` (and its inverse). Void only holds a session-local mirror.
- Rules:
  - A message in a Slack thread with an existing binding → that Void thread.
  - A new Slack thread, a `/void` slash command, or a first DM → `newThread` creates a Void thread in the workspace the channel is bound to (`workspaceUriOfChannelId` config on the proxy). One channel = one workspace; explicit, no guessing.
  - If the target Void thread is already running, inbound messages go through `queueUserMessage` — that mechanism already exists in `IChatThreadService` and is exactly right for this. Otherwise `addUserMessageAndStreamResponse` starts the turn.

## Redaction: what gets forwarded

The user's caveat — "reading files shouldn't forward the whole file content" — is enforced **structurally, at the Void boundary**, not by trusting the proxy:

- **The protocol has no field for raw tool output.** `toolStatus.summary` is produced by a per-tool summarizer in `integrationService.ts`, e.g.:
  - `readFile src/foo.ts (2,140 chars)`
  - `runCommand npm test · exit 1 · 340 lines`
  - `editFile src/foo.ts (+18/−4)`
- Full tool results stay local in the thread's messages, exactly as today.
- Assistant text is forwarded as-is (it's what the user asked for); the proxy chunks it to Slack's ~4k-char message limit.

Doing this in Void rather than the proxy means: (a) Void is the component that knows what a `ToolMessage` means, and (b) nothing unredacted leaves the machine even when streaming partial status, regardless of who runs the proxy.

## Tool approvals over Slack

Mirrors the existing native-notification flow (`_handleNotificationAction` receives a reply and routes it into the thread) with a second surface:

1. A tool call needs approval → `approvalRequest` goes out with a `paramsSummary` (redacted).
2. The adapter renders Approve/Reject buttons (Slack Block Kit) or a plain-text prompt the user answers with `approve` / `reject` (Teams, if the workflow can't emit actionable cards — plain text is the default assumption for v1).
3. The response returns as `approvalResponse`, which calls `approveToolRequest` / `rejectToolRequest`.
4. Unresolved approvals time out to **reject** after N minutes — a chat channel is a shared, less-trusted surface than the editor UI.

## Security defaults

- Threads created via the integration channel start in `read_only` permission mode. Promoting to `workspace_write` / `full_access` requires an explicit approval-button action or an in-editor action.
- **Company-workspace deployment (the expected mode)**. Teams (day one): use a dedicated private **team** containing only you, with a standard channel — Power Automate's connector cannot post to a private *channel* (connector limitation). The read key grants the user's own access level, but the proxy still scopes reads to that one team/channel only, and an author allowlist (the user's ID) rejects everyone else silently — a teammate posting in the channel gets no response. The webhook's posting identity is a workflow bot, so nothing runs as the user. Slack (later): non-distributed "From scratch" app, DM-only, same allowlist-is-the-access-control reasoning, Socket Mode as the only egress.
- **Slack content is company data**: DMs on a company workspace are subject to compliance export and DLP. The structural redaction above is therefore a compliance requirement, not just a convenience — file contents, terminal output, and secrets must never appear in `final`/`streamDelta` text. An opt-in "summaries only" mode (tool-status lines + truncated final) covers users whose agents quote sensitive code.
- Proxy↔Void auth: a pairing token displayed in Void settings (copy-paste), same idea as the tunnel device flow. The channel is refused without it.
- Slack-side (proxy's responsibility): verify request signatures, restrict to configured channels and user IDs, ignore everything else.
- No arbitrary webhook/plugin surface on the Void side — this is a conversation protocol only. That's deliberate: a generic "subscribe to anything" hook is a security hole and scope creep. Conversation-level covers Slack and future frontends (Teams, Discord, a web dashboard).

## Phasing

| Phase | Adapter | Proxy location | Void transport | Notes |
|---|---|---|---|---|
| v1 | Teams (existing webhook + read key) | Local, next to Void | `integrationChannel.ts` is a localhost ws server in electron-main | Zero new approvals; thread posting + reply reads already verified |
| v2 | Slack (Socket Mode) | Local | same | Blocked on workspace app-install approval; adapter slots into the same proxy interface |
| v3 | any | Hosted | ws client connecting outbound to the hosted proxy | Messages queue while Void is closed; same protocol |

## Files to change

All within `src/vs/workbench/contrib/void`:

| File | Change |
|---|---|
| `common/integrationTypes.ts` (new) | Protocol types above |
| `common/chatThreadServiceTypes.ts` | Optional `externalOrigin` on `ThreadType` |
| `browser/integrationService.ts` (new) | Consumes `IChatThreadService`; conversationKey↔threadId routing; per-tool result summarizers; throttles deltas |
| `electron-main/integrationChannel.ts` (new) | ws server (v1), following `sendLLMMessageChannel.ts` pattern; pairing-token auth |
| `void.contribution.ts` | Register the service |

The proxy itself is a separate small Node service outside this repo (owns Slack SDK, mapping store, queue). No changes to files outside `src/vs/workbench/contrib/void`.

## Risks

- **Shared-channel abuse** — anyone in the channel can talk to the agent. Mitigated by the Slack-side channel/user allowlist and `read_only` default.
- **Approval latency** — a Slack approval round-trip is slow (user not looking at Slack). Mitigated by the reject-on-timeout and by the fact that read-only threads (the default) never need approval.
- **Proxy trust** — the protocol trusts the proxy to authenticate users. Acceptable because the proxy only ever sees redacted data and can only *start conversations*, not read tool results or the workspace.
- **Streaming vs rate limits** — `chat.update` streaming can get rate-limited (Slack adapter). Mitigated by the proxy-side 1/sec throttle and falling back to final-message-only on 429s. The Teams adapter doesn't stream in place at all in v1 — it posts tool-status lines and the final message.
- **Read-path latency (Teams)** — inbound responsiveness is bounded by the read poll interval (or workflow trigger latency) rather than a push channel. Acceptable for a personal tool; tune the poll interval rather than adding push infra later than needed.
