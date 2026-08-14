---
name: mobile
description: Use when working on the hang4r mobile app (mobile/), the bridge relay (relay/), the desktop bridgeService, TestFlight uploads, Android APK builds, push notifications, or pairing — building, shipping, and the traps that already burned us.
---

# hang4r mobile

`mobile/` (Capacitor iOS/Android app) + `relay/` (Cloudflare Worker/DO) + `src/main/services/bridgeService.ts` (desktop side), sharing `src/shared/` (protocol, bridge frames, icons, claudeModels). Design doc: `docs/mobile/design.md`. Full history + credentials map: memory `hangar-mobile-bridge`.

## Ground rules

- **Worktrees via Worktrunk only**: `wt switch --create <branch>` (lands in `.worktrees/`). Never `git worktree add` into sibling dirs.
- **One heavy process at a time** (builds, suites, archives). Parallel gates froze Angel's 24GB Mac twice.
- **Never cut a desktop release without Angel's explicit go.**
- **Verify generated assets by pixels, not filenames** — `@capacitor/assets` dies mid-run leaving Capacitor's stock splash/icons under identical names. Read the PNGs (or extract from the built APK) before shipping.
- Everything Xcode: prefix `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (xcode-select points at CommandLineTools).

## Build & run

```bash
cd mobile && npm run build && npx cap sync          # web assets → native projects
# simulator (no signing):
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/DerivedData \
  CODE_SIGNING_ALLOWED=NO build
```
Browser dev loop: `npm run dev` in `mobile/` + desktop dev build + deployed relay — full loop, no native shell.

## Ship iOS (TestFlight)

1. Bump `CURRENT_PROJECT_VERSION` in `mobile/ios/App/App.xcodeproj/project.pbxproj` — Apple rejects duplicate build numbers.
2. `xcodebuild archive` with manual signing: `CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=JFHPE95EVW CODE_SIGN_IDENTITY="Apple Distribution: Angel Malavar (JFHPE95EVW)" PROVISIONING_PROFILE_SPECIFIER="hang4r mobile App Store"`.
3. `xcodebuild -exportArchive` with an exportOptions plist (`method: app-store-connect`, `destination: upload`, same manual signing map) + `-authenticationKeyPath ~/.appstoreconnect/AuthKey_MB58HFLA5T.p8 -authenticationKeyID MB58HFLA5T -authenticationKeyIssuerID` (issuer in `.env.release`). Success line: `Uploaded App`.

## Ship Android (sideload APK)

```bash
cd mobile/android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```
Publish to `Angel-Mu/hang4r-releases` release `mobile-v*` with `gh release upload --clobber` under the versioned filename. **That release must stay `--prerelease`** — the repo is the desktop auto-update feed; a plain release on top breaks the updater. No push on Android (pipeline is APNs; FCM not built).

## Relay

`cd relay && npx wrangler deploy` (Angel's Cloudflare account). Live smoke: `relay-smoke.mjs` pattern — auth matrix, presence, rotation, binary passthrough. APNs secrets are wrangler secrets (`APNS_TEAM_ID/KEY_ID/P8/TOPIC`); push key `AuthKey_5MQ3WNZ3RJ.p8` in `~/.appstoreconnect/`.

## Testing

`e2e/bridge.spec.ts` (fake phone ↔ desktop through the DEPLOYED relay) and `e2e/mobile-app.spec.ts` (real mobile UI in Chromium; self-skips when `mobile/dist` is absent). Full desktop suite is the merge gate for anything touching `src/`.

## Architecture traps

- iOS freezes the webview socket without closing it: presence ≠ liveness. The relay pushes via APNs unless a client FRAME arrived <40s ago; the phone ping-probes on resume and replays the open transcript (streamed events are broadcast-only, unrecoverable).
- Bridge clients must `resyncSession` before `getSessionEvents` (desktop's own order) or externally-driven sessions look empty.
- The phone speaks a curated allowlist (`BRIDGE_METHODS` in `src/shared/bridge.ts`) — no file writes, no terminal. Extend deliberately.
