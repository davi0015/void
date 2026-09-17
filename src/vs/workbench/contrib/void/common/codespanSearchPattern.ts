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
// Pure, and free of services, so the shapes can be pinned by fast unit tests — this
// is the kind of string arithmetic that looks obviously right and is not.

/**
 * The search pattern for a path named in a reply.
 *
 * `folderPaths` are the workspace folders' `fsPath`s. Comparison is literal and
 * case-sensitive, so a Windows drive letter written in the other case falls through
 * to the unchanged branch and matches nothing — a missing link, never a wrong one.
 */
export function workspaceRelativeSearchPattern(target: string, folderPaths: readonly string[]): string {
	// Longest folder first, so a nested folder is not shadowed by its parent being
	// tried first and matching a shorter prefix.
	const folders = [...folderPaths].sort((a, b) => b.length - a.length)

	for (const folder of folders) {
		if (!folder) continue
		const prefix = folder.endsWith('/') ? folder : folder + '/'
		if (target.startsWith(prefix)) return target.slice(prefix.length)
	}

	// `./docs/prd.md` — the dot segment is not part of any path the search reports.
	if (target.startsWith('./')) return target.slice(2)

	return target
}
