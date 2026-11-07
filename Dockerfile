# OpenWave container: Node 22 + FFmpeg. Persistent data lives in /data (mount a volume there).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data/db \
    MEDIA_DIR=/data/media \
    TRUST_PROXY=1 \
    COOKIE_SECURE=1

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root only to fix volume ownership, then drops to the unprivileged "node" user.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings", "server.js"]
