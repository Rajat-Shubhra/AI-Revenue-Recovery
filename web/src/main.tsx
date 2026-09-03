import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Placeholder so the dev server has a real React entry to compile. The
// dashboard (Blueprint 4.10) replaces this.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <h1>Failed-Subscription Recovery Agent</h1>
  </StrictMode>,
)
