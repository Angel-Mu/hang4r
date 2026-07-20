import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useHang4r } from './state/store'

// e2e reaches store actions that have no IPC/DOM path (e.g. requestOpenUrl,
// normally fired by a link click deep inside chat markdown)
;(window as unknown as { __hang4r_store: typeof useHang4r }).__hang4r_store = useHang4r

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
