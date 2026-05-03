/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Per-request telemetry for diagnosing token consumption and cache behaviour.
// Writes one JSONL line per phase (request, response, tool, sysDiff) to a
// per-thread log file under <userRoamingDataHome>/voidRequestLogs/thread-<threadId>.jsonl.
//
// Privacy surface:
//  - request / response / tool lines carry ONLY shape and usage counters: hashes,
//    lengths, tool names, status codes, provider-reported token counts. No user
//    text, no assistant text, no tool-result bodies, no file paths. Safe to share.
//  - sysDiff lines carry the literal lines of the system message that differ
//    between two consecutive requests on the same thread. Emitted ONLY when a
//    hash flip is detected (prefix cache leak suspect), capped at DIFF_MAX_CHARS
//    total content. These lines reflect the system prompt + tool schema + rules
//    infrastructure — generally non-sensitive, but may include `.voidrules`
//    content if that's what changed. Tagged so analysis tools can drop them if
//    sharing the log.
//
// Analysis entrypoints:
//  - sysHash stability across requests on the same thread → detects prefix-cache leaks.
//  - sysDiff lines (when they appear) → which exact bytes caused a flip.
//  - usage.cached over many turns → confirms provider-side prompt caching is engaged.
//  - sentChars vs usage.in → empirical chars/token ratio per model.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatMode } from '../common/voidSettingsTypes.js';

// Keys are deliberately short to keep per-line bytes small — log files can
// accumulate tens of thousands of entries over a dogfooding session.

// Compaction summary copied from CompactionInfo (convertToLLMMessageService).
// Both Perf 2 light-tier and emergency-trim contribute to the base totals;
// emergency-specific counters are split out so the analysis can tell a
// "graceful trim" from a "we were about to overflow" event.
export type TelemetryCompactionInfo = {
	trimmed: number;             // # tool results trimmed this request
	savedChars: number;          // chars removed from request body
	savedTokens: number;         // token-equivalent (charsPerToken-calibrated)
	emergencyTrimmed?: number;   // subset of `trimmed` that came from emergency path
	emergencySavedChars?: number;
	emergencySavedTokens?: number;
};

export type TelemetryRequestEntry = {
	phase: 'request';
	t: string;             // ISO timestamp at send-time
	rid: string;           // request uuid, ties request ↔ response ↔ tool lines
	tid: string;           // thread id (also file name)
	mode: ChatMode | null; // agent / gather / normal
	provider: string;
	model: string;
	sysHash: number;       // stringHash of the system message — must be stable for cache
	sysLen: number;        // system message chars (after rules merge, before tokenization)
	rulesLen: number;      // aiInstructions + .voidrules chars (subset of sysLen)
	msgCount: number;      // # messages sent on this call (proxy for turn depth)
	sentChars: number;     // total chars in messages going out
	historyLen: number;    // bulk of past turns: sum of all message chars except the last
	lastMsgLen: number;    // char count of the final message on this call
	lastMsgRole: string;   // 'user' (fresh turn) | 'tool' (agent loop continuation) | 'assistant' | 'system'
	compaction?: TelemetryCompactionInfo; // omitted when no trimming fired
};

// Emitted in `onFinalMessage`. `paramsLen` lets us spot models that ship bloated
// tool arguments (e.g. pasting whole code blocks into `replace_string`). Result
// sizes are logged separately on the `tool` phase since they aren't known yet
// at response time.
export type TelemetryResponseToolCall = {
	name: string;
	paramsLen: number;
	mcp?: boolean;
};

export type TelemetryResponseEntry = {
	phase: 'response';
	t: string;             // ISO timestamp at completion
	rid: string;
	tid: string;
	status: 'ok' | 'aborted' | 'error';
	finishReason?: string;
	durMs: number;         // end-to-end wall time from request log to here
	usage?: {
		in?: number;       // inputTokens
		out?: number;      // outputTokens
		cached?: number;   // cachedInputTokens (key cache-leak signal)
		reasoning?: number;
	};
	tools?: TelemetryResponseToolCall[]; // tool calls the model emitted this turn
	errorMsg?: string;     // short error summary (no PII from prompts/responses)
};

