/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Regression test: pending chat-thread writes must survive quitting immediately.
//
// Bug: _storeThread() does not write, it queues into _pendingThreadWrites and
// schedules a flush 500ms later. The only shutdown flush was registered on
// onWillShutdown, but the workbench registers its own onWillShutdown listener
// during startup (electron-sandbox/desktop.main.ts) which closes storage.
// Storage.close() sets StorageState.Closed synchronously and Storage.set()
// returns early once closed, discarding the value without error. Listeners run
// in registration order and the workbench's listener was registered long before
// the chat service exists, so the flush always ran after storage had closed and
// every write it made was dropped.
//
// Symptom: compact a thread, quit right away, relaunch — the compaction is gone.
// Compact, send a message, then quit — it survives, because the 500ms debounce
// fired in the meantime.
//
//   node test/void/durable-writes-on-quit.mjs
//   node test/void/durable-writes-on-quit.mjs --expect=lost   # demonstrate the bug
//   node test/void/durable-writes-on-quit.mjs --only=rename   # one probe
//
// Requires a compiled build (npm run compile) and a downloaded Electron
// (npm run electron). Drives the real app; does not call any LLM — the
// compaction probe stubs the LLM transport only, so no API key is needed.

import { _electron } from 'playwright'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const RUN_DIR = join(ROOT, '.tmp', 'void-e2e', 'durable-writes')

const args = process.argv.slice(2)
const EXPECT = (args.find((a) => a.startsWith('--expect='))?.split('=')[1] ?? 'present').toLowerCase()
const ONLY = args.find((a) => a.startsWith('--only='))?.split('=')[1]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── environment ─────────────────────────────────────────────────────────

