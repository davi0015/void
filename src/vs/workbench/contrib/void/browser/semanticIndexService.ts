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

export type IndexStatus = 'idle' | 'indexing' | 'ready' | 'noModel'

export interface SemanticSearchResult {
	uri: URI
	startLine: number
	endLine: number
	snippet: string
	score: number
	indexStatus: IndexStatus
	indexProgress: { indexed: number, total: number }
}

export type SemanticSearchNoResultReason = 'disabled' | 'noModel' | 'notReady'

interface Chunk {
	uri: string
	startLine: number
	endLine: number
	content: string
	contentHash: string
	embedding: number[] // always in memory as float array
}

// On-disk format: embeddings stored as base64-encoded Float32Array to reduce index size
// Content is NOT persisted — re-read from source file on search to keep the index small
interface SerializedChunk {
	uri: string
	startLine: number
	endLine: number
	contentHash: string
	embedding_b64: string // base64-encoded Float32Array
}

interface SemanticIndex {
	version: number
	embeddingModel: string
	fileHashOfUri: Record<string, string> // files with ALL chunks embedded
	mtimeOfUri: Record<string, number>
	chunks: SerializedChunk[] // serialized format on disk
}

// Lightweight metadata stored separately so startup doesn't need to read
// and parse the ~240MB embeddings file just to check mtimes.
interface IndexMetadata {
	version: number
	embeddingModel: string
	fileHashOfUri: Record<string, string>
	mtimeOfUri: Record<string, number>
	chunkMetas: { uri: string, startLine: number, endLine: number, contentHash: string }[]
}

export interface ISemanticIndexService {
	readonly _serviceBrand: undefined
	search(query: string, nResults: number, includePattern?: string): Promise<{ results: SemanticSearchResult[], noResultReason?: SemanticSearchNoResultReason }>
	readonly indexStatus: IndexStatus
	readonly indexProgress: { indexed: number, total: number }
	readonly onDidChangeStatus: Event<void>
}

export const ISemanticIndexService = createDecorator<ISemanticIndexService>('semanticIndexService');

// ---- Constants ----

const INDEX_VERSION = 1 // only bump when on-disk format changes

// Encode a float array to base64 (for disk storage — ~4x smaller than JSON float arrays)
const encodeEmbedding = (embedding: number[]): string => {
	const f32 = new Float32Array(embedding.length)
	for (let i = 0; i < embedding.length; i++) f32[i] = embedding[i]
	const bytes = new Uint8Array(f32.buffer)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary)
}

// Decode a base64 string to float array (from disk)
const decodeEmbedding = (b64: string): number[] => {
	const binary = atob(b64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	const f32 = new Float32Array(bytes.buffer)
	return Array.from(f32)
}
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

// Non-binary extensions that are not useful for semantic search
const SKIP_EXTENSIONS = new Set([
	'.lock', '.map', '.css', '.min.js', '.min.css',
	'.log', '.env', '.ini', '.cfg', '.conf',
	'.snap', '.patch', '.diff',
	'.csv', '.tsv', '.xml', '.proto',
	'.plist', '.xcodeproj', '.xcworkspace',
	'.dockerignore', '.gitignore', '.eslintignore',
	'.egg-info',
	'.scpt', '.applescript', // AppleScript
	'.nib', '.xib', '.storyboard', // macOS/iOS UI
	'.pbxproj', // Xcode project
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', // documents
])

// Filenames that are not useful for semantic search
const SKIP_FILENAMES = new Set([
	'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
	'.ds_store', 'thumbs.db',
	'dependency_links.txt', 'not-zip-safe',
])

// ---- Helpers ----

// Strip invalid UTF-16 surrogates that break embedding servers
const sanitizeText = (text: string): string => {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\ud800-\udfff]/g, '')
}

const contentHash = (content: string): string => {
	return String(hash(content))
}

