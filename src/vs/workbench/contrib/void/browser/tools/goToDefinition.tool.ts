import { CancellationToken } from '../../../../../base/common/cancellation.js'
import { Position } from '../../../../../editor/common/core/position.js'
import { getDefinitionsAtPosition } from '../../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr, validateNumber, resolveSymbolPosition } from './toolHelpers.js'

export const goToDefinitionToolCore: ToolDefinitionCore<'go_to_definition'> = {
	name: 'go_to_definition',
	description: `Use this to find where a symbol (function, class, variable, type) is defined, using the language's LSP (same mechanism as VS Code's "Go to Definition" / F12). Returns precise source locations — NOT text matches. This is the correct tool whenever you need to locate the source of a named identifier, whether to answer a question, inspect a function before calling it, follow an import to its real source, or resolve what a re-export actually points to. Prefer this over \`search_in_file\` or \`search_for_files\` whenever you know the symbol name: LSP resolves aliases, re-exports, and overloaded references that lexical search conflates or misses entirely. If no LSP provider is registered for the file's language, this tool returns an error telling you to fall back to \`search_in_file\` / \`search_for_files\`.`,
	params: {
		uri: { description: `Path to the file. Can be absolute (e.g. \`/Users/you/project/src/foo.ts\`) or relative to the workspace root (e.g. \`src/foo.ts\`, \`README.md\`).` },
		symbol_name: { description: `The name of the symbol you want to locate (e.g. \`validateToken\`, \`MyClass\`). Case-sensitive. Must appear somewhere in the file; the tool matches whole words only (e.g., \`foo\` will not match inside \`fooBar\`).` },
		line: { description: `Optional — strongly recommended when you know it. The 1-indexed line number in the file where \`symbol_name\` appears. If you have just read the file or run \`search_in_file\`, pass the line you saw — this is the most reliable mode and is REQUIRED to disambiguate when the same name has multiple meanings in the same file (shadowing, re-assignment, overloaded declarations, local-vs-outer bindings). If omitted, the tool scans the file for the first whole-word occurrence of \`symbol_name\` — this is safe only when the name is distinctive enough to have a single meaning in the file (typical for unique function/class names, risky for short/common names like \`i\`, \`x\`, \`result\`, \`run\`).` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, ctx: ToolCtx) => {
		const { uri: uriStr, symbol_name: symbolNameUnknown, line: lineUnknown } = raw
		const uri = ctx.validateURI(uriStr)
		const symbolName = validateStr('symbol_name', symbolNameUnknown)
		const line = validateNumber(lineUnknown, { default: null })
		if (line !== null && line < 1) throw new Error(`\`line\` must be 1 or greater, got ${line}.`)
		return { uri, symbolName, line }
	},

	callTool: async ({ uri, symbolName, line }, ctx) => {
		await ctx.voidModelService.initializeModel(uri)
		const { model } = await ctx.voidModelService.getModelSafe(uri)
		if (model === null) throw new Error(`File does not exist: ${uri.fsPath}.`)

		const position = resolveSymbolPosition(model, symbolName, line)
		if (position === null) throw new Error(`Symbol \`${symbolName}\` not found anywhere in ${uri.fsPath}. Check the spelling of the symbol or the file path.`)

		const providers = ctx.languageFeaturesService.definitionProvider.ordered(model)
		if (providers.length === 0) throw new Error(`No LSP definition provider is registered for ${model.getLanguageId()} files. Use \`search_in_file\` or \`search_for_files\` with \`${symbolName}\` as the query instead.`)

		const links = await getDefinitionsAtPosition(
			ctx.languageFeaturesService.definitionProvider,
			model,
			new Position(position.line, position.column),
			false,
			CancellationToken.None,
		)

		const locations = links.map(link => ({
			uri: link.uri,
			line: link.range.startLineNumber,
			column: link.range.startColumn,
		}))
		return { result: { locations } }
	},

	stringOfResult: (params, result, ctx) => {
		return ctx.voidModelService.withModel(params.uri, () => {
			if (result.locations.length === 0) {
				return `No definition found for \`${params.symbolName}\` on ${params.uri.fsPath}:${params.line}. This can happen for built-in or primitive types. If you believe this is wrong, try \`search_in_file\` or \`search_for_files\` with \`${params.symbolName}\` as the query.`
			}
			const header = result.locations.length === 1
				? `Found 1 definition of \`${params.symbolName}\`:`
				: `Found ${result.locations.length} definitions of \`${params.symbolName}\`:`
			const lines = result.locations.map((loc, i) => {
				const { model } = ctx.voidModelService.getModel(loc.uri)
				const preview = model ? model.getLineContent(loc.line).trim() : '<preview unavailable>'
				return `${i + 1}. ${loc.uri.fsPath}:${loc.line}:${loc.column}  ${preview}`
			})
			return [header, ...lines].join('\n')
		})
	},

	title: { done: 'Found definition', proposed: 'Go to definition', running: 'Finding definition' },
}
