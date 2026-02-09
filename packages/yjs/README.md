# @pm-cm/yjs

Collaborative split-editor sync between ProseMirror and CodeMirror over Yjs.

[Demo](https://munenick.github.io/prosemirror-codemirror-sync/#/yjs)

Extends `@pm-cm/core` with real-time collaboration: synchronizes a ProseMirror `XmlFragment` and a CodeMirror-friendly `Y.Text` through a single Yjs `Doc`, with collaborative cursor support. The serialization format is pluggable — you provide `serialize` and `parse` functions.

## Install

```
npm install @pm-cm/yjs @pm-cm/core yjs y-prosemirror y-protocols prosemirror-model prosemirror-state prosemirror-view
```

## Usage

### 1. Document sync (Bridge)

Keeps `Y.Text` (CodeMirror) and `Y.XmlFragment` (ProseMirror) in sync within a single Yjs doc.

```ts
import { Doc } from 'yjs'
import { createYjsBridge } from '@pm-cm/yjs'

const doc = new Doc()

const bridge = createYjsBridge({
  doc,
  sharedText: doc.getText('text'),
  sharedProseMirror: doc.getXmlFragment('prosemirror'),
  schema,      // ProseMirror Schema
  serialize,   // (doc: Node) => string
  parse,       // (text: string, schema: Schema) => Node
})

// bootstrapResult tells you how the bridge initialized
console.log(bridge.bootstrapResult.source) // 'text' | 'prosemirror' | 'both-match' | 'empty' | 'initial'

// After a ProseMirror edit, push to the CodeMirror side:
bridge.syncToSharedText(editorView.state.doc)

// CodeMirror → ProseMirror direction is automatic (Y.Text observer).

bridge.dispose() // cleanup
```

### 2. Collaborative editing with cursor sync

`createCollabPlugins` returns ProseMirror plugins for Yjs sync, remote cursors, and undo. Pass `serialize` and `cursorSync: true` to additionally enable PM ↔ CM cursor synchronization.

```ts
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Awareness } from 'y-protocols/awareness'
import { Doc } from 'yjs'
import { createYjsBridge, createCollabPlugins, syncCmCursor } from '@pm-cm/yjs'

const doc = new Doc()
const awareness = new Awareness(doc)
const xmlFragment = doc.getXmlFragment('prosemirror')

const bridge = createYjsBridge({
  doc,
  sharedText: doc.getText('text'),
  sharedProseMirror: xmlFragment,
  schema,
  serialize,
  parse,
})

// Setup ProseMirror with collab + cursor sync plugins
const { plugins, doc: pmDoc } = createCollabPlugins(schema, {
  sharedProseMirror: xmlFragment,
  awareness,
  serialize,
  cursorSync: true, // opt-in (default false)
  bridge,           // auto-wires PM doc changes → Y.Text
})

const view = new EditorView(element, {
  state: EditorState.create({ schema, doc: pmDoc, plugins }),
})

// PM cursor → awareness is automatic (plugin handles it).

// CM cursor → awareness: one line.
syncCmCursor(view, cmOffset)
```

## API

### Bridge

| Export | Description |
|---|---|
| `createYjsBridge(config, options?)` | Create a bridge that keeps `Y.Text` (CM) and `Y.XmlFragment` (PM) in sync. Throws if shared types are detached or belong to a different `Y.Doc` |
| `replaceSharedText(sharedText, next, origin, normalize?)` | Minimal-diff replace of `Y.Text` content. Returns `ReplaceTextResult` |
| `replaceSharedProseMirror(doc, fragment, text, origin, config)` | Replace `Y.XmlFragment` from serialized text. Returns `ReplaceProseMirrorResult` |

### Bridge Sync Plugin

| Export | Description |
|---|---|
| `createBridgeSyncPlugin(bridge, options?)` | ProseMirror plugin that auto-wires PM doc changes → `bridge.syncToSharedText()` |
| `bridgeSyncPluginKey` | `PluginKey` for the bridge sync plugin |

### Collab Plugins

| Export | Description |
|---|---|
| `createCollabPlugins(schema, options)` | Returns `{ plugins, doc, mapping }`. Bundles `ySyncPlugin`, `yCursorPlugin`, `yUndoPlugin`, and optionally cursor sync. `cursorSync` defaults to `false`. **Throws** if `cursorSync: true` but `serialize` is not provided |
| `createAwarenessProxy(awareness, cursorFieldName?)` | Proxy that suppresses y-prosemirror's auto cursor management |

### Cursor Sync

| Export | Description |
|---|---|
| `createCursorSyncPlugin(options)` | ProseMirror plugin: PM selection → awareness (auto), CM offset → awareness (via meta) |
| `syncCmCursor(view, anchor, head?, onWarning?)` | Dispatch a CM cursor offset (or range) to the cursor sync plugin. Input values are floored to non-negative integers |
| `cursorSyncPluginKey` | `PluginKey<CursorSyncState>` for reading plugin state |

### Cursor Mapping (re-exported from @pm-cm/core)

| Export | Description |
|---|---|
| `buildCursorMap(doc, serialize, locate?)` | Build a PM position ↔ CM offset mapping |
| `cursorMapLookup(map, pmPos)` | PM position → CM offset |
| `reverseCursorMapLookup(map, cmOffset)` | CM offset → PM position |

### Constants

| Export | Value |
|---|---|
| `ORIGIN_TEXT_TO_PM` | `'bridge:text-to-prosemirror'` |
| `ORIGIN_PM_TO_TEXT` | `'bridge:prosemirror-to-text'` |
| `ORIGIN_INIT` | `'bridge:init'` |

### Types

| Type | Description |
|---|---|
| `YjsBridgeConfig` | Config for `createYjsBridge` — uses `sharedProseMirror` (capital M) |
| `YjsBridgeHandle` | Handle returned by `createYjsBridge` — includes `bootstrapResult` |
| `YjsBridgeOptions` | Options for `createYjsBridge` (`initialText?`, `prefer?`) |
| `BootstrapResult` | `{ source: 'text' \| 'prosemirror' \| 'both-match' \| 'empty' \| 'initial', parseError?: boolean }` |
| `CollabPluginsOptions` | Options for `createCollabPlugins` — uses `sharedProseMirror` (capital M) |
| `CursorSyncPluginOptions` | Options for `createCursorSyncPlugin` |
| `CursorSyncState` | Plugin state: `{ pendingCm, mappedTextOffset }` |
| `ReplaceResult` | Union: `ReplaceTextResult \| ReplaceProseMirrorResult` |
| `ReplaceTextResult` | `{ ok: true } \| { ok: false; reason: 'unchanged' \| 'detached' }` |
| `ReplaceProseMirrorResult` | `{ ok: true } \| { ok: false; reason: 'parse-error' \| 'detached' }` |
| `YCursorPluginOpts` | Typed options for `yCursorPlugin` (`awarenessStateFilter`, `cursorBuilder`, `selectionBuilder`, `getSelection`) |
| `YUndoPluginOpts` | Typed options for `yUndoPlugin` (`protectedNodes`, `trackedOrigins`, `undoManager`) |
| `ProseMirrorMapping` | `Map<AbstractType<unknown>, Node \| Node[]>` — Yjs ↔ PM node mapping |
| `ErrorCode` | `'parse-error' \| 'serialize-error'` — re-exported from `@pm-cm/core` |
| `ErrorEvent` | `{ code: ErrorCode, message: string, cause: unknown }` — structured error event |
| `OnError` | `(event: ErrorEvent) => void` — re-exported from `@pm-cm/core` |
| `WarningCode` | `'bridge-already-wired' \| 'sync-failed' \| 'ysync-plugin-missing' \| 'cursor-sync-not-installed'` |
| `WarningEvent` | `{ code: WarningCode, message: string }` — structured warning event |
| `OnWarning` | `(event: WarningEvent) => void` — warning handler callback |
| `Serialize`, `Parse`, `Normalize` | Re-exported from `@pm-cm/core` |
| `TextSegment`, `CursorMap`, `LocateText` | Re-exported from `@pm-cm/core` |

### Compatibility

This package depends on internal state shapes of `y-prosemirror` (specifically `ySyncPluginKey` state and transaction meta). These internals are accessed via runtime type guards that degrade gracefully (returning `null` / logging a warning) when the expected shape is absent. The tested and supported version is `y-prosemirror@^1.3.7`.
