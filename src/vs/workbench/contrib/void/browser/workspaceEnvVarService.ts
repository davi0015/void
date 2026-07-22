/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { hash } from '../../../../base/common/hash.js';
import { basename as resourceBasename } from '../../../../base/common/resources.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkspaceContextService, toWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { WORKSPACE_ENV_VARS_KEY } from '../common/storageKeys.js';


// --- Types ---

// Plaintext metadata for one env var. The actual values live in the encrypted
// blob (EnvVarValuesBlob), indexed by position in the array.
export type EnvVarEntry = {
	activeIndex: number | null  // which value is active (injected into terminals), or null if none
	// Whether to scrub this var's values from terminal output. Defaults to
	// true (safer). Set to false for non-secret config like NODE_ENV=development
	// where scrubbing would redact common words from legitimate output.
	redact: boolean
}

// Map keyed by VAR_NAME (e.g. "OPENAI_API_KEY")
export type WorkspaceEnvVars = Record<string, EnvVarEntry>

// The encrypted values blob: { VAR_NAME: [value0, value1, ...] }
type EnvVarValuesBlob = Record<string, string[]>


// --- Interface ---

export interface IWorkspaceEnvVarService {
	readonly _serviceBrand: undefined;

	// Metadata (plaintext, workspace-scoped)
	getVars(): WorkspaceEnvVars
	addVar(name: string, value: string, redact: boolean): Promise<void>
	addValue(name: string, value: string): Promise<void>
	setActive(name: string, index: number): void
	setRedact(name: string, redact: boolean): void
	removeVar(name: string): Promise<void>
	removeValue(name: string, index: number): Promise<void>

	// Read the encrypted values blob (for the management UI to display
	// masked previews). One decrypt.
	getValues(name: string): Promise<string[]>

	// Resolved env for terminal injection (active values only,
	// called by TerminalToolService._createTerminal). Reads the single
	// encrypted values blob (one decrypt).
	getActiveEnv(): Promise<Record<string, string>>  // VAR_NAME -> value

	// All values (active + inactive) of vars where redact=true,
	// name + value pairs. Called by the output scrubber in TerminalToolService
	// so terminals created under a now-inactive value still get scrubbed.
	getScrubableEnvValues(): Promise<{ name: string, value: string }[]>

	// Names of vars that have an active value (activeIndex !== null).
	// Called by ConvertToLLMMessageService for LLM advertisement — names only.
	getActiveVarNames(): string[]
}

export const IWorkspaceEnvVarService = createDecorator<IWorkspaceEnvVarService>('WorkspaceEnvVarService');


// --- Helpers ---

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const SECRET_KEY_PREFIX = 'void.envVar.'

// Mask a value for UI display: first 8 + ... + last 4.
export const maskEnvValue = (v: string): string => {
	if (v.length <= 12) return '••••'
	return v.slice(0, 8) + '...' + v.slice(-4)
}


// --- Implementation ---

