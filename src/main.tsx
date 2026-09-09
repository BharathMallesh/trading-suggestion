import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App.tsx'
// keeps the llm shim (and thus the wllama worker chunk) in the build graph
// until Task 13 wires model loading into the app
import './llm/shim'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
