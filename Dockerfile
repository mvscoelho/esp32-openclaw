# esp32-openclaw plugin – build image.
#
# This Dockerfile builds the plugin's TypeScript source into JavaScript.
# The plugin is a library loaded by OpenClaw Gateway — it has no standalone
# entry point.  For full deployment use Dockerfile.openclaw at the repo root,
# which embeds the compiled plugin into an OpenClaw Gateway image.
#
# This file is kept for local development builds and CI artifact caching.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Artifact stage ────────────────────────────────────────────────────────────
# Exposes compiled JS + manifest so Dockerfile.openclaw can COPY --from= here.
FROM scratch

COPY --from=builder /app/dist /dist
COPY openclaw.plugin.json /openclaw.plugin.json
