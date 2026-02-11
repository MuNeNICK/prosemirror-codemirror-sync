import { describe, it, expect } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup, wrapSerialize } from '../cursor-map.js'
import type { Matcher, MatchResult, SerializeWithMap } from '../types.js'

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

function makeParagraph(text: string) {
  return schema.node('paragraph', null, text ? [schema.text(text)] : [])
}

describe('buildCursorMap: SerializeWithMap path', () => {
  it('builds exact cursor map via writer', () => {
    const serializeWithMap: SerializeWithMap = (doc, writer) => {
      let first = true
      doc.forEach((node) => {
        if (!first) writer.write('\n')
        first = false
        const text = node.textContent
        writer.write('* ')
        // Find the text node position
        let textStart = -1
        node.forEach((_child, offset) => {
          textStart = offset
        })
        if (text) {
          // paragraph opens at its position, text starts at +1
          // For simplicity, compute from doc structure
          writer.writeMapped(0, 0, '') // placeholder — see below
        }
      })
    }

    // Use a proper SerializeWithMap that tracks positions
    const properSerialize: SerializeWithMap = (doc, writer) => {
      let first = true
      doc.forEach((block, blockOffset) => {
        if (!first) writer.write('\n')
        first = false
        writer.write('* ')
        const contentStart = blockOffset + 1 // paragraph opens, content starts at +1
        block.forEach((child, childOffset) => {
          if (child.isText && child.text) {
            const pmStart = contentStart + childOffset
            writer.writeMapped(pmStart, pmStart + child.text.length, child.text)
          }
        })
      })
    }

    const doc = schema.node('doc', null, [
      makeParagraph('hello'),
      makeParagraph('world'),
    ])

    const map = buildCursorMap(doc, properSerialize)
    // "* hello\n* world"
    expect(map.segments.length).toBe(2)
    expect(map.skippedNodes).toBe(0)
    expect(map.segments[0].textStart).toBe(2)  // after "* "
    expect(map.segments[0].textEnd).toBe(7)    // "hello"
    expect(map.segments[1].textStart).toBe(10) // after "\n* "
    expect(map.segments[1].textEnd).toBe(15)   // "world"
  })
})

