/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState, useEffect, useCallback } from 'react'
import { MCPUserState, RefreshableProviderName, SettingsOfProvider } from '../../../../../../../workbench/contrib/void/common/voidSettingsTypes.js'
import { DisposableStore, IDisposable } from '../../../../../../../base/common/lifecycle.js'
import { VoidSettingsState } from '../../../../../../../workbench/contrib/void/common/voidSettingsService.js'
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js'
import { RefreshModelStateOfProvider } from '../../../../../../../workbench/contrib/void/common/refreshModelService.js'

import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';
import { IExplorerService } from '../../../../../../../workbench/contrib/files/browser/files.js'
import { IModelService } from '../../../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService, IContextMenuService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { ILLMMessageService } from '../../../../common/sendLLMMessageService.js';
import { IRefreshModelService } from '../../../../../../../workbench/contrib/void/common/refreshModelService.js';
import { IVoidSettingsService } from '../../../../../../../workbench/contrib/void/common/voidSettingsService.js';
import { IExtensionTransferService } from '../../../../../../../workbench/contrib/void/browser/extensionTransferService.js'

import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js'
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js'
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js'
import { IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js'
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js'
import { IAccessibilityService } from '../../../../../../../platform/accessibility/common/accessibility.js'
import { ILanguageConfigurationService } from '../../../../../../../editor/common/languages/languageConfigurationRegistry.js'
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js'
import { ILanguageDetectionService } from '../../../../../../services/languageDetection/common/languageDetectionWorkerService.js'
import { IKeybindingService } from '../../../../../../../platform/keybinding/common/keybinding.js'
import { IEnvironmentService } from '../../../../../../../platform/environment/common/environment.js'
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js'
import { IPathService } from '../../../../../../../workbench/services/path/common/pathService.js'
import { IMetricsService } from '../../../../../../../workbench/contrib/void/common/metricsService.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { IChatThreadService, IsRunningType, ThreadsState, ThreadStreamState, ThreadType } from '../../../chatThreadService.js'
import { type LLMUsage } from '../../../../common/sendLLMMessageTypes.js'
import { type CompactionInfo } from '../../../../common/chatThreadServiceTypes.js'
import { ITerminalToolService } from '../../../terminalToolService.js'
import { ILanguageService } from '../../../../../../../editor/common/languages/language.js'
import { IVoidModelService } from '../../../../common/voidModelService.js'
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js'
import { IVoidCommandBarService } from '../../../voidCommandBarService.js'
import { INativeHostService } from '../../../../../../../platform/native/common/native.js';
import { IEditCodeService } from '../../../editCodeServiceInterface.js'
import { IToolsService } from '../../../toolsService.js'
import { IConvertToLLMMessageService } from '../../../convertToLLMMessageService.js'
import { ITerminalService } from '../../../../../terminal/browser/terminal.js'
import { ISearchService } from '../../../../../../services/search/common/search.js'
import { IExtensionManagementService } from '../../../../../../../platform/extensionManagement/common/extensionManagement.js'
import { IMCPService } from '../../../../common/mcpService.js';
import { IStorageService, StorageScope } from '../../../../../../../platform/storage/common/storage.js'
import { OPT_OUT_KEY } from '../../../../common/storageKeys.js'
import { registerChatDevTools } from '../../../chatThreadDevTools.js'


// normally to do this you'd use a useEffect that calls .onDidChangeState(), but useEffect mounts too late and misses initial state changes

// even if React hasn't mounted yet, the variables are always updated to the latest state.
// React listens by adding a setState function to these listeners.

let chatThreadsState: ThreadsState
const chatThreadsStateListeners: Set<(s: ThreadsState) => void> = new Set()

let chatThreadsStreamState: ThreadStreamState
const chatThreadsStreamStateListeners: Set<(threadId: string) => void> = new Set()

let chatThreadsLatestUsageOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
let chatThreadsCumulativeUsageThisTurnOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
let chatThreadsCumulativeUsageThisThreadOfThreadId: { [threadId: string]: LLMUsage | undefined } = {}
let chatThreadsLatestCompactionOfThreadId: { [threadId: string]: CompactionInfo | undefined } = {}
let chatThreadsCumulativeCompactionThisTurnOfThreadId: { [threadId: string]: CompactionInfo | undefined } = {}
let chatThreadsCumulativeCompactionThisThreadOfThreadId: { [threadId: string]: CompactionInfo | undefined } = {}

let settingsState: VoidSettingsState
const settingsStateListeners: Set<(s: VoidSettingsState) => void> = new Set()

let refreshModelState: RefreshModelStateOfProvider
const refreshModelStateListeners: Set<(s: RefreshModelStateOfProvider) => void> = new Set()
const refreshModelProviderListeners: Set<(p: RefreshableProviderName, s: RefreshModelStateOfProvider) => void> = new Set()

let colorThemeState: ColorScheme
const colorThemeStateListeners: Set<(s: ColorScheme) => void> = new Set()

const ctrlKZoneStreamingStateListeners: Set<(diffareaid: number, s: boolean) => void> = new Set()
const commandBarURIStateListeners: Set<(uri: URI) => void> = new Set();
const activeURIListeners: Set<(uri: URI | null) => void> = new Set();

const mcpListeners: Set<() => void> = new Set()


// must call this before you can use any of the hooks below
// this should only be called ONCE! this is the only place you don't need to dispose onDidChange. If you use state.onDidChange anywhere else, make sure to dispose it!
export const _registerServices = (accessor: ServicesAccessor) => {

	const disposables: IDisposable[] = []

	_registerAccessor(accessor)

	registerChatDevTools(accessor.get(IChatThreadService))

	const stateServices = {
		chatThreadsStateService: accessor.get(IChatThreadService),
		settingsStateService: accessor.get(IVoidSettingsService),
		refreshModelService: accessor.get(IRefreshModelService),
		themeService: accessor.get(IThemeService),
		editCodeService: accessor.get(IEditCodeService),
		voidCommandBarService: accessor.get(IVoidCommandBarService),
		modelService: accessor.get(IModelService),
		mcpService: accessor.get(IMCPService),
	}

	const { settingsStateService, chatThreadsStateService, refreshModelService, themeService, editCodeService, voidCommandBarService, modelService, mcpService } = stateServices




	chatThreadsState = chatThreadsStateService.state
	disposables.push(
		chatThreadsStateService.onDidChangeCurrentThread(() => {
			chatThreadsState = chatThreadsStateService.state
			chatThreadsStateListeners.forEach(l => l(chatThreadsState))
		})
	)

	// same service, different state
	chatThreadsStreamState = chatThreadsStateService.streamState
	chatThreadsLatestUsageOfThreadId = chatThreadsStateService.latestUsageOfThreadId
	chatThreadsCumulativeUsageThisTurnOfThreadId = chatThreadsStateService.cumulativeUsageThisTurnOfThreadId
	chatThreadsCumulativeUsageThisThreadOfThreadId = chatThreadsStateService.cumulativeUsageThisThreadOfThreadId
	chatThreadsLatestCompactionOfThreadId = chatThreadsStateService.latestCompactionOfThreadId
	chatThreadsCumulativeCompactionThisTurnOfThreadId = chatThreadsStateService.cumulativeCompactionThisTurnOfThreadId
	chatThreadsCumulativeCompactionThisThreadOfThreadId = chatThreadsStateService.cumulativeCompactionThisThreadOfThreadId
	disposables.push(
		chatThreadsStateService.onDidChangeStreamState(({ threadId }) => {
			chatThreadsStreamState = chatThreadsStateService.streamState
			chatThreadsLatestUsageOfThreadId = chatThreadsStateService.latestUsageOfThreadId
			chatThreadsCumulativeUsageThisTurnOfThreadId = chatThreadsStateService.cumulativeUsageThisTurnOfThreadId
			chatThreadsCumulativeUsageThisThreadOfThreadId = chatThreadsStateService.cumulativeUsageThisThreadOfThreadId
			chatThreadsLatestCompactionOfThreadId = chatThreadsStateService.latestCompactionOfThreadId
			chatThreadsCumulativeCompactionThisTurnOfThreadId = chatThreadsStateService.cumulativeCompactionThisTurnOfThreadId
			chatThreadsCumulativeCompactionThisThreadOfThreadId = chatThreadsStateService.cumulativeCompactionThisThreadOfThreadId
			chatThreadsStreamStateListeners.forEach(l => l(threadId))
		})
	)

	settingsState = settingsStateService.state
	disposables.push(
		settingsStateService.onDidChangeState(() => {
			settingsState = settingsStateService.state
			settingsStateListeners.forEach(l => l(settingsState))
		})
	)

	refreshModelState = refreshModelService.state
	disposables.push(
		refreshModelService.onDidChangeState((providerName) => {
			refreshModelState = refreshModelService.state
			refreshModelStateListeners.forEach(l => l(refreshModelState))
			refreshModelProviderListeners.forEach(l => l(providerName, refreshModelState)) // no state
		})
	)

	colorThemeState = themeService.getColorTheme().type
	disposables.push(
		themeService.onDidColorThemeChange(({ type }) => {
			colorThemeState = type
			colorThemeStateListeners.forEach(l => l(colorThemeState))
		})
	)

	// no state
	disposables.push(
		editCodeService.onDidChangeStreamingInCtrlKZone(({ diffareaid }) => {
			const isStreaming = editCodeService.isCtrlKZoneStreaming({ diffareaid })
			ctrlKZoneStreamingStateListeners.forEach(l => l(diffareaid, isStreaming))
		})
	)

	disposables.push(
		voidCommandBarService.onDidChangeState(({ uri }) => {
			commandBarURIStateListeners.forEach(l => l(uri));
		})
	)

	disposables.push(
		voidCommandBarService.onDidChangeActiveURI(({ uri }) => {
			activeURIListeners.forEach(l => l(uri));
		})
	)

	disposables.push(
		mcpService.onDidChangeState(() => {
			mcpListeners.forEach(l => l())
		})
	)


	return disposables
}



const getReactAccessor = (accessor: ServicesAccessor) => {
	const reactAccessor = {
		IModelService: accessor.get(IModelService),
		IClipboardService: accessor.get(IClipboardService),
		IContextViewService: accessor.get(IContextViewService),
		IContextMenuService: accessor.get(IContextMenuService),
		IFileService: accessor.get(IFileService),
		IHoverService: accessor.get(IHoverService),
		IThemeService: accessor.get(IThemeService),
		ILLMMessageService: accessor.get(ILLMMessageService),
		IRefreshModelService: accessor.get(IRefreshModelService),
		IVoidSettingsService: accessor.get(IVoidSettingsService),
		IEditCodeService: accessor.get(IEditCodeService),
		IChatThreadService: accessor.get(IChatThreadService),

		IInstantiationService: accessor.get(IInstantiationService),
		ICodeEditorService: accessor.get(ICodeEditorService),
		ICommandService: accessor.get(ICommandService),
		IContextKeyService: accessor.get(IContextKeyService),
		INotificationService: accessor.get(INotificationService),
		IAccessibilityService: accessor.get(IAccessibilityService),
		ILanguageConfigurationService: accessor.get(ILanguageConfigurationService),
		ILanguageDetectionService: accessor.get(ILanguageDetectionService),
		ILanguageFeaturesService: accessor.get(ILanguageFeaturesService),
		IKeybindingService: accessor.get(IKeybindingService),
		ISearchService: accessor.get(ISearchService),

		IExplorerService: accessor.get(IExplorerService),
		IEnvironmentService: accessor.get(IEnvironmentService),
		IConfigurationService: accessor.get(IConfigurationService),
		IPathService: accessor.get(IPathService),
		IMetricsService: accessor.get(IMetricsService),
		ITerminalToolService: accessor.get(ITerminalToolService),
		ILanguageService: accessor.get(ILanguageService),
		IVoidModelService: accessor.get(IVoidModelService),
		IWorkspaceContextService: accessor.get(IWorkspaceContextService),

		IVoidCommandBarService: accessor.get(IVoidCommandBarService),
		INativeHostService: accessor.get(INativeHostService),
		IToolsService: accessor.get(IToolsService),
		IConvertToLLMMessageService: accessor.get(IConvertToLLMMessageService),
		ITerminalService: accessor.get(ITerminalService),
		IExtensionManagementService: accessor.get(IExtensionManagementService),
		IExtensionTransferService: accessor.get(IExtensionTransferService),
		IMCPService: accessor.get(IMCPService),

		IStorageService: accessor.get(IStorageService),

	} as const
	return reactAccessor
}

type ReactAccessor = ReturnType<typeof getReactAccessor>


let reactAccessor_: ReactAccessor | null = null
const _registerAccessor = (accessor: ServicesAccessor) => {
	const reactAccessor = getReactAccessor(accessor)
	reactAccessor_ = reactAccessor
}

// -- services --
export const useAccessor = () => {
	if (!reactAccessor_) {
		throw new Error(`⚠️ Void useAccessor was called before _registerServices!`)
	}

	return { get: <S extends keyof ReactAccessor,>(service: S): ReactAccessor[S] => reactAccessor_![service] }
}



// -- state of services --

export const useSettingsState = () => {
	const [s, ss] = useState(settingsState)
	useEffect(() => {
		ss(settingsState)
		settingsStateListeners.add(ss)
		return () => { settingsStateListeners.delete(ss) }
	}, [ss])
	return s
}

export const useChatThreadsState = () => {
	const [s, ss] = useState(chatThreadsState)
	useEffect(() => {
		ss(chatThreadsState)
		chatThreadsStateListeners.add(ss)
		return () => { chatThreadsStateListeners.delete(ss) }
	}, [ss])
	return s
	// allow user to set state natively in react
	// const ss: React.Dispatch<React.SetStateAction<ThreadsState>> = (action)=>{
	// 	_ss(action)
	// 	if (typeof action === 'function') {
	// 		const newState = action(chatThreadsState)
	// 		chatThreadsState = newState
	// 	} else {
	// 		chatThreadsState = action
	// 	}
	// }
	// return [s, ss] as const
}




export const useChatThread = (threadId: string) => {
	const [thread, setThread] = useState<ThreadType | undefined>(chatThreadsState.allThreads[threadId])
	useEffect(() => {
		setThread(chatThreadsState.allThreads[threadId])
		const listener = (newState: ThreadsState) => {
			setThread(prev => {
				const next = newState.allThreads[threadId]
				if (prev === next) return prev
				return next
			})
		}
		chatThreadsStateListeners.add(listener)
		return () => { chatThreadsStateListeners.delete(listener) }
	}, [threadId])
	return thread
}

export const useCurrentWorkspaceUri = () => {
	const [uri, setUri] = useState(chatThreadsState.currentWorkspaceUri)
	useEffect(() => {
		setUri(chatThreadsState.currentWorkspaceUri)
		const listener = (newState: ThreadsState) => {
			setUri(prev => {
				if (prev === newState.currentWorkspaceUri) return prev
				return newState.currentWorkspaceUri
			})
		}
		chatThreadsStateListeners.add(listener)
		return () => { chatThreadsStateListeners.delete(listener) }
	}, [])
	return uri
}

export const useChatThreadsStreamState = (threadId: string) => {
	const [s, ss] = useState<ThreadStreamState[string] | undefined>(chatThreadsStreamState[threadId])
	useEffect(() => {
		ss(chatThreadsStreamState[threadId])
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) return
			ss(chatThreadsStreamState[threadId])
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [ss, threadId])
	return s
}

export const useStreamRunningState = (threadId: string): IsRunningType => {
	const [isRunning, setIsRunning] = useState<IsRunningType>(
		chatThreadsStreamState[threadId]?.isRunning
	)
	useEffect(() => {
		setIsRunning(chatThreadsStreamState[threadId]?.isRunning)
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) return
			const next: IsRunningType = chatThreadsStreamState[threadId]?.isRunning
			setIsRunning((prev: IsRunningType) => prev === next ? prev : next)
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [threadId])
	return isRunning
}

export const useChatThreadLatestUsage = (threadId: string) => {
	const [u, su] = useState<LLMUsage | undefined>(chatThreadsLatestUsageOfThreadId[threadId])
	useEffect(() => {
		su(chatThreadsLatestUsageOfThreadId[threadId])
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) return
			su(chatThreadsLatestUsageOfThreadId[threadId])
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [su, threadId])
	return u
}

// Cumulative token usage across all LLM requests fired in the current user turn
// (this-turn) and across the entire thread history (this-thread). In an agent
// loop with N tool calls each request resends the full history, so total billed
// tokens grow ~O(N²) — these counters expose that real cost vs. `latestUsage`'s
// per-request snapshot.
export const useChatThreadCumulativeUsage = (threadId: string) => {
	const initial = {
		thisTurn: chatThreadsCumulativeUsageThisTurnOfThreadId[threadId],
		thisThread: chatThreadsCumulativeUsageThisThreadOfThreadId[threadId],
	}
	const [u, su] = useState<{ thisTurn: LLMUsage | undefined, thisThread: LLMUsage | undefined }>(initial)
	useEffect(() => {
		su({
			thisTurn: chatThreadsCumulativeUsageThisTurnOfThreadId[threadId],
			thisThread: chatThreadsCumulativeUsageThisThreadOfThreadId[threadId],
		})
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) return
			su({
				thisTurn: chatThreadsCumulativeUsageThisTurnOfThreadId[threadId],
				thisThread: chatThreadsCumulativeUsageThisThreadOfThreadId[threadId],
			})
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [su, threadId])
	return u
}

// Perf 2 compaction telemetry. Mirrors `useChatThreadLatestUsage` /
// `useChatThreadCumulativeUsage`:
//   - `latest` = last request's trim summary, undefined if the last request
//     didn't compact (tooltip renders "Compacted: none this request").
//   - `thisTurn` / `thisThread` = running totals so users can see e.g. "this
//     agent turn shrunk 4 tool results, saving ~8k tokens".
// Re-uses the shared stream-state listener set so updates ride the same
// event the token-usage hooks already subscribe to — no extra plumbing.
export const useChatThreadCompaction = (threadId: string) => {
	const initial = {
		latest: chatThreadsLatestCompactionOfThreadId[threadId],
		thisTurn: chatThreadsCumulativeCompactionThisTurnOfThreadId[threadId],
		thisThread: chatThreadsCumulativeCompactionThisThreadOfThreadId[threadId],
	}
	const [c, sc] = useState<{ latest: CompactionInfo | undefined, thisTurn: CompactionInfo | undefined, thisThread: CompactionInfo | undefined }>(initial)
	useEffect(() => {
		sc({
			latest: chatThreadsLatestCompactionOfThreadId[threadId],
			thisTurn: chatThreadsCumulativeCompactionThisTurnOfThreadId[threadId],
			thisThread: chatThreadsCumulativeCompactionThisThreadOfThreadId[threadId],
		})
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) return
			sc({
				latest: chatThreadsLatestCompactionOfThreadId[threadId],
				thisTurn: chatThreadsCumulativeCompactionThisTurnOfThreadId[threadId],
				thisThread: chatThreadsCumulativeCompactionThisThreadOfThreadId[threadId],
			})
		}
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [sc, threadId])
	return c
}

