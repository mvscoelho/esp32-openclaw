/**
 * WSClient – a resilient WebSocket client that connects the Plugin to
 * esp32-openclaw-server's /plugin endpoint.
 *
 * Features:
 *  - Automatic reconnection with exponential backoff (1 s → 60 s)
 *  - Authentication via Bearer token
 *  - Responds to heartbeat_ping with heartbeat_pong
 *  - EventEmitter API: 'connected', 'disconnected', 'message', 'error'
 */

import {EventEmitter} from 'events'
import WebSocket from 'ws'
import {TypeHeartbeatPing, TypeHeartbeatPong} from './protocol.js'

export interface WSClientConfig {
    /** Full WebSocket URL, e.g. "ws://localhost:8989/plugin". */
    serverUrl: string
    /** Bearer token sent as Authorization header on connect. */
    appToken?: string
    /** Milliseconds between reconnect attempts, base for exponential backoff (default 1000). */
    reconnectBaseMs?: number
    /** Maximum reconnect delay in milliseconds (default 60 000). */
    reconnectMaxMs?: number
}

export declare interface WSClient {
    on(event: 'connected', listener: () => void): this

    on(event: 'disconnected', listener: () => void): this

    on(event: 'message', listener: (data: unknown) => void): this

    on(event: 'error', listener: (err: Error) => void): this

    emit(event: 'connected'): boolean

    emit(event: 'disconnected'): boolean

    emit(event: 'message', data: unknown): boolean

    emit(event: 'error', err: Error): boolean
}

export class WSClient extends EventEmitter {
    private readonly config: Required<WSClientConfig>
    private ws: WebSocket | null = null
    private reconnectAttempt = 0
    private destroyed = false
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null

    constructor(config: WSClientConfig) {
        super()
        this.config = {
            reconnectBaseMs: 1_000,
            reconnectMaxMs: 60_000,
            appToken: '',
            ...config,
        }
    }

    /** Start connecting (idempotent). */
    connect(): void {
        if (this.destroyed || this.ws) return
        this._connect()
    }

    /** Send a JSON-serialisable message. Returns false if not connected. */
    send(data: unknown): boolean {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data))
            return true
        }
        return false
    }

    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN
    }

    /** Permanently close the client; no further reconnections. */
    destroy(): void {
        this.destroyed = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        if (this.ws) {
            const ws = this.ws
            this.ws = null
            // Remove all listeners so close/error events don't re-trigger logic.
            ws.removeAllListeners()
            // Add a no-op error handler: ws.close() during CONNECTING emits an
            // async 'error' event via stream.destroy(err) which we must absorb.
            ws.on('error', () => {
            })
            try {
                if (
                    ws.readyState !== WebSocket.CLOSING &&
                    ws.readyState !== WebSocket.CLOSED
                ) {
                    ws.close()
                }
            } catch {
                // Ignore synchronous throw too.
            }
        }
    }

    // ── Private ────────────────────────────────────────────────────────────────

    private _connect(): void {
        const headers: Record<string, string> = {}
        if (this.config.appToken) {
            headers['Authorization'] = `Bearer ${this.config.appToken}`
        }

        const ws = new WebSocket(this.config.serverUrl, {headers})
        this.ws = ws

        ws.once('open', () => {
            this.reconnectAttempt = 0
            this.emit('connected')
        })

        ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(raw.toString())
                if (msg?.type === TypeHeartbeatPing) {
                    this.send({type: TypeHeartbeatPong})
                    return
                }
                this.emit('message', msg)
            } catch (err) {
                this.emit('error', err instanceof Error ? err : new Error(String(err)))
            }
        })

        ws.on('error', (err: Error) => {
            if (!this.destroyed) this.emit('error', err)
        })

        ws.once('close', () => {
            this.ws = null
            this.emit('disconnected')
            if (!this.destroyed) {
                this._scheduleReconnect()
            }
        })
    }

    private _scheduleReconnect(): void {
        const delay = Math.min(
            this.config.reconnectBaseMs * 2 ** this.reconnectAttempt,
            this.config.reconnectMaxMs,
        )
        this.reconnectAttempt++
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            if (!this.destroyed) this._connect()
        }, delay)
    }
}
