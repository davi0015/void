# Terminal Crash Analysis — PTY Host Hang & Leaked Disposables

## 1. PTY Host Hang — `fs.write()` Fix

### Problem

Running multi-line commands through the terminal tool (e.g. `sed`, `python3 -c "..."`) caused the PTY host process to hang permanently, killing ALL terminals in the window (detected by heartbeat timeout: "No ptyHost heartbeat after 6 seconds").

### Root Cause Chain

Diagnosed via `logService.error()` logging inside the PTY host, which flushed on process restart.

1. `sendText` in `terminalInstance.ts:1305` converts `\n` → `\r` — multi-line commands become multiple premature Enter keys
2. The shell receives each `\r` as a separate command submission, generating rapid error output
3. The shell is busy writing error output → not reading stdin → kernel PTY input buffer fills (~4096 bytes on macOS)
4. `unacknowledgedCharCount` grows because acknowledgment is slow (xterm WriteBuffer uses `setTimeout(0)` with 12ms budget, renderer IPC adds latency)
5. By chunk ~16 of 36, the kernel PTY input buffer is full
6. `net.Socket.write()` on the PTY master fd **blocks the JavaScript event loop** on macOS — despite the fd being set to `O_NONBLOCK`, libuv's `uv_write` on macOS PTY fds can block when the kernel's internal PTY buffer is full
7. PTY host event loop is permanently blocked → heartbeat fails → all terminals die

### Why `sed` Crashes But `echo` Doesn't

After `\n` → `\r` conversion:
- A broken `sed` command causes the shell to **execute** each garbled fragment (shell is NOT reading stdin during execution → PTY input buffer fills)
- A broken `echo` with unclosed quotes puts the shell in **continuation mode** (shell IS reading stdin → buffer stays drained)