export const useFullChatThreadsStreamState = () => {
	const [s, ss] = useState(chatThreadsStreamState)
	useEffect(() => {
		ss(chatThreadsStreamState)
		const listener = () => { ss(chatThreadsStreamState) }
		chatThreadsStreamStateListeners.add(listener)
		return () => { chatThreadsStreamStateListeners.delete(listener) }
	}, [ss])
	return s
}



export const useRefreshModelState = () => {
	const [s, ss] = useState(refreshModelState)
	useEffect(() => {
		ss(refreshModelState)
		refreshModelStateListeners.add(ss)
		return () => { refreshModelStateListeners.delete(ss) }
	}, [ss])
	return s
}


export const useRefreshModelListener = (listener: (providerName: RefreshableProviderName, s: RefreshModelStateOfProvider) => void) => {
	useEffect(() => {
		refreshModelProviderListeners.add(listener)
		return () => { refreshModelProviderListeners.delete(listener) }
	}, [listener, refreshModelProviderListeners])
}

export const useCtrlKZoneStreamingState = (listener: (diffareaid: number, s: boolean) => void) => {
	useEffect(() => {
		ctrlKZoneStreamingStateListeners.add(listener)
		return () => { ctrlKZoneStreamingStateListeners.delete(listener) }
	}, [listener, ctrlKZoneStreamingStateListeners])
}

