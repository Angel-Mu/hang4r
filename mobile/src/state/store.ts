import { create } from 'zustand'
import type { Project, QuestionAnswer, SessionEvent, SessionMeta } from '@shared/protocol'
import { BridgeClient, type ConnectionState } from '../bridge/client'
import { applyEvent, emptyTranscript, type Transcript } from './transcript'

const PAIRING_KEY = 'h4.pairing'
const APNS_KEY = 'h4.apnsToken'

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
  error: string | null

  pair(url: string): boolean
  unpair(): void
  setApnsToken(token: string): void
  setScreen(screen: Screen): void
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
export function bridge(): BridgeClient {
  if (!client) throw new Error('not paired')
  return client
}

function startClient(url: string): BridgeClient | null {
  const savedToken = localStorage.getItem(APNS_KEY)
  const c = BridgeClient.fromUrl(url, {
    onState: (conn) => {
      useApp.setState({ conn })
      if (conn === 'online') void useApp.getState().refresh()
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

export const useApp = create<AppState>((set, get) => ({
  pairingUrl: localStorage.getItem(PAIRING_KEY),
  conn: 'idle',
  screen: 'home',
  projects: [],
  sessions: [],
  openSessionId: null,
  transcripts: {},
  transcriptLoading: false,
  attention: {},
  error: null,

  setScreen(screen: Screen): void {
    set({ screen })
  },

  setApnsToken(token: string): void {
    localStorage.setItem(APNS_KEY, token)
    client?.setApnsToken(token)
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
    set({
      pairingUrl: null,
      conn: 'idle',
      projects: [],
      sessions: [],
      openSessionId: null,
      transcripts: {},
      attention: {}
    })
  },

  async refresh(): Promise<void> {
    try {
      const [projects, sessions] = await Promise.all([
        bridge().call<Project[]>('listProjects'),
        bridge().call<SessionMeta[]>('listSessions')
      ])
      set({ projects, sessions, error: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  async openSession(id: string): Promise<void> {
    const prev = get().openSessionId
    if (prev && prev !== id) bridge().unsub(prev)
    set((s) => ({
      openSessionId: id,
      transcriptLoading: true,
      attention: { ...s.attention, [id]: false },
      transcripts: { ...s.transcripts, [id]: emptyTranscript() }
    }))
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
        return { transcripts: { ...s.transcripts, [id]: t }, transcriptLoading: false }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), transcriptLoading: false })
    }
  },

  closeSession(): void {
    const id = get().openSessionId
    if (id) bridge().unsub(id)
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
