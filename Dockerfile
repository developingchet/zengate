# Pinned by digest; Dependabot keeps the digest current.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

LABEL org.opencontainers.image.title="zengate" \
      org.opencontainers.image.description="Keyless OpenAI-compatible API for OpenCode Zen free models" \
      org.opencontainers.image.source="https://github.com/developingchet/zengate" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app

# The base image can lag Debian security updates. Upgrading installed packages
# keeps fixed CVEs in libraries such as pcre2 and perl-base out of the image.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# npm is only needed to install dependencies. Removing it (and corepack)
# keeps its bundled packages, and their CVEs, out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm
COPY index.js ./
COPY src ./src
COPY scripts/setup.mjs ./scripts/setup.mjs

# The gateway key lives in /data/config.json (created on first start and
# printed once in the logs). Mount a volume there to keep it across restarts,
# or pass API_KEY as an environment variable instead.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV CONFIG_FILE=/data/config.json \
    HOST=0.0.0.0 \
    PORT=8083

USER node
EXPOSE 8083
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "index.js"]