export const useIsDark = () => {
	const [s, ss] = useState(colorThemeState)
	useEffect(() => {
		ss(colorThemeState)
		colorThemeStateListeners.add(ss)
		return () => { colorThemeStateListeners.delete(ss) }
	}, [ss])

	// s is the theme, return isDark instead of s
	const isDark = s === ColorScheme.DARK || s === ColorScheme.HIGH_CONTRAST_DARK
	return isDark
}

export const useCommandBarURIListener = (listener: (uri: URI) => void) => {
	useEffect(() => {
		commandBarURIStateListeners.add(listener);
		return () => { commandBarURIStateListeners.delete(listener) };
	}, [listener]);
};
export const useCommandBarState = () => {
	const accessor = useAccessor()
	const commandBarService = accessor.get('IVoidCommandBarService')
	const [s, ss] = useState({ stateOfURI: commandBarService.stateOfURI, sortedURIs: commandBarService.sortedURIs });
	const listener = useCallback(() => {
		ss({ stateOfURI: commandBarService.stateOfURI, sortedURIs: commandBarService.sortedURIs });
	}, [commandBarService])
	useCommandBarURIListener(listener)

	return s;
}



// roughly gets the active URI - this is used to get the history of recent URIs
export const useActiveURI = () => {
	const accessor = useAccessor()
	const commandBarService = accessor.get('IVoidCommandBarService')
	const [s, ss] = useState(commandBarService.activeURI)
	useEffect(() => {
		const listener = () => { ss(commandBarService.activeURI) }
		activeURIListeners.add(listener);
		return () => { activeURIListeners.delete(listener) };
	}, [])
	return { uri: s }
}




export const useMCPServiceState = () => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')
	const [s, ss] = useState(mcpService.state)
	useEffect(() => {
		const listener = () => { ss(mcpService.state) }
		mcpListeners.add(listener);
		return () => { mcpListeners.delete(listener) };
	}, []);
	return s
}



export const useIsOptedOut = () => {
	const accessor = useAccessor()
	const storageService = accessor.get('IStorageService')

	const getVal = useCallback(() => {
		return storageService.getBoolean(OPT_OUT_KEY, StorageScope.APPLICATION, false)
	}, [storageService])

	const [s, ss] = useState(getVal())

	useEffect(() => {
		const disposables = new DisposableStore();
		const d = storageService.onDidChangeValue(StorageScope.APPLICATION, OPT_OUT_KEY, disposables)(e => {
			ss(getVal())
		})
		disposables.add(d)
		return () => disposables.clear()
	}, [storageService, getVal])

	return s
}
