/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Image ownership (S5 — bugs 6, 7 and 8).
//
// Every image ever pasted into any thread lands in one flat directory,
// `<userRoamingDataHome>/voidImages/<uuid>.<ext>`. A message stores that uri.
// `duplicateThread` deep-clones the messages, so the copy stores the *same*
// uri — two threads, one file — and `deleteThread` decides what to delete by
// scanning the messages of the thread being deleted. Deleting the original
// therefore deletes a file the duplicate still renders.
//
// The fix is ownership rather than a cleverer scan: an image is written under
// `threads/<threadId>/images/`, so a thread's images can be deleted with the
// thread and nothing else has to be consulted.
//
// The invariant these scenarios pin is narrower than "images are thread-owned":
//
//     no code path deletes a file it does not own.
//
// That is what makes the change shippable before the migration. Images written
// before the change stay in the flat directory and are never migrated here —
// `thread-storage.md` §1.5 step 4 does that as one pass in S10. Until then they
// are simply *not deleted*, which leaks bytes instead of losing renders.
//
//   npm run test-void -- --only=image-ownership
//   VOID_EXPECT=lost npm run test-void -- --only=image-ownership

import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as h from './harness.mjs'

before(() => h.preflight())

/** Prints storage traces when a scenario fails, so CI logs are diagnosable. */
function trace(t, session) {
	for (const line of session.log.slice(-5)) t.diagnostic(line)
}

// A selection's `uri` reaches storage marshalled and comes back through
// `ChatThreadService._storageReviver`, which turns any `$mid === 1` object into
// a real URI — `_fileService.del` and the path getters both need the real thing,
// not a plain object.
//
// The marshalled shape stores `uri.path`, which is *not* an `fsPath` on Windows.
// It is `/C:/Users/...`: forward slashes, and a leading one before the drive.
// `fsPath` is the same path in the platform's own spelling (`c:\Users\...`), and
// it lowercases the drive letter. On POSIX the two strings are identical, which
// is why every fixture here used to write an `fsPath` into `path` and pass.
//
// That was not cosmetic, and the drive letter is the sharp edge. `isThreadImageUri`
// asks whether a uri is inside a thread's own image directory by comparing
// `uri.path` against `threadImageDir(...).path` — a case-*sensitive* prefix test.
// A fixture path built from an `fsPath` carries `c:` while the profile's own
// `globalStorageHome.path` carries `C:`, so the thread's own image failed to match
// the directory it was sitting in, `_copyOwnedImages` skipped it as unowned, and
// the duplicate silently kept pointing at the source's file. The subject then
// failed for a reason that had nothing to do with what it was testing.
//
// So a fixture must be handed a path the product would recognise as its own, and
// the only reliable source is the product: `appPaths` returns `globalStorageHome`
// and `userRoamingDataHome` in *both* spellings, `path` for anything that becomes
// a uri and `fsPath` for anything Node touches. Deriving one from the other is
// what broke.
//
// Every path read back out of a message below is `uri.fsPath`, because that is
// the convention `node:path` and `existsSync` are in, on both platforms.
const marshalledFileUri = (uriPath) => ({
	$mid: 1, scheme: 'file', authority: '', path: uriPath, query: '', fragment: '',
})

const imageSelection = (uriPath) => ({
	type: 'Image',
	uri: marshalledFileUri(uriPath),
	mimeType: 'image/webp',
	fileName: 'shot.webp',
	state: { wasAddedAsCurrentFile: false },
})

// A second kind of selection, carrying a uri the same way an image does. Every chip
// in the sidebar renders through `getBasename(selection.uri.fsPath)` regardless of
// type, so a fix that only kept image uris intact would still break this one — the
// difference being that nothing copies a project file, so the duplicate must point
// at the *same* file rather than a new one.
const fileSelection = (uriPath) => ({
	type: 'File',
	uri: marshalledFileUri(uriPath),
	language: 'python',
	state: { wasAddedAsCurrentFile: false },
})

