/**
 * esp32-openclaw – OpenClaw Channel Plugin entry point.
 *
 * The OpenClaw Gateway loads this file and calls plugin.register(api).
 * The plugin registers the ESP32 channel with the gateway.
 */

import type {OpenClawPluginApi} from 'openclaw/plugin-sdk'
import {esp32ChannelPlugin} from './src/channel.js'

const plugin = {
    id: 'esp32',
    name: 'ESP32-OpenClaw',
    description: 'ESP32 voice channel plugin for OpenClaw via xiaozhi firmware',
    register(api: OpenClawPluginApi) {
        api.registerChannel({plugin: esp32ChannelPlugin})
    },
}

export default plugin
