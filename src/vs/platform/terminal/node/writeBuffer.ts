/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes `buffer` in full, continuing from a partial write.
 *
 * `fs.write` on a PTY descriptor can accept fewer bytes than it was given —
 * the kernel input queue is small, and it fills while the shell is busy with
 * the bytes already delivered — and reports the short count without an error.
 * Treating that count as success silently drops the rest: a terminal command
 * arrives with a hole in the middle, and only the part before the queue filled
 * is missing while everything written after it lands, which reads as random
 * corruption of one span.
 *
 * `write` is passed the buffer, the offset to resume at, and the number of
 * bytes left. On failure the callback receives the error together with the
 * number of bytes already accepted, so the caller can keep the unsent
 * remainder rather than re-sending bytes the kernel already has.
 */
export type BufferWriter = (buffer: Buffer, offset: number, length: number, cb: (err: NodeJS.ErrnoException | null, bytesWritten: number) => void) => void;

export function writeBufferFully(
	write: BufferWriter,
	buffer: Buffer,
	cb: (err: NodeJS.ErrnoException | null, bytesWritten: number) => void,
): void {
	if (buffer.length === 0) {
		cb(null, 0);
		return;
	}

	const step = (offset: number) => {
		write(buffer, offset, buffer.length - offset, (err, bytesWritten) => {
			if (err) {
				cb(err, offset);
				return;
			}
			if (bytesWritten <= 0) {
				// A zero-byte write with no error means the descriptor accepted
				// nothing. Treat it like EAGAIN so the caller keeps the bytes and
				// retries, instead of dropping them because "the write returned".
				const again = new Error('write accepted 0 bytes') as NodeJS.ErrnoException;
				again.code = 'EAGAIN';
				cb(again, offset);
				return;
			}
			const next = offset + bytesWritten;
			if (next >= buffer.length) {
				cb(null, next);
				return;
			}
			step(next);
		});
	};

	step(0);
}
