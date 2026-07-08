import { URI } from '../../../../../base/common/uri.js'
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolDefinitionCore, ToolCtx } from './toolTypes.js'
import { validateStr } from './toolHelpers.js'

export const loadSkillToolCore: ToolDefinitionCore<'load_skill'> = {
	name: 'load_skill',
	description: `Loads the full instructions for a named skill. Use this when the current task matches a skill listed in the AVAILABLE SKILLS section of the system prompt. Returns the skill's full content as text. Only load skills that are relevant to the current task — don't load skills you don't need.`,
	params: {
		skill_name: { description: `The name of the skill to load, as it appears in the AVAILABLE SKILLS section of the system prompt.` },
	},
	approvalType: undefined,

	validateParams: (raw: RawToolParamsObj, _ctx: ToolCtx) => {
		const { skill_name: skillNameUnknown } = raw
		const skillName = validateStr('skill_name', skillNameUnknown)
		return { skillName }
	},

	callTool: async ({ skillName }, ctx) => {
		// Strip frontmatter and return body
		const stripFrontmatter = (content: string) => {
			const bodyMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)
			return (bodyMatch ? bodyMatch[1] : content).trim()
		}
		// Try each candidate path: workspace .void/skills/ then global ~/.void/skills/
		// Supports both <name>/SKILL.md (directory) and <name>.md (flat file)
		const candidateUris: URI[] = []
		for (const folder of ctx.workspaceContextService.getWorkspace().folders) {
			candidateUris.push(URI.joinPath(folder.uri, '.void', 'skills', skillName, 'SKILL.md'))
			candidateUris.push(URI.joinPath(folder.uri, '.void', 'skills', `${skillName}.md`))
		}
		const userHome = await ctx.pathService.userHome()
		candidateUris.push(URI.joinPath(userHome, '.void', 'skills', skillName, 'SKILL.md'))
		candidateUris.push(URI.joinPath(userHome, '.void', 'skills', `${skillName}.md`))

		for (const uri of candidateUris) {
			if (await ctx.fileService.exists(uri)) {
				const content = (await ctx.fileService.readFile(uri)).value.toString()
				return { result: { content: stripFrontmatter(content) } }
			}
		}
		return { result: { content: `Skill "${skillName}" not found. Check the AVAILABLE SKILLS section for the correct name.` } }
	},

	stringOfResult: (_params, result) => {
		return result.content
	},

	title: { done: 'Loaded skill', proposed: 'Load skill', running: 'Loading skill' },
}
