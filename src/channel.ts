/**
 * M2 – ESP32 Channel Plugin for OpenClaw.
 *
 * Implements ChannelPlugin<ResolvedESP32Account> from openclaw/plugin-sdk.
 * The plugin connects outward to esp32-openclaw-server via WebSocket (M0 protocol).
 *
 * Entry point: the root index.ts calls api.registerChannel({ plugin: esp32ChannelPlugin }).
 *
 * MVP mode:
 *  - All users are "unknown"; no voiceprint logic.
 *  - Session key is built by Plugin from msg fields (agent_id, user_id).
 *  - No pairing checks.
 */

import type {
  ChannelPlugin,
  ClawdbotChannelConfig,
} from 'openclaw/plugin-sdk'
import {
  AgentReplyChunk,
  AgentReplyDone,
  TypeAgentReply,
  TypeAgentReplyDone,
  TypeUserMessage,
  UserMessage,
} from './protocol.js'
import { WSClient } from './ws-client.js'

// ── Account type ──────────────────────────────────────────────────────────────

export interface ResolvedESP32Account {
  serverUrl: string
  appToken?: string
  defaultAgent: string
  sessionScope: 'per-user' | 'per-device'
}

// ── Module-level runtime stores ───────────────────────────────────────────────

const wsClients = new Map<string, WSClient>()

/** Per-message metadata: chunkIndex and agentId, keyed by message_id. */
interface MessageMeta { idx: number; agentId: string }
const messageMeta = new Map<string, MessageMeta>()

/** Test helper: inject a fake WSClient for unit testing outbound methods. */
export function _testSetWSClient(accountId: string, client: WSClient): void {
  wsClients.set(accountId, client)
}

/** Test helper: remove a WSClient entry (cleanup). */
export function _testClearWSClient(accountId: string): void {
  wsClients.delete(accountId)
}

// ── Sentence splitting ────────────────────────────────────────────────────────

const SENTENCE_END_RE = /[。！？\n]/u
const SENTENCE_PAUSE_RE = /[，；]/u
const PAUSE_THRESHOLD = 50

/** Returns true when text contains at least one letter, digit, or CJK character.
 * Segments that are purely punctuation/whitespace (e.g. a lone `"`) produce no
 * audio from TTS and should be dropped rather than sent as empty sentences. */
function hasSpeakableContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/**
 * Split text into sentence-level pieces.
 * Always splits on 。！？\n; splits on ，； when accumulated rune count ≥ 50.
 * Any trailing incomplete segment is returned as the last element.
 * Segments that contain no speakable characters (letters/digits) are dropped.
 *
 * Uses for...of to iterate Unicode code points correctly (handles surrogate pairs).
 */
export function splitIntoSentences(text: string): string[] {
  const sentences: string[] = []
  let remaining = text

  for (; ;) {
    let bytePos = 0
    let runeCount = 0
    let found = false

    for (const char of remaining) {
      runeCount++
      const charLen = char.length // 1 for BMP, 2 for surrogate pairs

      if (SENTENCE_END_RE.test(char)) {
        const end = bytePos + charLen
        const sentence = remaining.slice(0, end).trim()
        if (sentence && hasSpeakableContent(sentence)) sentences.push(sentence)
        remaining = remaining.slice(end)
        found = true
        break
      }
      if (SENTENCE_PAUSE_RE.test(char) && runeCount >= PAUSE_THRESHOLD) {
        const end = bytePos + charLen
        const sentence = remaining.slice(0, end).trim()
        if (sentence && hasSpeakableContent(sentence)) sentences.push(sentence)
        remaining = remaining.slice(end)
        found = true
        break
      }

      bytePos += charLen
    }

    if (!found) break
  }

  const tail = remaining.trim()
  if (tail && hasSpeakableContent(tail)) sentences.push(tail)

  return sentences
}

// ── Voice mode system prompt ──────────────────────────────────────────────────

