# syntax=docker/dockerfile:1
# Codync web UI: the desktop renderer built for the browser, served by a basic-auth proxy
# that forwards to a loopback codync-host with the token added server-side.
ARG CODYNC_REF=v2.9.2

# --- Build the renderer bundle ---
FROM node:20-bookworm-slim AS webbuild
ARG CODYNC_REF
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${CODYNC_REF}" https://github.com/leepokai/Codync.git .
COPY overlay/apps/desktop/vite.web.config.ts apps/desktop/vite.web.config.ts
COPY overlay/apps/desktop/src/renderer/web/ apps/desktop/src/renderer/web/
WORKDIR /src/apps/desktop
RUN npm ci --no-audit --no-fund \
  && npx vite build --config vite.web.config.ts

# --- Runtime: host binary + proxy + bundle ---
FROM node:20-bookworm-slim
ARG CODYNC_REF
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/leepokai/Codync/releases/download/${CODYNC_REF}/codync-host-linux-x86_64.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin codync-host-linux-x86_64/codync-host

# Host state (bots, transcripts, memory, token) lives under $HOME/.codync; /data is the
# platform's persistent volume.
ENV HOME=/data
WORKDIR /app
COPY --from=webbuild /src/apps/desktop/dist-web ./web
COPY proxy/server.mjs ./server.mjs
COPY start.sh ./start.sh
RUN chmod +x ./start.sh && mkdir -p /data

ENV PORT=8080
EXPOSE 8080
CMD ["./start.sh"]
