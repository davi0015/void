/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Shared plumbing for the two scratchpad tools. Kept out of `common/scratchPad.ts`
// so that module stays pure (paths and name validation) and this one can touch
// the file system.

import { VSBuffer } from '../../../../../base/common/buffer.js'
import { URI } from '../../../../../base/common/uri.js'
import { IFileStat } from '../../../../../platform/files/common/files.js'
import { scratchRootUri } from '../../common/scratchPad.js'
import { ToolCtx } from './toolTypes.js'

/** The workspace folder scratch lives under, or a message the model can act on. */
export const workspaceFolderUri = (ctx: ToolCtx): URI => {
	const folder = ctx.workspaceContextService.getWorkspace().folders[0]?.uri
	if (!folder) {
		throw new Error('No workspace folder is open, so there is no scratchpad. Ask the user to open one, or use rewrite_file for a file in the project.')
	}
	return folder
}

export const threadScratchRoot = (ctx: ToolCtx, threadId: string): URI => scratchRootUri(workspaceFolderUri(ctx), threadId)

/**
 * Creates the scratch directory and the `.gitignore` that keeps it out of the
 * user's repository.
 *
 * The ignore file lives *inside* `.void/` and contains `*`, so git ignores the
 * folder and everything in it — including the ignore file itself — without the
 * scratchpad editing the user's own `.gitignore`. Writing to the project's
 * `.gitignore` would be a project change, which is what scratch is avoiding.
 */
export const ensureScratchRoot = async (ctx: ToolCtx, workspaceFolder: URI, root: URI): Promise<void> => {
	const ignoreFolder = URI.joinPath(workspaceFolder, '.void')
	const ignoreUri = URI.joinPath(ignoreFolder, '.gitignore')
	if (!(await ctx.fileService.exists(ignoreUri))) {
		await ctx.fileService.createFolder(ignoreFolder)
		await ctx.fileService.writeFile(ignoreUri, VSBuffer.fromString('*\n'))
	}
	if (!(await ctx.fileService.exists(root))) {
		await ctx.fileService.createFolder(root)
	}
}

/** Bytes currently used by one thread's scratchpad, or 0 if it cannot be measured. */
export const usedScratchBytes = async (ctx: ToolCtx, root: URI): Promise<number> => {
	const sizeOf = async (stat: IFileStat): Promise<number> => {
		if (stat.isFile) return stat.size ?? 0
		let total = 0
		for (const child of stat.children ?? []) total += await sizeOf(child)
		return total
	}
	try {
		return await sizeOf(await ctx.fileService.resolve(root, { resolveMetadata: true }))
	} catch {
		// A missing directory is an empty scratchpad; anything else is measured on
		// the next write rather than blocking this one.
		return 0
	}
}
