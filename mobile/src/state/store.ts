import { create } from 'zustand'
import type { Project, QuestionAnswer, SessionEvent, SessionMeta } from '@shared/protocol'
import type { BridgeSidebarState } from '@shared/bridge'
import type { SidebarLayout } from '@shared/sidebarOrder'
import { BridgeClient, type ConnectionState } from '../bridge/client'
import { applyEvent, countPending, emptyTranscript, type Transcript } from './transcript'
import { IMAGE_ONLY_PROMPT } from '../hooks/useImageAttachments'

const PAIRING_KEY = 'h4.pairing'
const APNS_KEY = 'h4.apnsToken'
const TEXT_KEY = 'h4.textScale'
const PINS_KEY = 'h4.pinnedSessions'
const SEEN_KEY = 'h4.seenAt'
const DESKTOP_UNSEEN_KEY = 'h4.desktopUnseen'
const PENDING_SEEN_KEY = 'h4.pendingSeen'
const FINISHED_KEY = 'h4.finishedAt'
const LAYOUT_KEY = 'h4.desktopLayout'
const UNREAD_KEY = 'h4.unreadOverrides'
const PENDING_KEY = 'h4.pendingApprovals'

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
const TRANSCRIPT_CACHE_KEY = 'h4.transcripts.v1'
const TRANSCRIPT_CACHE_MAX_SESSIONS = 10
const TRANSCRIPT_CACHE_MAX_ITEMS = 150
const SESSION_INIT_KEY = 'h4.sessionInit'
const QUEUE_KEY = 'h4.queue.v1'

/** a follow-up typed while the agent was working; images stay in memory only */
export interface QueuedMessage {
  id: string
  text: string
  images?: { base64: string; mediaType: string }[]
}

function loadQueues(): Record<string, QueuedMessage[]> {
  const raw = loadJson<Record<string, QueuedMessage[]>>(QUEUE_KEY, {})
  const out: Record<string, QueuedMessage[]> = {}
  for (const [id, q] of Object.entries(raw)) {
    const kept = Array.isArray(q) ? q.filter((m) => m?.id && m.text) : []
    if (kept.length) out[id] = kept
  }
  return out
}

function saveQueues(queues: Record<string, QueuedMessage[]>): void {
  const out: Record<string, { id: string; text: string }[]> = {}
  for (const [id, q] of Object.entries(queues)) {
    const kept = q.filter((m) => m.text).map((m) => ({ id: m.id, text: m.text }))
    if (kept.length) out[id] = kept
  }
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(out))
  } catch {
    // quota — the in-memory queue still sends
  }
}

const isActive = (status: string | undefined): boolean =>
  status === 'running' || status === 'starting'

const isUnknownMethod = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('unknown method')

function saveJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // quota — the in-memory copy still drives this run
  }
}

/** The sidebar bell. A desktop that reports its finished-unseen set is the
 *  truth (it clears when the session is seen anywhere); an older desktop
 *  leaves the phone to its own record of turns that ended since it looked. */
export function isFinishedUnseen(
  s: Pick<AppState, 'desktopUnseen' | 'attention' | 'finishedAt' | 'seenAt' | 'unreadOverrides'>,
  id: string
): boolean {
  if (s.unreadOverrides.includes(id)) return true
  if (s.desktopUnseen) return s.desktopUnseen.includes(id)
  return !!s.attention[id] || (s.finishedAt[id] ?? 0) > (s.seenAt[id] ?? 0)
}

/** sessions whose flushed prompt hasn't been seen running yet — both flush
 *  triggers (turn settled, refresh while idle) can fire for the same idle
 *  window, and the second must not send the next message into a live turn */
const flushInFlight = new Map<string, number>()
/** marked unread from this phone — its own echo must not be swallowed */
const requestedUnseen = new Set<string>()
const FLUSH_GUARD_MS = 15_000
const SESSION_INIT_MAX = 100

