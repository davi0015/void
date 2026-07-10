/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { forwardRef, ForwardRefExoticComponent, MutableRefObject, RefAttributes, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { IInputBoxStyles, InputBox } from '../../../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { SelectBox } from '../../../../../../../base/browser/ui/selectBox/selectBox.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Checkbox } from '../../../../../../../base/browser/ui/toggle/toggle.js';


import { useAccessor } from './services.js';

import { asCssVariable } from '../../../../../../../platform/theme/common/colorUtils.js';
import { inputBackground, inputForeground } from '../../../../../../../platform/theme/common/colorRegistry.js';
import { useFloating, autoUpdate, offset, flip, shift, size, autoPlacement } from '@floating-ui/react';
import { URI } from '../../../../../../../base/common/uri.js';
import { getBasename, getFolderName } from '../sidebar-tsx/SidebarChat.js';
import { ChevronRight, File, Folder, FolderClosed, LucideProps } from 'lucide-react';
import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';

import { ExtractedSearchReplaceBlock } from '../../../../common/helpers/extractCodeFromResult.js';
import { Edit } from '../../../../common/editCodeServiceTypes.js';
import { IAccessibilitySignalService } from '../../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IEditorProgressService } from '../../../../../../../platform/progress/common/progress.js';
import { detectLanguage } from '../../../../common/helpers/languageHelpers.js';


// type guard
const isConstructor = (f: any)
	: f is { new(...params: any[]): any } => {
	return !!f.prototype && f.prototype.constructor === f;
}

export const WidgetComponent = <CtorParams extends any[], Instance>({ ctor, propsFn, dispose, onCreateInstance, children, className }
	: {
		ctor: { new(...params: CtorParams): Instance } | ((container: HTMLDivElement) => Instance),
		propsFn: (container: HTMLDivElement) => CtorParams, // unused if fn
		onCreateInstance: (instance: Instance) => IDisposable[],
		dispose: (instance: Instance) => void,
		children?: React.ReactNode,
		className?: string
	}
) => {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const instance = isConstructor(ctor) ? new ctor(...propsFn(containerRef.current!)) : ctor(containerRef.current!)
		const disposables = onCreateInstance(instance);
		return () => {
			disposables.forEach(d => d.dispose());
			dispose(instance)
		}
	}, [ctor, propsFn, dispose, onCreateInstance, containerRef])

	return <div ref={containerRef} className={className === undefined ? `w-full` : className}>{children}</div>
}

type GenerateNextOptions = (optionText: string) => Promise<Option[]>

type Option = {
	fullName: string,
	abbreviatedName: string,
	iconInMenu: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>, // type for lucide-react components
} & (
		| { leafNodeType?: undefined, nextOptions: Option[], generateNextOptions?: undefined, }
		| { leafNodeType?: undefined, nextOptions?: undefined, generateNextOptions: GenerateNextOptions, }
		| { leafNodeType: 'File' | 'Folder', uri: URI, nextOptions?: undefined, generateNextOptions?: undefined, }
	)


const isSubsequence = (text: string, pattern: string): boolean => {

	text = text.toLowerCase()
	pattern = pattern.toLowerCase()

	if (pattern === '') return true;
	if (text === '') return false;
	if (pattern.length > text.length) return false;

	const seq: boolean[][] = Array(pattern.length + 1)
		.fill(null)
		.map(() => Array(text.length + 1).fill(false));

	for (let j = 0; j <= text.length; j++) {
		seq[0][j] = true;
	}

	for (let i = 1; i <= pattern.length; i++) {
		for (let j = 1; j <= text.length; j++) {
			if (pattern[i - 1] === text[j - 1]) {
				seq[i][j] = seq[i - 1][j - 1];
			} else {
				seq[i][j] = seq[i][j - 1];
			}
		}
	}
	return seq[pattern.length][text.length];
};


const scoreSubsequence = (text: string, pattern: string): number => {
	if (pattern === '') return 0;

	text = text.toLowerCase();
	pattern = pattern.toLowerCase();

	// We'll use dynamic programming to find the longest consecutive substring
	const n = text.length;
	const m = pattern.length;

	// This will track our maximum consecutive match length
	let maxConsecutive = 0;

	// For each starting position in the text
	for (let i = 0; i < n; i++) {
		// Check for matches starting from this position
		let consecutiveCount = 0;

		// For each character in the pattern
		for (let j = 0; j < m; j++) {
			// If we have a match and we're still within text bounds
			if (i + j < n && text[i + j] === pattern[j]) {
				consecutiveCount++;
			} else {
				// Break on first non-match
				break;
			}
		}

		// Update our maximum
		maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
	}

	return maxConsecutive;
}


function getRelativeWorkspacePath(accessor: ReturnType<typeof useAccessor>, uri: URI): string {
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceFolders = workspaceService.getWorkspace().folders;

	if (!workspaceFolders.length) {
		return uri.fsPath; // No workspace folders, return original path
	}

	// Sort workspace folders by path length (descending) to match the most specific folder first
	const sortedFolders = [...workspaceFolders].sort((a, b) =>
		b.uri.fsPath.length - a.uri.fsPath.length
	);

	// Add trailing slash to paths for exact matching
	const uriPath = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';

	// Check if the URI is inside any workspace folder
	for (const folder of sortedFolders) {


		const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : folder.uri.fsPath + '/';
		if (uriPath.startsWith(folderPath)) {
			// Calculate the relative path by removing the workspace folder path
			let relativePath = uri.fsPath.slice(folder.uri.fsPath.length);
			// Remove leading slash if present
			if (relativePath.startsWith('/')) {
				relativePath = relativePath.slice(1);
			}
			// console.log({ folderPath, relativePath, uriPath });

			return relativePath;
		}
	}

	// URI is not in any workspace folder, return original path
	return uri.fsPath;
}



const numOptionsToShow = 100



// TODO make this unique based on other options
const getAbbreviatedName = (relativePath: string) => {
	return getBasename(relativePath, 1)
}

