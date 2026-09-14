/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Runner for the Void end-to-end tests.
//
//   npm run test-void                       all of test/void/*.test.mjs
//   node test/void/run.mjs --only=durable   files matching a substring
//   VOID_EXPECT=lost npm run test-void      invert subject assertions
//
// Discovers the .test.mjs files and hands them to node:test. The discovery
// lives here rather than in the npm script because a shell glob is not expanded
// by cmd.exe, and because passing a directory to node --test is not portable
// across the Node versions this repo builds with.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]

const files = readdirSync(HERE)
	.filter((f) => f.endsWith('.test.mjs'))
	.filter((f) => !only || f.includes(only))
	.sort()
	.map((f) => join(HERE, f))

if (files.length === 0) {
	console.error(only
		? `No test file in test/void matches --only=${only}`
		: 'No *.test.mjs files found in test/void')
	process.exit(2)
}

console.log(`Running ${files.length} Void end-to-end test file(s)`
	+ `${only ? ` matching '${only}'` : ''}`
	+ ` (VOID_EXPECT=${process.env.VOID_EXPECT ?? 'present'})\n`)

// Each file runs in its own process: node:test does this anyway, and it keeps a
// crashed app in one file from taking the rest of the suite with it.
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