class WorkspaceEnvVarService extends Disposable implements IWorkspaceEnvVarService {
	readonly _serviceBrand: undefined;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();
	}

	// --- Workspace identity ---
	// Mirrors ChatThreadService._getCurrentWorkspaceIdentity so env vars
	// scope the same way threads do.
	private _workspaceKey(): string {
		const workspace = this.workspaceContextService.getWorkspace()
		const identifier = toWorkspaceIdentifier(workspace)
		if ('uri' in identifier) {
			return identifier.uri.toString()
		}
		if ('configPath' in identifier) {
			const configName = resourceBasename(identifier.configPath)
			if (configName !== 'workspace.json' && configName.endsWith('.code-workspace')) {
				return identifier.configPath.toString()
			}
		}
		if (workspace.folders.length > 0) {
			return workspace.folders[0].uri.toString()
		}
		return ''
	}

	private _secretStorageKey(): string | null {
		const wsKey = this._workspaceKey()
		if (!wsKey) return null
		return `${SECRET_KEY_PREFIX}${hash(wsKey).toString(36)}`
	}

	// --- Metadata (plaintext) ---

	getVars(): WorkspaceEnvVars {
		const raw = this.storageService.get(WORKSPACE_ENV_VARS_KEY, StorageScope.WORKSPACE)
		if (!raw) return {}
		try {
			const parsed = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
			const vars = parsed as WorkspaceEnvVars
			// Backward-compat: entries persisted before `redact` existed default
			// to true (safer — scrub by default).
			for (const entry of Object.values(vars)) {
				if (entry.redact === undefined) entry.redact = true
			}
			return vars
		} catch {
			return {}
		}
	}

	private _setVars(vars: WorkspaceEnvVars): void {
		this.storageService.store(WORKSPACE_ENV_VARS_KEY, JSON.stringify(vars), StorageScope.WORKSPACE, StorageTarget.USER)
	}

	// --- Values (encrypted blob) ---

	private async _readValuesBlob(): Promise<EnvVarValuesBlob> {
		const key = this._secretStorageKey()
		if (!key) return {}
		const raw = await this.secretStorageService.get(key)
		if (!raw) return {}
		try {
			const parsed = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
			return parsed as EnvVarValuesBlob
		} catch {
			await this.secretStorageService.delete(key).catch(() => { })
			return {}
		}
	}

	private async _writeValuesBlob(blob: EnvVarValuesBlob): Promise<void> {
		const key = this._secretStorageKey()
		if (!key) return
		await this.secretStorageService.set(key, JSON.stringify(blob))
	}

	// --- CRUD ---

	async addVar(name: string, value: string, redact: boolean): Promise<void> {
		if (!ENV_VAR_NAME_RE.test(name)) {
			throw new Error(`Invalid env var name: ${name}. Must match /^[A-Z_][A-Z0-9_]*$/`)
		}
		const vars = this.getVars()
		if (name in vars) {
			throw new Error(`Env var ${name} already exists`)
		}
		vars[name] = { activeIndex: 0, redact }
		this._setVars(vars)

		const blob = await this._readValuesBlob()
		blob[name] = [value]
		await this._writeValuesBlob(blob)
	}

	async addValue(name: string, value: string): Promise<void> {
		const vars = this.getVars()
		if (!(name in vars)) {
			throw new Error(`Env var ${name} does not exist`)
		}
		// Does NOT change activeIndex — user explicitly switches.
		this._setVars(vars)

		const blob = await this._readValuesBlob()
		if (!blob[name]) blob[name] = []
		blob[name].push(value)
		await this._writeValuesBlob(blob)
	}

	setActive(name: string, index: number): void {
		const vars = this.getVars()
		const entry = vars[name]
		if (!entry) {
			throw new Error(`Env var ${name} does not exist`)
		}
		// Plaintext-metadata-only flip — zero secret bytes touched.
		entry.activeIndex = index
		this._setVars(vars)
	}

	setRedact(name: string, redact: boolean): void {
		const vars = this.getVars()
		const entry = vars[name]
		if (!entry) {
			throw new Error(`Env var ${name} does not exist`)
		}
		entry.redact = redact
		this._setVars(vars)
	}

	async removeVar(name: string): Promise<void> {
		const vars = this.getVars()
		if (!(name in vars)) return
		delete vars[name]
		this._setVars(vars)

		const blob = await this._readValuesBlob()
		if (blob[name]) {
			delete blob[name]
			await this._writeValuesBlob(blob)
		}
	}

	async removeValue(name: string, index: number): Promise<void> {
		const vars = this.getVars()
		const entry = vars[name]
		if (!entry) return

		const blob = await this._readValuesBlob()
		const values = blob[name]
		if (!values || index < 0 || index >= values.length) return

		values.splice(index, 1)

		// Adjust activeIndex: if we removed the active one, fall back to 0
		// (or null if no values remain). If we removed before active, shift down.
		if (values.length === 0) {
			delete vars[name]
			delete blob[name]
		} else {
			if (entry.activeIndex === index) {
				entry.activeIndex = 0
			} else if (entry.activeIndex !== null && index < entry.activeIndex) {
				entry.activeIndex -= 1
			}
		}
		this._setVars(vars)
		await this._writeValuesBlob(blob)
	}

	// --- Read paths for consumers ---

	async getValues(name: string): Promise<string[]> {
		const blob = await this._readValuesBlob()
		return blob[name] ?? []
	}

	async getActiveEnv(): Promise<Record<string, string>> {
		const vars = this.getVars()
		const blob = await this._readValuesBlob()
		const result: Record<string, string> = {}
		for (const [name, entry] of Object.entries(vars)) {
			if (entry.activeIndex === null) continue
			const value = blob[name]?.[entry.activeIndex]
			if (value !== undefined) result[name] = value
		}
		return result
	}

	async getScrubableEnvValues(): Promise<{ name: string, value: string }[]> {
		const vars = this.getVars()
		const blob = await this._readValuesBlob()
		const result: { name: string, value: string }[] = []
		for (const [name, entry] of Object.entries(vars)) {
			if (!entry.redact) continue
			for (const value of blob[name] ?? []) {
				if (value) result.push({ name, value })
			}
		}
		return result
	}

	getActiveVarNames(): string[] {
		const vars = this.getVars()
		return Object.entries(vars)
			.filter(([, entry]) => entry.activeIndex !== null)
			.map(([name]) => name)
	}
}

registerSingleton(IWorkspaceEnvVarService, WorkspaceEnvVarService, InstantiationType.Delayed);
