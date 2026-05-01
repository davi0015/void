/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';


import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';

import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VOID_VIEW_CONTAINER_ID, VOID_VIEW_ID } from './sidebarPane.js';
import { IMetricsService } from '../common/metricsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { VOID_TOGGLE_SETTINGS_ACTION_ID } from './voidSettingsPane.js';
import { VOID_CTRL_L_ACTION_ID } from './actionIDs.js';
import { localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { Codicon } from '../../../../base/common/codicons.js';

// ---------- Register commands and keybindings ----------


export const roundRangeToLines = (range: IRange | null | undefined, options: { emptySelectionBehavior: 'null' | 'line' }) => {
	if (!range)
		return null

	// treat as no selection if selection is empty
	if (range.endColumn === range.startColumn && range.endLineNumber === range.startLineNumber) {
		if (options.emptySelectionBehavior === 'null')
			return null
		else if (options.emptySelectionBehavior === 'line')
			return { startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: range.startLineNumber, endColumn: 1 }
	}

	// IRange is 1-indexed
	const endLine = range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber // e.g. if the user triple clicks, it selects column=0, line=line -> column=0, line=line+1
	const newRange: IRange = {
		startLineNumber: range.startLineNumber,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: Number.MAX_SAFE_INTEGER
	}
	return newRange
}

// const getContentInRange = (model: ITextModel, range: IRange | null) => {
// 	if (!range)
// 		return null
// 	const content = model.getValueInRange(range)
// 	const trimmedContent = content
// 		.replace(/^\s*\n/g, '') // trim pure whitespace lines from start
// 		.replace(/\n\s*$/g, '') // trim pure whitespace lines from end
// 	return trimmedContent
// }



const VOID_OPEN_SIDEBAR_ACTION_ID = 'void.sidebar.open'
registerAction2(class extends Action2 {
	constructor() {
		super({ id: VOID_OPEN_SIDEBAR_ACTION_ID, title: localize2('voidOpenSidebar', 'Void: Open Sidebar'), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService)
		const chatThreadsService = accessor.get(IChatThreadService)
		viewsService.openViewContainer(VOID_VIEW_CONTAINER_ID)
		await chatThreadsService.focusCurrentChat()
	}
})


// cmd L
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_CTRL_L_ACTION_ID,
			f1: true,
			title: localize2('voidCmdL', 'Void: Add Selection to Chat'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				weight: KeybindingWeight.VoidExtension
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// Get services
		const commandService = accessor.get(ICommandService)
		const viewsService = accessor.get(IViewsService)
		const metricsService = accessor.get(IMetricsService)
		const editorService = accessor.get(ICodeEditorService)
		const chatThreadService = accessor.get(IChatThreadService)

		metricsService.capture('Ctrl+L', {})

		// capture selection and model before opening the chat panel
		const editor = editorService.getActiveCodeEditor()
		const model = editor?.getModel()
		if (!model) return

		const selectionRange = roundRangeToLines(editor?.getSelection(), { emptySelectionBehavior: 'null' })

		// open panel
		const wasAlreadyOpen = viewsService.isViewContainerVisible(VOID_VIEW_CONTAINER_ID)
		if (!wasAlreadyOpen) {
			await commandService.executeCommand(VOID_OPEN_SIDEBAR_ACTION_ID)
		}

		// Add selection to chat
		// add line selection
		if (selectionRange) {
			editor?.setSelection({
				startLineNumber: selectionRange.startLineNumber,
				endLineNumber: selectionRange.endLineNumber,
				startColumn: 1,
				endColumn: Number.MAX_SAFE_INTEGER
			})
			chatThreadService.addNewStagingSelection({
				type: 'CodeSelection',
				uri: model.uri,
				language: model.getLanguageId(),
				range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
				state: { wasAddedAsCurrentFile: false },
			})
		}
		// add file
		else {
			chatThreadService.addNewStagingSelection({
				type: 'File',
				uri: model.uri,
				language: model.getLanguageId(),
				state: { wasAddedAsCurrentFile: false },
			})
		}

		await chatThreadService.focusCurrentChat()
	}
})


