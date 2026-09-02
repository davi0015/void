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
	private static readonly NOTIFICATION_TIMEOUT_MS = 12000;

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
			if (message.startsWith('void-action:')) {
				event.preventDefault();
				const actionId = message.slice('void-action:'.length);
				if (actionId !== 'close') {
					this._onNotificationAction.fire(actionId);
				}
				this.dismissNotification(notification.id);
			}
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
			win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)').then(measured => {
				const contentHeight = typeof measured === 'number' && measured > 0 ? measured : VoidNotificationService.NOTIFICATION_DEFAULT_HEIGHT;
				const height = Math.min(Math.max(contentHeight, VoidNotificationService.NOTIFICATION_MIN_HEIGHT), VoidNotificationService.NOTIFICATION_MAX_HEIGHT);
				const entry = this._notificationWindows.get(notification.id);
				if (entry) entry.height = height;
				win.setContentSize(VoidNotificationService.NOTIFICATION_WIDTH, height);
				showNow();
				this._repositionNotifications();
			}).catch(() => showNow()).finally(() => clearTimeout(fallbackTimer));
		});

		const html = this._buildNotificationHtml(notification);
		win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

		// Auto-dismiss for notifications without action buttons (done/error)
		let timeout: NodeJS.Timeout | undefined;
		if (notification.actions.length === 0) {
			timeout = setTimeout(() => {
				this.dismissNotification(notification.id);
			}, VoidNotificationService.NOTIFICATION_TIMEOUT_MS);
		}

		// Register global keyboard shortcuts for action buttons
		const shortcuts: string[] = [];
		if (notification.actions.length > 0) {
			const shortcutAccels = ['CmdOrCtrl+Shift+A', 'CmdOrCtrl+Shift+R'];
			notification.actions.forEach((action, i) => {
				const accel = shortcutAccels[i];
				if (accel && globalShortcut.register(accel, () => {
					this._onNotificationAction.fire(action.actionId);
					this.dismissNotification(notification.id);
				})) {
					shortcuts.push(accel);
				}
			});
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

		const shortcutLabels = ['\u2318\u21e7A', '\u2318\u21e7R', ''];
		const allButtons = [...notification.actions, { label: 'Dismiss', actionId: 'close' }];
		const buttonsHtml = `<div class="buttons">${allButtons.map((a, i) => {
			const cls = a.label.toLowerCase().includes('approve') ? 'btn-approve' : a.label.toLowerCase().includes('reject') ? 'btn-reject' : 'btn-default';
			const hint = shortcutLabels[i] ? `<span class="shortcut">${shortcutLabels[i]}</span>` : '';
			return `<button class="btn ${cls}" onmousedown="event.preventDefault()" onclick="event.preventDefault(); event.stopPropagation(); console.log('void-action:${this._escapeHtml(a.actionId)}')">${this._escapeHtml(a.label)}${hint}</button>`;
		}).join('')}</div>`;

		const subtitleHtml = subtitle ? `<div class="subtitle">${subtitle}</div>` : '';
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
.body { font-size: 13px; color: #aeaeb2; line-height: 1.4; margin-bottom: ${buttonsHtml ? '12px' : '0'}; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
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
</style>
</head>
<body>
<div class="container" ${clickHandler}>
  <div class="title">${title}</div>
  ${subtitleHtml}
  <div class="body">${body}</div>
  ${buttonsHtml}
</div>
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
