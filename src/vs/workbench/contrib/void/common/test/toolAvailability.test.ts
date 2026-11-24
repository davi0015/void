/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { builtinToolNames } from '../prompt/prompts.js';
import {
	approvalTypeOfBuiltinToolName,
	BuiltinToolName,
	chatModeOfChildThread,
	delegationToolNames,
	isToolAvailableInChatMode,
	levelOfBuiltinToolName,
	levelOfChatMode,
} from '../toolsServiceTypes.js';
import type { ChatMode } from '../voidSettingsTypes.js';

// Which builtin tools a chat mode may use.
//
// This looks like a one-line filter and was treated as one until delegation arrived,
// which is why it is tested. `gather` used to be "everything that needs no approval",
// and that is a proxy for "read-only" only until a tool needs no approval and can
// still write a file — which is exactly what `run_subagent` does. The rule is a
// ladder now: a mode is a rung, a tool sits on one, and a mode gets what is at or
// below it. The safety property is two numbers instead of an exclusion list.
//
// Three things the tests below hold together:
//
//   * the ladder is monotonic, so a higher rung is never narrower than a lower one;
//   * each tool's grade has not drifted from the two facts it deliberately repeats —
//     the approval table and the delegation set — because drift is how this rule goes
//     wrong without anybody seeing it;
//   * a child runs one rung down, because delegation does not inherit.

const ladder: ChatMode[] = ['normal', 'gather', 'agent', 'orchestrator']
const tools: BuiltinToolName[] = builtinToolNames

suite('ToolAvailability', () => {

	test('the modes are a strict ladder, lowest first', () => {
		assert.ok(ladder.length >= 2, 'the ladder is too short to order anything');
		for (let i = 1; i < ladder.length; i++) {
			const lower = levelOfChatMode[ladder[i - 1]]
			const higher = levelOfChatMode[ladder[i]]
			assert.ok(higher > lower, `${ladder[i]} is not above ${ladder[i - 1]}: ${higher} vs ${lower}`)
		}
	});

	test('a rung is never narrower than the rung below it', () => {
		for (const toolName of tools) {
			let heldByLowerRung = false
			for (const mode of ladder) {
				const held = isToolAvailableInChatMode(toolName, mode)
				assert.strictEqual(typeof held, 'boolean', `${toolName} in ${mode} produced ${held}`)
				if (heldByLowerRung) {
					assert.strictEqual(held, true, `${toolName} is in a lower rung and missing from ${mode}`)
				}
				heldByLowerRung = held
			}
		}
	});

	test('orchestrator is the full list, and agent is the list without delegation', () => {
		assert.ok(tools.length > 0, 'the tool list is empty, so this test would prove nothing');
		assert.ok(delegationToolNames.size > 0, 'the delegation set is empty, so the exclusion below is untested');

		for (const toolName of tools) {
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'orchestrator'),
				true,
				`${toolName} is missing from orchestrator, which is meant to hold every builtin tool`,
			);
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'agent'),
				!delegationToolNames.has(toolName),
				`agent disagrees with the delegation set about ${toolName}`,
			);
		}
	});

	test('gather keeps the read-only tools and drops what needs approval or starts a child', () => {
		// Control, in the sense that matters: if every tool were unavailable in gather,
		// the assertions below would pass for the wrong reason.
		assert.strictEqual(isToolAvailableInChatMode('read_file', 'gather'), true, 'gather lost a read-only tool');
		assert.strictEqual(isToolAvailableInChatMode('semantic_search', 'gather'), true, 'gather lost a read-only tool');

		for (const toolName of Object.keys(approvalTypeOfBuiltinToolName) as (keyof typeof approvalTypeOfBuiltinToolName)[]) {
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'gather'),
				false,
				`${toolName} needs approval and is still reachable in gather mode`,
			);
		}
		for (const toolName of delegationToolNames) {
			assert.strictEqual(
				isToolAvailableInChatMode(toolName, 'gather'),
				false,
				`${toolName} would let a read-only mode start a child that can write`,
			);
		}
	});

	test('normal mode has no builtin tools at all', () => {
		for (const toolName of tools) {
			assert.strictEqual(isToolAvailableInChatMode(toolName, 'normal'), false, `${toolName} is reachable in normal mode`);
		}
	});

	test('every tool is graded, and the grade agrees with approval except for delegation', () => {
		// The grade answers a different question from the approval tier: what the tool
		// does, not whether a call to it is prompted. They agree for every tool today
		// except delegation — and delegation is the case that proves they are not the
		// same fact, because it needs no approval and can still start a writer. Asserting
		// the agreement keeps the two tables from drifting apart silently; the assertion
		// that delegation is *not* in the approval table keeps this test from passing for
		// the wrong reason.
		for (const toolName of tools) {
			const level = levelOfBuiltinToolName[toolName]
			assert.ok(level === 1 || level === 2 || level === 3, `${toolName} has no rung: ${level}`);

			if (delegationToolNames.has(toolName)) {
				assert.strictEqual(level, 3, `${toolName} delegates but is not on the top rung`);
				assert.ok(
					!(toolName in approvalTypeOfBuiltinToolName),
					`${toolName} needs approval now, so "delegation needs none" is no longer the reason it cannot be graded by approval`,
				);
				continue
			}
			const needsApproval = toolName in approvalTypeOfBuiltinToolName
			assert.strictEqual(
				level,
				needsApproval ? 2 : 1,
				`${toolName} is graded ${level} but ${needsApproval ? 'needs' : 'does not need'} approval. ` +
				`If that is right, change the grade in levelOfBuiltinToolName — not this test.`,
			);
		}
	});

	test('a child runs one rung down, never above its parent', () => {
		assert.strictEqual(chatModeOfChildThread('orchestrator'), 'agent', 'a child of an orchestrator could delegate again');
		assert.strictEqual(chatModeOfChildThread('agent'), 'agent', 'a child of an agent lost the ability to act');

		const top = levelOfChatMode['agent']
		for (const parent of ladder) {
			const child = chatModeOfChildThread(parent)
			assert.ok(
				levelOfChatMode[child] <= levelOfChatMode[parent],
				`${parent}'s child runs as ${child}, which is above its parent`,
			);
			assert.ok(
				levelOfChatMode[child] <= top,
				`${parent}'s child runs as ${child}, which is above agent`,
			);
		}
	});
});