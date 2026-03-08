# Base image for Magister user machines.
# Wraps OpenClaw with Chromium, marketing skills, and LLM proxy config injection.
FROM node:22-bookworm

# System deps: Chromium for browser automation, git for OpenClaw
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium git curl ca-certificates socat \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# --- OpenClaw ---
# Copy from the magister-openclaw submodule (pinned via git submodule)
COPY magister-openclaw/ /app/openclaw/
RUN cd /app/openclaw \
    && corepack enable \
    && pnpm install --frozen-lockfile \
    && pnpm build

# --- Marketing Skills (from forked submodule) ---
COPY magister-marketingskills/skills/ /app/skills/

# --- Custom Magister Skills (override/extend marketingskills) ---
COPY skills/ /app/skills/

# --- Catalog Skills (staged, not active — users install from UI) ---
COPY catalog-skills/ /app/catalog-skills/

# --- Default Config ---
COPY openclaw-image/default-config/ /app/default-config/

# --- Entrypoint ---
COPY openclaw-image/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789 18790 18794

ENTRYPOINT ["/entrypoint.sh"]
