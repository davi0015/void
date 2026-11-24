/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Extracts a command's output from the raw pty stream.
//
// `TerminalCommand.getOutput()` reads the xterm buffer between the executed and
// end markers. The buffer is a display surface, not the process's stdout: the
// slice can begin with the prompt and the echoed command (when the executed
// marker sits on the command line), it is hard-wrapped at the terminal width,
// and it silently loses its head once the scrollback is full. All three corrupt
// what the model reads.
//
// VS Code's shell integration brackets each command with OSC 633 sequences:
// `633;C` immediately before the command runs and `633;D;<code>` after it
// finishes. The bytes between them are the command's output — no prompt, no
// echo, no reflow, no scrollback eviction. This tracker consumes the raw data
// stream and hands each command's output back in completion order.
//
// It is dependency-free so the parsing runs under `npm run test-node`.
//
// The feed comes from `onWillData`, before xterm parses the chunk, because
// command detection reports `D` *during* that parse. Feeding from `onData`
// would leave the tracker one chunk behind at the moment `onCommandFinished`
// runs, so a command whose output and marker arrive together would hand back
// an empty window. `take()` still accepts a partially collected window: that
// is what a timeout needs.

const MARKER = '\x1b]633;'
const BEL = '\x07'

/**
 * Collects the output windows of commands as their raw bytes arrive.
 *
 * The terminal instance fires `onCommandFinished` while it parses the `633;D`
 * sequence, which is before the same bytes reach the `onData` callback. `take()`
 * therefore accepts a still-collecting window as well as a completed one, so it
 * works whichever event arrives first.
 */
export class TerminalCommandOutputTracker {
	/** Bytes not yet classified; may end in a partial marker. */
	private pending = ''
	private collecting = false
	private current = ''
	/** Windows completed but not yet taken, oldest first. */
	private completed: string[] = []

	/** Feeds one raw pty chunk. */
	feed(chunk: string): void {
		this.pending += chunk
		for (;;) {
			const start = this.pending.indexOf(MARKER)
			if (start === -1) {
				this.appendWithoutMarker()
				return
			}
			if (this.collecting) {
				this.current += this.pending.slice(0, start)
			}
			const rest = this.pending.slice(start)
			const end = rest.indexOf(BEL)
			if (end === -1) {
				// An incomplete marker: keep it for the next chunk.
				this.pending = rest
				return
			}
			const payload = rest.slice(MARKER.length, end)
			this.pending = rest.slice(end + 1)
			if (payload === 'C') {
				this.collecting = true
				this.current = ''
			} else if (payload === 'D' || payload.startsWith('D;')) {
				if (this.collecting) {
					this.completed.push(this.current)
					this.collecting = false
					this.current = ''
				}
			}
		}
	}

	/**
	 * The output of the most recently started command, or null when no command
	 * has started since the last take. An empty string means a command ran and
	 * printed nothing.
	 */
	take(): string | null {
		if (this.completed.length > 0) {
			return this.completed.shift()!
		}
		if (this.collecting) {
			const output = this.current
			this.collecting = false
			this.current = ''
			return output
		}
		return null
	}

	private appendWithoutMarker(): void {
		const hold = partialMarkerSuffix(this.pending)
		const body = hold.length === 0 ? this.pending : this.pending.slice(0, -hold.length)
		if (this.collecting) {
			this.current += body
		}
		this.pending = hold
	}
}

/** The longest suffix of `text` that is a prefix of a marker, to be held back. */
function partialMarkerSuffix(text: string): string {
	const longest = Math.min(MARKER.length - 1, text.length)
	for (let length = longest; length > 0; length--) {
		if (text.endsWith(MARKER.slice(0, length))) {
			return text.slice(text.length - length)
		}
	}
	return ''
}
