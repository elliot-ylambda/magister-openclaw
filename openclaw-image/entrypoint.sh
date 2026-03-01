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

# Revert bind to "lan" if a previous image set it to an invalid value
node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (c.gateway && c.gateway.bind !== 'lan') {
  c.gateway.bind = 'lan';
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
}
"

# Copy/update marketing skills on every boot (picks up new skills on image update)
if [ -d "/app/skills" ]; then
    mkdir -p "$OPENCLAW_HOME/skills"
    cp -r /app/skills/* "$OPENCLAW_HOME/skills/"
fi

# Purge cached models.json so OpenClaw regenerates from current config.
# Prevents stale baseUrl (e.g. wrong port) from persisting across image updates.
find "$OPENCLAW_HOME/agents" -name models.json -delete 2>/dev/null

# ── LLM Credentials ──────────────────────────────────────────
# Two modes:
#   1. Proxy (default): GATEWAY_TOKEN → used as "API key" to our LLM proxy
#   2. BYOK: BYOK_ANTHROPIC_KEY → user's own key, calls Anthropic directly
if [ -n "$BYOK_ANTHROPIC_KEY" ]; then
    export ANTHROPIC_API_KEY="${BYOK_ANTHROPIC_KEY}"
    echo "[entrypoint] BYOK mode — using user-provided Anthropic API key"
elif [ -n "$GATEWAY_TOKEN" ]; then
    export OPENROUTER_API_KEY="${GATEWAY_TOKEN}"
    DEFAULT_MODEL="${DEFAULT_MODEL:-anthropic/claude-sonnet-4-6}"
    node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!c.models) c.models = {};
if (!c.models.providers) c.models.providers = {};
// Remove old anthropic provider override (from previous image)
delete c.models.providers.anthropic;
c.models.providers.openrouter = {
  baseUrl: '${LLM_BASE_URL:-http://magister-gateway.internal:8081/llm/v1}',
  api: 'openai-completions',
  models: []
};
if (!c.agents) c.agents = {};
if (!c.agents.defaults) c.agents.defaults = {};
c.agents.defaults.model = { primary: 'openrouter/${DEFAULT_MODEL}' };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
    echo "[entrypoint] Proxy mode — LLM calls route through gateway (openrouter)"
fi

# Toggle Slack channel based on env vars (set via Fly secrets after OAuth)
if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_SIGNING_SECRET" ]; then
    node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!c.channels) c.channels = {};
if (!c.channels.slack) c.channels.slack = {};
c.channels.slack.enabled = true;
c.channels.slack.mode = 'http';
c.channels.slack.webhookPath = '/slack/events';
if (!c.channels.slack.dm) c.channels.slack.dm = {};
c.channels.slack.dm.enabled = true;
c.channels.slack.dm.policy = 'open';
c.channels.slack.groupPolicy = 'open';
c.channels.slack.requireMention = true;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
    echo "[entrypoint] Slack channel enabled"
else
    node -e "
const fs = require('fs');
const p = '${OPENCLAW_HOME}/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
if (c.channels && c.channels.slack) c.channels.slack.enabled = false;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
    echo "[entrypoint] Slack channel disabled (no credentials)"
fi

export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
export OPENCLAW_STATE_DIR="$OPENCLAW_HOME"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"

# Bridge IPv6 → IPv4 so Fly's 6PN internal DNS can reach OpenClaw.
# OpenClaw binds 0.0.0.0:18789 (IPv4 only). Fly internal DNS resolves to
# IPv6 (6PN). socat on port 18790 accepts IPv6 and forwards to localhost:18789.
socat TCP6-LISTEN:18790,fork,reuseaddr,bind=[::] TCP4:127.0.0.1:18789 &

echo "[entrypoint] Starting OpenClaw gateway on 0.0.0.0:18789 (IPv6 bridge on :18790)"
exec node /app/openclaw/dist/index.js gateway
