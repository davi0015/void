/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	ALIAS_MAX_CHARS,
	childThreadSeedOf,
	ChildThreadCreation,
	DelegatingThreadLike,
	delegationDepthOf,
	isChildThread,
	MAX_DELEGATION_DEPTH,
	reportedSummaryOf,
	REPORT_CLOSE,
	REPORT_OPEN,
	subagentPreambleOf,
	withSubagentPreamble,
} from '../childThreadLinkage.js';

// What a child thread is, and what it inherits from the thread that spawned it.
//
// These are the two rules a delegation gets wrong in a way nobody notices until
// much later: inheritance copied from somewhere that is not the parent (so the
// child is a different agent than the one that was asked for), and a depth that
// lets a child spawn children.
//
// Inheritance matters in both directions. A child that resolved its permission
// mode from the default instead of the parent would be *narrower* than its
// parent, so work the parent was granted would fail in the child; a child that
// took a wider grant would be the widening this design forbids. The tests below
// pin the copy in both directions rather than only the dangerous one.

const thread = (over: Partial<DelegatingThreadLike> = {}): DelegatingThreadLike => ({ id: 'parent-thread', ...over })

const seedOf = (creation: ChildThreadCreation) => {
	assert.ok(creation.ok, `expected a seed, got a refusal: ${creation.ok ? '' : creation.refusal}`);
	return creation.seed;
}

