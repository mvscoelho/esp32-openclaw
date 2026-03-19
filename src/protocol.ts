/**
 * M0 – Server↔Plugin wire protocol types.
 *
 * This file is the TypeScript mirror of
 * esp32-openclaw-server/internal/protocol/protocol.go.
 */

// ── Message type constants ────────────────────────────────────────────────────

/** Server → Plugin */
export const TypeUserMessage = 'user_message' as const
export const TypeDeviceConnected = 'device_connected' as const
export const TypeDeviceDisconnected = 'device_disconnected' as const
export const TypeHeartbeatPing = 'heartbeat_ping' as const
export const TypeError = 'error' as const

/** Plugin → Server */
export const TypeAgentReply = 'agent_reply' as const
export const TypeAgentReplyDone = 'agent_reply_done' as const
export const TypePairingResult = 'pairing_result' as const
export const TypeHeartbeatPong = 'heartbeat_pong' as const

// ── User status ───────────────────────────────────────────────────────────────

export type UserStatus = 'paired' | 'identified' | 'unknown'

// ── Server → Plugin messages ──────────────────────────────────────────────────

/**
 * UserMessage is sent from Server to Plugin when a user speaks (post-ASR).
 */
export interface UserMessage {
  type: typeof TypeUserMessage
  message_id: string
  device_id: string
  /** Voiceprint ID – empty in MVP. */
  speaker_id: string
  /** "unknown" in MVP. */
  user_id: string
  user_status: UserStatus
  display_name: string
  /** ASR transcription. */
  text: string
  /** Voiceprint confidence 0.0–1.0. */
  confidence: number
  /** Target OpenClaw Agent ID. */
  agent_id: string
  /** Unix milliseconds. */
  timestamp: number
}

export interface DeviceConnected {
  type: typeof TypeDeviceConnected
  device_id: string
  timestamp: string
}

export interface DeviceDisconnected {
  type: typeof TypeDeviceDisconnected
  device_id: string
  timestamp: string
}

export interface HeartbeatPing {
  type: typeof TypeHeartbeatPing
}

export interface ErrorMsg {
  type: typeof TypeError
  code: number
  message: string
}

/** Union of all messages sent from Server to Plugin. */
export type ServerToPlugin =
  | UserMessage
  | DeviceConnected
  | DeviceDisconnected
  | HeartbeatPing
  | ErrorMsg

// ── Plugin → Server messages ──────────────────────────────────────────────────

/**
 * AgentReplyChunk is one streaming segment of the Agent's reply.
 * is_final is always false; stream end is signaled by AgentReplyDone.
 */
export interface AgentReplyChunk {
  type: typeof TypeAgentReply
  message_id: string
  device_id: string
  chunk_index: number
  text: string
  agent_id: string
  /** Always false; use AgentReplyDone for stream end. */
  is_final: false
  /** Agent is waiting for the user to speak next. */
  needs_input: boolean
}

/** AgentReplyDone signals the end of a reply stream. */
export interface AgentReplyDone {
  type: typeof TypeAgentReplyDone
  message_id: string
  device_id: string
}

export interface HeartbeatPong {
  type: typeof TypeHeartbeatPong
}

/** Union of all messages sent from Plugin to Server. */
export type PluginToServer = AgentReplyChunk | AgentReplyDone | HeartbeatPong

// ── Error codes (mirrors Go ErrorCode) ───────────────────────────────────────

export const ErrInvalidAppToken = 4001
export const ErrInvalidBotToken = 4002
export const ErrDeviceNotFound = 4003
export const ErrInternalServer = 5001
export const ErrASRUnavailable = 5002
export const ErrTTSUnavailable = 5003
