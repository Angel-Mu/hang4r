import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Multi-page build: the landing plus the blog (each post is its own
// pre-rendered HTML page for SEO — no client-side routing).
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        notFound: resolve(__dirname, '404.html'),
        blog: resolve(__dirname, 'blog/index.html'),
        postWorktrees: resolve(__dirname, 'blog/parallel-agents-git-worktrees/index.html'),
        postSubscription: resolve(__dirname, 'blog/your-subscription-is-the-api/index.html'),
        postReview: resolve(__dirname, 'blog/code-review-that-talks-back/index.html'),
        postOrchestrate: resolve(__dirname, 'blog/from-coder-to-conductor/index.html'),
        postBrowserEyes: resolve(__dirname, 'blog/agents-that-see-the-browser/index.html'),
        postV1: resolve(__dirname, 'blog/hang4r-1-0/index.html'),
        postHandoff: resolve(__dirname, 'blog/switch-agents-mid-session/index.html'),
        postIde: resolve(__dirname, 'blog/ide-around-the-agent/index.html'),
        postMobile: resolve(__dirname, 'blog/agents-in-your-pocket/index.html'),
        postSsh: resolve(__dirname, 'blog/agents-over-ssh/index.html'),
        postSubagents: resolve(__dirname, 'blog/watch-your-agents-agents/index.html')
      }
    }
  }
})
