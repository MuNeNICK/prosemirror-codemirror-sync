import { useCallback, useMemo, useRef, useState } from 'react'
import { createViewBridge } from '@pm-cm/core'
import type { EditorView } from 'prosemirror-view'
import type { Transaction } from 'prosemirror-state'
import { MarkdownPane } from '../components/MarkdownPane'
import { WysiwygPane } from '../components/WysiwygPane'
import { markdownToProseMirrorDoc, normalizeMarkdown, proseMirrorDocToMarkdown } from '../lib/prosemirrorMarkdown'
import { prosemirrorSchema } from '../lib/prosemirrorSchema'

const INITIAL_MARKDOWN = `# Standalone Demo

**@pm-cm/core** bridge: CM↔PM sync. See also the [Yjs collaborative editing demo](/yjs) where two clients share one document in real time.

Type \`/\` in the WYSIWYG pane to open Notion-like slash commands — insert headings, lists, tables, code blocks, quotes, and more.

- [ ] Task 1
- [x] Task 2

| A | B |
| --- | --- |
| 1 | 2 |
`

export function StandalonePage() {
  const pmViewRef = useRef<EditorView | null>(null)
  const [markdown, setMarkdown] = useState(INITIAL_MARKDOWN)

  const bridge = useMemo(() => createViewBridge({
    schema: prosemirrorSchema,
    serialize: proseMirrorDocToMarkdown,
    parse: markdownToProseMirrorDoc,
    normalize: normalizeMarkdown,
  }), [])

  // CM onChange → apply to PM
  const handleCmChange = useCallback((md: string) => {
    if (pmViewRef.current) {
      bridge.applyText(pmViewRef.current, md)
    }
  }, [bridge])

  // PM dispatchTransaction → extract to CM
  const handlePmTransaction = useCallback((view: EditorView, tr: Transaction) => {
    if (tr.docChanged && !bridge.isBridgeChange(tr)) {
      setMarkdown(bridge.extractText(view))
    }
  }, [bridge])

  return (
    <div className="app-shell">
      <main className="editor-grid">
        <MarkdownPane value={markdown} onChange={handleCmChange} />
        <WysiwygPane
          initialText={INITIAL_MARKDOWN}
          onTransaction={handlePmTransaction}
          onViewReady={(v) => { pmViewRef.current = v }}
        />
      </main>
    </div>
  )
}
