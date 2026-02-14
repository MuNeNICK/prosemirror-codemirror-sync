import type { Node, Schema } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Normalize, Serialize, Parse, OnError, IncrementalParse, IncrementalParseResult, TextDiff } from './types.js'

const BRIDGE_META = 'pm-cm-bridge'
const DEFAULT_PARSE_CACHE_SIZE = 8
const defaultNormalize: Normalize = (s) => (s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n'))
const defaultOnError: OnError = (event) => console.error(`[bridge] ${event.code}: ${event.message}`, event.cause)

/** Compute the changed region between two strings. */
export function diffText(a: string, b: string): TextDiff {
  let start = 0
  const minLen = Math.min(a.length, b.length)
  while (start < minLen && a.charCodeAt(start) === b.charCodeAt(start)) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { start, endA, endB }
}

/** Simple LRU cache for parse results. */
class ParseLru {
  private map = new Map<string, Node>()
  private limit: number
  constructor(limit: number) {
    this.limit = limit
  }
  get(key: string): Node | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, value: Node): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) {
      const first = this.map.keys().next().value!
      this.map.delete(first)
    }
  }
}

/** Configuration for {@link createViewBridge}. */
export type ViewBridgeConfig = {
  schema: Schema
  serialize: Serialize
  parse: Parse
  normalize?: Normalize
  /** Called on non-fatal errors (e.g. parse failures). Defaults to `console.error`. */
  onError?: OnError
  /**
   * Optional incremental parser for large documents.
   * When provided, the bridge computes a text-level diff and passes it to this
   * function instead of calling the full {@link Parse}. Return `null` to fall
   * back to full parse.
   */
  incrementalParse?: IncrementalParse
  /** Maximum number of parse results to cache. Defaults to `8`. Set `0` to disable. */
  parseCacheSize?: number
}

/** Options for {@link ViewBridgeHandle.applyText}. */
export type ApplyTextOptions = {
  /** Set `false` to prevent the change from being added to undo history. Default `true`. */
  addToHistory?: boolean
  /**
   * Pre-computed text diff from the editor's change set.
   * When provided, skips the internal `diffText` O(n) scan.
   * The diff describes the changed region between the previous and incoming
   * **normalized** text.
   */
  diff?: TextDiff
  /**
   * Set `true` when the caller guarantees the text is already normalized
   * (no `\r` characters). Skips the `normalize` pass entirely.
   */
  normalized?: boolean
}

/**
 * Discriminated-union result of {@link ViewBridgeHandle.applyText}.
 * `ok: true` when the text was applied; `ok: false` with a `reason` otherwise.
 */
export type ApplyTextResult =
  | { ok: true }
  | { ok: false; reason: 'unchanged' | 'parse-error' | 'serialize-error' }

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
  const incrementalParse = config.incrementalParse ?? null
  const cacheSize = config.parseCacheSize ?? DEFAULT_PARSE_CACHE_SIZE

  // --- Serialize cache: keyed by immutable Node reference ---
  const serializeCache = new WeakMap<Node, string>()

  function cachedSerialize(doc: Node): string {
    let text = serializeCache.get(doc)
    if (text === undefined) {
      text = normalize(serialize(doc))
      serializeCache.set(doc, text)
    }
    return text
  }

  // --- Parse LRU cache ---
  const parseLru = cacheSize > 0 ? new ParseLru(cacheSize) : null

  function cachedParse(text: string): Node {
    if (parseLru) {
      const cached = parseLru.get(text)
      if (cached) return cached
    }
    const doc = parse(text, schema)
    if (parseLru) parseLru.set(text, doc)
    return doc
  }

  // --- Last-applied guard ---
  let lastDoc: Node | null = null
  let lastRaw: string | null = null
  let lastIncoming: string | null = null

  function markUnchanged(doc: Node, raw: string, incoming: string): ApplyTextResult {
    lastDoc = doc
    lastRaw = raw
    lastIncoming = incoming
    return { ok: false, reason: 'unchanged' }
  }

  return {
    applyText(view: EditorView, text: string, options?: ApplyTextOptions): ApplyTextResult {
      const prevDoc = view.state.doc

      // Fast path: same doc + same raw text reference as last call → skip normalize
      if (prevDoc === lastDoc && text === lastRaw) {
        return { ok: false, reason: 'unchanged' }
      }

      const incoming = options?.normalized ? text : normalize(text)

      // Fast path: same doc + same normalized text as last call
      if (prevDoc === lastDoc && incoming === lastIncoming) {
        lastRaw = text
        return { ok: false, reason: 'unchanged' }
      }

      // Serialize cache: avoid full tree walk when doc reference is unchanged
      let current: string
      try {
        current = cachedSerialize(prevDoc)
      } catch (error) {
        onError({ code: 'serialize-error', message: 'failed to serialize current ProseMirror document', cause: error })
        return { ok: false, reason: 'serialize-error' }
      }

      if (incoming === current) {
        return markUnchanged(prevDoc, text, incoming)
      }

      // --- Parse (with incremental and LRU cache) ---
      let nextDoc: Node
      let rangeHint: { from: number; to: number; toB: number } | null = null
      const diff = options?.diff ?? diffText(current, incoming)
      try {
        if (incrementalParse) {
          const result: IncrementalParseResult | null =
            incrementalParse({ prevDoc, prevText: current, text: incoming, diff, schema })
          if (result == null) {
            nextDoc = cachedParse(incoming)
          } else if ('doc' in result && 'from' in result) {
            nextDoc = result.doc
            rangeHint = { from: result.from, to: result.to, toB: result.toB }
          } else {
            nextDoc = result as Node
          }
        } else {
          nextDoc = cachedParse(incoming)
        }
      } catch (error) {
        onError({ code: 'parse-error', message: 'failed to parse text into ProseMirror document', cause: error })
        return { ok: false, reason: 'parse-error' }
      }

      // Determine the changed document range.
      // If incrementalParse provided positions, skip the O(n) tree diff.
      let from: number, to: number, toB: number
      if (rangeHint) {
        from = rangeHint.from
        to = rangeHint.to
        toB = rangeHint.toB
      } else {
        const start = prevDoc.content.findDiffStart(nextDoc.content)
        if (start == null) {
          return markUnchanged(prevDoc, text, incoming)
        }
        const end = prevDoc.content.findDiffEnd(nextDoc.content)
        if (!end) {
          return markUnchanged(prevDoc, text, incoming)
        }
        from = Math.min(start, end.a)
        to = Math.max(start, end.a)
        toB = Math.max(start, end.b)
      }

      const tr = view.state.tr
      tr.replace(from, to, nextDoc.slice(from, toB))
      tr.setMeta(BRIDGE_META, true)
      if (options?.addToHistory === false) {
        tr.setMeta('addToHistory', false)
      }
      view.dispatch(tr)

      // Update last-applied guard after successful dispatch.
      // Do NOT pre-populate serializeCache: appendTransaction plugins may
      // have further modified the doc, making `incoming` inaccurate.
      const newDoc = view.state.doc
      lastDoc = newDoc
      lastRaw = text
      lastIncoming = incoming

      return { ok: true }
    },

    extractText(view: EditorView): string {
      let text: string
      try {
        text = serialize(view.state.doc)
      } catch (error) {
        onError({ code: 'serialize-error', message: 'failed to serialize ProseMirror document in extractText', cause: error })
        throw error
      }
      serializeCache.set(view.state.doc, normalize(text))
      return text
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
