/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Semantic index service: chunks workspace files, embeds them via the
// embedding IPC channel, and serves cosine-similarity search results
// for the `semantic_search` tool.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEmbeddingService } from '../common/embeddingService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { ProviderName } from '../common/voidSettingsTypes.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { getAllUrisInDirectory } from '../common/directoryStrService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { joinPath } from '../../../../base/common/resources.js';
import { hash } from '../../../../base/common/hash.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

// ---- Types ----

export type IndexStatus = 'idle' | 'indexing' | 'ready'

export interface SemanticSearchResult {
	uri: URI
	startLine: number
	endLine: number
	snippet: string
	score: number
}

interface Chunk {
	uri: string
	startLine: number
	endLine: number
	content: string
	contentHash: string
	embedding: number[]
}

interface SemanticIndex {
	version: number
	embeddingModel: string
	fileHashOfUri: Record<string, string>
	chunks: Chunk[]
}

export interface ISemanticIndexService {
	readonly _serviceBrand: undefined
	search(query: string, nResults: number, includePattern?: string): Promise<SemanticSearchResult[]>
	readonly indexStatus: IndexStatus
	readonly indexProgress: { indexed: number, total: number }
	readonly onDidChangeStatus: Event<void>
}

export const ISemanticIndexService = createDecorator<ISemanticIndexService>('semanticIndexService');

// ---- Constants ----

const CHUNK_SIZE_CHARS = 1200
const CHUNK_OVERLAP_CHARS = 200
const INDEX_VERSION = 1
const MAX_FILE_SIZE_BYTES = 1_000_000 // 1MB
const EMBEDDING_BATCH_SIZE = 64 // texts per embed() call
const FILE_WATCHER_DEBOUNCE_MS = 5000

// Binary extensions to skip
const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.svg',
	'.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.wmv',
	'.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tgz',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	'.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.pickle', '.pkl', '.npy', '.npz', '.h5', '.hdf5',
	'.parquet', '.arrow', '.feather', '.sqlite', '.db',
	'.wasm', '.class', '.jar', '.pyc', '.pyo',
])

// ---- Helpers ----

const contentHash = (content: string): string => {
	return String(hash(content))
}

const isBinaryFile = (uri: URI): boolean => {
	const path = uri.path.toLowerCase()
	for (const ext of BINARY_EXTENSIONS) {
		if (path.endsWith(ext)) return true
	}
	return false
}

