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
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..')
export const PROFILES_DIR = join(ROOT, '.tmp', 'void-e2e')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── environment ─────────────────────────────────────────────────────────

function resolveElectronPath() {
	const product = JSON.parse(
		execFileSync('node', ['-p', 'JSON.stringify(require("./product.json"))'], { cwd: ROOT, encoding: 'utf8' }),
	)
	switch (process.platform) {
		case 'darwin': return join(ROOT, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', 'Electron')
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
	if (!existsSync(ELECTRON_PATH)) problems.push(`no Electron at ${ELECTRON_PATH} — run: npm run electron`)
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
	if (process.platform === 'darwin') a.push('--use-gl=swiftshader')
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

function query(userDataDir, sql) {
	const db = join(userDataDir, 'User', 'globalStorage', 'state.vscdb')
	if (!existsSync(db)) return []
	const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, sql], { encoding: 'utf8' })
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
