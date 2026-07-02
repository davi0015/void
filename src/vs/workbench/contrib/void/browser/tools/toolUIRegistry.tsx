/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from '../../common/toolsServiceTypes.js'
import { ToolDefinition } from './toolUITypes.js'
import { readFileTool } from './readFile.toolUI.js'


// Full tool definitions (including React UI segments). Imported by
// ToolResultComponents.tsx (.tsx) to delegate title/desc/resultWrapper.
// Mirrors toolRegistry.ts which stores only the backend (core) segments.
export const toolUIOfToolName: Partial<{ [T in BuiltinToolName]: ToolDefinition<T> }> = {
	read_file: readFileTool,
}