The key distinction: **execution mode** (shell doesn't read stdin) vs **continuation mode** (shell reads stdin).

This is also why `python3 -c "..."` with multi-line content times out without crashing — the garbled Python produces small error output, so the PTY input buffer never fully fills. The command is garbled and produces wrong output, but doesn't kill the PTY host.

### Diagnostic Approach

Added `logService.error()` calls in the PTY host for `_doWrite`, `input`, `acknowledgeDataEvent`, and `onData`. These calls normally can't escape a blocked event loop:
- Buffered IPC requires the event loop to be running
- `process.stderr` goes nowhere in UtilityProcess
- `console.log/warn` not forwarded to renderer's Dev Tools
- `fs.appendFileSync` unavailable (UtilityProcess has no `fs` access)

But `logService.error()` calls **DO eventually flush** when the PTY host is killed and restarted — the IPC buffer is drained during shutdown. The logs captured the exact moment of the hang:

```
_doWrite BEFORE: chunkLen=50 remaining=15 isPaused=false unack=2158
```

`_doWrite AFTER` never appeared — `this._ptyProcess!.write(object.data)` blocked the event loop and never returned. This happened consistently at `unack ≈ 2043`, `remaining = 15` chunks.

`console.warn()` in the renderer process (terminalProcessManager.ts, terminalInstance.ts) also worked for capturing the command that triggered the crash.

### Fix

Replaced `node-pty`'s `net.Socket.write()` in `_doWrite()` (`terminalProcess.ts`) with `fs.write(fd, buffer, 0, buffer.length, null, callback)`. `fs.write()` runs in the libuv thread pool, so even if the kernel write blocks, the JavaScript event loop stays responsive. The PTY host heartbeat continues, other terminals keep working, and the write eventually completes or returns `EAGAIN` (re-queued with retry).

### Socket Pause/Resume

`node-pty`'s internal `_socket` (a `tty.ReadStream`) uses the same PTY fd for reading. Concurrent access from `fs.write()` and `_socket`'s N-API read callbacks caused `DEP0168` N-API callback exceptions. Fixed by calling `socket.pause()` before `fs.write()` and `socket.resume()` in the callback — prevents concurrent fd access.

### EAGAIN Handling

When `fs.write()` returns `EAGAIN` or `EWOULDBLOCK`, the chunk is re-queued at the front of `_writeQueue` and retried after `WriteInterval = 5ms`. Other errors (EBADF etc.) are dropped silently — the PTY is gone.

### Remaining Issue: Command Garbling

`sendText` still converts `\n` → `\r`, so multi-line commands are still garbled. This fix only prevents the PTY host from hanging — it doesn't fix the command garbling. Bracketed paste mode or a different `sendText` approach would be needed for that.

### Files Modified

- `src/vs/platform/terminal/node/terminalProcess.ts` — `_doWrite()` rewritten

---

## 2. Terminal Leaked Disposable Fixes

### Problem

`[LEAKED DISPOSABLE]` warnings in the console every time a temporary (`hideFromUser`) terminal was created and disposed by the AI agent. Four separate leak sources:

#### Source 1: `TerminalProcessManager._processListeners`

Event subscriptions on `LocalPty` (`onProcessReady`, `onProcessExit`, `onProcessData`, `onDidChangeProperty`, `onProcessReplayComplete`, `onRestoreCommands`) were never disposed when the process manager was disposed. `dispose()` set `_process = null` without cleaning up `_processListeners`.

**Fix**: Added `dispose(this._processListeners)` + `this._processListeners = undefined` at the top of `TerminalProcessManager.dispose()`.

#### Source 2: `LocalPty` itself

`LocalPty` extends `Disposable` with 6 emitters registered via `this._register()`, but `localTerminalBackend.ts` removed it from `_ptys` on process exit via `this._ptys.delete(e.id)` without calling `pty.dispose()`.

**Fix**: Added `pty.dispose()` after `this._ptys.delete(e.id)` in the `onProcessExit` handler of `localTerminalBackend.ts`.

#### Source 3: `_backgroundedTerminalDisposables`

`_backgroundedTerminalDisposables` in `terminalService.ts` stored the `onDisposed` listener disposable for `hideFromUser` terminals, but only `.delete()`d the map entry without `.dispose()`ing the disposables.

**Fix**: Added `dispose(disposables)` before `this._backgroundedTerminalDisposables.delete(e.instanceId)` in the `onDisposed` listener of `terminalService.ts`.

#### Source 4: `SeamlessRelaunchDataFilter`

`_firstDisposable`, `_secondDisposable`, `_dataListener`, and `_swapTimeout` were not cleaned up when the filter was disposed. The class extended `Disposable` but didn't override `dispose()` to clean these plain `IDisposable` properties.

**Fix**: Added `dispose()` override to `SeamlessRelaunchDataFilter` that disposes `_dataListener`, `_firstDisposable`, `_secondDisposable`, and clears `_swapTimeout`.

### Upstream Bug (Not Our Issue)

There are also `[LEAKED DISPOSABLE]` warnings from `DecorationRequestsQueue.enqueue` in `mainThreadDecorations.ts` — these are from VS Code's built-in file decorations service (the colored badges on files in the explorer). The `CancellationToken.onCancellationRequested` subscription creates tracked disposables that get GC'd before their `.finally()` cleanup runs. This is a pre-existing upstream VS Code bug, not related to terminal code.

### Files Modified

- `src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts` — `_processListeners` disposal + `SeamlessRelaunchDataFilter.dispose()` override
- `src/vs/workbench/contrib/terminal/electron-sandbox/localTerminalBackend.ts` — `pty.dispose()` on exit
- `src/vs/workbench/contrib/terminal/browser/terminalService.ts` — `_backgroundedTerminalDisposables` disposal

---

## 3. Architecture Reference

### Terminal Process Hierarchy

```
TerminalInstance (renderer)
  └── TerminalProcessManager (renderer)
        ├── LocalPty (renderer, IPC proxy to PTY host)
        ├── SeamlessRelaunchDataFilter (renderer, data buffering for relaunch)
        └── AckDataBufferer (renderer, batches ack events into 5000-char chunks)
              ↓ IPC (MessagePort)
        PtyHostService (main process, manages PTY host lifecycle)
              ↓ UtilityProcess
        PtyHostMain (PTY host process)
              ├── PtyService (PTY host, manages all terminal processes)
              │     ├── TerminalProcess (PTY host, wraps node-pty)
              │     └── PersistentProcess (PTY host, wraps TerminalProcess + serialization)
              └── HeartbeatService (PTY host, fires beat every 5s)
```

### Key Constants

| Constant | Value | Location |
|---|---|---|
| `HighWatermarkChars` | 100,000 | `terminal.ts` |
| `LowWatermarkChars` | 5,000 | `terminal.ts` |
| `CharCountAckSize` | 5,000 | `terminal.ts` |
| `WriteMaxChunkSize` | 50 bytes | `terminalProcess.ts` |
| `WriteInterval` | 5 ms | `terminalProcess.ts` |
| `BeatInterval` | 5,000 ms | `terminal.ts` |
| `FirstWaitMultiplier` | 1.2 | `terminal.ts` |
| `SecondWaitMultiplier` | 1.0 | `terminal.ts` |
| `DataFlushTimeout` | 250 ms | `terminalProcess.ts` |
| `MaximumShutdownTime` | 5,000 ms | `terminalProcess.ts` |
| PTY input buffer (macOS) | ~4,096 bytes | kernel |

### Data Flow: Write Path

```
LLM agent → terminalToolService.runCommand()
  → TerminalInstance.sendText(text)
      text = text.replace(/\r?\n/g, '\r')  ← TRIGGER for the crash
  → TerminalProcessManager.write(data)
      → _process.input(data)               ← IPC to PTY host
  → PtyService.input(id, data)
      → TerminalProcess.input(data)
          → chunkInput(data)                ← splits into 50-byte chunks
          → _startWrite() / _doWrite()      ← 5ms delay between chunks
              → fs.write(fd, buffer, ..., callback)  ← [VOID FIX] was net.Socket.write()
                  if EAGAIN → re-queue + retry
                  if EBADF → drop silently
```

### Data Flow: Ack Path

```
TerminalProcess.onData(data)
  → _unacknowledgedCharCount += data.length
  → if > HighWatermarkChars → ptyProcess.pause()
  → PersistentProcess._serializer.handleData(data)
  → PtyService → IPC → renderer

Renderer:
  → TerminalProcessManager._onProcessData
  → xterm.raw.write(data, callback)
      callback fires → acknowledgeDataEvent(data.length)
  → AckDataBufferer.ack(charCount)
      → batches into 5000-char chunks
      → _process.acknowledgeDataEvent(charCount)  ← IPC to PTY host
  → TerminalProcess.acknowledgeDataEvent(charCount)
      → _unacknowledgedCharCount -= charCount
      → if < LowWatermarkChars → ptyProcess.resume()
```

### What Blocks and Why

| Component | Can block? | Why |
|---|---|---|
| `net.Socket.write()` on PTY fd | **Yes** (macOS) | libuv's `uv_write` can block when kernel PTY buffer is full, despite `O_NONBLOCK` |
| `fs.write()` on PTY fd | **No** (event loop) | Runs in libuv thread pool; JS event loop stays responsive |
| `ptyProcess.pause()` | No | Only stops reading from `_socket` |
| `xterm.raw.write()` | No | Uses `WriteBuffer` with `setTimeout(0)` |
| Heartbeat `setInterval` | **Indirectly** | Can't fire when event loop is blocked by a synchronous hang |

### Diagnostic Approaches Tried

| Approach | Worked? | Why/why not |
|---|---|---|
| `logService.info/error()` in PTY host (real-time) | No | Buffered IPC requires event loop running |
| `logService.error()` in PTY host (post-crash flush) | **Yes** | IPC buffer drains during PTY host shutdown/restart |
| `console.warn()` in renderer | **Yes** | Renderer stays alive when PTY host hangs |
| `process.stderr.write()` | No | Goes nowhere in UtilityProcess |
| `fs.appendFileSync()` | No | UtilityProcess has no `fs` access |
| Event loop lag monitor (`setTimeout`-based) | No | Monitor itself needs event loop to fire |
| Standalone Node.js reproduction | No | Blocking behavior specific to UtilityProcess |

### Theories Investigated and Rejected

1. **FD write race condition** (VS Code issue #38137) — the 50-byte chunking doesn't fully prevent data corruption, but corruption isn't what causes the hang
2. **`hideFromUser` terminals have `this.xterm === null`** — WRONG, `xterm` IS set for hidden terminals and the WriteBuffer callback fires without DOM attachment
3. **Flow control deadlock** — `ptyProcess.pause()` only stops reading (doesn't affect writes), and `net.Socket.write()` is supposed to be non-blocking
4. **`node-pty`'s `kill()` crashing** — the hang happens before any `dispose()` call
