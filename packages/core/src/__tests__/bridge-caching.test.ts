import { describe, it, expect, vi } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createViewBridge, diffText } from '../bridge.js'
import type { IncrementalParseResult } from '../types.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

function parse(text: string) {
  const paragraphs = text.split('\n').map((line) =>
    schema.node('paragraph', null, line ? [schema.text(line)] : []),
  )
  return schema.node('doc', null, paragraphs)
}

function makeView(text: string): EditorView {
  let view: EditorView
  view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ schema, doc: parse(text) }),
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr))
    },
  })
  return view
}

describe('bridge: serialize cache', () => {
  it('should call serialize at most once per doc reference', () => {
    const serializeSpy = vi.fn((doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    })

    const bridge = createViewBridge({ schema, serialize: serializeSpy, parse })
    const view = makeView('hello')

    // First call: serialize is called once to get current text
    bridge.applyText(view, 'hello')
    const firstCount = serializeSpy.mock.calls.length
    expect(firstCount).toBe(1)

    // Second call with same doc: serialize should NOT be called again (cached)
    bridge.applyText(view, 'hello')
    expect(serializeSpy.mock.calls.length).toBe(firstCount)

    view.destroy()
  })

  it('should re-serialize after external PM doc change', () => {
    const serializeSpy = vi.fn((doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    })

    const bridge = createViewBridge({ schema, serialize: serializeSpy, parse })
    const view = makeView('hello')

    // First call: serialize called once
    bridge.applyText(view, 'hello')
    const countAfterFirst = serializeSpy.mock.calls.length
    expect(countAfterFirst).toBe(1)

    // Simulate external PM change (e.g. user typing in PM)
    const tr = view.state.tr.insertText('!', view.state.doc.content.size - 1)
    view.dispatch(tr)

    // Now doc reference changed → serialize must be called again
    bridge.applyText(view, 'something')
    expect(serializeSpy.mock.calls.length).toBeGreaterThan(countAfterFirst)

    view.destroy()
  })
})

describe('bridge: last-applied guard', () => {
  it('should skip serialize and parse on repeated identical calls', () => {
    const serializeSpy = vi.fn((doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    })
    const parseSpy = vi.fn(parse)

    const bridge = createViewBridge({ schema, serialize: serializeSpy, parse: parseSpy })
    const view = makeView('hello')

    // First call
    bridge.applyText(view, 'world')
    const serializeCount = serializeSpy.mock.calls.length
    const parseCount = parseSpy.mock.calls.length

    // Repeated call with same text → last-applied guard triggers
    const result = bridge.applyText(view, 'world')
    expect(result).toEqual({ ok: false, reason: 'unchanged' })

    // Neither serialize nor parse should be called again
    expect(serializeSpy.mock.calls.length).toBe(serializeCount)
    expect(parseSpy.mock.calls.length).toBe(parseCount)

    view.destroy()
  })
})

describe('bridge: parse LRU cache', () => {
  it('should reuse parse result for identical text', () => {
    const parseSpy = vi.fn(parse)

    const bridge = createViewBridge({ schema, serialize: (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }, parse: parseSpy })
    const view = makeView('hello')

    // Apply "world" → calls parse
    bridge.applyText(view, 'world')
    const countAfterFirst = parseSpy.mock.calls.length

    // Apply "foo" → calls parse (different text)
    bridge.applyText(view, 'foo')
    const countAfterSecond = parseSpy.mock.calls.length
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst)

    // Apply "world" again → should hit LRU cache, no new parse call
    bridge.applyText(view, 'world')
    expect(parseSpy.mock.calls.length).toBe(countAfterSecond)

    view.destroy()
  })

  it('should respect parseCacheSize: 0 to disable caching', () => {
    const parseSpy = vi.fn(parse)

    const bridge = createViewBridge({
      schema,
      serialize: (doc: Node) => {
        const lines: string[] = []
        doc.forEach((node) => lines.push(node.textContent))
        return lines.join('\n')
      },
      parse: parseSpy,
      parseCacheSize: 0,
    })
    const view = makeView('hello')

    bridge.applyText(view, 'world')
    const countAfterFirst = parseSpy.mock.calls.length

    bridge.applyText(view, 'foo')
    const countAfterSecond = parseSpy.mock.calls.length

    // Apply "world" again → cache disabled, parse called again
    bridge.applyText(view, 'world')
    expect(parseSpy.mock.calls.length).toBeGreaterThan(countAfterSecond)

    view.destroy()
  })
})

