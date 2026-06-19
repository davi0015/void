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
import { Emitter } from '../../../../base/common/event.js';
import { getAllUrisInDirectory } from '../common/directoryStrService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { joinPath } from '../../../../base/common/resources.js';
import { hash } from '../../../../base/common/hash.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

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
}

export const ISemanticIndexService = createDecorator<ISemanticIndexService>('semanticIndexService');

// ---- Constants ----

const CHUNK_SIZE_CHARS = 1200
const CHUNK_OVERLAP_CHARS = 200
const INDEX_VERSION = 1
const MAX_FILE_SIZE_BYTES = 1_000_000 // 1MB
const EMBEDDING_BATCH_SIZE = 64 // texts per embed() call

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
	private readonly _onDidChangeStatus = new Emitter<void>()
	readonly onDidChangeStatus = this._onDidChangeStatus.event

	get indexStatus(): IndexStatus { return this._status }
	get indexProgress(): { indexed: number, total: number } { return this._progress }

	private setStatus(status: IndexStatus) {
		this._status = status
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
			const loaded = await this._loadIndex(modelKey)
			if (loaded) {
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

			this._progress = { indexed: 0, total: allUris.length }

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

				this._progress = { indexed: i + 1, total: allUris.length }
			}

			// Embed chunks in batches
			for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
				const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
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

			this._chunks = allChunks

			// Persist index
			const index: SemanticIndex = {
				version: INDEX_VERSION,
				embeddingModel: modelKey,
				fileHashOfUri,
				chunks: allChunks,
			}
			await this._saveIndex(index)

			this.setStatus('ready')
		} catch (e) {
			console.error('[semanticIndex] Indexing failed:', e)
			this.setStatus('idle')
		}
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

	private async _loadIndex(expectedModel: string): Promise<boolean> {
		try {
			const path = this._indexPath()
			const exists = await this.fileService.exists(path)
			if (!exists) return false

			const content = await this.fileService.readFile(path)
			const index: SemanticIndex = JSON.parse(content.value.toString())

			if (index.version !== INDEX_VERSION) return false
			if (index.embeddingModel !== expectedModel) return false

			// Verify files haven't changed — only keep chunks for unchanged files
			const validChunks: Chunk[] = []
			const fileHashOfUri: Record<string, string> = {}

			const folders = this.workspaceContextService.getWorkspace().folders
			const allUris: URI[] = []
			for (const folder of folders) {
				const uris = await getAllUrisInDirectory(folder.uri, 50_000, this.fileService)
				allUris.push(...uris)
			}

			const currentFileHashOfUri: Record<string, string | null> = {}

			for (const chunk of index.chunks) {
				// Check if we've hashed this file yet
				if (!(chunk.uri in currentFileHashOfUri)) {
					const uri = URI.file(chunk.uri)
					try {
						const fileContent = await this.fileService.readFile(uri)
						currentFileHashOfUri[chunk.uri] = contentHash(fileContent.value.toString())
					} catch {
						currentFileHashOfUri[chunk.uri] = null // file deleted
					}
				}

				const currentHash = currentFileHashOfUri[chunk.uri]
				if (currentHash === null) continue // file deleted
				if (currentHash === index.fileHashOfUri[chunk.uri]) {
					validChunks.push(chunk)
					fileHashOfUri[chunk.uri] = currentHash
				}
				// If hash differs, skip this chunk (needs re-indexing — for now we drop it)
			}

			this._chunks = validChunks

			// TODO: re-embed changed files (commit 3 will handle this)

			return validChunks.length > 0
		} catch {
			return false
		}
	}

	private async _saveIndex(index: SemanticIndex): Promise<void> {
		try {
			const path = this._indexPath()
			const dir = joinPath(this.environmentService.userRoamingDataHome, 'voidSemanticIndex')
			const dirExists = await this.fileService.exists(dir)
			if (!dirExists) {
				await this.fileService.createFolder(dir)
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