describe('wrapSerialize', () => {
  it('without matcher produces same result as plain indexOf', () => {
    const doc = schema.node('doc', null, [
      makeParagraph('hello'),
      makeParagraph('world'),
    ])

    const plainMap = buildCursorMap(doc, serializeWithSyntax)
    const wrappedMap = buildCursorMap(doc, wrapSerialize(serializeWithSyntax))

    expect(wrappedMap.segments.length).toBe(plainMap.segments.length)
    expect(wrappedMap.skippedNodes).toBe(plainMap.skippedNodes)
    for (let i = 0; i < plainMap.segments.length; i++) {
      expect(wrappedMap.segments[i].textStart).toBe(plainMap.segments[i].textStart)
      expect(wrappedMap.segments[i].textEnd).toBe(plainMap.segments[i].textEnd)
    }
  })

  it('with matcher falls back to indexOf for exact matches', () => {
    const doc = schema.node('doc', null, [
      makeParagraph('hello'),
    ])

    let matcherCalled = false
    const matcher: Matcher = () => {
      matcherCalled = true
      return null
    }

    const map = buildCursorMap(doc, wrapSerialize(serializeWithSyntax, matcher))
    // "hello" appears literally in "* hello" — indexOf finds it, matcher not called
    expect(matcherCalled).toBe(false)
    expect(map.segments.length).toBe(1)
    expect(map.segments[0].textStart).toBe(2)
  })

  it('with matcher uses matcher when indexOf fails', () => {
    // Serializer that escapes * with backslash
    const escapingSerialize = (doc: Node): string => {
      const lines: string[] = []
      doc.forEach((node) => {
        lines.push(node.textContent.replace(/\*/g, '\\*'))
      })
      return lines.join('\n')
    }

    // Matcher that handles backslash escaping
    const backslashMatcher: Matcher = (serialized, nodeText, searchFrom) => {
      const firstChar = nodeText.charAt(0)
      let candidate = serialized.indexOf(firstChar, searchFrom)

      while (candidate !== -1) {
        let i = 0
        let j = candidate
        let runContentStart = -1
        let runTextStart = -1
        const runs: { contentStart: number; contentEnd: number; textStart: number; textEnd: number }[] = []

        while (i < nodeText.length && j < serialized.length) {
          if (serialized.charCodeAt(j) === nodeText.charCodeAt(i)) {
            if (runContentStart === -1) { runContentStart = i; runTextStart = j }
            i++; j++
          } else if (serialized.charCodeAt(j) === 92) { // backslash
            if (runContentStart !== -1) {
              runs.push({ contentStart: runContentStart, contentEnd: i, textStart: runTextStart, textEnd: j })
              runContentStart = -1
            }
            j++
          } else {
            break
          }
        }

        if (i === nodeText.length) {
          if (runContentStart !== -1) {
            runs.push({ contentStart: runContentStart, contentEnd: i, textStart: runTextStart, textEnd: j })
          }
          return { runs, nextSearchFrom: j }
        }
        candidate = serialized.indexOf(firstChar, candidate + 1)
      }
      return null
    }

    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a*b')]),
    ])

    // Without matcher: indexOf can't find "a*b" in "a\*b"
    const plainMap = buildCursorMap(doc, escapingSerialize)
    expect(plainMap.skippedNodes).toBe(1)

    // With matcher: backslash-aware matching finds it with multi-run
    const matcherMap = buildCursorMap(doc, wrapSerialize(escapingSerialize, backslashMatcher))
    expect(matcherMap.skippedNodes).toBe(0)
    expect(matcherMap.segments.length).toBe(2) // two runs: "a" and "*b"
  })

  it('multi-run segments enable correct cursor mapping through escapes', () => {
    const escapingSerialize = (doc: Node): string => {
      const lines: string[] = []
      doc.forEach((node) => {
        lines.push(node.textContent.replace(/\*/g, '\\*'))
      })
      return lines.join('\n')
    }

    // Simple matcher: skips backslashes
    const backslashMatcher: Matcher = (serialized, nodeText, searchFrom) => {
      const firstChar = nodeText.charAt(0)
      let candidate = serialized.indexOf(firstChar, searchFrom)

      while (candidate !== -1) {
        let i = 0
        let j = candidate
        let runContentStart = -1
        let runTextStart = -1
        const runs: { contentStart: number; contentEnd: number; textStart: number; textEnd: number }[] = []

        while (i < nodeText.length && j < serialized.length) {
          if (serialized.charCodeAt(j) === nodeText.charCodeAt(i)) {
            if (runContentStart === -1) { runContentStart = i; runTextStart = j }
            i++; j++
          } else if (serialized.charCodeAt(j) === 92) {
            if (runContentStart !== -1) {
              runs.push({ contentStart: runContentStart, contentEnd: i, textStart: runTextStart, textEnd: j })
              runContentStart = -1
            }
            j++
          } else {
            break
          }
        }

        if (i === nodeText.length) {
          if (runContentStart !== -1) {
            runs.push({ contentStart: runContentStart, contentEnd: i, textStart: runTextStart, textEnd: j })
          }
          return { runs, nextSearchFrom: j }
        }
        candidate = serialized.indexOf(firstChar, candidate + 1)
      }
      return null
    }

    // Doc: paragraph with "a*b"
    // Serialized: "a\*b"
    // PM positions: paragraph opens at 0, text at 1. 'a'=1, '*'=2, 'b'=3
    // Serialized: 'a'=0, '\'=1, '*'=2, 'b'=3
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a*b')]),
    ])

    const map = buildCursorMap(doc, wrapSerialize(escapingSerialize, backslashMatcher))

    // Two runs: "a" at pm[1,2)->text[0,1), "*b" at pm[2,4)->text[2,4)
    expect(map.segments.length).toBe(2)

    // PM pos 1 ('a') → text offset 0
    expect(cursorMapLookup(map, 1)).toBe(0)
    // PM pos 2 ('*') → text offset 2 (skipping the backslash)
    expect(cursorMapLookup(map, 2)).toBe(2)
    // PM pos 3 ('b') → text offset 3
    expect(cursorMapLookup(map, 3)).toBe(3)

    // Reverse: text offset 0 → PM pos 1
    expect(reverseCursorMapLookup(map, 0)).toBe(1)
    // Text offset 2 → PM pos 2
    expect(reverseCursorMapLookup(map, 2)).toBe(2)
    // Text offset 3 → PM pos 3
    expect(reverseCursorMapLookup(map, 3)).toBe(3)
  })

  it('default indexOf still works for unambiguous cases', () => {
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
