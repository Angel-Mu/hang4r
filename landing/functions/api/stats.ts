/**
 * GET /api/stats — download numbers, one JSON blob:
 *   landingDownloads  — hits on hang4r.dev/download (KV counter, since 2026-07-17)
 *   githubAssets      — GitHub's per-asset download_count across ALL releases
 *                       (ground truth; includes Homebrew + direct GitHub traffic)
 *   githubTotalDmg    — sum of the .dmg asset counts (the headline number)
 * Public on purpose: everything here is already public via the GitHub API.
 */
interface Env {
  WAITLIST: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const landingDownloads = Number((await ctx.env.WAITLIST.get('stats:downloads')) ?? '0')
  let githubAssets: { tag: string; asset: string; downloads: number }[] = []
  try {
    const res = await fetch('https://api.github.com/repos/Angel-Mu/hang4r-releases/releases', {
      headers: {
        'user-agent': 'hang4r.dev-stats',
        accept: 'application/vnd.github+json'
      },
      cf: { cacheTtl: 300, cacheEverything: true }
    } as RequestInit)
    if (res.ok) {
      const rels = (await res.json()) as {
        tag_name: string
        assets?: { name: string; download_count: number }[]
      }[]
      githubAssets = rels.flatMap((r) =>
        (r.assets ?? []).map((a) => ({ tag: r.tag_name, asset: a.name, downloads: a.download_count }))
      )
    }
  } catch {
    /* GitHub down → still return the landing counter */
  }
  const githubTotalDmg = githubAssets
    .filter((a) => a.asset.endsWith('.dmg'))
    .reduce((n, a) => n + a.downloads, 0)
  return Response.json(
    { landingDownloads, githubTotalDmg, githubAssets },
    { headers: { 'cache-control': 'public, max-age=60' } }
  )
}
