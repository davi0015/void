/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from '../../common/toolsServiceTypes.js'
import { ToolDefinitionCore } from './toolTypes.js'
import { readFileToolCore } from './readFile.tool.js'

// This registry stores the backend (non-React) segments of each tool definition.
// The UI segments (title, desc, resultWrapper) are accessed by
// ToolResultComponents.tsx via the per-tool .tsx files directly.
//
// Tools are converted in batches; this file starts empty and fills up.
// The conversion plan is in docs/designs/tool-restructuring.md.


export const toolDefinitionOfToolName: Partial<{ [T in BuiltinToolName]: ToolDefinitionCore<T> }> = {
	read_file: readFileToolCore,
}


// Whether a tool has been migrated to the new per-file definition.
export const isConvertedTool = (toolName: BuiltinToolName): boolean => {
	return toolName in toolDefinitionOfToolName
}
