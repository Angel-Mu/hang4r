# hang4r mobile — remote bridge design

**Goal**: an iOS companion app (Capacitor) that connects to the hang4r desktop
over the internet and continues the *same* sessions — full conversation
continuity, live streaming, approvals, new sessions, diffs, usage — with no
network setup on either end.

Decisions locked with Angel (2026-08-13):

- **Bridge**: our own relay — Cloudflare Worker + Durable Object on the
  hang4r.dev account (same wrangler auth the landing deploy uses). Works for
  *any* future app user: desktop and phone both dial **out**, so NAT/firewalls
  never matter. E2E encrypted; the relay routes opaque bytes.
- **Platform**: iOS first via Capacitor 8 (the proven Wodometer recipe).
- **v1 scope**: workspaces → sessions → history + live transcript, send
  prompts, permission + question approvals, start new sessions, diff review
  (read-only), usage, minimal settings. Push notifications phased in last.
- Distribution is explicitly out of scope; the app must *build and run
  packaged* (archive), not ship to the App Store yet.

## Topology

```
hang4r desktop                 Cloudflare                    iPhone
┌──────────────────┐      ┌────────────────────┐      ┌──────────────────┐
│ bridgeService.ts │─wss─▶│ relay worker        │◀─wss─│ hang4r mobile     │
│ (main process)   │      │ DO per deviceId     │      │ (Capacitor)       │
└──────────────────┘      │ routes ciphertext   │      └──────────────────┘
                          └────────────────────┘
```

- One Durable Object instance per `deviceId` (a desktop install). It holds the
  live WebSocket to the desktop and to at most a few phone clients, and pumps
  frames between them. No message content is ever stored server-side.
- Both connections are **outbound** from the user's devices. Reconnect with
  exponential backoff + jitter on both ends; the DO tolerates either side
  dropping.

## Identity, pairing, encryption

Desktop generates and persists (store settings):

- `bridge.deviceId` — UUID, public routing key.
- `bridge.pairSecret` — 32 random bytes (base64url). Never leaves the device
  except inside the QR code.

Pairing QR / manual code encodes one URL:

```
hang4r://pair?v=1&device=<deviceId>&secret=<pairSecret>&relay=wss://relay.hang4r.dev
```

Both ends derive, via HKDF-SHA256 over `pairSecret` with distinct `info`
labels:

- `info="h4/e2e"` → **AES-256-GCM session key**. Every frame is
  `iv(12B) || ciphertext` sent as a binary ws message. The relay cannot read
  frames — different HKDF label means the relay token reveals nothing about
  this key.
- `info="h4/relay"` → **relay auth token** (sent as `?t=` on the ws upgrade).
  The DO learns the token hash from the *desktop's* first connection (TOFU
  registration) and requires the same token from phone clients. Re-pairing
  rotates `pairSecret`, which rotates both derivations; the DO replaces its
  stored hash on the next desktop connect with the `reset=1` flag (desktop
  sends it only when the user explicitly re-pairs).

Threat model v1: the relay is trusted for availability only; content privacy
comes from E2E. One desktop ↔ one-or-few phones, all owned by the same person.

## Frame protocol (inside the encryption)

JSON, one frame per ws message:

```ts
type BridgeFrame =
  | { t: 'hello'; role: 'desktop' | 'client'; appVersion: string }
  | { t: 'peer'; connected: boolean }                    // relay → both sides
  | { t: 'req'; id: number; method: string; params: unknown[] }   // phone → desktop
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'sub'; sessionId: string }                      // phone → desktop
  | { t: 'unsub'; sessionId: string }
  | { t: 'event'; channel: 'agent-event'; payload: SessionEvent }
  | { t: 'event'; channel: 'session-updated'; payload: SessionMeta }
```

`peer` is the only frame the relay itself originates (plaintext-adjacent: it
carries no user content) so each side can show connection state without
guessing.

### Event forwarding policy

