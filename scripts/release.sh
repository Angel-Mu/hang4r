#!/usr/bin/env bash
# hang4r release: signed (Developer ID) + notarized + published to GitHub Releases.
#
# One-time setup (see docs/launch-plan.md §2):
#   1. Developer ID Application cert installed in the login keychain
#      (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application)
#   2. App Store Connect API key: put the .p8 anywhere (e.g. ~/.appstoreconnect/),
#      then create .env.release at the repo root (gitignored) with:
#        APPLE_API_KEY=/Users/you/.appstoreconnect/AuthKey_XXXXXXXXXX.p8
#        APPLE_API_KEY_ID=XXXXXXXXXX
#        APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   3. gh CLI logged in (publishing uses `gh auth token`).
#
# Usage:
#   scripts/release.sh            # gate + build + sign + notarize + publish DRAFT release
#   scripts/release.sh --no-gate  # skip the e2e gate (only if you JUST ran it green)
#
# The release is created as a DRAFT — review the notes on GitHub, then press
# Publish there. Auto-update (electron-updater) only sees PUBLISHED releases.
set -euo pipefail
cd "$(dirname "$0")/.."

# self-contained node (non-login shells default to v16 — build breaks)
NODE_V="$(cat .nvmrc 2>/dev/null || echo 22.22.2)"
export PATH="$HOME/.nvm/versions/node/v${NODE_V#v}/bin:$PATH"

[ -f .env.release ] && set -a && source .env.release && set +a

fail() { echo "RELEASE BLOCKED: $1" >&2; exit 1; }

