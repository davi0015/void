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
callTool: (params: BuiltinToolCallParams[T], ctx: ToolCtx) => Promise<{
result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>
interruptTool?: () => void
}>
	stringOfResult: (params: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>, ctx: ToolCtx) => string

	// --- UI (plain strings, no JSX) ---
	// loadingTitleWrapper is applied at render time by getTitle().
	title: { done: string, proposed: string, running: string }
}
