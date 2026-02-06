import { useCallback, useState } from 'react'
import { MarkdownPane } from './components/MarkdownPane'
import { WysiwygPane } from './components/WysiwygPane'
import type { SyncState, UpdateSource } from './types/editor'

const INITIAL_MARKDOWN = `# ProseMirror Split Editor

This demo lets you edit **Markdown** and **WYSIWYG** side by side.

## Features

- Real-time bidirectional sync
- Rich-text editing powered by ProseMirror + Unified
- CodeMirror-based Markdown editing

- [ ] Task 1
- [x] Task 2

| Column A | Column B |
| --- | --- |
| Cell A1 | Cell B1 |
`

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

  return (
    <div className="app-shell">
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