/** per-session CLI-resolved model id, persisted so the model pickers keep the
 *  real version across cold starts (same shape as the desktop's sessionInit) */
type SessionInit = Record<string, { model: string }>

function withInitModel(map: SessionInit, id: string, model: string | undefined): SessionInit | null {
  if (!model || map[id]?.model === model) return null
  const next = { ...map }
  delete next[id]
  next[id] = { model }
  const ids = Object.keys(next)
  for (const k of ids.slice(0, Math.max(0, ids.length - SESSION_INIT_MAX))) delete next[k]
  try {
    localStorage.setItem(SESSION_INIT_KEY, JSON.stringify(next))
  } catch {
    // best-effort, like the other caches
  }
  return next
}

/** last successful projects+sessions snapshot — the home screen must show
 *  something useful when the desktop is off, not a void with a timeout */
type CachedTranscripts = Record<string, Transcript & { savedAt: number }>

function loadTranscriptCache(): Record<string, Transcript> {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_CACHE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as CachedTranscripts
      const out: Record<string, Transcript> = {}
      for (const [id, t] of Object.entries(cached)) {
        out[id] = { items: t.items, lastSeq: t.lastSeq, plan: t.plan ?? [], ctxTokens: t.ctxTokens, ctxWindow: t.ctxWindow }
      }
      return out
    }
  } catch {
    // corrupt cache — start empty
  }
  return {}
}

/** Cold starts (notification taps!) must show the conversation instantly:
 *  persist a trimmed copy — last N items, images stripped (base64 bulk),
 *  most-recent sessions only, quota-tolerant. */
