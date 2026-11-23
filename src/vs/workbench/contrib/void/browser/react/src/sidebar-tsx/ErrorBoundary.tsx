/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { WarningBox } from '../void-settings-tsx/WarningBox.js';

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onDismiss?: () => void;
	/**
	 * Changing this value clears a caught error. An error thrown during one render
	 * can be a race with state that arrives a moment later — the current thread
	 * landing after a log read, for instance — and a boundary that never retries
	 * turns that moment into a dead pane for the rest of the session.
	 */
	resetKey?: unknown;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null
		};
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return {
			hasError: true,
			error
		};
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		// The fallback is all the user sees, and without this the stack that explains
		// it never reaches the console — which is most of the cost of diagnosing one.
		console.error('[void] chat pane render failed:', error, errorInfo);
		this.setState({
			error,
			errorInfo
		});
	}

	componentDidUpdate(prevProps: Props): void {
		if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
			this.reset();
		}
	}

	private reset(): void {
		this.setState({ hasError: false, error: null, errorInfo: null });
	}

	render(): ReactNode {
		if (this.state.hasError && this.state.error) {
			// If a custom fallback is provided, use it
			if (this.props.fallback) {
				return this.props.fallback;
			}

			// Use ErrorDisplay component as the default error UI
			return (
				<WarningBox
					text={this.state.error + '  (click to retry)'}
					onClick={() => this.reset()}
				/>
				// <ErrorDisplay
				// 	message={this.state.error + ''}
				// 	fullError={this.state.error}
				// 	onDismiss={this.props.onDismiss || null}
				// />
			);
		}

		return this.props.children;
	}
}

export default ErrorBoundary;
