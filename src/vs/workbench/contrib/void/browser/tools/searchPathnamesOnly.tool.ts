import { MAX_CHILDREN_URIs_PAGE } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { searchWorkspacePathnames } from './searchPathnames.js'
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
		// The unpaginated search lives in `searchWorkspacePathnames`; paging is this
		// tool's own contract, because it is answering an LLM. `pageNumber` is 1-based
		// and is validated by `validateParams` before it reaches here — a caller that
		// dispatches to `callTool` directly would skip that, which is how the codespan
		// resolver ended up asking for page 0 and getting nothing for every query.
		const all = await searchWorkspacePathnames(ctx, { query: queryStr, includePattern })

		const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
		const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
		const uris = all.slice(fromIdx, toIdx + 1)

		const hasNextPage = (all.length - 1) - toIdx >= 1
		return { result: { uris, hasNextPage } }
	},

	stringOfResult: (_params, result) => {
		return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
	},

	title: { done: 'Searched by file name', proposed: 'Search by file name', running: 'Searching by file name' },
}
