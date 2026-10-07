// Codync web proxy: basic auth at the edge, static SPA, and /api/* + /events forwarded to
// the loopback codync-host with its token added server-side. No dependencies.
//
// Env:
//   CODYNC_WEB_PASSWORD  basic-auth password (required; the server refuses to start without it)
//   CODYNC_WEB_USER      basic-auth username (default: admin)
//   CODYNC_HOST_URL      upstream host (default: http://127.0.0.1:19222)
//   CODYNC_TOKEN_FILE    host token file (default: $HOME/.codync/token)
//   WEB_ROOT             static files (default: ./web next to this file)
//   PORT                 listen port (default: 8080)

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT || 8080)
const HOST_URL = process.env.CODYNC_HOST_URL || 'http://127.0.0.1:19222'
const TOKEN_FILE = process.env.CODYNC_TOKEN_FILE || `${process.env.HOME}/.codync/token`
const WEB_ROOT = resolve(process.env.WEB_ROOT || join(fileURLToPath(new URL('.', import.meta.url)), 'web'))
const USER = process.env.CODYNC_WEB_USER || 'admin'
const PASSWORD = process.env.CODYNC_WEB_PASSWORD || ''

if (!PASSWORD) {
  console.error('CODYNC_WEB_PASSWORD is required: this proxy grants full control of the host.')
  process.exit(1)
}

async function hostToken() {
  try {
    return (await readFile(TOKEN_FILE, 'utf8')).trim()
  } catch {
    return null
  }
}

function authorized(req) {
  const header = req.headers.authorization || ''
  const expect = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`
  // Constant-time-ish: compare hashes of equal-length padded buffers.
  const a = Buffer.from(header.padEnd(4096, '\0'))
  const b = Buffer.from(expect.padEnd(4096, '\0'))
  return a.equals(b)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function proxyToHost(req, res, token) {
  const upstream = http.request(
    `${HOST_URL}${req.url}`,
    {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
        Accept: req.headers.accept || '*/*',
      },
      timeout: 0,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        'Content-Type': up.headers['content-type'] || 'application/json',
        'Cache-Control': 'no-store',
      })
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: "Can't reach the Codync host." }))
  })
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname

  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="codync"', 'Cache-Control': 'no-store' })
    res.end('Unauthorized')
    return
  }

  if (path.startsWith('/api/') || path === '/events') {
    const token = await hostToken()
    if (!token) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Codync host is still starting.' }))
      return
    }
    proxyToHost(req, res, token)
    return
  }

  // Static SPA: exact file, else index.html. No path escapes from WEB_ROOT.
  let file = normalize(join(WEB_ROOT, path))
  if (!file.startsWith(WEB_ROOT + sep) && file !== WEB_ROOT) file = join(WEB_ROOT, 'index.html')
  let data
  try {
    data = await readFile(file)
  } catch {
    try {
      file = join(WEB_ROOT, 'index.html')
      data = await readFile(file)
    } catch {
      res.writeHead(404)
      res.end('Not found')
      return
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
})

// Long-lived SSE must never hit a socket timeout.
server.requestTimeout = 0
server.headersTimeout = 60_000
server.timeout = 0

server.listen(PORT, () => {
  console.log(`codync web proxy on :${PORT} -> ${HOST_URL} (static: ${WEB_ROOT})`)
})