/** A thread's own image directory, in `fsPath` spelling. */
const threadImageDir = (globalStorageHome, threadId) =>
	join(globalStorageHome, 'void', 'threads', threadId, 'images')

/** The same directory in `uri.path` spelling — what a fixture must hand the product. */
const threadImageUriDir = (globalStorageUriPath, threadId) =>
	`${globalStorageUriPath}/void/threads/${threadId}/images`

/**
 * The two directories the product writes into, as the app itself sees them, in
 * both spellings. `userRoamingDataHome` is on `IEnvironmentService`;
 * `globalStorageHome` is not — it sits on `IUserDataProfile`, which is where
 * `_globalStorageHome` reads it, and it is deliberately *not* derived here as
 * `<roamingHome>/globalStorage`: the product's own value is the one its
 * case-sensitive ownership check compares against, so the fixture has to take it
 * rather than reconstruct it. Scenarios still assert `state.vscdb` is there, so a
 * wrong value is caught rather than silently trusted.
 *
 * `*Path` is `uri.path` spelling for fixtures that become uris; `*FsPath` is for
 * anything Node opens.
 */
async function appPaths(page) {
	return page.evaluate(() => {
		const svc = globalThis.__voidChatThreadService
		const roaming = svc._environmentService.userRoamingDataHome
		const storage = svc._globalStorageHome()
		return {
			roamingHome: roaming.fsPath,
			globalStorageHome: storage.fsPath,
			roamingUriPath: roaming.path,
			globalStorageUriPath: storage.path,
		}
	})
}

/**
 * Puts a user message carrying one image selection — and optionally other
 * selections beside it — on the current thread, and reloads the thread so the
 * message and its revived URIs are in memory where duplicate and delete will
 * find them.
 */
async function seedThreadWithImage(page, imagePath, extraSelections = []) {
	return page.evaluate(({ selection, extra }) => {
		const svc = globalThis.__voidChatThreadService
		const id = svc.state.currentThreadId
		svc._storeMessageKey(id, 0, {
			role: 'user', content: 'look at this', displayContent: 'look at this', selections: [selection, ...extra],
		})
		// _storeMessageKey only queues; the reload below reads storage.
		svc._flushPendingThreadWrites()
		svc._loadedMessageThreadIds.delete(id)
		svc._ensureMessagesLoaded(id)
		const loaded = svc.state.allThreads[id]
		return {
			threadId: id,
			messageCount: loaded.messages.length,
			imagePaths: loaded.messages.flatMap(m => (m.selections ?? []).filter(s => s.type === 'Image').map(s => s.uri.fsPath)),
			filePaths: loaded.messages.flatMap(m => (m.selections ?? []).filter(s => s.type === 'File').map(s => s.uri.fsPath)),
		}
	}, { selection: imageSelection(imagePath), extra: extraSelections })
}

/** Duplicates the thread and reports which selection paths the copy references. */
async function duplicateAndReadImages(page, sourceId) {
	return page.evaluate(async (id) => {
		const svc = globalThis.__voidChatThreadService
		// Now async: the copy carries its own image files, so the new thread only
		// exists once the bytes have been written.
		const newId = await svc.copyThreadToCurrentWorkspace(id)
		const copy = svc.state.allThreads[newId]
		return {
			threadId: newId,
			imagePaths: (copy?.messages ?? []).flatMap(m => (m.selections ?? []).filter(s => s.type === 'Image').map(s => s.uri.fsPath)),
			filePaths: (copy?.messages ?? []).flatMap(m => (m.selections ?? []).filter(s => s.type === 'File').map(s => s.uri.fsPath)),
			hasImageSelection: (copy?.messages ?? []).some(m => (m.selections ?? []).some(s => s.type === 'Image')),
		}
	}, sourceId)
}

