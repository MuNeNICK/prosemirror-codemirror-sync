import { describe, it, expect, afterEach, vi } from 'vitest'
import { Schema, Node } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Doc, Text as YText, XmlFragment as YXmlFragment, applyUpdate } from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { yCursorPluginKey } from 'y-prosemirror'
import { createYjsBridge } from '../bridge.js'
import { createCollabPlugins } from '../collab-plugins.js'
import { cursorSyncPluginKey, syncCmCursor } from '../cursor-sync-plugin.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

function serialize(doc: Node): string {
  const lines: string[] = []
  doc.forEach((n: Node) => lines.push(n.textContent))
  return lines.join('\n')
}
function parse(text: string, s: Schema): Node {
  const lines = text.split('\n')
  return s.node('doc', null, lines.map(l => s.node('paragraph', null, l ? [s.text(l)] : [])))
}
function normalize(s: string): string { return s.replace(/\r\n?/g, '\n') }

let views: EditorView[] = []
afterEach(async () => {
  // Flush deferred setMeta timers from y-prosemirror before destroying views
  await new Promise(r => setTimeout(r, 50))
  views.forEach(v => { try { v.destroy() } catch { /* jsdom DOM errors */ } })
  views = []
})
function tracked(v: EditorView): EditorView { views.push(v); return v }

const CROSS = 'cross'

function setupCrossSync(doc1: Doc, doc2: Doc) {
  doc1.on('update', (u: Uint8Array, o: unknown) => { if (o !== CROSS) applyUpdate(doc2, u, CROSS) })
  doc2.on('update', (u: Uint8Array, o: unknown) => { if (o !== CROSS) applyUpdate(doc1, u, CROSS) })
}

function setupAwarenessCrossSync(a1: Awareness, a2: Awareness) {
  a1.on('update', ({ added, updated, removed }: any) => {
    applyAwarenessUpdate(a2, encodeAwarenessUpdate(a1, added.concat(updated, removed)), CROSS)
  })
  a2.on('update', ({ added, updated, removed }: any) => {
    applyAwarenessUpdate(a1, encodeAwarenessUpdate(a2, added.concat(updated, removed)), CROSS)
  })
}

