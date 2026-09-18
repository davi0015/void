/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Source Code License, Version 1.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { isThreadImageUri, threadImageDir, threadImageUri } from '../threadImagePaths.js';

// The ownership predicate every image-deleting path depends on.
//
// The rule it enforces is "no code path deletes a file it does not own", and the
// cases that matter are the ones it must *reject*: the flat directory images were
// written to before this change, another thread's images, and a path that merely
// shares a prefix with this thread's directory. A predicate that accepted any of
// those would let one thread's delete remove a file another thread still renders,
// which is the bug it exists to prevent.

const HOME = URI.file('/Users/me/Library/Application Support/Void/User/globalStorage');
const THREAD = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';

suite('ThreadImagePaths', () => {

	test('a thread\'s image directory sits under global storage', () => {
		assert.strictEqual(
			threadImageDir(HOME, THREAD).path,
			`${HOME.path}/void/threads/${THREAD}/images`,
		);
	});

	test('an image uri is the directory plus the file name', () => {
		assert.strictEqual(
			threadImageUri(HOME, THREAD, 'shot.webp').path,
			`${HOME.path}/void/threads/${THREAD}/images/shot.webp`,
		);
	});

	test('a profile uri without the file scheme is normalized, not rejected', () => {
		// The profile's globalStorageHome is not guaranteed to carry `file`, and
		// every consumer hands the result to IFileService. Joining first would
		// produce a uri no file service can open.
		const profileHome = HOME.with({ scheme: 'vscode-userdata' });
		assert.strictEqual(threadImageUri(profileHome, THREAD, 'shot.webp').scheme, 'file');
		assert.strictEqual(
			threadImageUri(profileHome, THREAD, 'shot.webp').path,
			`${HOME.path}/void/threads/${THREAD}/images/shot.webp`,
		);
	});

	test('a thread owns the images in its own directory', () => {
		assert.strictEqual(isThreadImageUri(HOME, THREAD, threadImageUri(HOME, THREAD, 'shot.webp')), true);
		assert.strictEqual(isThreadImageUri(HOME, THREAD, threadImageUri(HOME, THREAD, 'a/b/c.png')), true);
	});

	test('the flat directory is nobody\'s, so nothing may delete from it', () => {
		// Images written before the change live here, are not migrated by it, and
		// may be shared with a duplicate. Deleting one is the bug this prevents.
		const legacy = URI.file('/Users/me/Library/Application Support/Void/User/voidImages/9f3a.webp');
		assert.strictEqual(isThreadImageUri(HOME, THREAD, legacy), false);
	});

	test('another thread\'s images are not this thread\'s to delete', () => {
		assert.strictEqual(isThreadImageUri(HOME, THREAD, threadImageUri(HOME, OTHER, 'shot.webp')), false);
	});

	test('a prefix is not a directory', () => {
		// `/threads/<id>/images-backup/x.png` and `/threads/<id>-old/images/x.png`
		// both start with the thread's directory string without being inside it.
		const siblingDir = URI.file(`${HOME.path}/void/threads/${THREAD}/images-backup/x.png`);
		const siblingThread = URI.file(`${HOME.path}/void/threads/${THREAD}-old/images/x.png`);
		assert.strictEqual(isThreadImageUri(HOME, THREAD, siblingDir), false);
		assert.strictEqual(isThreadImageUri(HOME, THREAD, siblingThread), false);
	});

	test('a non-file uri is never an owned image', () => {
		const remote = threadImageUri(HOME, THREAD, 'shot.webp').with({ scheme: 'vscode-remote' });
		assert.strictEqual(isThreadImageUri(HOME, THREAD, remote), false);
	});
});
