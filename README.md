# Codync Web

A self-hosted web UI for [Codync](https://www.codync.dev): the real desktop app's renderer,
built for the browser and pointed at a live `codync-host` over a same-origin proxy.

```
browser ──basic auth──> proxy (server.mjs) ──loopback + token──> codync-host :19222
```

The host's API is loopback-only (`POST /api/<method>` + SSE `/events`, bearer token in
`~/.codync/token`). The proxy runs on the same machine/container, injects the token
server-side, and requires HTTP basic auth on every request. The browser never sees the token.

## Layout

- `proxy/server.mjs` — zero-dependency Node server: basic auth, static SPA, API/SSE proxy.
- `overlay/apps/desktop/` — files overlaid onto the upstream Codync repo at build time:
  - `vite.web.config.ts` — browser bundle build (modeled on the website's demo build).
  - `src/renderer/web/bridge.ts` — `window.codync` bridge whose `host.call`/`host.stream`
    use `fetch` against the same-origin proxy; desktop-only features are no-ops.
- `start.sh` — runs host + proxy, exits if either dies.
- `Dockerfile` — clones Codync (`ARG CODYNC_REF=v2.9.2`), builds the bundle, downloads the
  prebuilt static Linux `codync-host`, assembles the runtime image.

## Run

```sh
docker build -t codync-web .
docker run -p 8080:8080 -e CODYNC_WEB_PASSWORD=choose-a-strong-password -v codync-data:/data codync-web
# open http://localhost:8080 (user: admin)
```

Env: `CODYNC_WEB_USER` (default `admin`), `PORT` (default `8080`), `CODYNC_HOST_URL`,
`CODYNC_TOKEN_FILE`, `WEB_ROOT`.

## Notes

- Host state lives under `/data/.codync` (HOME=/data): bots, transcripts, memory, token.
- Desktop-only features (install/restart host, SSH tunnels, remote screen, speech, account
  sign-in) are unavailable in the web UI by design.
- No agent CLIs are installed in the image; install what your bots need (e.g. Claude Code)
  in the running container or extend the Dockerfile.
- Never expose this without the basic-auth password set; the proxy refuses to start without
  `CODYNC_WEB_PASSWORD`.
