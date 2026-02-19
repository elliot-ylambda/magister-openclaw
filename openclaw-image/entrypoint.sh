#!/bin/bash
# Initializes OpenClaw home directory and injects LLM proxy credentials.
set -e

OPENCLAW_HOME="${OPENCLAW_HOME:-/data/.openclaw}"

# First boot: initialize from defaults
if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
    echo "[entrypoint] First boot — initializing $OPENCLAW_HOME"
    mkdir -p "$OPENCLAW_HOME/credentials"
    mkdir -p "$OPENCLAW_HOME/workspace"
    mkdir -p "$OPENCLAW_HOME/agents"
    cp -r /app/default-config/* "$OPENCLAW_HOME/"
fi

# Copy/update marketing skills on every boot (picks up new skills on image update)
if [ -d "/app/skills" ]; then
    mkdir -p "$OPENCLAW_HOME/skills"
    cp -r /app/skills/* "$OPENCLAW_HOME/skills/"
fi

# Inject LLM config from env vars (set via Fly secrets during provisioning)
# GATEWAY_TOKEN = per-machine bearer token (doubles as API key for the proxy)
# LLM_BASE_URL = gateway's /llm/v1 endpoint on the internal network
if [ -n "$GATEWAY_TOKEN" ]; then
    mkdir -p "$OPENCLAW_HOME/credentials"
    cat > "$OPENCLAW_HOME/credentials/llm-keys.json" <<EOF
{
  "anthropic": {
    "apiKey": "${GATEWAY_TOKEN}",
    "baseUrl": "${LLM_BASE_URL:-http://magister-gateway.internal:8080/llm/v1}"
  }
}
EOF
    echo "[entrypoint] LLM credentials refreshed"
fi

echo "[entrypoint] Starting OpenClaw gateway on 0.0.0.0:18789"
exec node /app/openclaw/dist/index.js gateway \
    --home "$OPENCLAW_HOME" \
    --host 0.0.0.0 \
    --port 18789