const getOptionsAtPath = async (accessor: ReturnType<typeof useAccessor>, path: string[], optionText: string): Promise<Option[]> => {

	const toolsService = accessor.get('IToolsService')



	const searchForFilesOrFolders = async (t: string, searchFor: 'files' | 'folders') => {
		try {

			const searchResults = (await (await toolsService.callTool.search_pathnames_only({
				query: t,
				includePattern: null,
				pageNumber: 1,
			})).result).uris

			if (searchFor === 'files') {
				const res: Option[] = searchResults.map(uri => {
					const relativePath = getRelativeWorkspacePath(accessor, uri)
					return {
						leafNodeType: 'File',
						uri: uri,
						iconInMenu: File,
						fullName: relativePath,
						abbreviatedName: getAbbreviatedName(relativePath),
					}
				})
				return res
			}

			else if (searchFor === 'folders') {
				// Extract unique directory paths from the results
				const directoryMap = new Map<string, URI>();

				for (const uri of searchResults) {
					if (!uri) continue;

					// Get the full path and extract directories
					const relativePath = getRelativeWorkspacePath(accessor, uri)
					const pathParts = relativePath.split('/');

					// Get workspace info
					const workspaceService = accessor.get('IWorkspaceContextService');
					const workspaceFolders = workspaceService.getWorkspace().folders;

					// Find the workspace folder containing this URI
					let workspaceFolderUri: URI | undefined;
					if (workspaceFolders.length) {
						// Sort workspace folders by path length (descending) to match the most specific folder first
						const sortedFolders = [...workspaceFolders].sort((a, b) =>
							b.uri.fsPath.length - a.uri.fsPath.length
						);

						// Find the containing workspace folder
						for (const folder of sortedFolders) {
							const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : folder.uri.fsPath + '/';
							const uriPath = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';

							if (uriPath.startsWith(folderPath)) {
								workspaceFolderUri = folder.uri;
								break;
							}
						}
					}

					if (workspaceFolderUri) {
						// Add each directory and its parents to the map
						let currentPath = '';
						for (let i = 0; i < pathParts.length - 1; i++) {
							currentPath = i === 0 ? `/${pathParts[i]}` : `${currentPath}/${pathParts[i]}`;


							// Create a proper directory URI
							const directoryUri = URI.joinPath(
								workspaceFolderUri,
								currentPath.startsWith('/') ? currentPath.substring(1) : currentPath
							);

							directoryMap.set(currentPath, directoryUri);
						}
					}
				}
				// Convert map to array
				return Array.from(directoryMap.entries()).map(([relativePath, uri]) => ({
					leafNodeType: 'Folder',
					uri: uri,
					iconInMenu: Folder, // Folder
					fullName: relativePath,
					abbreviatedName: getAbbreviatedName(relativePath),
				})) satisfies Option[];
			}
		} catch (error) {
			console.error('Error fetching directories:', error);
			return [];
		}
	};


	const allOptions: Option[] = [
		{
			fullName: 'files',
			abbreviatedName: 'files',
			iconInMenu: File,
			generateNextOptions: async (t) => (await searchForFilesOrFolders(t, 'files')) || [],
		},
		{
			fullName: 'folders',
			abbreviatedName: 'folders',
			iconInMenu: Folder,
			generateNextOptions: async (t) => (await searchForFilesOrFolders(t, 'folders')) || [],
		},
	]

	// follow the path in the optionsTree (until the last path element)

	let nextOptionsAtPath = allOptions
	let generateNextOptionsAtPath: GenerateNextOptions | undefined = undefined

	for (const pn of path) {

		const selectedOption = nextOptionsAtPath.find(o => o.fullName.toLowerCase() === pn.toLowerCase())

		if (!selectedOption) return [];

		nextOptionsAtPath = selectedOption.nextOptions! // assume nextOptions exists until we hit the very last option (the path will never contain the last possible option)
		generateNextOptionsAtPath = selectedOption.generateNextOptions

	}


	if (generateNextOptionsAtPath) {

		nextOptionsAtPath = await generateNextOptionsAtPath(optionText)
	}
	else if (path.length === 0 && optionText.trim().length > 0) { // (special case): directly search for both files and folders if optionsPath is empty and there's a search term
		const filesResults = await searchForFilesOrFolders(optionText, 'files') || [];
		const foldersResults = await searchForFilesOrFolders(optionText, 'folders') || [];
		nextOptionsAtPath = [...foldersResults, ...filesResults,]
	}

	const optionsAtPath = nextOptionsAtPath
		.filter(o => isSubsequence(o.fullName, optionText))
		.sort((a, b) => { // this is a hack but good for now
			const scoreA = scoreSubsequence(a.fullName, optionText);
			const scoreB = scoreSubsequence(b.fullName, optionText);
			return scoreB - scoreA;
		})
		.slice(0, numOptionsToShow) // should go last because sorting/filtering should happen on all datapoints

	return optionsAtPath

}



