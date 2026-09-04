import { test, expect } from '@playwright/test'
import { popupAction } from '../src/main/popupAction'

/**
 * Angel: "the hang4r browser didnt follow a redirect and got stuck when logging
 * in on a session for a browser."
 *
 * v1.0.155 turned every window request into a tab. A sign-in popup finishes by
 * talking back through window.opener, and a tab has none — so the flow hangs
 * with the login apparently stalled mid-redirect.
 */
test('a target=_blank link becomes a tab', () => {
  expect(popupAction('https://example.com/docs', 'foreground-tab')).toBe('tab')
  expect(popupAction('https://example.com/docs', 'background-tab')).toBe('tab')
})

test('an auth popup stays a real window, so window.opener survives', () => {
  expect(popupAction('https://accounts.google.com/o/oauth2/auth', 'new-window')).toBe('window')
})

test('a non-web scheme is left alone rather than opened', () => {
  // mailto:, custom app schemes, javascript: — none of these belong in a tab
  expect(popupAction('mailto:someone@example.com', 'foreground-tab')).toBe('ignore')
  expect(popupAction('myapp://callback?code=1', 'new-window')).toBe('ignore')
})
