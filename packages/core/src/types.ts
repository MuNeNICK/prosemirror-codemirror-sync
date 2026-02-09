import type { Node, Schema } from 'prosemirror-model'

/** Converts a ProseMirror document to a serialized text string. */
export type Serialize = (doc: Node) => string

/** Parses a serialized text string into a ProseMirror document. */
export type Parse = (text: string, schema: Schema) => Node

/** Normalizes a text string (e.g. line endings). Default strips `\r`. */
export type Normalize = (text: string) => string

/**
 * Error handler callback for non-fatal errors (e.g. parse failures).
 * @param context - A short label identifying where the error occurred.
 * @param error - The original error value.
 */
export type OnError = (context: string, error: unknown) => void
