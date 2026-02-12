import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from 'prosemirror-view'
import type { Transaction } from 'prosemirror-state'
import { applyUpdate, Doc } from 'yjs'
import type { Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import {
  createYjsBridge,
  cursorSyncPluginKey,
  syncCmCursor,
} from '@pm-cm/yjs'
import type { YjsBridgeHandle } from '@pm-cm/yjs'
import { AppHeader } from '../components/AppHeader'
import { MarkdownPane } from '../components/MarkdownPane'
import { WysiwygPane } from '../components/WysiwygPane'
import { markdownToProseMirrorDoc, normalizeMarkdown, proseMirrorDocToMarkdown } from '../lib/prosemirrorMarkdown'
import { prosemirrorSchema } from '../lib/prosemirrorSchema'

const INITIAL_MARKDOWN = `# Collaborative Editing

Two clients sharing one document in real time via **Yjs** CRDT.

## How it works

Each client pair below has its own \`Y.Doc\` — updates are synced automatically. Try editing in one client and watch the other update instantly.

- Cursors and selections are shared via **awareness protocol**
- The \`@pm-cm/yjs\` bridge keeps Markdown and Rich Text in sync on each client
- Type \`/\` in the Rich Text pane for slash commands

> Edit either client — both stay in sync through Yjs conflict-free replication.

| Client | Doc | Awareness |
| --- | --- | --- |
| Client 1 | Y.Doc 1 | Blue cursor |
| Client 2 | Y.Doc 2 | Green cursor |
`

const CROSS_SYNC = 'cross-sync'

type Client = {
  sharedText: YText
  sharedProseMirror: YXmlFragment
  awareness: Awareness
  bridge: YjsBridgeHandle
}

function CollabPair({ client, label }: { client: Client; label: string }) {
  const pmViewRef = useRef<EditorView | null>(null)
  const [cmScrollOffset, setCmScrollOffset] = useState<number | undefined>(undefined)

  const handlePmTransaction = useCallback((view: EditorView, _tr: Transaction) => {
    // Bridge sync is handled by bridgeSyncPlugin (runs before cursor sync plugin).
    // Just read the mapped offset for local CM scroll.
    const syncState = cursorSyncPluginKey.getState(view.state)
    if (syncState?.mappedTextOffset != null) {
      setCmScrollOffset(syncState.mappedTextOffset)
    }
  }, [])

  const handleCmCursorChange = useCallback((mdOffset: number) => {
    if (pmViewRef.current) syncCmCursor(pmViewRef.current, mdOffset)
  }, [])

  return (
    <div className="collab-client">
      <div className="client-label">{label}</div>
      <main className="editor-grid">
        <MarkdownPane
          sharedMarkdown={client.sharedText}
          awareness={client.awareness}
          scrollToOffset={cmScrollOffset}
          onCursorPositionChange={handleCmCursorChange}
        />
        <WysiwygPane
          initialText=""
          sharedProseMirror={client.sharedProseMirror}
          awareness={client.awareness}
          serialize={proseMirrorDocToMarkdown}
          sharedText={client.sharedText}
          bridge={client.bridge}
          onTransaction={handlePmTransaction}
          onViewReady={(v) => { pmViewRef.current = v }}
        />
      </main>
    </div>
  )
}

export function YjsPage() {
  const [clients, setClients] = useState<[Client, Client] | null>(null)

  useEffect(() => {
    const doc1 = new Doc()
    const doc2 = new Doc()

    // Cross-sync updates between two docs (simulates network)
    doc1.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== CROSS_SYNC) applyUpdate(doc2, update, CROSS_SYNC)
    })
    doc2.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== CROSS_SYNC) applyUpdate(doc1, update, CROSS_SYNC)
    })

    const awareness1 = new Awareness(doc1)
    const awareness2 = new Awareness(doc2)
    awareness1.setLocalStateField('user', { name: 'Client 1', color: '#30bced' })
    awareness2.setLocalStateField('user', { name: 'Client 2', color: '#6eeb83' })

    // Cross-sync awareness between two clients (simulates network)
    awareness1.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed)
      applyAwarenessUpdate(awareness2, encodeAwarenessUpdate(awareness1, changed), CROSS_SYNC)
    })
    awareness2.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed)
      applyAwarenessUpdate(awareness1, encodeAwarenessUpdate(awareness2, changed), CROSS_SYNC)
    })

    // Client 1 bootstraps the document
    const bridge1 = createYjsBridge(
      {
        doc: doc1,
        sharedText: doc1.getText('markdown'),
        sharedProseMirror: doc1.getXmlFragment('prosemirror'),
        schema: prosemirrorSchema,
        serialize: proseMirrorDocToMarkdown,
        parse: markdownToProseMirrorDoc,
        normalize: normalizeMarkdown,
      },
      { initialText: INITIAL_MARKDOWN },
    )

    // Client 2 joins (doc already synced via cross-sync)
    const bridge2 = createYjsBridge({
      doc: doc2,
      sharedText: doc2.getText('markdown'),
      sharedProseMirror: doc2.getXmlFragment('prosemirror'),
      schema: prosemirrorSchema,
      serialize: proseMirrorDocToMarkdown,
      parse: markdownToProseMirrorDoc,
      normalize: normalizeMarkdown,
    })

    setClients([
      { sharedText: doc1.getText('markdown'), sharedProseMirror: doc1.getXmlFragment('prosemirror'), awareness: awareness1, bridge: bridge1 },
      { sharedText: doc2.getText('markdown'), sharedProseMirror: doc2.getXmlFragment('prosemirror'), awareness: awareness2, bridge: bridge2 },
    ])

    return () => {
      bridge1.dispose()
      bridge2.dispose()
      awareness1.destroy()
      awareness2.destroy()
      doc1.destroy()
      doc2.destroy()
      setClients(null)
    }
  }, [])

  if (!clients) return null

  return (
    <div className="app-shell">
      <AppHeader activePage="yjs" />
      <div className="collab-clients-grid">
        <CollabPair client={clients[0]} label="Client 1" />
        <CollabPair client={clients[1]} label="Client 2" />
      </div>
    </div>
  )
}
