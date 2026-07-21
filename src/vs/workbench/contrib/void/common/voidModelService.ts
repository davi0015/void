import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

type VoidModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

export interface IVoidModelService {
	readonly _serviceBrand: undefined;
	initializeModel(uri: URI): Promise<void>;
	releaseModel(uri: URI): void;
	getModel(uri: URI): VoidModelType;
	getModelFromFsPath(fsPath: string): VoidModelType;
	getModelSafe(uri: URI): Promise<VoidModelType>;
	withModel<T>(uri: URI, fn: (model: VoidModelType) => T): T;
	asyncWithModel<T>(uri: URI, fn: (model: VoidModelType) => Promise<T>): Promise<T>;
	saveModel(uri: URI): Promise<void>;

}

export const IVoidModelService = createDecorator<IVoidModelService>('voidVoidModelService');

class VoidModelService extends Disposable implements IVoidModelService {
	_serviceBrand: undefined;
	static readonly ID = 'voidVoidModelService';
	private readonly _modelRefOfURI: Record<string, IReference<IResolvedTextEditorModel>> = {};

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super();
	}

	saveModel = async (uri: URI) => {
		await this._textFileService.save(uri, { // we want [our change] -> [save] so it's all treated as one change.
			skipSaveParticipants: true // avoid triggering extensions etc (if they reformat the page, it will add another item to the undo stack)
		})
	}

	private static readonly _BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.mp3', '.mp4', '.wav', '.ogg', '.zip', '.tar', '.gz', '.pdf', '.woff', '.woff2', '.ttf', '.eot'])

	initializeModel = async (uri: URI) => {
		try {
			if (uri.fsPath in this._modelRefOfURI) return;
			const ext = uri.fsPath.slice(uri.fsPath.lastIndexOf('.')).toLowerCase()
			if (VoidModelService._BINARY_EXTENSIONS.has(ext)) return;
			const editorModelRef = await this._textModelService.createModelReference(uri);
			// Keep a strong reference to prevent disposal
			this._modelRefOfURI[uri.fsPath] = editorModelRef;
		}
		catch (e) {
			console.log('InitializeModel error:', e)
		}
	};


	// Release a model reference. Called internally by acquireModel and withModel.
	// Models for files open in editor tabs are kept alive by the editor's
	// own model service — we only release our extra reference here. Safe to
	// call even if the model was never initialized or already released.
	releaseModel = (uri: URI) => {
		const ref = this._modelRefOfURI[uri.fsPath]
		if (!ref) return
		ref.dispose()
		delete this._modelRefOfURI[uri.fsPath]
	};

	getModelFromFsPath = (fsPath: string): VoidModelType => {
		const editorModelRef = this._modelRefOfURI[fsPath];
		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}

		const model = editorModelRef.object.textEditorModel;

		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}

		return { model, editorModel: editorModelRef.object };
	};

	getModel = (uri: URI) => {
		return this.getModelFromFsPath(uri.fsPath)
	}


	getModelSafe = async (uri: URI): Promise<VoidModelType> => {
		if (!(uri.fsPath in this._modelRefOfURI)) await this.initializeModel(uri);
		return this.getModel(uri);
	};

	// Use a model for a read-only operation. The ref is automatically released
	// when the callback returns — callers never need to remember releaseModel.
	// The model must already be initialized (e.g. via getModelSafe during tool execution).
	withModel = <T>(uri: URI, fn: (model: VoidModelType) => T): T => {
		const result = this.getModel(uri)
		try {
			return fn(result)
		} finally {
			this.releaseModel(uri)
		}
	}

	// Use a model for an async read-only operation (e.g. LSP queries that
	// await provider.provideDefinition). Like withModel, but awaits the
	// callback before releasing the reference so async work completes first.
	asyncWithModel = async <T>(uri: URI, fn: (model: VoidModelType) => Promise<T>): Promise<T> => {
		if (!(uri.fsPath in this._modelRefOfURI)) await this.initializeModel(uri);
		try {
			return await fn(this.getModel(uri));
		} finally {
			this.releaseModel(uri);
		}
	}

	override dispose() {
		super.dispose();
		for (const ref of Object.values(this._modelRefOfURI)) {
			ref.dispose(); // release reference to allow disposal
		}
	}
}

registerSingleton(IVoidModelService, VoidModelService, InstantiationType.Eager);
