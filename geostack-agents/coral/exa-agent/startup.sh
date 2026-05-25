#!/bin/bash
# Geostack executable-runtime wrapper. Launched by coral-server.
# This script is IDENTICAL across all agents — AGENT_KEY is derived from the
# containing directory's name, which must match both the worker's
# agentFactories key and the [agent] name in this dir's coral-agent.toml.
# (This file is the source of truth; each coral/<agent>/startup.sh is a copy.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
AGENT_KEY="$(basename "$SCRIPT_DIR")"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)" # geostack-agents monorepo root

echo "=== Geostack $AGENT_KEY ==="
echo "Agent ID:       ${CORAL_AGENT_ID:-?}"
echo "Session ID:     ${CORAL_SESSION_ID:-?}"
echo "Connection URL: ${CORAL_CONNECTION_URL:-?}"
echo "Model:          ${MODEL_NAME:-?}"
echo "Root:           $ROOT"

# Load keys for OpenRouter-direct calls. The single local config
# (~/.geostack/config, written by the app's Settings page) is the canonical
# source; a repo-local .env still overrides it for development.
set -a
# shellcheck disable=SC1091
[ -f "$HOME/.geostack/config" ] && source "$HOME/.geostack/config"
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && source "$ROOT/.env"
set +a

cd "$ROOT"
# One-time install convenience. To avoid a concurrent-install race on first
# boot, run `npm install` once in geostack-agents/ before starting a session.
[ -d node_modules ] || npm install

exec npx tsx src/coral-worker.ts "$AGENT_KEY"
