import type { Hang4rApi } from '../shared/protocol'

declare global {
  interface Window {
    hang4r: Hang4rApi
  }
}

export {}
