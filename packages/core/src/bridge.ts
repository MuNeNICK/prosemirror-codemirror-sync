import type { Node, Schema } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Normalize, Serialize, Parse, OnError } from './types.js'

const BRIDGE_META = 'pm-cm-bridge'
const defaultNormalize: Normalize = (s) => s.replace(/\r\n?/g, '\n')
const defaultOnError: OnError = (context, error) => console.error(`[bridge] ${context}`, error)

/** Configuration for {@link createViewBridge}. */
export type ViewBridgeConfig = {
  schema: Schema
  serialize: Serialize
  parse: Parse
  normalize?: Normalize
  /** Called on non-fatal errors (e.g. parse failures). Defaults to `console.error`. */
  onError?: OnError
}

/** Options for {@link ViewBridgeHandle.applyText}. */
export type ApplyTextOptions = {
  /** Set `false` to prevent the change from being added to undo history. Default `true`. */
  addToHistory?: boolean
}

/**
 * Discriminated-union result of {@link ViewBridgeHandle.applyText}.
 * `ok: true` when the text was applied; `ok: false` with a `reason` otherwise.
 */
export type ApplyTextResult =
  | { ok: true }
  | { ok: false; reason: 'unchanged' | 'parse-error' }

/** Handle returned by {@link createViewBridge}. */
export type ViewBridgeHandle = {
  /** Parse `text` and replace the ProseMirror document. Returns an {@link ApplyTextResult}. */
  applyText(view: EditorView, text: string, options?: ApplyTextOptions): ApplyTextResult
  /** Serialize the current ProseMirror document to text. */
  extractText(view: EditorView): string
  /** Returns `true` if the transaction was dispatched by {@link applyText}. */
  isBridgeChange(tr: Transaction): boolean
}

/** Handle returned by {@link createBoundViewBridge}. View is bound; no need to pass it each call. */
export type BoundViewBridgeHandle = {
  /** Parse `text` and replace the ProseMirror document. */
  applyText(text: string, options?: ApplyTextOptions): ApplyTextResult
  /** Serialize the current ProseMirror document to text. */
  extractText(): string
  /** Returns `true` if the transaction was dispatched by {@link applyText}. */
  isBridgeChange(tr: Transaction): boolean
  /** Replace the bound EditorView. */
  setView(view: EditorView): void
}

/**
 * Create a document-sync bridge between ProseMirror and a text editor.
 *
 * Returns a {@link ViewBridgeHandle} with methods to push/pull text and
 * detect bridge-originated transactions.
 */
export function createViewBridge(config: ViewBridgeConfig): ViewBridgeHandle {
  const { schema, serialize, parse } = config
  const normalize = config.normalize ?? defaultNormalize
  const onError = config.onError ?? defaultOnError

  return {
    applyText(view: EditorView, text: string, options?: ApplyTextOptions): ApplyTextResult {
      const incoming = normalize(text)
      const current = normalize(serialize(view.state.doc))

      if (incoming === current) {
        return { ok: false, reason: 'unchanged' }
      }

      let nextDoc: Node
      try {
        nextDoc = parse(incoming, schema)
      } catch (error) {
        onError('failed to parse text into ProseMirror document', error)
        return { ok: false, reason: 'parse-error' }
      }

      const tr = view.state.tr
      tr.replaceWith(0, tr.doc.content.size, nextDoc.content)
      tr.setMeta(BRIDGE_META, true)
      if (options?.addToHistory === false) {
        tr.setMeta('addToHistory', false)
      }
      view.dispatch(tr)
      return { ok: true }
    },

    extractText(view: EditorView): string {
      return serialize(view.state.doc)
    },

    isBridgeChange(tr: Transaction): boolean {
      return tr.getMeta(BRIDGE_META) === true
    },
  }
}

/**
 * Create a view-bound document-sync bridge. Wraps {@link createViewBridge}
 * so that the `EditorView` does not need to be passed to each method call.
 *
 * @param view - The initial EditorView to bind.
 * @param config - Configuration for the underlying bridge.
 */
export function createBoundViewBridge(view: EditorView, config: ViewBridgeConfig): BoundViewBridgeHandle {
  const inner = createViewBridge(config)
  let currentView = view

  return {
    applyText(text: string, options?: ApplyTextOptions): ApplyTextResult {
      return inner.applyText(currentView, text, options)
    },
    extractText(): string {
      return inner.extractText(currentView)
    },
    isBridgeChange(tr: Transaction): boolean {
      return inner.isBridgeChange(tr)
    },
    setView(v: EditorView): void {
      currentView = v
    },
  }
}
