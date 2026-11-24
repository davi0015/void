/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ThreadPermissionMode, ToolName } from './toolsServiceTypes.js'
import { LLMUsage } from './sendLLMMessageTypes.js'


// ---------------------------------------------------------------------------
// The Void Integration Protocol
//
// A conversation-level protocol between Void and an external "proxy" process
// (see docs/designs/slack-integration.md — adapter-generic design; first
// adapter is Teams, Slack later). The proxy owns the external chat surface
// (Teams/Slack/Discord/...) and speaks only this protocol to Void. No
// chat-platform concepts (thread_ts, channel ids, Block Kit...) appear on
// the Void side of the boundary, and — critically — no raw tool results
// appear on the proxy side: everything in IntegrationOutbound is
// presentation-safe by construction (see the summarizer in
// integrationService.ts).
//
// Transport (v1): newline-delimited JSON over a localhost socket served from
// electron-main (see integrationChannel.ts). Each line is one message
// (handshake, ack, or envelope-wrapped inbound/outbound payload).
// ---------------------------------------------------------------------------


export const INTEGRATION_PROTOCOL_VERSION = 1


// --- handshake ------------------------------------------------------------

// First message on every connection. The pairing token is displayed in Void
// settings; the channel refuses all other traffic until a valid hello.
export type IntegrationHello = {
	type: 'hello'
	protocolVersion: number
	pairingToken: string
}

export type IntegrationWelcome =
	| { type: 'welcome'; protocolVersion: number }
	| { type: 'denied'; reason: string }


// --- proxy → void ----------------------------------------------------------

export type IntegrationInbound =
	// A user typed something on the external surface. The proxy has already
	// decided which conversation this belongs to — `conversationKey` is an
	// opaque string chosen by the proxy (Teams: root message id; Slack:
	// (channel_id, thread_ts)) and stable for the lifetime of the external
	// conversation. Void never parses it. `threadId` is the proxy's remembered
	// binding (it owns the durable map); Void adopts it when its own
	// session-local mirror has no entry — this is how bindings survive Void
	// restarts. `permissionMode` is the channel's configured grant, applied
	// BEFORE the turn starts — carrying it here (rather than as a separate
	// setThreadPermissionMode message) avoids a race where the turn's own
	// state snapshot, taken before a separate grant lands, reverts the mode
	// to read_only mid-flight.
	| { type: 'userMessage'; conversationKey: string; text: string; author: string; threadId?: string; permissionMode?: ThreadPermissionMode }

	// Response to an outstanding approvalRequest. `requestId` is the id Void
	// sent in the approvalRequest.
	| { type: 'approvalResponse'; requestId: string; approved: boolean }

	// Like hitting the stop button in the UI for that conversation's thread.
	| { type: 'interrupt'; conversationKey: string }

	// Ask Void to create a new thread for this conversation (e.g. a `/agent`
	// command on the external surface). `workspaceHint` is a human-readable
	// label the proxy was configured with; Void resolves it to a workspace
	// when creating the thread.
	| { type: 'newThread'; conversationKey: string; workspaceHint?: string }

	// The proxy created a new external conversation for an existing Void
	// thread (in response to createConversation). Fills Void's session
	// mirror — from here on, the thread's events flow to the new
	// conversation and replies in it route back to the thread.
	| { type: 'conversationBound'; conversationKey: string; threadId: string }

	// Ask Void to set the permission mode of the thread this conversation is
	// bound to. Used by proxies whose channel config explicitly grants a
	// stronger mode (e.g. full access, so a remote agent doesn't pause for
	// an in-chat approval on every step) — a deliberate, per-channel
	// re-grant of trust, recorded in the proxy's config. `threadId` is the
	// proxy's remembered binding, adopted when Void's session mirror is
	// empty (e.g. right after an app restart, on the pre-warm path).
	| { type: 'setThreadPermissionMode'; conversationKey: string; threadId: string; permissionMode: ThreadPermissionMode }


// --- void → proxy ----------------------------------------------------------

