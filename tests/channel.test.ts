/**
 * Unit tests for esp32ChannelPlugin (M2 – real OpenClaw ChannelPlugin interface).
 *
 * Groups:
 *  A – splitIntoSentences (pure function)
 *  B – config adapter (listAccountIds / resolveAccount / isConfigured)
 *  C – outbound.sendText (fake WSClient via _testSetWSClient)
 *  D – outbound.onStreamEnd (fake WSClient)
 *  E – gateway.startAccount integration (real in-process WSS)
 *  F – gateway.startAccount abort (real in-process WSS)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import {
  esp32ChannelPlugin,
  splitIntoSentences,
  _testSetWSClient,
  _testClearWSClient,
} from '../src/channel.js'
import { WSClient } from '../src/ws-client.js'
import {
  TypeAgentReply,
  TypeAgentReplyDone,
  TypeUserMessage,
  UserMessage,
} from '../src/protocol.js'

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

function nextConnection(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => wss.once('connection', resolve))
}

function makeUserMsg(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    type: TypeUserMessage,
    message_id: 'msg-001',
    device_id: 'living-room',
    speaker_id: '',
    user_id: 'unknown',
    user_status: 'unknown',
    display_name: 'Unknown',
    text: '你好！',
    confidence: 0,
    agent_id: 'main',
    timestamp: Date.now(),
    ...overrides,
  }
}

// ── A: splitIntoSentences ─────────────────────────────────────────────────────

describe('splitIntoSentences', () => {
  it('returns single sentence with 。', () => {
    const result = splitIntoSentences('今天天气很好。')
    expect(result).toEqual(['今天天气很好。'])
  })

  it('splits on 。！？ into multiple sentences', () => {
    const result = splitIntoSentences('第一句！第二句？第三句。')
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('第一句！')
    expect(result[1]).toBe('第二句？')
    expect(result[2]).toBe('第三句。')
  })

  it('splits on \\n', () => {
    const result = splitIntoSentences('第一行\n第二行。')
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('comma below threshold does NOT split (returns whole as one or at final 。)', () => {
    const result = splitIntoSentences('你好，世界。') // '，' at rune 3, below 50
    // No split at comma; split at 。 → one sentence
    expect(result).toHaveLength(1)
    expect(result[0]).toBe('你好，世界。')
  })

  it('comma above threshold DOES split', () => {
    const long = 'x'.repeat(50) + '，后半段。'
    const result = splitIntoSentences(long)
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result[0]).toBe('x'.repeat(50) + '，')
    expect(result[1]).toBe('后半段。')
  })

  it('returns remainder with no boundary as last element', () => {
    const result = splitIntoSentences('第一句。未完成')
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('第一句。')
    expect(result[1]).toBe('未完成')
  })

  it('returns empty array for empty string', () => {
    expect(splitIntoSentences('')).toEqual([])
  })

  it('returns remainder for text with no boundary', () => {
    const result = splitIntoSentences('没有句号')
    expect(result).toEqual(['没有句号'])
  })
})

// ── B: config adapter ─────────────────────────────────────────────────────────

describe('esp32ChannelPlugin.config', () => {
  const { config } = esp32ChannelPlugin

  it('listAccountIds returns [] when no serverUrl', () => {
    expect(config.listAccountIds({})).toEqual([])
    expect(config.listAccountIds({ channels: {} })).toEqual([])
    expect(config.listAccountIds({ channels: { esp32: {} } })).toEqual([])
  })

  it('listAccountIds returns ["default"] when serverUrl present', () => {
    const cfg = { channels: { esp32: { serverUrl: 'ws://localhost:8989/plugin' } } }
    expect(config.listAccountIds(cfg)).toEqual(['default'])
  })

  it('resolveAccount returns null when no serverUrl', () => {
    expect(config.resolveAccount({}, 'default')).toBeNull()
    expect(config.resolveAccount({ channels: { esp32: {} } }, 'default')).toBeNull()
  })

  it('resolveAccount returns correct account', () => {
    const cfg = {
      channels: {
        esp32: {
          serverUrl: 'ws://localhost:8989/plugin',
          appToken: 'secret',
          defaultAgent: 'assistant',
          session: { scope: 'per-device' as const },
        },
      },
    }
    const account = config.resolveAccount(cfg, 'default')
    expect(account).not.toBeNull()
    expect(account!.serverUrl).toBe('ws://localhost:8989/plugin')
    expect(account!.appToken).toBe('secret')
    expect(account!.defaultAgent).toBe('assistant')
    expect(account!.sessionScope).toBe('per-device')
  })

  it('resolveAccount applies defaults', () => {
    const cfg = { channels: { esp32: { serverUrl: 'ws://localhost:8989/plugin' } } }
    const account = config.resolveAccount(cfg, 'default')!
    expect(account.defaultAgent).toBe('main')
    expect(account.sessionScope).toBe('per-user')
  })

  it('isConfigured returns true when serverUrl set', () => {
    const account = { serverUrl: 'ws://localhost', defaultAgent: 'main', sessionScope: 'per-user' as const }
    expect(config.isConfigured(account)).toBe(true)
  })

  it('isConfigured returns false when serverUrl empty', () => {
    const account = { serverUrl: '', defaultAgent: 'main', sessionScope: 'per-user' as const }
    expect(config.isConfigured(account)).toBe(false)
  })
})

// ── C: outbound.sendText ──────────────────────────────────────────────────────

describe('esp32ChannelPlugin.outbound.sendText', () => {
  const ACCOUNT_ID = 'test-send'
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSend = vi.fn()
    _testSetWSClient(ACCOUNT_ID, { send: mockSend } as unknown as WSClient)
  })

  afterEach(() => {
    _testClearWSClient(ACCOUNT_ID)
  })

  it('sends an AgentReplyChunk with correct fields', async () => {
    const result = await esp32ChannelPlugin.outbound.sendText({
      cfg: {},
      to: 'living-room:msg-001',
      text: '今天天气很好。',
      accountId: ACCOUNT_ID,
    })

    expect(result).toEqual({ channel: 'esp32', messageId: 'msg-001' })
    expect(mockSend).toHaveBeenCalledOnce()
    const chunk = mockSend.mock.calls[0][0]
    expect(chunk.type).toBe(TypeAgentReply)
    expect(chunk.message_id).toBe('msg-001')
    expect(chunk.device_id).toBe('living-room')
    expect(chunk.text).toBe('今天天气很好。')
    expect(chunk.is_final).toBe(false)
    expect(chunk.needs_input).toBe(false)
  })

  it('chunk_index increments across sendText calls for same message', async () => {
    const opts = { cfg: {}, to: 'device:msg-seq', text: '一', accountId: ACCOUNT_ID }
    await esp32ChannelPlugin.outbound.sendText(opts)
    await esp32ChannelPlugin.outbound.sendText({ ...opts, text: '二' })
    await esp32ChannelPlugin.outbound.sendText({ ...opts, text: '三' })

    expect(mockSend).toHaveBeenCalledTimes(3)
    expect(mockSend.mock.calls[0][0].chunk_index).toBe(0)
    expect(mockSend.mock.calls[1][0].chunk_index).toBe(1)
    expect(mockSend.mock.calls[2][0].chunk_index).toBe(2)

    // Cleanup
    await esp32ChannelPlugin.outbound.onStreamEnd!({ cfg: {}, to: 'device:msg-seq', accountId: ACCOUNT_ID })
  })

  it('throws when no WSClient registered for accountId', async () => {
    await expect(
      esp32ChannelPlugin.outbound.sendText({ cfg: {}, to: 'x:y', text: 'hi', accountId: 'no-such-account' }),
    ).rejects.toThrow('no WSClient')
  })
})

// ── D: outbound.onStreamEnd ───────────────────────────────────────────────────

describe('esp32ChannelPlugin.outbound.onStreamEnd', () => {
  const ACCOUNT_ID = 'test-done'
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSend = vi.fn()
    _testSetWSClient(ACCOUNT_ID, { send: mockSend } as unknown as WSClient)
  })

  afterEach(() => {
    _testClearWSClient(ACCOUNT_ID)
  })

  it('sends AgentReplyDone with correct fields', async () => {
    await esp32ChannelPlugin.outbound.onStreamEnd!({
      cfg: {},
      to: 'living-room:msg-001',
      accountId: ACCOUNT_ID,
    })

    expect(mockSend).toHaveBeenCalledOnce()
    const done = mockSend.mock.calls[0][0]
    expect(done.type).toBe(TypeAgentReplyDone)
    expect(done.message_id).toBe('msg-001')
    expect(done.device_id).toBe('living-room')
  })

  it('chunk_index resets after onStreamEnd for same message', async () => {
    const sendOpts = { cfg: {}, to: 'dev:msg-reset', text: 'x', accountId: ACCOUNT_ID }

    await esp32ChannelPlugin.outbound.sendText(sendOpts)
    await esp32ChannelPlugin.outbound.sendText({ ...sendOpts, text: 'y' })
    await esp32ChannelPlugin.outbound.onStreamEnd!({ cfg: {}, to: 'dev:msg-reset', accountId: ACCOUNT_ID })

    // After stream end + new message starts, idx should reset
    await esp32ChannelPlugin.outbound.sendText({ ...sendOpts, to: 'dev:msg-reset2', text: 'z' })
    const call = mockSend.mock.calls[mockSend.mock.calls.length - 1][0]
    expect(call.chunk_index).toBe(0)

    // Cleanup
    await esp32ChannelPlugin.outbound.onStreamEnd!({ cfg: {}, to: 'dev:msg-reset2', accountId: ACCOUNT_ID })
  })

  it('does not throw when WSClient not found', async () => {
    await expect(
      esp32ChannelPlugin.outbound.onStreamEnd!({ cfg: {}, to: 'x:y', accountId: 'no-such' }),
    ).resolves.toBeUndefined()
  })
})

// ── E: gateway.startAccount integration ──────────────────────────────────────

describe('esp32ChannelPlugin.gateway.startAccount', () => {
  let wss: WebSocketServer
  let port: number
  let serverConn: WebSocket
  let controller: AbortController

  beforeEach(async () => {
    const s = await startServer()
    wss = s.wss
    port = s.port
    controller = new AbortController()
  })

  afterEach(async () => {
    controller.abort()
    await closeServer(wss)
  })

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      cfg: { channels: { esp32: { serverUrl: `ws://localhost:${port}` } } },
      accountId: 'default',
      account: {
        serverUrl: `ws://localhost:${port}`,
        defaultAgent: 'main',
        sessionScope: 'per-user' as const,
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      channelRuntime: { reply: { dispatchReplyFromConfig: vi.fn().mockResolvedValue(undefined) } },
      abortSignal: controller.signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ...overrides,
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it('connects to server on startAccount()', async () => {
    const connPromise = nextConnection(wss)
    const ctx = makeCtx()
    void esp32ChannelPlugin.gateway.startAccount(ctx)
    serverConn = await connPromise
    expect(serverConn.readyState).toBe(WebSocket.OPEN)
  })

  it('dispatches user_message with correct ctx payload', async () => {
    const connPromise = nextConnection(wss)
    const ctx = makeCtx()
    void esp32ChannelPlugin.gateway.startAccount(ctx)
    serverConn = await connPromise
    await new Promise((r) => setTimeout(r, 20))

    const msg = makeUserMsg({ user_id: 'alice', display_name: 'Alice', agent_id: 'main' })
    serverConn.send(JSON.stringify(msg))

    await new Promise((r) => setTimeout(r, 100))

    expect(ctx.channelRuntime.reply.dispatchReplyFromConfig).toHaveBeenCalledOnce()
    const params = ctx.channelRuntime.reply.dispatchReplyFromConfig.mock.calls[0][0]
    const ctxPayload = params['ctx']

    expect(ctxPayload.Surface).toBe('esp32')
    expect(ctxPayload.From).toBe('alice')
    expect(ctxPayload.To).toBe('living-room:msg-001')
    expect(ctxPayload.SessionKey).toBe('agent:main:esp32:direct:alice')
    expect(ctxPayload.Body).toContain('你好！')
    expect(ctxPayload.Body).toContain('Reply Rules')
    expect(ctxPayload.MessageSid).toBe('msg-001')
    expect(ctxPayload.AgentId).toBe('main')
  })

  it('ignores non-user_message types silently', async () => {
    const connPromise = nextConnection(wss)
    const ctx = makeCtx()
    void esp32ChannelPlugin.gateway.startAccount(ctx)
    serverConn = await connPromise
    await new Promise((r) => setTimeout(r, 20))

    serverConn.send(JSON.stringify({ type: 'device_connected', device_id: 'abc' }))
    await new Promise((r) => setTimeout(r, 50))

    expect(ctx.channelRuntime.reply.dispatchReplyFromConfig).not.toHaveBeenCalled()
  })
})

// ── F: gateway.startAccount abort ────────────────────────────────────────────

describe('esp32ChannelPlugin.gateway.startAccount – abort', () => {
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    const s = await startServer()
    wss = s.wss
    port = s.port
  })

  afterEach(async () => {
    await closeServer(wss)
  })

  it('destroys WSClient when abort signal fires', async () => {
    const controller = new AbortController()
    const connPromise = nextConnection(wss)

    const ctx = {
      cfg: {},
      accountId: 'default',
      account: { serverUrl: `ws://localhost:${port}`, defaultAgent: 'main', sessionScope: 'per-user' },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      channelRuntime: { reply: { dispatchReplyFromConfig: vi.fn().mockResolvedValue(undefined) } },
      abortSignal: controller.signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any

    void esp32ChannelPlugin.gateway.startAccount(ctx)
    const serverConn = await connPromise
    await new Promise((r) => setTimeout(r, 20))

    let closed = false
    serverConn.once('close', () => { closed = true })

    controller.abort()
    await new Promise((r) => setTimeout(r, 100))

    expect(closed).toBe(true)
  })
})
