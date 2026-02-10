# Performance Optimization Guide

`@pm-cm/core` provides several optimization options for `createViewBridge` that can significantly reduce the cost of `applyText` for large documents. This guide explains each option and how to combine them.

## Overview

The `applyText` pipeline has these stages:

```
text -> normalize -> diff -> parse -> tree diff -> dispatch
```

Each stage has an associated optimization:

| Stage | Cost | Optimization | Speedup |
|---|---|---|---|
| Normalize | O(n) | `options.normalized` | Skip entirely |
| Serialize (current doc) | O(n) | WeakMap cache (automatic) | Amortized O(1) |
| String diff | O(n) | `options.diff` | Skip entirely |
| Parse | O(n) | `incrementalParse` hook | O(changed) |
| Parse (repeated) | O(n) | LRU cache (automatic) | Amortized O(1) |
| Tree diff | O(n) | `IncrementalParseResult` range hint | Skip entirely |
| Repeated calls | O(n) | Last-applied guard (automatic) | O(1) |

---

## Automatic Optimizations

These are enabled by default and require no configuration.

### Serialize Cache

A `WeakMap<Node, string>` caches serialized text keyed by the immutable ProseMirror `Node` reference. The same document is never serialized twice.

### Parse LRU Cache

An LRU cache (default size 8) stores recent parse results keyed by normalized text. Helps with undo/redo and echo loops where the same text is parsed repeatedly.

```ts
const bridge = createViewBridge({
  schema, serialize, parse,
  parseCacheSize: 16,  // increase cache size (default: 8)
})

// Or disable:
const bridge = createViewBridge({
  schema, serialize, parse,
  parseCacheSize: 0,   // no parse caching
})
```

### Last-Applied Guard

When `applyText` is called with the same document and text as the previous call, it returns `{ ok: false, reason: 'unchanged' }` immediately without any work. This handles echo loops (e.g. CodeMirror echoing back the same text after a PM-originated change).

---

## `options.normalized`

When the caller guarantees the input text contains no `\r` characters (e.g. CodeMirror always produces clean text), set `normalized: true` to skip the normalize pass entirely.

```ts
bridge.applyText(view, text, { normalized: true })
```

---

## `options.diff`

