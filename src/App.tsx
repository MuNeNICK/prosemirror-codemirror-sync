import { useCallback, useMemo, useState } from 'react'
import { MarkdownPane } from './components/MarkdownPane'
import { WysiwygPane } from './components/WysiwygPane'
import type { SyncState, UpdateSource } from './types/editor'

const INITIAL_MARKDOWN = `# ProseMirror Split Editor

このデモは **Markdown** と **WYSIWYG** を同時に編集できます。

## Features

- 双方向リアルタイム同期
- ProseMirror + Unified ベースのリッチテキスト編集
- Markdown 側は CodeMirror で編集

- [ ] タスク1
- [x] タスク2

| Column A | Column B |
| --- | --- |
| Cell A1 | Cell B1 |
`

function toSourceLabel(source: UpdateSource): string {
  switch (source) {
    case 'markdown':
      return 'Markdown Pane'
    case 'wysiwyg':
      return 'WYSIWYG Pane'
    default:
      return 'Initial'
  }
}

function App() {
  const [syncState, setSyncState] = useState<SyncState>({
    markdown: INITIAL_MARKDOWN,
    source: 'external',
    revision: 0,
  })

  const updateMarkdown = useCallback((nextMarkdown: string, source: UpdateSource) => {
    setSyncState((previousState) => {
      if (previousState.markdown === nextMarkdown) {
        return previousState
      }

      return {
        markdown: nextMarkdown,
        source,
        revision: previousState.revision + 1,
      }
    })
  }, [])

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      updateMarkdown(nextMarkdown, 'markdown')
    },
    [updateMarkdown],
  )

  const handleWysiwygChange = useCallback(
    (nextMarkdown: string) => {
      updateMarkdown(nextMarkdown, 'wysiwyg')
    },
    [updateMarkdown],
  )

  const statusText = useMemo(() => {
    return `Rev ${syncState.revision} - Last update: ${toSourceLabel(syncState.source)}`
  }, [syncState.revision, syncState.source])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Split Markdown / WYSIWYG Editor</h1>
          <p>ProseMirror + Unified + CodeMirror</p>
        </div>
        <span className="status-pill" aria-live="polite">
          {statusText}
        </span>
      </header>

      <main className="editor-grid">
        <MarkdownPane markdown={syncState.markdown} onChange={handleMarkdownChange} />
        <WysiwygPane
          markdown={syncState.markdown}
          onChange={handleWysiwygChange}
          source={syncState.source}
        />
      </main>
    </div>
  )
}

export default App
