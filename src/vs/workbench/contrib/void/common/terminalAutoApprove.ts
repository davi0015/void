/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, NodeType, type BaseNode } from './shellParser/parser.js'
import { getTopLevelCommands, type Command, type Token } from './shellParser/command.js'

// Commands and shell keywords that execute arbitrary code or change
// control flow — never auto-approve regardless of allowlist.
//   - `eval` runs a string as code, `source`/`.` executes a file,
//     `exec` replaces the shell process
//   - `while`/`for`/`if`/`until`/`case`/`select` are shell control flow
//     constructs that execute arbitrary code in their bodies. The parser
//     treats them as regular command words, so they'd otherwise slip through.
const DANGEROUS_COMMAND_NAMES = new Set([
	'eval', 'source', 'exec', '.',
	'while', 'for', 'if', 'until', 'case', 'select', '[[', 'time',
	'do', 'then', 'else', 'elif', 'fi', 'done', 'esac',
])

// Recursively check if a node tree contains command substitution ($() or
// backticks). The parser correctly distinguishes `$(date)` (CommandSubstitution
// node) from `'$(date)'` (literal text in a RawString — no child node), so
// this won't false-positive on single-quoted strings.
const hasCommandSubstitution = (node: BaseNode): boolean => {
	if (node.type === NodeType.CommandSubstitution) {
		return true
	}
	return node.children.some(child => hasCommandSubstitution(child))
}

// Check if a node tree contains a Pipeline (pipe operator |). Used to prevent
// prefix matching across pipe boundaries — `git status` should NOT match
// `git status | sh` because the pipe introduces a new, potentially dangerous
// command.
const hasPipeline = (node: BaseNode): boolean => {
	if (node.type === NodeType.Pipeline) return true
	return node.children.some(child => hasPipeline(child))
}

// Process substitution (<(), >()) is not parsed by the parser — it's left as
// raw text in word nodes. Scan for it in the command text. This is
// conservative: `echo a<(b` would require manual approval even though it might
// be a file path, but that's safe (false negative, not false positive).
const hasProcessSubstitution = (commandText: string): boolean => {
	return /<\(/.test(commandText) || />\)/.test(commandText)
}

// Walk the AST, splitting only on &&/||/; (List nodes) and statement
// separators. Pipelines (|) are treated as atomic units — the entire pipeline
// is one entry. This prevents `cat` from being stored as a standalone prefix
// when the user approves `git diff | cat`.
const splitChainUnits = (tree: BaseNode): BaseNode[] => {
	const results: BaseNode[] = []
	const walk = (node: BaseNode) => {
		if (node.type === NodeType.List) {
			// && or || — recurse into parts
			for (const child of node.children) walk(child)
		} else if (
			node.type === NodeType.Program ||
			node.type === NodeType.CompoundStatement ||
			node.type === NodeType.Subshell
		) {
			// Containers — recurse into children
			for (const child of node.children) walk(child)
		} else if (node.type === NodeType.AssignmentList) {
			// Extract the Command child, skip pure assignments
			const cmdChild = node.children.find(c => c.type === NodeType.Command)
			if (cmdChild) walk(cmdChild)
		} else {
			// Command, Pipeline, or other — atomic
			const text = node.text.trim()
			if (text) results.push(node)
		}
	}
	walk(tree)
	return results
}

const getUnitText = (node: BaseNode): string => {
	return node.text.trim()
}

// Node types that represent quoted strings. Their content is inherently
// variable (messages, paths, arbitrary text), so they're stripped from the
// stored prefix — `echo "random long text"` stores `echo`, not the full
// string that would never match a future `echo "different text"`.
const QUOTED_STRING_TYPES = new Set([
	NodeType.String,      // "double-quoted"
	NodeType.RawString,   // 'single-quoted'
	NodeType.AnsiCString, // $'ANSI-C'
])

// A token is "structural" — part of the stable command name/structure — if
// it's a plain word (alphabetic, possibly with hyphens) and NOT a quoted
// string. This single rule strips flags (`-x`, `--flag`), numbers (e.g.
// stray `1` from `2>&1`), paths (`/foo`, `./src`, `~/x`), shell syntax
// (`{}`, `+`, `;`), and redirections (`2>&1`, `>`, `>>`) in one pass.
// Quoted strings are stripped by node type because their inner text may be
// alphabetic (e.g. `"hello"`) but is still variable content.
const isStructuralToken = (token: Token): boolean => {
	if (QUOTED_STRING_TYPES.has(token.node.type)) return false
	return /^[a-zA-Z][a-zA-Z-]*$/.test(token.text)
}

// Normalize a single Command to its prefix: keep only structural tokens
// (command name + subcommands + word-like positional args). For single-dash
// flags (`-type`, `-exec`, `-i`), also skip the next token as a potential
// value — this prevents orphaned values like `stat` from `-exec stat` or
// `pattern` from `-i pattern`. Double-dash flags (`--no-pager`, `--all`)
// are usually boolean or `--key=value`, so no extra skip is needed.
const getCommandPrefix = (cmd: Command): string => {
	const keptTokens: string[] = []
	const tokens = cmd.tokens
	let i = 0
	while (i < tokens.length) {
		const t = tokens[i]
		if (isStructuralToken(t)) {
			keptTokens.push(t.text)
			i += 1
		} else if (t.text.startsWith('-') && !t.text.startsWith('--')
			&& i + 1 < tokens.length
			&& !tokens[i + 1].text.startsWith('-')) {
			// Single-dash flag with a value — skip both the flag and its value
			i += 2
		} else {
			i += 1
		}
	}
	return keptTokens.join(' ').trim()
}

