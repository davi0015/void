/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Shared harness for Void end-to-end tests.
//
// These tests drive the real application (Electron under Playwright) and assert
// against what actually reached disk. They exist for behaviour that only shows up
// in a running workbench: service wiring, the storage layer, lifecycle/shutdown
// ordering, and anything that spans a quit or a reload.
//
// Not every test belongs here. See test/void/README.md for where tests go.
//
// Test files import from this module; nothing here is a test itself.

import { _electron } from 'playwright'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..')
export const PROFILES_DIR = join(ROOT, '.tmp', 'void-e2e')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── environment ─────────────────────────────────────────────────────────

const TEST_ELECTRON_DIR = join(ROOT, '.tmp', 'void-e2e-electron')
const TEST_ELECTRON_APP = join(TEST_ELECTRON_DIR, 'ElectronTest.app')

/**
 * A copy of Electron's bundle that macOS never gives a Dock tile to.
 *
 * `app.dock.hide()` is too late to stop the tile appearing: it is on screen for
 * the moment between launch and the call, and this tier launches about thirty
 * processes, so the developer watches the icon arrive and leave thirty times.
 *
 * `LSUIElement` is a property of the bundle, read before the app starts. An
 * accessory application has no Dock tile and is never activated — which also
 * means nothing can take focus, without anything having to catch it at run time.
 *
 * A distinct `CFBundleIdentifier` keeps it a separate application from the
 * developer's own instance, which is the other half of not disturbing them.
 *
 * The copy is made once and reused, refreshed when Electron's bundle is newer.
 * `cp -c` clones it on APFS, so it costs no disk and no measurable time.
 */
function darwinTestElectronPath() {
	const source = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')
	const sourcePlist = join(source, 'Contents', 'Info.plist')
	const targetPlist = join(TEST_ELECTRON_APP, 'Contents', 'Info.plist')
	const stale = !existsSync(targetPlist) || statSync(sourcePlist).mtimeMs > statSync(targetPlist).mtimeMs
	if (stale) {
		rmSync(TEST_ELECTRON_APP, { recursive: true, force: true })
		mkdirSync(TEST_ELECTRON_DIR, { recursive: true })
		execFileSync('cp', ['-Rc', source, TEST_ELECTRON_APP], { stdio: 'ignore' })
		const plist = (command) => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, targetPlist], { stdio: 'ignore' })
		try { plist('Set :LSUIElement bool true') } catch { plist('Add :LSUIElement bool true') }
		plist('Set :CFBundleIdentifier com.voideditor.void-e2e')
	}
	return join(TEST_ELECTRON_APP, 'Contents', 'MacOS', 'Electron')
}

function resolveElectronPath() {
	const product = JSON.parse(
		execFileSync('node', ['-p', 'JSON.stringify(require("./product.json"))'], { cwd: ROOT, encoding: 'utf8' }),
	)
	switch (process.platform) {
		// Not `.build/electron/<nameLong>.app`, which carries the same bundle
		// identifier as the app a developer runs from `./scripts/code.sh`: macOS
		// treats one identifier as one application, so launching a test instance
		// activated *their* instance and pulled their window forward. No amount of
		// `setFocusable(false)` inside the test process could prevent that, because
		// the window coming forward belonged to a different process — which is why
		// every measurement taken from inside the test app said the window never
		// took focus while the developer watched it happen.
		case 'darwin': return darwinTestElectronPath()
		case 'win32': return join(ROOT, '.build', 'electron', `${product.nameShort}.exe`)
		default: return join(ROOT, '.build', 'electron', product.applicationName)
	}
}

export const ELECTRON_PATH = resolveElectronPath()
const OUT_MAIN = join(ROOT, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')

/** Fails fast with actionable messages when the app cannot be launched. */
export function preflight() {
	const problems = []
	if (!existsSync(OUT_MAIN)) problems.push('no compiled build in out/ — run: npm run compile')
	if (!existsSync(ELECTRON_PATH)) problems.push(`no Electron at ${ELECTRON_PATH} — run: npm ci`)
	if (problems.length) {
		throw new Error('Cannot run Void end-to-end tests:\n  - ' + problems.join('\n  - '))
	}
}

// Mirrors test/automation/src/electron.ts, plus --no-sandbox: without it the
// renderer aborts before any window appears in sandboxed/CI environments.
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
	if (process.platform === 'darwin') {
		a.push(
			'--use-gl=swiftshader',
			// The window is hidden on this platform (see stopStealingFocus), and a
			// hidden renderer is backgrounded: timers get clamped and rAF stops.
			// Several scenarios here depend on timers and on storage work settling,
			// so the renderer has to keep running as if it were on screen.
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
		)
	}
	if (process.platform === 'linux') a.push('--disable-dev-shm-usage', '--disable-gpu')
	return a
}