- `session-updated`: always forwarded (cheap; drives all list screens).
- `agent-event`: `block-delta` and mid-turn `usage` events are forwarded only
  for sessions the phone has `sub`'d (the open one). Everything else —
  `turn-complete`, `permission-request`, `question-request`, `block-final`,
  `user-text`, … — is always forwarded, so badges and approvals work from any
  screen. This mirrors the desktop's own economics: block-deltas are
  broadcast-only there too (never persisted; see the v1.0.84 DB-bloat fix).
- On opening a session the phone calls `getSessionEvents` (replay is
  block-final-complete by design), renders, then `sub`s for live deltas.

### Method allowlist (v1)

The desktop router exposes a **curated subset** of `Hang4rApi`
(`src/shared/protocol.ts`) — never the whole surface. File writes, terminal,
settings-file editing, and browser control are deliberately absent.

- Lists: `listProjects`, `listSessions`, `listArchivedSessions`
- Transcript: `getSessionEvents`
- Drive: `prompt` (text-only in v1), `interrupt`, `createSession`,
  `respondPermission`, `respondQuestion`, `renameSession`, `archiveSession`,
  `unarchiveSession`, `retrySession`
- New-session support: `authStatus`, `listCodexModels`, `listCursorModels`,
  `resolveAgentDefault`
- Diff: `scopeSummary`, `scopedFiles`, `scopedDiff`
- Usage: `claudeUsage`, `codexUsage`, `cursorUsage`
- Meta: `appVersion`, `agentAlive`, `currentBranch`

## Repo layout (monorepo, like `landing/`)

```
relay/    wrangler project: the Cloudflare Worker + DO. `npm run deploy`.
mobile/   Vite + React + TS + Capacitor iOS app. Imports the desktop's
          src/shared/protocol.ts via tsconfig path alias — one protocol,
          zero drift.
src/main/services/bridge.ts   desktop side: ws client, crypto, router, fan-out.
```

`electron-builder.yml` gets `!relay`/`!mobile` exclusions **in the same commit
that creates the dirs** — the `.worktrees` asar-bloat incident (v1.0.8) must
not repeat.

## Desktop integration points

- `bridgeService` starts when `bridge.enabled` setting is true; lives beside
  the other main-process services and taps the same broadcast path that feeds
  `agent-event` / `session-updated` to the renderer.
- Requests are executed against the same service functions `ipc.ts` handlers
  call — the bridge is a *second, narrower* front-end to the main process, not
  a parallel implementation.
- Settings UI: a "Phone" section — enable toggle, QR code, connection status
  (relay reachable / phone online), re-pair button.

## Mobile app

- Vite + React 19 + zustand (desktop-familiar stack), TypeScript strict.
- Capacitor 8, bundle id `dev.hang4r.mobile`, name **hang4r**, iOS deployment
  target 15.0+, dark splash `#0f0f23`-family per brand. Plugins: status-bar,
  splash-screen, haptics, keyboard, + barcode scanning for QR pairing (manual
  paste fallback — required for simulator/e2e anyway).
- Screens: Pair → Workspaces → Sessions → Session (transcript + composer +
  approval sheets) · New Session · Diff · Usage · Settings.
- Runs as a plain web app in dev (`vite dev` against `wrangler dev` relay +
  desktop dev build) — the full loop works locally before any deploy; the
  native shell is only needed for camera QR + packaging.

## Push notifications (phase 2 of v1)

Desktop emits lightweight `notify` frames (turn finished / input needed) that
the DO forwards to connected phones; when no phone is connected the DO calls
APNs (token-based auth key, stored as a worker secret) for the paired device
token. Until the APNs key exists: in-app + `peer`-connected notifications only.

## Verification ladder

1. Unit: relay DO routing (vitest + miniflare), bridge router allowlist, crypto
   round-trip.
2. Local loop: desktop dev + `wrangler dev` relay + mobile in browser —
   pair, list, stream, prompt, approve, diff.
3. Internet loop: deployed relay, phone on cellular (not the desktop's wifi).
4. Packaged: `vite build && cap sync && xcodebuild archive` with the
   JFHPE95EVW distribution cert — the "ready packaged" bar for this effort.
