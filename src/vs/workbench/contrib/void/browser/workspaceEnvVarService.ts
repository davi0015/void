/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { hash } from '../../../../base/common/hash.js';
import { basename as resourceBasename } from '../../../../base/common/resources.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkspaceContextService, toWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { WORKSPACE_ENV_VARS_KEY } from '../common/storageKeys.js';


// --- Types (also referenced by consumers: TerminalToolService,
// ConvertToLLMMessageService, the management UI in sidebarActions.ts) ---

export type EnvVarVariantMeta = {
	id: string       // stable uuid; key into the values blob
	label: string    // human-readable, e.g. "prod" / "staging" / "personal"
	createdAt: number
}

export type EnvVarEntry = {
	variants: EnvVarVariantMeta[]   // insertion order; first is default-active on creation
	activeVariantId: string         // points into variants[].id
}

// map keyed by VAR_NAME (e.g. "OPENAI_API_KEY")
export type WorkspaceEnvVars = Record<string, EnvVarEntry>

// The encrypted values blob: { VAR_NAME: { variantId: value } }
type EnvVarValuesBlob = Record<string, Record<string, string>>


// --- Interface ---

export interface IWorkspaceEnvVarService {
	readonly _serviceBrand: undefined;

	// Metadata (plaintext, workspace-scoped)
	getVars(): WorkspaceEnvVars
	addVar(name: string, firstVariantLabel: string, firstVariantValue: string): Promise<void>
	addVariant(name: string, label: string, value: string): Promise<void>
	setActiveVariant(name: string, variantId: string): void
	removeVar(name: string): Promise<void>
	removeVariant(name: string, variantId: string): Promise<void>

	// Resolved env for terminal injection (active variants only,
	// called by TerminalToolService._createTerminal). Reads the single
	// encrypted values blob (one decrypt).
	getActiveEnv(): Promise<Record<string, string>>  // VAR_NAME -> value

	// All variant values (active + inactive), name + value pairs.
	// Called by the output scrubber in TerminalToolService so terminals
	// created under a now-inactive variant still get scrubbed. Same single
	// blob read as getActiveEnv, flattened to all variants.
	getAllEnvValues(): Promise<{ name: string, value: string }[]>

	// Resolved names + active labels for LLM advertisement
	// (called by ConvertToLLMMessageService — names only, no values)
	getActiveVarDescriptors(): { name: string, activeLabel: string }[]
}

export const IWorkspaceEnvVarService = createDecorator<IWorkspaceEnvVarService>('WorkspaceEnvVarService');


