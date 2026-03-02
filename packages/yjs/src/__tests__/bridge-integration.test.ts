/**
 * Integration tests: real Y.Doc + bridge + ySyncPlugin + bridgeSyncPlugin.
 *
 * These tests verify end-to-end behavior when external Y.Text changes
 * (simulating a CodeMirror edit) interact with local ProseMirror edits.
 *
 * Specifically, they test whether:
 * 1. A user edit in PM persists after an external Y.Text change has been
 *    bridged to Y.XmlFragment (and ySyncPlugin has pending changes).
 * 2. Select-all + delete followed by typing propagates correctly.
 * 3. Y.Text is updated when a user edits PM while ySyncPlugin has pending changes.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState, TextSelection, AllSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import * as Y from 'yjs'
import { createYjsBridge } from '../bridge.js'
import { createCollabPlugins } from '../collab-plugins.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

function serialize(doc: Node): string {
  const lines: string[] = []
  doc.forEach((node: Node) => lines.push(node.textContent))
  return lines.join('\n')
}

function parse(text: string) {
  const paragraphs = text.split('\n').map((line) =>
    schema.node('paragraph', null, line ? [schema.text(line)] : []),
  )
  return schema.node('doc', null, paragraphs.length > 0 ? paragraphs : [schema.node('paragraph')])
}

/** Flush any pending ySyncPlugin changes by pumping a microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Setup {
  ydoc: Y.Doc
  view: EditorView
  destroy: () => void
}

function setup(initialText?: string, bridgeOpts?: { skipOrigins?: Set<unknown> }): Setup {
  const ydoc = new Y.Doc()
  const sharedText = ydoc.getText('text')
  const sharedProseMirror = ydoc.getXmlFragment('prosemirror')

  if (initialText) {
    sharedText.insert(0, initialText)
  }

  const bridge = createYjsBridge({
    doc: ydoc,
    sharedText,
    sharedProseMirror,
    schema,
    serialize,
    parse,
    ...bridgeOpts,
  })

  const { plugins, doc } = createCollabPlugins(schema, {
    sharedProseMirror,
    awareness: {
      clientID: 1,
      getLocalState: () => ({}),
      setLocalStateField: () => {},
      getStates: () => new Map(),
      on: () => {},
      off: () => {},
    } as any,
    bridge,
    sharedText,
  })

  const state = EditorState.create({ schema, doc, plugins })
  const view = new EditorView(document.createElement('div'), { state })

  return {
    ydoc,
    view,
    destroy: () => {
      view.destroy()
      bridge.dispose()
    },
  }
}

const setups: Setup[] = []
afterEach(() => {
  setups.forEach((s) => s.destroy())
  setups.length = 0
})

function tracked(s: Setup): Setup {
  setups.push(s)
  return s
}

describe('bridge integration: external Y.Text change + local PM edit', () => {
  it('user edit in PM persists and syncs to Y.Text after external Y.Text change', async () => {
    const { ydoc, view } = tracked(setup('hello'))
    const sharedText = ydoc.getText('text')

    expect(view.state.doc.textContent).toBe('hello')
    expect(sharedText.toString()).toBe('hello')

    // Simulate external CM edit: append " world" to Y.Text
    sharedText.insert(sharedText.length, ' world')

    // Wait for ySyncPlugin to process the Y.XmlFragment change from bridge
    await flush()

    // PM should now show "hello world"
    expect(view.state.doc.textContent).toBe('hello world')
    expect(sharedText.toString()).toBe('hello world')

    // Now simulate user typing "!" at end of PM
    const endPos = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.insertText('!', endPos))

    await flush()

    // User edit must persist in PM and propagate to Y.Text
    expect(view.state.doc.textContent).toBe('hello world!')
    expect(sharedText.toString()).toBe('hello world!')
  })

  it('select-all + delete + type propagates to Y.Text', async () => {
    const { ydoc, view } = tracked(setup('hello'))
    const sharedText = ydoc.getText('text')

    expect(view.state.doc.textContent).toBe('hello')

    // Select all and delete
    const allSel = new AllSelection(view.state.doc)
    view.dispatch(view.state.tr.setSelection(allSel).deleteSelection())

    await flush()

    // PM should be empty (single empty paragraph)
    expect(view.state.doc.textContent).toBe('')

    // Type new text
    view.dispatch(view.state.tr.insertText('new text', 1))

    await flush()

    // Must appear in PM and Y.Text
    expect(view.state.doc.textContent).toBe('new text')
    expect(sharedText.toString()).toBe('new text')
  })

  it('select-all + delete + type works after an external Y.Text change', async () => {
    const { ydoc, view } = tracked(setup('hello'))
    const sharedText = ydoc.getText('text')

    // External edit first
    sharedText.insert(sharedText.length, ' world')
    await flush()

    expect(view.state.doc.textContent).toBe('hello world')

    // Select all and delete
    const allSel = new AllSelection(view.state.doc)
    view.dispatch(view.state.tr.setSelection(allSel).deleteSelection())

    await flush()

    expect(view.state.doc.textContent).toBe('')

    // Type new text
    view.dispatch(view.state.tr.insertText('replaced', 1))

    await flush()

    expect(view.state.doc.textContent).toBe('replaced')
    expect(sharedText.toString()).toBe('replaced')
  })

  it('deleting empty paragraph persists locally', async () => {
    // Start with two paragraphs: "hello" and ""
    const { ydoc, view } = tracked(setup('hello\n'))
    const sharedText = ydoc.getText('text')

    await flush()

    // Verify initial state: two paragraphs
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.textContent).toBe('hello')

    // Delete the second (empty) paragraph by removing its range
    const firstParaEnd = view.state.doc.firstChild!.nodeSize
    const docEnd = view.state.doc.content.size
    view.dispatch(view.state.tr.delete(firstParaEnd, docEnd))

    await flush()

    // Should be one paragraph now
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.textContent).toBe('hello')
    expect(sharedText.toString()).toBe('hello')
  })

  it('rapid edits after external change all propagate', async () => {
    const { ydoc, view } = tracked(setup('a'))
    const sharedText = ydoc.getText('text')

    // External change
    sharedText.delete(0, 1)
    sharedText.insert(0, 'b')
    await flush()

    expect(view.state.doc.textContent).toBe('b')

    // Rapid local edits
    view.dispatch(view.state.tr.insertText('1', 2))
    view.dispatch(view.state.tr.insertText('2', 3))
    view.dispatch(view.state.tr.insertText('3', 4))

    await flush()

    expect(view.state.doc.textContent).toBe('b123')
    expect(sharedText.toString()).toBe('b123')
  })
})

describe('bridge integration: multi-client CRDT merge with skipOrigins', () => {
  /**
   * Simulate two clients sharing a Y.Doc via update exchange.
   * Without skipOrigins, both bridges write to XmlFragment for the same
   * Y.Text change, causing the CRDT merge to duplicate empty paragraphs.
   */
  function setupTwoClients(initialText: string, useSkipOrigins: boolean) {
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    // Bidirectional sync (simulates WebSocket)
    // We buffer updates and apply them separately to simulate the
    // real-world case where Y.Text and XmlFragment changes arrive
    // as separate transactions.
    const pending1to2: Uint8Array[] = []
    const pending2to1: Uint8Array[] = []

    doc1.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return
      pending1to2.push(update)
    })
    doc2.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return
      pending2to1.push(update)
    })

    const flushSync = () => {
      // Apply pending updates one at a time (separate transactions)
      while (pending1to2.length > 0 || pending2to1.length > 0) {
        const batch1 = pending1to2.splice(0)
        const batch2 = pending2to1.splice(0)
        for (const u of batch1) Y.applyUpdate(doc2, u, 'remote')
        for (const u of batch2) Y.applyUpdate(doc1, u, 'remote')
      }
    }

    const skipOrigins = useSkipOrigins ? new Set<unknown>(['remote']) : undefined

    // Client 1
    const sharedText1 = doc1.getText('text')
    const sharedPM1 = doc1.getXmlFragment('prosemirror')
    sharedText1.insert(0, initialText)

    const bridge1 = createYjsBridge({
      doc: doc1,
      sharedText: sharedText1,
      sharedProseMirror: sharedPM1,
      schema,
      serialize,
      parse,
      skipOrigins,
    })

    const collab1 = createCollabPlugins(schema, {
      sharedProseMirror: sharedPM1,
      awareness: {
        clientID: 1,
        getLocalState: () => ({}),
        setLocalStateField: () => {},
        getStates: () => new Map(),
        on: () => {},
        off: () => {},
      } as any,
      bridge: bridge1,
      sharedText: sharedText1,
    })

    const state1 = EditorState.create({ schema, doc: collab1.doc, plugins: collab1.plugins })
    const view1 = new EditorView(document.createElement('div'), { state: state1 })

    // Sync initial state to client 2
    flushSync()

    // Client 2
    const sharedText2 = doc2.getText('text')
    const sharedPM2 = doc2.getXmlFragment('prosemirror')

    const bridge2 = createYjsBridge({
      doc: doc2,
      sharedText: sharedText2,
      sharedProseMirror: sharedPM2,
      schema,
      serialize,
      parse,
      skipOrigins,
    })

    const collab2 = createCollabPlugins(schema, {
      sharedProseMirror: sharedPM2,
      awareness: {
        clientID: 2,
        getLocalState: () => ({}),
        setLocalStateField: () => {},
        getStates: () => new Map(),
        on: () => {},
        off: () => {},
      } as any,
      bridge: bridge2,
      sharedText: sharedText2,
    })

    const state2 = EditorState.create({ schema, doc: collab2.doc, plugins: collab2.plugins })
    const view2 = new EditorView(document.createElement('div'), { state: state2 })

    return {
      doc1, doc2,
      view1, view2,
      sharedText1, sharedText2,
      sharedPM1, sharedPM2,
      flushSync,
      destroy: () => {
        view1.destroy()
        view2.destroy()
        bridge1.dispose()
        bridge2.dispose()
      },
    }
  }

  it('empty paragraphs are NOT duplicated when skipOrigins is set', async () => {
    const ctx = setupTwoClients('hello', true)
    setups.push({ ydoc: ctx.doc1, view: ctx.view1, destroy: ctx.destroy })

    // Both clients should start with "hello"
    await flush()
    ctx.flushSync()
    await flush()

    expect(ctx.view1.state.doc.textContent).toBe('hello')
    expect(ctx.view2.state.doc.textContent).toBe('hello')

    // Client 1: insert empty lines via Y.Text (simulating CM edit)
    ctx.sharedText1.insert(5, '\n\n')
    await flush()
    ctx.flushSync()
    await flush()

    // Both clients should have 3 paragraphs: "hello", "", (empty from \n\n)
    // NOT 4+ paragraphs from duplicated empty nodes
    expect(ctx.view1.state.doc.childCount).toBe(3)
    expect(ctx.view2.state.doc.childCount).toBe(3)
    expect(ctx.sharedText1.toString()).toBe(ctx.sharedText2.toString())
  })

  it('skipOrigins prevents bridge from syncing remote Y.Text changes', async () => {
    const ctx = setupTwoClients('hello', true)
    setups.push({ ydoc: ctx.doc1, view: ctx.view1, destroy: ctx.destroy })

    await flush()
    ctx.flushSync()
    await flush()

    // Client 1: insert text via Y.Text (simulating CM edit)
    ctx.sharedText1.insert(5, ' world')
    await flush()

    // Before flushSync, only client 1 should have the updated content.
    // After flushSync, client 2 receives the updates.
    ctx.flushSync()
    await flush()

    // Both clients converge to the same state
    expect(ctx.view1.state.doc.textContent).toBe('hello world')
    expect(ctx.view2.state.doc.textContent).toBe('hello world')
    expect(ctx.sharedText1.toString()).toBe(ctx.sharedText2.toString())
  })
})