export type TextAreaFns = { setValue: (v: string) => void, enable: () => void, disable: () => void }
type InputBox2Props = {
	initValue?: string | null;
	placeholder: string;
	multiline: boolean;
	enableAtToMention?: boolean;
	fnsRef?: { current: null | TextAreaFns };
	className?: string;
	onChangeText?: (value: string) => void;
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
	onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
	onChangeHeight?: (newHeight: number) => void;
}
export const VoidInputBox2 = forwardRef<HTMLTextAreaElement, InputBox2Props>(function X({ initValue, placeholder, multiline, enableAtToMention, fnsRef, className, onKeyDown, onPaste, onFocus, onBlur, onChangeText }, ref) {


	// mirrors whatever is in ref
	const accessor = useAccessor()

	const chatThreadService = accessor.get('IChatThreadService')
	const languageService = accessor.get('ILanguageService')

	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const selectedOptionRef = useRef<HTMLDivElement>(null);
	const [isMenuOpen, _setIsMenuOpen] = useState(false); // the @ to mention menu
	const setIsMenuOpen: typeof _setIsMenuOpen = (value) => {
		if (!enableAtToMention) { return; } // never open menu if not enabled
		_setIsMenuOpen(value);
	}

	// logic for @ to mention vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
	const [optionPath, setOptionPath] = useState<string[]>([]);
	const [optionIdx, setOptionIdx] = useState<number>(0);
	const [options, setOptions] = useState<Option[]>([]);
	const [optionText, setOptionText] = useState<string>('');
	const [didLoadInitialOptions, setDidLoadInitialOptions] = useState(false);

	const currentPathRef = useRef<string>(JSON.stringify([]));

	// dont show breadcrums if first page and user hasnt typed anything
	const isTypingEnabled = true
	const isBreadcrumbsShowing = optionPath.length === 0 && !optionText ? false : true

	const insertTextAtCursor = (text: string) => {
		const textarea = textAreaRef.current;
		if (!textarea) return;

		// Focus the textarea first
		textarea.focus();

		// delete the @ and set the cursor position
		// Get cursor position
		const startPos = textarea.selectionStart;
		const endPos = textarea.selectionEnd;

		// Get the text before the cursor, excluding the @ symbol that triggered the menu
		const textBeforeCursor = textarea.value.substring(0, startPos - 1);
		const textAfterCursor = textarea.value.substring(endPos);

		// Replace the text including the @ symbol with the selected option
		textarea.value = textBeforeCursor + textAfterCursor;

		// Set cursor position after the inserted text
		const newCursorPos = textBeforeCursor.length;
		textarea.setSelectionRange(newCursorPos, newCursorPos);

		// React's onChange relies on a SyntheticEvent system
		// The best way to ensure it runs is to call callbacks directly
		if (onChangeText) {
			onChangeText(textarea.value);
		}
		adjustHeight();
	};


	const onSelectOption = async () => {

		if (!options.length) { return; }

		const option = options[optionIdx];
		const newPath = [...optionPath, option.fullName]
		const isLastOption = !option.generateNextOptions && !option.nextOptions
		setDidLoadInitialOptions(false)
		if (isLastOption) {
			setIsMenuOpen(false)
			insertTextAtCursor(option.abbreviatedName)

			let newSelection: StagingSelectionItem
			if (option.leafNodeType === 'File') newSelection = {
				type: 'File',
				uri: option.uri,
				language: languageService.guessLanguageIdByFilepathOrFirstLine(option.uri) || '',
				state: { wasAddedAsCurrentFile: false },
			}
			else if (option.leafNodeType === 'Folder') newSelection = {
				type: 'Folder',
				uri: option.uri,
				language: undefined,
				state: undefined,
			}
			else throw new Error(`Unexpected leafNodeType ${option.leafNodeType}`)

			chatThreadService.addNewStagingSelection(newSelection)
		}
		else {


			currentPathRef.current = JSON.stringify(newPath);
			const newOpts = await getOptionsAtPath(accessor, newPath, '') || []
			if (currentPathRef.current !== JSON.stringify(newPath)) { return; }
			setOptionPath(newPath)
			setOptionText('')
			setOptionIdx(0)
			setOptions(newOpts)
			setDidLoadInitialOptions(true)
		}
	}

	const onRemoveOption = async () => {
		const newPath = [...optionPath.slice(0, optionPath.length - 1)]
		currentPathRef.current = JSON.stringify(newPath);
		const newOpts = await getOptionsAtPath(accessor, newPath, '') || []
		if (currentPathRef.current !== JSON.stringify(newPath)) { return; }
		setOptionPath(newPath)
		setOptionText('')
		setOptionIdx(0)
		setOptions(newOpts)
	}

	const onOpenOptionMenu = async () => {
		const newPath: [] = []
		currentPathRef.current = JSON.stringify([]);
		const newOpts = await getOptionsAtPath(accessor, [], '') || []
		if (currentPathRef.current !== JSON.stringify([])) { return; }
		setOptionPath(newPath)
		setOptionText('')
		setIsMenuOpen(true);
		setOptionIdx(0);
		setOptions(newOpts);
	}
	const onCloseOptionMenu = () => {
		setIsMenuOpen(false);
	}

	const onNavigateUp = (step = 1, periodic = true) => {
		if (options.length === 0) return;
		setOptionIdx((prevIdx) => {
			const newIdx = prevIdx - step;
			return periodic ? (newIdx + options.length) % options.length : Math.max(0, newIdx);
		});
	}
	const onNavigateDown = (step = 1, periodic = true) => {
		if (options.length === 0) return;
		setOptionIdx((prevIdx) => {
			const newIdx = prevIdx + step;
			return periodic ? newIdx % options.length : Math.min(options.length - 1, newIdx);
		});
	}

	const onNavigateToTop = () => {
		if (options.length === 0) return;
		setOptionIdx(0);
	}
	const onNavigateToBottom = () => {
		if (options.length === 0) return;
		setOptionIdx(options.length - 1);
	}

	const debounceTimerRef = useRef<number | null>(null);

	useEffect(() => {
		// Cleanup function to cancel any pending timeouts when unmounting
		return () => {
			if (debounceTimerRef.current !== null) {
				window.clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
		};
	}, []);

	// debounced, but immediate if text is empty
	const onPathTextChange = useCallback((newStr: string) => {


		setOptionText(newStr);

		if (debounceTimerRef.current !== null) {
			window.clearTimeout(debounceTimerRef.current);
		}

		currentPathRef.current = JSON.stringify(optionPath);

		const fetchOptions = async () => {
			const newOpts = await getOptionsAtPath(accessor, optionPath, newStr) || [];
			if (currentPathRef.current !== JSON.stringify(optionPath)) { return; }
			setOptions(newOpts);
			setOptionIdx(0);
			debounceTimerRef.current = null;
		};

		// If text is empty, run immediately without debouncing
		if (newStr.trim() === '') {
			fetchOptions();
		} else {
			// Otherwise, set a new timeout to fetch options after a delay
			debounceTimerRef.current = window.setTimeout(fetchOptions, 300);
		}
	}, [optionPath, accessor]);


	const onMenuKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {

		const isCommandKeyPressed = e.altKey || e.ctrlKey || e.metaKey;

		if (e.key === 'ArrowUp') {
			if (isCommandKeyPressed) {
				onNavigateToTop()
			} else {
				if (e.altKey) {
					onNavigateUp(10, false);
				} else {
					onNavigateUp();
				}
			}
		} else if (e.key === 'ArrowDown') {
			if (isCommandKeyPressed) {
				onNavigateToBottom()
			} else {
				if (e.altKey) {
					onNavigateDown(10, false);
				} else {
					onNavigateDown();
				}
			}
		} else if (e.key === 'ArrowLeft') {
			onRemoveOption();
		} else if (e.key === 'ArrowRight') {
			onSelectOption();
		} else if (e.key === 'Enter') {
			onSelectOption();
		} else if (e.key === 'Escape') {
			onCloseOptionMenu()
		} else if (e.key === 'Backspace') {

			if (!optionText) { // No text remaining
				if (optionPath.length === 0) {
					onCloseOptionMenu()
					return; // don't prevent defaults (backspaces the @ symbol)
				} else {
					onRemoveOption();
				}
			}
			else if (isCommandKeyPressed) { // Ctrl+Backspace
				onPathTextChange('')
			}
			else { // Backspace
				onPathTextChange(optionText.slice(0, -1))
			}
		} else if (e.key.length === 1) {
			if (isCommandKeyPressed) { // Ctrl+letter
				// do nothing
			}
			else { // letter
				if (isTypingEnabled) {
					onPathTextChange(optionText + e.key)
				}
			}
		}

		e.preventDefault();
		e.stopPropagation();

	};

	// scroll the selected optionIdx into view on optionIdx and optionText changes
	useEffect(() => {
		if (isMenuOpen && selectedOptionRef.current) {
			selectedOptionRef.current.scrollIntoView({
				behavior: 'instant',
				block: 'nearest',
				inline: 'nearest',
			});
		}
	}, [optionIdx, isMenuOpen, optionText, selectedOptionRef]);

	const measureRef = useRef<HTMLDivElement>(null);
	const gapPx = 2
	const offsetPx = 2
	const {
		x,
		y,
		strategy,
		refs,
		middlewareData,
		update
	} = useFloating({
		open: isMenuOpen,
		onOpenChange: setIsMenuOpen,
		placement: 'bottom',

		middleware: [
			offset({ mainAxis: gapPx, crossAxis: offsetPx }),
			flip({
				boundary: document.body,
				padding: 8
			}),
			shift({
				boundary: document.body,
				padding: 8,
			}),
			size({
				apply({ elements, rects }) {
					// Just set width on the floating element and let content handle scrolling
					Object.assign(elements.floating.style, {
						width: `${Math.max(
							rects.reference.width,
							measureRef.current?.offsetWidth ?? 0
						)}px`
					});
				},
				padding: 8,
				// Use viewport as boundary instead of any parent element
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});
	useEffect(() => {
		if (!isMenuOpen) return;

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;

			// Check if reference is an HTML element before using contains
			const isReferenceHTMLElement = reference && 'contains' in reference;

			if (
				floating &&
				(!isReferenceHTMLElement || !reference.contains(target)) &&
				!floating.contains(target)
			) {
				setIsMenuOpen(false);
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isMenuOpen, refs.floating, refs.reference]);
	// logic for @ to mention ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^


	const [isEnabled, setEnabled] = useState(true)

	const adjustHeight = useCallback(() => {
		const r = textAreaRef.current
		if (!r) return

		r.style.height = 'auto' // set to auto to reset height, then set to new height

		if (r.scrollHeight === 0) return requestAnimationFrame(adjustHeight)
		const h = r.scrollHeight
		const newHeight = Math.min(h + 1, 500) // plus one to avoid scrollbar appearing when it shouldn't
		r.style.height = `${newHeight}px`
	}, []);



	const fns: TextAreaFns = useMemo(() => ({
		setValue: (val) => {
			const r = textAreaRef.current
			if (!r) return
			r.value = val
			onChangeText?.(r.value)
			adjustHeight()
		},
		enable: () => { setEnabled(true) },
		disable: () => { setEnabled(false) },
	}), [onChangeText, adjustHeight])



	useEffect(() => {
		if (initValue)
			fns.setValue(initValue)
	}, [initValue])




	return <>
		<textarea
			autoFocus={false}
			ref={useCallback((r: HTMLTextAreaElement | null) => {
				if (fnsRef)
					fnsRef.current = fns

				refs.setReference(r)

				textAreaRef.current = r
				if (typeof ref === 'function') ref(r)
				else if (ref) ref.current = r
				adjustHeight()
			}, [fnsRef, fns, setEnabled, adjustHeight, ref, refs])}

			onFocus={onFocus}
			onBlur={onBlur}
			onPaste={onPaste}

			disabled={!isEnabled}

			className={`w-full resize-none max-h-[500px] overflow-y-auto text-void-fg-1 placeholder:text-void-fg-3 ${className}`}
			style={{
				// defaultInputBoxStyles
				background: asCssVariable(inputBackground),
				color: asCssVariable(inputForeground)
				// inputBorder: asCssVariable(inputBorder),
			}}

			onInput={useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
				const latestChange = (event.nativeEvent as InputEvent).data;

				if (latestChange === '@') {
					onOpenOptionMenu()
				}

			}, [onOpenOptionMenu, accessor])}

			onChange={useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const r = textAreaRef.current
				if (!r) return
				onChangeText?.(r.value)
				adjustHeight()
			}, [onChangeText, adjustHeight])}

			onKeyDown={useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {

				if (isMenuOpen) {
					onMenuKeyDown(e)
					return;
				}

				if (e.key === 'Backspace') { // TODO allow user to undo this.
					if (!e.currentTarget.value || (e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0)) { // if there is no text or cursor is at position 0, remove a selection
						if (e.metaKey || e.ctrlKey) { // Ctrl+Backspace = remove all
							chatThreadService.popStagingSelections(Number.MAX_SAFE_INTEGER)
						} else { // Backspace = pop 1 selection
							chatThreadService.popStagingSelections(1)
						}
						return;
					}
				}
				if (e.key === 'Enter') {
					// Shift + Enter when multiline = newline
					const shouldAddNewline = e.shiftKey && multiline
					if (!shouldAddNewline) e.preventDefault(); // prevent newline from being created
				}
				onKeyDown?.(e)
			}, [onKeyDown, onMenuKeyDown, multiline])}

			rows={1}
			placeholder={placeholder}
		/>
		{/* <div>{`idx ${optionIdx}`}</div> */}
		{isMenuOpen && (
			<div
				ref={refs.setFloating}
				className="z-[100] border-void-border-3 bg-void-bg-2-alt border rounded shadow-lg flex flex-col overflow-hidden"
				style={{
					position: strategy,
					top: y ?? 0,
					left: x ?? 0,
					width: refs.reference.current instanceof HTMLElement ? refs.reference.current.offsetWidth : 0
				}}
				onWheel={(e) => e.stopPropagation()}
			>
				{/* Breadcrumbs Header */}
				{isBreadcrumbsShowing && <div className="px-2 py-1 text-void-fg-1 bg-void-bg-2-alt border-b border-void-border-3 sticky top-0 bg-void-bg-1 z-10 select-none pointer-events-none">
					{optionText ?
						<div className="flex items-center">
							{/* {optionPath.map((path, index) => (
								<React.Fragment key={index}>
									<span>{path}</span>
									<ChevronRight size={12} className="mx-1" />
								</React.Fragment>
							))} */}
							<span>{optionText}</span>
						</div>
						: <div className='opacity-50'>Enter text to filter...</div>
					}
				</div>}


				{/* Options list */}
				<div className='max-h-[400px] w-full max-w-full overflow-y-auto overflow-x-auto'>
					<div className="w-max min-w-full flex flex-col gap-0 text-nowrap flex-nowrap">
						{options.length === 0 ?
							<div className="text-void-fg-3 px-3 py-0.5">No results found</div>
							: options.map((o, oIdx) => {

								return (
									// Option
									<div
										ref={oIdx === optionIdx ? selectedOptionRef : null}
										key={o.fullName}
										className={`
											flex items-center gap-2
											px-3 py-1 cursor-pointer
											${oIdx === optionIdx ? 'bg-blue-500 text-white/80' : 'bg-void-bg-2-alt text-void-fg-1'}
										`}
										onClick={() => { onSelectOption(); }}
										onMouseMove={() => { setOptionIdx(oIdx) }}
									>
										{<o.iconInMenu size={12} />}

										<span>{o.abbreviatedName}</span>

										{o.fullName && o.fullName !== o.abbreviatedName && <span className="opacity-60 text-sm">{o.fullName}</span>}

										{o.nextOptions || o.generateNextOptions ? (
											<ChevronRight size={12} />
										) : null}

									</div>
								)
							})
						}
					</div>
				</div>
			</div>
		)}
	</>

})


