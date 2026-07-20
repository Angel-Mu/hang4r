import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches render/lifecycle exceptions so a single bad component can't white-
 * screen the whole app. Before this existed, any thrown error (e.g. a malformed
 * transcript state after an error_during_execution turn) unmounted the entire
 * React tree, and the ONLY recovery was quitting + reopening the app (Angel hit
 * exactly this). Now:
 *   - variant="app"  → full-window recoverable fallback with a Reload button
 *   - variant="tile" → contained per-session fallback; the app + other sessions
 *                      keep working, and Retry re-renders just this tile.
 * `resetKey` clears a caught error when it changes (e.g. a pane's session id),
 * so a fresh subtree gets a clean render.
 */
interface Props {
  children: ReactNode
  variant?: 'app' | 'tile'
  resetKey?: string
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // a breadcrumb in the console — a render crash used to be a silent white screen
    console.error('[hang4r] UI error caught by boundary:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    // a session switch / prop change clears a stale error so the new subtree renders
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  private reload = (): void => window.location.reload()
  private retry = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.variant === 'tile') {
      return (
        <div className="tile-error">
          <div className="tile-error-title">⚠ This session hit a display error</div>
          <div className="tile-error-msg">{error.message || String(error)}</div>
          <div className="tile-error-actions">
            <button className="ghost-btn" onClick={this.retry}>
              Retry
            </button>
            <button className="ghost-btn" onClick={this.reload}>
              Reload window
            </button>
          </div>
          <div className="tile-error-hint">
            Your other sessions are unaffected. Nothing is lost — your files and git history are on disk.
          </div>
        </div>
      )
    }

    return (
      <div className="app-error">
        <div className="app-error-box">
          <div className="app-error-title">hang4r hit a display error</div>
          <div className="app-error-msg">{error.message || String(error)}</div>
          <button className="app-error-reload" onClick={this.reload}>
            Reload
          </button>
          <div className="app-error-hint">
            This only reloads the window — your sessions, files, and git history are safe.
          </div>
        </div>
      </div>
    )
  }
}
