/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shell parser copied from extensions/terminal-suggest/src/fig/shell-parser/
// (Fig's MIT-licensed parser). Extended to also extract Command nodes from
// AssignmentList nodes (handles `FOO=bar git status`).

export * from './parser.js';
export * from './command.js';