export const VoidSimpleInputBox = ({ value, onChangeValue, placeholder, className, disabled, passwordBlur, compact, ...inputProps }: {
	value: string;
	onChangeValue: (value: string) => void;
	placeholder: string;
	className?: string;
	disabled?: boolean;
	compact?: boolean;
	passwordBlur?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) => {
	// Create a ref for the input element to maintain the same DOM node between renders
	const inputRef = useRef<HTMLInputElement>(null);

	// Track if we need to restore selection
	const selectionRef = useRef<{ start: number | null, end: number | null }>({
		start: null,
		end: null
	});

	// Handle value changes without recreating the input
	useEffect(() => {
		const input = inputRef.current;
		if (input && input.value !== value) {
			// Store current selection positions
			selectionRef.current.start = input.selectionStart;
			selectionRef.current.end = input.selectionEnd;

			// Update the value
			input.value = value;

			// Restore selection if we had it before
			if (selectionRef.current.start !== null && selectionRef.current.end !== null) {
				input.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
			}
		}
	}, [value]);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		onChangeValue(e.target.value);
	}, [onChangeValue]);

	return (
		<input
			ref={inputRef}
			defaultValue={value} // Use defaultValue instead of value to avoid recreation
			onChange={handleChange}
			placeholder={placeholder}
			disabled={disabled}
			className={`w-full resize-none bg-void-bg-1 text-void-fg-1 placeholder:text-void-fg-3 border border-void-border-2 focus:border-void-border-1
				${compact ? 'py-1 px-2' : 'py-2 px-4 '}
				rounded
				${disabled ? 'opacity-50 cursor-not-allowed' : ''}
				${className}`}
			style={{
				...passwordBlur && { WebkitTextSecurity: 'disc' },
				background: asCssVariable(inputBackground),
				color: asCssVariable(inputForeground)
			}}
			{...inputProps}
			type={undefined} // VS Code is doing some annoyingness that breaks paste if this is defined
		/>
	);
};


export const VoidInputBox = ({ onChangeText, onCreateInstance, inputBoxRef, placeholder, isPasswordField, multiline }: {
	onChangeText: (value: string) => void;
	styles?: Partial<IInputBoxStyles>,
	onCreateInstance?: (instance: InputBox) => void | IDisposable[];
	inputBoxRef?: { current: InputBox | null };
	placeholder: string;
	isPasswordField?: boolean;
	multiline: boolean;
}) => {

	const accessor = useAccessor()

	const contextViewProvider = accessor.get('IContextViewService')
	return <WidgetComponent
		className='
			bg-void-bg-1
			@@void-force-child-placeholder-void-fg-1
		'
		ctor={InputBox}
		propsFn={useCallback((container) => [
			container,
			contextViewProvider,
			{
				inputBoxStyles: {
					...defaultInputBoxStyles,
					inputForeground: "var(--vscode-foreground)",
					// inputBackground: 'transparent',
					// inputBorder: 'none',
				},
				placeholder,
				tooltip: '',
				type: isPasswordField ? 'password' : undefined,
				flexibleHeight: multiline,
				flexibleMaxHeight: 500,
				flexibleWidth: false,
			}
		] as const, [contextViewProvider, placeholder, multiline])}
		dispose={useCallback((instance: InputBox) => {
			instance.dispose()
			instance.element.remove()
		}, [])}
		onCreateInstance={useCallback((instance: InputBox) => {
			const disposables: IDisposable[] = []
			disposables.push(
				instance.onDidChange((newText) => onChangeText(newText))
			)
			if (onCreateInstance) {
				const ds = onCreateInstance(instance) ?? []
				disposables.push(...ds)
			}
			if (inputBoxRef)
				inputBoxRef.current = instance;

			return disposables
		}, [onChangeText, onCreateInstance, inputBoxRef])}
	/>
};





