import { useCallback, useEffect, useRef, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import { createRelativePositionFromTypeIndex, Doc } from 'yjs'
import type { Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import { MarkdownPane } from './components/MarkdownPane'
import { WysiwygPane } from './components/WysiwygPane'
import { markdownToProseMirrorDoc, normalizeMarkdown, proseMirrorDocToMarkdown } from './lib/prosemirrorMarkdown'
import { prosemirrorSchema } from './lib/prosemirrorSchema'

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
const ORIGIN_MD_TO_PM = 'bridge:markdown-to-prosemirror'
const ORIGIN_PM_TO_MD = 'bridge:prosemirror-to-markdown'
const ORIGIN_INIT = 'bridge:init'
type CollabBindings = {
  sharedMarkdown: YText
  sharedProsemirror: YXmlFragment
  awareness: Awareness
}

const USER_COLORS = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#8acb88', light: '#8acb8833' },
]

function createLocalUser() {
  const color = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
  const name = `User ${Math.floor(Math.random() * 1000)}`
  return {
    name,
    color: color.color,
    colorLight: color.light,
  }
}

function toNormalizedMarkdown(text: string): string {
  return normalizeMarkdown(text)
}

function sharedProsemirrorToMarkdown(sharedProsemirror: YXmlFragment): string | null {
  try {
    const pmDoc = yXmlFragmentToProseMirrorRootNode(sharedProsemirror, prosemirrorSchema)
    return toNormalizedMarkdown(proseMirrorDocToMarkdown(pmDoc))
  } catch (error) {
    console.error('[bridge] failed to convert ProseMirror fragment to markdown', error)
    return null
  }
}

function replaceSharedMarkdown(sharedText: YText, nextMarkdown: string, origin: string): boolean {
  const next = toNormalizedMarkdown(nextMarkdown)
  const current = sharedText.toString()
  if (current === next) {
    return false
  }

  // Minimal diff: find common prefix and suffix, replace only the changed middle.
  let start = 0
  const minLen = Math.min(current.length, next.length)
  while (start < minLen && current.charCodeAt(start) === next.charCodeAt(start)) {
    start++
  }

  let endCurrent = current.length
  let endNext = next.length
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)) {
    endCurrent--
    endNext--
  }

  sharedText.doc?.transact(() => {
    const deleteCount = endCurrent - start
    if (deleteCount > 0) {
      sharedText.delete(start, deleteCount)
    }
    const insertStr = next.slice(start, endNext)
    if (insertStr.length > 0) {
      sharedText.insert(start, insertStr)
    }
  }, origin)

  return true
}

function replaceSharedProsemirror(
  doc: Doc,
  sharedProsemirror: YXmlFragment,
  markdown: string,
  origin: string,
): void {
  const nextDoc = markdownToProseMirrorDoc(toNormalizedMarkdown(markdown), prosemirrorSchema)

  doc.transact(() => {
    prosemirrorToYXmlFragment(nextDoc, sharedProsemirror)
  }, origin)
}