// One per tool execution, attributed to the `rid` of the LLM request that emitted
// the call. Distribution of `name` → prompt-section ROI; `resultLen` → compaction
// priority (which tools contribute most to the next-turn `historyLen`);
// `status` → failure rate that wastes retry tokens.
export type TelemetryToolEntry = {
	phase: 'tool';
	t: string;             // ISO timestamp at completion
	rid?: string;          // rid of the LLM request that emitted this tool call (undefined if untracked)
	tid: string;
	name: string;
	status: 'ok' | 'error' | 'invalid_params' | 'interrupted';
	errorReason?: string;  // short classifier for the error (e.g. 'Not found', 'Not unique', 'Has overlap')
	paramsLen: number;
	resultLen?: number;    // stringified tool-result chars (the thing that lands in next-turn history)
	durMs: number;
	mcp?: boolean;
};

// Emitted ONLY when `logRequest` is called with a `systemMessage` and the hash
// of that message differs from what we recorded on the previous request for
// the same thread. This is the Option B "sysDiff-on-flip" path: happy path
// (stable prefix) → zero extra bytes; flip → one event with the line-level
// delta so the analyst can see which bytes drifted and why the prefix cache
// missed. `oldMid` / `newMid` are the differing line ranges only — matching
// prefix and suffix lines are elided and their counts reported instead.
//
// `truncated: true` means combined (oldMid + newMid) content exceeded
// DIFF_MAX_CHARS, so the tail of whichever side was bigger is cut. Rare; only
// happens when "essentially everything changed" (e.g. chatMode switched) —
// in those cases the flip itself is the signal, the exact diff matters less.
export type TelemetrySysDiffEntry = {
	phase: 'sysDiff';
	t: string;
	rid: string;           // rid of the NEW (current) request
	tid: string;
	prevRid?: string;      // rid of the previous request we diffed against (undefined after Void restart)
	prevSysHash: number;
	newSysHash: number;
	prefixLines: number;   // # leading lines that matched (elided)
	suffixLines: number;   // # trailing lines that matched (elided)
	oldLen: number;        // chars in the previous system message
	newLen: number;        // chars in the new system message
	oldMid: string[];      // diverging lines from the previous system message
	newMid: string[];      // diverging lines from the new system message
	truncated?: boolean;
};

export interface IRequestTelemetryService {
	readonly _serviceBrand: undefined;
	// `systemMessage` is optional so callers can opt out of sysDiff entirely by
	// omitting it. When provided, the service tracks per-thread systemMessage
	// state and emits a `sysDiff` event on hash flips (prefix cache leaks).
	logRequest(entry: TelemetryRequestEntry, opts?: { systemMessage?: string }): void;
	logResponse(entry: TelemetryResponseEntry): void;
	logTool(entry: TelemetryToolEntry): void;
	// Releases any in-memory per-thread state (the sysMessage snapshot used
	// for flip detection). The on-disk log file is left untouched. Called on
	// `chatThreadService.deleteThread` to keep the snapshot map bounded.
	forgetThread(threadId: string): void;
}

export const IRequestTelemetryService = createDecorator<IRequestTelemetryService>('voidRequestTelemetryService');

// Rotation: when the live file grows past this, we roll it to
// thread-<id>.prev.jsonl (overwriting any existing prev) so the latest and
// previous window together cap at ~2×MAX. Anything older is lost — fine, this
// is for recent-session debugging, not compliance.
const MAX_BYTES_BEFORE_ROTATE = 5 * 1024 * 1024;

// Debounce so a burst of entries (e.g. agent loop with 5 tool iterations in
// <1s) coalesce into one read-concat-write cycle.
const FLUSH_DEBOUNCE_MS = 250;

const LOG_DIR_NAME = 'voidRequestLogs';

// Drops lines after this many consecutive flush failures for a thread, so a
// persistent I/O error (e.g. disk full) can't grow the in-memory buffer
// unboundedly.
const MAX_FLUSH_RETRIES = 3;

// Cap on total characters stored in (oldMid + newMid) of a sysDiff event. A
// normal flip from a small volatility source (timestamp, ordering drift) is
// 100s of bytes; a flip caused by rules edit can be a few KB. 8 KB is the
// break-even where "we can see what changed" still holds without letting a
// pathological flip (chatMode switch, whole prompt rewrite) bloat the log.
const DIFF_MAX_CHARS = 8 * 1024;

// Tracks the last system message we saw per thread so we can diff on flip.
// One entry per active thread, cleared on service disposal. A system message
// is ~15-20 KB so even with dozens of active threads this is <1 MB resident.
type SysMessageSnapshot = {
	sysMessage: string;
	sysHash: number;
	rid: string;
};

