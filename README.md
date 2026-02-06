# ProseMirror Split Editor

Split editor demo with:
- Left pane: Markdown editor (`CodeMirror`)
- Right pane: WYSIWYG editor (`ProseMirror`)
- Bidirectional sync through `Unified`
- Multi-tab / multi-browser collaboration through `Yjs`

## Tech Roles

### CodeMirror
- Provides the Markdown editing UI.
- Emits plain Markdown text updates.

### ProseMirror
- Provides the WYSIWYG editing UI.
- Supports block handle drag-and-drop, slash menu, tables, and task items.

### Unified
- Converts Markdown -> ProseMirror doc (`remark-parse` + `remark-gfm` pipeline).
- Converts ProseMirror doc -> Markdown (`remark-stringify` + `remark-gfm` pipeline).
- This is the normalization bridge between left and right editors.

### Yjs
- Uses `Y.Text("markdown")` as shared collaborative state.
- `y-indexeddb` persists the doc locally.
- `y-webrtc` syncs edits across browser instances in real time.

## Data Flow

The app uses Markdown text in `Y.Text` as the shared source for collaboration.

```
+-------------------+          Markdown          +---------------------+
|   CodeMirror UI   | -------------------------> |      App Router      |
|  (Markdown pane)  | <------------------------- | (origin + observers) |
+-------------------+                             +----------+----------+
                                                            |
                                                            | shared state
                                                            v
                                                   +---------------------+
                                                   |   Y.Doc / Y.Text    |
                                                   |      "markdown"      |
                                                   +-----+-----------+----+
                                                         |           |
                                   local persistence ----+           +---- network sync
                                                         |           |
                                                         v           v
                                              +----------------+   +----------------+
                                              | y-indexeddb    |   |   y-webrtc     |
                                              +----------------+   +----------------+
                                                            ^
                                                            |
                                                            | Markdown
                          +---------------------+ <---------+
                          |      App Router      |
                          | (origin + observers) |
                          +----------+----------+
                                     |
                                     | Unified conversion
                                     v
                          +---------------------+
                          |   ProseMirror UI    |
                          |   (WYSIWYG pane)    |
                          +---------------------+
```

1. CodeMirror edit
- CodeMirror emits Markdown.
- App writes Markdown into `Y.Text` with origin `"markdown"`.
- Observer updates React state.
- WYSIWYG pane receives Markdown and re-renders ProseMirror via Unified.

2. ProseMirror edit
- ProseMirror transaction updates the doc.
- App extracts Markdown from ProseMirror via Unified.
- App writes Markdown into `Y.Text` with origin `"wysiwyg"`.
- Observer updates React state.
- Markdown pane receives the same Markdown text.

3. Remote edit (another browser/tab)
- Remote client updates the same Yjs room.
- Local observer receives Yjs update.
- Both panes update from shared Markdown.

## Sequence (ASCII)

```
CodeMirror edit:
CodeMirror -> App -> Y.Text("markdown") -> observer -> App -> Unified(md->pm) -> ProseMirror

ProseMirror edit:
ProseMirror -> Unified(pm->md) -> App -> Y.Text("markdown") -> observer -> App -> CodeMirror

Remote edit:
Browser A -> y-webrtc -> Browser B Y.Text -> observer -> App -> (CodeMirror + ProseMirror)
```

## Why not `y-prosemirror` / `y-codemirror.next` bindings?

This project intentionally keeps collaboration state in shared Markdown text (`Y.Text`) and uses Unified as the conversion layer.
That makes the dual-editor sync path explicit and easier to reason about for this architecture.

## Run

```bash
npm install
npm run dev
```

Open the same URL in two browsers (or profiles) to test Yjs real-time sync.

## Scripts

```bash
npm run lint
npm run test -- --run
npm run build
```

## Key Files

- `src/App.tsx`
  - Yjs setup (`Doc`, `IndexeddbPersistence`, `WebrtcProvider`)
  - Shared markdown observer and update routing

- `src/components/MarkdownPane.tsx`
  - CodeMirror Markdown pane

- `src/components/WysiwygPane.tsx`
  - ProseMirror view host
  - Slash menu UI and interactions

- `src/lib/prosemirrorEditor.ts`
  - ProseMirror state/plugins
  - Block handle drag/drop logic
  - Task checkbox click handling

- `src/lib/prosemirrorMarkdown.ts`
  - Unified-based Markdown <-> ProseMirror conversion

- `src/lib/prosemirrorSchema.ts`
  - ProseMirror schema extensions (task list, table, marks)
