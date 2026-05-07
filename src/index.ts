/**
 * esp32-openclaw – Library exports.
 *
 * For plugin loading by the OpenClaw Gateway, use the root index.ts.
 * This file re-exports the public API for library consumers.
 */

export {esp32ChannelPlugin, splitIntoSentences} from './channel.js'
export type {ResolvedESP32Account} from './channel.js'
export {WSClient} from './ws-client.js'
export type {WSClientConfig} from './ws-client.js'
export * from './protocol.js'
