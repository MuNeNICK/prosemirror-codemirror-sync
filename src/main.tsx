import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from './components/ThemeProvider'
import { StandalonePage } from './pages/StandalonePage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <StandalonePage />
    </ThemeProvider>
  </StrictMode>,
)