// New chat keybind + menu button
const VOID_CMD_SHIFT_L_ACTION_ID = 'void.cmdShiftL'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_CMD_SHIFT_L_ACTION_ID,
			title: 'New Chat',
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
				weight: KeybindingWeight.VoidExtension,
			},
			icon: { id: 'add' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', when: ContextKeyExpr.equals('view', VOID_VIEW_ID), }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {

		const metricsService = accessor.get(IMetricsService)
		const chatThreadsService = accessor.get(IChatThreadService)
		const editorService = accessor.get(ICodeEditorService)
		metricsService.capture('Chat Navigation', { type: 'Start New Chat' })

		// get current selections and value to transfer
		const oldThreadId = chatThreadsService.state.currentThreadId
		const oldThread = chatThreadsService.state.allThreads[oldThreadId]

		const oldUI = await oldThread?.state.mountedInfo?.whenMounted

		const oldSelns = oldThread?.state.stagingSelections
		const oldVal = oldUI?.textAreaRef?.current?.value

		// open and focus new thread
		chatThreadsService.openNewThread()
		await chatThreadsService.focusCurrentChat()


		// set new thread values
		const newThreadId = chatThreadsService.state.currentThreadId
		const newThread = chatThreadsService.state.allThreads[newThreadId]

		const newUI = await newThread?.state.mountedInfo?.whenMounted
		chatThreadsService.setCurrentThreadState({ stagingSelections: oldSelns, })
		if (newUI?.textAreaRef?.current && oldVal) newUI.textAreaRef.current.value = oldVal


		// if has selection, add it
		const editor = editorService.getActiveCodeEditor()
		const model = editor?.getModel()
		if (!model) return
		const selectionRange = roundRangeToLines(editor?.getSelection(), { emptySelectionBehavior: 'null' })
		if (!selectionRange) return
		editor?.setSelection({ startLineNumber: selectionRange.startLineNumber, endLineNumber: selectionRange.endLineNumber, startColumn: 1, endColumn: Number.MAX_SAFE_INTEGER })
		chatThreadsService.addNewStagingSelection({
			type: 'CodeSelection',
			uri: model.uri,
			language: model.getLanguageId(),
			range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
			state: { wasAddedAsCurrentFile: false },
		})
	}
})

// History menu button
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'void.historyAction',
			title: 'View Past Chats',
			icon: { id: 'history' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', when: ContextKeyExpr.equals('view', VOID_VIEW_ID), }]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {

		// do not do anything if there are no messages (without this it clears all of the user's selections if the button is pressed)
		// TODO the history button should be disabled in this case so we can remove this logic
		const thread = accessor.get(IChatThreadService).getCurrentThread()
		if (thread.messages.length === 0) {
			return;
		}

		const metricsService = accessor.get(IMetricsService)

		const commandService = accessor.get(ICommandService)

		metricsService.capture('Chat Navigation', { type: 'History' })
		commandService.executeCommand(VOID_CMD_SHIFT_L_ACTION_ID)

	}
})


// Settings gear
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'void.settingsAction',
			title: `Void's Settings`,
			icon: { id: 'settings-gear' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', when: ContextKeyExpr.equals('view', VOID_VIEW_ID), }]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService)
		commandService.executeCommand(VOID_TOGGLE_SETTINGS_ACTION_ID)
	}
})




// export class TabSwitchListener extends Disposable {

// 	constructor(
// 		onSwitchTab: () => void,
// 		@ICodeEditorService private readonly _editorService: ICodeEditorService,
// 	) {
// 		super()

// 		// when editor switches tabs (models)
// 		const addTabSwitchListeners = (editor: ICodeEditor) => {
// 			this._register(editor.onDidChangeModel(e => {
// 				if (e.newModelUrl?.scheme !== 'file') return
// 				onSwitchTab()
// 			}))
// 		}

// 		const initializeEditor = (editor: ICodeEditor) => {
// 			addTabSwitchListeners(editor)
// 		}

