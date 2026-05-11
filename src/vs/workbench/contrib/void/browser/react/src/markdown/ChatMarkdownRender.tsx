/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { JSX, useEffect, useRef, useState } from 'react'
import { marked, MarkedToken, Token } from 'marked'
import katex from 'katex'

// Module-level content-keyed cache for marked.lexer output. Every tab switch / every
// re-render of a bubble otherwise re-lexes the entire message from scratch, even
// though the content is identical to the previous lex. Cache survives component
// unmount/remount. Bounded with a rough LRU on insertion-order (JS Map preserves it)
// so a long chat session doesn't leak unbounded memory.
const LEXER_CACHE_MAX = 500
const lexerCache = new Map<string, Token[]>()
const cachedLex = (raw: string): Token[] => {
	const hit = lexerCache.get(raw)
	if (hit !== undefined) {
		// refresh recency
		lexerCache.delete(raw)
		lexerCache.set(raw, hit)
		return hit
	}
	const tokens = marked.lexer(raw)
	if (lexerCache.size >= LEXER_CACHE_MAX) {
		const oldest = lexerCache.keys().next().value
		if (oldest !== undefined) lexerCache.delete(oldest)
	}
	lexerCache.set(raw, tokens)
	return tokens
}

// Incremental lexer for streaming. During streaming the string grows by appending
// chunks. Instead of re-lexing the entire string every frame (O(n)), we keep the
// tokens whose raw text hasn't changed (the "stable prefix") and only re-lex the
// tail that was appended. The stable tokens keep their original object references,
// which lets React.memo on RenderToken skip re-rendering them entirely.
//
// The safe split point is "all tokens except the last one" — an unclosed code fence
// or partial paragraph stays as the last token and gets re-lexed each frame until
// the construct is complete.
class IncrementalLexer {
	private _prevString = ''
	private _tokens: Token[] = []

	lex(newString: string): Token[] {
		if (newString === this._prevString) return this._tokens

		if (
			newString.length > this._prevString.length
			&& newString.startsWith(this._prevString)
			&& this._tokens.length > 0
		) {
			// Append-only path: reuse all tokens except the last (which may be incomplete).
			const stable = this._tokens.slice(0, -1)
			const stableLen = stable.reduce((sum, t) => sum + t.raw.length, 0)
			const tail = marked.lexer(newString.slice(stableLen))
			this._tokens = [...stable, ...tail]
		} else {
			// Full re-lex (first call, edit, or non-append change).
			this._tokens = marked.lexer(newString)
		}

		this._prevString = newString
		return this._tokens
	}

	/** Seed the module-level LRU cache with the final tokens so a subsequent
	 *  `cachedLex(string)` call (e.g. from a newly mounted committed message)
	 *  gets an instant hit instead of re-lexing from scratch. */
	populateCache() {
		if (this._prevString && this._tokens.length > 0) {
			if (lexerCache.size >= LEXER_CACHE_MAX) {
				const oldest = lexerCache.keys().next().value
				if (oldest !== undefined) lexerCache.delete(oldest)
			}
			lexerCache.set(this._prevString, this._tokens)
		}
	}

	reset() {
		this._prevString = ''
		this._tokens = []
	}
}

import { convertToVscodeLang, detectLanguage } from '../../../../common/helpers/languageHelpers.js'
import { BlockCodeApplyWrapper } from './ApplyBlockHoverButtons.js'
import { useAccessor } from '../util/services.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { isAbsolute } from '../../../../../../../base/common/path.js'
import { separateOutFirstLine } from '../../../../common/helpers/util.js'
import { LazyBlockCode } from '../util/inputs.js'
import { CodespanLocationLink } from '../../../../common/chatThreadServiceTypes.js'
import { getBasename, getRelative, voidOpenFileFn } from '../sidebar-tsx/SidebarChat.js'


export type ChatMessageLocation = {
	threadId: string;
	messageIdx: number;
}

