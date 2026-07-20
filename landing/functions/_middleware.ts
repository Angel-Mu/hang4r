/**
 * Host canonicalization: hang4r.dev is THE hostname. www and the bare
 * .pages.dev alias 301 to it so search engines see one site, not three.
 * Deployment-specific preview URLs (<hash>.hang4r.pages.dev) stay reachable
 * for testing.
 */
const CANONICAL_HOST = 'hang4r.dev'
const REDIRECT_HOSTS = new Set(['www.hang4r.dev', 'hang4r.pages.dev'])

export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url)
  if (REDIRECT_HOSTS.has(url.hostname)) {
    url.hostname = CANONICAL_HOST
    url.protocol = 'https:'
    return Response.redirect(url.toString(), 301)
  }
  return next()
}