// 		// initialize current editors + any new editors
// 		for (let editor of this._editorService.listCodeEditors()) initializeEditor(editor)
// 		this._register(this._editorService.onCodeEditorAdd(editor => { initializeEditor(editor) }))
// 	}
// }


// ---------- Terminal → chat ----------

// Hard cap on a single terminal snippet, in UTF-16 code units (~bytes for ASCII).
// Picked to (a) keep one capture from blowing up the prompt budget on its own,
// (b) leave headroom for additional chips in the same turn. Truncation is
// middle-out with a tail bias because errors and stack traces tend to live at
// the end of an output stream.
const TERMINAL_SNIPPET_MAX_CHARS = 32 * 1024
const TERMINAL_SNIPPET_HEAD_CHARS = 8 * 1024
const TERMINAL_SNIPPET_TAIL_CHARS = TERMINAL_SNIPPET_MAX_CHARS - TERMINAL_SNIPPET_HEAD_CHARS

const truncateTerminalText = (text: string): { text: string; truncated: boolean } => {
	if (text.length <= TERMINAL_SNIPPET_MAX_CHARS) return { text, truncated: false }
	const head = text.slice(0, TERMINAL_SNIPPET_HEAD_CHARS)
	const tail = text.slice(text.length - TERMINAL_SNIPPET_TAIL_CHARS)
	const omitted = text.length - TERMINAL_SNIPPET_HEAD_CHARS - TERMINAL_SNIPPET_TAIL_CHARS
	const sep = `\n\n... [${omitted} chars truncated, kept first ${TERMINAL_SNIPPET_HEAD_CHARS} + last ${TERMINAL_SNIPPET_TAIL_CHARS}] ...\n\n`
	return { text: `${head}${sep}${tail}`, truncated: true }
}

const buildTerminalSelection = (opts: {
	rawText: string,
	command?: string,
	cwd?: string,
	exitCode?: number,
}): StagingSelectionItem & { type: 'Terminal' } => {
	const { text, truncated } = truncateTerminalText(opts.rawText)
	const lineCount = text.split('\n').length

	// Chip label policy:
	//  - command-mode (have the command string): show command, truncated to keep
	//    the chip narrow enough to fit alongside file chips. Append `· exit N`
	//    when we know the exit code so failures are visible at a glance.
	//  - selection-mode (no command): "Terminal (12 lines)" with a `truncated`
	//    suffix when applicable. Line count is more useful than byte count for
	//    selection captures since users select by lines visually.
	const labelParts: string[] = []
	if (opts.command) {
		const cmd = opts.command.length > 40 ? opts.command.slice(0, 40) + '…' : opts.command
		labelParts.push(cmd)
	} else {
		labelParts.push(`Terminal (${lineCount} lines${truncated ? ', truncated' : ''})`)
	}
	if (typeof opts.exitCode === 'number') labelParts.push(`exit ${opts.exitCode}`)
	const label = labelParts.join(' · ')

	return {
		type: 'Terminal',
		// Synthetic per-snapshot URI so existing code paths that key off
		// `selection.uri` keep working. Each capture is its own snapshot, never
		// deduped — see findStagingSelectionIndex in chatThreadService.ts.
		uri: URI.from({ scheme: 'void-terminal', path: `/snapshot/${generateUuid()}` }),
		language: 'shellscript',
		text,
		command: opts.command,
		cwd: opts.cwd,
		exitCode: opts.exitCode,
		label,
		state: { wasAddedAsCurrentFile: false },
	}
}

// Open the chat panel + focus, mirroring the editor Cmd+L flow. Extracted so
// both terminal actions reuse the exact same panel-open behaviour.
const openChatAndAttach = async (
	accessor: ServicesAccessor,
	selection: StagingSelectionItem,
) => {
	const commandService = accessor.get(ICommandService)
	const viewsService = accessor.get(IViewsService)
	const chatThreadService = accessor.get(IChatThreadService)

	const wasAlreadyOpen = viewsService.isViewContainerVisible(VOID_VIEW_CONTAINER_ID)
	if (!wasAlreadyOpen) {
		await commandService.executeCommand(VOID_OPEN_SIDEBAR_ACTION_ID)
	}
	chatThreadService.addNewStagingSelection(selection)
	await chatThreadService.focusCurrentChat()
}