When the caller already has a text diff (e.g. from CodeMirror's changeset), pass it to skip the internal O(n) `diffText` scan.

```ts
import { diffText } from '@pm-cm/core'

// Example: computing diff from CodeMirror changes
const diff = diffText(previousText, newText)

bridge.applyText(view, newText, { diff })
```

The `TextDiff` shape:

```ts
type TextDiff = {
  start: number   // byte offset where texts first differ
  endA: number    // end of changed region in old text
  endB: number    // end of changed region in new text
}
```

### Deriving `TextDiff` from CodeMirror

When using CodeMirror 6, you can derive the diff from a `ChangeSet`:

```ts
function changeSetToDiff(changes: ChangeSet): TextDiff {
  let start = Infinity, endA = 0, endB = 0
  let offset = 0
  changes.iterChanges((fromA, toA, fromB, toB) => {
    start = Math.min(start, fromA)
    endA = Math.max(endA, toA)
    endB = Math.max(endB, toB)
  })
  if (start === Infinity) return { start: 0, endA: 0, endB: 0 }
  return { start, endA, endB }
}
```

---

## `incrementalParse`

For large documents, full re-parsing is the dominant cost. The `incrementalParse` hook lets you re-parse only the changed region.

This hook is **optional** because the library is format-agnostic: it cannot implement incremental parsing without knowledge of your specific format (Markdown, HTML, etc.).

### Basic Usage (Node return)

Return a `Node` and the bridge will diff it against the previous document using `findDiffStart`/`findDiffEnd`:

```ts
const bridge = createViewBridge({
  schema, serialize, parse,
  incrementalParse({ prevDoc, prevText, text, diff, schema }) {
    // Only handle simple single-line edits
    const oldLines = prevText.split('\n')
    const newLines = text.split('\n')

    if (Math.abs(oldLines.length - newLines.length) > 5) {
      return null  // fall back to full parse
    }

    // Find first changed line
    let firstLine = 0, charCount = 0
    for (let i = 0; i < oldLines.length; i++) {
      if (charCount + oldLines[i].length >= diff.start) { firstLine = i; break }
      charCount += oldLines[i].length + 1
    }

    // Find common suffix lines
    let commonSuffix = 0
    while (
      commonSuffix < oldLines.length &&
      commonSuffix < newLines.length &&
      oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
    ) commonSuffix++

    const lastNewLine = newLines.length - commonSuffix
    const lastOldLine = oldLines.length - commonSuffix

    // Reuse unchanged nodes from prevDoc
    const children: Node[] = []
    for (let i = 0; i < firstLine; i++) children.push(prevDoc.child(i))
    for (let i = firstLine; i < lastNewLine; i++) {
      const line = newLines[i]
      children.push(schema.node('paragraph', null, line ? [schema.text(line)] : []))
    }
    for (let i = lastOldLine; i < prevDoc.childCount; i++) children.push(prevDoc.child(i))

    return schema.node('doc', null, children)
  },
})
```

### Advanced Usage (Range hint)

Return `{ doc, from, to, toB }` to skip the tree diff entirely. The bridge will use these positions directly for `tr.replace()`:

```ts
incrementalParse({ prevDoc, prevText, text, diff, schema }) {
  // ... same line-finding logic as above ...

  const doc = schema.node('doc', null, children)

  // Compute PM positions for the changed range
  let from = 0
  for (let i = 0; i < firstLine; i++) from += prevDoc.child(i).nodeSize
  let to = from
  for (let i = firstLine; i < lastOldLine; i++) to += prevDoc.child(i).nodeSize
  let toB = from
  for (let i = firstLine; i < lastNewLine; i++) toB += doc.child(i).nodeSize

  return { doc, from, to, toB }
}
```

### Return Values

| Return | Behavior |
|---|---|
| `null` | Fall back to full `parse` |
| `Node` | Bridge diffs against `prevDoc` via `findDiffStart`/`findDiffEnd` |
| `{ doc, from, to, toB }` | Bridge skips tree diff, uses positions directly |

---

## Combining Options

For maximum performance, combine all options:

```ts
const bridge = createViewBridge({
  schema, serialize, parse,
  incrementalParse: myIncrementalParser,
})

// In the CodeMirror update handler:
let prevText = bridge.extractText(view)

function onCmChange(newText: string, changeset: ChangeSet) {
  const diff = changeSetToDiff(changeset)
  bridge.applyText(view, newText, {
    diff,           // skip diffText O(n) scan
    normalized: true, // CM text has no \r
  })
  prevText = newText
}
```

---

## Benchmark Results

Measured on a single-character edit in the middle of a plain-text document. Each cell shows the median of 10 iterations.

### `applyText` latency (single-character edit)

| Size | No optimization | Cache only | Cache+Incr | +Diff | +Diff+Range |
|---|---|---|---|---|---|
| 1,000 lines | 1.6 ms | 1.3 ms | 0.5 ms | 0.4 ms | 0.5 ms |
| 5,000 lines | 3.5 ms | 2.9 ms | 1.7 ms | 1.2 ms | 1.4 ms |
| 10,000 lines | 4.5 ms | 5.8 ms | 4.1 ms | 2.6 ms | 2.1 ms |
| 50,000 lines | 23.4 ms | 23.3 ms | 19.9 ms | 13.3 ms | 20.5 ms |

**Columns explained:**

- **No optimization**: `parseCacheSize: 0`, no `incrementalParse`.
- **Cache only**: Default config (serialize cache + parse LRU + last-applied guard).
- **Cache+Incr**: Default config + `incrementalParse` hook.
- **+Diff**: Cache+Incr + `options.diff` (pre-computed).
- **+Diff+Range**: +Diff + `incrementalParse` returning `{ doc, from, to, toB }`.

### Echo loop (repeated identical text)

When the same text is applied repeatedly (e.g. CodeMirror echoing back a PM-originated change), the last-applied guard makes it essentially free:

| Size | Median |
|---|---|
| 1,000 lines | 0.0003 ms |
| 10,000 lines | 0.0002 ms |
| 50,000 lines | 0.0001 ms |

### Key Takeaways

1. **`incrementalParse` + `options.diff`** provides the best overall speedup. At 50k lines, this reduces latency from ~23 ms to ~13 ms (43% improvement).

2. **The range hint** (`{ doc, from, to, toB }`) shows minimal additional improvement because `findDiffStart`/`findDiffEnd` is already fast when incremental parse reuses unchanged `Node` references (shared identity makes the tree diff near-instant for the matching prefix/suffix).

3. **Echo loops are effectively free** thanks to the last-applied guard, regardless of document size.

4. **For most use cases**, the default config (serialize cache + parse LRU) is sufficient. Add `incrementalParse` only when dealing with documents larger than ~5,000 lines.

### Running the Benchmarks

```bash
npx vitest run packages/core/src/__tests__/bench-scale.test.ts
```
