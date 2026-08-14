import { create } from 'zustand'
import type { Project, QuestionAnswer, SessionEvent, SessionMeta } from '@shared/protocol'
import { BridgeClient, type ConnectionState } from '../bridge/client'
import { applyEvent, emptyTranscript, type Transcript } from './transcript'

const PAIRING_KEY = 'h4.pairing'
const APNS_KEY = 'h4.apnsToken'
const TEXT_KEY = 'h4.textScale'
const PINS_KEY = 'h4.pinnedSessions'
const SEEN_KEY = 'h4.seenAt'

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as T
  } catch {
    // corrupt — fall through
  }
  return fallback
}
const THEME_KEY = 'h4.theme'
const PUSH_KEY = 'h4.pushEnabled'

export type ThemePref = 'system' | 'dark' | 'light'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && systemDark.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
systemDark.addEventListener('change', () => applyTheme(useApp.getState().theme))
const HOME_CACHE_KEY = 'h4.homeCache'

/** last successful projects+sessions snapshot — the home screen must show
 *  something useful when the desktop is off, not a void with a timeout */
function loadHomeCache(): { projects: Project[]; sessions: SessionMeta[] } {
  try {
    const raw = localStorage.getItem(HOME_CACHE_KEY)
    if (raw) return JSON.parse(raw) as { projects: Project[]; sessions: SessionMeta[] }
  } catch {
    // corrupt cache — start empty
  }
  return { projects: [], sessions: [] }
}

export type TextScale = 's' | 'm' | 'l'
function applyTextScale(scale: TextScale): void {
  document.documentElement.dataset.textscale = scale
}

export type Screen = 'home' | 'new' | 'usage' | 'settings'

interface AppState {
  pairingUrl: string | null
  conn: ConnectionState
  screen: Screen
  projects: Project[]
  sessions: SessionMeta[]
  openSessionId: string | null
  transcripts: Record<string, Transcript>
  transcriptLoading: boolean
  /** sessions that hit permission/question/turn-complete while not open */
  attention: Record<string, boolean>
  /** unresolved permission/question requests per session — drives the
   *  "needs you" badge in the list without opening the conversation */
  pendingApprovals: Record<string, number>
  /** phone-local pins: pinned sessions sort first in their workspace */
  pinned: string[]
  togglePin(sessionId: string): void
  /** per-session last-seen updatedAt watermark — powers the finished-while-
   *  away marker even when the app heard no events (iOS had it frozen) */
  seenAt: Record<string, number>
  markSeen(sessionId: string): void
  error: string | null
  /** push registration outcome, surfaced in Settings so failures aren't silent */
  pushStatus: string
  textScale: TextScale
  setTextScale(scale: TextScale): void
  theme: ThemePref
  setTheme(pref: ThemePref): void
  pushEnabled: boolean
  setPushEnabled(on: boolean): void
  /** pull-to-refresh / manual refresh in flight */
  refreshing: boolean

  pair(url: string): boolean
  unpair(): void
  setApnsToken(token: string): void
  setPushStatus(status: string): void
  /** open a session as soon as the bridge is online (push-tap deep link) */
  openSessionWhenReady(id: string): void
  setScreen(screen: Screen): void
  /** replay the open session after resume/reconnect — events streamed while
   *  iOS had the app frozen were broadcast-only and are gone from the wire */
  reloadOpenTranscript(): Promise<void>
  refresh(): Promise<void>
  openSession(id: string): Promise<void>
  closeSession(): void
  sendPrompt(text: string): Promise<void>
  interrupt(): Promise<void>
  startSession(req: {
    projectId: string
    backend: string
    environment: string
    permissionMode: string
    model?: string
    firstPrompt?: string
  }): Promise<void>
  respondPermission(sessionId: string, requestId: string, decision: string): Promise<void>
  respondQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
}

let client: BridgeClient | null = null
let pendingOpen: string | null = null
export function bridge(): BridgeClient {
  if (!client) throw new Error('not paired')
  return client
}
export function tryBridge(): BridgeClient | null {
  return client
}

