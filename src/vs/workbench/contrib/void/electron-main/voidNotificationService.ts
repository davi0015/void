/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Void. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, globalShortcut, screen } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export type VoidNotification = {
	id: string;
	title: string;
	subtitle?: string;
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
 * Global keyboard shortcuts (⌘⇧A / ⌘⇧R) provide a zero-focus alternative.
 *
 * Reply: the Reply button (done notifications) temporarily makes the panel
 * keyable so the user can type a response without switching to Void — the
 * panel window type keeps the app itself from activating. The typed text is
 * sent back as a 'reply:<threadId>:<encoded text>' action.
 */
export class VoidNotificationService extends Disposable {

	private readonly _notificationWindows = new Map<string, { window: BrowserWindow; timeout: NodeJS.Timeout | undefined; shortcuts: string[]; height: number }>();

	private readonly _onNotificationAction = this._register(new Emitter<string>());
	readonly onNotificationAction: Event<string> = this._onNotificationAction.event;

	private static readonly NOTIFICATION_WIDTH = 360;
	private static readonly NOTIFICATION_DEFAULT_HEIGHT = 180;
	private static readonly NOTIFICATION_MIN_HEIGHT = 120;
	private static readonly NOTIFICATION_MAX_HEIGHT = 260;
	private static readonly NOTIFICATION_MARGIN = 20;
	private static readonly NOTIFICATION_GAP = 10;
	private static readonly NOTIFICATION_TIMEOUT_MS = 20000;

	async showNotification(notification: VoidNotification): Promise<void> {
		// Close existing notification with same id (dedup)
		await this.dismissNotification(notification.id);

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
				win.setFocusable(true);
				win.focus();
				win.webContents.executeJavaScript('document.getElementById("void-reply-row").style.display = "flex"; document.getElementById("void-reply-input").focus();').catch(() => { });
				this._resizeToContent(win, notification.id);
				return;
			}
			if (actionId === 'reply-collapse') {
				win.setFocusable(false);
				this._resizeToContent(win, notification.id);
				return;
			}

			if (actionId !== 'close') {
				this._onNotificationAction.fire(actionId);
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

		// Register global keyboard shortcuts for the actions that have one.
		// Mapped by label so extra actions (Reply, Approve all) never pick up
		// a shortcut meant for another button.
		const shortcutAccelOfActionLabel: Record<string, string> = {
			'Approve': 'CmdOrCtrl+Shift+A',
			'Reject': 'CmdOrCtrl+Shift+R',
		};
		const shortcuts: string[] = [];
		for (const action of notification.actions) {
			const accel = shortcutAccelOfActionLabel[action.label];
			if (accel && globalShortcut.register(accel, () => {
				this._onNotificationAction.fire(action.actionId);
				this.dismissNotification(notification.id);
			})) {
				shortcuts.push(accel);
			}
		}

		this._notificationWindows.set(notification.id, { window: win, timeout, shortcuts, height: VoidNotificationService.NOTIFICATION_DEFAULT_HEIGHT });
	}

	async dismissNotification(id: string): Promise<void> {
		const entry = this._notificationWindows.get(id);
		if (!entry) return;
		if (entry.timeout) { clearTimeout(entry.timeout); }
		for (const accel of entry.shortcuts) {
			globalShortcut.unregister(accel);
		}
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
		return win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)').then(measured => {
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

		const shortcutLabelOfActionLabel: Record<string, string> = {
			'Approve': '\u2318\u21e7A',
			'Reject': '\u2318\u21e7R',
		};
		const allButtons = [...notification.actions, { label: 'Dismiss', actionId: 'close' }];
		const buttonsHtml = `<div class="buttons">${allButtons.map(a => {
			const cls = a.label.toLowerCase().includes('approve') ? 'btn-approve' : a.label.toLowerCase().includes('reject') ? 'btn-reject' : 'btn-default';
			const hint = shortcutLabelOfActionLabel[a.label] ? `<span class="shortcut">${shortcutLabelOfActionLabel[a.label]}</span>` : '';
			return `<button class="btn ${cls}" onmousedown="event.preventDefault()" onclick="event.preventDefault(); event.stopPropagation(); console.log('void-action:${this._escapeHtml(a.actionId)}')">${this._escapeHtml(a.label)}${hint}</button>`;
		}).join('')}</div>`;

		const subtitleHtml = subtitle ? `<div class="subtitle">${subtitle}</div>` : '';

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
  background: rgba(30, 30, 30, 0.92);
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
  color: #fff;
  padding: 14px 16px;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
.container { cursor: pointer; }
.title { font-size: 14px; font-weight: 600; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle { font-size: 13px; color: #8e8e93; margin-bottom: 6px; font-weight: 500; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.body { font-size: 13px; color: #aeaeb2; line-height: 1.4; margin-bottom: ${buttonsHtml ? '12px' : '0'}; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.buttons { display: flex; gap: 6px; }
.btn {
  flex: 1; padding: 6px 8px; border: none; border-radius: 6px;
  font-size: 12px; font-weight: 500; cursor: pointer; text-align: center;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  white-space: nowrap;
}
.shortcut { font-size: 10px; opacity: 0.6; }
.btn-approve { background: #30d158; color: #000; }
.btn-approve:hover { background: #28b84c; }
.btn-reject { background: #ff453a; color: #fff; }
.btn-reject:hover { background: #d63a30; }
.btn-default { background: rgba(255,255,255,0.15); color: #fff; }
.reply-row { margin-top: 8px; display: flex; }
.reply-row input {
  width: 100%; padding: 6px 10px; border: none; border-radius: 6px;
  background: rgba(255,255,255,0.12); color: #fff; font-size: 13px;
  outline: none; font-family: inherit; cursor: text;
  user-select: text; -webkit-user-select: text;
}
.reply-row input::placeholder { color: #636366; }
</style>
</head>
<body>
<div class="container" ${clickHandler}>
  <div class="title">${title}</div>
  ${subtitleHtml}
  <div class="body">${body}</div>
  ${buttonsHtml}
  ${replyRowHtml}
</div>
${replyScript}
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