function saveTranscriptCache(id: string, t: Transcript): void {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_CACHE_KEY)
    const cached: CachedTranscripts = raw ? (JSON.parse(raw) as CachedTranscripts) : {}
    const items = t.items.slice(-TRANSCRIPT_CACHE_MAX_ITEMS).map((it) =>
      it.kind === 'user' && it.images?.length ? { ...it, images: undefined } : it
    )
    cached[id] = { items, lastSeq: t.lastSeq, plan: t.plan, ctxTokens: t.ctxTokens, ctxWindow: t.ctxWindow, savedAt: Date.now() }
    const ids = Object.entries(cached)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, TRANSCRIPT_CACHE_MAX_SESSIONS)
    const trimmed: CachedTranscripts = Object.fromEntries(ids)
    try {
      localStorage.setItem(TRANSCRIPT_CACHE_KEY, JSON.stringify(trimmed))
    } catch {
      // quota: drop everything but this session and retry once
      try {
        localStorage.setItem(TRANSCRIPT_CACHE_KEY, JSON.stringify({ [id]: cached[id] }))
      } catch {
        // still no — live without the cache
      }
    }
  } catch {
    // cache is best-effort
  }
}

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
  /** showing cached/none while the live fetch failed or the link is down */
  transcriptStale: boolean
  /** sessions that hit permission/question/turn-complete while not open */
  attention: Record<string, boolean>
  /** unresolved permission/question requests per session — drives the
   *  "needs you" badge in the list without opening the conversation */
  pendingApprovals: Record<string, number>
  sessionInit: SessionInit
  /** phone-local pins: pinned sessions sort first in their workspace */
  pinned: string[]
  togglePin(sessionId: string): void
  /** per-session last-seen updatedAt watermark — powers the finished-while-
   *  away marker even when the app heard no events (iOS had it frozen) */
  seenAt: Record<string, number>
  markSeen(sessionId: string): void
  /** markSeen here AND on the desktop (which fans it out to other phones);
   *  retried from refresh() when the desktop can't be told right now */
  markSeenEverywhere(sessionId: string): void
  /** the desktop's finished-unseen set; null = desktop too old to say */
  desktopUnseen: string[] | null
  /** when this phone learned a session's turn ended (old-desktop fallback) */
  finishedAt: Record<string, number>
  /** the desktop sidebar's pins/order/sort/collapse; null = desktop too old */
  desktopLayout: SidebarLayout | null
  /** marked unread here when the desktop couldn't take it */
  unreadOverrides: string[]
  /** sessions still working after their turn ended — live only, never cached */
  liveWork: string[]
  /** "Mark as unread": the desktop flags it for every device */
  markUnseen(sessionId: string): Promise<void>
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
  sendPrompt(text: string, images?: { base64: string; mediaType: string }[]): Promise<void>
  interrupt(): Promise<void>
  startSession(req: {
    projectId: string
    backend: string
    environment: string
    permissionMode: string
    model?: string
    firstPrompt?: string
    firstImages?: { base64: string; mediaType: string }[]
  }): Promise<void>
  respondPermission(sessionId: string, requestId: string, decision: string): Promise<void>
  respondQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  /** per-session follow-ups submitted while the agent was running (desktop's
   *  messageQueue): one is sent each time a turn settles, oldest first */
  queues: Record<string, QueuedMessage[]>
  queueMessage(sessionId: string, text: string, images?: QueuedMessage['images']): void
  removeQueued(sessionId: string, id: string): void
  /** interrupt the running turn and send this one next */
  sendQueuedNow(sessionId: string, id: string): Promise<void>
  flushQueue(sessionId: string): Promise<void>
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
      useApp.setState(conn === 'online' ? { conn, error: null } : { conn, liveWork: [] })
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
        if (ev.event.kind === 'init') {
          const init = withInitModel(s.sessionInit, ev.sessionId, ev.event.model)
          if (init) next.sessionInit = init
        }
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
        } else if (kind === 'turn-complete' || kind === 'exit') {
          // the turn's leftover requests are dead (applyEvent cancelled them)
          next.pendingApprovals = { ...s.pendingApprovals, [ev.sessionId]: t ? countPending(t) : 0 }
        }
        return next
      })
    },
    onSeen: (sessionId: string) => {
      const app = useApp.getState()
      app.markSeen(sessionId)
      useApp.setState((s) => ({ attention: { ...s.attention, [sessionId]: false } }))
    },
    onUnseen: (sessionId: string) => {
      const app = useApp.getState()
      const asked = requestedUnseen.delete(sessionId)
      // on screen here: no bell; closing it clears the desktop's too
      if (!asked && app.openSessionId === sessionId && document.visibilityState === 'visible') {
        return
      }
      useApp.setState((s) => {
        const base = s.desktopUnseen ?? []
        if (base.includes(sessionId)) return {}
        const desktopUnseen = [...base, sessionId]
        saveJson(DESKTOP_UNSEEN_KEY, desktopUnseen)
        return { desktopUnseen }
      })
    },
    onLiveWork: (ids: string[]) => useApp.setState({ liveWork: ids }),
    onSessionUpdated: (session: SessionMeta) => {
      const prev = useApp.getState().sessions.find((x) => x.id === session.id)?.status
      if (isActive(session.status)) flushInFlight.delete(session.id)
      if (isActive(prev) && !isActive(session.status)) noteFinished([session.id])
      useApp.setState((s) => ({
        sessions: s.sessions.some((x) => x.id === session.id)
          ? s.sessions.map((x) => (x.id === session.id ? session : x))
          : [...s.sessions, session]
      }))
      // turn settled (running/starting → idle|error): send the next queued
      // message — 'error' too, since a send-now interrupt ends claude's turn
      // with an is_error result
      if (isActive(prev) && (session.status === 'idle' || session.status === 'error')) {
        void useApp.getState().flushQueue(session.id)
      }
    }
  })
  if (c && savedToken) c.setApnsToken(savedToken)
  c?.start()
  return c
}

const homeCache = loadHomeCache()

/** turns that ended: the open one was watched, the rest wait for a look */
function noteFinished(ids: string[]): void {
  const app = useApp.getState()
  const now = Date.now()
  const finishedAt = { ...app.finishedAt }
  for (const id of ids) {
    if (id === app.openSessionId && document.visibilityState === 'visible') app.markSeen(id)
    else finishedAt[id] = now
  }
  saveJson(FINISHED_KEY, finishedAt)
  useApp.setState({ finishedAt })
}