function startClient(url: string): BridgeClient | null {
  const savedToken = localStorage.getItem(APNS_KEY)
  const c = BridgeClient.fromUrl(url, {
    onState: (conn) => {
      useApp.setState(conn === 'online' ? { conn, error: null } : { conn })
      if (conn === 'online') {
        void useApp.getState().refresh()
        void useApp.getState().reloadOpenTranscript()
        if (pendingOpen) {
          const id = pendingOpen
          pendingOpen = null
          void useApp.getState().openSession(id)
        }
      }
    },
    onAgentEvent: (ev: SessionEvent) => {
      useApp.setState((s) => {
        const t = s.transcripts[ev.sessionId]
        const next: Partial<AppState> = {}
        if (t && applyEvent(t, ev)) {
          next.transcripts = { ...s.transcripts, [ev.sessionId]: { ...t } }
        }
        const kind = ev.event.kind
        if (
          ev.sessionId !== s.openSessionId &&
          (kind === 'permission-request' || kind === 'question-request' || kind === 'turn-complete')
        ) {
          next.attention = { ...s.attention, [ev.sessionId]: true }
        }
        if (kind === 'permission-request' || kind === 'question-request') {
          next.pendingApprovals = {
            ...s.pendingApprovals,
            [ev.sessionId]: (s.pendingApprovals[ev.sessionId] ?? 0) + 1
          }
        } else if (kind === 'permission-resolved' || kind === 'question-resolved') {
          next.pendingApprovals = {
            ...s.pendingApprovals,
            [ev.sessionId]: Math.max(0, (s.pendingApprovals[ev.sessionId] ?? 0) - 1)
          }
        }
        return next
      })
    },
    onSessionUpdated: (session: SessionMeta) => {
      useApp.setState((s) => ({
        sessions: s.sessions.some((x) => x.id === session.id)
          ? s.sessions.map((x) => (x.id === session.id ? session : x))
          : [...s.sessions, session]
      }))
    }
  })
  if (c && savedToken) c.setApnsToken(savedToken)
  c?.start()
  return c
}

const homeCache = loadHomeCache()

