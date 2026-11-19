/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { compactRecords, decodeLog, encodeRecord, foldRecords, LogRecord, threadMessageLogFile, truncateFrom } from '../threadLog.js';

// The arithmetic of the message log: one line per record, fold by index, and a
// truncation that cannot lose a superseded message.
//
// Two cases get the attention, because both look correct in a naive implementation:
// a record for an index *below* the cut that sits after the cut in file order (a
// `ftruncate` at the first `i >= K` silently reverts that message), and a gap in the
// indices, which must be visible to the caller rather than quietly repacked — repacking
// is the renumbering the format exists to remove.

type Msg = { role: string; content: string }

const rec = (i: number, id: string): LogRecord<Msg> => ({ i, m: { role: 'user', content: id } })
const ids = (records: readonly LogRecord<Msg>[]) => records.map(r => r.m.content)

suite('ThreadLog', () => {

	test('a record is one line even when the message holds newlines', () => {
		// JSON.stringify escapes the newline, so the line discipline holds without a
		// second escaping pass — the property the whole format rests on.
		const text = encodeRecord<Msg>({ i: 0, m: { role: 'user', content: 'first\nsecond' } });
		assert.strictEqual(text.split('\n').length, 2, 'one record plus the empty tail from the terminator');
		assert.ok(text.endsWith('\n'), 'every record is terminated');

		const decoded = decodeLog<Msg>(text);
		assert.strictEqual(decoded.malformedLines, 0);
		assert.strictEqual(decoded.tornTail, false);
		assert.deepStrictEqual(decoded.records, [{ i: 0, m: { role: 'user', content: 'first\nsecond' } }]);
	});

	test('the last record for an index wins', () => {
		// A parallel tool batch appends placeholders and then supersedes them, so
		// duplicates are the expected shape rather than a defect.
		const folded = foldRecords([rec(0, 'a'), rec(1, 'b'), rec(0, 'a2')]);

		assert.deepStrictEqual(folded.messages, [{ role: 'user', content: 'a2' }, { role: 'user', content: 'b' }]);
		assert.deepStrictEqual(folded.indices, [0, 1]);
		assert.strictEqual(folded.duplicateCount, 1);
		assert.deepStrictEqual(folded.gapIndices, []);
	});

	test('truncation keeps a supersede that sits after the cut', () => {
		// File order: 0 a, 1 b, 2 c, 1 b2. Truncating at 2 must keep b2, not b.
		// A byte cut at the first record with i >= 2 would keep b and drop b2, which
		// reverts message 1 to a state it had before the supersede.
		const records = [rec(0, 'a'), rec(1, 'b'), rec(2, 'c'), rec(1, 'b2')];

		assert.deepStrictEqual(ids(truncateFrom(records, 2)), ['a', 'b2']);
		assert.deepStrictEqual(ids(truncateFrom(records, 1)), ['a']);
		assert.deepStrictEqual(truncateFrom(records, 0), []);
	});

	test('compaction drops duplicates and keeps ascending order', () => {
		const records = [rec(0, 'a'), rec(1, 'b'), rec(0, 'a2')];

		assert.deepStrictEqual(ids(compactRecords(records)), ['a2', 'b']);
		// Compaction is the same rewrite as truncation at the end, so the two cannot
		// disagree about what the file means.
		assert.deepStrictEqual(compactRecords(records), truncateFrom(records, Number.POSITIVE_INFINITY));
	});

	test('a gap is reported, not closed', () => {
		// Index 1 is missing. The fold must not present c as the second message:
		// the caller decides, and the load path treats this as a corrupt log.
		const folded = foldRecords([rec(0, 'a'), rec(2, 'c')]);

		assert.deepStrictEqual(folded.indices, [0, 2]);
		assert.deepStrictEqual(folded.messages, [{ role: 'user', content: 'a' }, { role: 'user', content: 'c' }]);
		assert.deepStrictEqual(folded.gapIndices, [1], 'position 1 in the array is index 2, and the gap says so');
	});

	test('a leading gap is reported too', () => {
		assert.deepStrictEqual(foldRecords([rec(3, 'd')]).gapIndices, [0, 1, 2]);
	});

	test('a torn final line is dropped and named', () => {
		const text = '{"i":0,"m":{"role":"user","content":"a"}}\n{"i":1,"m":{"role":"us';

		const decoded = decodeLog<Msg>(text);
		assert.deepStrictEqual(ids(decoded.records), ['a'], 'the complete record survives');
		assert.strictEqual(decoded.malformedLines, 1);
		assert.strictEqual(decoded.tornTail, true);

		// A complete record that merely lacks its terminator is not torn: the record
		// is intact, and the writer repairs the missing newline before appending.
		const unterminated = decodeLog<Msg>('{"i":0,"m":{"role":"user","content":"a"}}');
		assert.strictEqual(unterminated.records.length, 1);
		assert.strictEqual(unterminated.tornTail, false);
	});

	test('a malformed line in the middle is skipped, not fatal', () => {
		const text = '{"i":0,"m":{"role":"user","content":"a"}}\nnot json\n{"i":2,"m":{"role":"user","content":"c"}}\n';

		const decoded = decodeLog<Msg>(text);
		assert.deepStrictEqual(ids(decoded.records), ['a', 'c']);
		assert.strictEqual(decoded.malformedLines, 1);
		assert.strictEqual(decoded.tornTail, false, 'the file ends in a newline, so nothing is half-written');
		assert.deepStrictEqual(foldRecords(decoded.records).gapIndices, [1], 'the loss is visible as a gap');
	});

	test('blank lines are not records', () => {
		const decoded = decodeLog<Msg>('\n\n');
		assert.strictEqual(decoded.records.length, 0);
		assert.strictEqual(decoded.malformedLines, 0);
		assert.strictEqual(decoded.tornTail, false);
	});

	test('an index that is not a non-negative integer is refused at encode time', () => {
		assert.throws(() => encodeRecord(rec(-1, 'a')), /invalid index/);
		assert.throws(() => encodeRecord(rec(1.5, 'a')), /invalid index/);
		assert.throws(() => encodeRecord<undefined>({ i: 0, m: undefined }), /no message/);
	});

	test('the log sits inside the thread\'s store directory', () => {
		const threadDir = URI.file('/home/me/globalStorage/void/threads/t1');
		assert.strictEqual(threadMessageLogFile(threadDir).path, `${threadDir.path}/messages.jsonl`);
	});
});
