/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Inlined from terminal-suggest/src/fig/shared/errors.ts to keep the shell
// parser self-contained.

const createErrorInstance = (name: string) =>
	class extends Error {
		constructor(message?: string) {
			super(message);
			this.name = `Fig.${name}`;
		}
	};

export const SubstituteAliasError = createErrorInstance('SubstituteAliasError');
export const ConvertCommandError = createErrorInstance('ConvertCommandError');
