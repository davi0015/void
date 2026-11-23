/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { normalizeScratchPath, scratchEntryUri } from '../../common/scratchPad.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { threadScratchRoot } from './scratchToolHelpers.js'

export const deleteScratchToolCore: ToolDefinitionCore<'delete_scratch'> = {
	name: 'delete_scratch',
	description: `Deletes one file from this chat's scratchpad. Only scratch files can be removed this way — the path is resolved inside the scratchpad and cannot reach a project file. Use \`delete_file_or_folder\` for project files.`,
	params: {
		path: { description: `File name inside the scratchpad, as passed to \`write_scratch\` (e.g. \`logs/run.txt\`).` },
	},
	approvalType: 'delete',

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { path: pathUnknown } = raw
		const path = normalizeScratchPath(pathUnknown)
		return { path }
	},

	callTool: async ({ path }, ctx, threadId) => {
		const root = threadScratchRoot(ctx, threadId)
		// See writeScratch: the tool re-validates so it is safe even when it is
		// dispatched with already-approved params.
		const uri = scratchEntryUri(root, normalizeScratchPath(path))
		if (!(await ctx.fileService.exists(uri))) {
			throw new Error(`No scratch file at \`${path}\`. List the scratchpad with \`ls_dir\` if you are not sure what it contains.`)
		}
		const stat = await ctx.fileService.resolve(uri)
		if (stat.isDirectory) {
			throw new Error(`\`${path}\` is a directory. delete_scratch removes one file; delete the files inside it instead.`)
		}
		await ctx.fileService.del(uri)
		return { result: { fsPath: uri.fsPath } }
	},

	stringOfResult: (_params, result) => `Deleted scratch file ${result.fsPath}.`,

	title: { done: 'Deleted scratch file', proposed: 'Delete scratch file', running: 'Deleting scratch file' },
}
