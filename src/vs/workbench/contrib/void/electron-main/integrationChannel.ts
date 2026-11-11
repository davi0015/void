/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts (channel name: 'void-channel-integration')
// same pattern as mcpChannel.ts — can't make a service responsible for this
// because it needs to run in the main process with node dependencies.

// This channel has two hats:
//   1. The IServerChannel half — how the browser-side integrationService
//      (renderer) starts/stops the socket server and relays protocol messages,
//      via normal VS Code IPC.
//   2. The localhost server half — a net.Server speaking the Void Integration
//      Protocol (newline-delimited JSON) with the external proxy process.
//      See common/integrationTypes.ts for the protocol and
//      docs/designs/slack-integration.md for the design.
//
// The channel deliberately knows nothing about chat, threads, or tools — it
// relays envelopes. All intelligence (routing, redaction) lives in the
// browser-side integrationService.

import * as net from 'net'
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { Emitter, Event } from '../../../../base/common/event.js'
import {
	INTEGRATION_PROTOCOL_VERSION,
	IntegrationAck,
	IntegrationChannelStartParams,
	IntegrationChannelState,
	IntegrationEnvelope,
	IntegrationHello,
	IntegrationInbound,
	IntegrationMessage,
	IntegrationOutbound,
	IntegrationWelcome,
	isInboundPayload,
} from '../common/integrationTypes.js'


// Authenticated proxy connection. Line-buffered because TCP gives you
// arbitrary chunk boundaries — a JSON line may arrive split across chunks.
type ProxyConnection = {
	socket: net.Socket
	buffer: string
}

export class IntegrationChannel implements IServerChannel {

	private _server: net.Server | null = null
	private _port: number | undefined

	// the token the proxy must present in its hello. owned/persisted by the
	// browser service; passed in on start().
	private _pairingToken: string | undefined

	// currently authenticated proxy connections (typically 0 or 1)
	private readonly _connections = new Set<ProxyConnection>()

	// next id for outbound envelopes (monotonic across the session)
	private _nextOutboundEnvelopeId = 1

	// ---- events → browser

	private readonly _onProxyConnected = new Emitter<void>()
	public readonly onProxyConnected = this._onProxyConnected.event

	private readonly _onProxyDisconnected = new Emitter<void>()
	public readonly onProxyDisconnected = this._onProxyDisconnected.event

	// inbound protocol messages (already envelope-unwrapped + acked by this
	// channel; ack-on-receipt is fine for the v1 local transport)
	private readonly _onInbound = new Emitter<IntegrationInbound>()
	public readonly onInbound = this._onInbound.event


	// browser uses this to listen for changes
	listen(_: unknown, event: string): Event<any> {
		if (event === 'onProxyConnected') return this.onProxyConnected
		else if (event === 'onProxyDisconnected') return this.onProxyDisconnected
		else if (event === 'onInbound') return this.onInbound
		else throw new Error(`Event not found: ${event}`)
	}

	// browser uses this to call (see integrationService.ts for all usages)
	async call(_: unknown, command: string, params: any): Promise<any> {
		try {
			if (command === 'start') {
				return await this._start(params as IntegrationChannelStartParams)
			}
			else if (command === 'stop') {
				this._stop()
				return this._getState()
			}
			else if (command === 'getState') {
				return this._getState()
			}
			else if (command === 'postOutbound') {
				return this._postOutbound(params as IntegrationOutbound)
			}
			else {
				throw new Error(`Void integration: command "${command}" not recognized.`)
			}
		}
		catch (e) {
			console.error('integration channel: Call Error:', e)
			throw e
		}
	}


	// ---- localhost server

