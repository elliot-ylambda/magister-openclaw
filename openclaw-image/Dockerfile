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
# Clone and build OpenClaw from our fork (pinned to a specific commit)
ARG OPENCLAW_VERSION=b6e0e32114a6c3a216d1a02d19a5e561dc0842e8
RUN git clone https://github.com/elliot-ylambda/magister-openclaw.git /app/openclaw \
    && cd /app/openclaw \
    && git checkout ${OPENCLAW_VERSION} \
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

EXPOSE 18789 18790

ENTRYPOINT ["/entrypoint.sh"]