const shouldSkipFile = (uri: URI): boolean => {
	const path = uri.path.toLowerCase()
	// Check binary extensions
	for (const ext of BINARY_EXTENSIONS) {
		if (path.endsWith(ext)) return true
	}
	// Check skip extensions
	for (const ext of SKIP_EXTENSIONS) {
		if (path.endsWith(ext)) return true
	}
	// Check skip filenames
	const filename = path.split('/').pop() ?? ''
	if (SKIP_FILENAMES.has(filename)) return true
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
const chunkContent = (content: string, lines: string[], chunkSizeChars: number, chunkOverlapChars: number): Chunk[] => {
	const chunks: Chunk[] = []
	let offset = 0

	while (offset < content.length) {
		const end = Math.min(offset + chunkSizeChars, content.length)
		const chunkText = content.slice(offset, end)

		// Find the line range for this chunk
		let charCount = 0
		let startLine = 1
		let endLine = lines.length
		let foundStart = false

		for (let i = 0; i < lines.length; i++) {
			if (!foundStart && charCount >= offset) {
				startLine = i + 1
				foundStart = true
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
		offset += chunkSizeChars - chunkOverlapChars
	}

	return chunks
}

// ---- Service ----

class SemanticIndexService extends Disposable implements ISemanticIndexService {
	_serviceBrand: undefined

	private _status: IndexStatus = 'idle'
	private _progress = { indexed: 0, total: 0 } // indexed = files fully indexed, total = total files to index
	private _chunks: Chunk[] = [] // chunk metadata always loaded; embeddings loaded lazily
	private _fileHashOfUri: Record<string, string> = {} // only files with ALL chunks embedded
	private _mtimeOfUri: Record<string, number> = {}
	private _currentEmbeddingModel: string = ''
	private _embeddingsLoaded = false // true after _ensureEmbeddingsLoaded has decoded all embeddings

	// During embedding, temporarily stores hashes/mtimes for files being processed.
	// Moved to _fileHashOfUri/_mtimeOfUri only when all chunks for a file are embedded.
	private _pendingFileHashOfUri: Record<string, string> = {}
	private _pendingMtimeOfUri: Record<string, number> = {}
	// Tracks how many chunks are still needed per file during embedding
	private _remainingChunkCountOfFsPath: Record<string, number> = {}

	// Total files being indexed in the current run
	private _totalFilesToIndex: number = 0

	private readonly _onDidChangeStatus = new Emitter<void>()
	readonly onDidChangeStatus = this._onDidChangeStatus.event

	// Debounced file watcher
	private readonly _fileChangeScheduler: RunOnceScheduler
	private _pendingChangedUris = new Set<string>()

	get indexStatus(): IndexStatus { return this._status }
	get indexProgress(): { indexed: number, total: number } { return this._progress }

	// Settings accessors — read from voidSettingsService with defaults
	private get _embeddingDimensions(): number { return this.voidSettingsService.state.globalSettings.semanticSearchDimensions || 1024 }
	private get _embeddingBatchSize(): number { return this.voidSettingsService.state.globalSettings.semanticSearchBatchSize || 64 }
	private get _embeddingConcurrency(): number { return this.voidSettingsService.state.globalSettings.semanticSearchConcurrency || 16 }
	private get _chunkSizeChars(): number { return this.voidSettingsService.state.globalSettings.semanticSearchChunkSize || 2400 }
	private get _chunkOverlapChars(): number { return this.voidSettingsService.state.globalSettings.semanticSearchChunkOverlap || 200 }
	private get _maxFileSizeBytes(): number { return this.voidSettingsService.state.globalSettings.semanticSearchMaxFileSize || 1_000_000 }

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
			if (this._status === 'ready') {
				this._processPendingFileChanges()
			}
			// If not ready, changes stay in _pendingChangedUris and get picked up
			// by _processPendingFileChanges called from _indexWorkspace after it completes
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
			if (this._pendingChangedUris.size > 0) {
				this._fileChangeScheduler.schedule()
			}
		}))

		// Wait for settings to load, then defer indexing past startup so it
		// doesn't compete with editor initialization and extension activation.
		this.voidSettingsService.waitForInitState.then(() => {
			setTimeout(() => this._indexWorkspace(), 3000)
		})
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
		if (!this.voidSettingsService.state.globalSettings.semanticSearchEnabled) {
			console.warn('[semanticIndex] Semantic search is disabled — skipping indexing')
			return
		}

		const model = this._resolveEmbeddingModel()
		if (!model) {
			this.setStatus('noModel')
			return
		}

		const modelKey = `${model.providerName}/${model.modelName}/d${this._embeddingDimensions}/c${this._chunkSizeChars}/o${this._chunkOverlapChars}/m${this._maxFileSizeBytes}`

		this._status = 'indexing'
		this._progress = { indexed: -1, total: 0 } // -1 = scanning phase
		this._onDidChangeStatus.fire()

		try {
			// Scan workspace files once — used by both _loadIndex and full-index path
			const folders = this.workspaceContextService.getWorkspace().folders
			const allUris: URI[] = []
			for (const folder of folders) {
				const uris = await getAllUrisInDirectory(folder.uri, 50_000, this.fileService)
				allUris.push(...uris)
			}

			// Filter to indexable files
			const indexableUris: URI[] = []
			for (let i = 0; i < allUris.length; i++) {
				const uri = allUris[i]
				if (shouldSkipFile(uri)) continue
				try {
					const stat = await this.fileService.stat(uri)
					if (stat.size > this._maxFileSizeBytes) continue
					indexableUris.push(uri)
				} catch {
					// skip
				}
				// Yield to the event loop every 50 files to avoid blocking the UI
				if (i % 50 === 49) {
					await new Promise<void>(resolve => setTimeout(resolve, 0))
				}
			}

			// Try to load existing index — determines which files still need embedding
			const fsPathsToEmbed = await this._loadIndex(modelKey, indexableUris)

			this._currentEmbeddingModel = modelKey

			// If all files are already indexed, we're done
			if (fsPathsToEmbed.length === 0) {
				this.setStatus('ready')
				await this._processPendingFileChanges()
				return
			}

			// Now we know what needs embedding — set progress (newly indexed / total to index)
			this._totalFilesToIndex = fsPathsToEmbed.length
			this._progress = { indexed: 0, total: fsPathsToEmbed.length }
			this._onDidChangeStatus.fire()

			// Reset pending state for this embedding run
			this._pendingFileHashOfUri = {}
			this._pendingMtimeOfUri = {}
			this._remainingChunkCountOfFsPath = {}

			// Read and chunk files that need embedding
			const chunksToEmbed: Chunk[] = []
			for (let i = 0; i < fsPathsToEmbed.length; i++) {
				const fsPath = fsPathsToEmbed[i]
				const uri = URI.file(fsPath)
				try {
					const content = await this.fileService.readFile(uri)
					const text = sanitizeText(content.value.toString())

					const lines = text.split('\n')
					const chunks = chunkContent(text, lines, this._chunkSizeChars, this._chunkOverlapChars)
					for (const chunk of chunks) {
						chunk.uri = fsPath
					}

					if (chunks.length === 0) {
						// File produces no chunks (empty/whitespace) — mark as indexed immediately
						this._fileHashOfUri[fsPath] = contentHash(text)
						const stat = await this.fileService.stat(uri)
						this._mtimeOfUri[fsPath] = stat.mtime
					} else {
						// Store hash/mtime in pending — promoted to permanent when all chunks are embedded
						this._pendingFileHashOfUri[fsPath] = contentHash(text)
						const stat = await this.fileService.stat(uri)
						this._pendingMtimeOfUri[fsPath] = stat.mtime
						this._remainingChunkCountOfFsPath[fsPath] = chunks.length
						chunksToEmbed.push(...chunks)
					}
				} catch {
					// skip unreadable files
				}

				// Yield to the event loop every 50 files to avoid blocking the UI
				if (i % 50 === 49) {
					await new Promise<void>(resolve => setTimeout(resolve, 0))
				}
			}

			if (chunksToEmbed.length === 0) {
				// All files were empty/no chunks — save and finish
				await this._saveCurrentIndex()
				this.setStatus('ready')
				await this._processPendingFileChanges()
				return
			}

			// Embed chunks
			await this._embedChunks(chunksToEmbed, model)

			// Persist index
			await this._saveCurrentIndex()

			this.setStatus('ready')

			// Process any file changes that occurred during initial indexing
			await this._processPendingFileChanges()

			// Pre-warm embeddings in the background so the first search is fast.
			// Not awaited — this runs concurrently and yields to avoid freezing.
			// If files were re-embedded above, _saveCurrentIndex already loaded
			// them, so this is a no-op.
			void this._ensureEmbeddingsLoaded()
		} catch (e) {
			console.error('[semanticIndex] Indexing failed:', e)
			this.setStatus('idle')
		}
	}

	// Embed an array of chunks in batches with sliding window concurrency.
	// Failed chunks are moved to the end of the queue and retried until all succeed.
	private async _embedChunks(chunks: Chunk[], model: { providerName: ProviderName, modelName: string }): Promise<void> {
		const CONCURRENCY = this._embeddingConcurrency
		const MAX_RETRIES = 5
		let completedBatches = 0
		let indexedFileCount = 0

		const processBatch = async (batch: Chunk[], batchNum: number): Promise<Chunk[]> => {
			// Replace empty/whitespace-only texts with a space to avoid server errors
			const texts = batch.map(c => c.content.trim() ? c.content : ' ')
			let succeededChunks: Chunk[] = []
			let failedChunks: Chunk[] = []

			// Retry with exponential backoff on failure
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				succeededChunks = []
				failedChunks = []
				try {
					// Timeout: if the server hangs, don't wait forever
					const embedPromise = this.embeddingService.embed(
						model.providerName,
						model.modelName,
						texts,
						this.voidSettingsService.state.settingsOfProvider,
					)
					const timeoutPromise = new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('Embedding request timed out')), 120_000)
					)
					const embeddings = await Promise.race([embedPromise, timeoutPromise])
					for (let j = 0; j < batch.length; j++) {
						if (embeddings[j] && embeddings[j].length > 0) {
							batch[j].embedding = embeddings[j].length > this._embeddingDimensions ? embeddings[j].slice(0, this._embeddingDimensions) : embeddings[j]
							succeededChunks.push(batch[j])
						} else {
							failedChunks.push(batch[j])
						}
					}
					if (failedChunks.length === 0) break // all succeeded
					if (attempt < MAX_RETRIES) {
						// Retry only the failed chunks
						const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000)
						console.warn(`[semanticIndex] Batch ${batchNum}: ${failedChunks.length}/${batch.length} chunks failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms`)
						await new Promise<void>(resolve => setTimeout(resolve, delayMs))
						// Rebuild texts for only the failed chunks
						batch = failedChunks
						failedChunks = []
						continue
					}
				} catch (e) {
					// Entire request failed — retry all chunks in this batch
					if (attempt < MAX_RETRIES) {
						const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000)
						console.warn(`[semanticIndex] Batch ${batchNum} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms:`, e)
						await new Promise<void>(resolve => setTimeout(resolve, delayMs))
					} else {
						failedChunks = batch
					}
				}
			}

			// Add successfully embedded chunks to the main list
			if (succeededChunks.length > 0) {
				this._chunks.push(...succeededChunks)

				// Decrement remaining chunk counts and finalize files that are fully embedded
				for (const c of succeededChunks) {
					if (this._remainingChunkCountOfFsPath[c.uri] !== undefined) {
						this._remainingChunkCountOfFsPath[c.uri]--
						if (this._remainingChunkCountOfFsPath[c.uri] === 0) {
							// All chunks for this file are embedded — move hash/mtime to permanent state
							const fsPath = c.uri
							if (this._pendingFileHashOfUri[fsPath] !== undefined) {
								this._fileHashOfUri[fsPath] = this._pendingFileHashOfUri[fsPath]
								delete this._pendingFileHashOfUri[fsPath]
							}
							if (this._pendingMtimeOfUri[fsPath] !== undefined) {
								this._mtimeOfUri[fsPath] = this._pendingMtimeOfUri[fsPath]
								delete this._pendingMtimeOfUri[fsPath]
							}
							delete this._remainingChunkCountOfFsPath[fsPath]
							// Update file-level progress
							indexedFileCount++
							this.setProgress({ indexed: indexedFileCount, total: this._totalFilesToIndex })
						}
					}
				}
			}

			completedBatches++

			// Save incrementally every 4 batches
			if (completedBatches % 4 === 0) {
				await this._saveCurrentIndex()
			}

			// Return any chunks that still failed (will be re-queued)
			return failedChunks
		}

		// Run batches in sliding window. Collect failed chunks and re-queue them.
		let remainingChunks = chunks
		let passNum = 1
		while (remainingChunks.length > 0) {
			// Create batch slices
			const batches: Chunk[][] = []
			for (let i = 0; i < remainingChunks.length; i += this._embeddingBatchSize) {
				batches.push(remainingChunks.slice(i, i + this._embeddingBatchSize))
			}

			const failedChunks: Chunk[] = []

			// Sliding window: always keep CONCURRENCY requests in flight
			let nextBatchIdx = 0
			const inFlight = new Set<Promise<void>>()

			const launchNext = (): Promise<void> => {
				if (nextBatchIdx >= batches.length) return Promise.resolve()
				const batchIdx = nextBatchIdx++
				const batch = batches[batchIdx]
				const p = processBatch(batch, batchIdx + 1).then(failed => {
					failedChunks.push(...failed)
					inFlight.delete(p)
					while (inFlight.size < CONCURRENCY && nextBatchIdx < batches.length) {
						inFlight.add(launchNext())
					}
				}).catch(() => {
					inFlight.delete(p)
				})
				inFlight.add(p)
				return p
			}

			while (inFlight.size < CONCURRENCY && nextBatchIdx < batches.length) {
				inFlight.add(launchNext())
			}

			while (inFlight.size > 0) {
				await Promise.race(inFlight)
			}

			if (failedChunks.length === 0) break // all done
			console.warn(`[semanticIndex] Pass ${passNum} complete: ${failedChunks.length} chunks failed, re-queuing`)
			remainingChunks = failedChunks
			passNum++
		}

		// Clean up any remaining partial files (shouldn't happen normally)
		for (const fsPath of Object.keys(this._remainingChunkCountOfFsPath)) {
			const remaining = this._remainingChunkCountOfFsPath[fsPath]
			if (remaining > 0) {
				const hasSucceededChunks = this._chunks.some(c => c.uri === fsPath)
				if (hasSucceededChunks) {
					if (this._pendingFileHashOfUri[fsPath] !== undefined) {
						this._fileHashOfUri[fsPath] = this._pendingFileHashOfUri[fsPath]
						delete this._pendingFileHashOfUri[fsPath]
					}
					if (this._pendingMtimeOfUri[fsPath] !== undefined) {
						this._mtimeOfUri[fsPath] = this._pendingMtimeOfUri[fsPath]
						delete this._pendingMtimeOfUri[fsPath]
					}
				} else {
					delete this._pendingFileHashOfUri[fsPath]
					delete this._pendingMtimeOfUri[fsPath]
				}
			}
			delete this._remainingChunkCountOfFsPath[fsPath]
		}
	}

	// Process pending file changes. Called after any indexing completes.
	// Loops until no more pending changes, so rapid saves are handled correctly.
	private async _processPendingFileChanges(): Promise<void> {
		if (this._pendingChangedUris.size === 0) return

		const model = this._resolveEmbeddingModel()
		if (!model) return

		// Keep processing until no more pending changes
		while (this._pendingChangedUris.size > 0) {
			const changedPaths = [...this._pendingChangedUris]
			this._pendingChangedUris.clear()

			const chunksToRemove = new Set<number>()
			const newChunks: Chunk[] = []

			// Set up pending state for this batch
			this._pendingFileHashOfUri = {}
			this._pendingMtimeOfUri = {}
			this._remainingChunkCountOfFsPath = {}

			for (const fsPath of changedPaths) {
				const uri = URI.file(fsPath)
				const oldHash = this._fileHashOfUri[fsPath]

				// Remove existing chunks for this file
				for (let i = 0; i < this._chunks.length; i++) {
					if (this._chunks[i].uri === fsPath) {
						chunksToRemove.add(i)
					}
				}
				// Also remove from hash/mtime — will be re-added when fully embedded
				delete this._fileHashOfUri[fsPath]
				delete this._mtimeOfUri[fsPath]

				// If file was deleted, skip re-indexing
				const exists = await this.fileService.exists(uri)
				if (!exists) continue

				if (shouldSkipFile(uri)) continue

				try {
					const stat = await this.fileService.stat(uri)
					if (stat.size > this._maxFileSizeBytes) continue

					const content = await this.fileService.readFile(uri)
					const text = sanitizeText(content.value.toString())
					const fileHashValue = contentHash(text)

					// Skip if file content hasn't actually changed
					if (oldHash !== undefined && oldHash === fileHashValue) {
						// Content didn't change — restore hash/mtime and cancel chunk removal
						this._fileHashOfUri[fsPath] = oldHash
						this._mtimeOfUri[fsPath] = stat.mtime
						for (let i = 0; i < this._chunks.length; i++) {
							if (this._chunks[i].uri === fsPath) {
								chunksToRemove.delete(i)
							}
						}
						continue
					}

					this._pendingFileHashOfUri[fsPath] = fileHashValue
					this._pendingMtimeOfUri[fsPath] = stat.mtime
					const lines = text.split('\n')
					const chunks = chunkContent(text, lines, this._chunkSizeChars, this._chunkOverlapChars)
					for (const chunk of chunks) {
						chunk.uri = fsPath
					}
					newChunks.push(...chunks)
					this._remainingChunkCountOfFsPath[fsPath] = chunks.length
				} catch {
					// skip unreadable files
				}
			}

			if (chunksToRemove.size === 0 && newChunks.length === 0) continue

			// Remove old chunks first — _embedChunks will push new ones to this._chunks
			this._chunks = this._chunks.filter((_, i) => !chunksToRemove.has(i))

			// Show indexing status for re-embedding
			const totalFiles = new Set(newChunks.map(c => c.uri)).size
			this._totalFilesToIndex = totalFiles
			this._status = 'indexing'
			this._progress = { indexed: 0, total: totalFiles }
			this._onDidChangeStatus.fire()

			// Embed new chunks
			await this._embedChunks(newChunks, model)

			// Persist updated index
			await this._saveCurrentIndex()

			// Back to ready — loop will check for more pending changes
			this._status = 'ready'
		}

		this._onDidChangeStatus.fire()
	}

	// Search by cosine similarity
	async search(query: string, nResults: number, includePattern?: string): Promise<{ results: SemanticSearchResult[], noResultReason?: SemanticSearchNoResultReason }> {
		if (!this.voidSettingsService.state.globalSettings.semanticSearchEnabled) {
			return { results: [], noResultReason: 'disabled' }
		}

		const model = this._resolveEmbeddingModel()
		if (!model) return { results: [], noResultReason: 'noModel' }

		if (this._chunks.length === 0) {
			return { results: [], noResultReason: 'notReady' }
		}

		// Lazily load embeddings from disk if not yet loaded (deferred past startup)
		await this._ensureEmbeddingsLoaded()

		// Embed the query
		const [queryEmbedding] = await this.embeddingService.embed(
			model.providerName,
			model.modelName,
			[query],
			this.voidSettingsService.state.settingsOfProvider,
		)
		if (!queryEmbedding || queryEmbedding.length === 0) return { results: [] }

		// Truncate query embedding to match stored chunk dimensions
		const truncatedQuery = queryEmbedding.length > this._embeddingDimensions ? queryEmbedding.slice(0, this._embeddingDimensions) : queryEmbedding

		// Compute similarity scores
		let scored = this._chunks.map(chunk => ({
			chunk,
			score: cosineSimilarity(truncatedQuery, chunk.embedding),
		}))

		// Filter by include pattern if provided
		if (includePattern) {
			const globRe = globToRegex(includePattern)
			scored = scored.filter(({ chunk }) => globRe.test(chunk.uri))
		}

		// Sort by score descending, take top N
		scored.sort((a, b) => b.score - a.score)
		const topN = scored.slice(0, nResults)

		// Build results — read snippet from source file on demand
		const results: SemanticSearchResult[] = []
		for (const { chunk, score } of topN) {
			let snippet = ''
			try {
				const fileContent = await this.fileService.readFile(URI.file(chunk.uri))
				const text = fileContent.value.toString()
				const lines = text.split('\n')
				const snippetLines = lines.slice(chunk.startLine - 1, chunk.endLine)
				snippet = snippetLines.join('\n')
				if (snippet.length > 200) snippet = snippet.slice(0, 200) + '...'
			} catch {
				snippet = ''
			}
			results.push({
				uri: URI.file(chunk.uri),
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				snippet,
				score,
				indexStatus: this._status,
				indexProgress: this._progress,
			})
		}
		return { results }
	}

	// ---- Persistence ----

	private _indexPath(): URI {
		const folders = this.workspaceContextService.getWorkspace().folders
		const workspaceHash = folders.length > 0 ? String(hash(folders.map(f => f.uri.toString()).join(','))) : 'default'
		return joinPath(this.environmentService.userRoamingDataHome, 'voidSemanticIndex', `${workspaceHash}.json`)
	}

	private _metaPath(): URI {
		const folders = this.workspaceContextService.getWorkspace().folders
		const workspaceHash = folders.length > 0 ? String(hash(folders.map(f => f.uri.toString()).join(','))) : 'default'
		return joinPath(this.environmentService.userRoamingDataHome, 'voidSemanticIndex', `${workspaceHash}.meta.json`)
	}

	// One-time migration: extract metadata from the legacy single-file index
	// (.json) into the new split format (.meta.json). Preserves existing
	// embeddings so users don't need a full re-index on first launch after update.
	private async _migrateFromLegacyIndex(expectedModel: string, indexableUris: URI[]): Promise<string[]> {
		const legacyPath = this._indexPath()
		const legacyExists = await this.fileService.exists(legacyPath)
		if (!legacyExists) return indexableUris.map(u => u.fsPath)

		try {

			const content = await this.fileService.readFile(legacyPath)
			await new Promise<void>(resolve => setTimeout(resolve, 0))
			const index: SemanticIndex = JSON.parse(content.value.toString())

			if (index.version !== INDEX_VERSION || index.embeddingModel !== expectedModel) {
				return indexableUris.map(u => u.fsPath)
			}

			// Populate chunk metadata (no embeddings decoded yet)
			this._chunks = index.chunks.map(sc => ({
				uri: sc.uri,
				startLine: sc.startLine,
				endLine: sc.endLine,
				content: '',
				contentHash: sc.contentHash,
				embedding: [],
			}))
			this._embeddingsLoaded = false
			this._fileHashOfUri = { ...index.fileHashOfUri }
			this._mtimeOfUri = { ...index.mtimeOfUri }
			this._currentEmbeddingModel = expectedModel

			// Write the .meta.json file so future loads are fast
			await this._saveCurrentIndex()


			// Now run the normal mtime check to find changed files
			return await this._checkMtimes(indexableUris)
		} catch {
			return indexableUris.map(u => u.fsPath)
		}
	}

	// Extracted mtime-check logic so both _loadIndex and the migration
	// path can call it without duplicating code.
	private async _checkMtimes(indexableUris: URI[]): Promise<string[]> {
		const fsPathsToEmbed: string[] = []
		for (let idx = 0; idx < indexableUris.length; idx++) {
			if (idx % 50 === 49) {
				await new Promise<void>(resolve => setTimeout(resolve, 0))
			}
			const uri = indexableUris[idx]
			const fsPath = uri.fsPath
			const savedMtime = this._mtimeOfUri[fsPath]
			const savedHash = this._fileHashOfUri[fsPath]

			if (savedHash === undefined) {
				fsPathsToEmbed.push(fsPath)
				continue
			}

			if (savedMtime !== undefined) {
				try {
					const stat = await this.fileService.stat(uri)
					this._mtimeOfUri[fsPath] = stat.mtime
					if (stat.mtime === savedMtime) continue
					const fileContent = await this.fileService.readFile(uri)
					const currentHash = contentHash(fileContent.value.toString())
					if (currentHash === savedHash) continue
					this._chunks = this._chunks.filter(c => c.uri !== fsPath)
					delete this._fileHashOfUri[fsPath]
					fsPathsToEmbed.push(fsPath)
				} catch { }
			} else {
				try {
					const fileContent = await this.fileService.readFile(uri)
					const currentHash = contentHash(fileContent.value.toString())
					if (currentHash === savedHash) continue
					this._chunks = this._chunks.filter(c => c.uri !== fsPath)
					delete this._fileHashOfUri[fsPath]
					fsPathsToEmbed.push(fsPath)
				} catch { }
			}
		}

		const indexableFsPathSet = new Set(indexableUris.map(u => u.fsPath))
		this._chunks = this._chunks.filter(c => indexableFsPathSet.has(c.uri) && !shouldSkipFile(URI.file(c.uri)))
		for (const fsPath of Object.keys(this._fileHashOfUri)) {
			if (!indexableFsPathSet.has(fsPath) || shouldSkipFile(URI.file(fsPath))) {
				delete this._fileHashOfUri[fsPath]
				delete this._mtimeOfUri[fsPath]
			}
		}

		return fsPathsToEmbed
	}

	// Load existing index and return the list of fsPaths that still need embedding.
	// Populates this._chunks, this._fileHashOfUri, this._mtimeOfUri with existing data.
	// Returns all indexable fsPaths that are not yet in the index (or whose content changed).
	private async _loadIndex(expectedModel: string, indexableUris: URI[]): Promise<string[]> {
		try {
			// Try the metadata file first (small, fast to parse). This avoids
			// reading and parsing the ~240MB embeddings file at startup just
			// to check mtimes. Embeddings are loaded lazily by
			// _ensureEmbeddingsLoaded when search() is called.
			const metaPath = this._metaPath()
			const metaExists = await this.fileService.exists(metaPath)
			if (!metaExists) {
				// Migration: if .meta.json doesn't exist but the old .json does,
				// extract metadata from it so we don't lose existing embeddings.
				return this._migrateFromLegacyIndex(expectedModel, indexableUris)
			}

			const metaContent = await this.fileService.readFile(metaPath)
			const meta: IndexMetadata = JSON.parse(metaContent.value.toString())

			if (meta.version !== INDEX_VERSION) return indexableUris.map(u => u.fsPath)
			if (meta.embeddingModel !== expectedModel) return indexableUris.map(u => u.fsPath)

			// Populate chunk metadata WITHOUT embeddings — they'll be decoded
			// lazily by _ensureEmbeddingsLoaded when search is called.
			this._chunks = meta.chunkMetas.map(cm => ({
				uri: cm.uri,
				startLine: cm.startLine,
				endLine: cm.endLine,
				content: '',
				contentHash: cm.contentHash,
				embedding: [],
			}))
			this._embeddingsLoaded = false
			this._fileHashOfUri = { ...meta.fileHashOfUri }
			this._mtimeOfUri = { ...meta.mtimeOfUri }

			return await this._checkMtimes(indexableUris)
		} catch {
			return indexableUris.map(u => u.fsPath)
		}
	}

	// Lazily load and decode embeddings from the full index file. Called
	// from search() before cosine similarity, and before saving if new
	// chunks were added (to preserve existing embeddings). No-op if already
	// loaded. The embeddings file is ~240MB for large workspaces, so this
	// is deferred past startup to avoid freezing the renderer.
	private async _ensureEmbeddingsLoaded(): Promise<void> {
		if (this._embeddingsLoaded) return
		this._embeddingsLoaded = true

		try {
			const path = this._indexPath()
			const exists = await this.fileService.exists(path)
			if (!exists) return

			const content = await this.fileService.readFile(path)
			await new Promise<void>(resolve => setTimeout(resolve, 0))
			const index: SemanticIndex = JSON.parse(content.value.toString())

			// Build a lookup of existing embeddings by a composite key so we
			// can match them to the chunk metadata already in _chunks.
			const embeddingOfChunkKey: Record<string, number[]> = {}
			for (let i = 0; i < index.chunks.length; i++) {
				const sc = index.chunks[i]
				const key = `${sc.uri}:${sc.startLine}:${sc.endLine}`
				embeddingOfChunkKey[key] = decodeEmbedding(sc.embedding_b64)
				if (i % 200 === 199) {
					await new Promise<void>(resolve => setTimeout(resolve, 0))
				}
			}

			// Fill in embeddings for chunks that have metadata but no embedding yet
			for (const chunk of this._chunks) {
				const key = `${chunk.uri}:${chunk.startLine}:${chunk.endLine}`
				const emb = embeddingOfChunkKey[key]
				if (emb) {
					chunk.embedding = emb
				}
			}
		} catch (e) {
			console.error('[semanticIndex] Failed to lazily load embeddings:', e)
		}
	}

	private async _saveCurrentIndex(): Promise<void> {
		// Don't save empty indexes — they'd overwrite a valid partial index
		if (this._chunks.length === 0 || !this._currentEmbeddingModel) return

		// Always save the small metadata file (fast, needed at startup)
		try {
			const metaPath = this._metaPath()
			const dir = joinPath(this.environmentService.userRoamingDataHome, 'voidSemanticIndex')
			const dirExists = await this.fileService.exists(dir)
			if (!dirExists) {
				await this.fileService.createFolder(dir)
			}
			const meta: IndexMetadata = {
				version: INDEX_VERSION,
				embeddingModel: this._currentEmbeddingModel,
				fileHashOfUri: this._fileHashOfUri,
				mtimeOfUri: this._mtimeOfUri,
				chunkMetas: this._chunks.map(c => ({
					uri: c.uri,
					startLine: c.startLine,
					endLine: c.endLine,
					contentHash: c.contentHash,
				})),
			}
			await this.fileService.writeFile(metaPath, VSBuffer.fromString(JSON.stringify(meta)))
		} catch (e) {
			console.error('[semanticIndex] Failed to save metadata:', e)
		}

		// If re-embedding happened (some chunks have real embeddings) but old
		// embeddings weren't loaded yet, load them now so we can save a
		// complete index file. Without this, re-embedded chunks' embeddings
		// would be lost on restart because the old chunks have empty arrays.
		const hasNewEmbeddings = this._chunks.some(c => c.embedding.length > 0)
		if (hasNewEmbeddings && !this._embeddingsLoaded) {
			await this._ensureEmbeddingsLoaded()
		}
		if (!this._embeddingsLoaded) return

		try {
			const path = this._indexPath()

			// Save full index with embeddings
			const serializedChunks: SerializedChunk[] = this._chunks.map(c => {
				const truncated = c.embedding.length > this._embeddingDimensions ? c.embedding.slice(0, this._embeddingDimensions) : c.embedding
				return {
					uri: c.uri,
					startLine: c.startLine,
					endLine: c.endLine,
					contentHash: c.contentHash,
					embedding_b64: encodeEmbedding(truncated),
				}
			})
			const index: SemanticIndex = {
				version: INDEX_VERSION,
				embeddingModel: this._currentEmbeddingModel,
				fileHashOfUri: this._fileHashOfUri,
				mtimeOfUri: this._mtimeOfUri,
				chunks: serializedChunks,
			}
			const serialized = JSON.stringify(index)
			await this.fileService.writeFile(path, VSBuffer.fromString(serialized))
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
