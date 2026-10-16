/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Turning a file named in a chat reply into something the workspace search can match.
//
// A reply mentions a file however the model felt like writing it: `hello_metal.py`,
// `docs/prd.md`, `./src/app.py`, or the whole absolute path. The workspace search
// takes a glob matched against each file's path *relative to a workspace folder*, so
// the shapes that carry a leading separator match nothing at all — an absolute path
// inside the workspace and a `./`-prefixed path both fail, which is not obvious from
// reading the resolver, and both appear in real conversations.
//
// Stripping the folder prefix is what makes an absolute path searchable again. The
// one case deliberately left alone is an absolute path *outside* every folder: it is
// returned unchanged so the search finds nothing. Searching for its basename instead
// would happily link `/etc/passwd` to some `passwd` in the workspace, and a missing
// link is a much better failure than a wrong one.
//
// On Windows the two sides of that comparison disagree by construction. The folders
// arrive as `fsPath`s (`c:\Users\me\proj`) while the target is whatever the model
// typed — `C:\Users\me\proj\docs\prd.md`, `c:/Users/me/proj/docs/prd.md`, or either
// case for the drive. Comparing the raw strings and appending a hard-coded `/` meant
// an absolute Windows path could never match, so the one shape this module exists to
// rescue was the one that never worked there. Windows paths are case-insensitive and
// accept both separators, so folding them for the comparison is not a guess.
//
// Pure, and free of services, so the shapes can be pinned by fast unit tests — this
// is the kind of string arithmetic that looks obviously right and is not. Which
// platform's rules apply is a parameter rather than a constant read inside, so the
// tests can pin both from either one.
//
// The remainder is returned with `/` separators and its original casing: it is
// matched against `uri.path`, which uses `/` on every platform, and it has to keep
// the real file's case to be recognisable in the UI.

import { isWindows } from '../../../../base/common/platform.js';

/**
 * The search pattern for a path named in a reply.
 *
 * `folderPaths` are the workspace folders' `fsPath`s.
 *
 * `windows` defaults to the running platform and exists so a test can pin both
 * behaviours on either one. On Windows the comparison folds `\` to `/` and folds
 * ASCII case; on POSIX it does neither, because there a backslash is an ordinary
 * filename character and `Proj` and `proj` are different directories.
 */
export function workspaceRelativeSearchPattern(
	target: string,
	folderPaths: readonly string[],
	{ windows = isWindows }: { windows?: boolean } = {},
): string {
	// Folding is length-preserving by construction — `\` becomes `/` one for one, and
	// only ASCII letters fold — which is what lets the match be found on the folded
	// strings while the result is still cut out of the original.
	const fold = (p: string) => windows
		? p.replace(/\\/g, '/').replace(/[A-Z]/g, (c) => c.toLowerCase())
		: p
	const toSearchForm = (p: string) => windows ? p.replace(/\\/g, '/') : p

	const foldedTarget = fold(target)

	// Longest folder first, so a nested folder is not shadowed by its parent being
	// tried first and matching a shorter prefix.
	const folders = [...folderPaths].sort((a, b) => b.length - a.length)

	for (const folder of folders) {
		if (!folder) continue
		const folded = fold(folder)
		const prefix = folded.endsWith('/') ? folded : folded + '/'
		if (foldedTarget.startsWith(prefix)) return toSearchForm(target.slice(prefix.length))
	}

	// `./docs/prd.md` — the dot segment is not part of any path the search reports.
	// Windows writes the same prefix with a backslash.
	if (target.startsWith('./') || (windows && target.startsWith('.\\'))) return toSearchForm(target.slice(2))

	return target
}