describe('image ownership', () => {

	// The safe half of the change, and the one that makes it shippable before
	// S10: images already in the flat directory have no single owner, so the
	// only correct thing to do with them is leave them alone.
	test('deleting a thread does not delete an image it does not own', async (t) => {
		await h.withScenario('image-ownership/legacy-file', async (s) => {
			const homes = await appPaths(s.page)

			// Guard: the derived global-storage path must be the real one, or
			// scenario 2 would write its fixture into a directory nothing reads.
			assert.ok(
				existsSync(join(homes.globalStorageHome, 'state.vscdb')),
				`the derived global storage path holds no state.vscdb: ${homes.globalStorageHome}`,
			)

			const flatPath = join(homes.roamingHome, 'voidImages', 'legacy-image.webp')
			const flatUriPath = `${homes.roamingUriPath}/voidImages/legacy-image.webp`
			mkdirSync(dirname(flatPath), { recursive: true })
			writeFileSync(flatPath, Buffer.from('legacy-image-bytes'))

			const seeded = await seedThreadWithImage(s.page, flatUriPath)

			// Guard: the fixture must have produced a loaded thread that really
			// references the file. Without this, "the file survived" is true for
			// the uninteresting reason that nothing referenced it.
			assert.ok(existsSync(flatPath), 'fixture did not write the legacy image file')
			assert.equal(seeded.messageCount, 1, `the seeded message did not load (got ${seeded.messageCount} messages)`)
			assert.deepEqual(seeded.imagePaths, [flatPath], `the message does not reference the legacy file: ${JSON.stringify(seeded.imagePaths)}`)

			const copy = await duplicateAndReadImages(s.page, seeded.threadId)

			// Guard: the duplicate must exist and carry the image, or deleting
			// the original proves nothing about what the duplicate can still render.
			assert.ok(copy.threadId, 'copyThreadToCurrentWorkspace returned no id')
			assert.ok(copy.hasImageSelection, 'the duplicate carries no image selection')
			assert.equal(copy.imagePaths.length, 1, `the duplicate references ${copy.imagePaths.length} images, expected 1`)
			assert.ok(existsSync(copy.imagePaths[0]), `the duplicate references an image that was never on disk: ${copy.imagePaths[0]}`)

			await s.page.evaluate((id) => globalThis.__voidChatThreadService.deleteThread(id), seeded.threadId)
			await h.sleep(1000) // _fileService.del is fire-and-forget

			trace(t, s)

			// Control: the original really is gone, so a no-op delete would not
			// read as success.
			const originalGone = await s.page.evaluate((id) => !globalThis.__voidChatThreadService.state.allThreads[id], seeded.threadId)
			assert.ok(originalGone, 'deleteThread did not remove the original thread — the assertion below is about nothing')

			h.assertPersistence(
				'an image the deleted thread did not own',
				existsSync(copy.imagePaths[0]),
				{ subject: true },
			)
		})
	})

	// The gate from the delivery table: duplicate a thread with images, delete
	// one, the other's images still render. For images written after the change
	// the duplicate must own a *copy*, because the original's directory goes
	// away with the original.
	test('a duplicate keeps its own copy of a thread-owned image', async (t) => {
		await h.withScenario('image-ownership/duplicate', async (s) => {
			const homes = await appPaths(s.page)
			assert.ok(
				existsSync(join(homes.globalStorageHome, 'state.vscdb')),
				`the derived global storage path holds no state.vscdb: ${homes.globalStorageHome}`,
			)

			// The path depends on the thread id, so the thread has to exist first.
			const threadId = await s.page.evaluate(() => globalThis.__voidChatThreadService.state.currentThreadId)
			const ownedPath = join(threadImageDir(homes.globalStorageHome, threadId), 'owned-image.webp')
			const ownedUriPath = `${threadImageUriDir(homes.globalStorageUriPath, threadId)}/owned-image.webp`
			mkdirSync(dirname(ownedPath), { recursive: true })
			writeFileSync(ownedPath, Buffer.from('owned-image-bytes'))

			// A second selection on the same message, pointing at a project file. No
			// code path copies one — it is the user's file — so the duplicate must end
			// up referencing this exact path, unlike the image.
			const projectPath = join(homes.roamingHome, 'project', 'hello_metal.py')
			const projectUriPath = `${homes.roamingUriPath}/project/hello_metal.py`
			mkdirSync(dirname(projectPath), { recursive: true })
			writeFileSync(projectPath, 'print("hello metal")\n')

			const seeded = await seedThreadWithImage(s.page, ownedUriPath, [fileSelection(projectUriPath)])
			assert.equal(seeded.threadId, threadId, 'the current thread changed between fixture steps')
			assert.equal(seeded.messageCount, 1, `the seeded message did not load (got ${seeded.messageCount} messages)`)
			assert.ok(existsSync(ownedPath), 'fixture did not write the thread-owned image file')
			assert.deepEqual(seeded.imagePaths, [ownedPath], `the message does not reference the owned file: ${JSON.stringify(seeded.imagePaths)}`)
			assert.deepEqual(seeded.filePaths, [projectPath], `the message does not reference the project file: ${JSON.stringify(seeded.filePaths)}`)

			const copy = await duplicateAndReadImages(s.page, seeded.threadId)
			assert.ok(copy.hasImageSelection, 'the duplicate carries no image selection')
			assert.equal(copy.imagePaths.length, 1, `the duplicate references ${copy.imagePaths.length} images, expected 1`)

			// Guard: the copy's selection uris are still uris — both kinds. A plain
			// `deepClone` (`base/common/objects.ts`) rebuilds objects as bare ones:
			// `path` survives as an own property while `fsPath` and `toJSON` do not,
			// being prototype getters. The assertions below would then fail with
			// `undefined` and read as "the file is missing", which is not what went
			// wrong. Image and file selections are checked together because every chip
			// renders through `getBasename(selection.uri.fsPath)` regardless of type,
			// and a fix aimed only at images would leave this one broken.
			const urisAreReal = await s.page.evaluate((id) => {
				const thread = globalThis.__voidChatThreadService.state.allThreads[id]
				const selections = (thread?.messages ?? []).flatMap(m => m.selections ?? [])
				return {
					all: selections.every(sel => typeof sel.uri?.fsPath === 'string'),
					types: selections.map(sel => sel.type),
				}
			}, copy.threadId)
			assert.deepEqual(urisAreReal.types.sort(), ['File', 'Image'], 'the copy did not carry both selections — the uri guard below would be about one kind only')
			assert.ok(urisAreReal.all, 'a duplicated thread\'s selection uri lost its fsPath — the copy was not cloned with URIs preserved')

			// Guard: the duplicate owns its own copy rather than pointing at the
			// source's file, which is the whole point of the ownership change. Without
			// this, "the image survived the delete" could be true of a copy that was
			// never made.
			assert.ok(
				copy.imagePaths[0].startsWith(threadImageDir(homes.globalStorageHome, copy.threadId)),
				`the duplicate's image is not in its own directory: ${copy.imagePaths[0]}`,
			)
			assert.notEqual(copy.imagePaths[0], ownedPath, 'the duplicate references the source image instead of a copy of it')

			// Guard: the copy is the same bytes, not merely a file at the right path.
			// The copy is a read-then-write through IFileService, so existence alone
			// would also be satisfied by an empty write.
			assert.deepEqual(
				readFileSync(copy.imagePaths[0]),
				readFileSync(ownedPath),
				'the copied image is not the same bytes as the original',
			)

			// The opposite rule for a file selection: nothing copies a project file, so
			// the duplicate points at the same one.
			assert.deepEqual(copy.filePaths, [projectPath], `the duplicate references a different project file: ${JSON.stringify(copy.filePaths)}`)

			// Guard: whatever the duplicate points at must exist *before* the
			// delete, or the subject below would fail for a fixture reason.
			assert.ok(existsSync(copy.imagePaths[0]), `the duplicate references an image that was never on disk: ${copy.imagePaths[0]}`)

			await s.page.evaluate((id) => globalThis.__voidChatThreadService.deleteThread(id), seeded.threadId)
			await h.sleep(1000)

			trace(t, s)

			const originalGone = await s.page.evaluate((id) => !globalThis.__voidChatThreadService.state.allThreads[id], seeded.threadId)
			assert.ok(originalGone, 'deleteThread did not remove the original thread')

			// Control: the duplicate still carries the image selection, so its
			// file surviving is a statement about the file and not about the
			// message having quietly lost it.
			const stillReferenced = await s.page.evaluate((id) => {
				const thread = globalThis.__voidChatThreadService.state.allThreads[id]
				return (thread?.messages ?? []).some(m => (m.selections ?? []).some(s => s.type === 'Image'))
			}, copy.threadId)
			assert.ok(stillReferenced, 'the duplicate lost its image selection — the file assertion is vacuous')

			h.assertPersistence(
				'the image a surviving duplicate renders',
				existsSync(copy.imagePaths[0]),
				{ subject: true },
			)
		})
	})

	// The Duplicate action in the thread selector is a *second* clone path, and the
	// one a user actually clicks. It needs the same treatment — and it exposes a
	// second defect that has nothing to do with images: it only ever called
	// `_storeThread`, which persists metadata, while messages live under their own
	// keys. Its copies therefore read back empty after a restart.
	test('the selector\'s duplicate keeps its own copy, and its messages', async (t) => {
		await h.withScenario('image-ownership/selector-duplicate', async (s) => {
			const homes = await appPaths(s.page)
			assert.ok(
				existsSync(join(homes.globalStorageHome, 'state.vscdb')),
				`the derived global storage path holds no state.vscdb: ${homes.globalStorageHome}`,
			)

			const threadId = await s.page.evaluate(() => globalThis.__voidChatThreadService.state.currentThreadId)
			const ownedPath = join(threadImageDir(homes.globalStorageHome, threadId), 'selector-image.webp')
			const ownedUriPath = `${threadImageUriDir(homes.globalStorageUriPath, threadId)}/selector-image.webp`
			mkdirSync(dirname(ownedPath), { recursive: true })
			writeFileSync(ownedPath, Buffer.from('selector-image-bytes'))

			const seeded = await seedThreadWithImage(s.page, ownedUriPath)
			assert.equal(seeded.messageCount, 1, `the seeded message did not load (got ${seeded.messageCount} messages)`)
			assert.deepEqual(seeded.imagePaths, [ownedPath], `the message does not reference the owned file: ${JSON.stringify(seeded.imagePaths)}`)

			const copy = await s.page.evaluate(async (id) => {
				const svc = globalThis.__voidChatThreadService
				// Identified by diffing rather than by the return value: the old
				// `duplicateThread` returned nothing, and a fixture that cannot run
				// against unpatched code cannot show what the fix changed.
				const before = new Set(Object.keys(svc.state.allThreads))
				await svc.duplicateThread(id)
				svc._flushPendingThreadWrites()
				const newId = Object.keys(svc.state.allThreads).find(k => !before.has(k))
				const thread = svc.state.allThreads[newId]
				return {
					threadId: newId,
					imagePaths: (thread?.messages ?? []).flatMap(m => (m.selections ?? []).filter(s => s.type === 'Image').map(s => s.uri.fsPath)),
					hasImageSelection: (thread?.messages ?? []).some(m => (m.selections ?? []).some(s => s.type === 'Image')),
				}
			}, seeded.threadId)

			assert.ok(copy.threadId, 'duplicateThread produced no new thread')
			assert.ok(copy.hasImageSelection, 'the duplicate carries no image selection')
			assert.equal(copy.imagePaths.length, 1, `the duplicate references ${copy.imagePaths.length} images, expected 1`)
			assert.ok(existsSync(copy.imagePaths[0]), `the duplicate references an image that was never on disk: ${copy.imagePaths[0]}`)

			await s.page.evaluate((id) => globalThis.__voidChatThreadService.deleteThread(id), seeded.threadId)
			await h.sleep(1000)

			trace(t, s)

			const originalGone = await s.page.evaluate((id) => !globalThis.__voidChatThreadService.state.allThreads[id], seeded.threadId)
			assert.ok(originalGone, 'deleteThread did not remove the original thread')

			h.assertPersistence(
				'the image a surviving selector-duplicate renders',
				existsSync(copy.imagePaths[0]),
				{ subject: true },
			)

			// The copy's own message keys. `_storeThread` persists metadata only, so
			// an unfixed duplicate reloads with no conversation at all and the images
			// copied for it are files nothing will ever reference again. Written on
			// the 500ms coalescing timer, hence the wait above.
			await h.sleep(600)
			h.assertPersistence(
				'the selector-duplicate\'s own message keys',
				!!s.readKey(`void.chatMsg.${copy.threadId}.0`),
				{ subject: true },
			)
		})
	})

	// Bug 7 and bug 8: the path an *attached* image is given. This is the only
	// place the directory is chosen, and it is chosen in the sidebar's attach
	// hook, so the assertion has to go through the real file input rather than
	// through a service call that never decides anything.
	test('an attached image is written into the thread that attached it', async (t) => {
		await h.withScenario('image-ownership/attach', async (s) => {
			await h.ensureModelSelection(s.page)
			const threadId = await s.page.evaluate(() => {
				const svc = globalThis.__voidChatThreadService
				// The composer only renders the image input when a chat model is
				// selected and either it or a Vision Helper can see. The harness
				// sets Chat; an unset Vision Helper fails the gate, so install one
				// the way the harness installs Chat — by assigning state, because
				// validation drops a model no configured provider serves.
				//
				// Replaced rather than mutated in place: `useSettingsState` feeds a
				// `useMemo` keyed on the state object, so an in-place edit notifies
				// React and still renders the old value.
				const st = svc._settingsService.state
				svc._settingsService.state = {
					...st,
					modelSelectionOfFeature: {
						...st.modelSelectionOfFeature,
						'VisionHelper': { providerName: 'ollama', modelName: 'llava:latest' },
					},
				}
				svc._settingsService._onDidChangeState.fire()
				return svc.state.currentThreadId
			})
			const homes = await appPaths(s.page)
			assert.ok(
				existsSync(join(homes.globalStorageHome, 'state.vscdb')),
				`the derived global storage path holds no state.vscdb: ${homes.globalStorageHome}`,
			)

			const input = s.page.locator('input[type=file][accept*="image/png"]')
			await input.waitFor({ state: 'attached', timeout: 60000 })
			await input.setInputFiles({
				name: 'screenshot.png',
				mimeType: 'image/png',
				buffer: Buffer.from(PNG_1X1, 'base64'),
			})

			// handleImageFiles compresses through a canvas before staging, so the
			// selection appears asynchronously.
			const staged = await pollImageSelection(s.page, 60000)

			// Guard: a path came back at all. Everything below is about where it
			// points, which is meaningless if nothing was attached.
			assert.ok(staged, 'the file input never produced a staged image selection')

			trace(t, s)

			const ownedDir = threadImageDir(homes.globalStorageHome, threadId)
			const flatDir = join(homes.roamingHome, 'voidImages')

			// Control: it is a real file path with an extension, so the subject
			// is not passing because the path is empty or malformed.
			assert.match(staged, /\.(webp|png|jpe?g|gif)$/, `the staged uri is not an image path: ${staged}`)

			// Guard: the two directories must be distinguishable and the staged
			// path must be under exactly one of them, or neither assertion below
			// means anything. Comparing across two path conventions fails both
			// `startsWith` calls at once, which reads as "not in the flat
			// directory" and passes the absence assertion for the wrong reason —
			// and that is precisely what happened here on Windows, where `staged`
			// was a `uri.path` (`/c:/...`) and both directories were `node:path`
			// joins (`c:\...`). The subject then failed while its neighbour
			// passed vacuously, which is the more dangerous of the two.
			assert.ok(
				!ownedDir.startsWith(flatDir) && !flatDir.startsWith(ownedDir),
				`the two candidate directories are not distinguishable: ${ownedDir} / ${flatDir}`,
			)
			assert.ok(
				staged.startsWith(ownedDir) || staged.startsWith(flatDir),
				`the staged image is under neither known directory: ${staged}`,
			)

			h.assertAbsent(
				'an attached image landing in the shared flat directory',
				!staged.startsWith(flatDir),
				{ subject: true },
			)
			h.assertPersistence(
				'an attached image landing under its own thread',
				staged.startsWith(ownedDir),
				{ subject: true },
			)
		})
	})

	// Bug 18's own gate, and the reason it is documented as a separate defect
	// rather than folded into image ownership: nothing above would catch it. The
	// assertion there is that the copy's message keys reach storage, which is the
	// mechanism — this one asks the question a user would, by quitting and
	// reopening the profile.
	test('a duplicated conversation comes back after a restart', async (t) => {
		const dirs = h.createProfile('image-ownership/duplicate-reload')
		const first = await h.launchVoid(dirs)
		let copyId
		try {
			copyId = await first.page.evaluate(async () => {
				const svc = globalThis.__voidChatThreadService
				const id = svc.state.currentThreadId
				svc._storeMessageKey(id, 0, {
					role: 'user', content: 'remember me', displayContent: 'remember me', selections: null,
				})
				svc._flushPendingThreadWrites()
				svc._loadedMessageThreadIds.delete(id)
				svc._ensureMessagesLoaded(id)

				const before = new Set(Object.keys(svc.state.allThreads))
				await svc.duplicateThread(id)
				svc._flushPendingThreadWrites()
				return Object.keys(svc.state.allThreads).find(k => !before.has(k))
			})
			assert.ok(copyId, 'the duplicate was never created')
			await h.sleep(600) // the message keys are queued on the 500ms coalescing timer
		} finally {
			await first.close()
		}

		const second = await h.launchVoid(dirs)
		try {
			const loaded = await second.page.evaluate((id) => {
				const svc = globalThis.__voidChatThreadService
				svc._ensureMessagesLoaded(id)
				const thread = svc.state.allThreads[id]
				return {
					// Guard: the copy's metadata reached the index, so a missing
					// conversation below is a message-storage failure and not a
					// duplicate that was never persisted at all.
					threadPresent: !!thread,
					messageCount: thread?.messages?.length ?? 0,
					texts: (thread?.messages ?? []).map(m => m.displayContent),
				}
			}, copyId)

			trace(t, second)
			// Guard: the copy's metadata reached the index, so a missing
			// conversation below is a message-storage failure and not a duplicate
			// that was never persisted at all. Must hold in every configuration.
			assert.ok(loaded.threadPresent, 'the duplicate is not in the thread index after a restart')
			t.diagnostic(`duplicate after restart: ${loaded.messageCount} message(s) ${JSON.stringify(loaded.texts)}`)

			h.assertPersistence(
				'the duplicated conversation after a restart',
				loaded.texts.includes('remember me'),
				{ subject: true },
			)
		} finally {
			await second.close()
		}
	})
})

// A 1x1 PNG. Small enough to compress instantly, real enough for the canvas
// round-trip in `compressImage` to produce bytes.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Waits for the attach hook to stage an Image selection, and returns its path. */
async function pollImageSelection(page, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const paths = await page.evaluate(() => {
			const svc = globalThis.__voidChatThreadService
			const thread = svc.state.allThreads[svc.state.currentThreadId]
			return (thread?.state?.stagingSelections ?? []).filter(s => s.type === 'Image').map(s => s.uri.fsPath)
		})
		if (paths.length > 0) return paths[0]
		if (Date.now() > deadline) return null
		await h.sleep(250)
	}
}
