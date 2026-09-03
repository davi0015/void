/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Void. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, screen } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export type VoidNotification = {
	id: string;
	title: string;
	// Thread identity (custom title or first user message) — lets the user
	// tell parallel chats apart at a glance.
	threadTitle?: string;
	subtitle?: string;
	// Play a soft chime when the notification appears (approvals and
	// chat-complete). Value is the volume 0-1; 0 or undefined means no sound.
	sound?: number;
	// The chime timbre — one of the notificationSoundKinds from
	// voidSettingsTypes ('pop', 'glass', 'marimba', ...). Unknown values fall
	// back to 'pop' in the generated sound script.
	soundKind?: string;
	body: string;
	actions: { label: string, actionId: string }[];
	clickActionId?: string;
};

/**
 * Manages floating, frameless, non-focusable notification windows.
 *
 * IPC: buttons call console.log('void-action:<actionId>'), intercepted via
 * the console-message event. No preload script needed.
 *
 * Focus prevention: onmousedown="event.preventDefault()" on all interactive
 * elements stops the web-content focus chain from triggering macOS app
 * activation when clicking buttons.
 *
 * Notifications are visible on all macOS Spaces so a persistent approval
 * never gets stranded on a desktop the user has since left, and can play a
 * soft chime (approval-needed) for awareness without looking.
 *
 * Reply: the Reply button (done notifications) temporarily makes the panel
 * keyable so the user can type a response without switching to Void — the
 * panel window type keeps the app itself from activating. The typed text is
 * sent back as a 'reply:<threadId>:<encoded text>' action.
 */
export class VoidNotificationService extends Disposable {

	private readonly _notificationWindows = new Map<string, { window: BrowserWindow; windowId: number | undefined; timeout: NodeJS.Timeout | undefined; height: number; informational: boolean; replyExpanded: boolean }>();

	private readonly _onNotificationAction = this._register(new Emitter<{ windowId: number | undefined; actionId: string }>());
	readonly onNotificationAction: Event<{ windowId: number | undefined; actionId: string }> = this._onNotificationAction.event;

	private static readonly NOTIFICATION_WIDTH = 360;
	private static readonly NOTIFICATION_DEFAULT_HEIGHT = 180;
	private static readonly NOTIFICATION_MIN_HEIGHT = 120;
	private static readonly NOTIFICATION_MAX_HEIGHT = 260;
	private static readonly NOTIFICATION_MARGIN = 20;
	private static readonly NOTIFICATION_GAP = 10;
	private static readonly NOTIFICATION_TIMEOUT_MS = 20000;
	private static readonly MAX_VISIBLE_NOTIFICATIONS = 5;

	async showNotification(windowId: number | undefined, notification: VoidNotification): Promise<void> {
		// Close existing notification with same id (dedup)
		await this.dismissNotification(notification.id);

		// Cap the visible stack (also keeps the stack on-screen). Evict the
		// oldest informational notification (done/error) when full — approvals
		// carry a pending decision and are never auto-dismissed, and neither
		// is a notification whose reply input the user is typing in. If all
		// visible notifications are protected, the stack is allowed to exceed
		// the cap rather than hide a pending decision.
		const informational = notification.actions.every(a => a.actionId.startsWith('reply-expand:'));
		while (this._notificationWindows.size >= VoidNotificationService.MAX_VISIBLE_NOTIFICATIONS) {
			const victim = [...this._notificationWindows.entries()].find(([, e]) => e.informational && !e.replyExpanded);
			if (!victim) break;
			await this.dismissNotification(victim[0]);
		}

		const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
		const x = display.workArea.x + display.workArea.width - VoidNotificationService.NOTIFICATION_WIDTH - VoidNotificationService.NOTIFICATION_MARGIN;
		let y = display.workArea.y + VoidNotificationService.NOTIFICATION_MARGIN;
		for (const [, entry] of this._notificationWindows) {
			y += entry.height + VoidNotificationService.NOTIFICATION_GAP;
		}

		const win = new BrowserWindow({
			width: VoidNotificationService.NOTIFICATION_WIDTH,
			height: VoidNotificationService.NOTIFICATION_DEFAULT_HEIGHT,
			x,
			y,
			frame: false,
			transparent: true,
			resizable: false,
			maximizable: false,
			minimizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			focusable: false,
			type: 'panel',
			show: false,
			hasShadow: false,
			backgroundColor: '#00000000',
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
			},
		});

