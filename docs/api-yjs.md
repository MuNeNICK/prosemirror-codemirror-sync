# @pm-cm/yjs API Reference

`@pm-cm/yjs` provides the Yjs collaborative layer: bridge sync between `Y.Text` and `Y.XmlFragment`, collab plugins, cursor sync, and awareness proxy.

## Yjs Bridge

### `createYjsBridge(config, options?): YjsBridgeHandle`

Create a collaborative bridge that keeps `Y.Text` and `Y.XmlFragment` in sync.

Runs a synchronous bootstrap to reconcile existing state, then installs a `Y.Text` observer for the text-to-ProseMirror direction.

```ts
import { createYjsBridge } from '@pm-cm/yjs'

const bridge = createYjsBridge({
  doc: ydoc,
  sharedText: ydoc.getText('text'),
  sharedProseMirror: ydoc.getXmlFragment('prosemirror'),
  schema,
  serialize,
  parse,
})

console.log(bridge.bootstrapResult.source)
// 'text' | 'prosemirror' | 'both-match' | 'empty' | 'initial'
```

#### `YjsBridgeConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `doc` | `Doc` | *required* | The `Y.Doc` instance. |
| `sharedText` | `YText` | *required* | The `Y.Text` shared type. |
| `sharedProseMirror` | `YXmlFragment` | *required* | The `Y.XmlFragment` shared type. |
| `schema` | `Schema` | *required* | ProseMirror schema. |
| `serialize` | `Serialize` | *required* | `(doc: Node) => string` |
| `parse` | `Parse` | *required* | `(text: string, schema: Schema) => Node` |
| `normalize` | `Normalize` | Strip `\r` | Text normalization function. |
| `onError` | `OnError` | `console.error` | Called on non-fatal errors. |

#### `YjsBridgeOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `initialText` | `string` | `''` | Text to use when both shared types are empty. |
| `prefer` | `'text' \| 'prosemirror'` | `'text'` | Which side wins when both exist and differ. |

#### `YjsBridgeHandle`

| Member | Type | Description |
|---|---|---|
| `bootstrapResult` | `BootstrapResult` | Result of the synchronous bootstrap phase. |
| `syncToSharedText(doc)` | `(Node) => ReplaceTextResult` | Serialize and push to `Y.Text` using minimal diff. |
| `isYjsSyncChange(tr)` | `(Transaction) => boolean` | Returns `true` if the transaction originated from y-prosemirror sync. |
| `dispose()` | `() => void` | Remove the `Y.Text` observer. Call when tearing down. |

#### `BootstrapResult`

| Field | Type | Description |
|---|---|---|
| `source` | `'text' \| 'prosemirror' \| 'both-match' \| 'empty' \| 'initial'` | Which source was used to initialize. |
| `parseError` | `boolean?` | `true` when format conversion failed during bootstrap. |

---

### `replaceSharedText(sharedText, next, origin, normalize?): ReplaceTextResult`

Replace `Y.Text` content using a minimal diff (common prefix/suffix trimming).

```ts
import { replaceSharedText } from '@pm-cm/yjs'

const result = replaceSharedText(sharedText, 'new text', 'my-origin')
```

#### `ReplaceTextResult`

```ts
| { ok: true }
| { ok: false; reason: 'unchanged' | 'detached' }
```

---

### `replaceSharedProseMirror(doc, fragment, text, origin, config): ReplaceProseMirrorResult`

Replace `Y.XmlFragment` by parsing text into a ProseMirror document. Uses incremental fragment update when possible, falling back to full replacement.

```ts
import { replaceSharedProseMirror } from '@pm-cm/yjs'

const result = replaceSharedProseMirror(ydoc, fragment, 'text', 'my-origin', {
  schema, parse, normalize, onError,
})
```

#### `ReplaceProseMirrorResult`

```ts
| { ok: true }
| { ok: false; reason: 'unchanged' | 'parse-error' | 'detached' }
```

---

## Collab Plugins

### `createCollabPlugins(schema, options): { plugins, doc, mapping }`

Bundle `ySyncPlugin`, `yCursorPlugin`, `yUndoPlugin` from y-prosemirror, plus optional PM-to-CM cursor sync and bridge sync plugins.

```ts
import { createCollabPlugins, createYjsBridge } from '@pm-cm/yjs'

const bridge = createYjsBridge({ /* ... */ })

const { plugins, doc, mapping } = createCollabPlugins(schema, {
  sharedProseMirror: ydoc.getXmlFragment('prosemirror'),
  awareness,
  bridge,           // optional: auto-wire PM doc changes to Y.Text
  cursorSync: true, // optional: enable PM<->CM cursor sync
  serialize,        // required when cursorSync: true
  sharedText,       // optional: broadcast CM-format cursors
})

const state = EditorState.create({ schema, doc, plugins })
```

#### `CollabPluginsOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `sharedProseMirror` | `YXmlFragment` | *required* | Shared PM document in Yjs. |
| `awareness` | `Awareness` | *required* | Yjs awareness instance. |
| `cursorFieldName` | `string` | `'pmCursor'` | Awareness field for PM cursor. |
| `serialize` | `Serialize` | `undefined` | Required when `cursorSync: true`. |
| `cmCursorFieldName` | `string` | `'cursor'` | Awareness field for CM/Y.Text cursor. |
| `locate` | `LocateText` | `undefined` | Custom text-location function. |
| `cursorSync` | `boolean` | `false` | Enable PM-to-CM cursor sync. |
| `sharedText` | `YText` | `undefined` | Enable CM-format cursor broadcasting. |
| `bridge` | `YjsBridgeHandle` | `undefined` | Auto-wire PM doc changes to Y.Text. |
| `yCursorPluginOpts` | `YCursorPluginOpts` | `{}` | Extra options for `yCursorPlugin`. |
| `yUndoPluginOpts` | `YUndoPluginOpts` | `{}` | Extra options for `yUndoPlugin`. |
| `onWarning` | `OnWarning` | `console.warn` | Warning callback. |

