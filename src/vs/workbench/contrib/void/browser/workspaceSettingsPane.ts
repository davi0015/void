/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

import { mountWorkspaceSettings } from './react/out/workspace-settings-tsx/index.js'
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { VOID_VIEW_ID } from './sidebarPane.js';


class VoidWorkspaceSettingsInput extends EditorInput {

	static readonly ID: string = 'workbench.input.void.workspaceSettings';

	static readonly RESOURCE = URI.from({
		scheme: 'void',
		path: 'workspaceSettings'
	})
	readonly resource = VoidWorkspaceSettingsInput.RESOURCE;

	constructor() {
		super();
	}

	override get typeId(): string {
		return VoidWorkspaceSettingsInput.ID;
	}

	override getName(): string {
		return nls.localize('voidWorkspaceSettingsName', 'Workspace Settings');
	}

	override getIcon() {
		return Codicon.key
	}

}


class VoidWorkspaceSettingsPane extends EditorPane {
	static readonly ID = 'workbench.input.void.workspaceSettingsPane';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(VoidWorkspaceSettingsPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const elt = document.createElement('div');
		elt.style.height = '100%';
		elt.style.width = '100%';

		parent.appendChild(elt);

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountWorkspaceSettings(elt, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()))
		});
	}

	layout(_dimension: Dimension): void { }


	override get minimumWidth() { return 700 }

}

// register the pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoidWorkspaceSettingsPane, VoidWorkspaceSettingsPane.ID, nls.localize('VoidWorkspaceSettingsPane', "Void Workspace Settings Pane")),
	[new SyncDescriptor(VoidWorkspaceSettingsInput)]
);


// Action: toggle / open the workspace settings pane. Wired to the key icon
// in the sidebar view title (replaces the QuickPick that was there before).
export const VOID_TOGGLE_WORKSPACE_SETTINGS_ACTION_ID = 'workbench.action.toggleVoidWorkspaceSettings'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOID_TOGGLE_WORKSPACE_SETTINGS_ACTION_ID,
			title: nls.localize2('voidWorkspaceSettings', "Void: Toggle Workspace Settings"),
			icon: Codicon.key,
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', when: ContextKeyExpr.equals('view', VOID_VIEW_ID), }]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupService = accessor.get(IEditorGroupsService);
		const instantiationService = accessor.get(IInstantiationService);

		// if is open, close it
		const openEditors = editorService.findEditors(VoidWorkspaceSettingsInput.RESOURCE);
		if (openEditors.length !== 0) {
			const openEditor = openEditors[0].editor
			const isCurrentlyOpen = editorService.activeEditor?.resource?.fsPath === openEditor.resource?.fsPath
			if (isCurrentlyOpen)
				await editorService.closeEditors(openEditors)
			else
				await editorGroupService.activeGroup.openEditor(openEditor)
			return;
		}

		// else open it
		const input = instantiationService.createInstance(VoidWorkspaceSettingsInput);
		await editorGroupService.activeGroup.openEditor(input);
	}
})
