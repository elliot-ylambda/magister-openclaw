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

# --- Marketing Skills ---
ARG MARKETINGSKILLS_VERSION=main
RUN git clone --depth 1 --branch ${MARKETINGSKILLS_VERSION} \
    https://github.com/coreyhaines31/marketingskills.git /app/skills \
    && rm -rf /app/skills/.git

# --- Local Skills (override/extend marketingskills) ---
COPY openclaw-image/skills/ /app/skills/

# --- Default Config ---
COPY openclaw-image/default-config/ /app/default-config/

# --- Entrypoint ---
COPY openclaw-image/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789 18790

ENTRYPOINT ["/entrypoint.sh"]
