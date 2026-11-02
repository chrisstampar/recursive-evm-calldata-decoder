import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/** Global Tailwind + base styles before `App` (Vite still bundles correctly if order changes). */
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason)
  if (!import.meta.env.DEV) {
    // Production: send `event.reason` to your error reporting pipeline if you add one.
  }
})

const rootEl = document.getElementById('root')
if (!(rootEl instanceof HTMLElement)) {
  throw new Error('Root element #root not found or not an HTMLElement')
}

if (import.meta.env.DEV) {
  console.log('Dev mode — React StrictMode enabled')
}

/**
 * Clickjacking guard. `frame-ancestors` cannot be set from a <meta> CSP and IPFS gateways don't let us set headers,
 * so refuse to render inside a frame: a hostile page could overlay this decoder's trusted-looking output.
 */
function isFramed(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true // cross-origin parent
  }
}

if (isFramed()) {
  createRoot(rootEl).render(
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#f3f4f6' }}>
      This decoder can't be used inside another page.{' '}
      <a href={window.location.href} target="_blank" rel="noopener noreferrer" style={{ color: '#93c5fd' }}>
        Open it directly
      </a>
      .
    </div>,
  )
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
