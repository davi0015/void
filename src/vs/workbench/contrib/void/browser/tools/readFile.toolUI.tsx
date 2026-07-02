/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react'

import { BuiltinToolCallParams } from '../../common/toolsServiceTypes.js'
import { MAX_FILE_CHARS_PAGE } from '../../common/prompt/prompts.js'

import { ToolDefinition } from './toolUITypes.js'
import { readFileToolCore } from './readFile.tool.js'

// UI imports — used only inside function bodies (call-time), so circular
// imports with ToolResultComponents.tsx are safe (live bindings resolve
// by the time the functions are called).
import { useAccessor } from '../react/src/util/services.js'
import {
	ToolHeaderWrapper,
	ToolHeaderParams,
	getTitle,
	toolNameToDesc,
	BottomChildren,
	CodeChildren,
} from '../react/src/sidebar-tsx/ToolResultComponents.js'
import { getBasename, getRelative, voidOpenFileFn, IconLoading } from '../react/src/sidebar-tsx/sidebarChatHelpers.js'


const loadingTitleWrapper = (item: React.ReactNode): React.ReactNode => {
	return <span className='flex items-center flex-nowrap'>
		{item}
		<IconLoading className='w-3 text-sm' />
	</span>
}


export const readFileTool: ToolDefinition<'read_file'> = {
	...readFileToolCore,

	title: { done: 'Read file', proposed: 'Read file', running: loadingTitleWrapper('Reading file') },

	desc: (params: BuiltinToolCallParams['read_file'], accessor: ReturnType<typeof useAccessor>) => ({
		desc1: getBasename(params.uri.fsPath),
		desc1Info: getRelative(params.uri, accessor),
	}),

	resultWrapper: ({ toolMessage }) => {
		const accessor = useAccessor()

		const title = getTitle(toolMessage)

		const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
		const icon = null

		if (toolMessage.type === 'tool_request' || toolMessage.type === 'running_now') {
			return <ToolHeaderWrapper title={title} desc1={desc1} desc1Info={desc1Info} icon={icon} />
		}

		const isError = false
		const isRejected = toolMessage.type === 'rejected'
		const { params } = toolMessage
		const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

		let range: [number, number] | undefined = undefined
		if (toolMessage.params.startLine !== null || toolMessage.params.endLine !== null) {
			const start = toolMessage.params.startLine === null ? `1` : `${toolMessage.params.startLine}`
			const end = toolMessage.params.endLine === null ? `` : `${toolMessage.params.endLine}`
			const addStr = `(${start}-${end})`
			componentParams.desc1 += ` ${addStr}`
			range = [params.startLine || 1, params.endLine || 1]
		}

		if (toolMessage.type === 'success') {
			const { result } = toolMessage
			componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor, range) }
			if (result.outlined) {
				componentParams.desc2 = '(outline)'
			} else if (result.hasNextPage && params.pageNumber === 1)  // first page
				componentParams.desc2 = `(truncated after ${Math.round(MAX_FILE_CHARS_PAGE) / 1000}k)`
			else if (params.pageNumber > 1) // subsequent pages
				componentParams.desc2 = `(part ${params.pageNumber})`
		}
		else if (toolMessage.type === 'tool_error') {
			const { result } = toolMessage
			componentParams.bottomChildren = <BottomChildren title='Error'>
				<CodeChildren>
					{result}
				</CodeChildren>
			</BottomChildren>
		}

		return <ToolHeaderWrapper {...componentParams} />
	},
}
