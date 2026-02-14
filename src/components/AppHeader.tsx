import { Moon, Sun } from 'lucide-react'
import { useTheme } from './ThemeProvider'

type AppHeaderProps = {
  activePage: 'standalone' | 'yjs'
}

export function AppHeader({ activePage }: AppHeaderProps) {
  const { theme, toggleTheme } = useTheme()

  return (
    <header className="app-header">
      <span className="app-header__brand">@pm-cm</span>
      <nav className="app-header__nav">
        <a
          href={import.meta.env.BASE_URL}
          className={`app-header__link${activePage === 'standalone' ? ' is-active' : ''}`}
        >
          Standalone
        </a>
        <a
          href={`${import.meta.env.BASE_URL}yjs.html`}
          className={`app-header__link${activePage === 'yjs' ? ' is-active' : ''}`}
        >
          Collaborative
        </a>
      </nav>
      <button
        type="button"
        className="app-header__theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      >
        {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
      </button>
    </header>
  )
}
