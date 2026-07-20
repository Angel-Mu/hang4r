/**
 * HTML preview helper. A srcdoc <iframe> inherits the app's CSP
 * (script-src 'self'), so inline scripts in previewed pages can never run.
 * A <webview> guest has its own origin and CSP — feed it the document as a
 * base64 data: URL and pages "pre-render" like a real browser tab.
 */
export function htmlDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:text/html;charset=utf-8;base64,${btoa(bin)}`
}
