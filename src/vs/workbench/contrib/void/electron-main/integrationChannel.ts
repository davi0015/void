/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts (channel name: 'void-channel-integration')
// same pattern as mcpChannel.ts — can't make a service responsible for this
// because it needs to run in the main process with node dependencies.
//
// This channel has two hats:
//   1. The IServerChannel half — how each window's browser-side
//      integrationService (renderer) starts/stops its socket server and
//      relays protocol messages, via normal VS Code IPC.
//   2. The localhost server half — a net.Server per WINDOW, speaking the
//      Void Integration Protocol (newline-delimited JSON) with an external
//      proxy process. See common/integrationTypes.ts for the protocol and
//      docs/designs/slack-integration.md for the design.
//
// ONE WORKSPACE = ONE PORT = ONE SERVER. Each window derives its port from
// its workspace (see integrationService.ts), so a proxy reaches a specific
// workspace's window by connecting to that port. The IPC `ctx` (the calling
// window's connection) is what routes messages between a window and its
// server — two windows never see each other's conversations.
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

// Per-window state: the server that window started (on its workspace's
// port), its authenticated proxy connections, and the emitters that window
// listens on. A window that never successfully started has server: null and
// simply never receives events.
type ChannelClient = {
	server: net.Server | null
	port: number | undefined
	pairingToken: string | undefined
	connections: Set<ProxyConnection>
	nextOutboundEnvelopeId: number

	onProxyConnected: Emitter<void>
	onProxyDisconnected: Emitter<void>
	onInbound: Emitter<IntegrationInbound>
}

export class IntegrationChannel implements IServerChannel {

	// one entry per window (renderer) that has ever called into this channel,
	// keyed by the IPC caller context
	private readonly _clientOfCtx = new Map<unknown, ChannelClient>()
	// port → the ctx that owns it. A window reload creates a NEW ctx for the
	// same workspace port; the old entry is stale and gets evicted when the
	// port is reclaimed (otherwise the reload's start() would EADDRINUSE).
	private readonly _ctxOfPort = new Map<number, unknown>()


	private _clientOf(ctx: unknown): ChannelClient {
		let client = this._clientOfCtx.get(ctx)
		if (!client) {
			client = {
				server: null,
				port: undefined,
				pairingToken: undefined,
				connections: new Set(),
				nextOutboundEnvelopeId: 1,
				onProxyConnected: new Emitter<void>(),
				onProxyDisconnected: new Emitter<void>(),
				onInbound: new Emitter<IntegrationInbound>(),
			}
			this._clientOfCtx.set(ctx, client)
		}
		return client
	}


	// browser uses this to listen for changes
	listen(ctx: unknown, event: string): Event<any> {
		const client = this._clientOf(ctx)
		if (event === 'onProxyConnected') return client.onProxyConnected.event
		else if (event === 'onProxyDisconnected') return client.onProxyDisconnected.event
		else if (event === 'onInbound') return client.onInbound.event
		else throw new Error(`Event not found: ${event}`)
	}

	// browser uses this to call (see integrationService.ts for all usages)
	async call(ctx: unknown, command: string, params: any): Promise<any> {
		try {
			if (command === 'start') {
				return await this._start(ctx, params as IntegrationChannelStartParams)
			}
			else if (command === 'stop') {
				this._stop(ctx)
				return this._getState(ctx)
			}
			else if (command === 'getState') {
				return this._getState(ctx)
			}
			else if (command === 'postOutbound') {
				return this._postOutbound(ctx, params as IntegrationOutbound)
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


	// ---- localhost server (per window)

	private async _start(ctx: unknown, params: IntegrationChannelStartParams): Promise<IntegrationChannelState> {
		const client = this._clientOf(ctx)

		// reclaim the port from a stale owner — the previous window for this
		// same workspace (a reload made its ctx stale)
		const prevCtx = this._ctxOfPort.get(params.port)
		if (prevCtx !== undefined && prevCtx !== ctx) {
			const prev = this._clientOfCtx.get(prevCtx)
			if (prev) this._teardownServer(prev)
		}

		// restart (also the changed-pairing-token path)
		this._teardownServer(client)

		client.pairingToken = params.pairingToken

		const server = client.server = net.createServer(socket => {
			this._onConnection(client, socket)
		})

		server.on('error', err => {
			console.error('integration channel: server error:', err)
			this._teardownServer(client)
		})

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			// 127.0.0.1 only — this must never be reachable from the network
			server.listen(params.port, '127.0.0.1', () => resolve())
		})

		client.port = (server.address() as net.AddressInfo).port
		this._ctxOfPort.set(client.port, ctx)
		console.log(`integration channel: listening on 127.0.0.1:${client.port}`)

		return this._getState(ctx)
	}

	private _stop(ctx: unknown) {
		const client = this._clientOf(ctx)
		// close all proxy connections first so their handlers don't race the
		// server teardown
		for (const conn of [...client.connections]) {
			this._closeConnection(conn)
		}
		this._teardownServer(client)
	}

	private _teardownServer(client: ChannelClient) {
		if (client.server) {
			try { client.server.close() } catch { /* already closed */ }
			if (client.port !== undefined) this._ctxOfPort.delete(client.port)
			client.server = null
		}
		client.port = undefined
	}

	private _onConnection(client: ChannelClient, socket: net.Socket) {
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
					const ok = this._handleHello(client, conn, msg)
					if (!ok) return
					authenticated = true
					client.connections.add(conn)
					client.onProxyConnected.fire()
					continue
				}

				if ('payload' in msg) {
					// envelope: relay to the browser + ack back to the proxy
					const envelope: IntegrationEnvelope = msg
					const ack: IntegrationAck = { type: 'ack', id: envelope.id }
					this._send(conn, ack)
					if (isInboundPayload(envelope.payload)) {
						client.onInbound.fire(envelope.payload)
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
			if (authenticated && client.connections.delete(conn)) {
				client.onProxyDisconnected.fire()
			}
		})
	}

	private _handleHello(client: ChannelClient, conn: ProxyConnection, msg: IntegrationMessage): boolean {
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

		if (hello.pairingToken !== client.pairingToken) {
			// deliberately vague — don't leak which part was wrong
			this._send(conn, { type: 'denied', reason: 'unauthorized' } satisfies IntegrationWelcome)
			this._closeConnection(conn)
			return false
		}

		this._send(conn, { type: 'welcome', protocolVersion: INTEGRATION_PROTOCOL_VERSION } satisfies IntegrationWelcome)
		return true
	}

	private _postOutbound(ctx: unknown, payload: IntegrationOutbound): { envelopeId: number } {
		const client = this._clientOf(ctx)
		const envelope: IntegrationEnvelope = { id: client.nextOutboundEnvelopeId++, payload }
		const line = JSON.stringify(envelope) + '\n'
		for (const conn of [...client.connections]) {
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

	private _getState(ctx: unknown): IntegrationChannelState {
		const client = this._clientOf(ctx)
		return {
			running: client.server !== null,
			port: client.port,
			nConnections: client.connections.size,
		}
	}
}
