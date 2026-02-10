import { describe, it, expect } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '../cursor-map.js'
import type { LocateText, LocateTextContext } from '../cursor-map.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] as const },
    blockquote: { group: 'block', content: 'paragraph+', toDOM: () => ['blockquote', 0] as const },
    text: { inline: true },
  },
})

/**
 * Serializer that adds Markdown-like syntax prefixes.
 * Paragraphs get "* " prefix, blockquote children get "> " prefix.
 */
function serializeWithSyntax(doc: Node): string {
  const lines: string[] = []
  doc.forEach((node) => {
    if (node.type.name === 'paragraph') {
      lines.push(`* ${node.textContent}`)
      return
    }
    if (node.type.name === 'blockquote') {
      node.forEach((child) => {
        lines.push(`> ${child.textContent}`)
      })
    }
  })
  return lines.join('\n')
}

/**
 * Context-aware locate that uses structural info to skip past syntax prefixes.
 * Knows that paragraphs have "* " prefix (2 chars) and blockquote lines have "> " prefix (2 chars).
 */
const syntaxAwareLocate: LocateText = (
  serialized: string,
  nodeText: string,
  searchFrom: number,
  context?: LocateTextContext,
): number => {
  if (!context) return serialized.indexOf(nodeText, searchFrom)

  // Repeatedly find matches and reject those in prefix regions
  let pos = searchFrom
  while (true) {
    const idx = serialized.indexOf(nodeText, pos)
    if (idx < 0) return -1

    // Find line start for this match
    let lineStart = idx
    while (lineStart > 0 && serialized[lineStart - 1] !== '\n') lineStart--

    // Accept only if match is past the 2-char syntax prefix ("* " or "> ")
    if (idx >= lineStart + 2) return idx

    // Match was inside prefix — skip and try next occurrence
    pos = idx + 1
  }
}

function makeParagraph(text: string) {
  return schema.node('paragraph', null, text ? [schema.text(text)] : [])
}

describe('cursor-map: LocateText context', () => {
  it('context-aware locate maps nested syntax-like text to content offsets', () => {
    // Doc: blockquote(paragraph("> ")), paragraph("tail")
    // Serialized: "> > \n* tail"
    // Without context: indexOf finds "> " at 0 (syntax prefix)
    // With context: skips prefix, finds "> " at 2 (actual content)
    const doc = schema.node('doc', null, [
      schema.node('blockquote', null, [makeParagraph('> ')]),
      makeParagraph('tail'),
    ])

    const map = buildCursorMap(doc, serializeWithSyntax, syntaxAwareLocate)

    expect(map.segments.length).toBeGreaterThan(0)
    expect(map.segments[0].textStart).toBe(2)
  })

  it('context-aware locate handles repeated marker text with empty nodes', () => {
    // Doc: paragraph("*"), paragraph(""), paragraph("*")
    // Serialized: "* *\n* \n* *"
    // Without context: first "*" matches at 0, second at 2
    // With context: first "*" at 2 (after "* " prefix), second at 9 (after third "* " prefix)
    const doc = schema.node('doc', null, [
      makeParagraph('*'),
      makeParagraph(''),
      makeParagraph('*'),
    ])

    const map = buildCursorMap(doc, serializeWithSyntax, syntaxAwareLocate)

    expect(map.segments.length).toBe(2)
    expect(map.segments[0].textStart).toBe(2)
    expect(map.segments[1].textStart).toBe(9)
  })

  it('cm->pm roundtrip lands on same logical text node with context-aware locate', () => {
    const doc = schema.node('doc', null, [
      makeParagraph('*'),
      makeParagraph(''),
      makeParagraph('*'),
    ])

    const map = buildCursorMap(doc, serializeWithSyntax, syntaxAwareLocate)

    const firstParagraphTextPmPos = 1
    const expectedCmOffset = 2

    expect(cursorMapLookup(map, firstParagraphTextPmPos)).toBe(expectedCmOffset)
    expect(reverseCursorMapLookup(map, expectedCmOffset)).toBe(firstParagraphTextPmPos)
  })

  it('context provides correct structural information', () => {
    const doc = schema.node('doc', null, [
      schema.node('blockquote', null, [makeParagraph('hello')]),
      makeParagraph('world'),
    ])

    const contexts: LocateTextContext[] = []
    const capturingLocate: LocateText = (serialized, nodeText, searchFrom, context) => {
      if (context) contexts.push(context)
      return serialized.indexOf(nodeText, searchFrom)
    }

    buildCursorMap(doc, serializeWithSyntax, capturingLocate)

    expect(contexts.length).toBe(2)

    // First text node: "hello" inside blockquote > paragraph
    expect(contexts[0].parentType).toBe('paragraph')
    expect(contexts[0].pmPath).toEqual([0, 0])
    expect(contexts[0].indexInParent).toBe(0)
    expect(contexts[0].textNodeOrdinal).toBe(0)

    // Second text node: "world" inside paragraph
    expect(contexts[1].parentType).toBe('paragraph')
    expect(contexts[1].pmPath).toEqual([1])
    expect(contexts[1].indexInParent).toBe(0)
    expect(contexts[1].textNodeOrdinal).toBe(1)
  })

  it('default locate (no context) still works for unambiguous cases', () => {
    const doc = schema.node('doc', null, [
      makeParagraph('hello'),
      makeParagraph('world'),
    ])

    // No custom locate — uses default indexOf
    const map = buildCursorMap(doc, serializeWithSyntax)

    expect(map.segments.length).toBe(2)
    expect(map.skippedNodes).toBe(0)
    // "* hello\n* world" → "hello" at 2, "world" at 10
    expect(map.segments[0].textStart).toBe(2)
    expect(map.segments[1].textStart).toBe(10)
  })
})
