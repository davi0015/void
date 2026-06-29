/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_CHARS, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { timeout } from '../../../../base/common/async.js';



export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	listAllTerminals(): { name: string; status: string; lastCommand: string; isVoidTerminal: boolean }[];
	runCommand(command: string, opts:
		| { type: 'persistent', persistentTerminalId: string }
		| { type: 'temporary', cwd: string | null, terminalId: string }
		// | { type: 'apply', terminalId: string }
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string, resolveReason: TerminalResolveReason }> }>;

	focusPersistentTerminal(terminalId: string): Promise<void>
	persistentTerminalExists(terminalId: string): boolean

	readTerminal(terminalId: string): Promise<string>

	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>
	killPersistentTerminal(terminalId: string): Promise<void>

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined
}
export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');



// function isCommandComplete(output: string) {
// 	// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
// 	const completionMatch = output.match(/\]633;D(?:;(\d+))?/)
// 	if (!completionMatch) { return false }
// 	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
// 	return { exitCode: 0 }
// }


export const persistentTerminalNameOfId = (id: string) => {
	if (id === '1') return 'Void Agent'
	return `Void Agent (${id})`
}
export const idOfPersistentTerminalName = (name: string) => {
	if (name === 'Void Agent') return '1'

	const match = name.match(/Void Agent \((\d+)\)/)
	if (!match) return null
	if (Number.isInteger(match[1]) && Number(match[1]) >= 1) return match[1]
	return null
}

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = {}

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		// runs on ALL terminals for simplicity
		const initializeTerminal = (terminal: ITerminalInstance) => {
			// when exit, remove
			const d = terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title)
				if (terminalId !== null && (terminalId in this.persistentTerminalInstanceOfId)) delete this.persistentTerminalInstanceOfId[terminalId]
				d.dispose()
			})
		}


		// initialize any terminals that are already open
		for (const terminal of terminalService.instances) {
			const proposedTerminalId = idOfPersistentTerminalName(terminal.title)
			if (proposedTerminalId) this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal

			initializeTerminal(terminal)
		}

		this._register(
			terminalService.onDidCreateInstance(terminal => { initializeTerminal(terminal) })
		)

	}


	private _getLastCommand(terminal: ITerminalInstance): string {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection)
		if (!cmdCap) return ''
		const lastCmd = cmdCap.commands.at(-1)
		if (!lastCmd?.command) return ''
		const cmd = lastCmd.command
		return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
	}

	private _getTerminalStatus(terminal: ITerminalInstance): string {
		const exitCode = terminal.exitCode
		return exitCode !== undefined
			? `exited (code ${exitCode})`
			: 'running'
	}

	listAllTerminals(): { name: string; status: string; lastCommand: string; isVoidTerminal: boolean }[] {
		return [...this.terminalService.instances].map(terminal => {
				const voidId = idOfPersistentTerminalName(terminal.title)
				const isVoidTerminal = voidId !== null
				return {
					name: isVoidTerminal ? `Void Agent ${voidId === '1' ? '' : `(${voidId})`}`.trim() : terminal.title,
					status: this._getTerminalStatus(terminal),
					lastCommand: this._getLastCommand(terminal),
					isVoidTerminal,
				}
			})
	}

	getValidNewTerminalId(): string {
		// {1 2 3} # size 3, new=4
		// {1 3 4} # size 3, new=2
		// 1 <= newTerminalId <= n + 1
		const n = Object.keys(this.persistentTerminalInstanceOfId).length;
		if (n === 0) return '1'

		for (let i = 1; i <= n + 1; i++) {
			const potentialId = i + '';
			if (!(potentialId in this.persistentTerminalInstanceOfId)) return potentialId;
		}
		throw new Error('This should never be reached by pigeonhole principle');
	}


	private async _createTerminal(props: { cwd: string | null, config: ICreateTerminalOptions['config'], hidden?: boolean }) {
		const { cwd: override_cwd, config, hidden } = props;

		const cwd: URI | string | undefined = (override_cwd ?? undefined) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: config && 'name' in config ? config.name : undefined,
				forceShellIntegration: true,
				hideFromUser: hidden ? true : undefined,
				// Copy any other properties from the provided config
				...config,
			},
			// Skip profile check to ensure the terminal is created quickly
			skipContributedProfileCheck: true,
		};

		const terminal = await this.terminalService.createTerminal(options)

		// // when a new terminal is created, there is an initial command that gets run which is empty, wait for it to end before returning
		// const disposables: IDisposable[] = []
		// const waitForMount = new Promise<void>(res => {
		// 	let data = ''
		// 	const d = terminal.onData(newData => {
		// 		data += newData
		// 		if (isCommandComplete(data)) { res() }
		// 	})
		// 	disposables.push(d)
		// })
		// const waitForTimeout = new Promise<void>(res => { setTimeout(() => { res() }, 5000) })

		// await Promise.any([waitForMount, waitForTimeout,])
		// disposables.forEach(d => d.dispose())

		return terminal

	}

	createPersistentTerminal: ITerminalToolService['createPersistentTerminal'] = async ({ cwd }) => {
		const terminalId = this.getValidNewTerminalId();
		const config = { name: persistentTerminalNameOfId(terminalId), title: persistentTerminalNameOfId(terminalId) }
		const terminal = await this._createTerminal({ cwd, config, })
		this.persistentTerminalInstanceOfId[terminalId] = terminal
		return terminalId
	}

	async killPersistentTerminal(terminalId: string) {
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`);
		terminal.dispose()
		delete this.persistentTerminalInstanceOfId[terminalId]
		return
	}

	persistentTerminalExists(terminalId: string): boolean {
		return terminalId in this.persistentTerminalInstanceOfId
	}


	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.temporaryTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}


	focusPersistentTerminal: ITerminalToolService['focusPersistentTerminal'] = async (terminalId) => {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		this.terminalService.setActiveInstance(terminal)
		await this.terminalService.focusActiveInstance()
	}




	// Reads terminal output starting from a specific line number. Used by
	// runCommand's timeout path to capture only the current command's output
	// instead of the entire scrollback buffer (which includes all previous
	// commands on persistent terminals).
	readTerminalFromLine = async (terminalId: string, fromLine: number): Promise<string> => {
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}

		const buffer = terminal.xterm.raw.buffer.active;
		const endLine = buffer.length;
		const lines: string[] = [];
		for (let i = endLine; i >= fromLine; i--) {
			let line = buffer.getLine(i);
			if (!line) continue;
			let lineData = line.translateToString(true);
			let lineIndex = i;
			while (lineIndex > fromLine && line.isWrapped) {
				line = buffer.getLine(--lineIndex);
				if (!line) break;
				lineData = line.translateToString(false) + lineData;
			}
			lines.unshift(lineData);
			i = lineIndex;
		}

		let result = removeAnsiEscapeCodes(lines.join('\n'));
		// Trim trailing empty lines — the xterm buffer includes blank lines below
		// the cursor, which create large gaps between the output and the
		// timeout message in the stringifier.
		result = result.replace(/\n+$/, '');
		if (result.length > MAX_TERMINAL_CHARS) {
			const half = MAX_TERMINAL_CHARS / 2;
			result = result.slice(0, half) + '\n...\n' + result.slice(result.length - half);
		}
		return result;
	};

	readTerminal: ITerminalToolService['readTerminal'] = async (terminalId) => {
		// Try persistent first, then temporary
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}

		// Ensure the xterm.js instance has been created – otherwise we cannot access the buffer.
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}

		// Collect lines from the buffer iterator (oldest to newest)
		const lines: string[] = [];
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}

		let result = removeAnsiEscapeCodes(lines.join('\n'));

		if (result.length > MAX_TERMINAL_CHARS) {
			const half = MAX_TERMINAL_CHARS / 2;
			result = result.slice(0, half) + '\n...\n' + result.slice(result.length - half);
		}

		return result
	};

	private async _waitForCommandDetectionCapability(terminal: ITerminalInstance) {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) return cmdCap

		const disposables: IDisposable[] = []

		const waitTimeout = timeout(10_000)
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>((res) => {
			disposables.push(
				terminal.capabilities.onDidAddCapability((e) => {
					if (e.id === TerminalCapability.CommandDetection) res(e.capability)
				})
			)
		})

		const capability = await Promise.any([waitTimeout, waitForCapability])
			.finally(() => { disposables.forEach((d) => d.dispose()) })

		return capability ?? undefined
	}

	runCommand: ITerminalToolService['runCommand'] = async (command, params) => {
		await this.terminalService.whenConnected;

		const { type } = params
		const isPersistent = type === 'persistent'

		let terminal: ITerminalInstance
		const disposables: IDisposable[] = []

		if (isPersistent) { // BG process
			const { persistentTerminalId } = params
			terminal = this.persistentTerminalInstanceOfId[persistentTerminalId];
			if (!terminal) throw new Error(`Unexpected internal error: Terminal with ID ${persistentTerminalId} did not exist.`);
		}
		else {
			const { cwd } = params
			terminal = await this._createTerminal({ cwd: cwd, config: undefined, hidden: true })
			this.temporaryTerminalInstanceOfId[params.terminalId] = terminal
		}

		const interrupt = () => {
			terminal.dispose()
			if (!isPersistent)
				delete this.temporaryTerminalInstanceOfId[params.terminalId]
			else
				delete this.persistentTerminalInstanceOfId[params.persistentTerminalId]
		}

		const waitForResult = async () => {
			try {
				if (isPersistent) {
					// focus the terminal about to run
					this.terminalService.setActiveInstance(terminal)
					await this.terminalService.focusActiveInstance()
				}
				let result: string = ''
				let resolveReason: TerminalResolveReason | undefined


				const cmdCap = await this._waitForCommandDetectionCapability(terminal)
				// if (!cmdCap) throw new Error(`There was an error using the terminal: CommandDetection capability did not mount yet. Please try again in a few seconds or report this to the Void team.`)

				// Register a marker before sending the command. It tracks its line
				// through buffer scrolls so we can read only this command's output on
				// timeout (not the entire scrollback).
				const startMarker = terminal.xterm?.raw.registerMarker(0)
				if (startMarker) disposables.push(startMarker)

				// Track whether we've sent our command yet. The listener is attached
				// before sendText, so any onCommandFinished that fires before we set
				// this flag is from a previous command and should be ignored.
				let commandSent = false

				// Prefer the structured command-detection capability when available

				const waitUntilDone = new Promise<void>(resolve => {
					if (!cmdCap) return
					const l = cmdCap.onCommandFinished(cmd => {
						if (resolveReason?.type === 'done') return // already resolved with structured output
						if (!commandSent) return // stale command from before we sent ours
						resolveReason = { type: 'done', exitCode: cmd.exitCode ?? 0 };
						result = cmd.getOutput() ?? ''
						l.dispose()
						resolve()
					})
					disposables.push(l)
				})


				// send the command now that listeners are attached
				await terminal.sendText(command, true)
				commandSent = true

				const waitUntilInterrupt =
					// Inactivity-based timeout for both persistent and temporary terminals.
					// When a command finishes it produces output (resetting the timer), then
					// onCommandFinished fires and returns structured output before the
					// inactivity timeout can fire. Persistent terminals also get a backstop
					// timeout so long-running processes still return.
					new Promise<void>(res => {
						let inactivityTimeoutId: ReturnType<typeof setTimeout>;
						let backstopTimeoutId: ReturnType<typeof setTimeout>;
						const inactivityMs = (isPersistent ? MAX_TERMINAL_BG_COMMAND_TIME : MAX_TERMINAL_INACTIVE_TIME) * 1000;
						const backstopMs = isPersistent ? MAX_TERMINAL_BG_COMMAND_TIME * 1000 * 2 : Infinity;

						const fire = () => {
							if (resolveReason) return
							clearTimeout(inactivityTimeoutId);
							clearTimeout(backstopTimeoutId);
							resolveReason = { type: 'timeout' };
							res();
						};
						const resetInactivity = () => {
							clearTimeout(inactivityTimeoutId);
							inactivityTimeoutId = setTimeout(fire, inactivityMs);
						};

						const dTimeout = terminal.onData(() => { resetInactivity(); });
						disposables.push(dTimeout, toDisposable(() => { clearTimeout(inactivityTimeoutId); clearTimeout(backstopTimeoutId); }));
						resetInactivity();
						if (isPersistent) {
							backstopTimeoutId = setTimeout(fire, backstopMs);
						}
					})

				// wait for result
				await Promise.any([waitUntilDone, waitUntilInterrupt])



				// read result if timed out, since we didn't get it (could clean this code up but it's ok)
					if (resolveReason?.type === 'timeout') {
					// Grace period — onCommandFinished may fire just after the inactivity
					// timeout. Listener is still alive (disposed after this block).
					if (cmdCap) {
						for (let i = 0; i < 10; i++) {
							if (result) break
							await timeout(100)
						}
					}
					if (!result) {
						const terminalId = isPersistent ? params.persistentTerminalId : params.terminalId
						const fromLine = startMarker?.line ?? 0
						result = await this.readTerminalFromLine(terminalId, fromLine)
					}
				}

				// Dispose all listeners now that we have the result
				disposables.forEach(d => d.dispose())

				if (!resolveReason) throw new Error('Unexpected internal error: Promise.any should have resolved with a reason.')

				if (!isPersistent) result = `$ ${command}\n${result}`
				result = removeAnsiEscapeCodes(result)
				// trim
				if (result.length > MAX_TERMINAL_CHARS) {
					const half = MAX_TERMINAL_CHARS / 2
					result = result.slice(0, half)
						+ '\n...\n'
						+ result.slice(result.length - half, Infinity)
				}

				return { result, resolveReason }
			} finally {
				// Always dispose temporary terminals, even if an error was thrown
				if (!isPersistent) {
					interrupt()
				}
			}
		}
		const resPromise = waitForResult()

		return {
			interrupt,
			resPromise,
		}
	}


}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
