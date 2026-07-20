/**
 * GET /download — 302 straight to the newest .dmg asset, so the landing's
 * Download button downloads immediately instead of parking users on the
 * GitHub releases page. Resolves the latest release via the GitHub API and
 * caches the asset URL for 5 minutes (survives version bumps — no hardcoded
 * filename anywhere).
 *
 * Every hit bumps a KV counter (stats:downloads in the WAITLIST namespace) so
 * we can tell landing-initiated downloads apart from GitHub's per-asset totals
 * (which also include Homebrew + direct GitHub). Counting rides waitUntil —
 * the redirect never waits on it. See /api/stats.
 */
interface Env {
  WAITLIST: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const fallback = 'https://github.com/Angel-Mu/hang4r-releases/releases/latest'
  ctx.waitUntil(
    (async () => {
      const cur = Number((await ctx.env.WAITLIST.get('stats:downloads')) ?? '0')
      await ctx.env.WAITLIST.put('stats:downloads', String(cur + 1))
    })().catch(() => {
      /* counting must never break the download */
    })
  )
  try {
    const res = await fetch(
      'https://api.github.com/repos/Angel-Mu/hang4r-releases/releases/latest',
      {
        headers: {
          'user-agent': 'hang4r.dev-download',
          accept: 'application/vnd.github+json'
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      } as RequestInit
    )
    if (res.ok) {
      const rel = (await res.json()) as {
        assets?: { name: string; browser_download_url: string }[]
      }
      const dmg = rel.assets?.find((a) => a.name.endsWith('.dmg'))
      if (dmg) {
        return new Response(null, {
          status: 302,
          headers: {
            location: dmg.browser_download_url,
            'cache-control': 'public, max-age=300'
          }
        })
      }
    }
  } catch {
    /* fall through to the releases page — never a dead button */
  }
  return Response.redirect(fallback, 302)
}
