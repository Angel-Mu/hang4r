import { test, expect } from '@playwright/test'
import {
  DIAG_LOG_MAX,
  diagnosticsText,
  emptyDiagnostics,
  linkIsSilent,
  pairingLooksChanged,
  pushLog
} from '../src/shared/bridgeLink'

// pure link-health rules shared by the desktop bridge and the phone
test('a link is silent only after a full window without frames', () => {
  expect(linkIsSilent(null, 1_000_000, 60_000)).toBe(false)
  expect(linkIsSilent(1_000_000, 1_059_999, 60_000)).toBe(false)
  expect(linkIsSilent(1_000_000, 1_060_000, 60_000)).toBe(true)
})

test('refused sockets mean a changed pairing only while the relay itself answers', () => {
  expect(pairingLooksChanged({ refusedStreak: 2, undecryptable: 0, relayReachable: true })).toBe(false)
  expect(pairingLooksChanged({ refusedStreak: 3, undecryptable: 0, relayReachable: true })).toBe(true)
  // offline phone: every socket fails, but so does the relay — not a re-pair
  expect(pairingLooksChanged({ refusedStreak: 9, undecryptable: 0, relayReachable: false })).toBe(false)
  // frames under a key we don't hold are proof on their own
  expect(pairingLooksChanged({ refusedStreak: 0, undecryptable: 3, relayReachable: false })).toBe(true)
})

test('the connection log keeps the newest entries and copies as text', () => {
  const d = emptyDiagnostics('desktop')
  for (let i = 0; i < DIAG_LOG_MAX + 5; i++) pushLog(d.log, `entry ${i}`, i)
  expect(d.log).toHaveLength(DIAG_LOG_MAX)
  expect(d.log[0].msg).toBe('entry 5')
  d.lastClose = { code: 4001, reason: 'no frames for 40s — presumed dead', at: 0 }
  d.reconnects = 2
  const text = diagnosticsText(d, 10_000)
  expect(text).toContain('last close: 4001 no frames for 40s — presumed dead')
  expect(text).toContain('reconnects: 2')
  expect(text).toContain(`entry ${DIAG_LOG_MAX + 4}`)
})