export const VOID_TERMINAL_ADD_SELECTION_ACTION_ID = 'void.terminal.addSelectionToChat'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_TERMINAL_ADD_SELECTION_ACTION_ID,
			f1: true,
			title: localize2('voidTerminalAddSelection', 'Void: Add Terminal Selection to Chat'),
			// Icon used by the terminal-panel toolbar entry below. The
			// codicon `comment-discussion` reads as "talk about this" in
			// most VS Code menu surfaces, which is closer to the intent
			// than `add` or `send` (both of which already have other
			// meanings in adjacent buttons).
			icon: Codicon.commentDiscussion,
			// Cmd+L only fires when the terminal is focused AND there's a selection.
			// When terminal is focused with no selection, the editor's Cmd+L action
			// (registered above without `when`) doesn't activate either because it
			// reaches for the active code editor and gets null — so the keystroke
			// is a quiet no-op rather than mis-firing on whatever was selected in
			// the last editor. That's the desired behaviour: don't surprise the
			// user. The "no selection" path is covered by the explicit
			// "Add Last Terminal Command" action below.
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				when: ContextKeyExpr.and(TerminalContextKeys.focus, TerminalContextKeys.textSelected),
				// One step above the editor Cmd+L (`VoidExtension = 605`) so the
				// dispatcher prefers this more-specific terminal binding when its
				// `when` clause matches. Without the bump, ties resolve by
				// registration order which is not stable across reloads.
				weight: KeybindingWeight.VoidExtension + 1,
			},
			// Register on BOTH terminal context menus: panel terminals use
			// `TerminalInstanceContext`, terminal editor tabs use
			// `TerminalEditorInstanceContext`. Without both, right-clicking
			// the terminal opened as an editor tab shows nothing new.
			//
			// We deliberately do NOT gate the right-click entries on
			// `TerminalContextKeys.textSelected` — empirically the context
			// key isn't reliably updated at the moment the context menu is
			// computed in some terminal implementations (e.g. xterm
			// selection state vs. VS Code context key sync timing). Always
			// showing the item is consistent with the "Last Command" entry,
			// and the run() handler shows a clear toast if there's nothing
			// selected.
			//
			// The third entry (`MenuId.ViewTitle`) is the lightweight
			// "popup-replacement" affordance: an icon button that appears
			// in the terminal panel's toolbar only when text is selected.
			// It's there to surface the feature without a right-click,
			// per Option B from the design discussion. Unlike the
			// right-click entries, this one IS gated on `textSelected`
			// because the whole point is to appear/disappear with the
			// selection — the user explicitly asked for "popup when text is
			// selected" UX. If `textSelected` ever proves unreliable here,
			// fallback would be to drop the gate and always show the icon.
			menu: [
				{
					id: MenuId.TerminalInstanceContext,
					group: '3_edit',
					order: 100,
				},
				{
					id: MenuId.TerminalEditorInstanceContext,
					group: '3_edit',
					order: 100,
				},
				{
					id: MenuId.ViewTitle,
					group: 'navigation',
					// Place to the left of Split (order 2) and Kill (order 3)
					// so it's adjacent to where users naturally look after
					// selecting text, rather than buried at the right end.
					order: 1,
					// Always show in the terminal panel toolbar. We tried
					// gating on `TerminalContextKeys.textSelected` (and the
					// OR of `textSelectedInFocused | textSelected`) but the
					// xterm-side selection signals don't reliably flip the
					// VS Code context keys before the menu re-evaluates,
					// so the icon would never appear. Always-visible is
					// the deterministic option; the run() handler shows a
					// clear toast when invoked without a selection.
					when: ContextKeyExpr.equals('view', TERMINAL_VIEW_ID),
				},
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService)
		const notificationService = accessor.get(INotificationService)
		const metricsService = accessor.get(IMetricsService)

		const terminal = terminalService.activeInstance
		const rawText = terminal?.selection
		if (!terminal || !rawText) {
			notificationService.notify({
				severity: Severity.Info,
				message: 'Void: select text in the terminal first.',
			})
			return
		}

		// Best-effort cwd from CommandDetection (works under shell integration).
		// Fine if unavailable — the chip just omits the cwd field.
		const cwd = terminal.capabilities.get(TerminalCapability.CommandDetection)?.cwd

		metricsService.capture('Terminal: Add Selection to Chat', { chars: rawText.length })

		await openChatAndAttach(accessor, buildTerminalSelection({ rawText, cwd }))
	}
})


