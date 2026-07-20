/// <reference types="vite/client" />

// Electron <webview> tag used by the embedded browser pane.
// Module augmentation (not a global namespace) so React's own types stay intact.
import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
        },
        HTMLElement
      >
    }
  }
}
