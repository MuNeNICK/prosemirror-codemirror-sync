# @pm-cm

Middleware for bidirectional synchronization between ProseMirror and CodeMirror.

## Motivation

Split-editor UIs — WYSIWYG on one side, text on the other — require keeping two fundamentally different editor models in sync. ProseMirror operates on a tree-structured document, while CodeMirror operates on a flat string. This library bridges the gap:

- **Document sync**: Propagates text edits to ProseMirror and vice versa, preventing infinite update loops.
- **Cursor mapping**: Translates cursor positions between ProseMirror's tree-based coordinate system and CodeMirror's character offsets.
- **Collaborative cursor sync**: Broadcasts cursor positions from either editor to Yjs awareness, so remote participants see a unified cursor regardless of which pane is being edited.

You provide the `serialize` and `parse` functions. Any text serialization format works — Markdown (via Unified/remark, markdown-it, etc.), AsciiDoc, reStructuredText, or plain text.

## Packages

### `@pm-cm/core`

Document sync bridge and cursor mapping between ProseMirror and CodeMirror.

```
npm install @pm-cm/core
```

#### Document sync

```ts
import { createViewBridge } from '@pm-cm/core'

const bridge = createViewBridge({
  schema,     // ProseMirror Schema
  serialize,  // (doc: Node) => string
  parse,      // (text: string, schema: Schema) => Node
})

// CM changed → push into PM
bridge.applyText(pmView, newText)

// PM changed → pull for CM
const text = bridge.extractText(pmView)

// In dispatchTransaction, detect bridge-originated changes
if (tr.docChanged && !bridge.isBridgeChange(tr)) {
  updateCodeMirror(bridge.extractText(pmView))
}
```

`applyText` compares the incoming text against the current document to avoid redundant dispatches. It tags its own transactions via ProseMirror meta, so `isBridgeChange` lets you skip the reverse direction and prevent loops.

#### Cursor mapping

```ts
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '@pm-cm/core'

const map = buildCursorMap(doc, serialize)

// PM position → CM offset
const cmOffset = cursorMapLookup(map, pmPos)

// CM offset → PM position
const pmPos = reverseCursorMapLookup(map, cmOffset)
```

`buildCursorMap` walks the ProseMirror document tree and aligns each text node against the serialized string, producing a sorted list of `TextSegment`s. Lookups use binary search — O(log n) per query. Positions that fall between segments (inside serialization syntax like `**`, `- `, `| `) snap to the nearest text boundary.

**Limitations**: The mapping uses `indexOf`-based forward matching — if the serializer transforms text (e.g. escaping, entity encoding), results may be inaccurate. Segments with no text nodes return `null`.

### `@pm-cm/yjs`

Collaborative document sync and cursor sync over Yjs. Built on top of `@pm-cm/core`.

```
npm install @pm-cm/yjs @pm-cm/core yjs y-prosemirror y-protocols
```

#### Source of truth

The Yjs bridge maintains two shared types within a single `Y.Doc`:

- `Y.Text` — serialized text string. **This is the source of truth.** CodeMirror binds to it directly via `y-codemirror.next`.
- `Y.XmlFragment` — ProseMirror document. Derived from `Y.Text` by the bridge. ProseMirror binds to it via `y-prosemirror`.

When both sides exist and conflict, the text side wins: the bridge parses `Y.Text` to ProseMirror and overwrites `Y.XmlFragment`.

#### Yjs bridge

```ts
import { Doc } from 'yjs'
import { createYjsBridge } from '@pm-cm/yjs'

const doc = new Doc()

const bridge = createYjsBridge({
  doc,
  sharedText: doc.getText('text'),
  sharedProseMirror: doc.getXmlFragment('prosemirror'),
  schema,
  serialize,
  parse,
})

// After a PM edit, push to Y.Text (source of truth):
bridge.syncToSharedText(view.state.doc)

// Y.Text → Y.XmlFragment direction is automatic (Y.Text observer).

bridge.dispose()
```

