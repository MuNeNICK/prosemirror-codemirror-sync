import type { Node } from 'prosemirror-model'
import type { CursorMapWriter, Matcher, Serialize, SerializeWithMap } from './types.js'

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

/**
 * Create a {@link CursorMapWriter} that tracks offsets and builds segments.
 *
 * Call `getText()` to retrieve the full serialized text.
 * Call `finish(doc)` to produce the final {@link CursorMap}.
 */
export function createCursorMapWriter(): CursorMapWriter & {
  getText(): string
  finish(doc: Node): CursorMap
  getMappedCount(): number
} {
  let offset = 0
  const parts: string[] = []
  const segments: TextSegment[] = []
  let mappedCount = 0

  const writer: CursorMapWriter & { getText(): string; finish(doc: Node): CursorMap; getMappedCount(): number } = {
    write(text: string): void {
      parts.push(text)
      offset += text.length
    },

    writeMapped(pmStart: number, pmEnd: number, text: string): void {
      segments.push({
        pmStart,
        pmEnd,
        textStart: offset,
        textEnd: offset + text.length,
      })
      parts.push(text)
      offset += text.length
      mappedCount++
    },

    getText(): string {
      return parts.join('')
    },

    getMappedCount(): number {
      return mappedCount
    },

    finish(doc: Node): CursorMap {
      const textNodes: { start: number; end: number }[] = []
      function collectTextNodes(node: Node, contentStart: number): void {
        node.forEach((child, childOffset) => {
          const childPos = contentStart + childOffset
          if (child.isText && child.text) {
            textNodes.push({ start: childPos, end: childPos + child.text.length })
          } else if (!child.isLeaf) {
            collectTextNodes(child, childPos + 1)
          }
        })
      }
      collectTextNodes(doc, 0)

      // Count PM text nodes with at least one overlapping mapped segment.
      let mappedNodes = 0
      let segIdx = 0
      for (const n of textNodes) {
        while (segIdx < segments.length && segments[segIdx].pmEnd <= n.start) segIdx++
        let k = segIdx
        while (k < segments.length && segments[k].pmStart < n.end) {
          const s = segments[k]
          if (s.pmEnd > n.start && s.pmStart < n.end) {
            mappedNodes++
            break
          }
          k++
        }
      }

      return {
        segments,
        textLength: offset,
        skippedNodes: Math.max(0, textNodes.length - mappedNodes),
      }
    },
  }

  return writer
}

/**
 * Build a cursor map that aligns ProseMirror positions with serialized-text offsets.
 *
 * Accepts either a plain {@link Serialize} `(doc) => string` or a
 * {@link SerializeWithMap} `(doc, writer) => void`. Detection is automatic:
 * if the serializer uses the writer, the exact-by-construction path is used;
 * if it returns a string, an internal `indexOf`-based forward match is applied.
 *
 * The plain `Serialize` path uses exact `indexOf` matching (format-agnostic).
 * For better mapping quality with serializers that transform text (escaping,
 * entity encoding, etc.), use {@link wrapSerialize} with a format-specific
 * {@link Matcher}, or implement {@link SerializeWithMap} directly.
 *
 * @param doc - The ProseMirror document to map.
 * @param serialize - A plain serializer or a writer-based serializer.
 */
export function buildCursorMap(
  doc: Node,
  serialize: Serialize | SerializeWithMap,
): CursorMap {
  const writer = createCursorMapWriter()
  const result = (serialize as (...args: unknown[]) => unknown)(doc, writer)

  // Plain Serialize: writer was not used, return value is the serialized string.
  if (typeof result === 'string' && writer.getMappedCount() === 0) {
    return forwardScanBuildMap(doc, result)
  }

  // SerializeWithMap: writer was used — exact-by-construction path.
  const map = writer.finish(doc)

  // Monotonicity validation for writer-produced segments.
  for (let i = 1; i < map.segments.length; i++) {
    const prev = map.segments[i - 1]
    const curr = map.segments[i]
    if (curr.pmStart < prev.pmEnd || curr.textStart < prev.textEnd) {
      console.warn(
        `[pm-cm] buildCursorMap: non-monotonic segment at index ${i} ` +
        `(pmStart ${curr.pmStart} < prev pmEnd ${prev.pmEnd} or ` +
        `textStart ${curr.textStart} < prev textEnd ${prev.textEnd}). ` +
        'Ensure writeMapped calls are in ascending PM document order.',
      )
    }
  }

  return map
}

