import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Route, Switch } from 'wouter'
import './index.css'
import { StandalonePage } from './pages/StandalonePage'
import { YjsPage } from './pages/YjsPage'

function App() {
  return (
    <Switch>
      <Route path="/yjs" component={YjsPage} />
      <Route component={StandalonePage} />
    </Switch>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
