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
import { Doc } from 'yjs'
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
  ydoc: Doc
  view: EditorView
  destroy: () => void
}

function setup(initialText?: string): Setup {
  const ydoc = new Doc()
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
