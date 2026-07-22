/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { useAccessor, useIsDark } from '../util/services.js';
import { VoidSimpleInputBox, VoidSwitch, VoidButtonBgDarken } from '../util/inputs.js';
import { Plus, Trash2, Check, Eye, EyeOff, KeyRound } from 'lucide-react';
import { type WorkspaceEnvVars, maskEnvValue } from '../../../workspaceEnvVarService.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';

// One env var row in the form. Shows name, all values (with activate/remove),
// redact toggle, and remove-var. All edits call the service and trigger a
// refresh from the parent.
type VarRowProps = {
	name: string
	values: string[]
	activeIndex: number | null
	redact: boolean
	onRefresh: () => Promise<void>
}

const VarRow = ({ name, values, activeIndex, redact, onRefresh }: VarRowProps) => {
	const accessor = useAccessor()
	const envVarService = accessor.get('IWorkspaceEnvVarService')
	const [revealedValues, setRevealedValues] = useState<Set<number>>(new Set())
	const [newValue, setNewValue] = useState('')
	const [addingValue, setAddingValue] = useState(false)

	const toggleReveal = (idx: number) => {
		setRevealedValues(prev => {
			const next = new Set(prev)
			if (next.has(idx)) next.delete(idx)
			else next.add(idx)
			return next
		})
	}

	const handleSetActive = async (idx: number) => {
		envVarService.setActive(name, idx)
		await onRefresh()
	}

	const handleRemoveValue = async (idx: number) => {
		await envVarService.removeValue(name, idx)
		await onRefresh()
	}

	const handleToggleRedact = async () => {
		envVarService.setRedact(name, !redact)
		await onRefresh()
	}

	const handleRemoveVar = async () => {
		await envVarService.removeVar(name)
		await onRefresh()
	}

	const handleAddValue = async () => {
		if (!newValue) return
		await envVarService.addValue(name, newValue)
		setNewValue('')
		setAddingValue(false)
		await onRefresh()
	}

	return (
		<div className="border border-void-border-2 rounded-lg p-4 mb-3 bg-void-bg-1">
			{/* Header: name + redact + remove */}
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<KeyRound size={16} className="text-void-fg-3" />
					<span className="font-mono font-bold text-void-fg-1">{name}</span>
				</div>
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-1.5">
						<span className="text-xs text-void-fg-3">Redact</span>
						<VoidSwitch value={redact} onChange={handleToggleRedact} size="xs" />
					</div>
					<button
						onClick={handleRemoveVar}
						className="text-void-fg-4 hover:text-red-400 transition-colors p-1 rounded"
						title="Remove env var"
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>

			{/* Values list */}
			{values.length > 0 && (
				<div className="space-y-1.5 mb-2">
					{values.map((v, i) => (
						<div key={i} className="flex items-center gap-2 group">
							{/* Activate radio */}
							<button
								onClick={() => handleSetActive(i)}
								className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors
									${i === activeIndex
										? 'border-void-accent bg-void-accent'
										: 'border-void-border-2 hover:border-void-fg-3'
									}`}
								title={i === activeIndex ? 'Active' : 'Set as active'}
							>
								{i === activeIndex && <Check size={10} className="text-white" />}
							</button>

							{/* Value display/edit */}
							<div className="flex-1 font-mono text-sm bg-void-bg-3 border border-void-border-3 rounded px-2 py-1 truncate">
								{revealedValues.has(i) ? v : maskEnvValue(v)}
							</div>

							{/* Reveal/hide */}
							<button
								onClick={() => toggleReveal(i)}
								className="text-void-fg-4 hover:text-void-fg-2 transition-colors p-1"
								title={revealedValues.has(i) ? 'Hide' : 'Reveal'}
							>
								{revealedValues.has(i) ? <EyeOff size={14} /> : <Eye size={14} />}
							</button>

							{/* Remove value */}
							<button
								onClick={() => handleRemoveValue(i)}
								className="text-void-fg-4 hover:text-red-400 transition-colors p-1 opacity-0 group-hover:opacity-100"
								title="Remove value"
							>
								<Trash2 size={14} />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Add value */}
			{addingValue ? (
				<div className="flex items-center gap-2">
					<VoidSimpleInputBox
						value={newValue}
						onChangeValue={setNewValue}
						placeholder="Enter value..."
						compact
						className="flex-1"
						autoFocus
					/>
					<VoidButtonBgDarken onClick={handleAddValue} className="text-sm">Add</VoidButtonBgDarken>
					<VoidButtonBgDarken onClick={() => { setAddingValue(false); setNewValue('') }} className="text-sm">Cancel</VoidButtonBgDarken>
				</div>
			) : (
				<button
					onClick={() => setAddingValue(true)}
					className="flex items-center gap-1.5 text-sm text-void-fg-3 hover:text-void-fg-1 transition-colors"
				>
					<Plus size={14} /> Add value
				</button>
			)}
		</div>
	)
}

// The new-var creation row. Shows name + value inputs and a Create button.
const NewVarRow = ({ onCreate, onCancel }: { onCreate: (name: string, value: string) => Promise<void>, onCancel: () => void }) => {
	const [name, setName] = useState('')
	const [value, setValue] = useState('')
	const [error, setError] = useState('')

	const handleCreate = async () => {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
			setError('Must match /^[A-Z_][A-Z0-9_]*$/')
			return
		}
		await onCreate(name, value)
	}

	return (
		<div className="border border-void-border-1 rounded-lg p-4 mb-3 bg-void-bg-2">
			<div className="flex items-center gap-2 mb-3">
				<KeyRound size={16} className="text-void-fg-3" />
				<span className="text-void-fg-3 text-sm">New env var</span>
			</div>
			<div className="space-y-2">
				<VoidSimpleInputBox
					value={name}
					onChangeValue={(v) => { setName(v); setError('') }}
					placeholder="VAR_NAME (e.g. OPENAI_API_KEY)"
					compact
				/>
				<VoidSimpleInputBox
					value={value}
					onChangeValue={setValue}
					placeholder="Value"
					compact
				/>
				{error && <span className="text-xs text-red-400">{error}</span>}
			</div>
			<div className="flex gap-2 mt-3">
				<VoidButtonBgDarken onClick={handleCreate} className="text-sm">Create</VoidButtonBgDarken>
				<VoidButtonBgDarken onClick={onCancel} className="text-sm">Cancel</VoidButtonBgDarken>
			</div>
		</div>
	)
}


export const WorkspaceSettings = () => {
	const isDark = useIsDark()
	const accessor = useAccessor()
	const envVarService = accessor.get('IWorkspaceEnvVarService')

	const [vars, setVars] = useState<WorkspaceEnvVars>({})
	const [valuesMap, setValuesMap] = useState<Record<string, string[]>>({})
	const [loading, setLoading] = useState(true)
	const [showNewVar, setShowNewVar] = useState(false)

	const refresh = useCallback(async () => {
		const v = envVarService.getVars()
		setVars(v)
		const valuesEntries = await Promise.all(
			Object.keys(v).map(async name => [name, await envVarService.getValues(name)] as const)
		)
		setValuesMap(Object.fromEntries(valuesEntries))
		setLoading(false)
	}, [envVarService])

	useEffect(() => { void refresh() }, [refresh])

	const handleCreate = async (name: string, value: string) => {
		await envVarService.addVar(name, value, true)
		setShowNewVar(false)
		await refresh()
	}

return (
			<div className={`@@void-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
			<div className="max-w-3xl mx-auto p-8">
				<h1 className="text-2xl font-bold text-void-fg-1 mb-1">Workspace Settings</h1>
				<p className="text-void-fg-3 text-sm mb-6">Env vars are injected into Void-spawned terminals and referenced as $VAR_NAME. Values are encrypted at rest.</p>

				{/* Env Vars section */}
				<div className="mb-6">
					<div className="flex items-center justify-between mb-3">
						<h2 className="text-lg font-semibold text-void-fg-1">Env Vars</h2>
						{!showNewVar && (
							<VoidButtonBgDarken onClick={() => setShowNewVar(true)} className="text-sm">
								<span className="flex items-center gap-1.5"><Plus size={14} /> Add env var</span>
							</VoidButtonBgDarken>
						)}
					</div>

					{loading ? (
						<div className="text-void-fg-3 text-sm">Loading...</div>
					) : (
						<ErrorBoundary fallback={<div className="text-red-400 text-sm">Render error</div>}>
							{showNewVar && (
								<NewVarRow onCreate={handleCreate} onCancel={() => setShowNewVar(false)} />
							)}
							{Object.keys(vars).length === 0 && !showNewVar ? (
								<div className="text-void-fg-3 text-sm py-4 text-center border border-dashed border-void-border-2 rounded-lg">
									No env vars yet. Click "Add env var" to create one.
								</div>
							) : (
								Object.entries(vars).map(([name, entry]) => (
									<VarRow
										key={name}
										name={name}
										values={valuesMap[name] ?? []}
										activeIndex={entry.activeIndex}
										redact={entry.redact}
										onRefresh={refresh}
									/>
								))
							)}
						</ErrorBoundary>
					)}
				</div>
			</div>
		</div>
	)
}
