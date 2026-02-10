# @pm-cm/core API Reference

`@pm-cm/core` provides the format-agnostic bridge between ProseMirror and a text editor (e.g. CodeMirror), plus cursor mapping utilities.

## Document Bridge

### `createViewBridge(config): ViewBridgeHandle`

Create a document-sync bridge between ProseMirror and a text editor.

```ts
import { createViewBridge } from '@pm-cm/core'

const bridge = createViewBridge({
  schema,
  serialize: (doc) => markdownSerializer.serialize(doc),
  parse: (text, schema) => markdownParser.parse(text),
})
```

#### `ViewBridgeConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `schema` | `Schema` | *required* | ProseMirror schema. |
| `serialize` | `Serialize` | *required* | `(doc: Node) => string` |
| `parse` | `Parse` | *required* | `(text: string, schema: Schema) => Node` |
| `normalize` | `Normalize` | Strip `\r` | `(text: string) => string` |
| `onError` | `OnError` | `console.error` | Called on non-fatal errors (e.g. parse failures). |
| `incrementalParse` | `IncrementalParse` | `undefined` | Optional incremental parser for large documents. See [Performance Guide](./performance.md). |
| `parseCacheSize` | `number` | `8` | Max parse results to cache (LRU). Set `0` to disable. |

#### `ViewBridgeHandle`

| Method | Signature | Description |
|---|---|---|
| `applyText` | `(view, text, options?) => ApplyTextResult` | Parse text and replace the PM document. |
| `extractText` | `(view) => string` | Serialize the current PM document to text. |
| `isBridgeChange` | `(tr) => boolean` | Returns `true` if the transaction was dispatched by `applyText`. |

#### `ApplyTextOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `addToHistory` | `boolean` | `true` | Set `false` to prevent the change from being added to undo history. |
| `diff` | `TextDiff` | Auto-computed | Pre-computed text diff. Skips internal `diffText` O(n) scan. |
| `normalized` | `boolean` | `false` | Set `true` when input is already normalized (no `\r`). Skips normalize pass. |

#### `ApplyTextResult`

Discriminated union:

```ts
| { ok: true }
| { ok: false; reason: 'unchanged' | 'parse-error' }
```

---

### `createBoundViewBridge(view, config): BoundViewBridgeHandle`

Wraps `createViewBridge` so the `EditorView` does not need to be passed to each method call.

```ts
import { createBoundViewBridge } from '@pm-cm/core'

const bridge = createBoundViewBridge(view, { schema, serialize, parse })

bridge.applyText('new text')        // no view argument
bridge.extractText()                // no view argument
bridge.setView(newView)             // replace the bound view
```

#### `BoundViewBridgeHandle`

| Method | Signature | Description |
|---|---|---|
| `applyText` | `(text, options?) => ApplyTextResult` | Parse text and replace the PM document. |
| `extractText` | `() => string` | Serialize the current PM document to text. |
| `isBridgeChange` | `(tr) => boolean` | Returns `true` if the transaction was dispatched by `applyText`. |
| `setView` | `(view) => void` | Replace the bound EditorView. |

---

### `diffText(a, b): TextDiff`

Compute the changed region between two strings. Returns `{ start, endA, endB }`.

```ts
import { diffText } from '@pm-cm/core'

const diff = diffText('hello world', 'hello WORLD')
// { start: 6, endA: 11, endB: 11 }
```

#### `TextDiff`

| Field | Type | Description |
|---|---|---|
| `start` | `number` | Byte offset where the two strings first differ. |
| `endA` | `number` | End of the changed region in the old text. |
| `endB` | `number` | End of the changed region in the new text. |

---

## Cursor Mapping

### `buildCursorMap(doc, serialize, locate?): CursorMap`

Build a cursor map that aligns ProseMirror positions with serialized-text offsets.

Walks the document tree and locates each text node within the serialized output, producing a sorted list of `TextSegment`s.

```ts
import { buildCursorMap } from '@pm-cm/core'

const map = buildCursorMap(doc, serialize)
// map.segments: TextSegment[]
// map.textLength: number
// map.skippedNodes: number
```

#### `CursorMap`

| Field | Type | Description |
|---|---|---|
| `segments` | `TextSegment[]` | Sorted list of PM position / text offset mappings. |
| `textLength` | `number` | Total length of the serialized text. |
| `skippedNodes` | `number` | Number of text nodes that could not be located. |

#### `TextSegment`

| Field | Type | Description |
|---|---|---|
| `pmStart` | `number` | PM position (inclusive). |
| `pmEnd` | `number` | PM position (exclusive). |
| `textStart` | `number` | Text offset (inclusive). |
| `textEnd` | `number` | Text offset (exclusive). |

---

### `cursorMapLookup(map, pmPos): number | null`

Look up a ProseMirror position and return the corresponding text offset. O(log n) binary search.

```ts
import { cursorMapLookup } from '@pm-cm/core'

const textOffset = cursorMapLookup(map, pmPos)
```

---

### `reverseCursorMapLookup(map, cmOffset): number | null`

Look up a text offset (e.g. CodeMirror position) and return the corresponding ProseMirror position. O(log n) binary search.

```ts
import { reverseCursorMapLookup } from '@pm-cm/core'

const pmPos = reverseCursorMapLookup(map, cmOffset)
```

---

### `LocateText`

Custom text-location function for `buildCursorMap`. Default is `indexOf`.

```ts
type LocateText = (
  serialized: string,
  nodeText: string,
  searchFrom: number,
  context?: LocateTextContext,
) => number  // return -1 if not found
```

#### `LocateTextContext`

Structural context passed to `LocateText` for disambiguation:

| Field | Type | Description |
|---|---|---|
| `pmStart` | `number` | PM position of this text node. |
| `pmPath` | `readonly number[]` | Child-index path from doc root. |
| `parentType` | `string \| null` | Parent node type name. |
| `indexInParent` | `number` | Index among parent's children. |
| `prevSiblingText` | `string \| null` | Previous sibling's text content. |
| `nextSiblingText` | `string \| null` | Next sibling's text content. |
| `textNodeOrdinal` | `number` | 0-based ordinal in document walk order. |

---

## Types

### Function Types

| Type | Signature | Description |
|---|---|---|
| `Serialize` | `(doc: Node) => string` | Converts a PM document to text. |
| `Parse` | `(text: string, schema: Schema) => Node` | Parses text into a PM document. |
| `Normalize` | `(text: string) => string` | Normalizes text (e.g. line endings). |
| `OnError` | `(event: ErrorEvent) => void` | Error handler. |
| `IncrementalParse` | `(args) => IncrementalParseResult \| null` | Optional incremental parser. |

### `ErrorEvent`

| Field | Type | Description |
|---|---|---|
| `code` | `ErrorCode` | `'parse-error' \| 'serialize-error'` |
| `message` | `string` | Human-readable description. |
| `cause` | `unknown` | Original error. |

### `IncrementalParse`

```ts
type IncrementalParse = (args: {
  prevDoc: Node
  prevText: string
  text: string
  diff: TextDiff
  schema: Schema
}) => IncrementalParseResult | null
```

### `IncrementalParseResult`

```ts
type IncrementalParseResult =
  | Node                                          // bridge will diff against prevDoc
  | { doc: Node; from: number; to: number; toB: number }  // skip tree diff entirely
```
