// Codync web proxy: password gate at the edge, static SPA, and /api/* + /events forwarded
// to the loopback codync-host with its token added server-side. No dependencies.
//
// Auth: a login form sets an HMAC-signed cookie (some hosting gateways strip the
// Authorization header, so plain basic auth can't reach us); `Authorization: Basic` is
// still accepted for non-browser clients on a direct connection.
//
// Env:
//   CODYNC_WEB_PASSWORD  password (required; the server refuses to start without it)
//   CODYNC_WEB_USER      username (default: admin)
//   CODYNC_HOST_URL      upstream host (default: http://127.0.0.1:19222)
//   CODYNC_TOKEN_FILE    host token file (default: $HOME/.codync/token)
//   WEB_ROOT             static files (default: ./web next to this file)
//   PORT                 listen port (default: 8080)

import { createHmac, timingSafeEqual } from 'node:crypto'
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
const COOKIE = 'codync_auth'

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

function cookieValue(user) {
  const sig = createHmac('sha256', PASSWORD).update(`codync:${user}`).digest('base64url')
  return `${encodeURIComponent(user)}.${sig}`
}

function eq(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function authorized(req) {
  // Session cookie (browser path).
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2),
  )
  if (cookies[COOKIE] && eq(cookies[COOKIE], cookieValue(USER))) return true
  // Basic auth (direct clients; may be stripped by hosting gateways).
  const header = req.headers.authorization || ''
  if (header.startsWith('Basic ')) {
    let pair = ''
    try {
      pair = Buffer.from(header.slice(6), 'base64').toString('utf8')
    } catch {
      return false
    }
    const i = pair.indexOf(':')
    if (i > 0 && eq(pair.slice(0, i), USER) && eq(pair.slice(i + 1), PASSWORD)) return true
  }
  return false
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Codync — sign in</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0d; color: #e7e7ea; font-family: -apple-system, system-ui, sans-serif; }
      form { display: grid; gap: 12px; width: 280px; }
      h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
      input, button { padding: 10px 12px; border-radius: 8px; border: 1px solid #3a3a40; background: #17171a; color: inherit; font-size: 14px; }
      button { background: #e7e7ea; color: #0b0b0d; border: none; cursor: pointer; font-weight: 600; }
      .err { color: #ff6b6b; font-size: 13px; min-height: 1em; margin: 0; }
    </style>
  </head>
  <body>
    <form method="POST" action="/__codync_login">
      <h1>Codync</h1>
      <input name="user" placeholder="Username" autocomplete="username" value="admin" />
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" autofocus />
      <button type="submit">Sign in</button>
      <p class="err">ERR</p>
    </form>
  </body>
</html>`

function sendLogin(res, error = '') {
  res.writeHead(error ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(LOGIN_PAGE.replace('ERR', error))
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

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
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

  // Login form submission: set the signed cookie on success.
  if (path === '/__codync_login' && req.method === 'POST') {
    const params = new URLSearchParams((await readBody(req)).toString('utf8'))
    if (eq(params.get('user') || '', USER) && eq(params.get('password') || '', PASSWORD)) {
      res.writeHead(303, {
        'Set-Cookie': `${COOKIE}=${cookieValue(USER)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
        Location: '/',
      })
      res.end()
    } else {
      sendLogin(res, 'Wrong username or password.')
    }
    return
  }

  if (path === '/__codync_logout') {
    res.writeHead(303, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, Location: '/' })
    res.end()
    return
  }

  if (!authorized(req)) {
    // API/SSE callers get a bare 401; pages get the login form.
    if (path.startsWith('/api/') || path === '/events') {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
    } else {
      sendLogin(res)
    }
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