// Get the normalized prefix for a chain unit — what gets stored in the
// allowlist AND what gets matched against. For a simple command, normalizes
// its tokens. For a pipeline, normalizes each command individually and joins
// them with ` | ` so flags are stripped consistently on both sides.
const getUnitPrefix = (node: BaseNode): string => {
	const commands = getTopLevelCommands(node)
	if (commands.length === 0) {
		return ''
	}
	const parts = commands.map(getCommandPrefix).filter(t => t.length > 0)
	return parts.join(' | ').trim()
}

// Split a command string into chain units (split on &&/||/; only, not |).
// Pipelines are treated as a single unit. Used by the UI to know what to
// store in the allowlist when the user clicks "Always Approve".
export const splitCommands = (command: string): string[] => {
	let tree: BaseNode
	try {
		tree = parse(command)
	} catch {
		return []
	}
	const units = splitChainUnits(tree)
	return units.map(getUnitPrefix).filter(t => t.length > 0)
}

export type CommandApprovalStatus = {
	text: string
	isApproved: boolean
	canApprove: boolean
}

// Check if a single chain unit could ever be auto-approved — i.e., it doesn't
// contain dangerous patterns (dangerous command names, command substitution,
// or process substitution). This is the per-unit version of the check that
// shouldAutoApprove applies to every unit.
const unitCanApprove = (unit: BaseNode): boolean => {
	const unitText = getUnitText(unit)
	if (!unitText) return false

	const commandsInUnit = getTopLevelCommands(unit)
	for (const cmd of commandsInUnit) {
		const cmdName = cmd.tokens[0]?.text
		if (cmdName && DANGEROUS_COMMAND_NAMES.has(cmdName)) return false
	}
	if (hasCommandSubstitution(unit)) return false
	if (hasProcessSubstitution(unitText)) return false
	return true
}

// Split a command string into chain units, each annotated with:
//   - isApproved: already covered by the allowlist
//   - canApprove: could ever be auto-approved (no dangerous patterns)
// Used by the UI to show the user which commands will be newly added vs
// already approved, and to hide the "Always" button for dangerous commands.
export const splitCommandsWithApproval = (command: string, allowlist: string[]): CommandApprovalStatus[] => {
	let tree: BaseNode
	try {
		tree = parse(command)
	} catch {
		return []
	}
	const units = splitChainUnits(tree)
	return units.map(unit => {
		const prefix = getUnitPrefix(unit)
		const unitHasPipeline = hasPipeline(unit)
		const canApprove = unitCanApprove(unit)
		const isApproved = canApprove && allowlist.some(allowPrefix =>
			prefix === allowPrefix
			|| (prefix.startsWith(allowPrefix + ' ')
				&& (!unitHasPipeline || allowPrefix.includes('|')))
		)
		return { text: prefix, isApproved, canApprove }
	}).filter(u => u.text.length > 0)
}

// Returns true if every chain unit in the command string matches a prefix in
// the allowlist AND no dangerous patterns are detected. Returns false
// (require manual approval) if:
//   - The allowlist is empty
//   - Parsing fails or yields zero units
//   - Any unit contains command substitution ($(), backticks)
//   - Any unit contains process substitution (<(), >())
//   - Any unit's command name is eval/source/exec/.
//   - Any unit doesn't match an allowlist prefix
//   - A pipeline unit matches a non-pipeline prefix (prevents `git status`
//     from matching `git status | sh`)
export const shouldAutoApprove = (command: string, allowlist: string[]): boolean => {
	if (allowlist.length === 0) return false

	let tree: BaseNode
	try {
		tree = parse(command)
	} catch {
		return false
	}

	const units = splitChainUnits(tree)
	if (units.length === 0) return false

	for (const unit of units) {
		const unitText = getUnitText(unit)
		if (!unitText) continue

		// Check for dangerous builtins in ALL commands within this unit
		// (a pipeline like `git diff | eval "..."` must be caught)
		const commandsInUnit = getTopLevelCommands(unit)
		for (const cmd of commandsInUnit) {
			const cmdName = cmd.tokens[0]?.text
			if (cmdName && DANGEROUS_COMMAND_NAMES.has(cmdName)) return false
		}

		// Check for command substitution in the AST
		if (hasCommandSubstitution(unit)) return false

		// Check for process substitution
		if (hasProcessSubstitution(unitText)) return false

		// Skip units with no structural tokens (e.g. stray `1` from `2>&1`
		// — the parser splits at `&`, leaving a unit with just `1` which has
		// no command name). These can't match any allowlist prefix.
		const unitPrefix = getUnitPrefix(unit)
		if (!unitPrefix) continue

		// Check if this unit is a pipeline
		const unitHasPipeline = hasPipeline(unit)

		// Prefix-match against allowlist. Both the stored prefix and the
		// incoming command are normalized (flags and quoted strings stripped)
		// via getUnitPrefix, so `git --no-pager diff` matches a stored `git diff`.
		// If the unit is a pipeline, the prefix must also contain a `|` — this
		// prevents `git status` from matching `git status | sh`.
		const matched = allowlist.some(prefix =>
			unitPrefix === prefix
			|| (unitPrefix.startsWith(prefix + ' ')
				&& (!unitHasPipeline || prefix.includes('|')))
		)
		if (!matched) return false
	}

	return true
}