On creation, the bridge runs a synchronous bootstrap that reconciles whatever state already exists in the Yjs doc (one side empty, both empty, both populated). After bootstrap, a `Y.Text` observer automatically converts text changes to ProseMirror. The reverse direction (`syncToSharedText`) is called explicitly from `dispatchTransaction`.

Updates to `Y.Text` use minimal diffs (common prefix/suffix trimming) to preserve Yjs history and minimize network traffic.

#### Collab plugins

`createCollabPlugins` bundles `ySyncPlugin`, `yCursorPlugin`, and `yUndoPlugin` from `y-prosemirror`, plus an optional cursor sync plugin:

```ts
import { createCollabPlugins, syncCmCursor } from '@pm-cm/yjs'

const { plugins, doc: pmDoc } = createCollabPlugins(schema, {
  sharedProseMirror: xmlFragment,
  awareness,
  serialize,   // pass to enable PM ↔ CM cursor sync
  cursorSync: true,
})

const view = new EditorView(element, {
  state: EditorState.create({ schema, doc: pmDoc, plugins }),
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr))
    if (tr.docChanged && !bridge.isYjsSyncChange(tr)) {
      bridge.syncToSharedText(view.state.doc)
    }
  },
})

// CM cursor → PM awareness (one call)
syncCmCursor(view, cmOffset)

// PM cursor → awareness is automatic when the PM view is focused.
```

The cursor sync plugin uses `buildCursorMap` (from `@pm-cm/core`) to convert CM offsets to PM positions, then broadcasts via `absolutePositionToRelativePosition` to Yjs awareness. An awareness proxy (`createAwarenessProxy`) suppresses `y-prosemirror`'s built-in cursor management so it doesn't conflict.

## API Reference

### @pm-cm/core

| Export | Type | Description |
|---|---|---|
| `createViewBridge(config)` | `(ViewBridgeConfig) => ViewBridgeHandle` | Create a document sync bridge |
| `createBoundViewBridge(view, config)` | `(EditorView, ViewBridgeConfig) => BoundViewBridgeHandle` | Create a view-bound bridge (no `view` param needed on methods) |
| `buildCursorMap(doc, serialize, locate?)` | `(Node, Serialize, LocateText?) => CursorMap` | Build PM ↔ CM cursor position mapping |
| `cursorMapLookup(map, pmPos)` | `(CursorMap, number) => number \| null` | PM position → CM offset |
| `reverseCursorMapLookup(map, cmOffset)` | `(CursorMap, number) => number \| null` | CM offset → PM position |

**Types**

| Type | Signature |
|---|---|
| `Serialize` | `(doc: Node) => string` |
| `Parse` | `(text: string, schema: Schema) => Node` |
| `Normalize` | `(text: string) => string` |
| `ViewBridgeConfig` | `{ schema, serialize, parse, normalize?, onError? }` |
| `ViewBridgeHandle` | `{ applyText(view, text, options?): ApplyTextResult, extractText(view), isBridgeChange(tr) }` |
| `BoundViewBridgeHandle` | `{ applyText(text, options?): ApplyTextResult, extractText(): string, isBridgeChange(tr): boolean }` |
| `LocateText` | `(serialized: string, nodeText: string, searchFrom: number) => number` |
| `ApplyTextOptions` | `{ addToHistory?: boolean }` |
| `ApplyTextResult` | `{ ok: true } \| { ok: false; reason: 'unchanged' \| 'parse-error' }` |
| `OnError` | `(context: string, error: unknown) => void` |
| `CursorMap` | `{ segments: TextSegment[], textLength: number, skippedNodes: number }` |
| `TextSegment` | `{ pmStart, pmEnd, textStart, textEnd }` |

### @pm-cm/yjs

