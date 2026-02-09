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