const ESP32_VOICE_PROMPT = `\

## Reply Rules
- 😄 emoji at start of sentence to show the emotion 
- Dialogue: "XX说: words" or "XX says/said: words"
- Max 100 words per sentence, expect on user's request
- No tables/Markdown

## Error Correction
- Misheard → infer intent → confirm or fix

## Emoji List
😶 🙂 😆 😂 😔 😠 😭 😍 😳 😲 😱 🤔 😉 😎 😌 🤤 😘 😏 😴 😜 🙄

## Notes
- TTS output, keep sentences short
- Unknown user → default user`

/** Wraps user voice input with the ESP32 voice-mode system prompt so the
 *  agent follows TTS-friendly reply rules regardless of its base system prompt. */
function buildBody(userText: string): string {
  return `[Voice Input]\n${userText}\n\n[Voice Mode Instructions]\n${ESP32_VOICE_PROMPT}`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSessionKey(msg: UserMessage, account: ResolvedESP32Account): string {
  const agentId = msg.agent_id || account.defaultAgent
  // In MVP mode user_id is always empty (no voiceprint). Use device_id as a
  // proxy so each physical device gets its own isolated OpenClaw session.
  const userId = msg.user_id || `unknown_${msg.device_id}`

  if (account.sessionScope === 'per-device') {
    // per-device: session is scoped to a specific device + user pair.
    // Same user on different devices → different sessions.
    // Future: userId will be the voiceprint-resolved user ID.
    return `agent:${agentId}:esp32:group:${msg.device_id}:${userId}`
  } else {
    // per-user: session is scoped to the user only, regardless of device.
    // Same user speaking from any device → same session (shared history).
    // direct: session type gives each user their own private conversation.
    // Future: userId will be the voiceprint-resolved user ID.
    return `agent:${agentId}:esp32:direct:${userId}`
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

// ── ChannelPlugin ─────────────────────────────────────────────────────────────

export const esp32ChannelPlugin: ChannelPlugin<ResolvedESP32Account> = {
  id: 'esp32',

  meta: {
    label: 'ESP32-OpenClaw',
    selectionLabel: 'ESP32 Voice (小智)',
    docsPath: '/channels/esp32',
    aliases: ['xiaozhi', 'esp32'],
    order: 80,
  },

  capabilities: {
    chatTypes: ['group', 'direct'],
    voice: true,
    streaming: true,
  },

  configSchema: {
    schema: {
      type: 'object',
      title: 'ESP32-OpenClaw',
      properties: {
        serverUrl: {
          type: 'string',
          title: 'Server URL',
          description: 'esp32-openclaw-server 的 WebSocket 地址，例如 ws://host:8989/plugin',
        },
        appToken: {
          type: 'string',
          title: 'App Token',
          description: '连接服务器的 Bearer Token（未设置认证时留空）',
        },
        defaultAgent: {
          type: 'string',
          title: 'Default Agent',
          description: '设备未指定 Agent 时使用的默认 Agent ID',
          default: 'main',
        },
        session: {
          type: 'object',
          title: 'Session Settings',
          properties: {
            scope: {
              type: 'string',
              title: 'Session Scope',
              enum: ['per-user', 'per-device'],
              default: 'per-user',
            },
          },
        },
      },
      required: ['serverUrl'],
    },
  },

  config: {
    listAccountIds: (cfg: ClawdbotChannelConfig): string[] => {
      console.log('[esp32] listAccountIds cfg.channels:', JSON.stringify(cfg?.channels))
      return cfg?.channels?.esp32?.serverUrl ? ['default'] : []
    },

    resolveAccount: (
      cfg: ClawdbotChannelConfig,
      _accountId: string,
    ): ResolvedESP32Account | null => {
      const s = cfg?.channels?.esp32
      console.log('[esp32] resolveAccount s:', JSON.stringify(s))
      if (!s?.serverUrl) return null
      return {
        serverUrl: s.serverUrl,
        appToken: s.appToken,
        defaultAgent: s.defaultAgent ?? 'main',
        sessionScope: s.session?.scope ?? 'per-user',
      }
    },

    isConfigured: (account: ResolvedESP32Account): boolean => !!account?.serverUrl,

    describeAccount: (account: ResolvedESP32Account): string =>
      account?.serverUrl ? `ESP32 server at ${account.serverUrl}` : 'Not configured',
  },

  gateway: {
    startAccount: async (ctx) => {
      const log = ctx.log
      log.info('[esp32] startAccount', { accountId: ctx.accountId, serverUrl: ctx.account.serverUrl })

      const client = new WSClient({
        serverUrl: ctx.account.serverUrl,
        appToken: ctx.account.appToken,
      })
      wsClients.set(ctx.accountId, client)

      client.on('connected', () => {
        log.info('[esp32] connected to server', { serverUrl: ctx.account.serverUrl })
      })

      client.on('disconnected', () => {
        log.warn('[esp32] disconnected from server, will reconnect', { serverUrl: ctx.account.serverUrl })
      })

      client.on('error', (err: Error) => {
        log.error(`[esp32] websocket error: ${err.message}`, { serverUrl: ctx.account.serverUrl })
      })

      client.on('message', (raw: unknown) => {
        const msg = raw as { type: string }
        if (msg.type !== TypeUserMessage) return
        const userMsg = msg as UserMessage

        const agentId = userMsg.agent_id || ctx.account.defaultAgent
        log.info('[esp32] user_message received', {
          device_id: userMsg.device_id,
          message_id: userMsg.message_id,
          agentId,
          text: userMsg.text,
        })

        // Store per-message metadata for outbound.sendText
        messageMeta.set(userMsg.message_id, { idx: 0, agentId })

        const messageId = userMsg.message_id
        const deviceId = userMsg.device_id
        const wsClient = wsClients.get(ctx.accountId)
        let lastSentSentenceCount = 0
        // Capture the moment the user_message was received so we can detect
        // stale messages that have been sitting in OpenClaw's session queue
        // behind previously timed-out requests.
        const messageReceivedAt = Date.now()
        // TTL must stay below the server's replyTimeout (120 s) so a stale
        // message is skipped before the server's pending entry expires for it.
        const MESSAGE_TTL_MS = 110_000

        const dispatcher = {
          sendFinalReply: async (payload: any) => {
            const textStr = typeof payload === 'string' ? payload : (payload?.text ?? '')
            const ageSinceReceived = Date.now() - messageReceivedAt
            if (ageSinceReceived > MESSAGE_TTL_MS) {
              log.warn(`[esp32] sendFinalReply: stale message skipped (age ${ageSinceReceived}ms > ${MESSAGE_TTL_MS}ms), messageId=${messageId}`)
              // Send reply_done so the server can clean up any lingering state.
              wsClient?.send({ type: TypeAgentReplyDone, message_id: messageId, device_id: deviceId } satisfies AgentReplyDone)
              messageMeta.delete(messageId)
              return
            }
            log.info(`[esp32] sendFinalReply called: messageId=${messageId} text=${textStr.slice(0, 50)}`)
            if (!wsClient) { log.error('[esp32] sendFinalReply: no wsClient'); return }

            const sentences = splitIntoSentences(textStr)
            const meta = messageMeta.get(messageId) ?? { idx: 0, agentId }

            for (let i = lastSentSentenceCount; i < sentences.length; i++) {
              wsClient.send({
                type: TypeAgentReply,
                message_id: messageId,
                device_id: deviceId,
                chunk_index: meta.idx++,
                text: sentences[i],
                agent_id: meta.agentId,
                is_final: false,
                needs_input: false,
              } satisfies AgentReplyChunk)
            }
            lastSentSentenceCount = sentences.length

            messageMeta.set(messageId, meta)
            wsClient.send({ type: TypeAgentReplyDone, message_id: messageId, device_id: deviceId } satisfies AgentReplyDone)
            messageMeta.delete(messageId)
          },
          getQueuedCounts: () => ({ block: 0, final: 0 }),
          markComplete: () => { },
          waitForIdle: async () => { },
        }

        const replyOptions = {
          onPartialReply: (payload: any) => {
            const textStr = typeof payload === 'string' ? payload : (payload?.text ?? '')
            if (!wsClient || !textStr) return
            if (Date.now() - messageReceivedAt > MESSAGE_TTL_MS) return

            const sentences = splitIntoSentences(textStr)
            const completeSentencesCount = Math.max(0, sentences.length - 1)

            if (completeSentencesCount > lastSentSentenceCount) {
              const meta = messageMeta.get(messageId) ?? { idx: 0, agentId }
              for (let i = lastSentSentenceCount; i < completeSentencesCount; i++) {
                wsClient.send({
                  type: TypeAgentReply,
                  message_id: messageId,
                  device_id: deviceId,
                  chunk_index: meta.idx++,
                  text: sentences[i],
                  agent_id: meta.agentId,
                  is_final: false,
                  needs_input: false,
                } satisfies AgentReplyChunk)
              }
              messageMeta.set(messageId, meta)
              lastSentSentenceCount = completeSentencesCount
            }
          }
        }

        const cr = ctx.channelRuntime as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
        const ctxPayload = {
          Surface: 'esp32',
          From: userMsg.user_id || 'unknown',
          To: `${userMsg.device_id}:${userMsg.message_id}`,
          SessionKey: buildSessionKey(userMsg, ctx.account),
          Body: buildBody(userMsg.text),
          MessageSid: userMsg.message_id,
          AgentId: agentId,
        }
        log.info(`[esp32] dispatching: Surface=esp32 To=${ctxPayload.To} SessionKey=${ctxPayload.SessionKey}`)
          ; (cr['reply']['dispatchReplyFromConfig']({
            ctx: ctxPayload,
            cfg: ctx.cfg,
            dispatcher,
            replyOptions,
          }) as Promise<unknown>)
            .catch((err: unknown) => {
              log.error(`[esp32] dispatch error: ${err instanceof Error ? err.message : String(err)}`)
            })
      })

      client.connect()
      log.info('[esp32] connecting…', { serverUrl: ctx.account.serverUrl })

      await waitForAbort(ctx.abortSignal)
      log.info('[esp32] account stopped, destroying client', { accountId: ctx.accountId })
      client.destroy()
      wsClients.delete(ctx.accountId)
    },
  },

  outbound: {
    deliveryMode: 'direct',

    chunker: (text: string, _limit: number): string[] => splitIntoSentences(text),
    chunkerMode: 'plain',
    textChunkLimit: 2000,

    sendText: async ({ cfg: _cfg, to, text, accountId }) => {
      console.log(`[esp32] sendText called: to=${to} accountId=${accountId} text=${text.slice(0, 30)}`)
      const sep = to.indexOf(':')
      const deviceId = to.slice(0, sep)
      const messageId = to.slice(sep + 1)

      const client = wsClients.get(accountId)
      if (!client) throw new Error(`[esp32] no WSClient for accountId="${accountId}"`)

      const meta = messageMeta.get(messageId) ?? { idx: 0, agentId: accountId }
      const chunk: AgentReplyChunk = {
        type: TypeAgentReply,
        message_id: messageId,
        device_id: deviceId,
        chunk_index: meta.idx,
        text,
        agent_id: meta.agentId,
        is_final: false,
        needs_input: false,
      }
      meta.idx++
      messageMeta.set(messageId, meta)

      client.send(chunk)
      return { channel: 'esp32', messageId }
    },

    onStreamEnd: async ({ cfg: _cfg, to, accountId }) => {
      console.log(`[esp32] onStreamEnd called: to=${to} accountId=${accountId}`)
      const sep = to.indexOf(':')
      const deviceId = to.slice(0, sep)
      const messageId = to.slice(sep + 1)

      const client = wsClients.get(accountId)
      if (client) {
        const done: AgentReplyDone = {
          type: TypeAgentReplyDone,
          message_id: messageId,
          device_id: deviceId,
        }
        client.send(done)
      }
      messageMeta.delete(messageId)
    },
  },
}
