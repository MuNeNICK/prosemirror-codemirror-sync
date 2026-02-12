import { useCallback, useMemo, useRef, useState } from 'react'
import { createViewBridge } from '@pm-cm/core'
import type { EditorView } from 'prosemirror-view'
import type { Transaction } from 'prosemirror-state'
import { AppHeader } from '../components/AppHeader'
import { MarkdownPane } from '../components/MarkdownPane'
import { WysiwygPane } from '../components/WysiwygPane'
import { markdownToProseMirrorDoc, normalizeMarkdown, proseMirrorDocToMarkdown } from '../lib/prosemirrorMarkdown'
import { prosemirrorSchema } from '../lib/prosemirrorSchema'

const INITIAL_MARKDOWN = `# Welcome to @pm-cm

A **ProseMirror** and **CodeMirror** bridge that keeps two editors in sync — edit Markdown on the left, see rich text on the right, and vice versa.

## Try it out

Type \`/\` in the Rich Text pane to open **slash commands** — insert headings, lists, tables, code blocks, and more.

### Features

- Real-time bidirectional sync between Markdown and Rich Text
- Format-agnostic cursor mapping via \`buildCursorMap\`
- Notion-style slash commands and block handles

> This is the **standalone** demo using \`@pm-cm/core\`. Switch to the **Collaborative** tab to see two clients sharing one document via Yjs.

### Task list

- [x] Bidirectional sync
- [x] Slash commands
- [ ] Your next feature

| Feature | Status |
| --- | --- |
| CM \u2194 PM sync | Done |
| Cursor mapping | Done |
| Yjs collab | See Collaborative tab |

\`\`\`ts
import { createViewBridge } from '@pm-cm/core'

const bridge = createViewBridge({
  schema, serialize, parse, normalize,
})
\`\`\`
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
      <AppHeader activePage="standalone" />
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
