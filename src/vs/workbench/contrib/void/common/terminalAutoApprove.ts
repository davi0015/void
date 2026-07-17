/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, NodeType, type BaseNode } from './shellParser/parser.js'
import { getTopLevelCommands } from './shellParser/command.js'

// Commands that execute arbitrary code by nature — never auto-approve
// regardless of allowlist. `eval` runs a string as code, `source`/`.`
// executes a file, `exec` replaces the shell process.
const DANGEROUS_COMMAND_NAMES = new Set(['eval', 'source', 'exec', '.'])

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
	return units.map(getUnitText).filter(t => t.length > 0)
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

		// Check if this unit is a pipeline
		const unitHasPipeline = hasPipeline(unit)

		// Prefix-match against allowlist. If the unit is a pipeline, the
		// prefix must also contain a `|` — this prevents `git status` from
		// matching `git status | sh`.
		const matched = allowlist.some(prefix =>
			unitText === prefix
			|| (unitText.startsWith(prefix + ' ')
				&& (!unitHasPipeline || prefix.includes('|')))
		)
		if (!matched) return false
	}

	return true
}