const cosineSimilarity = (a: number[], b: number[]): number => {
	let dot = 0
	let normA = 0
	let normB = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	if (normA === 0 || normB === 0) return 0
	return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Split file content into chunks with overlap, tracking line numbers
const chunkContent = (content: string, lines: string[]): Chunk[] => {
	const chunks: Chunk[] = []
	let offset = 0

	while (offset < content.length) {
		const end = Math.min(offset + CHUNK_SIZE_CHARS, content.length)
		const chunkText = content.slice(offset, end)

		// Find the line range for this chunk
		let charCount = 0
		let startLine = 1
		let endLine = lines.length

		for (let i = 0; i < lines.length; i++) {
			if (charCount === offset) {
				startLine = i + 1
			}
			charCount += lines[i].length + 1 // +1 for newline
			if (charCount >= end) {
				endLine = i + 1
				break
			}
		}

		chunks.push({
			uri: '', // filled in by caller
			startLine,
			endLine,
			content: chunkText,
			contentHash: contentHash(chunkText),
			embedding: [],
		})

		if (end >= content.length) break
		offset += CHUNK_SIZE_CHARS - CHUNK_OVERLAP_CHARS
	}

	return chunks
}

// ---- Service ----

class SemanticIndexService extends Disposable implements ISemanticIndexService {
	_serviceBrand: undefined

	private _status: IndexStatus = 'idle'
	private _progress = { indexed: 0, total: 0 }
	private _chunks: Chunk[] = []
	private _fileHashOfUri: Record<string, string> = {}
	private _currentEmbeddingModel: string = ''

	private readonly _onDidChangeStatus = new Emitter<void>()
	readonly onDidChangeStatus = this._onDidChangeStatus.event

	// Debounced file watcher
	private readonly _fileChangeScheduler: RunOnceScheduler
	private _pendingChangedUris = new Set<string>()

	get indexStatus(): IndexStatus { return this._status }
	get indexProgress(): { indexed: number, total: number } { return this._progress }

	private setStatus(status: IndexStatus) {
		this._status = status
		this._onDidChangeStatus.fire()
	}

	private setProgress(progress: { indexed: number, total: number }) {
		this._progress = progress
		this._onDidChangeStatus.fire()
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEmbeddingService private readonly embeddingService: IEmbeddingService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super()

		// Debounced handler for file changes
		this._fileChangeScheduler = this._register(new RunOnceScheduler(() => {
			this._handleFileChanges()
		}, FILE_WATCHER_DEBOUNCE_MS))

		// Watch for file changes across all workspace folders
		const folders = this.workspaceContextService.getWorkspace().folders
		for (const folder of folders) {
			this._register(this.fileService.watch(folder.uri))
		}
		this._register(this.fileService.onDidFilesChange(e => {
			for (const resource of e.rawUpdated) {
				this._pendingChangedUris.add(resource.fsPath)
			}
			for (const resource of e.rawDeleted) {
				this._pendingChangedUris.add(resource.fsPath)
			}
			for (const resource of e.rawAdded) {
				this._pendingChangedUris.add(resource.fsPath)
			}
			if (this._pendingChangedUris.size > 0 && this._status === 'ready') {
				this._fileChangeScheduler.schedule()
			}
		}))

		// Start indexing when the workspace is ready
		this._indexWorkspace()
	}

	// Resolve which embedding model to use from settings
	private _resolveEmbeddingModel(): { providerName: ProviderName, modelName: string } | null {
		const state = this.voidSettingsService.state
		const selection = state.modelSelectionOfFeature['SemanticSearch']
		if (selection) {
			return { providerName: selection.providerName, modelName: selection.modelName }
		}

		// Auto-pick: first model with supportsEmbedding === true
		for (const providerName of Object.keys(state.settingsOfProvider) as ProviderName[]) {
			const providerSettings = state.settingsOfProvider[providerName]
			if (!providerSettings?._didFillInProviderSettings) continue
			for (const model of providerSettings.models ?? []) {
				if (model.isHidden) continue
				const caps = getModelCapabilities(providerName, model.modelName, state.overridesOfModel)
				if (caps.supportsEmbedding === true) {
					return { providerName, modelName: model.modelName }
				}
			}
		}

		return null
	}

	private async _indexWorkspace(): Promise<void> {
		const model = this._resolveEmbeddingModel()
		if (!model) return // no embedding model configured yet

		const modelKey = `${model.providerName}/${model.modelName}`
		if (!this.voidSettingsService.state.globalSettings.semanticSearchEnabled) return

		this.setStatus('indexing')

		try {
			// Try to load existing index from disk
			const loaded = await this._loadIndex(modelKey, model)
			if (loaded) {
				this._currentEmbeddingModel = modelKey
				this.setStatus('ready')
				return
			}

			// Full index: collect all workspace file URIs
			const folders = this.workspaceContextService.getWorkspace().folders
			const allUris: URI[] = []
			for (const folder of folders) {
				const uris = await getAllUrisInDirectory(folder.uri, 50_000, this.fileService)
				allUris.push(...uris)
			}

			this.setProgress({ indexed: 0, total: allUris.length })

			// Chunk and embed each file
			const fileHashOfUri: Record<string, string> = {}
			const allChunks: Chunk[] = []

			for (let i = 0; i < allUris.length; i++) {
				const uri = allUris[i]
				if (isBinaryFile(uri)) continue

				try {
					const stat = await this.fileService.stat(uri)
					if (stat.size > MAX_FILE_SIZE_BYTES) continue

					const content = await this.fileService.readFile(uri)
					const text = content.value.toString()
					fileHashOfUri[uri.fsPath] = contentHash(text)

					const lines = text.split('\n')
					const chunks = chunkContent(text, lines)
					for (const chunk of chunks) {
						chunk.uri = uri.fsPath
					}
					allChunks.push(...chunks)
				} catch {
					// skip unreadable files
				}

				this.setProgress({ indexed: i + 1, total: allUris.length })
			}

			// Embed chunks in batches
			await this._embedChunks(allChunks, model)

			this._chunks = allChunks
			this._fileHashOfUri = fileHashOfUri
			this._currentEmbeddingModel = modelKey

			// Persist index
			await this._saveCurrentIndex()

			this.setStatus('ready')
		} catch (e) {
			console.error('[semanticIndex] Indexing failed:', e)
			this.setStatus('idle')
		}
	}

	// Embed an array of chunks in batches
	private async _embedChunks(chunks: Chunk[], model: { providerName: ProviderName, modelName: string }): Promise<void> {
		for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
			const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE)
			const texts = batch.map(c => c.content)
			const embeddings = await this.embeddingService.embed(
				model.providerName,
				model.modelName,
				texts,
				this.voidSettingsService.state.settingsOfProvider,
			)
			for (let j = 0; j < batch.length; j++) {
				batch[j].embedding = embeddings[j] ?? []
			}
		}
	}

	// Handle file changes detected by the watcher
	private async _handleFileChanges(): Promise<void> {
		if (this._status !== 'ready') return

		const changedPaths = [...this._pendingChangedUris]
		this._pendingChangedUris.clear()

		const model = this._resolveEmbeddingModel()
		if (!model) return

		const chunksToRemove = new Set<number>()
		const newChunks: Chunk[] = []
		const newFileHashes: Record<string, string> = {}

		for (const fsPath of changedPaths) {
			const uri = URI.file(fsPath)

			// Remove existing chunks for this file
			for (let i = 0; i < this._chunks.length; i++) {
				if (this._chunks[i].uri === fsPath) {
					chunksToRemove.add(i)
				}
			}

			// If file was deleted, skip re-indexing
			const exists = await this.fileService.exists(uri)
			if (!exists) {
				delete this._fileHashOfUri[fsPath]
				continue
			}

			if (isBinaryFile(uri)) continue

			try {
				const stat = await this.fileService.stat(uri)
				if (stat.size > MAX_FILE_SIZE_BYTES) continue

				const content = await this.fileService.readFile(uri)
				const text = content.value.toString()
				const fileHashValue = contentHash(text)

				// Skip if file content hasn't actually changed
				if (this._fileHashOfUri[fsPath] === fileHashValue) {
					// Remove the removal markers — content didn't change
					for (let i = 0; i < this._chunks.length; i++) {
						if (this._chunks[i].uri === fsPath) {
							chunksToRemove.delete(i)
						}
					}
					continue
				}

				newFileHashes[fsPath] = fileHashValue
				const lines = text.split('\n')
				const chunks = chunkContent(text, lines)
				for (const chunk of chunks) {
					chunk.uri = fsPath
				}
				newChunks.push(...chunks)
			} catch {
				// skip unreadable files
			}
		}

		if (chunksToRemove.size === 0 && newChunks.length === 0) return

		// Embed new chunks
		await this._embedChunks(newChunks, model)

		// Rebuild chunks array: remove old, add new
		const updatedChunks: Chunk[] = []
		for (let i = 0; i < this._chunks.length; i++) {
			if (!chunksToRemove.has(i)) {
				updatedChunks.push(this._chunks[i])
			}
		}
		updatedChunks.push(...newChunks)
		this._chunks = updatedChunks

		// Update file hashes
		for (const [path, hashValue] of Object.entries(newFileHashes)) {
			this._fileHashOfUri[path] = hashValue
		}

		// Persist updated index
		await this._saveCurrentIndex()
	}

	// Search by cosine similarity
	async search(query: string, nResults: number, includePattern?: string): Promise<SemanticSearchResult[]> {
		if (this._status !== 'ready' || this._chunks.length === 0) {
			return []
		}

		const model = this._resolveEmbeddingModel()
		if (!model) return []

		// Embed the query
		const [queryEmbedding] = await this.embeddingService.embed(
			model.providerName,
			model.modelName,
			[query],
			this.voidSettingsService.state.settingsOfProvider,
		)
		if (!queryEmbedding || queryEmbedding.length === 0) return []

		// Compute similarity scores
		let scored = this._chunks.map(chunk => ({
			chunk,
			score: cosineSimilarity(queryEmbedding, chunk.embedding),
		}))

		// Filter by include pattern if provided
		if (includePattern) {
			const globRe = globToRegex(includePattern)
			scored = scored.filter(({ chunk }) => globRe.test(chunk.uri))
		}

		// Sort by score descending, take top N
		scored.sort((a, b) => b.score - a.score)
		const topN = scored.slice(0, nResults)

		return topN.map(({ chunk, score }) => ({
			uri: URI.file(chunk.uri),
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			snippet: chunk.content.length > 200 ? chunk.content.slice(0, 200) + '...' : chunk.content,
			score,
		}))
	}

	// ---- Persistence ----

	private _indexPath(): URI {
		const folders = this.workspaceContextService.getWorkspace().folders
		const workspaceHash = folders.length > 0 ? String(hash(folders.map(f => f.uri.toString()).join(','))) : 'default'
		return joinPath(this.environmentService.userRoamingDataHome, 'voidSemanticIndex', `${workspaceHash}.json`)
	}

	private async _loadIndex(expectedModel: string, model: { providerName: ProviderName, modelName: string }): Promise<boolean> {
		try {
			const path = this._indexPath()
			const exists = await this.fileService.exists(path)
			if (!exists) return false

			const content = await this.fileService.readFile(path)
			const index: SemanticIndex = JSON.parse(content.value.toString())

			if (index.version !== INDEX_VERSION) return false
			// Full re-index if embedding model changed (different vector space)
			if (index.embeddingModel !== expectedModel) return false

			// Hash all current workspace files
			const folders = this.workspaceContextService.getWorkspace().folders
			const allUris: URI[] = []
			for (const folder of folders) {
				const uris = await getAllUrisInDirectory(folder.uri, 50_000, this.fileService)
				allUris.push(...uris)
			}

			const currentHashOfFsPath: Record<string, string | null> = {}
			for (const uri of allUris) {
				if (isBinaryFile(uri)) continue
				try {
					const stat = await this.fileService.stat(uri)
					if (stat.size > MAX_FILE_SIZE_BYTES) continue
					const fileContent = await this.fileService.readFile(uri)
					currentHashOfFsPath[uri.fsPath] = contentHash(fileContent.value.toString())
				} catch {
					currentHashOfFsPath[uri.fsPath] = null
				}
			}

			// Separate chunks into unchanged, changed, and deleted
			const unchangedChunks: Chunk[] = []
			const changedFsPaths = new Set<string>()
			const indexedFsPaths = new Set<string>()

			for (const chunk of index.chunks) {
				indexedFsPaths.add(chunk.uri)
				const currentHash = currentHashOfFsPath[chunk.uri]
				if (currentHash === null) continue // file deleted — drop chunks
				if (currentHash === index.fileHashOfUri[chunk.uri]) {
					unchangedChunks.push(chunk) // file unchanged — keep chunks
				} else {
					changedFsPaths.add(chunk.uri) // file changed — need re-indexing
				}
			}

			// Find new files not in the index
			const newFsPaths: string[] = []
			for (const [fsPath, hashVal] of Object.entries(currentHashOfFsPath)) {
				if (hashVal !== null && !indexedFsPaths.has(fsPath)) {
					newFsPaths.push(fsPath)
				}
			}

			// Re-chunk and re-embed changed + new files
			const changedAndNewPaths = [...changedFsPaths, ...newFsPaths]
			const newChunks: Chunk[] = []
			const newFileHashOfUri: Record<string, string> = {}

			for (const fsPath of changedAndNewPaths) {
				const uri = URI.file(fsPath)
				try {
					const fileContent = await this.fileService.readFile(uri)
					const text = fileContent.value.toString()
					newFileHashOfUri[fsPath] = currentHashOfFsPath[fsPath]!
					const lines = text.split('\n')
					const chunks = chunkContent(text, lines)
					for (const chunk of chunks) {
						chunk.uri = fsPath
					}
					newChunks.push(...chunks)
				} catch {
					// skip unreadable
				}
			}

			// Embed only the changed/new chunks
			if (newChunks.length > 0) {
				await this._embedChunks(newChunks, model)
			}

			// Merge file hashes
			const mergedFileHashOfUri: Record<string, string> = {}
			for (const [path, hashVal] of Object.entries(index.fileHashOfUri)) {
				if (currentHashOfFsPath[path] !== null) {
					mergedFileHashOfUri[path] = hashVal
				}
			}
			Object.assign(mergedFileHashOfUri, newFileHashOfUri)

			this._chunks = [...unchangedChunks, ...newChunks]
			this._fileHashOfUri = mergedFileHashOfUri

			// Persist updated index
			await this._saveCurrentIndex()

			return this._chunks.length > 0
		} catch {
			return false
		}
	}

	private async _saveCurrentIndex(): Promise<void> {
		try {
			const path = this._indexPath()
			const dir = joinPath(this.environmentService.userRoamingDataHome, 'voidSemanticIndex')
			const dirExists = await this.fileService.exists(dir)
			if (!dirExists) {
				await this.fileService.createFolder(dir)
			}
			const index: SemanticIndex = {
				version: INDEX_VERSION,
				embeddingModel: this._currentEmbeddingModel,
				fileHashOfUri: this._fileHashOfUri,
				chunks: this._chunks,
			}
			await this.fileService.writeFile(path, VSBuffer.fromString(JSON.stringify(index)))
		} catch (e) {
			console.error('[semanticIndex] Failed to save index:', e)
		}
	}
}

// Simple glob-to-regex converter for include_pattern filtering
const globToRegex = (pattern: string): RegExp => {
	const parts = pattern.split('/')
	let regex = ''
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === '**') {
			regex += '.*'
		} else if (parts[i] === '*') {
			regex += '[^/]*'
		} else {
			regex += parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		}
		if (i < parts.length - 1) regex += '/'
	}
	return new RegExp(regex)
}

registerSingleton(ISemanticIndexService, SemanticIndexService, InstantiationType.Delayed);
