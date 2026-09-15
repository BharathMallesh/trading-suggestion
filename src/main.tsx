import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App.tsx'
import { AuthGate } from './auth/AuthGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
