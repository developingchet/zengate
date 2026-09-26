FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
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
