/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Finding workspace paths by name.
//
// Two callers want this and they want different things from it:
//
//   * the `search_pathnames_only` tool is answering an LLM, so it returns one page
//     at a time and reports whether another follows;
//   * codespan resolution is answering a click, so it wants the best few matches
//     and has no concept of a page.
//
// They used to share the tool, and the seam between them was the bug: the resolver
// called the tool's `callTool` — which is dispatched straight to the core and skips
// `validateParams` — with `pageNumber: 0`. The core's arithmetic,
// `results.slice(PAGE * (p - 1), PAGE * p - 1 + 1)`, turns that into
// `slice(-500, 0)`: empty for every input. So the fallback never returned a URI, and
// a file the conversation had not already read could not be linked to at all. The
// coercion that would have saved it lives in `validatePageNum`, which maps falsy to
// 1 and which only the validated path reaches.
//
// This function is the unpaginated half. Paging stays with the tool, where a
// 1-based page is part of its contract and is validated before it arrives.

import { CancellationToken } from '../../../../../base/common/cancellation.js'
import { URI } from '../../../../../base/common/uri.js'
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../../services/search/common/search.js'

/** The services a pathname search needs. `ToolCtx` satisfies this. */
export type PathnameSearchServices = {
	queryBuilder: QueryBuilder
	searchService: ISearchService
	workspaceContextService: IWorkspaceContextService
}

/**
 * Every workspace pathname matching `query`, best match first.
 *
 * Unpaginated on purpose — callers that need a page slice it themselves, and
 * callers that need one answer take the first. Results are what the search service
 * already materialises, so this costs no more than the paginated path did.
 *
 * Returns an empty list when no workspace folder is open: the search is scoped to
 * the folders, so a reply that mentions a file is not resolvable without one.
 */
export async function searchWorkspacePathnames(
	services: PathnameSearchServices,
	{ query, includePattern }: { query: string, includePattern?: string | null },
): Promise<URI[]> {
	const folders = services.workspaceContextService.getWorkspace().folders.map((f) => f.uri)
	const searchQuery = services.queryBuilder.file(folders, {
		filePattern: query,
		includePattern: includePattern ?? undefined,
		sortByScore: true,
	})
	const data = await services.searchService.fileSearch(searchQuery, CancellationToken.None)
	return data.results.map(({ resource }) => resource)
}
