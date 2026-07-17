/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, NodeType, type BaseNode } from './shellParser/parser.js'
import { getTopLevelCommands, type Command } from './shellParser/command.js'

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

// Process substitution (<(), >()) is not parsed by the parser — it's left as
// raw text in word nodes. Scan for it in the command text. This is
// conservative: `echo a<(b` would require manual approval even though it might
// be a file path, but that's safe (false negative, not false positive).
const hasProcessSubstitution = (commandText: string): boolean => {
	return /<\(/.test(commandText) || />\)/.test(commandText)
}

// Parse a command string into individual Command objects. Returns empty array
// on parse failure.
const parseCommands = (command: string): Command[] => {
	try {
		const tree = parse(command)
		return getTopLevelCommands(tree)
	} catch {
		return []
	}
}

// Get the normalized text of a command (quotes stripped, env vars removed).
// This is what gets stored in the allowlist and matched against.
const getCommandText = (cmd: Command): string => {
	return cmd.tokens.map(t => t.text).join(' ').trim()
}

// Split a command string into normalized command texts. Useful for the UI
// to know what to store in the allowlist when the user clicks "Always approve".
export const splitCommands = (command: string): string[] => {
	const commands = parseCommands(command)
	const result: string[] = []
	for (const cmd of commands) {
		const text = getCommandText(cmd)
		if (text) {
			result.push(text)
		}
	}
	return result
}

// Returns true if every command in the command string matches a prefix in
// the allowlist AND no dangerous patterns are detected. Returns false
// (require manual approval) if:
//   - The allowlist is empty
//   - Parsing fails or yields zero commands
//   - Any command contains command substitution ($(), backticks)
//   - Any command contains process substitution (<(), >())
//   - Any command's name is eval/source/exec/.
//   - Any command doesn't match an allowlist prefix
export const shouldAutoApprove = (command: string, allowlist: string[]): boolean => {
	if (allowlist.length === 0) return false

	const commands = parseCommands(command)
	if (commands.length === 0) return false

	for (const cmd of commands) {
		const cmdText = getCommandText(cmd)
		if (!cmdText) continue

		// Check if command name is a dangerous builtin
		const cmdName = cmd.tokens[0]?.text
		if (cmdName && DANGEROUS_COMMAND_NAMES.has(cmdName)) return false

		// Check for command substitution in the AST ($(), backticks)
		if (hasCommandSubstitution(cmd.tree)) return false

		// Check for process substitution in raw text (<(), >())
		if (hasProcessSubstitution(cmdText)) return false

		// Prefix-match against allowlist
		const matched = allowlist.some(prefix =>
			cmdText === prefix || cmdText.startsWith(prefix + ' ')
		)
		if (!matched) return false
	}

	return true
}
