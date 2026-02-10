import { describe, it, expect, afterEach } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import {
  Doc,
  Text as YText,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
  createRelativePositionFromTypeIndex,
  createAbsolutePositionFromRelativePosition,
} from 'yjs'
import { Awareness } from 'y-protocols/awareness'

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
  return schema.node('doc', null, paragraphs)
}

type Harness = {
  ydoc: Doc
  awareness: Awareness
  sharedText: YText
  bridge: ReturnType<typeof createYjsBridge>
  view: EditorView
  destroy: () => void
}

const harnesses: Harness[] = []

afterEach(() => {
  for (const h of harnesses) h.destroy()
  harnesses.length = 0
})

function makeHarness(initialText: string): Harness {
  const ydoc = new Doc()
  const awareness = new Awareness(ydoc)
  const sharedText = ydoc.getText('text')
  const sharedProseMirror = ydoc.getXmlFragment('prosemirror')

  const bridge = createYjsBridge({
    doc: ydoc,
    sharedText,
    sharedProseMirror,
    schema,
    serialize,
    parse,
  }, { initialText })

  const { plugins, doc } = createCollabPlugins(schema, {
    sharedProseMirror,
    awareness,
    bridge,
  })

  let view: EditorView
  view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ schema, doc, plugins }),
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr))
      if (tr.docChanged && !bridge.isYjsSyncChange(tr)) {
        bridge.syncToSharedText(view.state.doc)
      }
    },
  })

  const harness: Harness = {
    ydoc,
    awareness,
    sharedText,
    bridge,
    view,
    destroy() {
      view.destroy()
      bridge.dispose()
      awareness.destroy()
      ydoc.destroy()
    },
  }

  harnesses.push(harness)
  return harness
}

describe('yjs bridge: incremental XmlFragment update', () => {
  it('cursor on surviving paragraph should not be null after middle paragraph deletion', () => {
    // With full replacement: ALL paragraphs are recreated → cursor on "a" becomes null
    // With incremental: prefix/suffix match preserves "a" and "c" → cursor survives
    const { ydoc, sharedText } = makeHarness('a\nb\nc')
    const fragment = ydoc.getXmlFragment('prosemirror')

    // Anchor cursor on first paragraph (which will survive the edit)
    const firstParagraph = fragment.get(0) as YXmlElement
    const firstText = firstParagraph.get(0) as YXmlText
    const remoteCursor = createRelativePositionFromTypeIndex(firstText, 0)

    // Remove middle line "b" in a single transaction
    ydoc.transact(() => {
      sharedText.delete(0, sharedText.length)
      sharedText.insert(0, 'a\nc')
    })

    const resolved = createAbsolutePositionFromRelativePosition(remoteCursor, ydoc)

    // Acceptance criterion: cursor on surviving paragraph should resolve
    expect(resolved).not.toBeNull()
    expect((resolved!.type as YXmlText).toString()).toContain('a')
  })

  it('cursor on suffix paragraph should survive after prefix text change', () => {
    // With full replacement: suffix paragraph is recreated → cursor lost
    // With incremental: suffix matches → paragraph "c" preserved
    const { ydoc, sharedText } = makeHarness('a\nb\nc')
    const fragment = ydoc.getXmlFragment('prosemirror')

    // Anchor cursor on last paragraph "c"
    const lastParagraph = fragment.get(2) as YXmlElement
    const lastText = lastParagraph.get(0) as YXmlText
    const remoteCursor = createRelativePositionFromTypeIndex(lastText, 0)

    // Change middle line "b" → "x" (prefix "a" and suffix "c" survive)
    ydoc.transact(() => {
      sharedText.delete(0, sharedText.length)
      sharedText.insert(0, 'a\nx\nc')
    })

    const resolved = createAbsolutePositionFromRelativePosition(remoteCursor, ydoc)

    expect(resolved).not.toBeNull()
    expect((resolved!.type as YXmlText).toString()).toContain('c')
  })

  it('surviving paragraphs should retain their XmlElement identity', () => {
    const { ydoc, sharedText } = makeHarness('a\nb\nc')
    const fragment = ydoc.getXmlFragment('prosemirror')

    // Capture identity of first and last paragraph
    const firstBefore = fragment.get(0)
    const lastBefore = fragment.get(2)

    // Change middle line "b" → "x"
    ydoc.transact(() => {
      sharedText.delete(0, sharedText.length)
      sharedText.insert(0, 'a\nx\nc')
    })

    // First and last paragraphs should be the SAME Yjs objects (not recreated)
    expect(fragment.get(0)).toBe(firstBefore)
    expect(fragment.get(2)).toBe(lastBefore)
  })

  it('text change within a paragraph should update XmlText in-place', () => {
    const { ydoc, sharedText } = makeHarness('hello\nworld')
    const fragment = ydoc.getXmlFragment('prosemirror')

    // Anchor cursor on "hello" paragraph
    const firstParagraph = fragment.get(0) as YXmlElement
    const firstText = firstParagraph.get(0) as YXmlText
    const remoteCursor = createRelativePositionFromTypeIndex(firstText, 0)

    // Change "hello" → "REMOTE-hello" (in-place text update, not element replacement)
    ydoc.transact(() => {
      sharedText.delete(0, sharedText.length)
      sharedText.insert(0, 'REMOTE-hello\nworld')
    })

    const resolved = createAbsolutePositionFromRelativePosition(remoteCursor, ydoc)
    expect(resolved).not.toBeNull()

    // XmlElement identity should be preserved
    expect(fragment.get(0)).toBe(firstParagraph)
  })
})
