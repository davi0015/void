/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react'

import { URI } from '../../../../../base/common/uri.js'
import { IFileService } from '../../../../../platform/files/common/files.js'
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js'
import { ISearchService } from '../../../../services/search/common/search.js'
import { IPathService } from '../../../../services/path/common/pathService.js'
import { IMarkerService } from '../../../../../platform/markers/common/markers.js'
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js'
import { ICommandService } from '../../../../../platform/commands/common/commands.js'
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
	ToolName,
} from '../../common/toolsServiceTypes.js'
import { SnakeCaseKeys } from '../../common/prompt/prompts.js'
import { ToolMessage } from '../../common/chatThreadServiceTypes.js'


// All DI services any tool might need. Passed by the registry (built from
// ToolsService constructor params); individual tools pick what they need and
// ignore the rest.
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
	commandService: ICommandService

	// Validation helpers — resolve relative paths against the workspace root
	// at call time. These mirror the closures that toolsService.ts currently
	// builds in its constructor.
	validateURI: (uriStr: unknown) => URI
	validateOptionalURI: (uriStr: unknown) => URI | null
}


export type ToolDesc = {
	desc1: React.ReactNode
	desc1Info?: string
}


// One definition per tool — LLM description, approval, backend execution,
// and UI rendering, all co-located.
export type ToolDefinition<T extends BuiltinToolName> = {
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
	stringOfResult: (params: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string

	// --- UI ---
	title: { done: React.ReactNode, proposed: React.ReactNode, running: React.ReactNode }
	desc: (params: BuiltinToolCallParams[T], accessor: ReturnType<typeof import('../react/src/util/services.js').useAccessor>) => ToolDesc
	resultWrapper: (props: { toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>, messageIdx: number, threadId: string }) => React.ReactNode
}
