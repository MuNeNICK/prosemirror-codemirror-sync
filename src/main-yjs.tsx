import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { YjsPage } from './pages/YjsPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <YjsPage />
  </StrictMode>,
)