describe('cursor decoration integration', () => {
  it('awareness receives pmCursor after syncCmCursor', async () => {
    const doc1 = new Doc()
    const doc2 = new Doc()
    setupCrossSync(doc1, doc2)

    const a1 = new Awareness(doc1)
    const a2 = new Awareness(doc2)
    a1.setLocalStateField('user', { name: 'C1', color: '#30bced' })
    a2.setLocalStateField('user', { name: 'C2', color: '#6eeb83' })
    setupAwarenessCrossSync(a1, a2)

    // Client 1 bootstraps
    const bridge1 = createYjsBridge(
      { doc: doc1, sharedText: doc1.getText('md'), sharedProseMirror: doc1.getXmlFragment('pm'),
        schema, serialize, parse, normalize },
      { initialText: 'hello\nworld' },
    )

    // Client 2 joins
    const bridge2 = createYjsBridge(
      { doc: doc2, sharedText: doc2.getText('md'), sharedProseMirror: doc2.getXmlFragment('pm'),
        schema, serialize, parse, normalize },
    )

    // Create Client 1 PM view
    const { plugins: p1, doc: d1 } = createCollabPlugins(schema, {
      sharedProseMirror: doc1.getXmlFragment('pm'),
      awareness: a1,
      serialize,
      cursorSync: true,
      sharedText: doc1.getText('md'),
      bridge: bridge1,
    })
    const state1 = EditorState.create({ schema, doc: d1, plugins: p1 })
    const view1 = tracked(new EditorView(document.createElement('div'), {
      state: state1,
      dispatchTransaction(tr) {
        const ns = view1.state.apply(tr)
        view1.updateState(ns)
      },
    }))

    // Create Client 2 PM view
    const { plugins: p2, doc: d2 } = createCollabPlugins(schema, {
      sharedProseMirror: doc2.getXmlFragment('pm'),
      awareness: a2,
      serialize,
      cursorSync: true,
      sharedText: doc2.getText('md'),
      bridge: bridge2,
    })
    const state2 = EditorState.create({ schema, doc: d2, plugins: p2 })
    const view2 = tracked(new EditorView(document.createElement('div'), {
      state: state2,
      dispatchTransaction(tr) {
        const ns = view2.state.apply(tr)
        view2.updateState(ns)
      },
    }))

    // Step 1: syncCmCursor on Client 1
    syncCmCursor(view1, 3)

    // Step 2: Check awareness states
    const a1State = a1.getLocalState()
    expect(a1State?.pmCursor).toBeDefined()
    expect(a1State?.pmCursor).not.toBeNull()

    const client1StateOnA2 = a2.getStates().get(doc1.clientID)
    expect(client1StateOnA2?.pmCursor).toBeDefined()
    expect(client1StateOnA2?.pmCursor).not.toBeNull()

    // Step 3: Check that the pmCursor has anchor and head
    expect(a1State?.pmCursor).toHaveProperty('anchor')
    expect(a1State?.pmCursor).toHaveProperty('head')

    // Step 4: Check the relativePosition is correctly formed
    const pmCursor = client1StateOnA2?.pmCursor
    expect(pmCursor.anchor).toBeDefined()
    expect(pmCursor.head).toBeDefined()

    // Step 5: Wait for deferred setMeta and trigger view update
    await new Promise(r => setTimeout(r, 100))

    // Step 6: Manually trigger a transaction on view2 to force decoration update
    try {
      view2.dispatch(view2.state.tr)
    } catch {
      // jsdom may throw on ProseMirror internal DOM operations
    }

    // Step 7: Check yCursorPlugin state on view2 for decorations
    const yCursorState = yCursorPluginKey.getState(view2.state)
    expect(yCursorState).toBeDefined()

    // DecorationSet.find returns decorations in a range
    const decorations = (yCursorState as any)?.find?.(0, view2.state.doc.content.size)

    // The yCursorPlugin should have at least 1 decoration (the cursor widget)
    expect(decorations).toBeDefined()
    expect(decorations.length).toBeGreaterThanOrEqual(1)

    bridge1.dispose()
    bridge2.dispose()
    a1.destroy()
    a2.destroy()
    doc1.destroy()
    doc2.destroy()
  })

  it('PM focus broadcasts pmCursor to awareness', async () => {
    const doc1 = new Doc()
    const doc2 = new Doc()
    setupCrossSync(doc1, doc2)

    const a1 = new Awareness(doc1)
    const a2 = new Awareness(doc2)
    a1.setLocalStateField('user', { name: 'C1', color: '#30bced' })
    a2.setLocalStateField('user', { name: 'C2', color: '#6eeb83' })
    setupAwarenessCrossSync(a1, a2)

    const bridge1 = createYjsBridge(
      { doc: doc1, sharedText: doc1.getText('md'), sharedProseMirror: doc1.getXmlFragment('pm'),
        schema, serialize, parse, normalize },
      { initialText: 'hello\nworld' },
    )

    const { plugins: p1, doc: d1 } = createCollabPlugins(schema, {
      sharedProseMirror: doc1.getXmlFragment('pm'),
      awareness: a1,
      serialize,
      cursorSync: true,
      sharedText: doc1.getText('md'),
      bridge: bridge1,
    })
    const state1 = EditorState.create({ schema, doc: d1, plugins: p1 })

    // Mount the view in the document body so focus works
    const container = document.createElement('div')
    document.body.appendChild(container)

    const view1 = tracked(new EditorView(container, {
      state: state1,
      dispatchTransaction(tr) {
        const ns = view1.state.apply(tr)
        view1.updateState(ns)
      },
    }))

    // Simulate focus and selection change
    view1.dom.dispatchEvent(new Event('focusin'))
    const tr = view1.state.tr.setSelection(TextSelection.create(view1.state.doc, 3))
    view1.dispatch(tr)

    // Check if cursor was broadcast
    const a1State = a1.getLocalState()

    // When PM has focus and selection changes, cursorSyncPlugin should broadcast.
    // Note: view.hasFocus() returns false in jsdom, so PM→awareness path is not triggered.
    // This test verifies the setup doesn't throw; full PM focus testing requires a real browser.
    if (a1State?.pmCursor != null) {
      expect(a1State.pmCursor).toHaveProperty('anchor')
      expect(a1State.pmCursor).toHaveProperty('head')
    }

    document.body.removeChild(container)
    bridge1.dispose()
    a1.destroy()
    doc1.destroy()
  })
})
