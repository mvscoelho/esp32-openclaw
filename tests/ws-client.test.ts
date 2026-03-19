/**
 * Unit tests for WSClient.
 *
 * Uses an in-process WebSocket server (ws package) as the mock server.
 * All server-side handlers are registered BEFORE client.connect() to
 * avoid missing 'connection' events that fire immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { WSClient } from '../src/ws-client.js'
import { TypeHeartbeatPing, TypeHeartbeatPong } from '../src/protocol.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 })
    wss.once('listening', () => {
      const addr = wss.address() as { port: number }
      resolve({ wss, port: addr.port })
    })
  })
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => wss.close(() => resolve()))
}

/** Wait for the next 'connection' event on a wss. Must be registered BEFORE connect(). */
function nextServerConn(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => wss.once('connection', resolve))
}

function waitEvent<T = void>(
  emitter: { once(e: string, fn: (...a: unknown[]) => void): void },
  event: string,
): Promise<T> {
  return new Promise((resolve) => emitter.once(event, (...a) => resolve(a[0] as T)))
}

/** Read one JSON message from a WebSocket. */
function readOne<T = unknown>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data: WebSocket.RawData) => {
      try { resolve(JSON.parse(data.toString())) }
      catch (e) { reject(e) }
    })
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WSClient', () => {
  let wss: WebSocketServer
  let port: number
  let client: WSClient

  beforeEach(async () => {
    const s = await startServer()
    wss = s.wss
    port = s.port
  })

  afterEach(async () => {
    client?.destroy()
    await closeServer(wss)
  })

  it('connects to the server and emits "connected"', async () => {
    client = new WSClient({ serverUrl: `ws://localhost:${port}` })
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected
    expect(client.isConnected()).toBe(true)
  })

  it('sends Authorization header when appToken is set', async () => {
    // Register server handler BEFORE connect().
    const authHeader = new Promise<string>((resolve) => {
      wss.once('connection', (_ws, req) => resolve(req.headers['authorization'] as string))
    })

    client = new WSClient({ serverUrl: `ws://localhost:${port}`, appToken: 'my-secret' })
    client.connect()

    expect(await authHeader).toBe('Bearer my-secret')
  })

  it('emits "message" for incoming JSON', async () => {
    const messages: unknown[] = []
    client = new WSClient({ serverUrl: `ws://localhost:${port}` })
    client.on('message', (msg) => messages.push(msg))

    // Register before connect.
    const serverConnPromise = nextServerConn(wss)
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected

    const serverConn = await serverConnPromise
    serverConn.send(JSON.stringify({ type: 'user_message', text: 'hello' }))

    await new Promise((r) => setTimeout(r, 50))
    expect(messages).toHaveLength(1)
    expect((messages[0] as { text: string }).text).toBe('hello')
  })

  it('auto-replies to heartbeat_ping with heartbeat_pong', async () => {
    const serverConnPromise = nextServerConn(wss)
    client = new WSClient({ serverUrl: `ws://localhost:${port}` })
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected

    const serverConn = await serverConnPromise
    const pongReceived = readOne<{ type: string }>(serverConn)
    serverConn.send(JSON.stringify({ type: TypeHeartbeatPing }))

    const pong = await pongReceived
    expect(pong.type).toBe(TypeHeartbeatPong)
  })

  it('does NOT emit "message" for heartbeat_ping (handled internally)', async () => {
    const serverConnPromise = nextServerConn(wss)
    const messages: unknown[] = []
    client = new WSClient({ serverUrl: `ws://localhost:${port}` })
    client.on('message', (msg) => messages.push(msg))

    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected

    const serverConn = await serverConnPromise
    serverConn.send(JSON.stringify({ type: TypeHeartbeatPing }))

    await new Promise((r) => setTimeout(r, 50))
    expect(messages).toHaveLength(0)
  })

  it('returns false from send() when not connected', () => {
    client = new WSClient({ serverUrl: `ws://localhost:${port}` })
    expect(client.send({ type: 'test' })).toBe(false)
  })

  it('returns true from send() when connected', async () => {
    client = new WSClient({ serverUrl: `ws://localhost:${port}` })
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected
    expect(client.send({ type: 'test' })).toBe(true)
  })

  it('emits "disconnected" when server closes', async () => {
    const serverConnPromise = nextServerConn(wss)
    client = new WSClient({ serverUrl: `ws://localhost:${port}`, reconnectBaseMs: 100_000 })
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected

    const serverConn = await serverConnPromise
    const disconnected = waitEvent(client, 'disconnected')
    serverConn.close()
    await disconnected

    expect(client.isConnected()).toBe(false)
  })

  it('reconnects after disconnection', async () => {
    // Expect two connections: initial + reconnect.
    let connectCount = 0
    const secondConn = new Promise<void>((resolve) => {
      wss.on('connection', () => {
        connectCount++
        if (connectCount >= 2) resolve()
      })
    })

    client = new WSClient({ serverUrl: `ws://localhost:${port}`, reconnectBaseMs: 30 })
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected

    // Close the first connection from the server side.
    const allConns: WebSocket[] = []
    wss.clients.forEach((c) => allConns.push(c))
    allConns.forEach((c) => c.close())

    await secondConn
    expect(connectCount).toBeGreaterThanOrEqual(2)
  })

  it('destroy() prevents reconnection', async () => {
    let connectCount = 0
    wss.on('connection', () => connectCount++)

    const serverConnPromise = nextServerConn(wss)
    client = new WSClient({ serverUrl: `ws://localhost:${port}`, reconnectBaseMs: 20 })
    const connected = waitEvent(client, 'connected')
    client.connect()
    await connected
    const serverConn = await serverConnPromise

    client.destroy()
    serverConn.close()

    await new Promise((r) => setTimeout(r, 200))
    // Still only 1 connection (no reconnect after destroy).
    expect(connectCount).toBe(1)
  })
})
