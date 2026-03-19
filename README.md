# esp32-openclaw

An [OpenClaw](https://github.com/openclaw) Channel Plugin that connects the `esp32-openclaw-server` to the OpenClaw Gateway, enabling voice conversations on ESP32 devices running [xiaozhi](https://github.com/xinnan-liu/xiaozhi-esp32) firmware.

**Language:** [中文](README_CN.md) | English

---

## Overview

```
OpenClaw Gateway
  └── esp32-openclaw (this plugin)
          │  WebSocket (M0 protocol)
          ▼
    esp32-openclaw-server (:8989)
          │  xiaozhi protocol
          ▼
    ESP32 Device
```

This package is an **OpenClaw Channel Plugin** that implements the `ChannelPlugin<T>` interface from `openclaw/plugin-sdk`. It runs *inside* the OpenClaw Gateway process. On startup the gateway calls `plugin.register(api)`, which registers the ESP32 channel. The plugin then connects outward to `esp32-openclaw-server` via WebSocket whenever an account is active.

When a user speaks to an ESP32 device:
1. The server sends a `user_message` (ASR transcript) to the plugin over WebSocket.
2. The plugin builds the session key from message fields and dispatches an `InboundMessage` to the gateway via `ctx.runtime.channel.handleMessage()`.
3. The gateway routes the message to the configured agent and streams the reply back via `outbound.sendText()`, with the plugin's `chunker` splitting text into sentences first.
4. When the stream ends the gateway calls `outbound.onStreamEnd()`, which sends `agent_reply_done` to the server.
5. The server's M3 Orchestrator converts pre-split chunks directly into TTS commands, emitting `tts.stop` immediately on `agent_reply_done`.

## Features

| Feature | Description |
|---|---|
| Channel Plugin | Implements `ChannelPlugin<ResolvedESP32Account>` — installable via `openclaw plugin install` |
| WebSocket client | Persistent connection to `esp32-openclaw-server`; automatic reconnect with exponential backoff (1 s → 60 s max) |
| Sentence splitting | `chunker` splits on `。！？\n` always; splits on `，；` when accumulated length ≥ 50 runes |
| Session key | Built by the Plugin from `agent_id` + `user_id`; not sent by the Server |
| Stream end signal | `onStreamEnd` sends `agent_reply_done`; Server emits `tts.stop` immediately |
| Heartbeat | Responds to `heartbeat_ping` from the server with `heartbeat_pong` |
| Bearer-token auth | Sends `Authorization: Bearer <appToken>` on connect when configured |
| Plugin manifest | `openclaw.plugin.json` declares channel ID and config schema |

## Requirements

- Node.js 20+
- `esp32-openclaw-server` running and reachable
- An OpenClaw Gateway instance (v2026.3.1+)

## Installation

```bash
# From the OpenClaw Gateway root:
openclaw plugin install /path/to/esp32-openclaw

# Or from GitHub:
openclaw plugin install github:your-org/esp32-openclaw
```

The plugin ships raw `.ts` source files. The gateway loads `index.ts` directly — no compile step needed.

### For development / testing only

```bash
cd esp32-openclaw
npm install
npm test        # runs 35 unit tests via Vitest
npm run lint    # type-check (tsc --noEmit)
```

## Configuration

After installation, add the `channels.esp32` section to your OpenClaw config:

```yaml
# openclaw.config.yaml
channels:
  esp32:
    serverUrl: ws://localhost:8989/plugin   # required
    appToken: ""                             # optional: Bearer token
    defaultAgent: main                       # optional: default agent ID
    session:
      scope: per-user                        # "per-user" | "per-device"
```

| Field | Required | Default | Description |
|---|---|---|---|
| `channels.esp32.serverUrl` | Yes | — | WebSocket URL of the server's `/plugin` endpoint |
| `channels.esp32.appToken` | No | `""` | Bearer token for server authentication |
| `channels.esp32.defaultAgent` | No | `"main"` | OpenClaw Agent ID when the device doesn't specify one |
| `channels.esp32.session.scope` | No | `"per-user"` | Session key scope: `per-user` or `per-device` |

When running via Docker Compose these map to environment variables passed to the gateway container:

```
ESP32_SERVER_URL=ws://esp32-server:8989/plugin
ESP32_APP_TOKEN=<your-token>
ESP32_DEFAULT_AGENT=main
```

## How it works (for Gateway developers)

The plugin's default export is loaded by the gateway:

```typescript
// index.ts (plugin entry point)
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { esp32ChannelPlugin } from './src/channel.js'

export default {
  id: 'esp32',
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: esp32ChannelPlugin })
  },
}
```

The `esp32ChannelPlugin` object implements `ChannelPlugin<ResolvedESP32Account>`:

```typescript
// Outbound reply flow (Gateway → Server):
outbound: {
  deliveryMode: 'direct',
  chunker(text, _limit) { return splitIntoSentences(text) },  // sentence-level splitting
  async sendText({ to, text, accountId }) { /* sends AgentReplyChunk */ },
  async onStreamEnd({ to, accountId }) { /* sends AgentReplyDone */ },
}

// Connection lifecycle (Gateway → ESP32 server):
gateway: {
  async startAccount(ctx) {
    // connects WSClient, dispatches user_messages via ctx.runtime.channel.handleMessage()
    // waits for ctx.abortSignal, then destroys WSClient
  },
}
```

Session key format: `agent:{agentId}:esp32:group:_global:{userId}`

## Plugin manifest

`openclaw.plugin.json` is read by the gateway during `openclaw plugin install`:

```json
{
  "id": "esp32",
  "channels": ["esp32"],
  "configSchema": {
    "type": "object",
    "properties": {
      "serverUrl": { "type": "string" },
      "appToken":  { "type": "string" },
      "defaultAgent": { "type": "string", "default": "main" },
      "session": { "type": "object", "properties": { "scope": { "type": "string", "enum": ["per-user", "per-device"], "default": "per-user" } } }
    },
    "required": ["serverUrl"]
  }
}
```

## Development

```bash
npm install
npm test            # Vitest (35 tests: 25 channel + 10 ws-client)
npm run test:watch  # Watch mode
npm run lint        # Type-check only (tsc --noEmit)
```

## Project Structure

```
index.ts              Plugin entry point — default export with register(api)
src/
  channel.ts          M2 ChannelPlugin — esp32ChannelPlugin object, splitIntoSentences
  ws-client.ts        WebSocket client with exponential-backoff reconnect
  protocol.ts         M0 wire protocol types (mirrors Go protocol package)
  plugin-sdk.d.ts     Ambient type stubs for openclaw/plugin-sdk (private SDK)
  index.ts            Library re-exports
tests/
  channel.test.ts     25 tests — splitIntoSentences, config, sendText, onStreamEnd, gateway
  ws-client.test.ts   10 tests — connect, reconnect, heartbeat, destroy
openclaw.plugin.json  Plugin manifest (id, channels, configSchema)
```

## Roadmap

| Phase | Features |
|---|---|
| MVP (current) | Transparent mode — all users unknown, no voiceprint |
| v1.0 | M5 voiceprint mapping · M6 per-user session routing · M8 first-use onboarding |
| v2.0 | M10 multi-agent routing · M14 voice commands |

## License

MIT
