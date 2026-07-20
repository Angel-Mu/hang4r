// Custom electron-builder mac code-sign hook.
//
// WHY THIS EXISTS: app-builder-lib resolves the signing certificate to a full
// { name, hash } identity, but then hands @electron/osx-sign only
// `identity.name` with `identityValidation: false` (macPackager.js `doSign`).
// osx-sign therefore does `new Identity(name)` (no hash) and runs
// `codesign --sign "<name>"`. When the login keychain holds two "Developer ID
// Application: …" certificates with the IDENTICAL common name (Angel renewed
// the Developer ID on 2026-07-19 and the prior 2026-07-17 cert — which signed
// v1.0.10–1.0.12 — is still installed), codesign dies with
//   "… ambiguous (matches "…" and "…" in login.keychain-db)"
// and the whole build aborts mid-sign. No `mac.identity` config fixes it: the
// hash is discarded before codesign runs.
//
// FIX: sign by the certificate's SHA-1 HASH instead of its name. `man codesign`
// accepts a leaf-cert SHA-1 hash as the `--sign` identity, which is unique even
// when two certs share a name — so this disambiguates WITHOUT deleting anything
// from Angel's keychain (the two certs have different private keys; deleting one
// would permanently lose a signing key). We pass `identityValidation: false` so
// osx-sign uses the hash verbatim as the identity.
//
// The hash comes from HANG4R_SIGN_ID, exported by scripts/release.sh, which
// auto-detects the Developer ID Application identity (self-healing across cert
// rotation, since `security find-identity -v` lists only currently-valid certs)
// and can be overridden. If it is unset we fall through to osx-sign's own
// auto-discovery, which picks identities[0] (an Identity WITH a hash) and thus
// still signs by hash rather than the ambiguous name.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS hook module */
exports.default = async function sign(opts) {
  const { signAsync } = require('@electron/osx-sign')
  const identity = process.env.HANG4R_SIGN_ID
  if (identity && /^[0-9A-Fa-f]{40}$/.test(identity)) {
    await signAsync({ ...opts, identity, identityValidation: false })
  } else {
    // No pinned hash: opts carries no identity here, so osx-sign auto-discovers
    // a full Identity (which includes the hash) and signs by hash — not by the
    // ambiguous name.
    await signAsync(opts)
  }
}