type ApplyBoxLocation = ChatMessageLocation & { tokenIdx: string }

export const getApplyBoxId = ({ threadId, messageIdx, tokenIdx }: ApplyBoxLocation) => {
	return `${threadId}-${messageIdx}-${tokenIdx}`
}

function isValidUri(s: string): boolean {
	return s.length > 5 && isAbsolute(s) && !s.includes('//') && !s.includes('/*') // common case that is a false positive is comments like //
}

// renders contiguous string of latex eg $e^{i\pi}$
const LatexRender = ({ latex }: { latex: string }) => {
	const ref = useRef<HTMLSpanElement>(null);

	let formula = latex;
	let displayMode = false;

	if (latex.startsWith('$$') && latex.endsWith('$$')) {
		formula = latex.slice(2, -2);
		displayMode = true;
	} else if (latex.startsWith('$') && latex.endsWith('$')) {
		formula = latex.slice(1, -1);
	} else if (latex.startsWith('\\[') && latex.endsWith('\\]')) {
		formula = latex.slice(2, -2);
		displayMode = true;
	} else if (latex.startsWith('\\(') && latex.endsWith('\\)')) {
		formula = latex.slice(2, -2);
	}

	useEffect(() => {
		if (!ref.current) return;
		try {
			katex.render(formula, ref.current, {
				displayMode,
				throwOnError: false,
				output: 'mathml',
			});
		} catch (err) {
			console.error('[LatexRender] failed:', err);
			ref.current.textContent = latex;
		}
	}, [formula, displayMode, latex]);

	const className = displayMode
		? 'katex-block my-2 text-center'
		: 'katex-inline';

	return <span ref={ref} className={className} />;
}

const Codespan = ({ text, className, onClick, tooltip }: { text: string, className?: string, onClick?: () => void, tooltip?: string }) => {

	// TODO compute this once for efficiency. we should use `labels.ts/shorten` to display duplicates properly

	return <code
		className={`font-mono font-medium rounded-sm bg-void-bg-1 px-1 ${className}`}
		onClick={onClick}
		{...tooltip ? {
			'data-tooltip-id': 'void-tooltip',
			'data-tooltip-content': tooltip,
			'data-tooltip-place': 'top',
		} : {}}
	>
		{text}
	</code>

}

const CodespanWithLink = ({ text, rawText, chatMessageLocation }: { text: string, rawText: string, chatMessageLocation: ChatMessageLocation }) => {

	const accessor = useAccessor()

	const chatThreadService = accessor.get('IChatThreadService')
	const commandService = accessor.get('ICommandService')
	const editorService = accessor.get('ICodeEditorService')

	const { messageIdx, threadId } = chatMessageLocation

	const [didComputeCodespanLink, setDidComputeCodespanLink] = useState<boolean>(false)

	let link: CodespanLocationLink | undefined = undefined
	let tooltip: string | undefined = undefined
	let displayText = text


	if (rawText.endsWith('`')) {
		// get link from cache
		link = chatThreadService.getCodespanLink({ codespanStr: text, messageIdx, threadId })

		if (link === undefined) {
			// if no link, generate link and add to cache
			chatThreadService.generateCodespanLink({ codespanStr: text, threadId })
				.then(link => {
					chatThreadService.addCodespanLink({ newLinkText: text, newLinkLocation: link, messageIdx, threadId })
					setDidComputeCodespanLink(true) // rerender
				})
		}

		if (link?.displayText) {
			displayText = link.displayText
		}

		if (isValidUri(displayText)) {
			tooltip = getRelative(URI.file(displayText), accessor)  // Full path as tooltip
			displayText = getBasename(displayText)
		}
	}


	const onClick = () => {
		if (!link) return;
		// Use the updated voidOpenFileFn to open the file and handle selection
		if (link.selection)
			voidOpenFileFn(link.uri, accessor, [link.selection.startLineNumber, link.selection.endLineNumber]);
		else
			voidOpenFileFn(link.uri, accessor);
	}

	return <Codespan
		text={displayText}
		onClick={onClick}
		className={link ? 'underline hover:brightness-90 transition-all duration-200 cursor-pointer' : ''}
		tooltip={tooltip || undefined}
	/>
}


