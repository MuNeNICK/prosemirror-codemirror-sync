import type { Node } from 'prosemirror-model'
import type { Serialize } from './types.js'

/** A mapping between a ProseMirror position range and a serialized-text offset range. */
export type TextSegment = {
  pmStart: number   // PM position (inclusive)
  pmEnd: number     // PM position (exclusive)
  textStart: number // serialized text offset (inclusive)
  textEnd: number   // serialized text offset (exclusive)
}

/**
 * Sorted list of {@link TextSegment}s produced by {@link buildCursorMap}.
 * Use {@link cursorMapLookup} and {@link reverseCursorMapLookup} for O(log n) queries.
 */
export type CursorMap = {
  segments: TextSegment[]
  textLength: number
  /** Number of text nodes that could not be located in the serialized output. */
  skippedNodes: number
}

/** Structural context passed to {@link LocateText} for disambiguation. */
export type LocateTextContext = {
  /** ProseMirror position of this text node. */
  pmStart: number
  /** Child-index path from doc root to this text node's parent. */
  pmPath: readonly number[]
  /** Parent node type name, or `null` for doc-level text. */
  parentType: string | null
  /** Index of this text node among its parent's children. */
  indexInParent: number
  /** Text content of the previous sibling, or `null`. */
  prevSiblingText: string | null
  /** Text content of the next sibling, or `null`. */
  nextSiblingText: string | null
  /** 0-based ordinal of this text node in document walk order. */
  textNodeOrdinal: number
}

/**
 * Locate a text-node string within the serialized output.
 * Return the starting index, or -1 if not found.
 * Default: `(serialized, nodeText, from) => serialized.indexOf(nodeText, from)`
 *
 * An optional {@link LocateTextContext} is provided for disambiguation
 * when the same text appears multiple times in the serialized output.
 */
export type LocateText = (serialized: string, nodeText: string, searchFrom: number, context?: LocateTextContext) => number

const defaultLocate: LocateText = (serialized, nodeText, from) =>
  serialized.indexOf(nodeText, from)

/**
 * Build a cursor map that aligns ProseMirror positions with serialized-text offsets.
 *
 * Walks the document tree and locates each text node within the serialized output,
 * producing a sorted list of {@link TextSegment}s.
 *
 * @param doc - The ProseMirror document to map.
 * @param serialize - Serializer used to produce the full text.
 * @param locate - Optional custom text-location function. Defaults to `indexOf`.
 */
export function buildCursorMap(
  doc: Node,
  serialize: Serialize,
  locate: LocateText = defaultLocate,
): CursorMap {
  const fullText = serialize(doc)
  const segments: TextSegment[] = []
  let searchFrom = 0
  let skippedNodes = 0
  let textNodeOrdinal = 0

  function walkChildren(node: Node, contentStart: number, path: readonly number[]): void {
    node.forEach((child, offset, index) => {
      const childPos = contentStart + offset

      if (child.isText && child.text) {
        const text = child.text
        const context: LocateTextContext = {
          pmStart: childPos,
          pmPath: path,
          parentType: node.type.name === 'doc' ? null : node.type.name,
          indexInParent: index,
          prevSiblingText: index > 0 ? (node.child(index - 1).textContent || null) : null,
          nextSiblingText: index < node.childCount - 1 ? (node.child(index + 1).textContent || null) : null,
          textNodeOrdinal,
        }
        textNodeOrdinal++
        const idx = locate(fullText, text, searchFrom, context)
        if (idx >= 0) {
          segments.push({
            pmStart: childPos,
            pmEnd: childPos + text.length,
            textStart: idx,
            textEnd: idx + text.length,
          })
          searchFrom = idx + text.length
        } else {
          skippedNodes++
        }
        return
      }

      if (child.isLeaf) {
        return
      }

      // Container node: content starts at childPos + 1 (open tag)
      walkChildren(child, childPos + 1, [...path, index])
    })
  }

  // doc's content starts at position 0
  walkChildren(doc, 0, [])

  return { segments, textLength: fullText.length, skippedNodes }
}

/**
 * Look up a ProseMirror position in a cursor map and return the corresponding text offset.
 * Returns `null` when the map has no segments.
 */
export function cursorMapLookup(map: CursorMap, pmPos: number): number | null {
  const { segments } = map
  if (segments.length === 0) return null

  // Binary search for the segment containing pmPos
  let lo = 0
  let hi = segments.length - 1

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const seg = segments[mid]

    if (pmPos < seg.pmStart) {
      hi = mid - 1
    } else if (pmPos >= seg.pmEnd) {
      lo = mid + 1
    } else {
      // Inside segment: exact mapping
      return seg.textStart + (pmPos - seg.pmStart)
    }
  }

  // pmPos is between segments — snap to nearest boundary
  // After binary search: hi < lo, pmPos falls between segments[hi] and segments[lo]
  const before = hi >= 0 ? segments[hi] : null
  const after = lo < segments.length ? segments[lo] : null

  if (!before) return after ? after.textStart : 0
  if (!after) return before.textEnd

  const distBefore = pmPos - before.pmEnd
  const distAfter = after.pmStart - pmPos
  return distBefore <= distAfter ? before.textEnd : after.textStart
}

/**
 * Look up a text offset (e.g. CodeMirror position) in a cursor map and return the corresponding ProseMirror position.
 * Returns `null` when the map has no segments.
 */
export function reverseCursorMapLookup(map: CursorMap, cmOffset: number): number | null {
  const { segments } = map
  if (segments.length === 0) return null

  // Binary search for the segment containing cmOffset
  let lo = 0
  let hi = segments.length - 1

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const seg = segments[mid]

    if (cmOffset < seg.textStart) {
      hi = mid - 1
    } else if (cmOffset >= seg.textEnd) {
      lo = mid + 1
    } else {
      // Inside segment: exact mapping
      return seg.pmStart + (cmOffset - seg.textStart)
    }
  }

  // cmOffset is between segments — snap to nearest boundary
  const before = hi >= 0 ? segments[hi] : null
  const after = lo < segments.length ? segments[lo] : null

  if (!before) return after ? after.pmStart : 0
  if (!after) return before.pmEnd

  const distBefore = cmOffset - before.textEnd
  const distAfter = after.textStart - cmOffset
  return distBefore <= distAfter ? before.pmEnd : after.pmStart
}