// --- Implementation ---

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const SECRET_KEY_PREFIX = 'void.envVar.'

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
	// scope the same way threads do: single-folder → folder URI, saved
	// .code-workspace → configPath, untitled multi-root → first folder URI
	// (so adding/removing folders doesn't break identity). Returns '' for
	// an empty window — env vars are a no-op in that case.
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
			// Untitled workspace — fall through to first-folder identity.
		}
		if (workspace.folders.length > 0) {
			return workspace.folders[0].uri.toString()
		}
		return ''
	}

	// Stable hash of the workspace URI for the secret-storage key. Not
	// secret — just a compact partition key. Returns null for empty windows
	// (no workspace), meaning env vars are disabled.
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
			return parsed as WorkspaceEnvVars
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
			// Corrupt blob — clear it so next read is clean. Matches the
			// auto-delete-on-decrypt-failure behavior in secrets.ts.
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

	async addVar(name: string, firstVariantLabel: string, firstVariantValue: string): Promise<void> {
		if (!ENV_VAR_NAME_RE.test(name)) {
			throw new Error(`Invalid env var name: ${name}. Must match /^[A-Z_][A-Z0-9_]*$/`)
		}
		const vars = this.getVars()
		if (name in vars) {
			throw new Error(`Env var ${name} already exists`)
		}
		const variantId = generateUuid()
		vars[name] = {
			variants: [{ id: variantId, label: firstVariantLabel, createdAt: Date.now() }],
			activeVariantId: variantId,
		}
		this._setVars(vars)

		// Read-modify-write the values blob (writes are rare + serialized by
		// ISecretStorageService's SequencerByKey).
		const blob = await this._readValuesBlob()
		if (!blob[name]) blob[name] = {}
		blob[name][variantId] = firstVariantValue
		await this._writeValuesBlob(blob)
	}

	async addVariant(name: string, label: string, value: string): Promise<void> {
		const vars = this.getVars()
		const entry = vars[name]
		if (!entry) {
			throw new Error(`Env var ${name} does not exist`)
		}
		const variantId = generateUuid()
		entry.variants.push({ id: variantId, label, createdAt: Date.now() })
		// Does NOT change the active variant — user explicitly switches.
		this._setVars(vars)

		const blob = await this._readValuesBlob()
		if (!blob[name]) blob[name] = {}
		blob[name][variantId] = value
		await this._writeValuesBlob(blob)
	}

	setActiveVariant(name: string, variantId: string): void {
		const vars = this.getVars()
		const entry = vars[name]
		if (!entry) {
			throw new Error(`Env var ${name} does not exist`)
		}
		if (!entry.variants.some(v => v.id === variantId)) {
			throw new Error(`Variant ${variantId} does not exist on var ${name}`)
		}
		// Plaintext-metadata-only flip — zero secret bytes touched.
		entry.activeVariantId = variantId
		this._setVars(vars)
	}

	async removeVar(name: string): Promise<void> {
		const vars = this.getVars()
		if (!(name in vars)) return
		delete vars[name]
		this._setVars(vars)

		// Best-effort: drop the var's values from the blob. If the blob
		// decrypt fails, metadata is still updated and the dangling blob
		// self-clears on next read via _readValuesBlob's catch.
		const blob = await this._readValuesBlob()
		if (blob[name]) {
			delete blob[name]
			await this._writeValuesBlob(blob)
		}
	}

	async removeVariant(name: string, variantId: string): Promise<void> {
		const vars = this.getVars()
		const entry = vars[name]
		if (!entry) return

		const idx = entry.variants.findIndex(v => v.id === variantId)
		if (idx === -1) return

		entry.variants.splice(idx, 1)

		// If we removed the active variant, fall back to the first remaining
		// one (or remove the var entirely if no variants remain).
		if (entry.variants.length === 0) {
			delete vars[name]
		} else {
			if (entry.activeVariantId === variantId) {
				entry.activeVariantId = entry.variants[0].id
			}
		}
		this._setVars(vars)

		const blob = await this._readValuesBlob()
		if (blob[name]) {
			delete blob[name][variantId]
			if (Object.keys(blob[name]).length === 0) delete blob[name]
			await this._writeValuesBlob(blob)
		}
	}

	// --- Read paths for consumers ---

	async getActiveEnv(): Promise<Record<string, string>> {
		const vars = this.getVars()
		const blob = await this._readValuesBlob()
		const result: Record<string, string> = {}
		for (const [name, entry] of Object.entries(vars)) {
			const value = blob[name]?.[entry.activeVariantId]
			if (value !== undefined) result[name] = value
		}
		return result
	}

	async getAllEnvValues(): Promise<{ name: string, value: string }[]> {
		const vars = this.getVars()
		const blob = await this._readValuesBlob()
		const result: { name: string, value: string }[] = []
		for (const [name, entry] of Object.entries(vars)) {
			for (const variant of entry.variants) {
				const value = blob[name]?.[variant.id]
				if (value !== undefined) result.push({ name, value })
			}
		}
		return result
	}

	getActiveVarDescriptors(): { name: string, activeLabel: string }[] {
		const vars = this.getVars()
		const result: { name: string, activeLabel: string }[] = []
		for (const [name, entry] of Object.entries(vars)) {
			const activeVariant = entry.variants.find(v => v.id === entry.activeVariantId)
			if (activeVariant) {
				result.push({ name, activeLabel: activeVariant.label })
			}
		}
		return result
	}
}

registerSingleton(IWorkspaceEnvVarService, WorkspaceEnvVarService, InstantiationType.Delayed);