		win.setAlwaysOnTop(true, 'floating');
		// Visible on every Space — a persistent approval must follow the user
		// across desktops instead of being stranded in the Space it was shown in.
		win.setVisibleOnAllWorkspaces(true);

		// Button/click actions use console.log — intercept via console-message.
		win.webContents.on('console-message', (event, _level, message) => {
			if (!message.startsWith('void-action:')) return;
			event.preventDefault();
			const actionId = message.slice('void-action:'.length);

			// Reply flow: the Reply button makes the panel keyable so the user can
			// type in it, then reveals the input row. Collapsing reverses both.
			// (The panel window type should let it take keyboard focus without
			// activating the app.)
			if (actionId.startsWith('reply-expand:')) {
				const entry = this._notificationWindows.get(notification.id);
				if (entry?.timeout) { clearTimeout(entry.timeout); entry.timeout = undefined; }
				if (entry) entry.replyExpanded = true;
				win.setFocusable(true);
				win.focus();
				win.webContents.executeJavaScript('document.getElementById("void-reply-row").style.display = "flex"; document.getElementById("void-reply-input").focus();').catch(() => { });
				this._resizeToContent(win, notification.id);
				return;
			}
			if (actionId === 'reply-collapse') {
				const entry = this._notificationWindows.get(notification.id);
				if (entry) entry.replyExpanded = false;
				win.setFocusable(false);
				this._resizeToContent(win, notification.id);
				return;
			}

			if (actionId !== 'close') {
				this._onNotificationAction.fire({ windowId, actionId });
			}
			this.dismissNotification(notification.id);
		});

		// Size the window to its content (capped) so the buttons are always
		// visible with long bodies, then show. The fallback timer covers a
		// failed/slow measurement; isDestroyed guards a dismissal in between.
		let shown = false;
		const showNow = () => {
			if (shown) return;
			shown = true;
			if (!win.isDestroyed()) win.showInactive();
		};
		const fallbackTimer = setTimeout(showNow, 1000);
		win.webContents.once('did-finish-load', () => {
			this._resizeToContent(win, notification.id).then(() => {
				showNow();
				clearTimeout(fallbackTimer);
			});
		});

		const html = this._buildNotificationHtml(notification);
		win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

		// Auto-dismiss notifications that don't need a decision (done/error).
		// The Reply button doesn't count — it's handled inside the window — but
		// expanding the reply input cancels the timer.
		const needsUserDecision = notification.actions.some(a => !a.actionId.startsWith('reply-expand:'));
		let timeout: NodeJS.Timeout | undefined;
		if (!needsUserDecision) {
			timeout = setTimeout(() => {
				this.dismissNotification(notification.id);
			}, VoidNotificationService.NOTIFICATION_TIMEOUT_MS);
		}

