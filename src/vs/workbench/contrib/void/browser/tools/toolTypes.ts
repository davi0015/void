/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js'
import { IFileService } from '../../../../../platform/files/common/files.js'
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js'
import { ISearchService } from '../../../../services/search/common/search.js'
import { IPathService } from '../../../../services/path/common/pathService.js'
import { IMarkerService } from '../../../../../platform/markers/common/markers.js'
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js'
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js'

import { IEditCodeService } from '../editCodeServiceInterface.js'
import { ITerminalToolService } from '../terminalToolService.js'
import { IVoidModelService } from '../../common/voidModelService.js'
import { IVoidCommandBarService } from '../voidCommandBarService.js'
import { IDirectoryStrService } from '../../common/directoryStrService.js'
import { IVoidSettingsService } from '../../common/voidSettingsService.js'
import { IFetchUrlService } from '../../common/fetchUrlService.js'

import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import {
BuiltinToolCallParams,
BuiltinToolResultType,
BuiltinToolName,
ToolApprovalType,
} from '../../common/toolsServiceTypes.js'
import { SnakeCaseKeys } from '../../common/prompt/prompts.js'


// All DI services any tool might need. Passed by the registry (built from
// ToolsService constructor params); individual tools pick what they need.
//
// The thread a call executes *for* is deliberately not in here. It is the only
// thing about a call that changes per call — everything below outlives it — and
// only `callTool` acts on the world, so only `callTool` is told about it. A tool
// that needs "this conversation" takes that argument rather than asking the chat
// service for the current thread: the current thread is the one on screen, which
// is a different thread as soon as two are running at once.
export type ToolCtx = {
fileService: IFileService
workspaceContextService: IWorkspaceContextService
searchService: ISearchService
queryBuilder: QueryBuilder
voidModelService: IVoidModelService
editCodeService: IEditCodeService
terminalToolService: ITerminalToolService
commandBarService: IVoidCommandBarService
directoryStrService: IDirectoryStrService
markerService: IMarkerService
voidSettingsService: IVoidSettingsService
languageFeaturesService: ILanguageFeaturesService
fetchUrlService: IFetchUrlService
pathService: IPathService
instantiationService: IInstantiationService

// Validation helpers — resolve relative paths against the workspace root
validateURI: (uriStr: unknown) => URI
validateOptionalURI: (uriStr: unknown) => URI | null
}


// The backend (non-React) segments of a tool definition. This type has no JSX
// dependency, so it can be imported from .ts files (toolsService.ts, toolRegistry.ts).
export type ToolDefinitionCore<T extends BuiltinToolName> = {
// --- LLM-facing ---
name: T
description: string
params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }>

// --- Approval ---
approvalType: ToolApprovalType | undefined

// --- Backend ---
validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => BuiltinToolCallParams[T]

// `threadId` is the thread this call is executing for. Required, so a tool that
// needs the conversation it belongs to has it in hand and cannot be tempted to
// ask for the current thread instead — and so the registry cannot forget to pass
// one. Only this function takes it: `validateParams` and `stringOfResult` parse
// and format rather than act, and neither has ever needed to know the thread.
callTool: (params: BuiltinToolCallParams[T], ctx: ToolCtx, threadId: string) => Promise<{
result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>
interruptTool?: () => void
}>
	stringOfResult: (params: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>, ctx: ToolCtx) => string

	// --- UI (plain strings, no JSX) ---
	// loadingTitleWrapper is applied at render time by getTitle().
	title: { done: string, proposed: string, running: string }
}
