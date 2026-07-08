/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { EndOfLinePreference } from '../../../../../editor/common/model.js'

import { AUTO_OUTLINE_THRESHOLD, MAX_FILE_CHARS_PAGE } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'

import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validatePageNum, validateNumber, safeFence, nextPageStr, getFileOutline } from './toolHelpers.js'


export const readFileToolCore: ToolDefinitionCore<'read_file'> = {
	name: 'read_file',
	description: `Use this to read a file's contents when you need to inspect, quote, or reason about code. For small files, returns the full contents. For large files called without \`start_line\`/\`end_line\`, returns a **symbol outline** with line ranges instead of the body — use those line numbers to call \`read_file\` again with \`start_line\`/\`end_line\` to read specific sections. Never use \`run_command\` with \`cat\` to read files — this tool is the correct choice.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		start_line: { description: 'Optional. Line number to start reading from (1-indexed). When omitted on large files, an outline is returned instead — use the line numbers from the outline to make a targeted read.' },
		end_line: { description: 'Optional. Line number to stop reading at (inclusive). Use together with \`start_line\` to read a specific section of a large file.' },
		page_number: { description: 'Optional. The page number of the result. Default is 1.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const pageNumber = validatePageNum(pageNumberUnknown)

		let startLine = validateNumber(startLineUnknown, { default: null })
		let endLine = validateNumber(endLineUnknown, { default: null })

		if (startLine !== null && startLine < 1) startLine = null
		if (endLine !== null && endLine < 1) endLine = null

		return { uri, startLine, endLine, pageNumber }
	},

	callTool: async ({ uri, startLine, endLine, pageNumber }, ctx) => {
		await ctx.voidModelService.initializeModel(uri)
		const { model } = await ctx.voidModelService.getModelSafe(uri)
		if (model === null) { throw new Error(`No contents; File does not exist.`) }

		const totalNumLines = model.getLineCount()

		if (startLine === null && endLine === null && pageNumber === 1 && ctx.voidSettingsService.state.globalSettings.autoOutlineReadFile) {
			const fullContent = model.getValue(EndOfLinePreference.LF)
			if (fullContent.length > AUTO_OUTLINE_THRESHOLD) {
				const outlineText = await getFileOutline(model, ctx.languageFeaturesService, uri)
				if (outlineText !== null) {
					return { result: { outlined: true as const, outlineText, totalFileLen: fullContent.length, totalNumLines } }
				}
				// No outline available — return first ~1KB as fallback
				const truncated = fullContent.slice(0, 1024)
				const fallbackText = `(No symbol outline available for this file type. Showing first ~1KB.)\n\n${truncated}`
				return { result: { outlined: true as const, outlineText: fallbackText, totalFileLen: fullContent.length, totalNumLines } }
			}
		}

		let contents: string
		if (startLine === null && endLine === null) {
			contents = model.getValue(EndOfLinePreference.LF)
		}
		else {
			const startLineNumber = startLine === null ? 1 : startLine
			const endLineNumber = endLine === null ? model.getLineCount() : endLine
			contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
		}

		const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
		const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
		const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
		const hasNextPage = (contents.length - 1) - toIdx >= 1
		const totalFileLen = contents.length
		return { result: { outlined: false as const, fileContents, totalFileLen, hasNextPage, totalNumLines } }
	},

	stringOfResult: (params, result, ctx) => {
		return ctx.voidModelService.withModel(params.uri, () => {
			if (result.outlined) {
				return `SUCCESS: File outline retrieved for ${params.uri.fsPath} (${result.totalNumLines} lines, ${result.totalFileLen} characters).\nThis file is too large to read all at once. The outline below shows the file's structure with line numbers.\n\nIMPORTANT: Do NOT retry this call without line numbers — you will get the same outline.\nUse start_line and end_line to read specific sections.\n\n${result.outlineText}\n\nNEXT STEPS: To read a specific section, call read_file with the same path plus start_line and end_line from the outline above.`
			}
			const fence = safeFence(result.fileContents)
			return `${params.uri.fsPath}\n${fence}\n${result.fileContents}\n${fence}${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
		})
	},

	title: { done: 'Read file', proposed: 'Read file', running: 'Reading file' },
}
