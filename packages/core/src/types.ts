import type { Node, Schema } from 'prosemirror-model'

/** Converts a ProseMirror document to a serialized text string. */
export type Serialize = (doc: Node) => string

/** Parses a serialized text string into a ProseMirror document. */
export type Parse = (text: string, schema: Schema) => Node

/** Normalizes a text string (e.g. line endings). Default strips `\r`. */
export type Normalize = (text: string) => string

/** Known error codes emitted by the bridge. */
export type ErrorCode = 'parse-error' | 'serialize-error'

/** Structured error event for non-fatal errors (e.g. parse failures). */
export type ErrorEvent = {
  code: ErrorCode
  message: string
  cause: unknown
}

/**
 * Error handler callback for non-fatal errors (e.g. parse failures).
 *
 * Known codes:
 * - `'parse-error'` — failed to parse text into a ProseMirror document.
 * - `'serialize-error'` — failed to serialize a ProseMirror document to text.
 */
export type OnError = (event: ErrorEvent) => void

/** Describes the changed region between two text strings. */
export type TextDiff = {
  /** Byte offset where the two strings first differ. */
  start: number
  /** End of the changed region in the old (previous) text. */
  endA: number
  /** End of the changed region in the new (incoming) text. */
  endB: number
}

/**
 * Result of an incremental parse. Either a plain `Node` (the bridge will
 * diff against `prevDoc` to find changed positions), or an object with
 * pre-computed document positions so the bridge can skip tree diffing entirely.
 */
export type IncrementalParseResult =
  | Node
  | { doc: Node; from: number; to: number; toB: number }

/**
 * Optional incremental parser that re-parses only the changed region.
 *
 * Receives the previous document, previous/next text, and the text-level diff
 * computed by the library. Returns an {@link IncrementalParseResult}, or `null`
 * to fall back to the full {@link Parse} function.
 *
 * When the result includes document positions (`{ doc, from, to, toB }`),
 * the bridge skips `findDiffStart`/`findDiffEnd` entirely.
 */
export type IncrementalParse = (args: {
  prevDoc: Node
  prevText: string
  text: string
  diff: TextDiff
  schema: Schema
}) => IncrementalParseResult | null
