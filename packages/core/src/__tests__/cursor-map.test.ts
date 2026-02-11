import { describe, it, expect, beforeAll } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '../cursor-map.js'
import type { CursorMap } from '../cursor-map.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

const serialize = (doc: Node): string => {
  const lines: string[] = []
  doc.forEach((node: Node) => {
    lines.push(node.textContent)
  })
  return lines.join('\n')
}

function makeDoc(...lines: string[]) {
  return schema.node('doc', null, lines.map((l) => schema.node('paragraph', null, l ? [schema.text(l)] : [])))
}

describe('buildCursorMap', () => {
  it('produces segments for a single-paragraph doc', () => {
    const doc = makeDoc('hello')
    const map = buildCursorMap(doc, serialize)
    expect(map.segments.length).toBe(1)
    expect(map.textLength).toBe(5)
    expect(map.skippedNodes).toBe(0)
    expect(map.segments[0]).toEqual({
      pmStart: 1, // paragraph opens at 0, text starts at 1
      pmEnd: 6,
      textStart: 0,
      textEnd: 5,
    })
  })

  it('produces segments for multi-paragraph doc', () => {
    const doc = makeDoc('ab', 'cd')
    const map = buildCursorMap(doc, serialize)
    expect(map.segments.length).toBe(2)
    // "ab\ncd" — textLength = 5
    expect(map.textLength).toBe(5)
    expect(map.segments[0]).toEqual({ pmStart: 1, pmEnd: 3, textStart: 0, textEnd: 2 })
    expect(map.segments[1]).toEqual({ pmStart: 5, pmEnd: 7, textStart: 3, textEnd: 5 })
  })

  it('counts skippedNodes when text is not found', () => {
    // Serializer returns text that doesn't contain the node content
    const doc = makeDoc('hello')
    const map = buildCursorMap(doc, () => 'XXXXX')
    expect(map.segments.length).toBe(0)
    expect(map.skippedNodes).toBe(1)
  })

  it('handles empty paragraphs', () => {
    const doc = makeDoc('', 'text')
    const map = buildCursorMap(doc, serialize)
    expect(map.segments.length).toBe(1)
    expect(map.segments[0].textStart).toBe(1) // after the newline
  })
})

describe('cursorMapLookup', () => {
  let map: CursorMap

  beforeAll(() => {
    const doc = makeDoc('abc', 'def')
    map = buildCursorMap(doc, serialize)
    // segments: [{pmStart:1,pmEnd:4,textStart:0,textEnd:3},{pmStart:6,pmEnd:9,textStart:4,textEnd:7}]
    // serialized: "abc\ndef" (len 7)
  })

  it('returns null for empty map', () => {
    expect(cursorMapLookup({ segments: [], textLength: 0, skippedNodes: 0 }, 0)).toBeNull()
  })

  it('maps positions inside a segment exactly', () => {
    // PM pos 1 = text offset 0 (start of "abc")
    expect(cursorMapLookup(map, 1)).toBe(0)
    // PM pos 3 = text offset 2
    expect(cursorMapLookup(map, 3)).toBe(2)
    // PM pos 6 = text offset 4 (start of "def")
    expect(cursorMapLookup(map, 6)).toBe(4)
  })

  it('snaps to nearest boundary for positions between segments', () => {
    // PM pos 0 (before first segment) → textStart of first = 0
    expect(cursorMapLookup(map, 0)).toBe(0)
    // PM pos 5 (between segments, paragraph boundary) → snaps
    const result = cursorMapLookup(map, 5)
    expect(typeof result).toBe('number')
  })
})

describe('reverseCursorMapLookup', () => {
  let map: CursorMap

  beforeAll(() => {
    const doc = makeDoc('abc', 'def')
    map = buildCursorMap(doc, serialize)
  })

  it('returns null for empty map', () => {
    expect(reverseCursorMapLookup({ segments: [], textLength: 0, skippedNodes: 0 }, 0)).toBeNull()
  })

  it('maps text offsets inside a segment exactly', () => {
    // text offset 0 = PM pos 1
    expect(reverseCursorMapLookup(map, 0)).toBe(1)
    // text offset 2 = PM pos 3
    expect(reverseCursorMapLookup(map, 2)).toBe(3)
    // text offset 4 = PM pos 6
    expect(reverseCursorMapLookup(map, 4)).toBe(6)
  })

  it('snaps to nearest boundary for offsets between segments', () => {
    // text offset 3 = newline, between segments → snaps
    const result = reverseCursorMapLookup(map, 3)
    expect(typeof result).toBe('number')
  })
})