export const useApp = create<AppState>((set, get) => ({
  pairingUrl: localStorage.getItem(PAIRING_KEY),
  conn: 'idle',
  screen: 'home',
  projects: homeCache.projects,
  sessions: homeCache.sessions,
  openSessionId: null,
  transcripts: {},
  transcriptLoading: false,
  attention: {},
  pendingApprovals: {},
  pinned: loadJson<string[]>(PINS_KEY, []),
  seenAt: loadJson<Record<string, number>>(SEEN_KEY, {}),
  error: null,

  togglePin(sessionId: string): void {
    set((s) => {
      const pinned = s.pinned.includes(sessionId)
        ? s.pinned.filter((id) => id !== sessionId)
        : [...s.pinned, sessionId]
      localStorage.setItem(PINS_KEY, JSON.stringify(pinned))
      return { pinned }
    })
  },

  markSeen(sessionId: string): void {
    set((s) => {
      const session = s.sessions.find((x) => x.id === sessionId)
      const seenAt = { ...s.seenAt, [sessionId]: Math.max(session?.updatedAt ?? 0, Date.now()) }
      localStorage.setItem(SEEN_KEY, JSON.stringify(seenAt))
      return { seenAt }
    })
  },
  pushStatus: 'not requested',
  textScale: (localStorage.getItem(TEXT_KEY) as TextScale) || 'm',
  theme: (localStorage.getItem(THEME_KEY) as ThemePref) || 'system',
  pushEnabled: localStorage.getItem(PUSH_KEY) !== '0',
  refreshing: false,

  setTheme(pref: ThemePref): void {
    localStorage.setItem(THEME_KEY, pref)
    applyTheme(pref)
    set({ theme: pref })
  },

  setPushEnabled(on: boolean): void {
    localStorage.setItem(PUSH_KEY, on ? '1' : '0')
    set({ pushEnabled: on, pushStatus: on ? get().pushStatus : 'disabled' })
    if (!on) {
      client?.setApnsToken('')
    } else {
      const saved = localStorage.getItem(APNS_KEY)
      if (saved) client?.setApnsToken(saved)
    }
  },

  setTextScale(scale: TextScale): void {
    localStorage.setItem(TEXT_KEY, scale)
    applyTextScale(scale)
    set({ textScale: scale })
  },

  setScreen(screen: Screen): void {
    set({ screen })
  },

  setApnsToken(token: string): void {
    localStorage.setItem(APNS_KEY, token)
    client?.setApnsToken(token)
    set({ pushStatus: 'registered ✓' })
  },

  setPushStatus(status: string): void {
    set({ pushStatus: status })
  },

  openSessionWhenReady(id: string): void {
    if (get().conn === 'online') {
      void get().openSession(id)
    } else {
      pendingOpen = id
    }
  },

  async reloadOpenTranscript(): Promise<void> {
    const id = get().openSessionId
    if (!id) return
    try {
      await bridge()
        .call('resyncSession', id)
        .catch(() => {})
      const events = await bridge().call<SessionEvent[]>('getSessionEvents', id)
      set((s) => {
        if (s.openSessionId !== id) return {}
        const t = emptyTranscript()
        for (const ev of events) applyEvent(t, ev)
        return { transcripts: { ...s.transcripts, [id]: t }, transcriptLoading: false }
      })
    } catch {
      // resume with no connection yet — the reconnect's 'online' retriggers this
    }
  },

  async startSession(req): Promise<void> {
    const session = await bridge().call<SessionMeta>('createSession', req)
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === session.id)
        ? s.sessions
        : [...s.sessions, session],
      screen: 'home'
    }))
    await get().openSession(session.id)
  },

  pair(url: string): boolean {
    const c = startClient(url)
    if (!c) return false
    client?.stop()
    client = c
    localStorage.setItem(PAIRING_KEY, url.trim())
    set({ pairingUrl: url.trim(), error: null })
    return true
  },

  unpair(): void {
    client?.stop()
    client = null
    localStorage.removeItem(PAIRING_KEY)
    localStorage.removeItem(HOME_CACHE_KEY)
    set({
      pairingUrl: null,
      conn: 'idle',
      projects: [],
      sessions: [],
      openSessionId: null,
      transcripts: {},
      attention: {},
      pendingApprovals: {}
    })
  },

  async refresh(): Promise<void> {
    set({ refreshing: true })
    try {
      const [projects, sessions] = await Promise.all([
        bridge().call<Project[]>('listProjects'),
        bridge().call<SessionMeta[]>('listSessions')
      ])
      set((s) => {
        const seenAt = { ...s.seenAt }
        let changed = false
        for (const sess of sessions) {
          if (!(sess.id in seenAt)) {
            seenAt[sess.id] = sess.updatedAt
            changed = true
          }
        }
        if (changed) localStorage.setItem(SEEN_KEY, JSON.stringify(seenAt))
        return { projects, sessions, error: null, seenAt }
      })
      try {
        localStorage.setItem(HOME_CACHE_KEY, JSON.stringify({ projects, sessions }))
      } catch {
        // cache write is best-effort (quota)
      }
      set({ refreshing: false })
    } catch (err) {
      set({ refreshing: false })
      // a failed refresh while the desktop is unreachable is the EXPECTED
      // state, already communicated by the offline banner — an error line
      // ("listProjects timed out") on top of it is just noise
      if (get().conn === 'online') {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  },

  async openSession(id: string): Promise<void> {
    const prev = get().openSessionId
    if (prev && prev !== id) bridge().unsub(prev)
    // cached transcript shows instantly; the fetch below replaces it when it
    // lands. Only a first-ever open gets the skeleton — reopening a slow
    // conversation must never cost the full load twice.
    const cached = get().transcripts[id]
    set((s) => ({
      openSessionId: id,
      transcriptLoading: !cached,
      attention: { ...s.attention, [id]: false },
      transcripts: cached ? s.transcripts : { ...s.transcripts, [id]: emptyTranscript() }
    }))
    get().markSeen(id)
    // clear the desktop's bell/badge/banners too (older desktops: no-op)
    void bridge()
      .call('markSeen', id)
      .catch(() => {})
    bridge().sub(id)
    try {
      // resync first, exactly like the desktop's loadTranscriptData: sessions
      // driven externally (or imported) have nothing in the store until their
      // jsonl is pulled in — skipping this is what showed empty conversations
      await bridge()
        .call('resyncSession', id)
        .catch(() => {})
      const events = await bridge().call<SessionEvent[]>('getSessionEvents', id)
      set((s) => {
        if (s.openSessionId !== id) return {}
        const t = emptyTranscript()
        for (const ev of events) applyEvent(t, ev)
        // full replay is the truth — recompute the badge from actually
        // unresolved cards instead of trusting the live-event counter
        const pending = t.items.filter(
          (it) =>
            (it.kind === 'permission' && !it.decision) || (it.kind === 'question' && !it.answered)
        ).length
        return {
          transcripts: { ...s.transcripts, [id]: t },
          transcriptLoading: false,
          pendingApprovals: { ...s.pendingApprovals, [id]: pending }
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), transcriptLoading: false })
    }
  },

  closeSession(): void {
    const id = get().openSessionId
    if (id) {
      bridge().unsub(id)
      get().markSeen(id)
    // clear the desktop's bell/badge/banners too (older desktops: no-op)
    void bridge()
      .call('markSeen', id)
      .catch(() => {})
    }
    set({ openSessionId: null })
  },

  async sendPrompt(text: string): Promise<void> {
    const id = get().openSessionId
    if (!id) return
    await bridge().call('prompt', id, text)
  },

  async interrupt(): Promise<void> {
    const id = get().openSessionId
    if (!id) return
    await bridge().call('interrupt', id)
  },

  async respondPermission(sessionId: string, requestId: string, decision: string): Promise<void> {
    await bridge().call('respondPermission', sessionId, requestId, decision)
  },

  async respondQuestion(
    sessionId: string,
    requestId: string,
    answers: QuestionAnswer[]
  ): Promise<void> {
    await bridge().call('respondQuestion', sessionId, requestId, answers)
  }
}))

const savedPairing = localStorage.getItem(PAIRING_KEY)
if (savedPairing) {
  client = startClient(savedPairing)
  if (!client) localStorage.removeItem(PAIRING_KEY)
}
applyTextScale(useApp.getState().textScale)
applyTheme(useApp.getState().theme)
