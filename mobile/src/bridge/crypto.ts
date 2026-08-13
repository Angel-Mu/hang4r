import { HKDF_INFO_E2E, HKDF_INFO_RELAY, HKDF_SALT } from '@shared/bridge'

const te = new TextEncoder()

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface BridgeKeys {
  e2e: CryptoKey
  relayToken: string
}

/** Same derivation as the desktop's node:crypto hkdfSync — verified by e2e. */
export async function deriveKeys(pairSecretB64url: string): Promise<BridgeKeys> {
  const ikm = await crypto.subtle.importKey('raw', b64urlDecode(pairSecretB64url) as BufferSource, 'HKDF', false, [
    'deriveBits'
  ])
  const hkdf = (info: string): Promise<ArrayBuffer> =>
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: te.encode(HKDF_SALT), info: te.encode(info) },
      ikm,
      256
    )
  const e2e = await crypto.subtle.importKey('raw', await hkdf(HKDF_INFO_E2E), 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ])
  const relayToken = b64urlEncode(new Uint8Array(await hkdf(HKDF_INFO_RELAY)))
  return { e2e, relayToken }
}

/** Wire layout: iv(12) || ciphertext+tag — WebCrypto appends the tag itself. */
export async function encryptFrame(key: CryptoKey, json: string): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(json))
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 12)
  return out.buffer
}

export async function decryptFrame(key: CryptoKey, buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf)
  const iv = bytes.subarray(0, 12)
  const ct = bytes.subarray(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(plain)
}