/**
 * Creates a throwaway profile. Passing the returned dirs to launchVoid() again
 * after a quit is how you test across a restart.
 */
export function createProfile(name, { fresh = true } = {}) {
	const base = join(PROFILES_DIR, name)
	if (fresh) rmSync(base, { recursive: true, force: true })
	const dirs = {
		base,
		userDataDir: join(base, 'user-data'),
		extensionsDir: join(base, 'extensions'),
		logsPath: join(base, 'logs'),
		crashesPath: join(base, 'crashes'),
		workspacePath: join(base, 'workspace'),
	}
	for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
	return dirs
}

// ── launching ───────────────────────────────────────────────────────────

/**
 * Keeps the suite out of the way of whoever is running it.
 *
 * macOS activates every app it launches, and this tier starts one app per
 * scenario — two for the restart ones, and seven files at once because node:test
 * runs them in parallel — so a full run used to put about thirty windows in front
 * of whatever the developer was doing, inside ninety seconds.
 *
 * By default the window is made invisible, unfocusable and click-through. None of
 * that is a progress view — the tests assert on storage, so all a window shows is
 * a landing page for the second before that scenario moves on. Use the terminal
 * output for what is running.
 *
 * `VOID_SHOW_TEST_WINDOWS=1` is for when a test fails and you want to look at the
 * app: the window is left completely alone, so it is a normal window you can drag
 * and click in. It will take focus, because that is what a window you can interact
 * with does — this mode is for looking, not for running the suite while you work.
 *
 * The quiet properties have to be applied at creation. Main-process control
 * arrives about 6 ms after launch, before the app has made a window, and that is
 * the only moment early enough. Reacting is too late: hiding on the window's
 * `show` event leaves the developer having watched a frame, because macOS has
 * composited it by the time the handler runs. An earlier version did exactly that
 * and looked correct by every measurement while still flickering on screen.
 *
 * The window stays *shown* either way, never hidden. A hidden renderer is
 * backgrounded, and VS Code force-shows and opens DevTools on a window that is
 * still not visible ten seconds in, reading it as a failed launch
 * (`windowImpl.ts`).
 *
 * The Dock tile is not handled here at all — it comes from the bundle, which is
 * an accessory application (`darwinTestElectronPath`). `app.dock.hide()` was too
 * late to stop the icon appearing, thirty times a run.
 *
 * Best effort throughout: a convenience for the developer running the suite must
 * never be the reason a test fails.
 */
async function stopStealingFocus(app) {
	if (process.platform !== 'darwin') return
	const visible = process.env.VOID_SHOW_TEST_WINDOWS === '1'
	// The first evaluate can land before the main process has a usable context and
	// throw "Execution context was destroyed". A single attempt therefore
	// sometimes does nothing at all, silently — and a launch that skips this is a
	// launch whose window appears. Retried, and reported, because a quiet failure
	// here is exactly the bug this function exists to prevent.
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await app.evaluate(({ app: electronApp, BrowserWindow }, visible) => {
				const configure = (window) => {
					if (visible) {
						// A normal window — draggable, clickable, focusable — that is
						// simply not made *key* by the app. VS Code calls `win.focus()`
						// from several places while restoring state, and `show()`
						// activates the window, so both are neutralised: the window is
						// displayed with `showInactive()`, and focus is left where it
						// was. Clicking the window still focuses it, because that goes
						// through the window server rather than through this call.
						try {
							window.show = () => { try { window.showInactive() } catch { /* ignore */ } }
							window.focus = () => { /* not made key; click it to focus */ }
						} catch { /* already destroyed */ }
						return
					}
					// Applied at creation, which is what makes it work: reacting to
					// the window being shown is too late, because macOS has already
					// drawn a frame by the time a handler runs.
					try {
						window.setFocusable(false)
						window.setOpacity(0)
						// A transparent window still receives clicks, and this one
						// covers the screen — without this it would swallow them,
						// and swallowing a click counts as taking focus.
						window.setIgnoreMouseEvents(true)
					} catch { /* already destroyed */ }
				}

				electronApp.on('browser-window-created', (_event, window) => configure(window))
				for (const window of BrowserWindow.getAllWindows()) configure(window)
			}, visible)
			return true
		} catch {
			await sleep(20)
		}
	}
	console.error('[harness] could not quiet the app window — it may appear on screen')
	return false
}

/**
 * Launches the app against a profile and waits until the chat service is
 * reachable. Returns a session whose read* helpers are bound to this profile,
 * so assertions read the same storage the app just wrote.
 */
