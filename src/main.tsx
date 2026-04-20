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

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