#### `ProseMirrorMapping`

```ts
type ProseMirrorMapping = Map<AbstractType<unknown>, Node | Node[]>
```

---

## Bridge Sync Plugin

### `createBridgeSyncPlugin(bridge, options?): Plugin`

ProseMirror plugin that automatically syncs PM doc changes to `Y.Text` via the bridge handle. Skips Yjs-originated changes to avoid loops.

```ts
import { createBridgeSyncPlugin, bridgeSyncPluginKey } from '@pm-cm/yjs'

const plugin = createBridgeSyncPlugin(bridge, { onWarning })
```

A warning is logged if the same bridge handle is wired to multiple plugin instances.

#### `BridgeSyncPluginOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `onSyncFailure` | `(result, view) => void` | `undefined` | Called when sync fails (detached). |
| `onWarning` | `OnWarning` | `console.warn` | Warning callback. |

---

## Cursor Sync Plugin

### `createCursorSyncPlugin(options): Plugin`

ProseMirror plugin that synchronizes cursor positions between PM and CM via Yjs awareness.

- **PM -> awareness**: automatically broadcasts when the PM view is focused and selection changes.
- **CM -> awareness**: triggered by dispatching `syncCmCursor`.

```ts
import { createCursorSyncPlugin, cursorSyncPluginKey } from '@pm-cm/yjs'

const plugin = createCursorSyncPlugin({
  awareness,
  serialize,
  sharedText,       // optional: broadcast CM-format cursors
  locate,           // optional: custom text-location function
})
```

#### `CursorSyncPluginOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `awareness` | `Awareness` | *required* | Yjs awareness instance. |
| `serialize` | `Serialize` | *required* | Serializer for cursor mapping. |
| `cursorFieldName` | `string` | `'pmCursor'` | Awareness field for PM cursor. |
| `cmCursorFieldName` | `string` | `'cursor'` | Awareness field for CM cursor. |
| `locate` | `LocateText` | `undefined` | Custom text-location function. |
| `sharedText` | `YText` | `undefined` | Enable CM-format cursor broadcasting. |
| `onWarning` | `OnWarning` | `console.warn` | Warning callback. |

#### `CursorSyncState`

| Field | Type | Description |
|---|---|---|
| `pendingCm` | `{ anchor, head } \| null` | Pending CM cursor to broadcast. |
| `mappedTextOffset` | `number \| null` | Text offset mapped from PM selection anchor. |

---

### `syncCmCursor(view, anchor, head?, onWarning?)`

Dispatch a CodeMirror cursor offset (or range) to the cursor sync plugin.

```ts
import { syncCmCursor } from '@pm-cm/yjs'

// Collapsed cursor at offset 42
syncCmCursor(view, 42)

// Range selection from 10 to 20
syncCmCursor(view, 10, 20)
```

Input values are sanitized: `Math.max(0, Math.floor(v))`.

---

## Awareness Proxy

### `createAwarenessProxy(awareness, cursorField?): Awareness`

Create a Proxy around a Yjs Awareness that suppresses the specified cursor field. This prevents y-prosemirror's built-in cursor management from conflicting with the PM-to-CM cursor sync plugin.

```ts
import { createAwarenessProxy } from '@pm-cm/yjs'

const proxiedAwareness = createAwarenessProxy(awareness, 'pmCursor')
```

Applied automatically by `createCollabPlugins` when `cursorSync: true`.

---

## Constants

| Constant | Value | Description |
|---|---|---|
| `ORIGIN_TEXT_TO_PM` | `'bridge:text-to-prosemirror'` | Yjs transaction origin: text -> PM. |
| `ORIGIN_PM_TO_TEXT` | `'bridge:prosemirror-to-text'` | Yjs transaction origin: PM -> text. |
| `ORIGIN_INIT` | `'bridge:init'` | Yjs transaction origin: bootstrap. |

---

## Warning Types

### `WarningEvent`

| Field | Type | Description |
|---|---|---|
| `code` | `WarningCode` | Warning identifier. |
| `message` | `string` | Human-readable description. |

### `WarningCode`

| Code | Meaning |
|---|---|
| `'bridge-already-wired'` | Same bridge handle wired to multiple plugin instances. |
| `'sync-failed'` | `syncToSharedText` failed (e.g. Y.Text detached). |
| `'ysync-plugin-missing'` | ySyncPlugin state unavailable; cursor broadcast skipped. |
| `'cursor-sync-not-installed'` | Cursor sync plugin not installed on the EditorView. |

---

## Re-exports from @pm-cm/core

The following are re-exported for convenience:

**Runtime:** `buildCursorMap`, `cursorMapLookup`, `reverseCursorMapLookup`

**Types:** `TextSegment`, `CursorMap`, `LocateText`, `Serialize`, `Parse`, `Normalize`, `OnError`, `ErrorCode`, `ErrorEvent`