export const VoidSlider = ({
	value,
	onChange,
	size = 'md',
	disabled = false,
	min = 0,
	max = 7,
	step = 1,
	className = '',
	width = 200,
}: {
	value: number;
	onChange: (value: number) => void;
	disabled?: boolean;
	size?: 'xxs' | 'xs' | 'sm' | 'sm+' | 'md';
	min?: number;
	max?: number;
	step?: number;
	className?: string;
	width?: number;
}) => {
	// Calculate percentage for position
	const percentage = ((value - min) / (max - min)) * 100;

	// Handle track click
	const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (disabled) return;

		const rect = e.currentTarget.getBoundingClientRect();
		const clickPosition = e.clientX - rect.left;
		const trackWidth = rect.width;

		// Calculate new value
		const newPercentage = Math.max(0, Math.min(1, clickPosition / trackWidth));
		const rawValue = min + newPercentage * (max - min);

		// Special handling to ensure max value is always reachable
		if (rawValue >= max - step / 2) {
			onChange(max);
			return;
		}

		// Normal step calculation
		const steppedValue = Math.round((rawValue - min) / step) * step + min;
		const clampedValue = Math.max(min, Math.min(max, steppedValue));

		onChange(clampedValue);
	};

	// Helper function to handle thumb dragging that respects steps and max
	const handleThumbDrag = (moveEvent: MouseEvent, track: Element) => {
		if (!track) return;

		const rect = (track as HTMLElement).getBoundingClientRect();
		const movePosition = moveEvent.clientX - rect.left;
		const trackWidth = rect.width;

		// Calculate new value
		const newPercentage = Math.max(0, Math.min(1, movePosition / trackWidth));
		const rawValue = min + newPercentage * (max - min);

		// Special handling to ensure max value is always reachable
		if (rawValue >= max - step / 2) {
			onChange(max);
			return;
		}

		// Normal step calculation
		const steppedValue = Math.round((rawValue - min) / step) * step + min;
		const clampedValue = Math.max(min, Math.min(max, steppedValue));

		onChange(clampedValue);
	};

	return (
		<div className={`inline-flex items-center flex-shrink-0 ${className}`}>
			{/* Outer container with padding to account for thumb overhang */}
			<div className={`relative flex-shrink-0 ${disabled ? 'opacity-25' : ''}`}
				style={{
					width,
					// Add horizontal padding equal to half the thumb width
					// paddingLeft: thumbSizePx / 2,
					// paddingRight: thumbSizePx / 2
				}}>
				{/* Track container with adjusted width */}
				<div className="relative w-full">
					{/* Invisible wider clickable area that sits above the track */}
					<div
						className="absolute w-full cursor-pointer"
						style={{
							height: '16px',
							top: '50%',
							transform: 'translateY(-50%)',
							zIndex: 1
						}}
						onClick={handleTrackClick}
					/>

					{/* Track */}
					<div
						className={`relative ${size === 'xxs' ? 'h-0.5' :
							size === 'xs' ? 'h-1' :
								size === 'sm' ? 'h-1.5' :
									size === 'sm+' ? 'h-2' : 'h-2.5'
							} bg-void-bg-2 rounded-full cursor-pointer`}
						onClick={handleTrackClick}
					>
						{/* Filled part of track */}
						<div
							className={`absolute left-0 ${size === 'xxs' ? 'h-0.5' :
								size === 'xs' ? 'h-1' :
									size === 'sm' ? 'h-1.5' :
										size === 'sm+' ? 'h-2' : 'h-2.5'
								} bg-void-fg-1 rounded-full`}
							style={{ width: `${percentage}%` }}
						/>
					</div>

					{/* Thumb */}
					<div
						className={`absolute top-1/2 transform -translate-x-1/2 -translate-y-1/2
							${size === 'xxs' ? 'h-2 w-2' :
								size === 'xs' ? 'h-2.5 w-2.5' :
									size === 'sm' ? 'h-3 w-3' :
										size === 'sm+' ? 'h-3.5 w-3.5' : 'h-4 w-4'
							}
							bg-void-fg-1 rounded-full shadow-md ${disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}
							border border-void-fg-1`}
						style={{ left: `${percentage}%`, zIndex: 2 }}  // Ensure thumb is above the invisible clickable area
						onMouseDown={(e) => {
							if (disabled) return;

							const track = e.currentTarget.previousElementSibling;

							const handleMouseMove = (moveEvent: MouseEvent) => {
								handleThumbDrag(moveEvent, track as Element);
							};

							const handleMouseUp = () => {
								document.removeEventListener('mousemove', handleMouseMove);
								document.removeEventListener('mouseup', handleMouseUp);
								document.body.style.cursor = '';
								document.body.style.userSelect = '';
							};

							document.body.style.userSelect = 'none';
							document.body.style.cursor = 'grabbing';
							document.addEventListener('mousemove', handleMouseMove);
							document.addEventListener('mouseup', handleMouseUp);

							e.preventDefault();
						}}
					/>
				</div>
			</div>
		</div>
	);
};



export const VoidSwitch = ({
	value,
	onChange,
	size = 'md',
	disabled = false,
	...props
}: {
	value: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
	size?: 'xxs' | 'xs' | 'sm' | 'sm+' | 'md';
}) => {
	return (
		<label className="inline-flex items-center" {...props}>
			<div
				onClick={() => !disabled && onChange(!value)}
				className={`
			cursor-pointer
			relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out
			${value ? 'bg-zinc-900 dark:bg-white' : 'bg-white dark:bg-zinc-600'}
			${disabled ? 'opacity-25' : ''}
			${size === 'xxs' ? 'h-3 w-5' : ''}
			${size === 'xs' ? 'h-4 w-7' : ''}
			${size === 'sm' ? 'h-5 w-9' : ''}
			${size === 'sm+' ? 'h-5 w-10' : ''}
			${size === 'md' ? 'h-6 w-11' : ''}
		  `}
			>
				<span
					className={`
			  inline-block transform rounded-full bg-white dark:bg-zinc-900 shadow transition-transform duration-200 ease-in-out
			  ${size === 'xxs' ? 'h-2 w-2' : ''}
			  ${size === 'xs' ? 'h-2.5 w-2.5' : ''}
			  ${size === 'sm' ? 'h-3 w-3' : ''}
			  ${size === 'sm+' ? 'h-3.5 w-3.5' : ''}
			  ${size === 'md' ? 'h-4 w-4' : ''}
			  ${size === 'xxs' ? (value ? 'translate-x-2.5' : 'translate-x-0.5') : ''}
			  ${size === 'xs' ? (value ? 'translate-x-3.5' : 'translate-x-0.5') : ''}
			  ${size === 'sm' ? (value ? 'translate-x-5' : 'translate-x-1') : ''}
			  ${size === 'sm+' ? (value ? 'translate-x-6' : 'translate-x-1') : ''}
			  ${size === 'md' ? (value ? 'translate-x-6' : 'translate-x-1') : ''}
			`}
				/>
			</div>
		</label>
	);
};





