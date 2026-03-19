# esp32-openclaw

一个 [OpenClaw](https://github.com/openclaw) Channel Plugin，将 `esp32-openclaw-server` 接入 OpenClaw Gateway，让运行 [xiaozhi](https://github.com/xinnan-liu/xiaozhi-esp32) 固件的 ESP32 设备具备语音对话能力。

**语言：** 中文 | [English](README.md)

---

## 架构概览

```
OpenClaw Gateway
  └── esp32-openclaw（本插件）
          │  WebSocket（M0 协议）
          ▼
    esp32-openclaw-server (:8989)
          │  xiaozhi 协议
          ▼
    ESP32 设备
```

本包是一个 **OpenClaw Channel Plugin**，实现了 `openclaw/plugin-sdk` 中的 `ChannelPlugin<T>` 接口。它运行在 OpenClaw Gateway **进程内部**。Gateway 启动时调用 `plugin.register(api)` 注册 ESP32 Channel；当账号激活时，插件主动向 `esp32-openclaw-server` 建立 WebSocket 连接。

完整对话流程：
1. 用户对 ESP32 说话，Server 将 ASR 转录文本以 `user_message` 发送给插件。
2. 插件从消息字段构建 Session Key，封装为 `InboundMessage`，通过 `ctx.runtime.channel.handleMessage()` 传递给 Gateway。
3. Gateway 将消息路由到配置的 Agent，通过 `outbound.sendText()` 流式返回回复；插件的 `chunker` 负责将文本切分为句子。
4. 流结束后 Gateway 调用 `outbound.onStreamEnd()`，插件向 Server 发送 `agent_reply_done`。
5. Server 的 M3 编排器将预切分的 chunk 直接转为 TTS 指令，收到 `agent_reply_done` 后立即发出 `tts.stop`。

## 功能特性

| 功能 | 说明 |
|---|---|
| Channel Plugin | 实现 `ChannelPlugin<ResolvedESP32Account>`，支持 `openclaw plugin install` 安装 |
| WebSocket 客户端 | 与 `esp32-openclaw-server` 保持持久连接；断线后指数退避自动重连（1 s → 最大 60 s） |
| 句子切分 | `chunker` 遇 `。！？\n` 立即切分；遇 `，；` 且已累积 ≥ 50 个 Unicode 字符时切分 |
| Session Key 构建 | 由插件从 `agent_id` + `user_id` 字段构建，Server 不再发送 |
| 流结束信号 | `onStreamEnd` 发送 `agent_reply_done`，Server 立即触发 `tts.stop` |
| 心跳 | 回复 Server 的 `heartbeat_ping` 为 `heartbeat_pong` |
| Bearer Token 认证 | 配置后连接时自动携带 `Authorization: Bearer <appToken>` |
| Plugin 清单 | `openclaw.plugin.json` 声明 Channel ID 和配置 Schema |

## 环境要求

- Node.js 20+
- 已运行的 `esp32-openclaw-server` 实例
- OpenClaw Gateway（v2026.3.1+）

## 安装

```bash
# 在 OpenClaw Gateway 根目录执行：
openclaw plugin install /path/to/esp32-openclaw

# 或从 GitHub 安装：
openclaw plugin install github:your-org/esp32-openclaw
```

插件以原始 `.ts` 源文件分发，Gateway 直接加载 `index.ts`，无需编译。

### 仅用于开发 / 测试

```bash
cd esp32-openclaw
npm install
npm test        # 运行 35 个单元测试（Vitest）
npm run lint    # 类型检查（tsc --noEmit）
```

## 配置

安装后，在 OpenClaw 配置文件中添加 `channels.esp32` 节：

```yaml
# openclaw.config.yaml
channels:
  esp32:
    serverUrl: ws://localhost:8989/plugin   # 必填
    appToken: ""                             # 可选：Bearer Token
    defaultAgent: main                       # 可选：默认 Agent ID
    session:
      scope: per-user                        # "per-user" | "per-device"
```

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `channels.esp32.serverUrl` | 是 | — | Server `/plugin` 端点的 WebSocket URL |
| `channels.esp32.appToken` | 否 | `""` | Server 认证用的 Bearer Token |
| `channels.esp32.defaultAgent` | 否 | `"main"` | 设备未指定 Agent 时使用的 OpenClaw Agent ID |
| `channels.esp32.session.scope` | 否 | `"per-user"` | Session Key 维度：`per-user` 或 `per-device` |

通过 Docker Compose 部署时，这些参数通过环境变量传入 Gateway 容器：

```
ESP32_SERVER_URL=ws://esp32-server:8989/plugin
ESP32_APP_TOKEN=<your-token>
ESP32_DEFAULT_AGENT=main
```

## 工作原理（供 Gateway 开发者参考）

插件默认导出由 Gateway 加载：

```typescript
// index.ts（插件入口）
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { esp32ChannelPlugin } from './src/channel.js'

export default {
  id: 'esp32',
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: esp32ChannelPlugin })
  },
}
```

`esp32ChannelPlugin` 对象实现 `ChannelPlugin<ResolvedESP32Account>`：

```typescript
// 出站回复流（Gateway → Server）：
outbound: {
  deliveryMode: 'direct',
  chunker(text, _limit) { return splitIntoSentences(text) },  // 按句子切分
  async sendText({ to, text, accountId }) { /* 发送 AgentReplyChunk */ },
  async onStreamEnd({ to, accountId }) { /* 发送 AgentReplyDone */ },
}

// 连接生命周期（Gateway → ESP32 Server）：
gateway: {
  async startAccount(ctx) {
    // 建立 WSClient 连接，通过 ctx.runtime.channel.handleMessage() 分发 user_message
    // 等待 ctx.abortSignal，然后销毁 WSClient
  },
}
```

Session Key 格式：`agent:{agentId}:esp32:group:_global:{userId}`

## Plugin 清单

`openclaw.plugin.json` 在 `openclaw plugin install` 时由 Gateway 读取：

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

## 开发与测试

```bash
npm install
npm test            # Vitest（35 个测试：25 channel + 10 ws-client）
npm run test:watch  # 监视模式
npm run lint        # 仅类型检查（tsc --noEmit）
```

## 项目结构

```
index.ts              插件入口 — 默认导出 register(api)
src/
  channel.ts          M2 ChannelPlugin — esp32ChannelPlugin 对象、splitIntoSentences
  ws-client.ts        WebSocket 客户端（含指数退避重连）
  protocol.ts         M0 wire 协议类型（镜像 Go 协议包）
  plugin-sdk.d.ts     openclaw/plugin-sdk 的本地环境类型存根（私有 SDK）
  index.ts            库级别的公开再导出
tests/
  channel.test.ts     25 个测试 — splitIntoSentences、config、sendText、onStreamEnd、gateway
  ws-client.test.ts   10 个测试 — 连接、重连、心跳、销毁
openclaw.plugin.json  Plugin 清单（id、channels、configSchema）
```

## 路线图

| 阶段 | 功能 |
|---|---|
| MVP（当前） | 透传模式 —— 所有用户为 unknown，无声纹识别 |
| v1.0 | M5 声纹用户映射 · M6 per-user Session 路由 · M8 首次使用引导 |
| v2.0 | M10 多 Agent 路由 · M14 语音命令系统 |

## 开源协议

MIT
