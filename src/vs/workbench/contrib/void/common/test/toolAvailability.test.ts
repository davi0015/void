/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { builtinToolNames } from '../prompt/prompts.js';
import { BuiltinToolName, approvalTypeOfBuiltinToolName, delegationToolNames, isToolAvailableInChatMode, subagentOnlyToolNames } from '../toolsServiceTypes.js';

// Which builtin tools a chat mode may use.
//
// This looks like a one-line filter and was treated as one until delegation arrived,
// which is exactly why it is tested: `gather` is read-only *by construction* — it
// keeps whatever needs no approval — and delegation needs no approval either, while a
// child can write. So the gather filter stopped being a proxy for "read-only" the
// moment `run_subagent` existed, and the failure would be silent: a read-only mode
// that can spawn a writer is still read-only in every way a user can see.
//
// The first test iterates `delegationToolNames` rather than naming the tools, so a
// delegation tool added later is covered without anybody remembering this file.

suite('ToolAvailability', () => {

	test('no delegation tool is reachable in gather mode, and all of them are in agent mode', () => {
		assert.ok(delegationToolNames.size > 0, 'the set is empty, so this test would prove nothing');

		for (const toolName of delegationToolNames) {
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'gather'),
				false,
				`${toolName} is reachable in gather mode, which is supposed to be read-only`,
			);
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'agent'),
				true,
				`${toolName} is not available in agent mode, which is where delegation belongs`,
			);
		}
	});

	test('gather keeps the read-only tools and drops the ones that need approval', () => {
		// Control, in the sense that matters: if every tool were unavailable in gather,
		// the test above would pass for the wrong reason.
		assert.strictEqual(isToolAvailableInChatMode('read_file', 'gather'), true, 'gather lost a read-only tool');
		assert.strictEqual(isToolAvailableInChatMode('semantic_search', 'gather'), true, 'gather lost a read-only tool');

		// And the approval gate is still the thing deciding the rest: anything in the
		// approval table needs it, so gather cannot have it.
		for (const toolName of Object.keys(approvalTypeOfBuiltinToolName) as (keyof typeof approvalTypeOfBuiltinToolName)[]) {
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'gather'),
				false,
				`${toolName} needs approval and is still reachable in gather mode`,
			);
		}
	});

	test('the report tool belongs to a child, and to nobody else', () => {
		assert.ok(subagentOnlyToolNames.size > 0, 'the set is empty, so this test would prove nothing');

		for (const toolName of subagentOnlyToolNames) {
			// The child half of the result contract: without it the parent's report is
			// whatever the child happened to say last.
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'agent', true), true, `${toolName} is not offered to a subagent`);
			// A top-level thread has no parent to report to, so the tool is absent rather than
			// present and refusing — an affordance a model cannot use is one it will misuse.
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'agent', false), false, `${toolName} is offered to a top-level thread`);
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'gather', true), false, `${toolName} is reachable in gather mode`);
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'normal', true), false, `${toolName} is reachable in normal mode`);
		}
	});

	test('normal mode has no builtin tools at all', () => {
		// `normal` is the chat-only mode; a tool list there would be a regression no test
		// of the filter's shape would catch, because the filter would simply be broader.
		const samples: BuiltinToolName[] = ['read_file', 'run_command', ...delegationToolNames];
		for (const toolName of samples) {
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'normal'), false, `${toolName} is reachable in normal mode`);
		}
	});

	test('every rule is total over the builtin list', () => {
		// No mode throws, and agent mode is exactly the full list — the identity that
		// makes `availableTools` and this rule agree about what "all the tools" means.
		for (const toolName of builtinToolNames) {
			for (const mode of ['agent', 'gather', 'normal'] as const) {
				const available = isToolAvailableInChatMode(toolName, mode);
				assert.strictEqual(typeof available, 'boolean', `${toolName} in ${mode} produced ${available}`);
			}
			// Agent mode is the whole list, except the tools only a child has. Stating it
			// against the set rather than as a bare `true` is what keeps this test honest when
			// a tool is added to either side.
			const expected = !subagentOnlyToolNames.has(toolName);
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'agent'), expected, `${toolName} availability in agent mode disagrees with the sets`);
		}
	});
});
