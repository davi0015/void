/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// past values:
// 'void.settingsServiceStorage'
// 'void.settingsServiceStorageI' // 1.0.2

// 1.0.3
export const VOID_SETTINGS_STORAGE_KEY = 'void.settingsServiceStorageII'


// past values:
// 'void.chatThreadStorage'
// 'void.chatThreadStorageI' // 1.0.2

// 1.0.3
export const THREAD_STORAGE_KEY = 'void.chatThreadStorageII'

// Per-thread storage (replaces the single-blob THREAD_STORAGE_KEY).
// Each thread is stored under `void.chatThread.{threadId}`.
// A lightweight index of thread IDs is stored separately.
export const THREAD_KEY_PREFIX = 'void.chatThread.'
export const THREAD_INDEX_KEY = 'void.chatThreadIndex'


// Ordered list of thread ids pinned as tabs in the chat sidebar. Persisted
// separately from THREAD_STORAGE_KEY so evolving tab UX doesn't force a
// thread-storage version bump.
export const PINNED_THREADS_STORAGE_KEY = 'void.chatPinnedThreadsI'


// Phase E (workspace-scoped chats) — `Record<workspaceUri, threadId>` map of
// the last thread the user was looking at within each workspace. Lets us
// restore "where you left off" per-workspace on window open / workspace
// switch instead of always landing on the most-recently-touched thread of
// any workspace. APPLICATION-scoped (cross-workspace state) and intentionally
// kept in its own storage slot so growing/pruning the map never touches the
// (much larger) thread blob.
export const LAST_ACTIVE_THREAD_BY_WORKSPACE_STORAGE_KEY = 'void.chatLastActiveThreadByWorkspaceI'


export const OPT_OUT_KEY = 'void.app.optOutAll'
