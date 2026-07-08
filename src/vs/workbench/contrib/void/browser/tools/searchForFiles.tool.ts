import { CancellationToken } from '../../../../../base/common/cancellation.js'
import { MAX_CHILDREN_URIs_PAGE } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validatePageNum, validateBoolean, nextPageStr } from './toolHelpers.js'

export const searchForFilesToolCore: ToolDefinitionCore<'search_for_files'> = {
	name: 'search_for_files',
	description: `Use this to find which files contain a given string or regex pattern across the workspace. Returns a list of matching file names (not line numbers). For line-number positions within a specific file, use \`search_in_file\`. For locating where a NAMED function / class / variable / type is defined or used, use \`go_to_definition\` / \`go_to_usages\` instead — LSP is precise where text search is noisy. For conceptual or intent-based queries where there's no exact string to match, use \`semantic_search\` instead. Never use \`run_command\` with \`grep\` — this tool is the correct choice.`,
	params: {
		query: { description: `Your query for the search.` },
		search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
		is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
		page_number: { description: 'Optional. The page number of the result. Default is 1.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { query: queryUnknown, search_in_folder: searchInFolderUnknown, is_regex: isRegexUnknown, page_number: pageNumberUnknown } = raw
		const queryStr = validateStr('query', queryUnknown)
		const pageNumber = validatePageNum(pageNumberUnknown)
		const searchInFolder = ctx.validateOptionalURI(searchInFolderUnknown)
		const isRegex = validateBoolean(isRegexUnknown, { default: false })
		return { query: queryStr, isRegex, searchInFolder, pageNumber }
	},

	callTool: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }, ctx) => {
		const searchFolders = searchInFolder === null ?
			ctx.workspaceContextService.getWorkspace().folders.map(f => f.uri)
			: [searchInFolder]

		const query = ctx.queryBuilder.text({
			pattern: queryStr,
			isRegExp: isRegex,
		}, searchFolders)

		const data = await ctx.searchService.textSearch(query, CancellationToken.None)

		const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
		const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
		const uris = data.results
			.slice(fromIdx, toIdx + 1)
			.map(({ resource }) => resource)

		const hasNextPage = (data.results.length - 1) - toIdx >= 1
		return { result: { queryStr, uris, hasNextPage } }
	},

	stringOfResult: (_params, result) => {
		return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
	},

	title: { done: 'Searched', proposed: 'Search', running: 'Searching' },
}