export async function launchVoid(dirs, { readyTimeoutMs = 120000 } = {}) {
	const app = await _electron.launch({
		executablePath: ELECTRON_PATH,
		args: electronArgs(dirs),
		env: { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' },
		timeout: 0,
	})
	// Before the app creates its window, which is the only moment early enough.
	await stopStealingFocus(app)
	const page = await app.firstWindow({ timeout: readyTimeoutMs })

	// Lines the tests mark with [probe] are kept: they survive the renderer's
	// death, which is what makes shutdown behaviour observable at all.
	const log = []
	page.on('console', (m) => {
		const t = m.text()
		if (t.includes('[probe]')) log.push(t)
	})

	const session = {
		dirs,
		app,
		page,
		log,
		readKey: (key) => readAppKey(dirs, key),
		readThread: (threadId) => readThreadMetadata(dirs, threadId),
		listKeys: (pattern) => listAppKeys(dirs, pattern),
		/** Graceful quit: runs the workbench's shutdown sequence. */
		async close() {
			await app.close().catch(() => { /* may already be gone */ })
			await sleep(1500)
		},
		/** Hard kill: no shutdown handlers run at all. */
		async kill() {
			app.process()?.kill('SIGKILL')
			await sleep(1500)
		},
	}

	await waitForChatService(page, readyTimeoutMs)
	return session
}

/**
 * Runs fn against a freshly launched app and always tears the app down.
 * Use launchVoid() directly when a test needs more than one session per profile.
 */
export async function withScenario(name, fn, { fresh = true } = {}) {
	preflight()
	const dirs = createProfile(name, { fresh })
	const session = await launchVoid(dirs)
	try {
		return await fn(session)
	} finally {
		await session.close()
	}
}

/**
 * The sidebar registers globalThis.__voidChatThreadService when it mounts.
 * Polled with page.evaluate because the renderer's Trusted Types policy rejects
 * the eval path that page.waitForFunction uses.
 */
export async function waitForChatService(page, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (await page.evaluate(() => !!globalThis.__voidChatThreadService).catch(() => false)) return
		if (Date.now() > deadline) throw new Error('chat thread service never registered (is the Void sidebar mounting?)')
		await sleep(1000)
	}
}

// ── reading the application store ───────────────────────────────────────
// state.vscdb is the application-scope key/value database. Reading it directly
// means a test asserts on what was persisted, not on what a service believes.

// sqlite3 is spawned with an explicit maxBuffer. Node's default is 1 MB, and one
// row here is a whole thread — messages, tool results, cached codespan links — so
// the largest values in a real profile pass it: a thread in the profile this was
// built against held 4.5 MB of metadata, and that is the thread worth verifying
// against, since the biggest one held 61% of everything reclaimable. Without the
// limit raised, reading it fails with a bare `spawnSync sqlite3 ENOBUFS`, which
// says nothing about storage and reads as a broken test rather than a broken
// harness. Bounded rather than unlimited: a runaway query should still fail.
const MAX_SQLITE_OUTPUT_BYTES = 256 * 1024 * 1024