// N-way segmented control used for tri-state (or bi-state) settings like the tool auto-approve
// tier mode (off / workspace / all). Renders as a row of individually-rounded pill buttons with
// visible gaps between them, so each option reads as a distinct clickable target. The active pill
// fills with a high-contrast color (matching VoidSwitch's active state) and the inactive pills
// have a subtle bordered look so they're visible against the panel background.
//
// Uses explicit zinc-* Tailwind colors rather than theme variables for the active fill, because
// `void-*` color variables can be subtle in some themes and we want consistent high contrast.
export const VoidSegmentedControl = <T extends string>({
	value,
	onChange,
	options,
	size = 'xs',
	disabled = false,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; title?: string }[];
	size?: 'xxs' | 'xs' | 'sm';
	disabled?: boolean;
}) => {
	// Bigger padding + slightly larger font than VoidSwitch because labels are text, not a dot.
	const btnPad =
		size === 'xxs' ? 'px-2 py-0.5 text-xs' :
			size === 'xs' ? 'px-3 py-1 text-sm' :
				'px-3.5 py-1.5 text-sm'

	return (
		<div
			role="radiogroup"
			className={`inline-flex items-center gap-1 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
		>
			{options.map((opt) => {
				const active = opt.value === value
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={active}
						title={opt.title ?? opt.label}
						onClick={() => !disabled && !active && onChange(opt.value)}
						className={`
							${btnPad}
							rounded
							leading-none
							whitespace-nowrap
							transition-colors duration-75
							border
							${active
								? 'bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-zinc-900 dark:border-white font-medium'
								: 'bg-transparent text-void-fg-3 border-void-border-2 hover:text-void-fg-1 hover:border-void-fg-3 hover:bg-void-bg-2-hover cursor-pointer'}
						`}
					>
						{opt.label}
					</button>
				)
			})}
		</div>
	)
}


export const VoidCheckBox = ({ label, value, onClick, className }: { label: string, value: boolean, onClick: (checked: boolean) => void, className?: string }) => {
	const divRef = useRef<HTMLDivElement | null>(null)
	const instanceRef = useRef<Checkbox | null>(null)

	useEffect(() => {
		if (!instanceRef.current) return
		instanceRef.current.checked = value
	}, [value])


	return <WidgetComponent
		className={className ?? ''}
		ctor={Checkbox}
		propsFn={useCallback((container: HTMLDivElement) => {
			divRef.current = container
			return [label, value, defaultCheckboxStyles] as const
		}, [label, value])}
		onCreateInstance={useCallback((instance: Checkbox) => {
			instanceRef.current = instance;
			divRef.current?.append(instance.domNode)
			const d = instance.onChange(() => onClick(instance.checked))
			return [d]
		}, [onClick])}
		dispose={useCallback((instance: Checkbox) => {
			instance.dispose()
			instance.domNode.remove()
		}, [])}

	/>

}



export const VoidCustomDropdownBox = <T extends NonNullable<any>>({
	options,
	selectedOption,
	onChangeOption,
	getOptionDropdownName,
	getOptionDropdownDetail,
	getOptionDisplayName,
	getOptionsEqual,
	className,
	arrowTouchesText = true,
	matchInputWidth = false,
	gapPx = 0,
	offsetPx = -6,
}: {
	options: T[];
	selectedOption: T | undefined;
	onChangeOption: (newValue: T) => void;
	getOptionDropdownName: (option: T) => string;
	getOptionDropdownDetail?: (option: T) => string;
	getOptionDisplayName: (option: T) => string;
	getOptionsEqual: (a: T, b: T) => boolean;
	className?: string;
	arrowTouchesText?: boolean;
	matchInputWidth?: boolean;
	gapPx?: number;
	offsetPx?: number;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const measureRef = useRef<HTMLDivElement>(null);

	// Replace manual positioning with floating-ui
	const {
		x,
		y,
		strategy,
		refs,
		middlewareData,
		update
	} = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'bottom-start',

		middleware: [
			offset({ mainAxis: gapPx, crossAxis: offsetPx }),
			flip({
				boundary: document.body,
				padding: 8
			}),
			shift({
				boundary: document.body,
				padding: 8,
			}),
			size({
				apply({ availableHeight, elements, rects }) {
					const maxHeight = Math.min(availableHeight)

					Object.assign(elements.floating.style, {
						maxHeight: `${maxHeight}px`,
						overflowY: 'auto',
						// Ensure the width isn't constrained by the parent
						width: `${Math.max(
							rects.reference.width,
							measureRef.current?.offsetWidth ?? 0
						)}px`
					});
				},
				padding: 8,
				// Use viewport as boundary instead of any parent element
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	// if the selected option is null, set the selection to the 0th option
	useEffect(() => {
		if (options.length === 0) return
		if (selectedOption !== undefined) return
		onChangeOption(options[0])
	}, [selectedOption, onChangeOption, options])

	// Handle clicks outside
	useEffect(() => {
		if (!isOpen) return;

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;

			// Check if reference is an HTML element before using contains
			const isReferenceHTMLElement = reference && 'contains' in reference;

			if (
				floating &&
				(!isReferenceHTMLElement || !reference.contains(target)) &&
				!floating.contains(target)
			) {
				setIsOpen(false);
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isOpen, refs.floating, refs.reference]);

	if (selectedOption === undefined)
		return null

	return (
		<div className={`inline-block relative ${className}`}>
			{/* Hidden measurement div */}
			<div
				ref={measureRef}
				className="opacity-0 pointer-events-none absolute -left-[999999px] -top-[999999px] flex flex-col"
				aria-hidden="true"
			>
				{options.map((option) => {
					const optionName = getOptionDropdownName(option);
					const optionDetail = getOptionDropdownDetail?.(option) || '';

					return (
						<div key={optionName + optionDetail} className="flex items-center whitespace-nowrap">
							<div className="w-4" />
							<span className="flex justify-between w-full">
								<span>{optionName}</span>
								<span>{optionDetail}</span>
								<span>______</span>
							</span>
						</div>
					)
				})}
			</div>

			{/* Select Button */}
			<button
				type='button'
				ref={refs.setReference}
				className="flex items-center h-4 bg-transparent whitespace-nowrap hover:brightness-90 w-full"
				onClick={() => setIsOpen(!isOpen)}
			>
				<span className={`truncate ${arrowTouchesText ? 'mr-1' : ''}`}>
					{getOptionDisplayName(selectedOption)}
				</span>
				<svg
					className={`size-3 flex-shrink-0 ${arrowTouchesText ? '' : 'ml-auto'}`}
					viewBox="0 0 12 12"
					fill="none"
				>
					<path
						d="M2.5 4.5L6 8L9.5 4.5"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>

			{/* Dropdown Menu */}
			{isOpen && (
				<div
					ref={refs.setFloating}
					className="z-[100] bg-void-bg-1 border-void-border-3 border rounded shadow-lg"
					style={{
						position: strategy,
						top: y ?? 0,
						left: x ?? 0,
						width: (matchInputWidth
							? (refs.reference.current instanceof HTMLElement ? refs.reference.current.offsetWidth : 0)
							: Math.max(
								(refs.reference.current instanceof HTMLElement ? refs.reference.current.offsetWidth : 0),
								(measureRef.current instanceof HTMLElement ? measureRef.current.offsetWidth : 0)
							))
					}}
					onWheel={(e) => e.stopPropagation()}
				><div className='overflow-auto max-h-80'>

						{options.map((option) => {
							const thisOptionIsSelected = getOptionsEqual(option, selectedOption);
							const optionName = getOptionDropdownName(option);
							const optionDetail = getOptionDropdownDetail?.(option) || '';

							return (
								<div
									key={optionName}
									className={`flex items-center px-2 py-1 pr-4 cursor-pointer whitespace-nowrap
									transition-all duration-100
									${thisOptionIsSelected ? 'bg-blue-500 text-white/80' : 'hover:bg-blue-500 hover:text-white/80'}
								`}
									onClick={() => {
										onChangeOption(option);
										setIsOpen(false);
									}}
								>
									<div className="w-4 flex justify-center flex-shrink-0">
										{thisOptionIsSelected && (
											<svg className="size-3" viewBox="0 0 12 12" fill="none">
												<path
													d="M10 3L4.5 8.5L2 6"
													stroke="currentColor"
													strokeWidth="1.5"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										)}
									</div>
									<span className="flex justify-between items-center w-full gap-x-1">
										<span>{optionName}</span>
										<span className='opacity-60'>{optionDetail}</span>
									</span>
								</div>
							);
						})}
					</div>

				</div>
			)}
		</div>
	);
};



export const _VoidSelectBox = <T,>({ onChangeSelection, onCreateInstance, selectBoxRef, options, className }: {
	onChangeSelection: (value: T) => void;
	onCreateInstance?: ((instance: SelectBox) => void | IDisposable[]);
	selectBoxRef?: React.MutableRefObject<SelectBox | null>;
	options: readonly { text: string, value: T }[];
	className?: string;
}) => {
	const accessor = useAccessor()
	const contextViewProvider = accessor.get('IContextViewService')

	let containerRef = useRef<HTMLDivElement | null>(null);

	return <WidgetComponent
		className={`
			@@select-child-restyle
			@@[&_select]:!void-text-void-fg-3
			@@[&_select]:!void-text-xs
			!text-void-fg-3
			${className ?? ''}
		`}
		ctor={SelectBox}
		propsFn={useCallback((container) => {
			containerRef.current = container
			const defaultIndex = 0;
			return [
				options.map(opt => ({ text: opt.text })),
				defaultIndex,
				contextViewProvider,
				defaultSelectBoxStyles,
			] as const;
		}, [containerRef, options])}

		dispose={useCallback((instance: SelectBox) => {
			instance.dispose();
			containerRef.current?.childNodes.forEach(child => {
				containerRef.current?.removeChild(child)
			})
		}, [containerRef])}

		onCreateInstance={useCallback((instance: SelectBox) => {
			const disposables: IDisposable[] = []

			if (containerRef.current)
				instance.render(containerRef.current)

			disposables.push(
				instance.onDidSelect(e => { onChangeSelection(options[e.index].value); })
			)

			if (onCreateInstance) {
				const ds = onCreateInstance(instance) ?? []
				disposables.push(...ds)
			}
			if (selectBoxRef)
				selectBoxRef.current = instance;

			return disposables;
		}, [containerRef, onChangeSelection, options, onCreateInstance, selectBoxRef])}

	/>;
};

// makes it so that code in the sidebar isnt too tabbed out
const normalizeIndentation = (code: string): string => {
	const lines = code.split('\n')

	let minLeadingSpaces = Infinity

	// find the minimum number of leading spaces
	for (const line of lines) {
		if (line.trim() === '') continue;
		let leadingSpaces = 0;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === '\t' || char === ' ') {
				leadingSpaces += 1;
			} else { break; }
		}
		minLeadingSpaces = Math.min(minLeadingSpaces, leadingSpaces)
	}

	// remove the leading spaces
	return lines.map(line => {
		if (line.trim() === '') return line;

		let spacesToRemove = minLeadingSpaces;
		let i = 0;
		while (spacesToRemove > 0 && i < line.length) {
			const char = line[i];
			if (char === '\t' || char === ' ') {
				spacesToRemove -= 1;
				i++;
			} else { break; }
		}

		return line.slice(i);

	}).join('\n')

}


export type BlockCodeProps = { initValue: string, language?: string, maxHeight?: number, showScrollbars?: boolean, isStreaming?: boolean }

type TokenSpan = { className: string; text: string }

// Module-level cache for tokenized spans: key = language + code
const tokenizedCache = new Map<string, TokenSpan[][]>()
const tokenizedCacheMaxSize = 500

// Inverse of VS Code's strings.escape() (src/vs/base/common/strings.ts),
// which is what tokenizeToString uses to escape span text. It produces
// exactly 3 entities: &lt;, &gt;, &amp;. &amp; must be unescaped last so
// a literal "&amp;" in source code (escaped to "&amp;amp;" by the
// tokenizer) round-trips correctly instead of collapsing to "&".
const unescapeHtml = (s: string): string => {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

// Parse the HTML from _tokenizeToString into a structured token array.
// Output format: array of lines, each line is an array of { className, text } spans.
const parseTokenizedHtml = (html: string): TokenSpan[][] => {
	const lines: TokenSpan[][] = []
	let currentLine: TokenSpan[] = []
	// Match <span class="mtkN ...">text</span> and <br/>
	const spanRe = /<span class="([^"]*)">([^<]*)<\/span>/g
	let match: RegExpExecArray | null
	let lastIndex = 0

	// Strip outer div wrapper
	const inner = html.replace(/^<div class="monaco-tokenized-source">/, '').replace(/<\/div>$/, '')

	while ((match = spanRe.exec(inner)) !== null) {
		// Check for <br/> between last match and this one
		const between = inner.slice(lastIndex, match.index)
		if (between.includes('<br/>')) {
			const parts = between.split('<br/>')
			// Each <br/> ends a line (the first part is after the previous span, ignore it)
			for (let i = 1; i < parts.length; i++) {
				lines.push(currentLine)
				currentLine = []
			}
		}
		currentLine.push({ className: match[1], text: unescapeHtml(match[2]) })
		lastIndex = match.index + match[0].length
	}
	// Check for trailing <br/>
	const trailing = inner.slice(lastIndex)
	if (trailing.includes('<br/>')) {
		const parts = trailing.split('<br/>')
		for (let i = 1; i < parts.length; i++) {
			lines.push(currentLine)
			currentLine = []
		}
	}
	if (currentLine.length > 0) {
		lines.push(currentLine)
	}
	return lines
}

// Lightweight code block — uses VS Code's built-in tokenizer for syntax
// highlighting instead of Monaco editors. Avoids creating/destroying
// heavy editors on every virtualization scroll cycle.
const BlockCode = ({ initValue, language, maxHeight, isStreaming }: BlockCodeProps) => {
	const accessor = useAccessor()
	const languageService = accessor.get('ILanguageService')
	const normalized = normalizeIndentation(initValue)
	const MAX_HEIGHT = maxHeight ?? Infinity
	const maxHeightStyle = MAX_HEIGHT !== Infinity ? { maxHeight: `${MAX_HEIGHT}px` } as React.CSSProperties : undefined
	const selectableStyle: React.CSSProperties = { userSelect: 'text', WebkitUserSelect: 'text' }

	// During streaming, skip tokenization — it's expensive and the content
	// changes every ~200ms anyway. Render plain text until streaming stops.
	const [tokenLines, setTokenLines] = useState<TokenSpan[][] | null>(() => {
		if (isStreaming || !language) return null
		const cacheKey = `${language}\0${normalized}`
		return tokenizedCache.get(cacheKey) ?? null
	})

	useEffect(() => {
		if (isStreaming || !language) {
			setTokenLines(null)
			return
		}
		const cacheKey = `${language}\0${normalized}`
		const cached = tokenizedCache.get(cacheKey)
		if (cached) {
			setTokenLines(cached)
			return
		}
		let disposed = false
		const tokenize = async (attempt: number) => {
			if (disposed) return
			const { tokenizeToString } = await import('../../../../../../../editor/common/languages/textToHtmlTokenizer.js')
			if (disposed) return
			const html = await tokenizeToString(languageService, normalized, language)
			if (disposed || !html) return
			const parsed = parseTokenizedHtml(html)
			// If tokenization produced only flat mtk1 tokens, the grammar
			// wasn't loaded yet. Retry after a delay (extension activation).
			const allSame = parsed.every(line => line.every(span => span.className === 'mtk1'))
			if (allSame && attempt < 3) {
				setTimeout(() => tokenize(attempt + 1), 1000)
				return
			}
			if (tokenizedCache.size > tokenizedCacheMaxSize) {
				const keys = [...tokenizedCache.keys()]
				for (let i = 0; i < 100; i++) tokenizedCache.delete(keys[i])
			}
			tokenizedCache.set(cacheKey, parsed)
			setTokenLines(parsed)
		}
		tokenize(0)
		return () => { disposed = true }
	}, [normalized, language, isStreaming, languageService])

	return (
		<div className='relative z-0 px-2 py-1 bg-void-bg-3' style={{ ...maxHeightStyle, ...selectableStyle }}>
			<pre className='m-0 font-mono text-[13px] leading-[19px] whitespace-pre overflow-x-auto overflow-y-auto text-void-fg-2' style={{ ...maxHeightStyle, ...selectableStyle }}>
				{tokenLines
					? <code className="monaco-tokenized-source">{tokenLines.map((line, i) =>
						<React.Fragment key={i}>
							{i > 0 && '\n'}
							{line.map((span, j) =>
								<span key={j} className={span.className}>{span.text}</span>
							)}
						</React.Fragment>
					)}</code>
					: <code>{normalized}</code>
				}
			</pre>
		</div>
	)
}


// Module-level scheduler that mounts at most one Monaco editor per animation frame.
// When a user scrolls fast through a long chat, many LazyBlockCode placeholders cross
// the IntersectionObserver threshold in quick succession. Without a queue they would
// all call setIsVisible(true) in the same React batch, mounting N Monaco editors
// synchronously on the main thread — visible as scroll jank. The queue rate-limits
// those mounts so scroll stays smooth, at the cost of a small staggered reveal.
const lazyMountQueue: Array<() => void> = []
let lazyMountFlushScheduled = false
const flushLazyMountQueue = () => {
	lazyMountFlushScheduled = false
	const next = lazyMountQueue.shift()
	if (next) {
		try { next() } catch (err) { console.error('[LazyBlockCode] mount callback failed', err) }
	}
	if (lazyMountQueue.length > 0) {
		lazyMountFlushScheduled = true
		requestAnimationFrame(flushLazyMountQueue)
	}
}
const scheduleLazyMount = (cb: () => void) => {
	lazyMountQueue.push(cb)
	if (!lazyMountFlushScheduled) {
		lazyMountFlushScheduled = true
		requestAnimationFrame(flushLazyMountQueue)
	}
}


// BlockCode is now lightweight (<pre><code>), so no need for IntersectionObserver
// or lazy mounting. We keep the export name so call-sites don't change.
export const LazyBlockCode = ({ initValue, language, maxHeight, isStreaming }: BlockCodeProps) => {
	return <BlockCode initValue={initValue} language={language} maxHeight={maxHeight} isStreaming={isStreaming} />
}


export const VoidButtonBgDarken = ({ children, disabled, onClick, className }: { children: React.ReactNode; disabled?: boolean; onClick: () => void; className?: string }) => {
	return <button disabled={disabled}
		className={`px-3 py-1 bg-black/10 dark:bg-white/10 rounded-sm overflow-hidden whitespace-nowrap flex items-center justify-center ${className || ''}`}
		onClick={onClick}
	>{children}</button>
}

// export const VoidScrollableElt = ({ options, children }: { options: ScrollableElementCreationOptions, children: React.ReactNode }) => {
// 	const instanceRef = useRef<DomScrollableElement | null>(null);
// 	const [childrenPortal, setChildrenPortal] = useState<React.ReactNode | null>(null)

// 	return <>
// 		<WidgetComponent
// 			ctor={DomScrollableElement}
// 			propsFn={useCallback((container) => {
// 				return [container, options] as const;
// 			}, [options])}
// 			onCreateInstance={useCallback((instance: DomScrollableElement) => {
// 				instanceRef.current = instance;
// 				setChildrenPortal(createPortal(children, instance.getDomNode()))
// 				return []
// 			}, [setChildrenPortal, children])}
// 			dispose={useCallback((instance: DomScrollableElement) => {
// 				console.log('calling dispose!!!!')
// 				// instance.dispose();
// 				// instance.getDomNode().remove()
// 			}, [])}
// 		>{children}</WidgetComponent>

// 		{childrenPortal}

// 	</>
// }

// export const VoidSelectBox = <T,>({ onChangeSelection, initVal, selectBoxRef, options }: {
// 	initVal: T;
// 	selectBoxRef: React.MutableRefObject<SelectBox | null>;
// 	options: readonly { text: string, value: T }[];
// 	onChangeSelection: (value: T) => void;
// }) => {


// 	return <WidgetComponent
// 		ctor={DropdownMenu}
// 		propsFn={useCallback((container) => {
// 			return [
// 				container, {
// 					contextMenuProvider,
// 					actions: options.map(({ text, value }, i) => ({
// 						id: i + '',
// 						label: text,
// 						tooltip: text,
// 						class: undefined,
// 						enabled: true,
// 						run: () => {
// 							onChangeSelection(value);
// 						},
// 					}))

// 				}] as const;
// 		}, [options, initVal, contextViewProvider])}

// 		dispose={useCallback((instance: DropdownMenu) => {
// 			instance.dispose();
// 			// instance.element.remove()
// 		}, [])}

// 		onCreateInstance={useCallback((instance: DropdownMenu) => {
// 			return []
// 		}, [])}

// 	/>;
// };




// export const VoidCheckBox = ({ onChangeChecked, initVal, label, checkboxRef, }: {
// 	onChangeChecked: (checked: boolean) => void;
// 	initVal: boolean;
// 	checkboxRef: React.MutableRefObject<ObjectSettingCheckboxWidget | null>;
// 	label: string;
// }) => {
// 	const containerRef = useRef<HTMLDivElement>(null);


// 	useEffect(() => {
// 		if (!containerRef.current) return;

// 		// Create and mount the Checkbox using VSCode's implementation

// 		checkboxRef.current = new ObjectSettingCheckboxWidget(
// 			containerRef.current,
// 			themeService,
// 			contextViewService,
// 			hoverService,
// 		);


// 		checkboxRef.current.setValue([{
// 			key: { type: 'string', data: label },
// 			value: { type: 'boolean', data: initVal },
// 			removable: false,
// 			resetable: true,
// 		}])

// 		checkboxRef.current.onDidChangeList((list) => {
// 			onChangeChecked(!!list);
// 		})


// 		// cleanup
// 		return () => {
// 			if (checkboxRef.current) {
// 				checkboxRef.current.dispose();
// 				if (containerRef.current) {
// 					while (containerRef.current.firstChild) {
// 						containerRef.current.removeChild(containerRef.current.firstChild);
// 					}
// 				}
// 				checkboxRef.current = null;
// 			}
// 		};
// 	}, [checkboxRef, label, initVal, onChangeChecked]);

// 	return <div ref={containerRef} className="w-full" />;
// };




// Simple line-level diff using LCS. Returns a unified view where each
// line is tagged as 'same', 'removed', or 'added'.
type DiffLine = { type: 'same' | 'removed' | 'added'; text: string }
const computeLineDiff = (orig: string, final: string): DiffLine[] => {
	const origLines = orig.split('\n')
	const finalLines = final.split('\n')

	// Build LCS table
	const m = origLines.length
	const n = finalLines.length
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = origLines[i - 1] === finalLines[j - 1]
				? dp[i - 1][j - 1] + 1
				: Math.max(dp[i - 1][j], dp[i][j - 1])
		}
	}

	// Backtrack to produce unified diff
	const result: DiffLine[] = []
	let i = m, j = n
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && origLines[i - 1] === finalLines[j - 1]) {
			result.push({ type: 'same', text: origLines[i - 1] })
			i--; j--
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.push({ type: 'added', text: finalLines[j - 1] })
			j--
		} else {
			result.push({ type: 'removed', text: origLines[i - 1] })
			i--
		}
	}
	result.reverse()
	return result
}

// Lightweight diff display with line-level highlighting.
const SingleDiffEditor = ({ block }: { block: ExtractedSearchReplaceBlock, lang?: string }) => {
	const selectableStyle: React.CSSProperties = { userSelect: 'text', WebkitUserSelect: 'text' }
	const notSelectableStyle: React.CSSProperties = { userSelect: 'none', WebkitUserSelect: 'none' }
	const diffLines = useMemo(() => computeLineDiff(block.orig, block.final), [block.orig, block.final])

	return (
		<div className="w-full bg-void-bg-3 text-xs font-mono overflow-x-auto max-h-[300px] overflow-y-auto" style={selectableStyle}>
			<div className="min-w-full inline-block">
				{diffLines.map((line, i) => {
					if (line.type === 'removed') {
						return (
							<div key={i} className="px-2 whitespace-pre leading-[19px] bg-[rgba(255,0,0,0.12)] text-void-fg-4 line-through opacity-60 min-w-full" style={notSelectableStyle}>
								<span className="opacity-50">-</span>{line.text}
							</div>
						)
					}
					if (line.type === 'added') {
						return (
							<div key={i} className="px-2 whitespace-pre leading-[19px] bg-[rgba(0,128,0,0.18)] text-void-fg-2 min-w-full" style={selectableStyle}>
								<span className="opacity-50 select-none">+</span>{line.text}
							</div>
						)
					}
					return (
						<div key={i} className="px-2 whitespace-pre leading-[19px] text-void-fg-2 min-w-full" style={selectableStyle}>
							<span className="opacity-50 select-none"> </span>{line.text}
						</div>
					)
				})}
			</div>
		</div>
	)
}





/**
 * VoidDiffEditor renders search/replace diff blocks as plain text
 * (original + modified sections). Lightweight alternative to Monaco
 * DiffEditorWidget — zero model creation, zero language service activation.
 */
export const VoidDiffEditor = ({ uri, edits, language }: { uri?: any, edits: Edit[], language?: string }) => {
	const accessor = useAccessor();
	const languageService = accessor.get('ILanguageService');

	// Convert Edit[] to the block shape SingleDiffEditor expects
	const blocks: ExtractedSearchReplaceBlock[] = edits.map(e => ({
		state: 'done',
		orig: e.original,
		final: e.delete ? '' : e.updated,
	}));

	// Use detectLanguage for language detection if not provided
	let lang = language;
	if (!lang && blocks.length > 0) {
		lang = detectLanguage(languageService, { uri: uri ?? null, fileContents: blocks[0].orig });
	}

	// If no blocks, show empty state
	if (blocks.length === 0) {
		return <div className="w-full p-4 text-void-fg-4 text-sm">No changes found</div>;
	}

	// Display all blocks
	return (
		<div className="w-full flex flex-col gap-2">
			{blocks.map((block, index) => (
				<div key={index} className="w-full">
					{blocks.length > 1 && (
						<div className="text-void-fg-4 text-xs mb-1 px-1">
							Change {index + 1} of {blocks.length}
						</div>
					)}
					<SingleDiffEditor block={block} lang={lang} />
				</div>
			))}
		</div>
	);
};