// All presentation-safe: no raw tool results, no file contents, no terminal
// output. Assistant text is forwarded as-is (it's the user's answer);
// everything else is a one-line summary produced by the summarizer.
export type IntegrationOutbound =

	// Throttled by the proxy before posting (external surfaces rate-limit
	// in-place edits; the Teams adapter ignores deltas entirely and only
	// posts final + toolStatus). `textSoFar` is the full text so far, not a
	// delta chunk.
	| { type: 'streamDelta'; conversationKey: string; textSoFar: string }

	// One line per tool call, as it transitions phases. `summary` is
	// redacted, e.g. `readFile src/foo.ts (2,140 chars)`. `title` is the
	// thread's current title, so posted messages can identify their task
	// even when read out of context (mobile notifications).
	| { type: 'toolStatus'; conversationKey: string; toolName: ToolName; mcpServerName: string | undefined; phase: 'running' | 'success' | 'error'; summary: string; title?: string }

	// A tool call needs the user's approval. `paramsSummary` is redacted the
	// same way as toolStatus summaries. The proxy renders buttons (Slack) or
	// an approve/reject text prompt (Teams v1) and returns an
	// approvalResponse with the same requestId. Void applies its own
	// timeout-to-reject if none arrives.
	| { type: 'approvalRequest'; requestId: string; conversationKey: string; toolName: ToolName; mcpServerName: string | undefined; paramsSummary: string; title?: string }

	// The turn is complete. `text` is the final assistant text (markdown).
	// `title` is the thread's current title — the proxy prefixes it to
	// posted messages so each identifies its task out of context.
	| { type: 'final'; conversationKey: string; text: string; usage?: LLMUsage; title?: string }

	// Void (re)bound a conversation to a thread — on thread creation, or on
	// adopting the proxy's remembered threadId. The proxy persists
	// voidThreadIdOfConversationKey from this; it is the durable half of a
	// binding whose Void-side mirror is session-local.
	| { type: 'bound'; conversationKey: string; threadId: string }

	// Ask the proxy to create a NEW external conversation (e.g. a Teams
	// thread) mirroring an EXISTING Void thread — the editor-initiated
	// direction of the binding. `title` is a human-readable label (thread
	// title / first-message excerpt). `text` is the user message that opens
	// the mirrored conversation — proxies that support it post this as the
	// conversation's root (authored by the channel user, never dispatched
	// back to Void) instead of a synthetic anchor, so the external thread
	// starts with real content.
	| { type: 'createConversation'; threadId: string; title?: string; text?: string }

	// The turn failed (LLM error, abort, etc).
	| { type: 'error'; conversationKey: string; message: string; title?: string }

	// The local user sent this message in the EDITOR on a bound thread.
	// Proxies mirror it into the conversation as the channel user and mark
	// it as already-seen so it is never dispatched back — the external
	// thread then shows both sides of the conversation. Messages that
	// ORIGINATED from the external surface are never echoed (they are
	// already there). Fire-and-forget: with no proxy connected the echo
	// is simply dropped.
	| { type: 'userMessageEcho'; conversationKey: string; text: string }


// --- envelope + ack --------------------------------------------------------

// Ack/replay semantics are designed in from day one so the v2 remote proxy
// (messages queue while Void is closed) needs no protocol change: every
// payload rides in an envelope with a monotonic id. Void acks every inbound
// envelope; unacked outbound envelopes may be re-sent by the proxy and are
// idempotent on Void's side.
export type IntegrationInboundEnvelope = {
	id: number
	payload: IntegrationInbound
}

export type IntegrationOutboundEnvelope = {
	id: number
	payload: IntegrationOutbound
}

export type IntegrationEnvelope =
	| IntegrationInboundEnvelope
	| IntegrationOutboundEnvelope

// After parsing off the wire we can't know statically which direction a
// payload belongs to — this guard narrows it. Proxies send only inbound
// payloads; Void sends only outbound ones.
export const isInboundPayload = (payload: { type: string }): payload is IntegrationInbound =>
	payload.type === 'userMessage' || payload.type === 'approvalResponse'
	|| payload.type === 'interrupt' || payload.type === 'newThread'
	|| payload.type === 'setThreadPermissionMode' || payload.type === 'conversationBound'

// Acknowledges receipt of an inbound envelope with the given id.
export type IntegrationAck = {
	type: 'ack'
	id: number
}

export type IntegrationMessage =
	| IntegrationHello
	| IntegrationWelcome
	| IntegrationAck
	| IntegrationEnvelope


// A one-line, presentation-safe summary of a tool call. This is the ONLY
// shape of per-tool information that ever leaves Void — the implementation
// must never include raw result content. Implemented per-tool in
// integrationService.ts.
export type ToolCallSummary = {
	toolName: ToolName
	mcpServerName: string | undefined
	// e.g. `readFile src/foo.ts (2,140 chars)` or `runCommand npm test · exit 1 · 340 lines`
	summary: string
}


// --- IPC channel types (browser integrationService ↔ electron-main integrationChannel) ---
// These ride the normal VS Code IPC (`void-channel-integration`), NOT the
// localhost socket — the socket is only for the external proxy process.

export type IntegrationChannelState = {
	running: boolean
	port: number | undefined
	nConnections: number   // number of authenticated proxy connections
}

export type IntegrationChannelStartParams = {
	port: number           // localhost port to serve the proxy protocol on
	pairingToken: string   // validated on the proxy's hello; the browser owns persistence
}

// Assigned by the channel when posting an outbound message; the id is used
// by the proxy for ack/replay bookkeeping.
export type IntegrationChannelPostResult = {
	envelopeId: number
}
