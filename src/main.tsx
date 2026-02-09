import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Route, Switch, Router } from 'wouter'
import './index.css'
import { StandalonePage } from './pages/StandalonePage'
import { YjsPage } from './pages/YjsPage'

const base = import.meta.env.BASE_URL.replace(/\/$/, '')

function App() {
  return (
    <Router base={base}>
      <Switch>
        <Route path="/yjs" component={YjsPage} />
        <Route component={StandalonePage} />
      </Switch>
    </Router>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
