# Base image for Magister user machines.
# Wraps OpenClaw with Chromium, marketing skills, and LLM proxy config injection.
FROM node:22-bookworm

# System deps: Chromium for browser automation, git for OpenClaw
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# --- OpenClaw ---
# Clone and build OpenClaw (pin to a specific commit for reproducibility)
# TODO: Replace with a specific tag/commit hash before GA
ARG OPENCLAW_VERSION=main
RUN git clone --depth 1 --branch ${OPENCLAW_VERSION} \
    https://github.com/openclaw/openclaw.git /app/openclaw \
    && cd /app/openclaw \
    && corepack enable \
    && pnpm install --frozen-lockfile \
    && pnpm build

# --- Marketing Skills ---
ARG MARKETINGSKILLS_VERSION=main
RUN git clone --depth 1 --branch ${MARKETINGSKILLS_VERSION} \
    https://github.com/coreyhaines31/marketingskills.git /app/skills \
    && rm -rf /app/skills/.git

# --- Default Config ---
COPY default-config/ /app/default-config/

# --- Entrypoint ---
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
