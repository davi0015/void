import { CancellationToken } from '../../../../../base/common/cancellation.js'
import { MAX_CHILDREN_URIs_PAGE } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validatePageNum, validateOptionalStr, nextPageStr } from './toolHelpers.js'

export const searchPathnamesOnlyToolCore: ToolDefinitionCore<'search_pathnames_only'> = {
	name: 'search_pathnames_only',
	description: `Use this to find files by name or path pattern across the workspace. Searches pathnames ONLY — not file contents. For content search, use \`search_for_files\` or \`search_in_file\`. Never use \`run_command\` with \`find\` — this tool is the correct choice.`,
	params: {
		query: { description: `Your query for the search.` },
		include_pattern: { description: `Optional. Glob pattern to restrict the search (e.g. \`*.ts\` to only match TypeScript files, \`src/**\` to limit to descendants of \`src/\`). Only fill this in if you need to narrow results.` },
		page_number: { description: 'Optional. The page number of the result. Default is 1.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { query: queryUnknown, search_in_folder: includeUnknown, page_number: pageNumberUnknown } = raw
		const queryStr = validateStr('query', queryUnknown)
		const pageNumber = validatePageNum(pageNumberUnknown)
		const includePattern = validateOptionalStr('include_pattern', includeUnknown)
		return { query: queryStr, includePattern, pageNumber }
	},

	callTool: async ({ query: queryStr, includePattern, pageNumber }, ctx) => {
		const query = ctx.queryBuilder.file(ctx.workspaceContextService.getWorkspace().folders.map(f => f.uri), {
			filePattern: queryStr,
			includePattern: includePattern ?? undefined,
			sortByScore: true,
		})
		const data = await ctx.searchService.fileSearch(query, CancellationToken.None)

		const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
		const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
		const uris = data.results
			.slice(fromIdx, toIdx + 1)
			.map(({ resource }) => resource)

		const hasNextPage = (data.results.length - 1) - toIdx >= 1
		return { result: { uris, hasNextPage } }
	},

	stringOfResult: (_params, result) => {
		return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
	},

	title: { done: 'Searched by file name', proposed: 'Search by file name', running: 'Searching by file name' },
}
