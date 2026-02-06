import { useCallback, useEffect, useRef, useState } from 'react'
import { MarkdownPane } from './components/MarkdownPane'
import { WysiwygPane } from './components/WysiwygPane'
import type { SyncState, UpdateSource } from './types/editor'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'
import { Doc } from 'yjs'

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

const YJS_DOC_NAME = 'prosemirror-split-editor'

function isUpdateSource(value: unknown): value is UpdateSource {
  return value === 'markdown' || value === 'wysiwyg' || value === 'external'
}

function replaceSharedMarkdown(sharedText: ReturnType<Doc['getText']>, nextMarkdown: string, source: UpdateSource) {
  const currentMarkdown = sharedText.toString()
  if (currentMarkdown === nextMarkdown) {
    return false
  }

  sharedText.doc?.transact(() => {
    sharedText.delete(0, currentMarkdown.length)
    sharedText.insert(0, nextMarkdown)
  }, source)

  return true
}

function App() {
  const sharedMarkdownRef = useRef<ReturnType<Doc['getText']> | null>(null)

  const [syncState, setSyncState] = useState<SyncState>({
    markdown: INITIAL_MARKDOWN,
    source: 'external',
    revision: 0,
  })

  useEffect(() => {
    const doc = new Doc()
    const sharedMarkdown = doc.getText('markdown')
    const persistence = new IndexeddbPersistence(YJS_DOC_NAME, doc)
    const rtc = new WebrtcProvider(YJS_DOC_NAME, doc)

    sharedMarkdownRef.current = sharedMarkdown

    const applyFromSharedText = (source: UpdateSource) => {
      const nextMarkdown = sharedMarkdown.toString()

      setSyncState((previousState) => {
        if (previousState.markdown === nextMarkdown && previousState.source === source) {
          return previousState
        }

        return {
          markdown: nextMarkdown,
          source,
          revision: previousState.revision + 1,
        }
      })
    }

    const observer = (_: unknown, transaction: { origin: unknown }) => {
      const source = isUpdateSource(transaction.origin) ? transaction.origin : 'external'
      applyFromSharedText(source)
    }

    sharedMarkdown.observe(observer)

    let disposed = false

    void persistence.whenSynced.then(() => {
      if (disposed) {
        return
      }

      // Keep the local template until the shared document has content.
      // This avoids duplicate template inserts when multiple clients start together.
      if (sharedMarkdown.length > 0) {
        applyFromSharedText('external')
      }
    })

    return () => {
      disposed = true
      sharedMarkdown.unobserve(observer)
      rtc.destroy()
      persistence.destroy()
      doc.destroy()
      sharedMarkdownRef.current = null
    }
  }, [])

  const updateMarkdown = useCallback((nextMarkdown: string, source: UpdateSource) => {
    const sharedMarkdown = sharedMarkdownRef.current
    if (!sharedMarkdown) {
      return
    }

    replaceSharedMarkdown(sharedMarkdown, nextMarkdown, source)
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