// Matches all LaTeX delimiters: $$...$$, \[...\], $...$, \(...\)
// Display variants are matched first (longer delimiters) to avoid partial matches.
const LATEX_RE_SOURCE = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\$((?!\$)(?:\\.|[^$])*?)\$|\\\(((?:\\.|[^)])*?)\\\)/.source;

type LatexSegment = { type: 'text', content: string } | { type: 'latex', content: string };

const splitLatexSegments = (paragraphText: string): LatexSegment[] | null => {
	if (
		!paragraphText
		|| paragraphText.includes('#') || paragraphText.includes('`')
		|| !/[$\\]/.test(paragraphText)
	) {
		return null;
	}

	const latexPattern = new RegExp(LATEX_RE_SOURCE, 'g');
	if (!latexPattern.test(paragraphText)) return null;

	latexPattern.lastIndex = 0;
	const segments: LatexSegment[] = [];
	let lastIndex = 0;
	let match;

	while ((match = latexPattern.exec(paragraphText)) !== null) {
		const [fullMatch] = match;
		const matchIndex = match.index;

		if (matchIndex > lastIndex) {
			segments.push({ type: 'text', content: paragraphText.substring(lastIndex, matchIndex) });
		}

		segments.push({ type: 'latex', content: fullMatch });
		lastIndex = matchIndex + fullMatch.length;
	}

	if (segments.length > 0 && lastIndex < paragraphText.length) {
		segments.push({ type: 'text', content: paragraphText.substring(lastIndex) });
	}

	return segments.length > 0 ? segments : null;
}


export type RenderTokenOptions = { isApplyEnabled?: boolean, isLinkDetectionEnabled?: boolean, isStreaming?: boolean }

type RenderTokenProps = { token: Token | string, inPTag?: boolean, codeURI?: URI, chatMessageLocation?: ChatMessageLocation, tokenIdx: string } & RenderTokenOptions

