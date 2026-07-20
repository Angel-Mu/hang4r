#!/usr/bin/env bash
# Rebuild hang4r and install it to /Applications, signing with a STABLE
# self-signed identity ("hang4r Self-Signed") so macOS keeps your Documents /
# Files-and-Folders permission across rebuilds (ad-hoc signing changes every
# build and makes macOS re-prompt each time).
#
# One-time setup created the identity in your login keychain. If it's missing,
# recreate it (legacy PKCS12 MAC is required for `security import`):
#   openssl req -x509 -newkey rsa:2048 -keyout k.pem -out c.pem -days 3650 -nodes \
#     -subj "/CN=hang4r Self-Signed" \
#     -addext "extendedKeyUsage=critical,codeSigning"
#   openssl pkcs12 -export -legacy -out c.p12 -inkey k.pem -in c.pem -passout pass:hang4r -name "hang4r Self-Signed"
#   security import c.p12 -k ~/Library/Keychains/login.keychain-db -P hang4r -T /usr/bin/codesign -A
set -euo pipefail
cd "$(dirname "$0")/.."

# self-contained node: non-login shells here default to an ancient node (v16)
# and the build fails with a bogus node:fs/promises export error
NODE_V="$(cat .nvmrc 2>/dev/null || echo 22.22.2)"
export PATH="$HOME/.nvm/versions/node/v${NODE_V#v}/bin:$PATH"

# Sign dev installs with the SAME identity as releases when it exists —
# macOS keys TCC permission grants to the signing identity, so alternating
# between a self-signed dev app and the Developer-ID release app (same bundle
# id) reset the grants and re-prompted on every switch (Angel hit this).
# One identity everywhere = grants stick. Self-signed remains the fallback
# for machines without the cert.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')"
if [ -z "$IDENTITY" ]; then
  IDENTITY="hang4r Self-Signed"
  security find-certificate -c "$IDENTITY" >/dev/null 2>&1 || IDENTITY="Hangar Self-Signed"
fi

pkill -f "/Applications/hang4r.app/Contents/MacOS/hang4r" 2>/dev/null || true
sleep 1
rm -rf dist/mac-arm64
npm run build
npx electron-builder --mac --dir

rm -rf /Applications/hang4r.app
cp -R dist/mac-arm64/hang4r.app /Applications/hang4r.app
xattr -cr /Applications/hang4r.app
# stable identity keeps TCC (Documents access) grants across rebuilds
codesign --force --deep --sign "$IDENTITY" /Applications/hang4r.app

# Remove the dist build copy so Launchpad/Spotlight don't register a SECOND
# "hang4r" app (the leftover .app in dist/ was showing up as a duplicate).
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREG" -u "$PWD/dist/mac-arm64/hang4r.app" 2>/dev/null || true
rm -rf dist/mac-arm64
"$LSREG" -f /Applications/hang4r.app 2>/dev/null || true

echo "installed + signed with '$IDENTITY' @ $(git rev-parse --short HEAD)"