| Export | Type | Description |
|---|---|---|
| `createYjsBridge(config, options?)` | `(YjsBridgeConfig, YjsBridgeOptions?) => YjsBridgeHandle` | Create a collaborative bridge. Throws on doc mismatch |
| `replaceSharedText(text, next, origin, normalize?)` | `(YText, string, unknown, Normalize?) => ReplaceTextResult` | Minimal-diff replace of `Y.Text` |
| `replaceSharedProseMirror(doc, fragment, text, origin, config)` | `=> ReplaceProseMirrorResult` | Replace `Y.XmlFragment` from serialized text |
| `createCollabPlugins(schema, options)` | `(Schema, CollabPluginsOptions) => { plugins, doc, mapping }` | Bundle Yjs + cursor sync plugins. Throws if `cursorSync: true` without `serialize` |
| `createAwarenessProxy(awareness, cursorFieldName?)` | `(Awareness, string?) => Awareness` | Suppress y-prosemirror auto cursor |
| `createBridgeSyncPlugin(bridge)` | `(YjsBridgeHandle) => Plugin` | Auto-wire PM doc changes → `bridge.syncToSharedText()` |
| `createCursorSyncPlugin(options)` | `(CursorSyncPluginOptions) => Plugin` | PM ↔ CM cursor sync plugin |
| `syncCmCursor(view, anchor, head?)` | `(EditorView, number, number?) => void` | Dispatch CM cursor (or range) to sync plugin |
| `cursorSyncPluginKey` | `PluginKey<CursorSyncState>` | Plugin key for cursor sync state |
| `bridgeSyncPluginKey` | `PluginKey` | Plugin key for bridge sync |
| `ORIGIN_TEXT_TO_PM`, `ORIGIN_PM_TO_TEXT`, `ORIGIN_INIT` | `string` | Transaction origin constants |

**Types**

| Type | Signature |
|---|---|
| `YjsBridgeConfig` | `{ doc, sharedText, sharedProseMirror, schema, serialize, parse, normalize?, onError? }` |
| `YjsBridgeHandle` | `{ bootstrapResult, syncToSharedText(doc): ReplaceTextResult, isYjsSyncChange(tr), dispose() }` |
| `YjsBridgeOptions` | `{ initialText?, prefer? }` |
| `BootstrapResult` | `{ source: 'text' \| 'prosemirror' \| 'both-match' \| 'empty' \| 'initial', parseError?: boolean }` |
| `CollabPluginsOptions` | `{ sharedProseMirror, awareness, cursorFieldName?, serialize?, locate?, cursorSync?, sharedText?, bridge?, yCursorPluginOpts?, yUndoPluginOpts?, onWarning? }` |
| `ReplaceTextResult` | `{ ok: true } \| { ok: false; reason: 'unchanged' \| 'detached' }` |
| `ReplaceProseMirrorResult` | `{ ok: true } \| { ok: false; reason: 'parse-error' }` |
| `ReplaceResult` | `ReplaceTextResult \| ReplaceProseMirrorResult` |
| `OnError` | `(context: string, error: unknown) => void` |
| `ProseMirrorMapping` | `Map<AbstractType<any>, Node \| Node[]>` |
| `BoundViewBridgeHandle` | `{ applyText(text, options?), extractText(), isBridgeChange(tr) }` |
| `CursorSyncPluginOptions` | `{ awareness, serialize, cursorFieldName?, cmCursorFieldName?, locate?, sharedText?, onWarning? }` |
| `CursorSyncState` | `{ pendingCm, mappedTextOffset }` |

## Demo App

This repo includes a demo app (`src/`) with two pages:

| Route | Description |
|---|---|
| `/` | Split editor using `@pm-cm/core` |
| `/yjs` | Two simulated collaborative clients using `@pm-cm/yjs` |

```bash
npm install
npm run dev
```

## Scripts

```bash
npm run dev          # start dev server
npm run build        # type-check + production build
npm run test         # run tests
npm run lint         # eslint
```