export const VOID_TERMINAL_ADD_LAST_COMMAND_ACTION_ID = 'void.terminal.addLastCommandOutputToChat'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_TERMINAL_ADD_LAST_COMMAND_ACTION_ID,
			f1: true,
			title: localize2('voidTerminalAddLastCommand', 'Void: Add Last Terminal Command Output to Chat'),
			// No default keybind — Cmd+L is reserved for selection. Users can
			// bind one in keybindings.json if they want.
			//
			// Menu visibility note: we deliberately do NOT gate this on
			// `terminalShellIntegrationEnabled`. The action is more
			// discoverable when always present, and the run() handler shows
			// a clear toast if shell integration isn't active in the current
			// terminal. Hidden menu items are confusing for a brand-new
			// feature.
			//
			// Registered on BOTH terminal context menus so it shows in panel
			// terminals AND editor-tab terminals.
			menu: [
				{
					id: MenuId.TerminalInstanceContext,
					group: '3_edit',
					order: 101,
				},
				{
					id: MenuId.TerminalEditorInstanceContext,
					group: '3_edit',
					order: 101,
				},
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService)
		const notificationService = accessor.get(INotificationService)
		const metricsService = accessor.get(IMetricsService)

		const terminal = terminalService.activeInstance
		const detection = terminal?.capabilities.get(TerminalCapability.CommandDetection)
		if (!terminal || !detection) {
			notificationService.notify({
				severity: Severity.Warning,
				message: 'Void: shell integration is not active in this terminal, so command output can\'t be captured automatically. Tip: select the output manually and use Cmd+L (or right-click → "Add Terminal Selection to Chat").',
			})
			return
		}

		// `commands` is chronological. We require BOTH a non-empty command
		// line AND non-empty trimmed output:
		//   - command must be non-empty: bare-Enter entries record `command: ''`
		//     and we want to skip them.
		//   - output must be non-empty after trim: rules out the case where
		//     `getOutput()` hands back just the next prompt line (e.g.
		//     `(base) user@host repo %`) for an empty-Enter — that's not
		//     real output, it's shell-integration markers landing on the
		//     prompt redraw region.
		// Trade-off: a real silent command like `mkdir foo` (non-empty
		// command, empty output) gets skipped. That's acceptable because
		// there's nothing useful to attach for those anyway, and conflating
		// a `mkdir foo` with the previous noisy command would be more
		// confusing than skipping it.
		// Also implicitly skips the in-flight `currentCommand` (not in
		// `commands` yet).
		const commands = detection.commands
		let lastFinished: typeof commands[number] | undefined
		let rawText = ''
		for (let i = commands.length - 1; i >= 0; i--) {
			const c = commands[i]
			const cmdTrimmed = (c.command ?? '').trim()
			if (cmdTrimmed.length === 0) continue
			const out = c.getOutput()
			if (!out || out.trim().length === 0) continue
			lastFinished = c
			rawText = out
			break
		}
		if (!lastFinished) {
			notificationService.notify({
				severity: Severity.Warning,
				message: 'Void: no recent terminal command produced output. Run a command first, then try again.',
			})
			return
		}

		const command = lastFinished.command

		metricsService.capture('Terminal: Add Last Command Output to Chat', {
			chars: rawText.length,
			exitCode: lastFinished.exitCode,
		})

		await openChatAndAttach(accessor, buildTerminalSelection({
			rawText,
			command,
			cwd: lastFinished.cwd,
			exitCode: lastFinished.exitCode,
		}))
	}
})
