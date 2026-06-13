/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { InlineCompletion, } from '../../../../editor/common/languages.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { FeatureName } from '../common/voidSettingsTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
// import { IContextGatheringService } from './contextGatheringService.js';



const allLinebreakSymbols = ['\r\n', '\n']
const _ln = isWindows ? allLinebreakSymbols[0] : allLinebreakSymbols[1]

// The extension this was called from is here - https://github.com/voideditor/void/blob/autocomplete/extensions/void/src/extension/extension.ts


/*
A summary of autotab:

Postprocessing
-one common problem for all models is outputting unbalanced parentheses
we solve this by trimming all extra closing parentheses from the generated string
in future, should make sure parentheses are always balanced

-another problem is completing the middle of a string, eg. "const [x, CURSOR] = useState()"
we complete up to first matchup character
but should instead complete the whole line / block (difficult because of parenthesis accuracy)

-too much info is bad. usually we want to show the user 1 line, and have a preloaded response afterwards
this should happen automatically with caching system
should break preloaded responses into \n\n chunks

Preprocessing
- we don't generate if cursor is at end / beginning of a line (no spaces)
- we generate 1 line if there is text to the right of cursor
- we generate 1 line if variable declaration
- (in many cases want to show 1 line but generate multiple)

State
- cache based on prefix (and do some trimming first)
- when press tab on one line, should have an immediate followup response
to do this, show autocompletes before they're fully finished
- [todo] remove each autotab when accepted
!- [todo] provide type information

Details
-generated results are trimmed up to 1 leading/trailing space
-prefixes are cached up to 1 trailing newline
-
*/


type AutocompletionPredictionType =
	| 'single-line-fill-middle'
	| 'single-line-redo-suffix'
	// | 'multi-line-start-here'
	| 'multi-line-start-on-next-line'
	| 'do-not-predict'

type Autocompletion = {
	type: AutocompletionPredictionType,
	insertText: string,
}

const DEBOUNCE_TIME = 500


// postprocesses the result
// Clean FIM response text — strip chat artifacts that some models append
// after the code (e.g. "Acknowledged", "Sure!", "Here is the code:", etc.)
const cleanFIMText = (text: string): string => {
	// Split into lines and find where code ends and chat artifacts begin.
	// Chat artifacts are typically short lines of natural language after
	// a blank line or at the end of the code. We detect them by checking
	// for lines that don't look like code (no brackets, semicolons,
	// operators, or typical code patterns).
	const lines = text.split('\n')
	let endIdx = lines.length

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim()
		// Empty lines at the end — trim them
		if (line === '') {
			endIdx = i
			continue
		}
		// Check if this line looks like a chat artifact:
		// - Short (under 60 chars)
		// - Contains no code-like characters: { } ( ) [ ] ; = < > / \
		// - Looks like natural language (starts with capital, ends with period/punctuation)
		const isChatArtifact = line.length < 60
			&& !/[{}()\[\];=<>\/\\]/.test(line)
			&& /^[A-Z]/.test(line)
			&& /[.!]$/.test(line)
		if (isChatArtifact) {
			endIdx = i
			continue
		}
		// Not a chat artifact — stop going backwards
		break
	}

	return lines.slice(0, endIdx).join('\n')
}


const removeAllWhitespace = (str: string): string => str.replace(/\s+/g, '');