		this._notificationWindows.set(notification.id, { window: win, windowId, timeout, height: VoidNotificationService.NOTIFICATION_DEFAULT_HEIGHT, informational, replyExpanded: false });
	}

	async dismissNotification(id: string): Promise<void> {
		const entry = this._notificationWindows.get(id);
		if (!entry) return;
		if (entry.timeout) { clearTimeout(entry.timeout); }
		entry.window.close();
		this._notificationWindows.delete(id);
		this._repositionNotifications();
	}

	/**
	 * Resize a notification window to fit its content (clamped), updating the
	 * stored height and re-positioning the stack. Fire-and-forget safe.
	 */
	private _resizeToContent(win: BrowserWindow, id: string): Promise<void> {
		if (win.isDestroyed()) return Promise.resolve();
		return win.webContents.executeJavaScript('Math.ceil(document.body.offsetHeight)').then(measured => {
			const contentHeight = typeof measured === 'number' && measured > 0 ? measured : VoidNotificationService.NOTIFICATION_DEFAULT_HEIGHT;
			const height = Math.min(Math.max(contentHeight, VoidNotificationService.NOTIFICATION_MIN_HEIGHT), VoidNotificationService.NOTIFICATION_MAX_HEIGHT);
			const entry = this._notificationWindows.get(id);
			if (entry) entry.height = height;
			if (!win.isDestroyed()) win.setContentSize(VoidNotificationService.NOTIFICATION_WIDTH, height);
			this._repositionNotifications();
		}).catch(() => { });
	}

	private _repositionNotifications(): void {
		const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
		let y = display.workArea.y + VoidNotificationService.NOTIFICATION_MARGIN;
		for (const [, entry] of this._notificationWindows) {
			entry.window.setPosition(
				display.workArea.x + display.workArea.width - VoidNotificationService.NOTIFICATION_WIDTH - VoidNotificationService.NOTIFICATION_MARGIN,
				y
			);
			y += entry.height + VoidNotificationService.NOTIFICATION_GAP;
		}
	}

	private _escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	private _buildNotificationHtml(notification: VoidNotification): string {
		const title = this._escapeHtml(notification.title);
		const subtitle = notification.subtitle ? this._escapeHtml(notification.subtitle) : '';
		const body = this._escapeHtml(notification.body);
		// Shown in the header meta row — static at build time, which is when
		// the notification appears.
		const timestamp = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

		const allButtons = [...notification.actions, { label: 'Dismiss', actionId: 'close' }];
		const buttonsHtml = `<div class="buttons">${allButtons.map(a => {
			// The close button renders as a compact × instead of a text
			// button — less visual noise next to the primary actions.
			if (a.actionId === 'close') {
				return `<button class="btn btn-close" title="Dismiss" onmousedown="event.preventDefault()" onclick="event.preventDefault(); event.stopPropagation(); console.log('void-action:close')">&times;</button>`;
			}
			const cls = a.label === 'Approve' ? 'btn-approve' : a.label === 'Approve all' ? 'btn-approve-all' : a.label === 'Reject' ? 'btn-reject' : 'btn-default';
			return `<button class="btn ${cls}" onmousedown="event.preventDefault()" onclick="event.preventDefault(); event.stopPropagation(); console.log('void-action:${this._escapeHtml(a.actionId)}')">${this._escapeHtml(a.label)}</button>`;
		}).join('')}</div>`;

		const subtitleHtml = subtitle ? `<div class="subtitle">${subtitle}</div>` : '';
		const threadTitleHtml = notification.threadTitle ? `<div class="thread-title">${this._escapeHtml(notification.threadTitle)}</div>` : '';

		// Reply input — revealed by the main process when Reply is clicked (it
		// makes the window keyable first so the input can take focus). Esc
		// collapses the row and makes the window non-focusable again.
		const replyAction = notification.actions.find(a => a.actionId.startsWith('reply-expand:'));
		const replyThreadId = replyAction ? this._escapeHtml(replyAction.actionId.slice('reply-expand:'.length)) : undefined;
		const replyRowHtml = replyThreadId ? `
<div class="reply-row" id="void-reply-row" style="display: none;" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()">
  <input id="void-reply-input" type="text" placeholder="Reply\u2026" onkeydown="if (event.key === 'Enter') { event.preventDefault(); voidSendReply('${replyThreadId}') } else if (event.key === 'Escape') { voidCollapseReply() }">
</div>` : '';
		const replyScript = replyThreadId ? `
<script>
function voidSendReply(threadId) {
	var text = document.getElementById('void-reply-input').value.trim();
	if (!text) return;
	console.log('void-action:reply:' + threadId + ':' + encodeURIComponent(text));
}
function voidCollapseReply() {
	document.getElementById('void-reply-row').style.display = 'none';
	console.log('void-action:reply-collapse');
}
</script>` : '';

		// Notification chime, synthesized with WebAudio inside the notification
		// page — no bundled asset needed, and Electron's default autoplay policy
		// allows it without a gesture. The timbre (soundKind) selects one of the
		// players below ('pop', 'glass', 'marimba', ... — see notificationSoundKinds
		// in voidSettingsTypes); unknown kinds fall back to 'pop'. Approvals chime
		// ascending (attention); chat-complete chimes descending (resolution),
		// mirroring the accent-color inference, so the user can tell "needs me"
		// from "finished" without looking.
		// The requested volume (0-1, clamped) scales every player's peak gain on
		// a quadratic curve — perceived loudness is logarithmic, so a linear
		// mapping would spend most of the slider range below the audible-
		// difference threshold. Layer gains sum to 1, so `peak` stays the true
		// peak amplitude. 100% = 0.7 (~6x the original 0.12 loudness).
		const soundVolume = Math.min(Math.max(notification.sound ?? 0, 0), 1);
		const peakGain = 0.7 * soundVolume * soundVolume;
		const chimeFrequencies = notification.actions.some(a => a.actionId.startsWith('approve')) ? [880, 1174.66] : [1174.66, 880];
		const soundScript = peakGain > 0 ? `
<script>
(function () {
	try {
		var ctx = new AudioContext();
		var dest = ctx.destination;
		var now = ctx.currentTime;
		var peak = ${peakGain.toFixed(4)};
		var freqs = ${JSON.stringify(chimeFrequencies)};
		var panOf = function (i) { return i === 0 ? -0.15 : 0.15; };
		var noteGainOf = function (i) { return i === 0 ? 1 : 0.75; };
		// Schedule a note made of sine layers. layers = [frequency ratio, gain,
		// decay seconds]. opts: attack seconds, glide multiplier (e.g. 0.94 =
		// starts 6% below pitch), glideTime seconds.
		function layeredSine(freq, nt, i, layers, opts) {
			var pan = ctx.createStereoPanner();
			pan.pan.value = panOf(i);
			pan.connect(dest);
			layers.forEach(function (l) {
				var osc = ctx.createOscillator();
				var g = ctx.createGain();
				osc.type = 'sine';
				if (opts.glide) {
					osc.frequency.setValueAtTime(freq * l[0] * opts.glide, nt);
					osc.frequency.exponentialRampToValueAtTime(freq * l[0], nt + (opts.glideTime || 0.06));
				} else {
					osc.frequency.value = freq * l[0];
				}
				g.gain.setValueAtTime(0.0001, nt);
				g.gain.linearRampToValueAtTime(peak * l[1] * noteGainOf(i), nt + opts.attack);
				g.gain.exponentialRampToValueAtTime(0.0001, nt + l[2]);
					osc.connect(g);
					g.connect(pan);
					osc.start(nt);
					osc.stop(nt + l[2] + 0.05);
			});
		}
		var PLAYERS = {
			pop: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq, t + i * 0.13, i, [[1, 0.87, 0.3], [2, 0.13, 0.3]], { attack: 0.015, glide: 0.94 });
				});
			},
			glass: function (t) {
					freqs.forEach(function (freq, i) {
						var nt = t + i * 0.13;
						var pan = ctx.createStereoPanner();
						pan.pan.value = panOf(i);
						pan.connect(dest);
						var carrier = ctx.createOscillator();
						carrier.type = 'sine';
						carrier.frequency.value = freq;
						var mod = ctx.createOscillator();
						mod.type = 'sine';
						mod.frequency.value = freq * 3.5;
						var modGain = ctx.createGain();
						modGain.gain.setValueAtTime(freq * 1.8 * noteGainOf(i), nt);
						modGain.gain.exponentialRampToValueAtTime(freq * 0.01, nt + 0.25);
						mod.connect(modGain);
						modGain.connect(carrier.frequency);
						var g = ctx.createGain();
						g.gain.setValueAtTime(0.0001, nt);
						g.gain.linearRampToValueAtTime(peak * noteGainOf(i), nt + 0.005);
						g.gain.exponentialRampToValueAtTime(0.0001, nt + 0.4);
						carrier.connect(g);
						g.connect(pan);
						carrier.start(nt);
						mod.start(nt);
						carrier.stop(nt + 0.45);
						mod.stop(nt + 0.45);
					});
			},
			marimba: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq, t + i * 0.13, i, [[1, 0.74, 0.4], [3.9, 0.19, 0.12], [9.2, 0.07, 0.06]], { attack: 0.008 });
				});
			},
			warmSynth: function (t) {
				freqs.forEach(function (freq, i) {
					var nt = t + i * 0.13;
					var pan = ctx.createStereoPanner();
					pan.pan.value = panOf(i);
					pan.connect(dest);
					[{ type: 'triangle', ratio: 1, gain: 0.8 }, { type: 'sine', ratio: 2, gain: 0.2 }].forEach(function (l) {
						var osc = ctx.createOscillator();
						var g = ctx.createGain();
						osc.type = l.type;
						osc.frequency.value = freq * l.ratio;
						g.gain.setValueAtTime(0.0001, nt);
						g.gain.linearRampToValueAtTime(peak * l.gain * noteGainOf(i), nt + 0.02);
						g.gain.exponentialRampToValueAtTime(0.0001, nt + 0.35);
						osc.connect(g);
						g.connect(pan);
						osc.start(nt);
						osc.stop(nt + 0.4);
					});
				});
			},
			epiano: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq, t + i * 0.14, i, [[0.997, 0.4, 0.45], [1.003, 0.4, 0.45], [2, 0.2, 0.45]], { attack: 0.02 });
				});
			},
			sparkle: function (t) {
				var asc = freqs[0] < freqs[1];
				var notes = asc ? [freqs[0], freqs[1], freqs[1] * 1.5] : [freqs[0] * 1.5, freqs[0], freqs[1]];
				notes.forEach(function (freq, i) {
					var nt = t + i * 0.09;
					var pan = ctx.createStereoPanner();
					pan.pan.value = [-0.2, 0, 0.2][i];
					pan.connect(dest);
					var osc = ctx.createOscillator();
					var g = ctx.createGain();
						osc.type = 'sine';
						osc.frequency.value = freq;
						g.gain.setValueAtTime(0.0001, nt);
						g.gain.linearRampToValueAtTime(peak * [1, 0.85, 0.7][i], nt + 0.01);
						g.gain.exponentialRampToValueAtTime(0.0001, nt + 0.25);
						osc.connect(g);
						g.connect(pan);
						osc.start(nt);
						osc.stop(nt + 0.3);
					});
			},
			kalimba: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq, t + i * 0.13, i, [[1, 0.9, 0.2], [2.76, 0.1, 0.08]], { attack: 0.008 });
				});
			},
			woodblock: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq * 1.5, t + i * 0.15, i, [[1, 0.85, 0.06], [2.5, 0.15, 0.04]], { attack: 0.003 });
				});
			},
			waterdrop: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq, t + i * 0.14, i, [[1, 1, 0.25]], { attack: 0.006, glide: 1.3, glideTime: 0.045 });
				});
			},
			sonar: function (t) {
				layeredSine(freqs[1], t, 0, [[1, 1, 0.5]], { attack: 0.005 });
				layeredSine(freqs[1], t + 0.35, 1, [[1, 0.55, 0.5]], { attack: 0.005 });
			},
			bell: function (t) {
				freqs.forEach(function (freq, i) {
					layeredSine(freq * 2, t + i * 0.13, i, [[1, 0.6, 0.6], [2.71, 0.25, 0.25], [5.15, 0.15, 0.1]], { attack: 0.005 });
				});
			},
			terminal: function (t) {
				freqs.forEach(function (freq, i) {
					var nt = t + i * 0.15;
					var pan = ctx.createStereoPanner();
					pan.pan.value = panOf(i);
					pan.connect(dest);
					var osc = ctx.createOscillator();
					var g = ctx.createGain();
						osc.type = 'square';
						osc.frequency.value = freq / 2;
						g.gain.setValueAtTime(0.0001, nt);
						g.gain.linearRampToValueAtTime(peak * 0.3 * noteGainOf(i), nt + 0.002);
						g.gain.exponentialRampToValueAtTime(0.0001, nt + 0.12);
						osc.connect(g);
						g.connect(pan);
						osc.start(nt);
						osc.stop(nt + 0.16);
				});
			},
		};
		var kind = ${JSON.stringify(notification.soundKind)};
		(PLAYERS[kind] || PLAYERS.pop)(now);
	} catch (e) { }
})();
</script>` : '';

		// Accent color by kind, inferred from the action set: approvals are
		// attention-colored, done is calm, errors are red.
		const accentColor = notification.actions.some(a => a.actionId.startsWith('approve')) ? '#d29922'
			: notification.actions.some(a => a.actionId.startsWith('reply-expand:')) ? '#3fb950'
			: '#f85149';

		// Click the body text to view in Void (focuses the window + switches thread).
		// Buttons stopPropagation so they don't trigger this.
		const clickAction = notification.clickActionId ? this._escapeHtml(notification.clickActionId) : '';
		const clickHandler = clickAction ? `onclick="console.log('void-action:${clickAction}')"` : '';

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: rgba(24, 24, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-left: 3px solid ${accentColor};
  border-radius: 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
  color: #fff;
  padding: 12px 14px;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  box-shadow: 0 16px 48px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);
}
.container { cursor: pointer; }
.header { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
.status-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: ${accentColor}; box-shadow: 0 0 6px ${accentColor}; }
.title { flex: 1; font-size: 13px; font-weight: 600; color: #f4f4f5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { flex: none; font-size: 10px; font-weight: 600; color: #7d7d83; letter-spacing: 0.5px; text-transform: uppercase; white-space: nowrap; }
.thread-title { font-size: 12px; color: #d1d1d6; font-weight: 500; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle {
  font-family: 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; font-weight: 500; color: #e8e8ec;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); border-radius: 5px;
  padding: 3px 8px; margin-bottom: 7px;
  width: fit-content; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.body { font-size: 12.5px; color: #aeaeb2; line-height: 1.45; margin-bottom: ${buttonsHtml ? '12px' : '0'}; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.buttons { display: flex; gap: 6px; }
.btn {
  flex: 1; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px;
  font-size: 11.5px; font-weight: 500; cursor: pointer; text-align: center;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  white-space: nowrap;
}
.btn-approve { background: #238636; color: #fff; border-color: rgba(255,255,255,0.12); }
.btn-approve:hover { background: #2ea043; }
.btn-approve-all { background: transparent; color: #3fb950; border-color: rgba(63,185,80,0.5); }
.btn-approve-all:hover { background: rgba(63,185,80,0.12); }
.btn-reject { background: transparent; color: #f85149; border-color: rgba(248,81,73,0.5); }
.btn-reject:hover { background: rgba(248,81,73,0.12); }
.btn-default { background: rgba(255,255,255,0.08); color: #c9d1d9; border-color: rgba(255,255,255,0.14); }
.btn-default:hover { background: rgba(255,255,255,0.14); }
.btn-close {
  flex: none; width: 28px; margin-left: auto; padding: 0;
  background: transparent; color: #8e8e93; border-color: rgba(255,255,255,0.12);
  font-size: 14px; line-height: 1;
}
.btn-close:hover { background: rgba(255,255,255,0.12); color: #fff; }
.reply-row { margin-top: 8px; display: flex; }
.reply-row input {
  width: 100%; padding: 6px 10px; border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
  background: rgba(255,255,255,0.08); color: #f4f4f5; font-size: 13px;
  outline: none; font-family: inherit; cursor: text;
  user-select: text; -webkit-user-select: text;
}
.reply-row input:focus { border-color: rgba(255,255,255,0.32); }
.reply-row input::placeholder { color: #6e7681; }
</style>
</head>
<body>
<div class="container" ${clickHandler}>
  <div class="header">
    <span class="status-dot"></span>
    <span class="title">${title}</span>
    <span class="meta">Void &middot; ${this._escapeHtml(timestamp)}</span>
  </div>
  ${threadTitleHtml}
  ${subtitleHtml}
  <div class="body">${body}</div>
  ${buttonsHtml}
  ${replyRowHtml}
</div>
${replyScript}
${soundScript}
</body>
</html>`;
	}

	override dispose(): void {
		for (const id of this._notificationWindows.keys()) {
			this.dismissNotification(id);
		}
		super.dispose();
	}
}
