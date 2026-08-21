---
name: mobile
description: Use when working on the hang4r mobile app (mobile/), the bridge relay (relay/), the desktop bridgeService, TestFlight uploads, Android APK builds, push notifications, or pairing — building, shipping, and the traps that already burned us.
---

# hang4r mobile

`mobile/` (Capacitor iOS/iPad/Android app) + `relay/` (Cloudflare Worker/DO) + `src/main/services/bridgeService.ts` (desktop side), sharing `src/shared/` (protocol, bridge frames, icons, claudeModels via `@shared/*`). Design doc: `docs/mobile/design.md`. State + history: memory `hangar-mobile-bridge`.

## Ground rules

- **Worktrees via Worktrunk only**: `wt switch --create <branch>` (lands in `.worktrees/`). Never `git worktree add` into sibling dirs. Fresh worktrees need `mobile/npm install` and `mobile/android/local.properties` → `sdk.dir=/opt/homebrew/share/android-commandlinetools`.
- **One heavy process at a time** (e2e suite OR xcodebuild OR gradle). Parallel gates froze Angel's 24GB Mac twice and made the suite flaky.
- **Desktop releases belong to the release agent — never cut one.** Desktop-side bridge changes merge to main and activate at the next release; the phone must degrade gracefully (`unknown method` → "update your desktop" message). Check feature availability with `git merge-base --is-ancestor <merge> <release-commit>` BEFORE debugging "missing" features.
- **Verify generated assets by pixels, not filenames** — `@capacitor/assets` dies mid-run leaving Capacitor's stock splash/icons under identical names. Read the PNGs; extract from the built APK when in doubt.
- **Desktop parity is the spec.** Dots: idle invisible, GREEN pulse = working, amber pulse = awaiting, accent = finished-unseen, red = error. Row: dot → backend glyph → title. No emoji glyphs — shared `src/shared/icons.tsx` only. When unsure, read the desktop component and copy its semantics; never guess.
- Everything Xcode: prefix `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (xcode-select points at CommandLineTools).

## Architecture invariants (violating any of these caused a field bug)

- **Overlays/panels: `position: absolute` inside body-tracking `#root`, NEVER `position: fixed`** — the iOS keyboard shrinks the BODY (Capacitor resize=body); fixed panels hide the composer behind the keyboard. Chromium e2e can't catch keyboard bugs.
- **Presence ≠ liveness (both directions)**: only frames prove life. Awake peers ping every 25s; the relay DO closes desktops silent >40s and tells phones `connected:false`; the phone ping-probes on resume/call-timeout, force-reconnects, and REPLAYS the open transcript (streamed events are broadcast-only, unrecoverable).
- **Persist everything a cold start needs**: transcripts (`h4.transcripts.v1`, 10×150 items, images stripped, quota-tolerant), home snapshot, seenAt watermarks, pins. Notification taps must render instantly from cache offline; live reload self-heals on 'online'. Empty states tell the truth (offline / retrying / actually empty).
- **Badges from persisted watermarks, not live events** (iOS freezes kill event delivery); recompute pending-approvals from replay truth on open.
- **Multi-device push = token SET on the relay** (cap 8, prune on APNs 400/410, `apns-remove` with own token on disable). Never a single slot.
- Bridge clients `resyncSession` before `getSessionEvents`, and `markSeen` after open (feeds the fleet-wide seen mesh: E2E `{t:'seen'}` frames + desktop `seenOnDesktop` funnel clears bells/badges/banners everywhere; pushes are held 30s and cancelled by seen-anywhere).
- The relay-readable channel carries ONLY: peer, notify (kind, opaque sessionId, title — Angel's explicit tradeoff), apns/apns-remove. Message content never.
- Extend `BRIDGE_METHODS` deliberately — no file writes, no terminal.

## Build & run

```bash
cd mobile && npm run build && npx cap sync          # web assets → native projects
# simulator (no signing):
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/DerivedData \
  CODE_SIGNING_ALLOWED=NO build
```
Browser dev loop: `npm run dev` in `mobile/` + desktop dev build + deployed relay. iPad = same binary, split view ≥700px (hideable sidebar; auto-tucks while keyboard open).

## Ship iOS (TestFlight)

1. Bump `CURRENT_PROJECT_VERSION` in `mobile/ios/App/App.xcodeproj/project.pbxproj` — Apple rejects duplicate build numbers.
2. `xcodebuild archive` manual signing: `CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=JFHPE95EVW CODE_SIGN_IDENTITY="Apple Distribution: Angel Malavar (JFHPE95EVW)" PROVISIONING_PROFILE_SPECIFIER="hang4r mobile App Store"`.
3. `xcodebuild -exportArchive` with exportOptions (`method: app-store-connect`, `destination: upload`, same manual signing map) + `-authenticationKeyPath ~/.appstoreconnect/AuthKey_MB58HFLA5T.p8 -authenticationKeyID MB58HFLA5T -authenticationKeyIssuerID <from .env.release>`. Success line: `Uploaded App`.

## Ship Android (sideload APK)

```bash
cd mobile/android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleDebug
```
Upload to `Angel-Mu/hang4r-releases` release `mobile-v0.1.0` with `gh release upload --clobber` under the SAME filename (`hang4r-mobile-0.1.0-android.apk`). **That release must stay `--prerelease`** — the repo is the desktop auto-update feed. No push on Android (APNs-only pipeline; FCM not built).

## Relay

`cd relay && npx wrangler deploy`. APNs secrets are wrangler secrets (`APNS_TEAM_ID/KEY_ID/P8/TOPIC`). Headless Apple provisioning (bundle ids, profiles, device registration) works via the ASC API key `~/.appstoreconnect/AuthKey_MB58HFLA5T.p8`.

## Testing

`e2e/bridge.spec.ts` (fake phone ↔ desktop through the DEPLOYED relay) and `e2e/mobile-app.spec.ts` (real mobile UI in Chromium; self-skips without `mobile/dist`). Full desktop suite once before merging anything that touches `src/`. Screenshot new UI before shipping — pixels, not assumptions.
