import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateNumber, isFalsy } from './toolHelpers.js'

export const semanticSearchToolCore: ToolDefinitionCore<'semantic_search'> = {
	name: 'semantic_search',
	description: `Use this to find code by meaning or intent, not exact string match. Best for conceptual queries like 'error handling', 'authentication middleware', 'retry logic', or 'how does the agent loop work'. For exact symbol names use \`go_to_definition\`/\`go_to_usages\`; for exact strings use \`search_in_file\`/\`search_for_files\`. Never use \`run_command\` with \`grep\` for conceptual searches — this tool is the correct choice.`,
	params: {
		query: { description: `A natural-language description of what you're looking for (e.g. "error handling logic", "authentication middleware", "retry with backoff").` },
		n_results: { description: 'Optional. Number of results to return. Default is 10.' },
		include_pattern: { description: 'Optional. Glob pattern to restrict results (e.g. `src/**` to only search under src/, `*.ts` for TypeScript files).' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { query: queryUnknown, n_results: nResultsUnknown, include_pattern: includePatternUnknown } = raw
		const query = validateStr('query', queryUnknown)
		const nResults = validateNumber(nResultsUnknown, { default: 10 }) ?? 10
		const includePattern = isFalsy(includePatternUnknown) ? null : validateStr('include_pattern', includePatternUnknown)
		return { query, nResults, includePattern }
	},

	callTool: async ({ query, nResults, includePattern }, ctx) => {
		const { ISemanticIndexService } = await import('../semanticIndexService.js')
		const semanticIndexService = ctx.instantiationService.invokeFunction(accessor => accessor.get(ISemanticIndexService))
		const { results, noResultReason } = await semanticIndexService.search(query, nResults, includePattern ?? undefined)
		return { result: { results, noResultReason } }
	},

	stringOfResult: (_params, result) => {
		const statusNote = result.results.length > 0 && result.results[0].indexStatus === 'indexing'
			? `\nNote: Index is still being built (${result.results[0].indexProgress.indexed}/${result.results[0].indexProgress.total} files indexed). Results may be incomplete.`
			: ''
		const reasonMap: Record<string, string> = {
			'disabled': ' Semantic search is disabled in settings.',
			'noModel': ' No embedding model configured. Add a model with supportsEmbedding: true in Void settings.',
			'notReady': ' Index is not built yet. Wait for indexing to complete.',
		}
		const reasonNote = result.results.length === 0 && result.noResultReason ? reasonMap[result.noResultReason] ?? '' : ''
		if (result.results.length === 0) return `No semantic search results found.${reasonNote}${statusNote}`
		const lines = result.results.map((r, i) => {
			const scoreStr = r.score.toFixed(2)
			return `${i + 1}. ${r.uri.fsPath}:${r.startLine}-${r.endLine} (score: ${scoreStr})\n\`\`\`\n${r.snippet}\n\`\`\``
		})
		return `Found ${result.results.length} result(s):\n\n${lines.join('\n\n')}${statusNote}`
	},

	title: { done: 'Searched semantically', proposed: 'Search semantically', running: 'Searching semantically' },
}
