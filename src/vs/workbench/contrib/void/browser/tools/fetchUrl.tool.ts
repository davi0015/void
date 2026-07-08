import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr } from './toolHelpers.js'

export const fetchUrlToolCore: ToolDefinitionCore<'fetch_url'> = {
	name: 'fetch_url',
	description: `Use this to fetch the content of a web page. The URL must be a fully-qualified HTTP or HTTPS URL. Returns the page content as readable Markdown text (article body extracted, navigation/ads stripped). Use when the user shares a link (docs, issue tracker, API reference, blog post, etc.) and you need to read its content. Do NOT use this for local files — use \`read_file\` instead.`,
	params: {
		url: { description: `The fully-qualified URL to fetch (must start with \`http://\` or \`https://\`).` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { url: urlUnknown } = raw
		const url = validateStr('url', urlUnknown)
		if (!/^https?:\/\//i.test(url)) {
			throw new Error(`Invalid URL: "${url}". URL must start with http:// or https://.`)
		}
		return { url }
	},

	callTool: async ({ url }, ctx) => {
		const result = await ctx.fetchUrlService.fetchUrl(url)
		return { result }
	},

	stringOfResult: (_params, result) => {
		return `# ${result.title}\n\nSource: ${result.url}\n\n${result.content}`
	},

	title: { done: 'Fetched URL', proposed: 'Fetch URL', running: 'Fetching URL' },
}
