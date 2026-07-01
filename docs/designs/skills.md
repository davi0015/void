# Agent-Driven Skills

## Problem

`.voidrules` is always-on baseline rules — every token is in every request. This is correct for rules the agent must *always* follow, but wrong for specialized knowledge that's only relevant *sometimes*. A React debugging guide, an AWS deployment runbook, or a git workflow convention shouldn't consume tokens in every request when the task doesn't involve them.

Today, users who want specialized knowledge either:
1. Paste it into chat manually each time (high friction)
2. Put it in `.voidrules` (token bloat — always in context)
3. Put it in a file and hope the agent `read_file`s it (unreliable — agent doesn't know the file exists)

## Solution

Anthropic-style skills: modular instruction files (markdown) with a name and description. The agent sees a compact **index** of available skills (names + one-line descriptions only) in the system prompt. When a skill is relevant to the current task, the agent calls a `load_skill` tool to pull in the full instructions on-demand. The full content arrives as a tool result for that turn, not permanently in the system prompt.

A workspace with 15 skills averaging 500 tokens each would add 7.5k tokens to every request if always-on. With on-demand loading, only the ~150-token index is always in context.

## Relationship to existing systems

| System | When in context | Scope | Purpose |
|---|---|---|---|
| `chat_systemMessage` | Always (frozen, prefix-cached) | Global | Persona, rules, tool definitions |
| `.voidrules` | Always (frozen via `aiInstructions`) | Workspace | Rules the agent must always follow |
| `globalSettings.aiInstructions` | Always (frozen via `aiInstructions`) | Global | Global rules (text field in settings) |
| `rulesPaths` | Always (frozen via `aiInstructions`) | Workspace | Additional rule files (`.md`/`.mdc`) |
| **Skills index** | Always (frozen via `aiInstructions`) | Workspace + global | Compact list of available skills |
| **Skill content** | On-demand (tool result) | N/A | Full instructions, loaded when relevant |

Skills are layered on top of `aiInstructions` — the index is appended to the same combined string, so it gets frozen on first send and stays byte-identical across turns for prefix cache stability. No new freeze plumbing.

## Architecture

### 1. Skill files

Two file layouts are supported:

**Directory layout** (recommended — allows reference files alongside the skill):
```
.void/skills/using-confluence-cli/
├── SKILL.md          # main skill file (frontmatter + body)
└── reference/        # optional supporting files
    ├── parameters.md
    └── pull-request.md
```

**Flat file layout** (simpler, for short skills):
```
.void/skills/react-debugging.md
```

Both use optional YAML frontmatter:

```markdown
---
name: react-debugging
description: Debug React component rendering and state issues
---
When debugging React components:
1. Check the component tree with React DevTools
2. Look for stale closures in useEffect dependencies
...
```

If no frontmatter: for directory layout, the directory name is the skill name; for flat file, the filename (without `.md`) is the name. Description is empty if not specified.

### 2. Skill locations

Two directories, merged into one index:

| Location | Scope | Path |
|---|---|---|
| Workspace skills | Per-workspace | `.void/skills/*.md` (relative to each workspace folder) |
| Global skills | Cross-workspace | `~/.void/skills/*.md` (user home directory) |

**Why global:** some skills are project-agnostic (personal coding conventions, debugging methodology, common tool patterns). Users shouldn't have to copy them into every workspace. Mirrors how `globalSettings.aiInstructions` (global) already coexists with `.voidrules` (workspace).

**Name collision resolution:** workspace skills override global skills with the same name. The index lists the workspace version only. `load_skill` checks workspace dir first, falls back to global.

**Path resolution:**
- Workspace: `URI.joinPath(folder.uri, '.void', 'skills')` — same pattern as `.voidrules` at `convertToLLMMessageService.ts:1003`
- Global: `joinPath(pathService.userHome(), '.void', 'skills')` — `userHome` is the OS home directory (`~` on macOS/Linux, `%USERPROFILE%` on Windows)

### 3. Skills index injection

The index flows through the existing `aiInstructions` path. `_getCombinedAIInstructionsAsync()` in `convertToLLMMessageService.ts` (line ~1124) already combines global AI instructions + `.voidrules` + `rulesPaths` into one string. Skills index is appended as a final section:

```
AVAILABLE SKILLS (use the load_skill tool to load full instructions when relevant):
- react-debugging: Debug React component rendering and state issues
- git-workflow: Branch/commit/PR conventions for this repo
- deploy-aws: AWS deployment steps and configuration
```

This means the index is automatically:
- **Frozen on first send** via `frozenAiInstructions` on the thread (`chatThreadService.ts:1708`)
- **Byte-identical across turns** for prefix cache stability
- **Re-applied via the same flow** as `.voidrules` when files change (user sees the "rules changed" indicator)

### 4. `load_skill` tool

Read-only tool (no approval, not in `approvalTypeOfBuiltinToolName`). Available in agent and gather modes (same as other read-only tools like `read_file`, `search_history`).

**Params:**
```typescript
{ skill_name: string }  // the skill name from the index
```

**Result:**
```typescript
{ content: string }  // full skill file body (frontmatter stripped)
```

**Implementation:** tries each candidate path in order: workspace `.void/skills/<skill_name>/SKILL.md`, workspace `.void/skills/<skill_name>.md`, global `~/.void/skills/<skill_name>/SKILL.md`, global `~/.void/skills/<skill_name>.md`. Returns the first match (frontmatter stripped). Returns an error string if no match.

**Tool description** (in `prompts.ts`):
> Loads the full instructions for a named skill. Use this when the current task matches a skill listed in the AVAILABLE SKILLS section of the system prompt. Returns the skill's full content as text. Only load skills that are relevant to the current task — don't load skills you don't need.

### 5. Discovery

`_getSkillsIndex()` method in `convertToLLMMessageService.ts`, called from `_getCombinedAIInstructionsAsync()`. Scans both `.void/skills/` (per workspace folder) and `~/.void/skills/` via `fileService.resolve` (same pattern as `_getRulesPathsContents` at line ~1030). Parses frontmatter with the existing `_parseMdcFile` pattern. Returns the formatted index string, or empty string if no skills found.

No file watcher for v1 — skills are read fresh on first send (frozen thereafter), same as `.voidrules`.

## Design decisions

- **Index in `aiInstructions`, not a separate system-message parameter** — reuses the existing freeze + inject infrastructure with zero new plumbing. The `aiInstructions` string already combines multiple sources (global instructions, `.voidrules`, `rulesPaths`); skills index is just one more section.

- **Agent-driven, not heuristic auto-loading** — the agent decides when to call `load_skill` based on the task and the skill descriptions. Pro: zero token cost when irrelevant, no detection logic to maintain. Con: depends on model capability — weaker models (Gemma, Nemotron) may not reliably recognize when a skill applies. Same capability ceiling as LSP tools and parallel reads: strong models use it well, weaker ones won't. Consistent with existing Void philosophy.

- **Index in system prompt, not a `list_skills` tool** — injecting the compact index directly into the system prompt means the agent always knows what skills exist without an extra tool round-trip. The index is small (~150 tokens for 15 skills) and frozen (stable across turns), so it stays prefix-cached. A `list_skills` tool would require the agent to call it before knowing what's available, adding latency.

- **Skill content as tool result, not system prompt mutation** — loading a skill doesn't modify the system prompt (which would break prefix cache). The content arrives as a tool result in conversation history, which is already cache-warm territory.

- **Workspace overrides global** — follows the same precedence as `.voidrules` (workspace) over `aiInstructions` (global). More specific wins.

## Files to change

All within `src/vs/workbench/contrib/void`:

| File | Change |
|---|---|
| `common/prompt/prompts.ts` | Add `load_skill` to `builtinTools` (name, description, params) |
| `common/toolsServiceTypes.ts` | Add `'load_skill'` to `BuiltinToolCallParams` (`{ skillName: string }`) and `BuiltinToolResultType` (`{ content: string }`) |
| `browser/toolsService.ts` | Add `load_skill` to validateParams, callTool (reads skill file), and stringifier |
| `browser/convertToLLMMessageService.ts` | Add `_getSkillsIndex()` method (scans workspace + global skill dirs), call from `_getCombinedAIInstructionsAsync()` |

No changes outside `src/vs/workbench/contrib/void`. No settings UI for v1 — skills are discovered automatically. No file watcher for v1 — frozen on first send, same as `.voidrules`.

## Risks

- **Model compliance** — weaker models may not call `load_skill` when they should. Fallback: `.voidrules` can include a hint like "If your task involves React, load the react-debugging skill first." Same empirical-testing approach as the memory system design.

- **Skill quality** — poorly written skills mislead the agent. Mitigated by: skills are user-authored (user controls quality), and skill content is visible in the conversation as a tool result (user can see what was loaded).

- **Discovery friction** — users need to know to create `.void/skills/` or `~/.void/skills/` files. Could ship a few built-in starter skills or add a "create skill" command later.
