/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from '../../common/toolsServiceTypes.js'
import { InternalToolInfo, SnakeCaseKeys, builtinTools, availableTools as _availableTools } from '../../common/prompt/prompts.js'
import { ChatMode } from '../../common/voidSettingsTypes.js'
import { ToolDefinition } from './toolTypes.js'

// This registry will be populated incrementally as tools are converted from the
// old multi-map layout to per-tool definition files. Until a tool is converted,
// its description/validate/call/stringify/UI live in the old locations:
//   - common/prompt/prompts.ts (builtinTools)
//   - browser/toolsService.ts (this.validateParams, this.callTool, this.stringOfResult)
//   - browser/react/.../ToolResultComponents.tsx (titleOfBuiltinToolName, toolNameToDesc, builtinToolNameToComponent)
//
// The conversion plan is in docs/designs/tool-restructuring.md.
// Tools are converted in 4 batches; this file starts empty and fills up as
// each batch lands.


export const toolDefinitionOfToolName: Partial<{ [T in BuiltinToolName]: ToolDefinition<T> }> = {
	// Populated incrementally — see batch commits
}


// Whether a tool has been migrated to the new per-file definition.
export const isConvertedTool = (toolName: BuiltinToolName): boolean => {
	return toolName in toolDefinitionOfToolName
}