function resolveElectronPath() {
	const product = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./product.json"))'], { cwd: ROOT, encoding: 'utf8' }))
	switch (process.platform) {
		case 'darwin': return join(ROOT, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', 'Electron')
		case 'win32': return join(ROOT, '.build', 'electron', `${product.nameShort}.exe`)
		default: return join(ROOT, '.build', 'electron', product.applicationName)
	}
}

const ELECTRON_PATH = resolveElectronPath()
const OUT_MAIN = join(ROOT, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')

function preflight() {
	const problems = []
	if (!existsSync(OUT_MAIN)) problems.push('no compiled build in out/ — run: npm run compile')
	if (!existsSync(ELECTRON_PATH)) problems.push(`no Electron at ${ELECTRON_PATH} — run: npm run electron`)
	if (problems.length) {
		console.error('Cannot run: \n  - ' + problems.join('\n  - '))
		process.exit(2)
	}
}

// Mirrors test/automation/src/electron.ts, plus --no-sandbox which is required
// for the renderer to start in sandboxed/CI environments (without it the
// renderer aborts before any window appears).
function electronArgs(dirs) {
	const a = [
		ROOT,
		dirs.workspacePath,
		'--skip-release-notes', '--skip-welcome', '--disable-telemetry', '--no-cached-data',
		'--disable-updates', '--use-inmemory-secretstorage',
		`--crash-reporter-directory=${dirs.crashesPath}`,
		'--disable-workspace-trust',
		`--extensions-dir=${dirs.extensionsDir}`,
		`--user-data-dir=${dirs.userDataDir}`,
		`--logsPath=${dirs.logsPath}`,
		'--no-sandbox',
	]
	if (process.platform === 'darwin') a.push('--use-gl=swiftshader')
	if (process.platform === 'linux') a.push('--disable-dev-shm-usage', '--disable-gpu')
	return a
}

function makeDirs(name) {
	const base = join(RUN_DIR, name)
	rmSync(base, { recursive: true, force: true })
	const dirs = {
		userDataDir: join(base, 'user-data'),
		extensionsDir: join(base, 'extensions'),
		logsPath: join(base, 'logs'),
		crashesPath: join(base, 'crashes'),
		workspacePath: join(base, 'workspace'),
	}
	for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
	return dirs
}

async function launch(dirs) {
	const app = await _electron.launch({
		executablePath: ELECTRON_PATH,
		args: electronArgs(dirs),
		env: { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' },
		timeout: 0,
	})
	const page = await app.firstWindow({ timeout: 120000 })
	const log = []
	page.on('console', (m) => {
		const t = m.text()
		if (t.includes('[probe]')) log.push(t)
	})
	// The sidebar registers globalThis.__voidChatThreadService when it mounts.
	// Polled with page.evaluate: the renderer's Trusted Types policy rejects the
	// eval path that page.waitForFunction uses.
	const deadline = Date.now() + 120000
	for (;;) {
		if (await page.evaluate(() => !!globalThis.__voidChatThreadService).catch(() => false)) break
		if (Date.now() > deadline) throw new Error('chat thread service never registered (is the Void sidebar mounting?)')
		await sleep(1000)
	}
	return { app, page, log }
}

// Reads the persisted thread metadata straight out of the application-scope
// database. This is the actual assertion: what reached disk, not what the
// in-memory service believes.
function readPersistedThreadMetadata(userDataDir, threadId) {
	const db = join(userDataDir, 'User', 'globalStorage', 'state.vscdb')
	return execFileSync(
		'sqlite3',
		[`file:${db}?mode=ro`, `select value from ItemTable where key='void.chatThread.${threadId}'`],
		{ encoding: 'utf8' },
	)
}

// ── instrumentation ─────────────────────────────────────────────────────
// Makes the shutdown flush observable after the renderer is gone, and reports
// whether each storage write actually landed. Storage.set() returns early when
// the store is closed, leaving its cache untouched — so comparing the cached
// value around the call proves whether the write was accepted or discarded.
function instrument() {
	const svc = globalThis.__voidChatThreadService
	if (globalThis.__probePatched) return
	globalThis.__probePatched = true
	const t0 = Date.now()
	const ts = () => '+' + String(Date.now() - t0).padStart(6) + 'ms'
	const caller = () => String(new Error().stack).split('\n').slice(1, 4).map((s) => s.trim()).join(' <- ')

	const origFlush = svc._flushPendingThreadWrites.bind(svc)
	svc._flushPendingThreadWrites = () => {
		console.log(`[probe] ${ts()} flush-called threadWrites=${svc._pendingThreadWrites.size}`
			+ ` usageWrites=${svc._pendingUsageWrites.size} messageWrites=${svc._pendingMessageKeyWrites.size} | ${caller()}`)
		return origFlush()
	}

	const origStoreThread = svc._storeThread.bind(svc)
	svc._storeThread = (threadId, thread, updateIndex) => {
		console.log(`[probe] ${ts()} storeThread compactionSummary=${thread?.compactionSummary ? 'yes' : 'no'}`)
		return origStoreThread(threadId, thread, updateIndex)
	}

	const ss = svc._storageService
	const origStore = ss.store.bind(ss)
	ss.store = (key, value, scope, target) => {
		const relevant = String(key).startsWith('void.chatThread')
		const before = relevant ? ss.get(key, scope) : undefined
		const result = origStore(key, value, scope, target)
		if (relevant) {
			console.log(`[probe] ${ts()} store ${String(key).slice(0, 20)}... landed=${ss.get(key, scope) !== before}`)
		}
		return result
	}
}

// ── probes ──────────────────────────────────────────────────────────────

async function runProbe(probe) {
	const dirs = makeDirs(probe.name)
	const { app, page, log } = await launch(dirs)

	let detail
	try {
		await page.evaluate(instrument)
		detail = await page.evaluate(async ({ kind, marker }) => {
			const svc = globalThis.__voidChatThreadService
			const threadId = svc.state.currentThreadId

			if (kind === 'rename') {
				svc.setThreadCustomTitle(threadId, marker)
				return { threadId, result: 'renamed' }
			}

			if (kind === 'synthetic-compaction-write') {
				// Exactly the write compactCurrentThread performs at its end.
				const thread = svc.state.allThreads[threadId]
				const updated = {
					...thread,
					lastModified: new Date().toISOString(),
					compactionSummary: marker,
					compactionBoundaryIdx: 4,
					compactionPercent: 50,
					compactionSavedTokens: 1234,
				}
				svc._storeThread(threadId, updated)
				svc._setState({ allThreads: { ...svc.state.allThreads, [threadId]: updated } })
				return { threadId, result: 'synthetic-write' }
			}

			// Real compaction through the real code path. Only the LLM
			// transport is stubbed, so this needs no API key and no network.
			const settings = svc._settingsService
			if (!settings.state.modelSelectionOfFeature['Chat']) {
				settings.state.modelSelectionOfFeature['Chat'] = { providerName: 'ollama', modelName: 'qwen2.5-coder:7b' }
			}
			svc._populateTestThread(15)
			svc._llmMessageService.sendLLMMessage = (opts) => {
				setTimeout(() => {
					const usage = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requestCount: 1 }
					try { opts.onText?.({ usage }) } catch { /* ignore */ }
					try { opts.onFinalMessage?.({ fullText: marker, usage }) } catch (e) { console.log('[probe] onFinalMessage threw ' + String(e)) }
				}, 0)
				return { cancel: () => { /* nothing to cancel */ } }
			}
			let result
			try {
				result = await svc.compactCurrentThread({ compactPercent: 50, protectTurns: 1, protectMessages: 2 })
			} catch (e) {
				result = 'THREW: ' + String(e)
			}
			const th = svc.state.allThreads[threadId]
			return { threadId, result: String(result), compactionBoundaryIdx: th?.compactionBoundaryIdx, summaryLen: th?.compactionSummary?.length ?? 0 }
		}, { kind: probe.kind, marker: probe.marker })
	} catch (e) {
		detail = { error: String(e) }
	}

	// Freeze the debounce so only the shutdown path can persist these writes.
	// This is what makes the test deterministic instead of racing a 500ms timer.
	if (probe.cancelScheduler) {
		await page.evaluate(() => globalThis.__voidChatThreadService._storeThreadFlushScheduler.cancel())
	}
	const pendingAtClose = await page
		.evaluate(() => globalThis.__voidChatThreadService._pendingThreadWrites.size)
		.catch(() => -1)

	if (probe.waitMs) await sleep(probe.waitMs)

	await app.close().catch(() => { /* the app may already be gone */ })
	await sleep(1500)

	let found = false
	let readError = null
	try {
		found = readPersistedThreadMetadata(dirs.userDataDir, detail.threadId).includes(probe.marker)
	} catch (e) {
		readError = String(e).slice(0, 200)
	}
	return { probe, detail, pendingAtClose, found, readError, log }
}

// rename-fast: the general case, via public API.
// compactwrite-fast: compactive write in isolation, no compaction machinery.
// realcompact-fast: the reported scenario — compact then quit immediately.
// realcompact-control: same, but lets the 500ms debounce fire first. Must
//   always persist; it proves the probe and the compaction path work, so a
//   missing marker in the other probes is attributable to shutdown timing.
const ALL_PROBES = [
	{ name: 'rename-fast', kind: 'rename', marker: 'DURABLE-RENAME', waitMs: 0, cancelScheduler: true },
	{ name: 'compactwrite-fast', kind: 'synthetic-compaction-write', marker: 'DURABLE-COMPACTWRITE', waitMs: 0, cancelScheduler: true },
	{ name: 'realcompact-fast', kind: 'real-compaction', marker: 'DURABLE-REALCOMPACT', waitMs: 0, cancelScheduler: true },
	{ name: 'realcompact-control', kind: 'real-compaction', marker: 'DURABLE-CONTROL', waitMs: 2000, cancelScheduler: false },
]

// ── run ─────────────────────────────────────────────────────────────────

preflight()

const probes = ONLY ? ALL_PROBES.filter((p) => p.name.includes(ONLY)) : ALL_PROBES
if (probes.length === 0) {
	console.error(`No probe matches --only=${ONLY}. Available: ${ALL_PROBES.map((p) => p.name).join(', ')}`)
	process.exit(2)
}

const results = []
for (const probe of probes) {
	process.stdout.write(`\n=== ${probe.name} ===\n`)
	const r = await runProbe(probe)
	results.push(r)
	console.log(`  detail:         ${JSON.stringify(r.detail)}`)
	console.log(`  pendingAtClose: ${r.pendingAtClose}`)
	console.log(`  persisted:      ${r.found}${r.readError ? ` (read error: ${r.readError})` : ''}`)
	for (const line of r.log.slice(-4)) console.log(`  ${line}`)
}

let ok = true
const lines = []

const control = results.find((r) => r.probe.name === 'realcompact-control')
if (!control) {
	lines.push('SKIP control probe (not selected in this run)')
} else if (!control.found) {
	ok = false
	lines.push(`FAIL control probe did not persist — the test harness itself is unsound (detail: ${JSON.stringify(control.detail)})`)
} else {
	lines.push('PASS control probe persisted (compaction path and probe are sound)')
}

for (const r of results.filter((r) => r.probe.name !== 'realcompact-control')) {
	const expectFound = EXPECT === 'present'
	const good = r.found === expectFound
	ok = ok && good
	lines.push(`${good ? 'PASS' : 'FAIL'} ${r.probe.name}: expected ${expectFound ? 'PRESENT' : 'LOST'}, observed ${r.found ? 'PRESENT' : 'LOST'}`)
}

console.log(`\n===== durable-writes-on-quit (expectation: ${EXPECT}) =====`)
for (const l of lines) console.log(l)
console.log(ok ? '\nRESULT: OK' : '\nRESULT: MISMATCH')
process.exit(ok ? 0 : 1)