// Line-level diff: elides matching leading and trailing lines and returns the
// middle that differs on each side, plus match-counts for context. Not a
// full Myers diff — we don't need it. Real flips usually differ in 1-5
// contiguous lines (timestamp, single rule block, one re-ordered list), and
// the degenerate "everything changed" case is handled by the truncation cap
// rather than a cleverer algorithm.
function lineDiff(oldStr: string, newStr: string): {
	prefixLines: number; suffixLines: number; oldMid: string[]; newMid: string[]; truncated: boolean;
} {
	const oldLines = oldStr.split('\n');
	const newLines = newStr.split('\n');

	let prefixLines = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (prefixLines < minLen && oldLines[prefixLines] === newLines[prefixLines]) prefixLines++;

	let suffixLines = 0;
	// Stop suffix collapse at the prefix boundary on each side so we never
	// double-count a single matched line when old and new have the same length
	// and share a long prefix that runs past midway.
	while (
		suffixLines < oldLines.length - prefixLines &&
		suffixLines < newLines.length - prefixLines &&
		oldLines[oldLines.length - 1 - suffixLines] === newLines[newLines.length - 1 - suffixLines]
	) suffixLines++;

	let oldMid = oldLines.slice(prefixLines, oldLines.length - suffixLines);
	let newMid = newLines.slice(prefixLines, newLines.length - suffixLines);

	// Truncate to DIFF_MAX_CHARS combined. Split the budget proportionally to
	// each side's size so a one-sided rewrite isn't forced to 50/50.
	let truncated = false;
	const total = oldMid.join('\n').length + newMid.join('\n').length;
	if (total > DIFF_MAX_CHARS) {
		truncated = true;
		const oldShare = Math.floor(DIFF_MAX_CHARS * (oldMid.join('\n').length / total));
		const newShare = DIFF_MAX_CHARS - oldShare;
		oldMid = capLines(oldMid, oldShare);
		newMid = capLines(newMid, newShare);
	}
	return { prefixLines, suffixLines, oldMid, newMid, truncated };
}

// Keep lines from the head until budget runs out; append `…` marker when we cut.
function capLines(lines: string[], budget: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length + 1 > budget) { out.push('…(truncated)'); break; }
		out.push(line);
		used += line.length + 1; // +1 for the rejoin newline
	}
	return out;
}

class RequestTelemetryService extends Disposable implements IRequestTelemetryService {
	_serviceBrand: undefined;

