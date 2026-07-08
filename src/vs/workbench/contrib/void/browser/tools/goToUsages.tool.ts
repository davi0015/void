import { CancellationToken } from '../../../../../base/common/cancellation.js'
import { Position } from '../../../../../editor/common/core/position.js'
import { getReferencesAtPosition } from '../../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js'
import { MAX_CHILDREN_URIs_PAGE } from '../../common/prompt/prompts.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateNumber, validatePageNum, resolveSymbolPosition } from './toolHelpers.js'

export const goToUsagesToolCore: ToolDefinitionCore<'go_to_usages'> = {
	name: 'go_to_usages',
	description: `Use this to find everywhere a symbol is referenced across the workspace, using the language's LSP (same mechanism as VS Code's "Find All References" / Shift+F12). Returns precise call sites and reference locations including the declaration itself — NOT text matches. This is the correct tool whenever you need to find who calls/uses a named identifier: before refactoring, before deleting, or to understand impact. Prefer this over \`search_for_files\` whenever you know the symbol name: LSP handles aliased imports, re-exports, and dynamic references that text search cannot disambiguate. If no LSP provider is registered for the file's language, this tool returns an error telling you to fall back to \`search_for_files\`.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		symbol_name: { description: `The name of the symbol whose usages you want to find (e.g. \`validateToken\`, \`MyClass\`). Case-sensitive. Must appear somewhere in the file; the tool matches whole words only (e.g., \`foo\` will not match inside \`fooBar\`).` },
		line: { description: `Optional — strongly recommended when you know it. The 1-indexed line number in the file where \`symbol_name\` appears. If you have just read the file or run \`search_in_file\`, pass the line you saw — this is the most reliable mode and is REQUIRED to disambiguate when the same name has multiple meanings in the same file (shadowing, re-assignment, overloaded declarations). If omitted, the tool scans the file for the first whole-word occurrence of \`symbol_name\` — safe for distinctive names, risky for common names.` },
		page_number: { description: 'Optional. The page number of the result. Default is 1.' },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, symbol_name: symbolNameUnknown, line: lineUnknown, page_number: pageNumberUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const symbolName = validateStr('symbol_name', symbolNameUnknown)
		const line = validateNumber(lineUnknown, { default: null })
		if (line !== null && line < 1) throw new Error(`\`line\` must be 1 or greater, got ${line}.`)
		const pageNumber = validatePageNum(pageNumberUnknown)
		return { uri, symbolName, line, pageNumber }
	},

	callTool: async ({ uri, symbolName, line, pageNumber }, ctx) => {
		await ctx.voidModelService.initializeModel(uri)
		const { model } = await ctx.voidModelService.getModelSafe(uri)
		if (model === null) throw new Error(`File does not exist: ${uri.fsPath}.`)

		const position = resolveSymbolPosition(model, symbolName, line)
		if (position === null) throw new Error(`Symbol \`${symbolName}\` not found anywhere in ${uri.fsPath}. Check the spelling of the symbol or the file path.`)

		const providers = ctx.languageFeaturesService.referenceProvider.ordered(model)
		if (providers.length === 0) throw new Error(`No LSP reference provider is registered for ${model.getLanguageId()} files. Use \`search_for_files\` with \`${symbolName}\` as the query instead.`)

		const links = await getReferencesAtPosition(
			ctx.languageFeaturesService.referenceProvider,
			model,
			new Position(position.line, position.column),
			false,
			false,
			CancellationToken.None,
		)

		const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
		const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
		const pageLinks = links.slice(fromIdx, toIdx + 1)
		const hasNextPage = (links.length - 1) - toIdx >= 1

		const locations = pageLinks.map(link => ({
			uri: link.uri,
			line: link.range.startLineNumber,
			column: link.range.startColumn,
		}))
		return { result: { locations, hasNextPage } }
	},

	stringOfResult: (params, result, ctx) => {
		return ctx.voidModelService.withModel(params.uri, () => {
			if (result.locations.length === 0) {
				return `No usages found for \`${params.symbolName}\` on ${params.uri.fsPath}:${params.line}. If you believe this is wrong, try \`search_for_files\` with \`${params.symbolName}\` as the query.`
			}
			const header = `Found ${result.locations.length} ${result.locations.length === 1 ? 'usage' : 'usages'} of \`${params.symbolName}\`${result.hasNextPage ? ' (more on next page)' : ''}:`
			const lines = result.locations.map((loc, i) => {
				const { model } = ctx.voidModelService.getModel(loc.uri)
				const preview = model ? model.getLineContent(loc.line).trim() : '<preview unavailable>'
				return `${i + 1}. ${loc.uri.fsPath}:${loc.line}:${loc.column}  ${preview}`
			})
			const footer = result.hasNextPage ? '\n\n(More usages available. Call again with `page_number` incremented by 1 to see them.)' : ''
			return [header, ...lines].join('\n') + footer
		})
	},

	title: { done: 'Found usages', proposed: 'Go to usages', running: 'Finding usages' },
}