suite('ChildThreadLinkage', () => {

	test('a thread that names no parent is top-level at depth 0', () => {
		const top = thread({ workspaceUri: 'file:///w', permissionMode: 'read_only' });
		assert.strictEqual(isChildThread(top), false);
		assert.strictEqual(delegationDepthOf(top), 0);

		// Undefined is the normal case for a thread that has not been read yet, and it
		// must not read as "a child of nobody".
		assert.strictEqual(isChildThread(undefined), false);
		assert.strictEqual(delegationDepthOf(undefined), 0);
	});

	test('the child names the parent thread and the tool call that spawned it', () => {
		const seed = seedOf(childThreadSeedOf(thread(), { toolCallId: 'call-7', alias: 'tester' }));

		assert.strictEqual(seed.parentThreadId, 'parent-thread', 'the linkage points at the parent thread id');
		assert.strictEqual(seed.parentToolCallId, 'call-7');
		assert.strictEqual(seed.alias, 'tester');
		assert.strictEqual(seed.delegationDepth, 1, 'a top-level parent yields a depth-1 child');
	});

	test('a child inherits the parent workspace, grant and frozen instructions verbatim', () => {
		const parent = thread({
			workspaceUri: 'file:///home/me/project',
			workspaceLabel: 'project',
			permissionMode: 'full_access',
			frozenAiInstructions: 'frozen at the parent\'s first send',
		});

		const seed = seedOf(childThreadSeedOf(parent, { toolCallId: 'call-1', alias: 'reviewer' }));

		assert.strictEqual(seed.workspaceUri, 'file:///home/me/project');
		assert.strictEqual(seed.workspaceLabel, 'project');
		assert.strictEqual(seed.permissionMode, 'full_access', 'no narrowing: the child holds the grant its parent holds');
		assert.strictEqual(seed.frozenAiInstructions, 'frozen at the parent\'s first send', 'same system-prompt prefix as the parent');
	});

	test('a narrow parent does not produce a wider child', () => {
		const seed = seedOf(childThreadSeedOf(thread({ permissionMode: 'read_only' }), { toolCallId: 'call-1', alias: 'a' }));
		assert.strictEqual(seed.permissionMode, 'read_only');
	});

	test('a parent with no recorded grant passes the absence through rather than defaulting', () => {
		// Threads persisted before `permissionMode` existed carry no value, and the
		// field normalizes to 'read_only' on read. Copying the absence therefore
		// copies the parent's answer exactly; writing 'read_only' here would be the
		// same answer by luck, and would stop being the same answer the day the
		// default changes. The child must follow the parent, not the default.
		const seed = seedOf(childThreadSeedOf(thread({ permissionMode: undefined }), { toolCallId: 'call-1', alias: 'a' }));
		assert.strictEqual(seed.permissionMode, undefined);
	});

	test('a child that carries no recorded depth is treated as the deepest allowed', () => {
		// Repair, not guesswork: a thread naming a parent is at least depth 1, and 1
		// is both the truth for anything this build writes and the most restrictive
		// reading under the cap.
		assert.strictEqual(delegationDepthOf(thread({ parentThreadId: 'p' })), MAX_DELEGATION_DEPTH);

		// Control: the repair must not fire for a top-level thread that simply has no
		// depth yet, or every new thread would be unable to delegate.
		assert.strictEqual(delegationDepthOf(thread()), 0);
	});

	test('a child cannot spawn a child', () => {
		const child = thread({ id: 'child-thread', parentThreadId: 'parent-thread', delegationDepth: MAX_DELEGATION_DEPTH });

		const creation = childThreadSeedOf(child, { toolCallId: 'call-2', alias: 'grandchild' });

		assert.strictEqual(creation.ok, false, 'depth 2 must be refused');
		assert.ok(!creation.ok && /cannot create subagents/.test(creation.refusal), `the refusal must say why: ${creation.ok ? '' : creation.refusal}`);
	});

	test('a child is told it is a child, and what the delegating agent receives', () => {
		const preamble = subagentPreambleOf('tester');

		// The three facts nothing in the inherited prompt conveys, and whose absence is
		// silent: an agent is reading, it sees only this message, and it is not the user.
		assert.strictEqual(/subagent/i.test(preamble), true, 'the framing must name what the child is');
		assert.strictEqual(preamble.includes('"tester"'), true, 'the framing must name this child');
		assert.strictEqual(/final message/i.test(preamble), true, 'the framing must say what crosses back');
		assert.strictEqual(/cannot see/i.test(preamble), true, 'the framing must say the parent is out of reach');
		// And the remedy, because "report back" without saying what to report is how a child
		// hands over a plan as if it were a result.
		assert.strictEqual(/report/i.test(preamble), true, 'the framing must ask for a report');
	});

	test('an unnamed child is still told what it is', () => {
		// `alias` is optional on the thread type, and a restored child could lack one.
		const preamble = subagentPreambleOf(undefined);
		assert.strictEqual(/subagent/i.test(preamble), true);
		assert.strictEqual(preamble.includes('named'), false, 'an unnamed child must not be given an empty name');
	});

	test('the framing is appended after the inherited instructions, exactly once', () => {
		const combined = withSubagentPreamble('BASE INSTRUCTIONS', 'tester');

		assert.strictEqual(combined.startsWith('BASE INSTRUCTIONS'), true, 'the inherited prompt must stay first');
		assert.strictEqual(combined.split('You are a subagent').length, 2, 'the framing must appear exactly once');
		assert.strictEqual(combined.includes('"tester"'), true);
	});
	test('the report block is what the parent reads, and nothing around it', () => {
		// The contract between a child and its parent, in one function: everything inside the
		// block is passed on, everything outside it is the child thinking.
		const message = `thinking out loud\n${REPORT_OPEN}\nThe answer is 25.\n${REPORT_CLOSE}\nanything else?`;
		assert.strictEqual(reportedSummaryOf(message), 'The answer is 25.');
	});

	test('the last block wins, so a child that corrects itself is heard once', () => {
		const message = `<report>first draft</report>\nmore work\n<report>final answer</report>`;
		assert.strictEqual(reportedSummaryOf(message), 'final answer');
	});

	test('a message without a block is passed on whole rather than dropped', () => {
		// Deliberate: a child that ignored the format still produced something, and refusing it
		// would turn a formatting slip into a delegation that reported nothing.
		assert.strictEqual(reportedSummaryOf('  just an answer  '), 'just an answer');
		// An empty block is not a report either.
		assert.strictEqual(reportedSummaryOf(`<report>   </report>`), `${REPORT_OPEN}   ${REPORT_CLOSE}`);
		// An unclosed block cannot be trusted to end where the child meant it to.
		assert.strictEqual(reportedSummaryOf(`${REPORT_OPEN}\nno close`), `${REPORT_OPEN}\nno close`);
	});

	test('the framing tells the child the format it will be read by', () => {
		// The prompt and the extractor are one contract; a prompt that described a different
		// marker would leave the block unread and the parent with the child's whole message.
		const preamble = subagentPreambleOf('tester');
		assert.strictEqual(preamble.includes(REPORT_OPEN), true, 'the framing never shows the opening delimiter');
		assert.strictEqual(preamble.includes(REPORT_CLOSE), true, 'the framing never shows the closing delimiter');
		assert.strictEqual(/not trimmed/i.test(preamble), true, 'the framing must say the report is not cut');
	});
	test('the alias is trimmed and its internal whitespace collapsed', () => {
		const seed = seedOf(childThreadSeedOf(thread(), { toolCallId: 'call-1', alias: '  release   checker  ' }));
		assert.strictEqual(seed.alias, 'release checker', 'a pasted name still becomes one name');
	});

	test('an empty or over-long alias is refused rather than fixed up', () => {
		const blank = childThreadSeedOf(thread(), { toolCallId: 'call-1', alias: '   ' });
		assert.strictEqual(blank.ok, false, 'an empty alias would make the child unaddressable');

		// Truncation is the tempting repair and the wrong one: two distinct aliases
		// can truncate to the same string, and the parent addresses children by alias.
		const long = childThreadSeedOf(thread(), { toolCallId: 'call-1', alias: 'a'.repeat(ALIAS_MAX_CHARS + 1) });
		assert.strictEqual(long.ok, false, 'over-long aliases are refused, not cut');

		// Control: exactly at the limit is accepted, so the bound is the stated one.
		const atLimit = childThreadSeedOf(thread(), { toolCallId: 'call-1', alias: 'a'.repeat(ALIAS_MAX_CHARS) });
		assert.strictEqual(atLimit.ok, true);
	});
});
