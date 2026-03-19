/**
 * Local ambient type stubs for "openclaw/plugin-sdk".
 *
 * The real SDK (openclaw >=2026.3.1) is a private distribution not published
 * on npm. These stubs are derived from the feishu reference plugin at
 * https://github.com/m1heng/clawdbot-feishu and from MODULE_SPEC M2.
 *
 * When the real SDK becomes available, replace this file with the real types.
 *
 * Key assumption to verify against the real SDK:
 *   ctx.runtime.channel.handleMessage(msg) — the method to dispatch an
 *   inbound message into the OpenClaw Gateway routing pipeline.
 */

declare module 'openclaw/plugin-sdk' {
  // ── Plugin-level API ─────────────────────────────────────────────────────────

  export function emptyPluginConfigSchema(): PluginConfigSchema
  export interface PluginConfigSchema {}

  export interface OpenClawPluginApi {
    runtime: OpenClawRuntime
    registerChannel(opts: { plugin: ChannelPlugin<any> }): void
  }

  // ── Runtime handle (opaque; injected by the Gateway into startAccount) ───────

  export interface OpenClawRuntime {
    /**
     * Dispatch an inbound message into the OpenClaw Gateway routing pipeline.
     * Based on MODULE_SPEC M2 design — verify exact method name against real SDK.
     */
    channel: {
      handleMessage(msg: InboundMessage): Promise<void>
    }
  }

  // ── Inbound message (Plugin → Gateway) ──────────────────────────────────────

  export interface InboundMessage {
    channel: string
    chatType: 'direct' | 'group'
    /** Session key built by Plugin; identifies the conversation context. */
    sessionKey: string
    from: { id: string; name: string; isBot: boolean }
    to: { id: string; isBot: boolean }
    message: { id: string; text: string; timestamp: number }
    /**
     * Peer ID used to route replies back. For ESP32:
     * kind="group", id="${device_id}:${message_id}"
     */
    peer: { kind: 'group' | 'direct'; id: string }
    metadata?: Record<string, unknown>
  }

  // ── ChannelPlugin<TAccount> ──────────────────────────────────────────────────

  export interface ChannelPlugin<TAccount> {
    id: string
    meta: ChannelMeta
    capabilities?: ChannelCapabilities
    configSchema?: ChannelConfigSchema
    config: ChannelConfigAdapter<TAccount>
    gateway: ChannelGateway<TAccount>
    outbound: ChannelOutboundAdapter
    // Optional sections not implemented in MVP
    pairing?: unknown
    security?: unknown
    setup?: unknown
    messaging?: unknown
    directory?: unknown
    status?: unknown
  }

  export interface ChannelMeta {
    label: string
    selectionLabel?: string
    docsPath?: string
    aliases?: string[]
    order?: number
  }

  export interface ChannelCapabilities {
    chatTypes?: Array<'direct' | 'group'>
    voice?: boolean
    streaming?: boolean
    threads?: boolean
    media?: boolean
    reactions?: boolean
  }

  export interface ChannelConfigSchema {
    schema: object
  }

  // ── Config adapter ───────────────────────────────────────────────────────────

  export interface ChannelConfigAdapter<TAccount> {
    listAccountIds(cfg: ClawdbotChannelConfig): string[]
    resolveAccount(cfg: ClawdbotChannelConfig, accountId: string): TAccount | null
    defaultAccountId?(cfg: ClawdbotChannelConfig): string | undefined
    isConfigured(account: TAccount): boolean
    describeAccount?(account: TAccount): string
  }

  /**
   * The full OpenClaw config passed to all config adapter methods.
   * ESP32-OpenClaw settings live under channels.esp32, consistent with
   * other channel plugins (e.g. clawdbot-feishu uses cfg.channels.feishu).
   */
  export interface ClawdbotChannelConfig {
    channels?: {
      esp32?: Esp32ChannelConfig
      [key: string]: unknown
    }
    [key: string]: unknown
  }

  export interface Esp32ChannelConfig {
    serverUrl?: string
    appToken?: string
    defaultAgent?: string
    session?: { scope?: 'per-user' | 'per-device' }
  }

  // ── Gateway ──────────────────────────────────────────────────────────────────

  export interface ChannelGateway<TAccount> {
    startAccount(ctx: GatewayContext<TAccount>): Promise<void>
  }

  export interface ChannelRuntime {
    handleMessage(msg: InboundMessage): Promise<void>
  }

  export interface GatewayContext<TAccount> {
    cfg: ClawdbotChannelConfig
    accountId: string
    account: TAccount
    runtime: OpenClawRuntime
    channelRuntime: ChannelRuntime
    abortSignal: AbortSignal
    log: Logger
    getStatus?(): unknown
    setStatus?(status: unknown): void
  }

  // ── Outbound adapter (Gateway → Plugin → Device) ─────────────────────────────

  export interface ChannelOutboundAdapter {
    /**
     * "direct": Gateway pre-chunks text via `chunker` and calls `sendText`
     * once per chunk.
     */
    deliveryMode: 'direct' | 'buffered'
    /** Split text into sentence-level pieces before sending. */
    chunker?(text: string, limit: number): string[]
    chunkerMode?: string
    textChunkLimit?: number
    /** Called for each pre-chunked sentence. */
    sendText(opts: SendTextOpts): Promise<SendTextResult>
    /**
     * Called once after all `sendText` calls for one reply are complete.
     * Use this to send `agent_reply_done` to the Go server.
     * Optional — if not present, the Go server falls back to its 30s timeout.
     */
    onStreamEnd?(opts: StreamEndOpts): Promise<void>
  }

  export interface SendTextOpts {
    cfg: ClawdbotChannelConfig
    to: string      // peer.id = "${device_id}:${message_id}"
    text: string
    accountId: string
  }

  export interface SendTextResult {
    channel: string
    messageId?: string
  }

  export interface StreamEndOpts {
    cfg: ClawdbotChannelConfig
    to: string      // same peer.id as sendText
    accountId: string
  }

  // ── Logger ───────────────────────────────────────────────────────────────────

  export interface Logger {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
    debug(...args: unknown[]): void
  }
}