	private async _start(params: IntegrationChannelStartParams): Promise<IntegrationChannelState> {
		if (this._server) {
			// already running — restart so a changed pairing token takes effect
			this._stop()
		}

		this._pairingToken = params.pairingToken

		const server = this._server = net.createServer(socket => {
			this._onConnection(socket)
		})

		server.on('error', err => {
			console.error('integration channel: server error:', err)
			this._teardownServer()
		})

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			// 127.0.0.1 only — this must never be reachable from the network
			server.listen(params.port, '127.0.0.1', () => resolve())
		})

		this._port = (server.address() as net.AddressInfo).port
		console.log(`integration channel: listening on 127.0.0.1:${this._port}`)

		return this._getState()
	}

	private _stop() {
		// close all proxy connections first so their handlers don't race the
		// server teardown
		for (const conn of [...this._connections]) {
			this._closeConnection(conn)
		}
		this._teardownServer()
	}

	private _teardownServer() {
		if (this._server) {
			try { this._server.close() } catch { /* already closed */ }
			this._server = null
		}
		this._port = undefined
	}

	private _onConnection(socket: net.Socket) {
		const conn: ProxyConnection = { socket, buffer: '' }
		let authenticated = false

		socket.setEncoding('utf8')

		socket.on('data', (chunk: string) => {
			conn.buffer += chunk

			let newlineIdx: number
			while ((newlineIdx = conn.buffer.indexOf('\n')) !== -1) {
				const line = conn.buffer.slice(0, newlineIdx)
				conn.buffer = conn.buffer.slice(newlineIdx + 1)

				if (line.trim() === '') continue

				let msg: IntegrationMessage
				try {
					msg = JSON.parse(line)
				}
				catch {
					console.error('integration channel: dropping malformed line from proxy')
					this._closeConnection(conn)
					return
				}

				if (!authenticated) {
					// the first message must be a hello
					const ok = this._handleHello(conn, msg)
					if (!ok) return
					authenticated = true
					this._connections.add(conn)
					this._onProxyConnected.fire()
					continue
				}

				if ('payload' in msg) {
					// envelope: relay to the browser + ack back to the proxy
					const envelope: IntegrationEnvelope = msg
					const ack: IntegrationAck = { type: 'ack', id: envelope.id }
					this._send(conn, ack)
					if (isInboundPayload(envelope.payload)) {
						this._onInbound.fire(envelope.payload)
					}
					else {
						// a proxy echoing our own outbound payloads back at us — ignore it
						console.error('integration channel: unexpected outbound payload from proxy, ignoring')
					}
				}
				else {
					console.error('integration channel: unexpected non-envelope message from proxy, ignoring')
				}
			}
		})

		socket.on('error', err => {
			console.error('integration channel: socket error:', err)
			this._closeConnection(conn)
		})

		socket.on('close', () => {
			if (authenticated && this._connections.delete(conn)) {
				this._onProxyDisconnected.fire()
			}
		})
	}

	private _handleHello(conn: ProxyConnection, msg: IntegrationMessage): boolean {
		if ((msg as IntegrationHello).type !== 'hello') {
			this._send(conn, { type: 'denied', reason: 'expected hello first' } satisfies IntegrationWelcome)
			this._closeConnection(conn)
			return false
		}

		const hello = msg as IntegrationHello

		if (hello.protocolVersion !== INTEGRATION_PROTOCOL_VERSION) {
			this._send(conn, { type: 'denied', reason: `protocol version mismatch (want ${INTEGRATION_PROTOCOL_VERSION}, got ${hello.protocolVersion})` } satisfies IntegrationWelcome)
			this._closeConnection(conn)
			return false
		}

		if (hello.pairingToken !== this._pairingToken) {
			// deliberately vague — don't leak which part was wrong
			this._send(conn, { type: 'denied', reason: 'unauthorized' } satisfies IntegrationWelcome)
			this._closeConnection(conn)
			return false
		}

		this._send(conn, { type: 'welcome', protocolVersion: INTEGRATION_PROTOCOL_VERSION } satisfies IntegrationWelcome)
		return true
	}

	private _postOutbound(payload: IntegrationOutbound): { envelopeId: number } {
		const envelope: IntegrationEnvelope = { id: this._nextOutboundEnvelopeId++, payload }
		const line = JSON.stringify(envelope) + '\n'
		for (const conn of [...this._connections]) {
			conn.socket.write(line)
		}
		return { envelopeId: envelope.id }
	}

	private _send(conn: ProxyConnection, msg: IntegrationMessage) {
		conn.socket.write(JSON.stringify(msg) + '\n')
	}

	private _closeConnection(conn: ProxyConnection) {
		try { conn.socket.destroy() } catch { /* already closed */ }
	}

	private _getState(): IntegrationChannelState {
		return {
			running: this._server !== null,
			port: this._port,
			nConnections: this._connections.size,
		}
	}
}
