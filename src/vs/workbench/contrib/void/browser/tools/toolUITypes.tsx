/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react'

import { BuiltinToolCallParams, BuiltinToolName } from '../../common/toolsServiceTypes.js'
import { ToolMessage } from '../../common/chatThreadServiceTypes.js'
import { ToolDefinitionCore } from './toolTypes.js'


export type ToolDesc = {
	desc1: React.ReactNode
	desc1Info?: string
}


// Full tool definition including React UI segments. Lives in .tsx because the
// UI types reference React.ReactNode. The backend-only ToolDefinitionCore lives
// in toolTypes.ts and is what toolsService.ts / toolRegistry.ts use.
export type ToolDefinition<T extends BuiltinToolName> = ToolDefinitionCore<T> & {
	// --- UI ---
	title: { done: React.ReactNode, proposed: React.ReactNode, running: React.ReactNode }
	desc: (params: BuiltinToolCallParams[T], accessor: ReturnType<typeof import('../react/src/util/services.js').useAccessor>) => ToolDesc
	resultWrapper: (props: { toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>, messageIdx: number, threadId: string }) => React.ReactNode
}