describe('bridge: incremental parse', () => {
  it('should call incrementalParse with correct diff when provided', () => {
    const incrementalParseSpy = vi.fn(() => null) // always fallback

    const serialize = (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }

    const bridge = createViewBridge({
      schema,
      serialize,
      parse,
      incrementalParse: incrementalParseSpy,
    })
    const view = makeView('hello\nworld')

    bridge.applyText(view, 'hello\nWORLD')

    expect(incrementalParseSpy).toHaveBeenCalledTimes(1)
    const args = incrementalParseSpy.mock.calls[0][0]
    expect(args.prevText).toBe('hello\nworld')
    expect(args.text).toBe('hello\nWORLD')
    expect(args.diff.start).toBe(6) // "hello\n" is common prefix
    expect(args.diff.endA).toBe(11) // "world".length = 5, so end at 11
    expect(args.diff.endB).toBe(11) // "WORLD".length = 5, so end at 11

    view.destroy()
  })

  it('should use incrementalParse result when non-null', () => {
    const parseSpy = vi.fn(parse)

    const serialize = (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }

    // incrementalParse that handles single-line changes
    const incrementalParse = vi.fn(({ prevDoc, text, diff, schema: s }: {
      prevDoc: Node, prevText: string, text: string, diff: { start: number, endA: number, endB: number }, schema: Schema
    }) => {
      const newLines = text.split('\n')
      const oldLines = serialize(prevDoc).split('\n')

      // Find changed line range
      let firstLine = 0, charCount = 0
      for (let i = 0; i < oldLines.length; i++) {
        if (charCount + oldLines[i].length >= diff.start) { firstLine = i; break }
        charCount += oldLines[i].length + 1
      }

      let commonSuffix = 0
      while (
        commonSuffix < oldLines.length &&
        commonSuffix < newLines.length &&
        oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
      ) commonSuffix++

      const lastNewLine = newLines.length - commonSuffix

      const children: Node[] = []
      for (let i = 0; i < firstLine; i++) children.push(prevDoc.child(i))
      for (let i = firstLine; i < lastNewLine; i++) {
        const line = newLines[i]
        children.push(s.node('paragraph', null, line ? [s.text(line)] : []))
      }
      const lastOldLine = oldLines.length - commonSuffix
      for (let i = lastOldLine; i < prevDoc.childCount; i++) children.push(prevDoc.child(i))

      return s.node('doc', null, children)
    })

    const bridge = createViewBridge({
      schema,
      serialize,
      parse: parseSpy,
      incrementalParse,
    })
    const view = makeView('aaa\nbbb\nccc')

    // Change middle line
    const result = bridge.applyText(view, 'aaa\nXXX\nccc')

    expect(result).toEqual({ ok: true })
    expect(incrementalParse).toHaveBeenCalledTimes(1)
    // Full parse should NOT have been called (incrementalParse returned non-null)
    expect(parseSpy).not.toHaveBeenCalled()

    // Verify the doc was updated correctly
    expect(bridge.extractText(view)).toBe('aaa\nXXX\nccc')

    view.destroy()
  })

  it('should fall back to full parse when incrementalParse returns null', () => {
    const parseSpy = vi.fn(parse)

    const serialize = (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }

    const bridge = createViewBridge({
      schema,
      serialize,
      parse: parseSpy,
      incrementalParse: () => null,
    })
    const view = makeView('hello')

    const result = bridge.applyText(view, 'world')

    expect(result).toEqual({ ok: true })
    // incrementalParse returned null → full parse was called
    expect(parseSpy).toHaveBeenCalledTimes(1)

    view.destroy()
  })

  it('incremental parse should preserve block identity for unchanged children', () => {
    const serialize = (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }

    const incrementalParse = ({ prevDoc, text, diff, schema: s }: {
      prevDoc: Node, prevText: string, text: string, diff: { start: number, endA: number, endB: number }, schema: Schema
    }) => {
      const newLines = text.split('\n')
      const oldLines = serialize(prevDoc).split('\n')

      let firstLine = 0, charCount = 0
      for (let i = 0; i < oldLines.length; i++) {
        if (charCount + oldLines[i].length >= diff.start) { firstLine = i; break }
        charCount += oldLines[i].length + 1
      }

      let commonSuffix = 0
      while (
        commonSuffix < oldLines.length &&
        commonSuffix < newLines.length &&
        oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
      ) commonSuffix++

      const lastNewLine = newLines.length - commonSuffix
      const lastOldLine = oldLines.length - commonSuffix

      const children: Node[] = []
      for (let i = 0; i < firstLine; i++) children.push(prevDoc.child(i))
      for (let i = firstLine; i < lastNewLine; i++) {
        const line = newLines[i]
        children.push(s.node('paragraph', null, line ? [s.text(line)] : []))
      }
      for (let i = lastOldLine; i < prevDoc.childCount; i++) children.push(prevDoc.child(i))

      return s.node('doc', null, children)
    }

    const bridge = createViewBridge({
      schema,
      serialize,
      parse,
      incrementalParse,
    })
    const view = makeView('aaa\nbbb\nccc\nddd\neee')

    const beforeChildren = Array.from({ length: view.state.doc.childCount }, (_, i) => view.state.doc.child(i))

    // Change only middle line
    bridge.applyText(view, 'aaa\nbbb\nXXX\nddd\neee')

    const afterDoc = view.state.doc
    // Lines 0,1 (prefix) and 3,4 (suffix) should be same Node references
    expect(afterDoc.child(0)).toBe(beforeChildren[0])
    expect(afterDoc.child(1)).toBe(beforeChildren[1])
    expect(afterDoc.child(3)).toBe(beforeChildren[3])
    expect(afterDoc.child(4)).toBe(beforeChildren[4])
    // Line 2 should be different
    expect(afterDoc.child(2)).not.toBe(beforeChildren[2])

    view.destroy()
  })

  it('should skip findDiffStart/findDiffEnd when incrementalParse returns range hint', () => {
    const serialize = (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }

    // incrementalParse that returns { doc, from, to, toB }
    const incrementalParse = vi.fn(({ prevDoc, text, diff, schema: s }: {
      prevDoc: Node, prevText: string, text: string, diff: { start: number, endA: number, endB: number }, schema: Schema
    }): IncrementalParseResult => {
      const newLines = text.split('\n')
      const oldLines = serialize(prevDoc).split('\n')

      let firstLine = 0, charCount = 0
      for (let i = 0; i < oldLines.length; i++) {
        if (charCount + oldLines[i].length >= diff.start) { firstLine = i; break }
        charCount += oldLines[i].length + 1
      }

      let commonSuffix = 0
      while (
        commonSuffix < oldLines.length &&
        commonSuffix < newLines.length &&
        oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
      ) commonSuffix++

      const lastNewLine = newLines.length - commonSuffix
      const lastOldLine = oldLines.length - commonSuffix

      const children: Node[] = []
      for (let i = 0; i < firstLine; i++) children.push(prevDoc.child(i))
      for (let i = firstLine; i < lastNewLine; i++) {
        const line = newLines[i]
        children.push(s.node('paragraph', null, line ? [s.text(line)] : []))
      }
      for (let i = lastOldLine; i < prevDoc.childCount; i++) children.push(prevDoc.child(i))

      const doc = s.node('doc', null, children)

      // Compute PM positions for the changed range
      let from = 0
      for (let i = 0; i < firstLine; i++) from += prevDoc.child(i).nodeSize
      let to = from
      for (let i = firstLine; i < lastOldLine; i++) to += prevDoc.child(i).nodeSize
      let toB = from
      for (let i = firstLine; i < lastNewLine; i++) toB += doc.child(i).nodeSize

      return { doc, from, to, toB }
    })

    const bridge = createViewBridge({ schema, serialize, parse, incrementalParse })
    const view = makeView('aaa\nbbb\nccc')

    const result = bridge.applyText(view, 'aaa\nXXX\nccc')

    expect(result).toEqual({ ok: true })
    expect(incrementalParse).toHaveBeenCalledTimes(1)
    expect(bridge.extractText(view)).toBe('aaa\nXXX\nccc')

    view.destroy()
  })
})

describe('bridge: normalized option', () => {
  it('should skip normalize when normalized: true is set', () => {
    const serializeSpy = vi.fn((doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    })

    const bridge = createViewBridge({ schema, serialize: serializeSpy, parse })
    const view = makeView('hello')

    const result = bridge.applyText(view, 'world', { normalized: true })
    expect(result).toEqual({ ok: true })
    expect(bridge.extractText(view)).toBe('world')

    view.destroy()
  })

  it('normalized + diff should bypass both normalize and diffText', () => {
    const serialize = (doc: Node) => {
      const lines: string[] = []
      doc.forEach((node) => lines.push(node.textContent))
      return lines.join('\n')
    }

    const bridge = createViewBridge({ schema, serialize, parse })
    const view = makeView('aaa\nbbb\nccc')

    const prevText = 'aaa\nbbb\nccc'
    const nextText = 'aaa\nXXX\nccc'
    const diff = diffText(prevText, nextText)

    const result = bridge.applyText(view, nextText, { normalized: true, diff })

    expect(result).toEqual({ ok: true })
    expect(bridge.extractText(view)).toBe('aaa\nXXX\nccc')

    view.destroy()
  })
})
