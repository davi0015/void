/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { writeBufferFully } from '../../node/writeBuffer.js';

suite('platform - writeBuffer', () => {

	test('writes everything when the descriptor accepts it all', () => {
		const buffer = Buffer.from('abcdef');
		let calls = 0;
		let seen: { offset: number; length: number } | undefined;
		writeBufferFully((full, offset, length, cb) => {
			calls++;
			seen = { offset, length };
			cb(null, length);
		}, buffer, (err, written) => {
			strictEqual(err, null);
			strictEqual(written, buffer.length);
		});
		strictEqual(calls, 1);
		deepStrictEqual(seen, { offset: 0, length: buffer.length });
	});

	test('continues after a partial write instead of dropping the rest', () => {
		// The failure this guards: a PTY accepts 5 of 16 bytes and reports `5`,
		// and the caller that treats that as success loses the last 11 — one
		// missing span in the middle of a command, with the bytes written after
		// the short one intact.
		const buffer = Buffer.from('0123456789abcdef');
		const offsets: number[] = [];
		const received: Buffer[] = [];
		writeBufferFully((full, offset, length, cb) => {
			offsets.push(offset);
			const take = Math.min(5, length);
			received.push(Buffer.from(full.subarray(offset, offset + take)));
			cb(null, take);
		}, buffer, (err, written) => {
			strictEqual(err, null);
			strictEqual(written, buffer.length);
		});
		strictEqual(Buffer.concat(received).toString(), '0123456789abcdef');
		deepStrictEqual(offsets, [0, 5, 10, 15]);
	});

	test('reports a failure with the number of bytes already written', () => {
		const buffer = Buffer.from('0123456789');
		writeBufferFully((full, offset, length, cb) => {
			if (offset === 0) {
				cb(null, 4);
				return;
			}
			const err = new Error('would block') as NodeJS.ErrnoException;
			err.code = 'EAGAIN';
			cb(err, 0);
		}, buffer, (err, written) => {
			strictEqual(err?.code, 'EAGAIN');
			strictEqual(written, 4, 'the caller needs the offset to re-queue only the unsent bytes');
		});
	});

	test('a write that accepts nothing is reported as EAGAIN, not success', () => {
		const buffer = Buffer.from('abc');
		let calls = 0;
		writeBufferFully((full, offset, length, cb) => {
			calls++;
			cb(null, 0);
		}, buffer, (err, written) => {
			strictEqual(err?.code, 'EAGAIN');
			strictEqual(written, 0);
		});
		strictEqual(calls, 1, 'a zero-byte write must not spin');
	});

	test('an empty buffer completes without writing', () => {
		let calls = 0;
		writeBufferFully(() => { calls++; }, Buffer.alloc(0), (err, written) => {
			strictEqual(err, null);
			strictEqual(written, 0);
		});
		strictEqual(calls, 0);
	});
});