function App() {
  const sharedMarkdownRef = useRef<YText | null>(null)
  const [bindings, setBindings] = useState<CollabBindings | null>(null)
  const [cursorOffset, setCursorOffset] = useState<number | undefined>(undefined)
  const [cmCursorOffset, setCmCursorOffset] = useState<number | undefined>(undefined)
  const [activePane, setActivePane] = useState<'cm' | 'pm'>('cm')
  const awarenessRef = useRef<Awareness | null>(null)

  const handleCmCursorPositionChange = useCallback((mdOffset: number) => {
    setCmCursorOffset(mdOffset)
    setActivePane('cm')
  }, [])

  const handleCursorPositionChange = useCallback((mdOffset: number) => {
    setCursorOffset(mdOffset)
    setActivePane('pm')

    const sharedMarkdown = sharedMarkdownRef.current
    const awareness = awarenessRef.current
    if (!sharedMarkdown || !awareness) return

    const anchor = createRelativePositionFromTypeIndex(sharedMarkdown, mdOffset)
    awareness.setLocalStateField('cursor', { anchor, head: anchor })
  }, [])

  const handleWysiwygMarkdownChange = useCallback((nextMarkdown: string) => {
    const sharedMarkdown = sharedMarkdownRef.current
    if (!sharedMarkdown) {
      return
    }

    replaceSharedMarkdown(sharedMarkdown, nextMarkdown, ORIGIN_PM_TO_MD)
  }, [])

  useEffect(() => {
    const doc = new Doc()
    const sharedMarkdown = doc.getText('markdown')
    const sharedProsemirror = doc.getXmlFragment('prosemirror')
    const persistence = new IndexeddbPersistence(YJS_DOC_NAME, doc)
    const ws = new WebsocketProvider('ws://localhost:1234', YJS_DOC_NAME, doc)
    let lastBridgedMarkdown: string | null = null

    sharedMarkdownRef.current = sharedMarkdown
    awarenessRef.current = ws.awareness
    ws.awareness.setLocalStateField('user', createLocalUser())

    const syncMarkdownToProsemirror = (origin: string) => {
      const markdown = toNormalizedMarkdown(sharedMarkdown.toString())
      if (lastBridgedMarkdown === markdown) {
        return
      }

      replaceSharedProsemirror(doc, sharedProsemirror, markdown, origin)
      lastBridgedMarkdown = markdown
    }
    const bootstrap = () => {
      const markdown = toNormalizedMarkdown(sharedMarkdown.toString())
      const hasMarkdown = markdown.length > 0
      const hasProsemirror = sharedProsemirror.length > 0

      if (!hasMarkdown && !hasProsemirror) {
        replaceSharedMarkdown(sharedMarkdown, INITIAL_MARKDOWN, ORIGIN_INIT)
        replaceSharedProsemirror(doc, sharedProsemirror, INITIAL_MARKDOWN, ORIGIN_INIT)
        lastBridgedMarkdown = toNormalizedMarkdown(INITIAL_MARKDOWN)
        return
      }

      if (hasMarkdown && !hasProsemirror) {
        syncMarkdownToProsemirror(ORIGIN_INIT)
        return
      }

      if (!hasMarkdown && hasProsemirror) {
        const markdownFromProsemirror = sharedProsemirrorToMarkdown(sharedProsemirror)
        if (markdownFromProsemirror !== null) {
          replaceSharedMarkdown(sharedMarkdown, markdownFromProsemirror, ORIGIN_INIT)
          lastBridgedMarkdown = toNormalizedMarkdown(markdownFromProsemirror)
        }
        return
      }

      const prosemirrorMarkdown = sharedProsemirrorToMarkdown(sharedProsemirror)
      if (prosemirrorMarkdown === null) {
        const fallbackMarkdown = hasMarkdown ? markdown : INITIAL_MARKDOWN
        replaceSharedMarkdown(sharedMarkdown, fallbackMarkdown, ORIGIN_INIT)
        replaceSharedProsemirror(doc, sharedProsemirror, fallbackMarkdown, ORIGIN_INIT)
        return
      }

      if (prosemirrorMarkdown !== markdown) {
        syncMarkdownToProsemirror(ORIGIN_INIT)
      } else {
        lastBridgedMarkdown = markdown
      }
    }

    const markdownObserver = (
      _: unknown,
      transaction: {
        origin: unknown
        local: boolean
      },
    ) => {
      if (transaction.origin === ORIGIN_PM_TO_MD || transaction.origin === ORIGIN_INIT) {
        return
      }

      // Only the client that authored markdown edits runs the bridge conversion.
      if (!transaction.local) {
        return
      }

      syncMarkdownToProsemirror(ORIGIN_MD_TO_PM)
    }

    sharedMarkdown.observe(markdownObserver)

    let disposed = false

    void persistence.whenSynced.then(() => {
      if (disposed) {
        return
      }

      bootstrap()
      setBindings({
        sharedMarkdown,
        sharedProsemirror,
        awareness: ws.awareness,
      })
    })

    return () => {
      disposed = true
      sharedMarkdown.unobserve(markdownObserver)
      ws.destroy()
      persistence.destroy()
      doc.destroy()
      sharedMarkdownRef.current = null
      awarenessRef.current = null
      setBindings(null)
    }
  }, [])

  if (!bindings) {
    return null
  }

  return (
    <div className="app-shell">
      <main className={`editor-grid editor-grid--${activePane}-active`}>
        <MarkdownPane sharedMarkdown={bindings.sharedMarkdown} awareness={bindings.awareness} scrollToOffset={cursorOffset} onCursorPositionChange={handleCmCursorPositionChange} />
        <WysiwygPane
          sharedProsemirror={bindings.sharedProsemirror}
          awareness={bindings.awareness}
          initialMarkdown={INITIAL_MARKDOWN}
          onLocalMarkdownChange={handleWysiwygMarkdownChange}
          onCursorPositionChange={handleCursorPositionChange}
          cmCursorOffset={cmCursorOffset}
        />
      </main>
    </div>
  )
}

export default App