function getStringUpToUnbalancedClosingParenthesis(s: string, prefix: string): string {

	const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };

	// process all bracets in prefix
	let stack: string[] = []
	const firstOpenIdx = prefix.search(/[[({]/);
	if (firstOpenIdx !== -1) {
		const brackets = prefix.slice(firstOpenIdx).split('').filter(c => '()[]{}'.includes(c));

		for (const bracket of brackets) {
			if (bracket === '(' || bracket === '{' || bracket === '[') {
				stack.push(bracket);
			} else {
				if (stack.length > 0 && stack[stack.length - 1] === pairs[bracket]) {
					stack.pop();
				} else {
					stack.push(bracket);
				}
			}
		}
	}

	// iterate through each character
	for (let i = 0; i < s.length; i++) {
		const char = s[i];

		if (char === '(' || char === '{' || char === '[') { stack.push(char); }
		else if (char === ')' || char === '}' || char === ']') {
			if (stack.length === 0 || stack.pop() !== pairs[char]) { return s.substring(0, i); }
		}
	}
	return s;
}


// further trim the autocompletion
const postprocessAutocompletion = ({ autocompletion, prefixAndSuffix, prefixAtRequestTime }: { autocompletion: Autocompletion, prefixAndSuffix: PrefixAndSuffixInfo, prefixAtRequestTime?: string }) => {

	const { prefix, prefixToTheLeftOfCursor, suffixToTheRightOfCursor } = prefixAndSuffix

	const generatedMiddle = autocompletion.insertText

	let startIdx = 0
	let endIdx = generatedMiddle.length // exclusive bounds

	// If the user typed more characters after the FIM was sent, skip
	// those characters in the completion. E.g. FIM was sent with "if "
	// and returned "frame.processId ...", but user then typed "(" making
	// it "if (". The "f" of "frame" was already typed, so skip it.
	if (prefixAtRequestTime && prefix.startsWith(prefixAtRequestTime)) {
		const extraChars = prefix.slice(prefixAtRequestTime.length)
		if (extraChars.length > 0 && generatedMiddle.startsWith(extraChars)) {
			startIdx = extraChars.length
		}
	}

	// const naiveReturnValue = generatedMiddle.slice(startIdx)
	// console.log('naiveReturnValue: ', JSON.stringify(naiveReturnValue))
	// return [{ insertText: naiveReturnValue, }]

	// do postprocessing for better ux
	// this is a bit hacky but may change a lot

	// if there is space at the start of the completion and user has added it, remove it
	const charToLeftOfCursor = prefixToTheLeftOfCursor.slice(-1)[0] || ''
	const userHasAddedASpace = charToLeftOfCursor === ' ' || charToLeftOfCursor === '\t'
	const rawFirstNonspaceIdx = generatedMiddle.slice(startIdx).search(/[^\t ]/)
	if (rawFirstNonspaceIdx > -1 && userHasAddedASpace) {
		const firstNonspaceIdx = rawFirstNonspaceIdx + startIdx;
		// console.log('p0', startIdx, rawFirstNonspaceIdx)
		startIdx = Math.max(startIdx, firstNonspaceIdx)
	}

	// if user is on a blank line and the generation starts with newline(s), remove them
	const numStartingNewlines = generatedMiddle.slice(startIdx).match(new RegExp(`^${_ln}+`))?.[0].length || 0;
	if (
		!prefixToTheLeftOfCursor.trim()
		&& !suffixToTheRightOfCursor.trim()
		&& numStartingNewlines > 0
	) {
		// console.log('p1', numStartingNewlines)
		startIdx += numStartingNewlines
	}

	// if the generated FIM text matches with the suffix on the current line, stop
	if (autocompletion.type === 'single-line-fill-middle' && suffixToTheRightOfCursor.trim()) { // completing in the middle of a line
		// complete until there is a match
		const rawMatchIndex = generatedMiddle.slice(startIdx).lastIndexOf(suffixToTheRightOfCursor.trim()[0])
		if (rawMatchIndex > -1) {
			// console.log('p2', rawMatchIndex, startIdx, suffixToTheRightOfCursor.trim()[0], 'AAA', generatedMiddle.slice(startIdx))
			const matchIdx = rawMatchIndex + startIdx;
			const matchChar = generatedMiddle[matchIdx]
			if (`{}()[]<>\`'"`.includes(matchChar)) {
				endIdx = Math.min(endIdx, matchIdx)
			}
		}
	}



	// For auto-closed brackets on the current line (e.g. VS Code's
	// ")" after "("), the model produces "condition) {\n\tbody\n}".
	// The ")" duplicates the auto-closed one in the editor. Strip just
	// the ")" from the completion, keeping "{\n\tbody\n}" intact.
	if (suffixToTheRightOfCursor) {
		const firstSuffixChar = suffixToTheRightOfCursor[0]
		if (firstSuffixChar && `)}]>'"`.includes(firstSuffixChar) && removeAllWhitespace(suffixToTheRightOfCursor).length <= 3) {
			const completionText = generatedMiddle.slice(startIdx, endIdx)
			const bracketIdx = completionText.indexOf(firstSuffixChar)
			if (bracketIdx > 0) {
				const before = completionText.slice(0, bracketIdx)
				const after = completionText.slice(bracketIdx + 1)
				endIdx = startIdx + before.length + after.length
			}
		}
	}

	// Trim completion where it starts duplicating existing suffix lines.
	// The FIM model sometimes ignores the suffix and produces code that
	// already exists below the cursor. Match generated lines against
	// suffix lines and trim at the first match (including short lines
	// like ")" or "}" with matching indentation).
	const suffixLinesForMatch = prefixAndSuffix.suffixLines.slice(1) // skip current line
	if (suffixLinesForMatch.length > 0) {
		const completionText = generatedMiddle.slice(startIdx, endIdx)
		const generatedLines = completionText.split(_ln)
		let trimAtLine = generatedLines.length
		for (let i = 0; i < generatedLines.length; i++) {
			const genTrimmed = generatedLines[i].trim()
			if (!genTrimmed) continue // skip blank lines
			for (let j = 0; j < Math.min(suffixLinesForMatch.length, 10); j++) {
				const sufTrimmed = suffixLinesForMatch[j].trim()
				if (!sufTrimmed) continue
				if (genTrimmed !== sufTrimmed) continue
				// Require matching indentation for short lines (<6 chars)
				// like "}", "});", ")" to avoid false positives
				if (genTrimmed.length < 6) {
					const genIndent = generatedLines[i].match(/^(\s*)/)?.[1] ?? ''
					const sufIndent = suffixLinesForMatch[j].match(/^(\s*)/)?.[1] ?? ''
					if (genIndent !== sufIndent) continue
				}
				trimAtLine = i
				break
			}
			if (trimAtLine !== generatedLines.length) break
		}
		if (trimAtLine < generatedLines.length) {
			const newEndIdx = startIdx + generatedLines.slice(0, trimAtLine).join(_ln).length
			endIdx = Math.min(endIdx, newEndIdx)
		}
	}

	// console.log('pFinal', startIdx, endIdx)
	let completionStr = generatedMiddle.slice(startIdx, endIdx)

	// Filter out unbalanced closing parentheses. If we stripped an
	// auto-closed ")" above, the matching "(" in the prefix has already
	// been closed by the editor's auto-close — remove it from the
	// prefix so the function doesn't treat it as an open bracket that
	// matches stray ")" from the model.
	let prefixForBracketCheck = prefix
	if (suffixToTheRightOfCursor) {
		const firstSuffixChar = suffixToTheRightOfCursor[0]
		if (firstSuffixChar && `)}]>'"`.includes(firstSuffixChar) && removeAllWhitespace(suffixToTheRightOfCursor).length <= 3) {
			// Remove the last unmatched "(" that matches the auto-closed ")"
			const lastOpenIdx = prefixForBracketCheck.lastIndexOf('(')
			if (lastOpenIdx !== -1) {
				prefixForBracketCheck = prefixForBracketCheck.slice(0, lastOpenIdx) + prefixForBracketCheck.slice(lastOpenIdx + 1)
			}
		}
	}
	completionStr = getStringUpToUnbalancedClosingParenthesis(completionStr, prefixForBracketCheck)
	// console.log('originalCompletionStr: ', JSON.stringify(generatedMiddle.slice(startIdx)))
	// console.log('finalCompletionStr: ', JSON.stringify(completionStr))


	return completionStr

}

// returns the text in the autocompletion to display, assuming the prefix is already matched
const toInlineCompletions = ({ autocompletion, prefixAndSuffix, position, prefixAtRequestTime }: { autocompletion: Autocompletion, prefixAndSuffix: PrefixAndSuffixInfo, position: Position, prefixAtRequestTime?: string }): { insertText: string, range: Range }[] => {

	let trimmedInsertText = postprocessAutocompletion({ autocompletion, prefixAndSuffix, prefixAtRequestTime })

	let rangeToReplace: Range = new Range(position.lineNumber, position.column, position.lineNumber, position.column)

	// After accepting "if (condition)" with auto-close ")", the
	// multi-line completion starts on the next line (\n\tbody).
	// The auto-close ")" is still on the current line after the
	// cursor. Replace it in the range and prepend ") {" to the
	// insert text. The replaced ")" IS a prefix of ") {\n\tbody".
	if (autocompletion.type === 'multi-line-start-on-next-line' && prefixAndSuffix.suffixToTheRightOfCursor) {
		const firstSuffixChar = prefixAndSuffix.suffixToTheRightOfCursor[0]
		if (firstSuffixChar && `)}]>'"`.includes(firstSuffixChar) && removeAllWhitespace(prefixAndSuffix.suffixToTheRightOfCursor).length <= 3) {
			const suffixEnd = position.column + prefixAndSuffix.suffixToTheRightOfCursor.length
			rangeToReplace = new Range(position.lineNumber, position.column, position.lineNumber, suffixEnd)
			trimmedInsertText = firstSuffixChar + ' {' + trimmedInsertText
		}
	}

	return [{
		insertText: trimmedInsertText,
		range: rangeToReplace,
	}]

}





// returns whether this autocompletion is in the cache
// const doesPrefixMatchAutocompletion = ({ prefix, autocompletion }: { prefix: string, autocompletion: Autocompletion }): boolean => {

// 	const originalPrefix = autocompletion.prefix
// 	const generatedMiddle = autocompletion.result
// 	const originalPrefixTrimmed = trimPrefix(originalPrefix)
// 	const currentPrefixTrimmed = trimPrefix(prefix)

// 	if (currentPrefixTrimmed.length < originalPrefixTrimmed.length) {
// 		return false
// 	}

// 	const isMatch = (originalPrefixTrimmed + generatedMiddle).startsWith(currentPrefixTrimmed)
// 	return isMatch

// }


type PrefixAndSuffixInfo = { prefix: string, suffix: string, prefixLines: string[], suffixLines: string[], prefixToTheLeftOfCursor: string, suffixToTheRightOfCursor: string }
const getPrefixAndSuffixInfo = (model: ITextModel, position: Position): PrefixAndSuffixInfo => {

	const fullText = model.getValue(EndOfLinePreference.LF);

	const cursorOffset = model.getOffsetAt(position)
	const prefix = fullText.substring(0, cursorOffset)
	const suffix = fullText.substring(cursorOffset)


	const prefixLines = prefix.split(_ln)
	const suffixLines = suffix.split(_ln)

	const prefixToTheLeftOfCursor = prefixLines.slice(-1)[0] ?? ''
	const suffixToTheRightOfCursor = suffixLines[0] ?? ''

	return { prefix, suffix, prefixLines, suffixLines, prefixToTheLeftOfCursor, suffixToTheRightOfCursor }

}


type CompletionOptions = {
	predictionType: AutocompletionPredictionType,
	shouldGenerate: boolean,
	llmPrefix: string,
	llmSuffix: string,
	stopTokens: string[],
}
const getCompletionOptions = (prefixAndSuffix: PrefixAndSuffixInfo, relevantContext: string, justAcceptedAutocompletion: boolean): CompletionOptions => {

	let { prefix, suffix, prefixToTheLeftOfCursor, suffixToTheRightOfCursor, suffixLines, prefixLines } = prefixAndSuffix

	// trim prefix and suffix to not be very large
	suffixLines = suffix.split(_ln).slice(0, 25)
	prefixLines = prefix.split(_ln).slice(-25)
	prefix = prefixLines.join(_ln)
	suffix = suffixLines.join(_ln)

	// Strip leading blank lines from the suffix sent to FIM. When
	// there's a blank line between the cursor and the next code, the
	// suffix starts with "\n\n". With stop=\n, the model's first token
	// "\n" triggers stop immediately → empty response. Stripping these
	// prevents that and gives the model useful context.
	const suffixLinesIgnoringThisLine = suffixLines.slice(1)
	const firstNonEmptySuffixLineIdx = suffixLinesIgnoringThisLine.findIndex(line => line.trim() !== '')
	const suffixLinesNoLeadingBlanks = firstNonEmptySuffixLineIdx === -1 ? [] : suffixLinesIgnoringThisLine.slice(firstNonEmptySuffixLineIdx)
	const suffixStringIgnoringThisLine = suffixLinesNoLeadingBlanks.length === 0 ? '' : _ln + suffixLinesNoLeadingBlanks.join(_ln)

	// After accepting "if (condition)", the auto-closed ")" is still
	// on the current line. Include ") {" in the prefix so the model
	// produces body text directly.
	const suffixIsJustBracketAfterAccept = justAcceptedAutocompletion
		&& suffixToTheRightOfCursor
		&& `)}]>'"`.includes(suffixToTheRightOfCursor[0])
		&& removeAllWhitespace(suffixToTheRightOfCursor).length <= 3

	// Decide whether to generate. Don't predict on empty prefix with
	// no context — the model produces garbage in that case.
	const isLinePrefixEmpty = removeAllWhitespace(prefixToTheLeftOfCursor).length === 0
	const isLineEmpty = !prefixToTheLeftOfCursor.trim() && !suffixToTheRightOfCursor.trim()
	const shouldGenerate = isLineEmpty || !isLinePrefixEmpty

	// All completions use stop=\n\n to let the model decide how much
	// to produce. This gives full blocks like "condition) {\n\tbody\n}"
	// in one tab instead of requiring separate condition + body tabs.
	let llmPrefix = prefix
	let llmSuffix = suffixStringIgnoringThisLine

	if (suffixIsJustBracketAfterAccept) {
		// After accepting a condition with auto-close ")", include
		// ") {" in the prefix so the model produces body text.
		llmPrefix = prefix + suffixToTheRightOfCursor[0] + ' {' + _ln
	} else if (prefixToTheLeftOfCursor.trimEnd().endsWith('{')) {
		// Line already ends with "{", predict body on next line
		llmPrefix = prefix + _ln
	}

	let completionOptions: CompletionOptions
	completionOptions = {
		predictionType: suffixIsJustBracketAfterAccept ? 'multi-line-start-on-next-line' : 'single-line-redo-suffix',
		shouldGenerate,
		llmPrefix,
		llmSuffix,
		stopTokens: [`${_ln}${_ln}`] // double newlines — let model produce multi-line
	}

	return completionOptions

}

export interface IAutocompleteService {
	readonly _serviceBrand: undefined;
}

export const IAutocompleteService = createDecorator<IAutocompleteService>('AutocompleteService');

export class AutocompleteService extends Disposable implements IAutocompleteService {

	static readonly ID = 'void.autocompleteService'

	_serviceBrand: undefined;

	private _lastCompletionStart = 0
	private _lastCompletionAccept = 0
	private _pendingRequestId: string | null = null
	// Trigger VS Code to re-query the inline completions provider
	private _triggerInlineCompletions() {
		try {
			const activePane = this._editorService.activeEditorPane
			if (activePane) {
				const control = activePane.getControl()
				if (control && isCodeEditor(control)) {
					const controller = control.getContribution('editor.contrib.inlineCompletionsController') as any
					const model = controller?.model?.get()
					if (model) {
						model.trigger()
					}
				}
			}
		} catch (e) {
			// Ignore
		}
	}

	// used internally by vscode
	// fires after every keystroke and returns the completion to show
	async _provideInlineCompletionItems(
		model: ITextModel,
		position: Position,
		token?: CancellationToken,
	): Promise<InlineCompletion[]> {

		const isEnabled = this._settingsService.state.globalSettings.enableAutocomplete
		if (!isEnabled) return []

		const prefixAndSuffix = getPrefixAndSuffixInfo(model, position)


		// Skip debounce if we just accepted a completion — we want the
		// follow-up (multi-line body) immediately before the
		// justAcceptedAutocompletion flag expires.
		const justAcceptedAutocompletion = Date.now() - this._lastCompletionAccept < 500

		// wait DEBOUNCE_TIME for the user to stop typing
		const thisTime = Date.now()
		this._lastCompletionStart = thisTime
		const didTypingHappenDuringDebounce = justAcceptedAutocompletion ? false : await new Promise((resolve, reject) =>
			setTimeout(() => {
				if (this._lastCompletionStart === thisTime) {
					resolve(false)
				} else {
					resolve(true)
				}
			}, DEBOUNCE_TIME)
		)

		// if more typing happened, then do not go forwards with the request
		if (didTypingHappenDuringDebounce) {
			return []
		}

		// abort any previous pending request
		if (this._pendingRequestId) {
			this._llmMessageService.abort(this._pendingRequestId)
			this._pendingRequestId = null
		}

		const relevantContext = ''
		const { shouldGenerate, predictionType, llmPrefix, llmSuffix, stopTokens } = getCompletionOptions(prefixAndSuffix, relevantContext, justAcceptedAutocompletion)



		if (!shouldGenerate) return []

		// send FIM request and wait for the result. Also store it so if
		// VS Code has abandoned this call (via CancellationToken), the
		// result is available on the next re-query triggered by
		// _triggerInlineCompletions.
		const insertTextPromise = new Promise<string>((resolve, reject) => {
			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'FIMMessage',
				messages: this._convertToLLMMessageService.prepareFIMMessage({
					messages: {
						prefix: llmPrefix,
						suffix: llmSuffix,
						stopTokens: stopTokens,
					}
				}),
				modelSelection: this._settingsService.state.modelSelectionOfFeature['Autocomplete' as FeatureName],
				modelSelectionOptions: (() => {
					const modelSelection = this._settingsService.state.modelSelectionOfFeature['Autocomplete' as FeatureName]
					return modelSelection ? this._settingsService.state.optionsOfModelSelection['Autocomplete' as FeatureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
				})(),
				overridesOfModel: this._settingsService.state.overridesOfModel,
				logging: { loggingName: 'Autocomplete' },
				onText: () => {
					// Non-streaming FIM delivers all text at once in onFinalMessage
				},
					onFinalMessage: ({ fullText }) => {
					this._pendingRequestId = null

					let text = cleanFIMText(fullText)

					// handle special case for predicting starting on the next line, add a newline character
					if (predictionType === 'multi-line-start-on-next-line') {
						text = _ln + text
					}

						resolve(text)
				},
				onError: ({ message }) => {
					this._pendingRequestId = null
					reject(message)
				},
				onAbort: () => {
					this._pendingRequestId = null
					// Don't reject — the FIM stream continues in the
					// background and will resolve via onFinalMessage.
				},
			})
			this._pendingRequestId = requestId
		})

		try {
			const insertText = await insertTextPromise

				if (token?.isCancellationRequested) {
				return []
			}

			const autocompletion: Autocompletion = {
				type: predictionType,
				insertText,
			}
			const inlineCompletions = toInlineCompletions({ autocompletion, prefixAndSuffix, position })
			return inlineCompletions

		} catch (e) {
			return []
		}

	}

	constructor(
		@ILanguageFeaturesService private _langFeatureService: ILanguageFeaturesService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessageService: IConvertToLLMMessageService
	) {
		super()

		this._register(this._langFeatureService.inlineCompletionsProvider.register('*', {
			provideInlineCompletions: async (model, position, context, token) => {
				const items = await this._provideInlineCompletionItems(model, position, token)

				return { items: items, }
			},
			freeInlineCompletions: (completions) => {
				if (completions.items.length > 0) {
					this._lastCompletionAccept = Date.now()
					// After accepting, trigger a follow-up completion
					// (e.g. multi-line body after if(condition))
					this._triggerInlineCompletions()
				}
			},
		}))
	}


}

registerWorkbenchContribution2(AutocompleteService.ID, AutocompleteService, WorkbenchPhase.BlockRestore);


