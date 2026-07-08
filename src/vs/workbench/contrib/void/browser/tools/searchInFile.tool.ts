import { EndOfLinePreference } from '../../../../../editor/common/model.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateBoolean } from './toolHelpers.js'

export const searchInFileToolCore: ToolDefinitionCore<'search_in_file'> = {
	name: 'search_in_file',
	description: `Use this to find where a pattern appears inside a specific file. Returns the start line numbers of matches. For cross-file content search, use \`search_for_files\`. For locating where a NAMED function / class / variable / type is defined or used, use \`go_to_definition\` / \`go_to_usages\` instead — LSP is precise where text search is noisy. For conceptual or intent-based queries where there's no exact string to match, use \`semantic_search\` instead. Never use \`run_command\` with \`grep\` — this tool is the correct choice.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		query: { description: 'The string or regex to search for in the file.' },
		is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const query = validateStr('query', queryUnknown)
		const isRegex = validateBoolean(isRegexUnknown, { default: false })
		return { uri, query, isRegex }
	},

	callTool: async ({ uri, query, isRegex }, ctx) => {
		await ctx.voidModelService.initializeModel(uri)
		const { model } = await ctx.voidModelService.getModelSafe(uri)
		if (model === null) { throw new Error(`No contents; File does not exist.`) }
		const contents = model.getValue(EndOfLinePreference.LF)
		const contentOfLine = contents.split('\n')
		const totalLines = contentOfLine.length
		const regex = isRegex ? new RegExp(query) : null
		const lines: number[] = []
		const lineContentOfLineNumber: Record<number, string> = {}
		for (let i = 0; i < totalLines; i++) {
			const line = contentOfLine[i]
			if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
				const matchLine = i + 1
				lines.push(matchLine)
				lineContentOfLineNumber[matchLine] = line
			}
		}
		return { result: { lines, lineContentOfLineNumber } }
	},

	stringOfResult: (_params, result) => {
		const lineContentOfLineNumber = result?.lineContentOfLineNumber
		return result.lines.map(n => {
			const lineContent = lineContentOfLineNumber?.[n] ?? ''
			return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
		}).join('\n\n')
	},

	title: { done: 'Searched in file', proposed: 'Search in file', running: 'Searching in file' },
}
