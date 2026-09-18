/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Resolving a file mentioned in a chat reply, when the conversation never read it.
//
// `generateCodespanLink` has exactly two ways to place a file-or-folder span: match
// it against the files the thread has *seen* — the user's own selections and
// `read_file` successes — or fall back to a workspace search for the name.
//
// The fallback was dead. It called the agent-facing `search_pathnames_only` tool
// with `pageNumber: 0`, and the tool's core computes
// `results.slice(500 * (p - 1), 500 * p - 1 + 1)`. At p = 0 that is
// `slice(-500, 0)`, which is empty for every input, so the search could not return
// a single URI. The value never got corrected because `callTool` dispatches
// straight to the core and skips `validateParams`, where `validatePageNum` maps
// falsy to 1 — a coercion the LLM path gets and an internal caller does not.
//
// The consequence is the gap this pins: a file the agent *creates* is not a seen
// file (writes do not count), so before the fix it was unreachable by both routes
// and its name in the reply stayed plain text forever.
//
//   npm run test-void -- --only=codespan-file-resolution
//   VOID_EXPECT=lost npm run test-void -- --only=codespan-file-resolution

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

describe('codespan file resolution', () => {

	test('a file the conversation never read resolves by name', async (t) => {
		// Written before launch so the workspace search sees it from the start.
		const dirs = h.createProfile('codespan-search/basic')
		writeFileSync(join(dirs.workspacePath, 'hello_metal.py'), 'print("hello metal")\n')
		mkdirSync(join(dirs.workspacePath, 'src', 'app'), { recursive: true })
		writeFileSync(join(dirs.workspacePath, 'src', 'app', 'main.py'), 'print("main")\n')
		mkdirSync(join(dirs.workspacePath, 'docs'), { recursive: true })
		writeFileSync(join(dirs.workspacePath, 'docs', 'prd.md'), '# prd\n')

		const absolute = join(dirs.workspacePath, 'docs', 'prd.md')

		const s = await h.launchVoid(dirs)
		try {
			const result = await s.page.evaluate(async ({ absolute }) => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId

				const resolve = async (span) => {
					const link = await Promise.race([
						svc.generateCodespanLink({ codespanStr: span, threadId: id }),
						new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000)),
					])
					if (link === 'TIMEOUT') return { span, timeout: true }
					return { span, resolved: !!link, path: link?.uri?.path, displayText: link?.displayText }
				}

				const spans = [
					'hello_metal.py',
					'main.py',
					'docs/prd.md',
					'src/app/main.py',
					'./docs/prd.md',
					absolute,
					'python hello_metal.py',
				]
				const results = []
				for (const span of spans) results.push(await resolve(span))

				return { seen: svc._getAllSeenFileURIs(id).map((u) => u.path), results }
			}, { absolute })

			// Guard, holding in every configuration: the thread has read nothing.
			assert.deepEqual(result.seen, [], 'fixture: the thread must have no seen files, or the search is not what is under test')

			for (const r of result.results) {
				t.diagnostic(`${JSON.stringify(r.span).padEnd(46)} -> ${r.timeout ? 'TIMEOUT' : r.resolved ? 'LINK ' + (r.path ?? '').replace(dirs.workspacePath, '') : 'plain'}`)
			}

			// Every shape a reply might name a file in, including the two that carry a
			// leading separator: an absolute path inside the workspace, and a `./`
			// prefix. Both matched nothing before the pattern was reduced to a path
			// relative to a folder.
			const bySpan = new Map(result.results.map((r) => [r.span, r]))
			const expectLink = (span, suffix) => {
				const r = bySpan.get(span)
				assert.ok(r, `no result recorded for ${JSON.stringify(span)}`)
				assert.ok(!r.timeout, `${JSON.stringify(span)}: the search never returned — hanging, not answering`)
				h.assertPersistence(`a file named as ${JSON.stringify(span)} resolves`, r.resolved, { subject: true })
				// Only meaningful once it resolved, so an inverted run skips it rather
				// than reporting a wrong answer it never saw.
				if (r.resolved) assert.ok(r.path?.endsWith(suffix), `${JSON.stringify(span)} resolved to the wrong file: ${r.path}`)
			}

			expectLink('hello_metal.py', 'hello_metal.py')
			expectLink('main.py', 'src/app/main.py')
			expectLink('docs/prd.md', 'docs/prd.md')
			expectLink('src/app/main.py', 'src/app/main.py')
			expectLink('./docs/prd.md', 'docs/prd.md')
			expectLink(absolute, 'docs/prd.md')

			// Control: a span that is a shell command, not a path, must stay plain.
			// It contains a dot, so it is classified as file-or-folder with the whole
			// command as the target — nothing should match it, before or after.
			const command = bySpan.get('python hello_metal.py')
			assert.equal(command.resolved, false, `a command-shaped span became a link: ${JSON.stringify(command)}`)
		} finally {
			await s.close()
		}
	})
})
