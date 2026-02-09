# @pm-cm/core

Bidirectional sync between ProseMirror and CodeMirror for split-editor UIs.

Keeps a WYSIWYG pane (ProseMirror) and a text pane (CodeMirror) in sync. The serialization format is pluggable — you provide `serialize` and `parse` functions (e.g. Markdown, AsciiDoc, plain text).

## Install

```
npm install @pm-cm/core prosemirror-model prosemirror-state prosemirror-view
```

## Usage

### View Bridge

Propagates changes between the ProseMirror pane and the CodeMirror pane.

```ts
import { createViewBridge } from '@pm-cm/core'

const bridge = createViewBridge({
  schema,     // ProseMirror Schema
  serialize,  // (doc: Node) => string
  parse,      // (text: string, schema: Schema) => Node
})

// CodeMirror changed → push into ProseMirror
bridge.applyText(pmView, cmValue)

// ProseMirror changed → pull for CodeMirror
const text = bridge.extractText(pmView)

// In dispatchTransaction, skip bridge-originated changes
function dispatchTransaction(tr: Transaction) {
  pmView.updateState(pmView.state.apply(tr))
  if (!bridge.isBridgeChange(tr) && tr.docChanged) {
    updateCodeMirror(bridge.extractText(pmView))
  }
}
```

### Cursor Mapping

Maps cursor positions between ProseMirror and CodeMirror.

```ts
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '@pm-cm/core'

const map = buildCursorMap(pmDoc, serialize)

// PM position → CM offset
const cmOffset = cursorMapLookup(map, pmPos)

// CM offset → PM position
const pmPos = reverseCursorMapLookup(map, cmOffset)
```

#### Limitations

- Uses `indexOf`-based forward matching: if the serializer transforms text (e.g. escaping, entity encoding), the mapping may be inaccurate.
- Segments with no text nodes (e.g. empty paragraphs, horizontal rules) produce no mapping entry and return `null`.
- Positions that fall between segments (inside serialization syntax like `**`, `- `, `| `) snap to the nearest text boundary.

## API

| Export | Description |
|---|---|
| `createViewBridge(config)` | Returns a `ViewBridgeHandle` with `applyText`, `extractText`, `isBridgeChange` |
| `createBoundViewBridge(view, config)` | Returns a `BoundViewBridgeHandle` — same as above but with the `EditorView` bound |
| `buildCursorMap(doc, serialize, locate?)` | Build a PM position ↔ CM offset mapping |
| `cursorMapLookup(map, pmPos)` | PM position → CM offset |
| `reverseCursorMapLookup(map, cmOffset)` | CM (CodeMirror) offset → PM position |
| `Serialize` | Type: `(doc: Node) => string` |
| `Parse` | Type: `(text: string, schema: Schema) => Node` |
| `Normalize` | Type: `(text: string) => string` |
| `OnError` | Type: `(context: string, error: unknown) => void` |
| `LocateText` | Type: `(serialized: string, nodeText: string, searchFrom: number) => number` |
| `ViewBridgeConfig` | `{ schema, serialize, parse, normalize?, onError? }` |
| `ViewBridgeHandle` | `{ applyText(view, text, options?): ApplyTextResult, extractText(view), isBridgeChange(tr) }` |
| `BoundViewBridgeHandle` | `{ applyText(text, options?), extractText(), isBridgeChange(tr), setView(view) }` |
| `ApplyTextOptions` | `{ addToHistory?: boolean }` |
| `ApplyTextResult` | `{ ok: true } \| { ok: false; reason: 'unchanged' \| 'parse-error' }` |
| `CursorMap` | `{ segments: TextSegment[], textLength, skippedNodes }` |
| `TextSegment` | `{ pmStart, pmEnd, textStart, textEnd }` |
