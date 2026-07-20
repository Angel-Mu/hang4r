import { useEffect, useRef, useState, type JSX } from 'react'
import { isDarkTheme, resolveTheme } from '../theme'
import { useHang4r } from '../state/store'

/**
 * Shared markdown block renderers for every Markdown surface (chat, subagent
 * threads, md preview): ```mermaid fences render as live diagrams, other
 * fenced code gets a consistent .md-code block.
 */

let mermaidSeq = 0

export function MermaidBlock({ code }: { code: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    setErr(false)
    void import('mermaid').then(async ({ default: mermaid }) => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkTheme(resolveTheme(useHang4r.getState().theme)) ? 'dark' : 'default'
        })
        const renderId = `hang4r-mmd-${++mermaidSeq}`
        try {
          const { svg } = await mermaid.render(renderId, code)
          if (alive && ref.current) ref.current.innerHTML = svg
        } finally {
          // a FAILED render leaves mermaid's temp element orphaned in body —
          // one per mid-stream partial diagram adds up (QA hunt 7)
          document.getElementById(renderId)?.remove()
          document.getElementById(`d${renderId}`)?.remove()
        }
      } catch {
        // mid-stream partial diagrams parse-fail constantly — fall back to code
        if (alive) setErr(true)
      }
    })
    return () => {
      alive = false
    }
  }, [code])
  if (err) {
    return (
      <pre className="md-code">
        <code>{code}</code>
      </pre>
    )
  }
  return <div className="mermaid-block" ref={ref} />
}

/** resolve a relative md link against the previewed file's directory (posix) */
function resolveRel(basePath: string | undefined, href: string): string {
  const baseDir = basePath?.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : ''
  const parts = (href.startsWith('/') ? href.slice(1) : `${baseDir}${baseDir ? '/' : ''}${href}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

/**
 * Safe `a` + `code` renderers for every markdown surface. CRITICAL: a plain
 * <a href> in the renderer NAVIGATES THE WHOLE APP WINDOW away (black screen,
 * no way back — Angel hit this ⌘-clicking a link in a rendered md). Links
 * must NEVER default-navigate: http(s) opens the Browser pane, relative
 * paths open in the editor, anchors are inert.
 */
const mdComponentsCache = new Map<
  string,
  { code: typeof MdCode; a: (p: { href?: string; children?: React.ReactNode }) => JSX.Element }
>()

export function mdComponents(
  sessionId: string,
  basePath?: string
): { code: typeof MdCode; a: (p: { href?: string; children?: React.ReactNode }) => JSX.Element } {
  // stable identity per (session, file): fresh component fns every render
  // would remount the whole rendered-markdown subtree on each re-render
  const key = `${sessionId}|${basePath ?? ''}`
  const cached = mdComponentsCache.get(key)
  if (cached) return cached
  const made = make(sessionId, basePath)
  mdComponentsCache.set(key, made)
  return made
}

/**
 * Route a `file://` href into the in-app editor. Agents link absolute paths;
 * anything under the session's working directory opens as an editor tab
 * (with :line support) instead of escaping to the OS browser as a raw
 * file:// URL (Angel hit that live). Returns false when the path lives
 * outside the workdir — the caller keeps its existing behavior.
 */
export function openFileHref(sessionId: string, href: string): boolean {
  const raw = decodeURIComponent(href.replace(/^file:\/\//, ''))
  const lm = /:(\d+)(?::\d+)?$/.exec(raw)
  const abs = lm ? raw.slice(0, lm.index) : raw
  const cwd = useHang4r.getState().sessions.find((s) => s.id === sessionId)?.cwd
  if (!cwd || !abs.startsWith(cwd + '/')) return false
  useHang4r
    .getState()
    .requestOpenFile(sessionId, abs.slice(cwd.length + 1), lm ? Number(lm[1]) : undefined)
  return true
}

function make(
  sessionId: string,
  basePath?: string
): { code: typeof MdCode; a: (p: { href?: string; children?: React.ReactNode }) => JSX.Element } {
  return {
    code: MdCode,
    a: ({ href, children }) => (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault()
          if (!href || href.startsWith('#')) return
          if (/^file:\/\//.test(href)) {
            if (!openFileHref(sessionId, href)) useHang4r.getState().requestOpenUrl(sessionId, href)
          } else if (/^https?:\/\//.test(href)) {
            useHang4r.getState().requestOpenUrl(sessionId, href)
          } else if (!/^[a-z]+:/.test(href)) {
            // relative link → open in the editor, resolved against this file
            const lm = /:(\d+)(?::\d+)?$/.exec(href)
            const clean = lm ? href.slice(0, lm.index) : href
            useHang4r.getState().requestOpenFile(sessionId, resolveRel(basePath, clean), lm ? Number(lm[1]) : undefined)
          }
        }}
      >
        {children}
      </a>
    )
  }
}

/**
 * `code` renderer for react-markdown: block code (has a language- class or
 * newlines) becomes a styled block — mermaid becomes a diagram; inline code
 * falls through to the default <code>.
 */
export function MdCode(props: {
  className?: string
  children?: React.ReactNode
}): JSX.Element {
  const { className, children } = props
  const text = String(children ?? '').replace(/\n$/, '')
  const lang = /language-([\w-]+)/.exec(className ?? '')?.[1]
  if (lang === 'mermaid') return <MermaidBlock code={text} />
  if (lang || text.includes('\n')) {
    return (
      <code className={'md-code-inner ' + (className ?? '')} data-lang={lang}>
        {children}
      </code>
    )
  }
  return <code className={className}>{children}</code>
}