export const useApp = create<AppState>((set, get) => ({
  pairingUrl: localStorage.getItem(PAIRING_KEY),
  conn: 'idle',
  screen: 'home',
  projects: homeCache.projects,
  sessions: homeCache.sessions,
  openSessionId: null,
  transcripts: loadTranscriptCache(),
  transcriptLoading: false,
  transcriptStale: false,
  attention: {},
  pendingApprovals: loadJson<Record<string, number>>(PENDING_KEY, {}),
  sessionInit: loadJson<SessionInit>(SESSION_INIT_KEY, {}),
  pinned: loadJson<string[]>(PINS_KEY, []),
  seenAt: loadJson<Record<string, number>>(SEEN_KEY, {}),
  desktopUnseen: loadJson<string[] | null>(DESKTOP_UNSEEN_KEY, null),
  finishedAt: loadJson<Record<string, number>>(FINISHED_KEY, {}),
  desktopLayout: loadJson<SidebarLayout | null>(LAYOUT_KEY, null),
  unreadOverrides: loadJson<string[]>(UNREAD_KEY, []),
  liveWork: [],
  error: null,
  queues: loadQueues(),

  queueMessage(sessionId, text, images): void {
    const msg: QueuedMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      ...(images?.length && { images })
    }
    set((s) => {
      const queues = { ...s.queues, [sessionId]: [...(s.queues[sessionId] ?? []), msg] }
      saveQueues(queues)
      return { queues }
    })
  },

  removeQueued(sessionId, id): void {
    set((s) => {
      const queues = { ...s.queues, [sessionId]: (s.queues[sessionId] ?? []).filter((m) => m.id !== id) }
      saveQueues(queues)
      return { queues }
    })
  },

  async sendQueuedNow(sessionId, id): Promise<void> {
    const q = get().queues[sessionId] ?? []
    const target = q.find((m) => m.id === id)
    if (!target) return
    set((s) => {
      const queues = { ...s.queues, [sessionId]: [target, ...q.filter((m) => m.id !== id)] }
      saveQueues(queues)
      return { queues }
    })
    const status = get().sessions.find((x) => x.id === sessionId)?.status
    // prompting into a live turn would race it: interrupt, and the turn
    // settling flushes this message first
    if (isActive(status)) await bridge().call('interrupt', sessionId)
    else await get().flushQueue(sessionId)
  },

  async flushQueue(sessionId): Promise<void> {
    const guard = flushInFlight.get(sessionId)
    if (guard && Date.now() - guard < FLUSH_GUARD_MS) return
    const [next, ...rest] = get().queues[sessionId] ?? []
    if (!next) return
    flushInFlight.set(sessionId, Date.now())
    set((s) => {
      const queues = { ...s.queues, [sessionId]: rest }
      saveQueues(queues)
      return { queues }
    })
    try {
      const text = next.text || IMAGE_ONLY_PROMPT
      if (next.images?.length) await bridge().call('prompt', sessionId, text, next.images)
      else await bridge().call('prompt', sessionId, text)
    } catch {
      // not delivered — put it back at the front for the next settle/refresh
      flushInFlight.delete(sessionId)
      set((s) => {
        const queues = { ...s.queues, [sessionId]: [next, ...(s.queues[sessionId] ?? [])] }
        saveQueues(queues)
        return { queues }
      })
    }
  },

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
      const seenAt = { ...s.seenAt, [sessionId]: Date.now() }
      saveJson(SEEN_KEY, seenAt)
      const next: Partial<AppState> = { seenAt }
      if (s.desktopUnseen?.includes(sessionId)) {
        next.desktopUnseen = s.desktopUnseen.filter((id) => id !== sessionId)
        saveJson(DESKTOP_UNSEEN_KEY, next.desktopUnseen)
      }
      if (s.unreadOverrides.includes(sessionId)) {
        next.unreadOverrides = s.unreadOverrides.filter((id) => id !== sessionId)
        saveJson(UNREAD_KEY, next.unreadOverrides)
      }
      return next
    })
  },

  async markUnseen(sessionId: string): Promise<void> {
    try {
      requestedUnseen.add(sessionId)
      await bridge().call('markUnseen', sessionId)
      // the desktop's unseen frame confirms it; don't wait on the round trip
      set((s) =>
        s.desktopUnseen && !s.desktopUnseen.includes(sessionId)
          ? { desktopUnseen: [...s.desktopUnseen, sessionId] }
          : {}
      )
    } catch {
      requestedUnseen.delete(sessionId)
      set((s) => {
        if (s.unreadOverrides.includes(sessionId)) return {}
        const unreadOverrides = [...s.unreadOverrides, sessionId]
        saveJson(UNREAD_KEY, unreadOverrides)
        return { unreadOverrides }
      })
    }
  },

  markSeenEverywhere(sessionId: string): void {
    get().markSeen(sessionId)
    const remember = (): void => {
      const pending = loadJson<string[]>(PENDING_SEEN_KEY, [])
      if (!pending.includes(sessionId)) saveJson(PENDING_SEEN_KEY, [...pending, sessionId])
    }
    const c = tryBridge()
    if (!c) return remember()
    c.call('markSeen', sessionId).catch((err) => {
      if (!isUnknownMethod(err)) remember()
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
      const saved = localStorage.getItem(APNS_KEY)
      if (saved) client?.removeApnsToken(saved)
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
    // open NOW even when offline: the persisted cache renders instantly and
    // the 'online' transition replays the live transcript automatically
    void get().openSession(id)
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
        saveTranscriptCache(id, t)
        const init = withInitModel(s.sessionInit, id, t.initModel)
        return {
          transcripts: { ...s.transcripts, [id]: t },
          transcriptLoading: false,
          transcriptStale: false,
          pendingApprovals: { ...s.pendingApprovals, [id]: countPending(t) },
          ...(init && { sessionInit: init })
        }
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
    localStorage.removeItem(QUEUE_KEY)
    for (const k of [
      DESKTOP_UNSEEN_KEY,
      PENDING_SEEN_KEY,
      FINISHED_KEY,
      LAYOUT_KEY,
      UNREAD_KEY,
      PENDING_KEY
    ]) {
      localStorage.removeItem(k)
    }
    set({
      desktopUnseen: null,
      desktopLayout: null,
      unreadOverrides: [],
      liveWork: [],
      finishedAt: {},
      pairingUrl: null,
      conn: 'idle',
      projects: [],
      sessions: [],
      openSessionId: null,
      transcripts: {},
      attention: {},
      pendingApprovals: {},
      queues: {}
    })
  },

  async refresh(): Promise<void> {
    set({ refreshing: true })
    try {
      // seen here while the desktop couldn't hear it: tell it first, so the
      // snapshot below already reflects it
      const pendingSeen = loadJson<string[]>(PENDING_SEEN_KEY, [])
      if (pendingSeen.length) {
        const told = await Promise.all(
          pendingSeen.map((id) =>
            bridge()
              .call('markSeen', id)
              .then(() => true)
              .catch((err) => isUnknownMethod(err))
          )
        )
        saveJson(PENDING_SEEN_KEY, pendingSeen.filter((_, i) => !told[i]))
      }
      const requestedAt = Date.now()
      const [projects, sessions, sidebar] = await Promise.all([
        bridge().call<Project[]>('listProjects'),
        bridge().call<SessionMeta[]>('listSessions'),
        bridge()
          .call<BridgeSidebarState>('sidebarState')
          .catch((err): BridgeSidebarState | null | undefined =>
            // null = old desktop (fall back); undefined = keep what we have
            isUnknownMethod(err) ? null : undefined
          )
      ])
      const before = new Map(get().sessions.map((x) => [x.id, x.status]))
      const settled = sessions
        .filter((x) => isActive(before.get(x.id)) && !isActive(x.status))
        .map((x) => x.id)
      set((s) => {
        const next: Partial<AppState> = { projects, sessions, error: null }
        // an unanswered request holds its turn open: a settled session has none
        const pendingApprovals = { ...s.pendingApprovals }
        for (const x of sessions) if (!isActive(x.status)) delete pendingApprovals[x.id]
        next.pendingApprovals = pendingApprovals
        if (sidebar === null) {
          next.desktopUnseen = null
          next.desktopLayout = null
          saveJson(DESKTOP_UNSEEN_KEY, null)
          saveJson(LAYOUT_KEY, null)
        } else if (sidebar) {
          next.liveWork = sidebar.liveWork ?? []
          if (sidebar.layout) {
            next.desktopLayout = sidebar.layout
            saveJson(LAYOUT_KEY, sidebar.layout)
          }
          // a look on this phone after the snapshot was taken wins over it
          next.desktopUnseen = sidebar.unseen.filter((id) => (s.seenAt[id] ?? 0) < requestedAt)
          saveJson(DESKTOP_UNSEEN_KEY, next.desktopUnseen)
        }
        return next
      })
      if (settled.length) noteFinished(settled)
      // queued while the app was frozen or offline: the settle that would have
      // flushed it was never heard
      for (const sess of sessions) {
        const settled = sess.status === 'idle' || sess.status === 'error'
        if (settled && get().queues[sess.id]?.length) void get().flushQueue(sess.id)
      }
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
    // cached transcript (persisted — cold starts from a notification tap
    // included) shows instantly; the live fetch replaces it when it lands
    const cached = get().transcripts[id]
    const online = get().conn === 'online'
    set((s) => ({
      openSessionId: id,
      transcriptLoading: online && !cached,
      transcriptStale: !online,
      attention: { ...s.attention, [id]: false },
      transcripts: cached ? s.transcripts : { ...s.transcripts, [id]: emptyTranscript() }
    }))
    // clear the desktop's bell/badge/banners too (older desktops: no-op)
    get().markSeenEverywhere(id)
    bridge().sub(id)
    // offline: show what we have; the 'online' transition replays via
    // reloadOpenTranscript, so this open self-heals without user action
    if (!online) return
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
        const pending = countPending(t)
        saveTranscriptCache(id, t)
        const init = withInitModel(s.sessionInit, id, t.initModel)
        return {
          transcripts: { ...s.transcripts, [id]: t },
          transcriptLoading: false,
          transcriptStale: false,
          pendingApprovals: { ...s.pendingApprovals, [id]: pending },
          ...(init && { sessionInit: init })
        }
      })
    } catch (err) {
      // the fetch failed — whatever is on screen is stale, say so honestly
      set({
        error: err instanceof Error ? err.message : String(err),
        transcriptLoading: false,
        transcriptStale: true
      })
    }
  },

  closeSession(): void {
    const id = get().openSessionId
    if (id) {
      bridge().unsub(id)
      get().markSeenEverywhere(id)
    }
    set({ openSessionId: null })
  },

  async sendPrompt(
    text: string,
    images?: { base64: string; mediaType: string }[]
  ): Promise<void> {
    const id = get().openSessionId
    if (!id) return
    if (images?.length) await bridge().call('prompt', id, text, images)
    else await bridge().call('prompt', id, text)
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
// "needs you" must survive a cold start; replay recomputes it on open
useApp.subscribe((s, prev) => {
  if (s.pendingApprovals !== prev.pendingApprovals) {
    const kept = Object.fromEntries(Object.entries(s.pendingApprovals).filter(([, n]) => n > 0))
    saveJson(PENDING_KEY, kept)
  }
})
applyTextScale(useApp.getState().textScale)
applyTheme(useApp.getState().theme)
