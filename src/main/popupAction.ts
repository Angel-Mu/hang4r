/**
 * What to do when a page inside the embedded browser asks for a window.
 *
 * A link with target="_blank" wants a tab. A window.open() with features is
 * almost always an auth popup, and those finish by talking back through
 * window.opener — a tab has none, so converting one leaves the login hanging
 * (Angel got stuck signing in). Chromium's disposition tells the two apart.
 */
export type PopupAction = 'tab' | 'window' | 'ignore'

export function popupAction(url: string, disposition: string): PopupAction {
  if (!/^https?:\/\//i.test(url)) return 'ignore'
  return disposition === 'new-window' ? 'window' : 'tab'
}
