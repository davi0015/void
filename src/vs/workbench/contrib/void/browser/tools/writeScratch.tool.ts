/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { MAX_SCRATCH_FILE_BYTES, MAX_SCRATCH_THREAD_BYTES, normalizeScratchPath, scratchEntryUri } from '../../common/scratchPad.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr } from './toolHelpers.js'
import { ensureScratchRoot, threadScratchRoot, usedScratchBytes, workspaceFolderUri } from './scratchToolHelpers.js'

export const writeScratchToolCore: ToolDefinitionCore<'write_scratch'> = {
	name: 'write_scratch',
	description: `Writes a throwaway file to this chat's scratchpad: a probe script, a one-off test, generated output. Scratch files are gitignored, are not project changes, and never need to be accepted or rejected; they last for this chat and you can remove them with \`delete_scratch\`. The result gives the absolute path. To run the file, use that path or the path relative to the workspace root (for example \`node .void/tmp/.../probe.js\`, since a new terminal starts in the workspace root). Use \`rewrite_file\` instead for files that are part of the project.`,
	params: {
		path: { description: `File name inside the scratchpad. Subdirectories are allowed (e.g. \`logs/run.txt\`). Absolute paths, drive letters, and \`..\` are rejected.` },
		content: { description: 'The contents of the file.' },
	},
	approvalType: 'edits',

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { path: pathUnknown, content: contentUnknown } = raw
		// The name is validated here rather than in `callTool` so a bad name fails
		// before approval is requested for a write that cannot happen.
		const path = normalizeScratchPath(pathUnknown)
		const content = validateStr('content', contentUnknown)
		return { path, content }
	},

	callTool: async ({ path, content }, ctx, threadId) => {
		const workspaceFolder = workspaceFolderUri(ctx)
		const root = threadScratchRoot(ctx, threadId)
		// Normalised again here, not only in `validateParams`: an approved call is
		// dispatched with the params it was approved with, so the tool must be safe
		// on its own rather than trusting that a schema ran earlier.
		const uri = scratchEntryUri(root, normalizeScratchPath(path))
		const bytes = VSBuffer.fromString(content)

		if (bytes.byteLength > MAX_SCRATCH_FILE_BYTES) {
			throw new Error(`Scratch file is ${bytes.byteLength} bytes, over the ${MAX_SCRATCH_FILE_BYTES}-byte limit for one scratch file. Write the part you need, or use the terminal to generate it.`)
		}
		await ensureScratchRoot(ctx, workspaceFolder, root)
		const used = await usedScratchBytes(ctx, root)
		if (used + bytes.byteLength > MAX_SCRATCH_THREAD_BYTES) {
			throw new Error(`This chat's scratchpad is full (${Math.round(used / (1024 * 1024))} MB used, ${Math.round(MAX_SCRATCH_THREAD_BYTES / (1024 * 1024))} MB limit). Delete files you no longer need with \`delete_scratch\`, then write again.`)
		}

		// Written directly, deliberately: going through the edit service would create
		// a diff zone, and a scratch file is exactly the change the user should not
		// have to review.
		await ctx.fileService.writeFile(uri, bytes)

		return { result: { fsPath: uri.fsPath, bytes: bytes.byteLength } }
	},

	stringOfResult: (_params, result) => `Wrote scratch file ${result.fsPath} (${result.bytes} bytes). It is gitignored and belongs to this chat only; remove it with \`delete_scratch\` when it is no longer needed.`,

	title: { done: 'Wrote scratch file', proposed: 'Write scratch file', running: 'Writing scratch file' },
}