function query(userDataDir, sql) {
	const db = join(userDataDir, 'User', 'globalStorage', 'state.vscdb')
	if (!existsSync(db)) return []
	const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, sql], { encoding: 'utf8', maxBuffer: MAX_SQLITE_OUTPUT_BYTES })
	return out.split('\n').filter((l) => l.length > 0)
}

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`

/** Value of one storage key, or undefined when absent. */
export function readAppKey(dirs, key) {
	return query(dirs.userDataDir, `select value from ItemTable where key=${sqlLiteral(key)}`)[0]
}

/** All keys matching a SQL LIKE pattern, e.g. 'void.chatMsg.%'. */
export function listAppKeys(dirs, pattern) {
	return query(dirs.userDataDir, `select key from ItemTable where key like ${sqlLiteral(pattern)}`)
}

/** Persisted metadata for a thread (void.chatThread.<id>). */
export function readThreadMetadata(dirs, threadId) {
	return readAppKey(dirs, `void.chatThread.${threadId}`)
}

// ── in-page instrumentation ─────────────────────────────────────────────

/**
 * Makes thread storage activity observable through console lines, including a
 * `landed` flag per write. Storage.set() returns early when the store is closed,
 * leaving its cache untouched, so comparing the cached value around the call
 * proves whether a write was accepted or silently discarded.
 */
export function instrumentThreadStorage(page) {
	return page.evaluate(() => {
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
	})
}

/**
 * Cancels the 500ms write-coalescing timer. Without this a test races that
 * timer: if it fires first the write is persisted no matter what shutdown does.
 * Cancelling it makes "did shutdown persist this?" a deterministic question.
 */
export function cancelFlushScheduler(page) {
	return page.evaluate(() => globalThis.__voidChatThreadService._storeThreadFlushScheduler.cancel())
}

/** Number of thread writes still queued but not yet persisted. */
export function pendingThreadWrites(page) {
	return page.evaluate(() => globalThis.__voidChatThreadService._pendingThreadWrites.size)
}

/**
 * Replaces the LLM transport so the real agent/compaction code paths can run
 * without a network, an API key, or a model selection. Only the transport is
 * faked: everything above it is production code.
 */
export function stubLLM(page, text, { usage } = {}) {
	return page.evaluate(({ text, usage }) => {
		// Every outgoing request is recorded so a test can assert on what the
		// model was actually sent — the only way to check prompt construction
		// (system message, compaction summary, history) without a provider.
		const g = globalThis
		g.__voidLLMRequests = []
		g.__voidChatThreadService._llmMessageService.sendLLMMessage = (opts) => {
			try { g.__voidLLMRequests.push(opts) } catch { /* ignore */ }
			setTimeout(() => {
				const u = usage ?? { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, requestCount: 1 }
				try { opts.onText?.({ usage: u }) } catch { /* ignore */ }
				try { opts.onFinalMessage?.({ fullText: text, usage: u }) } catch (e) { console.log('[probe] onFinalMessage threw ' + String(e)) }
			}, 0)
			return { cancel: () => { /* nothing to cancel */ } }
		}
	}, { text, usage })
}

/**
 * Everything stubLLM was asked to send, as a JSON string. Serialized rather than
 * returned structurally so assertions do not depend on the provider-specific
 * message shape, which differs per provider.
 */
export function capturedLLMRequests(page) {
	return page.evaluate(() => JSON.stringify(globalThis.__voidLLMRequests ?? []))
}

/** How many requests stubLLM has been asked to send so far. */
export function capturedLLMRequestCount(page) {
	return page.evaluate(() => (globalThis.__voidLLMRequests ?? []).length)
}

/** Fills the current thread with synthetic messages via the dev hook. */
export function seedTestThread(page, turns = 15) {
	return page.evaluate((t) => globalThis.__voidChatThreadService._populateTestThread(t), turns)
}

/** Ensures a model selection exists so features gated on one are reachable. */
export function ensureModelSelection(page) {
	return page.evaluate(() => {
		const settings = globalThis.__voidChatThreadService._settingsService
		if (!settings.state.modelSelectionOfFeature['Chat']) {
			settings.state.modelSelectionOfFeature['Chat'] = { providerName: 'ollama', modelName: 'qwen2.5-coder:7b' }
		}
	})
}

// ── expectations ────────────────────────────────────────────────────────
// VOID_EXPECT=lost runs the same assertions inverted. That is how a fix is
// demonstrated: the suite must fail against unmodified code and pass after.

export function expectedPersistence() {
	const raw = (process.env.VOID_EXPECT ?? 'present').toLowerCase()
	assert.ok(['present', 'lost'].includes(raw), `VOID_EXPECT must be 'present' or 'lost', got '${raw}'`)
	return raw === 'present'
}

/**
 * Asserts a marker's persistence.
 *   subject: true  — a write expected to be affected by the behaviour under test,
 *                    so it follows VOID_EXPECT.
 *   subject: false — a control that must always persist; if it does not, the
 *                    test itself is unsound and the failure says so.
 */
export function assertPersistence(label, persisted, { subject = false } = {}) {
	if (!subject) {
		assert.equal(persisted, true, `control check '${label}' did not persist — the test harness is unsound, not the behaviour under test`)
		return
	}
	const wanted = expectedPersistence()
	assert.equal(
		persisted,
		wanted,
		`${label}: expected ${wanted ? 'persisted' : 'lost'} (VOID_EXPECT=${process.env.VOID_EXPECT ?? 'present'}), observed ${persisted ? 'persisted' : 'lost'}`,
	)
}

/**
 * Asserts a field is kept out of persisted state — the mirror of
 * assertPersistence, for changes whose subject is a removal.
 *   subject: true  — follows VOID_EXPECT. With VOID_EXPECT=lost the assertion
 *                    inverts, so unpatched code (which still persists the
 *                    field) passes and the fix is what makes it fail.
 *   subject: false — a control that must always be absent.
 */
export function assertAbsent(label, absent, { subject = false } = {}) {
	if (!subject) {
		assert.equal(absent, true, `control check '${label}' was not absent — the test harness is unsound, not the behaviour under test`)
		return
	}
	const wanted = expectedPersistence()
	assert.equal(
		absent, wanted,
		`${label}: expected ${wanted ? 'kept out of storage' : 'still in storage'} (VOID_EXPECT=${process.env.VOID_EXPECT ?? 'present'}), observed ${absent ? 'kept out of storage' : 'still in storage'}`,
	)
}