# ---- preflight: credentials + cert + clean tree ----
[ -n "${APPLE_API_KEY:-}" ] || fail ".env.release is missing APPLE_API_KEY (path to the .p8)"
[ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY points to '$APPLE_API_KEY' but no file is there"
[ -n "${APPLE_API_KEY_ID:-}" ] || fail ".env.release is missing APPLE_API_KEY_ID"
[ -n "${APPLE_API_ISSUER:-}" ] || fail ".env.release is missing APPLE_API_ISSUER"
# Resolve the signing identity to a specific SHA-1 hash. The keychain can hold
# two "Developer ID Application" certs with the IDENTICAL name (a cert renewal
# on Jul 19 2026 left the prior one in place) — codesign then dies with
# "ambiguous (matches ...)" and electron-builder aborts mid-sign. Signing by
# hash is unambiguous. Auto-detect (self-heals when a cert is revoked/rotated,
# since `-v` lists only valid identities); override with HANG4R_SIGN_ID=<sha1>.
SIGN_ID="${HANG4R_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_IDS="$(security find-identity -v -p codesigning | grep 'Developer ID Application' | grep -oE '[0-9A-F]{40}')"
  SIGN_COUNT="$(printf '%s\n' "$SIGN_IDS" | grep -c . || true)"
  [ "${SIGN_COUNT:-0}" -ge 1 ] || fail "no 'Developer ID Application' certificate in the keychain (Xcode → Settings → Accounts → Manage Certificates)"
  SIGN_ID="$(printf '%s\n' "$SIGN_IDS" | head -1)"
  [ "$SIGN_COUNT" -gt 1 ] && echo "==> NOTE: ${SIGN_COUNT} 'Developer ID Application' certs present; signing with ${SIGN_ID} (override with HANG4R_SIGN_ID=<sha1>)"
fi
# build/sign.cjs (the electron-builder mac.sign hook) signs by this HASH so
# codesign is unambiguous even with two same-named certs in the keychain.
export HANG4R_SIGN_ID="$SIGN_ID"
echo "==> signing identity: ${SIGN_ID}"
[ -z "$(git status --porcelain)" ] || fail "working tree not clean — commit or stash first"
command -v gh >/dev/null || fail "gh CLI not installed"
GH_TOKEN="$(gh auth token 2>/dev/null)" || fail "gh CLI not logged in (gh auth login)"
export GH_TOKEN

VERSION="$(node -p "require('./package.json').version")"
echo "==> releasing hang4r v${VERSION} ($(git rev-parse --short HEAD))"

# ---- gate: never ship an ungated build ----
if [ "${1:-}" != "--no-gate" ]; then
  echo "==> gate: build + full e2e suite"
  npm run build
  npx playwright test || fail "e2e gate RED — fix before releasing"
else
  echo "==> gate SKIPPED (--no-gate)"
  npm run build
fi

# ---- build, sign (Developer ID auto-discovered), notarize ----
# publish=never: electron-builder must NOT publish (it raced itself into
# duplicate drafts once) and must not bake releaseType=draft into the app's
# app-update.yml (shipped apps would then look for DRAFT releases when
# checking updates — invisible without auth — bricking auto-update).
# The draft release is created below with gh instead.
echo "==> electron-builder: sign + notarize (no publish)"
npx electron-builder --mac \
  --config.mac.notarize=true \
  --publish never

# sanity: the update feed baked into the app must NOT be draft-scoped
if unzip -p "dist/hang4r-${VERSION}-arm64-mac.zip" "hang4r.app/Contents/Resources/app-update.yml" | grep -q "releaseType: draft"; then
  fail "app-update.yml still carries releaseType: draft — shipped apps couldn't see updates"
fi

# sanity: the dmg must be a SANE size. Normal is ~194 MB; a stale .worktrees/
# tree once got packed into app.asar and ballooned it to 3.1 GB — over GitHub's
# 2 GB asset limit, so the app silently never uploaded (v1.0.8/1.0.9). Fail loud
# well before that: anything over 800 MB means something got packed that
# shouldn't have (check electron-builder.yml `files` exclusions).
DMG_BYTES=$(stat -f%z "dist/hang4r-${VERSION}.dmg" 2>/dev/null || echo 0)
if [ "$DMG_BYTES" -gt 838860800 ]; then
  fail "dmg is $((DMG_BYTES/1024/1024)) MB — abnormally large (>800MB). Something bloated the asar (likely a dir missing from electron-builder.yml files exclusions). NOT shipping."
fi
echo "==> dmg size OK: $((DMG_BYTES/1024/1024)) MB"

echo "==> creating DRAFT release + uploading assets (gh)"
# gh reliably exits 1 AFTER creating the draft and uploading every asset: it
# re-resolves the release by tag, and an untagged draft (no git tag pushed)
# 404s there. Hit on 1.0.1/1.0.2/1.0.3. So: never let gh's exit code abort the
# release (set +e around it), then confirm success by polling the API for the
# asset count — which is also eventually-consistent, hence the retry loop.
set +e
gh release create "v${VERSION}" \
  --repo Angel-Mu/hang4r-releases \
  --draft \
  --title "hang4r ${VERSION}" \
  --notes "Release notes pending." \
  dist/hang4r-${VERSION}.dmg \
  dist/hang4r-${VERSION}-arm64-mac.zip \
  dist/hang4r-${VERSION}-arm64-mac.zip.blockmap \
  dist/latest-mac.yml
GH_RC=$?
set -e
[ "$GH_RC" -eq 0 ] || echo "==> gh exited ${GH_RC} (expected for an untagged draft) — verifying via the API"

ASSETS=0
for attempt in 1 2 3 4 5 6; do
  # default to 0 so the integer test never sees a non-numeric jq 'null'/empty
  ASSETS=$(gh api repos/Angel-Mu/hang4r-releases/releases \
    --jq "[.[] | select(.draft and .tag_name == \"v${VERSION}\") | .assets | length] | first // 0" 2>/dev/null)
  case "$ASSETS" in ''|*[!0-9]*) ASSETS=0 ;; esac
  [ "$ASSETS" -eq 4 ] && break
  echo "==> waiting for draft assets to settle (attempt ${attempt}: ${ASSETS}/4)"
  sleep 4
done
[ "$ASSETS" -eq 4 ] || fail "draft v${VERSION} should have 4 assets, found ${ASSETS} after retries"
echo "==> draft v${VERSION} confirmed with 4 assets"

# ---- verify what we actually shipped ----
# NOTE: no pipes with pipefail here — `ls -d A B` exits 1 when one path is
# absent (only one arch dir exists) and that was aborting the whole script
# AFTER a perfectly good draft. Resolve the app path without a failing pipe.
APP=""
for cand in dist/mac-arm64/hang4r.app dist/mac/hang4r.app; do
  [ -d "$cand" ] && { APP="$cand"; break; }
done
[ -n "$APP" ] || fail "built .app not found under dist/"
echo "==> Gatekeeper verdict:"
spctl -a -vvv "$APP" 2>&1 || true
spctl -a "$APP" || fail "spctl rejected the build — DO NOT publish this draft"

echo ""
echo "RELEASE READY (draft):"
echo "  1. Review + publish: https://github.com/Angel-Mu/hang4r-releases/releases"
echo "  2. Landing download button → the .dmg asset URL"
echo "  3. Homebrew tap: update the cask sha256 (shasum -a 256 dist/hang4r-${VERSION}.dmg)"