	private readonly logDir: URI;
	private readonly bufferByTid = new Map<string, string[]>();
	private readonly flushSchedulersByTid = new Map<string, RunOnceScheduler>();
	private readonly failureCountByTid = new Map<string, number>();
	// Emits the resolved log path to DevTools console on the first successful
	// write so it's trivial to find under dev builds / temp-profile launches
	// where userRoamingDataHome isn't where production Void would write.
	private _pathAnnounced = false;
	// Per-thread last-seen system message for sysDiff emission on hash flip.
	// In-memory only — NOT persisted across Void restarts. Consequence: the
	// very first request after a cold start won't produce a sysDiff even if
	// the hash differs from the last pre-restart request; the two sysHash
	// values are still in the log file so post-hoc reconstruction is possible.
	private readonly lastSysByTid = new Map<string, SysMessageSnapshot>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();
		this.logDir = joinPath(this.environmentService.userRoamingDataHome, LOG_DIR_NAME);
	}

	logRequest(entry: TelemetryRequestEntry, opts?: { systemMessage?: string }): void {
		this._enqueue(entry.tid, JSON.stringify(entry));

		// Option B: sysDiff-on-flip. Only meaningful when the caller passed us the
		// actual system-message content; otherwise we can't diff. Emitted as a
		// second line RIGHT AFTER the request line so they're adjacent in the
		// JSONL and can be consumed as a pair.
		if (opts?.systemMessage === undefined) return;
		const prev = this.lastSysByTid.get(entry.tid);
		const newSysHash = entry.sysHash;
		if (prev && prev.sysHash !== newSysHash) {
			const { prefixLines, suffixLines, oldMid, newMid, truncated } = lineDiff(prev.sysMessage, opts.systemMessage);
			const sysDiffEntry: TelemetrySysDiffEntry = {
				phase: 'sysDiff',
				t: new Date().toISOString(),
				rid: entry.rid,
				tid: entry.tid,
				prevRid: prev.rid,
				prevSysHash: prev.sysHash,
				newSysHash,
				prefixLines,
				suffixLines,
				oldLen: prev.sysMessage.length,
				newLen: opts.systemMessage.length,
				oldMid,
				newMid,
				truncated: truncated || undefined,
			};
			this._enqueue(entry.tid, JSON.stringify(sysDiffEntry));
		}
		// Update snapshot regardless of whether a flip fired — subsequent requests
		// should diff against this one, not against some stale version.
		this.lastSysByTid.set(entry.tid, { sysMessage: opts.systemMessage, sysHash: newSysHash, rid: entry.rid });
	}

	logResponse(entry: TelemetryResponseEntry): void {
		this._enqueue(entry.tid, JSON.stringify(entry));
	}

	logTool(entry: TelemetryToolEntry): void {
		this._enqueue(entry.tid, JSON.stringify(entry));
	}

	forgetThread(threadId: string): void {
		// `lastSysByTid` is keyed on the raw tid (matches `logRequest`), not
		// safeTid — the map never hits disk so sanitization isn't needed.
		this.lastSysByTid.delete(threadId);
		// NB: buffer + scheduler + failure counter are intentionally left — any
		// still-pending lines should flush to disk before we drop state.
	}

	private _safeTid(tid: string): string {
		// Thread ids are uuids in practice, but belt-and-suspenders: strip
		// anything that could traverse directories or confuse the FS.
		return tid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
	}

	private _enqueue(tid: string, line: string): void {
		const safeTid = this._safeTid(tid);
		let buf = this.bufferByTid.get(safeTid);
		if (!buf) { buf = []; this.bufferByTid.set(safeTid, buf); }
		buf.push(line);

		let scheduler = this.flushSchedulersByTid.get(safeTid);
		if (!scheduler) {
			scheduler = this._register(new RunOnceScheduler(() => { this._flush(safeTid); }, FLUSH_DEBOUNCE_MS));
			this.flushSchedulersByTid.set(safeTid, scheduler);
		}
		scheduler.schedule();
	}

	private async _flush(safeTid: string): Promise<void> {
		const buf = this.bufferByTid.get(safeTid);
		if (!buf || buf.length === 0) return;

		// Snapshot and clear — if the write fails we re-prepend.
		const pending = buf.splice(0, buf.length);
		const toAppend = pending.join('\n') + '\n';

		const fileUri = joinPath(this.logDir, `thread-${safeTid}.jsonl`);

		try {
			let existing = '';
			try {
				const content = await this.fileService.readFile(fileUri);
				existing = content.value.toString();
			} catch {
				// File (or parent dir) doesn't exist yet — writeFile below will create it.
			}

			if (existing.length + toAppend.length > MAX_BYTES_BEFORE_ROTATE) {
				// Rotate: previous log is kept as .prev.jsonl, live file starts fresh.
				const prevUri = joinPath(this.logDir, `thread-${safeTid}.prev.jsonl`);
				try {
					if (existing) await this.fileService.writeFile(prevUri, VSBuffer.fromString(existing));
				} catch { /* best-effort rotation */ }
				existing = '';
			}

			await this.fileService.writeFile(fileUri, VSBuffer.fromString(existing + toAppend));
			this.failureCountByTid.set(safeTid, 0);
			if (!this._pathAnnounced) {
				this._pathAnnounced = true;
				// eslint-disable-next-line no-console
				console.log('[request-telemetry] logging to', this.logDir.toString(), '(first file:', fileUri.toString() + ')');
			}
		} catch (e) {
			const retries = (this.failureCountByTid.get(safeTid) ?? 0) + 1;
			this.failureCountByTid.set(safeTid, retries);
			if (retries < MAX_FLUSH_RETRIES) {
				// Re-queue at the front so ordering is preserved, try again on next tick.
				const current = this.bufferByTid.get(safeTid) ?? [];
				this.bufferByTid.set(safeTid, [...pending, ...current]);
				this.flushSchedulersByTid.get(safeTid)?.schedule();
			} else {
				// Give up on this batch. Console so we at least know silently-lost
				// telemetry is happening; don't spam on every subsequent write.
				// eslint-disable-next-line no-console
				console.warn('[request-telemetry] dropping', pending.length, 'lines for thread', safeTid, 'after', retries, 'failures:', e);
				this.failureCountByTid.set(safeTid, 0);
			}
		}
	}
}

registerSingleton(IRequestTelemetryService, RequestTelemetryService, InstantiationType.Delayed);