const RenderToken = React.memo(({ token, inPTag, codeURI, chatMessageLocation, tokenIdx, ...options }: RenderTokenProps): React.ReactNode => {
	const accessor = useAccessor()
	const languageService = accessor.get('ILanguageService')

	// deal with built-in tokens first (assume marked token)
	const t = token as MarkedToken

	if (t.raw.trim() === '') {
		return null;
	}

	if (t.type === 'space') {
		return <span>{t.raw}</span>
	}

	if (t.type === 'code') {
		const [firstLine, remainingContents] = separateOutFirstLine(t.text)
		const firstLineIsURI = isValidUri(firstLine) && !codeURI
		const contents = firstLineIsURI ? (remainingContents?.trimStart() || '') : t.text // exclude first-line URI from contents

		if (!contents) return null

		// figure out langauge and URI
		let uri: URI | null
		let language: string
		if (codeURI) {
			uri = codeURI
		}
		else if (firstLineIsURI) { // get lang from the uri in the first line of the markdown
			uri = URI.file(firstLine)
		}
		else {
			uri = null
		}

		if (t.lang) { // a language was provided. empty string is common so check truthy, not just undefined
			language = convertToVscodeLang(languageService, t.lang) // convert markdown language to language that vscode recognizes (eg markdown doesn't know bash but it does know shell)
		}
		else { // no language provided - fallback - get lang from the uri and contents
			language = detectLanguage(languageService, { uri, fileContents: contents })
		}

		if (options.isApplyEnabled && chatMessageLocation) {
			const isCodeblockClosed = t.raw.trimEnd().endsWith('```') // user should only be able to Apply when the code has been closed (t.raw ends with '```')

			const applyBoxId = getApplyBoxId({
				threadId: chatMessageLocation.threadId,
				messageIdx: chatMessageLocation.messageIdx,
				tokenIdx: tokenIdx,
			})
			return <BlockCodeApplyWrapper
				canApply={isCodeblockClosed}
				applyBoxId={applyBoxId}
				codeStr={contents}
				language={language}
				uri={uri || 'current'}
			>
				<LazyBlockCode
					initValue={contents.trimEnd()} // \n\n adds a permanent newline which creates a flash
					language={language}
					isStreaming={options.isStreaming}
				/>
			</BlockCodeApplyWrapper>
		}

		return <LazyBlockCode
			initValue={contents}
			language={language}
			isStreaming={options.isStreaming}
		/>
	}

	if (t.type === 'heading') {

		const HeadingTag = `h${t.depth}` as keyof JSX.IntrinsicElements

		return <HeadingTag>
			<ChatMarkdownRender chatMessageLocation={chatMessageLocation} string={t.text} inPTag={true} codeURI={codeURI} {...options} />
		</HeadingTag>
	}

	if (t.type === 'table') {

		return (
			<div>
				<table>
					<thead>
						<tr>
							{t.header.map((h, hIdx: number) => (
								<th key={hIdx}>
									{h.text}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{t.rows.map((row, rowIdx: number) => (
							<tr key={rowIdx}>
								{row.map((r, rIdx: number) => (
									<td key={rIdx} >
										{r.text}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		)
		// return (
		// 	<div>
		// 		<table className={'min-w-full border border-void-bg-2'}>
		// 			<thead>
		// 				<tr className='bg-void-bg-1'>
		// 					{t.header.map((cell: any, index: number) => (
		// 						<th
		// 							key={index}
		// 							className='px-4 py-2 border border-void-bg-2 font-semibold'
		// 							style={{ textAlign: t.align[index] || 'left' }}
		// 						>
		// 							{cell.raw}
		// 						</th>
		// 					))}
		// 				</tr>
		// 			</thead>
		// 			<tbody>
		// 				{t.rows.map((row: any[], rowIndex: number) => (
		// 					<tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-white' : 'bg-void-bg-1'}>
		// 						{row.map((cell: any, cellIndex: number) => (
		// 							<td
		// 								key={cellIndex}
		// 								className={'px-4 py-2 border border-void-bg-2'}
		// 								style={{ textAlign: t.align[cellIndex] || 'left' }}
		// 							>
		// 								{cell.raw}
		// 							</td>
		// 						))}
		// 					</tr>
		// 				))}
		// 			</tbody>
		// 		</table>
		// 	</div>
		// )
	}

	if (t.type === 'hr') {
		return <hr />
	}

	if (t.type === 'blockquote') {
		return <blockquote>{t.text}</blockquote>
	}

	if (t.type === 'list_item') {
		return <li>
			<input type='checkbox' checked={t.checked} readOnly />
			<span>
				<ChatMarkdownRender chatMessageLocation={chatMessageLocation} string={t.text} inPTag={true} codeURI={codeURI} {...options} />
			</span>
		</li>
	}

	if (t.type === 'list') {
		const ListTag = t.ordered ? 'ol' : 'ul'

		return (
			<ListTag start={t.start ? t.start : undefined}>
				{t.items.map((item, index) => (
					<li key={index}>
						{item.task && (
							<input type='checkbox' checked={item.checked} readOnly />
						)}
						<span>
							<ChatMarkdownRender chatMessageLocation={chatMessageLocation} string={item.text} inPTag={true} {...options} />
						</span>
					</li>
				))}
			</ListTag>
		)
	}

	if (t.type === 'paragraph') {

		// check for latex
		const latexSegments = splitLatexSegments(t.raw)
		if (latexSegments !== null) {
			const rendered = latexSegments.map((seg, i) =>
				seg.type === 'latex'
					? <LatexRender key={`latex-${i}`} latex={seg.content} />
					: <ChatMarkdownRender key={`text-${i}`} chatMessageLocation={chatMessageLocation} string={seg.content} inPTag={true} {...options} />
			);
			if (inPTag) {
				return <span className='block'>{rendered}</span>;
			}
			return <p>{rendered}</p>;
		}

		// if no latex, default behavior
		const contents = <>
			{t.tokens.map((token, index) => (
				<RenderToken key={index}
					token={token}
					tokenIdx={`${tokenIdx ? `${tokenIdx}-` : ''}${index}`} // assign a unique tokenId to inPTag components
					chatMessageLocation={chatMessageLocation}
					inPTag={true}
					{...options}
				/>
			))}
		</>

		if (inPTag) return <span className='block'>{contents}</span>
		return <p>{contents}</p>
	}

	if (t.type === 'text' || t.type === 'escape' || t.type === 'html') {
		return <span>{t.raw}</span>
	}

	if (t.type === 'def') {
		return <></> // Definitions are typically not rendered
	}

	if (t.type === 'link') {
		return (
			<a
				onClick={() => { window.open(t.href) }}
				href={t.href}
				title={t.title ?? undefined}
				className='underline cursor-pointer hover:brightness-90 transition-all duration-200 text-void-fg-2'
			>
				{t.text}
			</a>
		)
	}

	if (t.type === 'image') {
		return <img
			src={t.href}
			alt={t.text}
			title={t.title ?? undefined}

		/>
	}

	if (t.type === 'strong') {
		return <strong>{t.text}</strong>
	}

	if (t.type === 'em') {
		return <em>{t.text}</em>
	}

	// inline code
	if (t.type === 'codespan') {

		if (options.isLinkDetectionEnabled && chatMessageLocation) {
			return <CodespanWithLink
				text={t.text}
				rawText={t.raw}
				chatMessageLocation={chatMessageLocation}
			/>

		}

		return <Codespan text={t.text} />
	}

	if (t.type === 'br') {
		return <br />
	}

	// strikethrough
	if (t.type === 'del') {
		return <del>{t.text}</del>
	}
	// default
	return (
		<div className='bg-orange-50 rounded-sm overflow-hidden p-2'>
			<span className='text-sm text-orange-500'>Unknown token rendered...</span>
		</div>
	)
})


export const ChatMarkdownRender = ({ string, inPTag = false, chatMessageLocation, ...options }: { string: string, inPTag?: boolean, codeURI?: URI, chatMessageLocation: ChatMessageLocation | undefined } & RenderTokenOptions) => {
	string = string.replaceAll('\n•', '\n\n•')

	const incrementalLexerRef = useRef<IncrementalLexer | null>(null)
	const wasStreamingRef = useRef(false)

	// When the streaming component unmounts (stream ends, bubble replaced by
	// committed message), seed the LRU cache so the new committed bubble's
	// cachedLex() call is an instant hit instead of a full re-lex.
	useEffect(() => {
		return () => {
			incrementalLexerRef.current?.populateCache()
		}
	}, [])

	let tokens: Token[]
	if (options.isStreaming) {
		if (!incrementalLexerRef.current) {
			incrementalLexerRef.current = new IncrementalLexer()
		}
		tokens = incrementalLexerRef.current.lex(string)
		wasStreamingRef.current = true
	} else {
		if (wasStreamingRef.current) {
			// Streaming just finished — discard incremental state and populate
			// the static LRU cache so future re-renders (tab switch etc.) are fast.
			incrementalLexerRef.current?.populateCache()
			incrementalLexerRef.current?.reset()
			incrementalLexerRef.current = null
			wasStreamingRef.current = false
		}
		tokens = cachedLex(string)
	}

	return (
		<>
			{tokens.map((token, index) => (
				<RenderToken key={index} token={token} inPTag={inPTag} chatMessageLocation={chatMessageLocation} tokenIdx={index + ''} {...options} />
			))}
		</>
	)
}
