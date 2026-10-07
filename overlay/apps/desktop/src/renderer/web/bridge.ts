import type { AccountState, CallError, CodyncBridge, HostSnapshot, UpdateState } from '@shared/ipc'
import { version } from '../../../package.json'

// `window.codync` for the browser, on a real host: `call`/`stream` go to the same-origin
// proxy, which adds the host token server-side (the browser never sees it). Our own proxy
// auth rides as the `k` query parameter (gateways may strip Authorization/Cookie), with the
// capability key kept in localStorage by the login gate in index.html. Everything the
// desktop shell owns (install/restart, SSH, speech, account sign-in, updates) is a no-op or
// unavailable. Modeled on the website demo's bridge (src/renderer/demo/bridge.ts).

let PROXY_KEY = ''
try {
  PROXY_KEY = localStorage.getItem('codync-proxy-key') ?? ''
} catch {}

function withKey(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(PROXY_KEY)}`
}

const none = () => () => {}
const unavailable = () => Promise.reject(new Error('Not available in the web app'))

const snapshot: HostSnapshot = {
  state: { kind: 'running' },
  // Same origin: the proxy forwards /api/<method> and /events to the loopback host.
  local: { computerId: 'web', baseURL: window.location.origin, token: 'proxy' },
  dev: false,
  logPath: '',
}
const account: AccountState = { ready: true, configured: false, busy: false, error: null, user: null, cloudURL: null }
const updates: UpdateState = {
  supported: false, canCheck: false, checking: false, availableVersion: null, staged: false,
  autoCheck: false, autoDownload: false, lastCheck: null, error: null, waitingForApp: null,
}

const bridge: CodyncBridge = {
  platform: 'linux',
  appVersion: version,
  computerName: 'Codync Web',
  debugOpen: null,
  host: {
    snapshot: async () => snapshot,
    onChange: none,
    install() {},
    restart() {},
    uninstall() {},
    openLog() {},
    async call(baseURL, _token, method, body, timeoutMs) {
      let res: Response
      try {
        res = await fetch(withKey(`${baseURL}/api/${method}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(timeoutMs || 20_000),
        })
      } catch {
        throw { status: 0, message: "Can't reach your computer. Is it on and connected to the internet?" } satisfies CallError
      }
      const text = await res.text()
      if (!res.ok) {
        let message = `Host error ${res.status}`
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? message
        } catch {}
        throw { status: res.status, message } satisfies CallError
      }
      return text ? JSON.parse(text) : {}
    },
    stream(url, _token, onData, onEnd) {
      const controller = new AbortController()
      // Idle timeout, not a total one: the host pings every 15 s, so silence this long means it's gone.
      let idle: ReturnType<typeof setTimeout> | null = null
      const arm = () => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => controller.abort(), 45_000)
      }
      void (async () => {
        try {
          arm()
          const res = await fetch(withKey(url), { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
          if (res.status !== 200 || !res.body) throw { status: res.status, message: `Host error ${res.status}` } satisfies CallError
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            arm()
            buffer += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).replace(/\r$/, '')
              buffer = buffer.slice(nl + 1)
              if (line.startsWith('data:')) onData(line.slice(5).trimStart())
            }
          }
          onEnd(null)
        } catch (error) {
          if (controller.signal.aborted) return // closed by the caller, not a failure
          const e = error as Partial<CallError>
          onEnd({ status: e.status ?? 0, message: e.message ?? "Can't reach your computer." })
        } finally {
          if (idle) clearTimeout(idle)
        }
      })()
      return () => controller.abort()
    },
    health: async () => ({ computerId: 'web', busy: false }),
  },
  account: {
    state: async () => account,
    onChange: none,
    signIn: unavailable,
    signOut: async () => {},
    token: unavailable,
  },
  speech: { available: false, locales: () => [], start() {}, stop() {}, onEvent: none },
  ssh: {
    state: async () => ({ profiles: [], status: {}, attachments: [] }),
    onChange: none,
    save: async () => 'Not available in the web app',
    remove() {},
    connect() {},
    disconnect() {},
    trustHostKey() {},
    chooseKey: async () => null,
  },
  cloud: { request: async () => ({ ok: false, error: { status: 503, code: 'web', message: 'Not available in the web app' } }) },
  updates: { state: async () => updates, onChange: none, check() {}, setAutoCheck() {}, setAutoDownload() {} },
  app: {
    openExternal: (url) => void window.open(url, '_blank', 'noopener'),
    copy: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
    pickFiles: () =>
      new Promise((resolvePromise) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = async () => {
          const files = await Promise.all(
            Array.from(input.files ?? []).map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
          )
          resolvePromise(files)
        }
        input.addEventListener('cancel', () => resolvePromise([]))
        input.click()
      }),
    readClipboardFiles: async () => [],
    setTraySummary() {},
    onCommand: none,
    openPairing() {},
    quit() {},
    resetAllData: async () => {},
    setLaunchAtLogin: async () => false,
    showInDock: async () => true,
    setShowInDock: async () => true,
    launchAtLogin: async () => false,
    openSettings() {},
    authenticate: unavailable,
    setScreenAgent: unavailable,
    syncScreenAgent: async () => ({ needsApproval: false }),
  },
}

// The desktop shell's one-time prompts don't apply to the web app: mark account onboarding
// and the GitHub star ask as done (without wiping anything a returning visitor already has).
try {
  if (!localStorage.getItem('macAccountOnboardingCompleted')) localStorage.setItem('macAccountOnboardingCompleted', 'true')
  if (!localStorage.getItem('githubStarAsk')) localStorage.setItem('githubStarAsk', JSON.stringify({ kind: 'done' }))
} catch {}

window.codync = bridge