/**
 * Build a cursor map using plain `indexOf` forward matching.
 * Format-agnostic: no character or escape assumptions.
 */
function forwardScanBuildMap(doc: Node, text: string): CursorMap {
  const segments: TextSegment[] = []
  let searchFrom = 0
  let totalTextNodes = 0
  let skippedNodes = 0

  function visit(node: Node, contentStart: number): void {
    node.forEach((child, childOffset) => {
      const childPos = contentStart + childOffset
      if (child.isText && child.text) {
        totalTextNodes++
        const idx = text.indexOf(child.text, searchFrom)
        if (idx >= 0) {
          segments.push({
            pmStart: childPos,
            pmEnd: childPos + child.text.length,
            textStart: idx,
            textEnd: idx + child.text.length,
          })
          searchFrom = idx + child.text.length
        } else {
          skippedNodes++
        }
      } else if (!child.isLeaf) {
        visit(child, childPos + 1)
      }
    })
  }

  visit(doc, 0)
  return { segments, textLength: text.length, skippedNodes }
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

/**
 * Wrap a plain {@link Serialize} function as a {@link SerializeWithMap}.
 *
 * When called without a `matcher`, the wrapper uses `indexOf` internally
 * (identical to the default `buildCursorMap` path — useful only for type
 * compatibility).
 *
 * When called with a format-specific {@link Matcher}, the wrapper uses
 * `indexOf` first for each text node, falling back to the matcher when
 * `indexOf` fails. This enables multi-run mapping for serializers that
 * transform text (escaping, entity encoding, etc.).
 *
 * @param serialize - A plain `(doc: Node) => string` serializer.
 * @param matcher - Optional format-specific matcher for improved mapping.
 * @returns A {@link SerializeWithMap} that can be passed to {@link buildCursorMap}.
 */
export function wrapSerialize(serialize: Serialize, matcher?: Matcher): SerializeWithMap {
  return (doc: Node, writer: CursorMapWriter): void => {
    const text = serialize(doc)
    const segments = collectMatchedSegments(doc, text, matcher)

    // Emit in text order: unmapped gaps then mapped text
    let pos = 0
    for (const seg of segments) {
      if (seg.textStart > pos) writer.write(text.slice(pos, seg.textStart))
      writer.writeMapped(seg.pmStart, seg.pmEnd, text.slice(seg.textStart, seg.textEnd))
      pos = seg.textEnd
    }
    if (pos < text.length) writer.write(text.slice(pos))
  }
}

/**
 * Collect matched segments for all PM text nodes using indexOf + optional matcher fallback.
 */
function collectMatchedSegments(
  doc: Node,
  text: string,
  matcher: Matcher | undefined,
): TextSegment[] {
  const segments: TextSegment[] = []
  let searchFrom = 0

  function visit(node: Node, contentStart: number): void {
    node.forEach((child, childOffset) => {
      const childPos = contentStart + childOffset
      if (child.isText && child.text) {
        const content = child.text

        // 1. Try exact indexOf first (strongest signal, no false positives)
        const exactIdx = text.indexOf(content, searchFrom)
        if (exactIdx >= 0) {
          segments.push({
            pmStart: childPos,
            pmEnd: childPos + content.length,
            textStart: exactIdx,
            textEnd: exactIdx + content.length,
          })
          searchFrom = exactIdx + content.length
          return
        }

        // 2. If matcher provided, try format-specific matching
        if (matcher) {
          const result = matcher(text, content, searchFrom)
          if (result) {
            for (const run of result.runs) {
              segments.push({
                pmStart: childPos + run.contentStart,
                pmEnd: childPos + run.contentEnd,
                textStart: run.textStart,
                textEnd: run.textEnd,
              })
            }
            searchFrom = result.nextSearchFrom
            return
          }
        }

        // 3. Both failed — node skipped (searchFrom not advanced)
      } else if (!child.isLeaf) {
        visit(child, childPos + 1)
      }
    })
  }

  visit(doc, 0)
  return segments
}
