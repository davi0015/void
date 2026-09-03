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

		const allButtons = [...notification.actions, { label: 'Dismiss', actionId: 'close' }];
		const buttonsHtml = `<div class="buttons">${allButtons.map(a => {
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

		// Soft two-tone chime for notifications. Synthesized with WebAudio
		// inside the notification page — no bundled asset needed, and Electron's
		// default autoplay policy allows it without a gesture. Approvals chime
		// ascending (attention); chat-complete chimes descending (resolution) —
		// mirroring the accent-color inference, so the user can tell "needs me"
		// from "finished" without looking.
		// The requested volume (0-1, clamped) scales the chime's peak gain on a
		// quadratic curve — perceived loudness is logarithmic, so a linear mapping
		// would spend most of the slider range below the audible-difference
		// threshold. 100% = 0.7 peak gain (~6x the original 0.12 loudness).
		const soundVolume = Math.min(Math.max(notification.sound ?? 0, 0), 1);
		const peakGain = 0.7 * soundVolume * soundVolume;
		const chimeFrequencies = notification.actions.some(a => a.actionId.startsWith('approve')) ? [880, 1174.66] : [1174.66, 880];
		const soundScript = peakGain > 0 ? `
<script>
(function () {
	try {
		var ctx = new AudioContext();
		var now = ctx.currentTime;
		var peak = ${peakGain.toFixed(4)};
		var freqs = ${JSON.stringify(chimeFrequencies)};
		freqs.forEach(function (freq, i) {
			var t = now + i * 0.15;
			var osc = ctx.createOscillator();
			var g = ctx.createGain();
			osc.type = 'sine';
			osc.frequency.value = freq;
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
			osc.connect(g);
			g.connect(ctx.destination);
			osc.start(t);
			osc.stop(t + 0.65);
		});
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
  background: rgba(22, 22, 26, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-left: 3px solid ${accentColor};
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
  color: #fff;
  padding: 14px 16px;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  box-shadow: 0 16px 48px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);
}
.container { cursor: pointer; }
.title { font-size: 14px; font-weight: 600; color: #f4f4f5; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thread-title { font-size: 12px; color: #d1d1d6; font-weight: 500; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle { font-size: 13px; color: #8e8e93; margin-bottom: 6px; font-weight: 500; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.body { font-size: 13px; color: #aeaeb2; line-height: 1.4; margin-bottom: ${buttonsHtml ? '12px' : '0'}; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.buttons { display: flex; gap: 6px; }
.btn {
  flex: 1; padding: 6px 8px; border: 1px solid transparent; border-radius: 6px;
  font-size: 12px; font-weight: 500; cursor: pointer; text-align: center;
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
  <div class="title">${title}</div>
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
