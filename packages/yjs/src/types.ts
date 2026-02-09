import type { Node, Schema } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import type { Serialize, Parse, Normalize, OnError } from '@pm-cm/core'
import type { Doc, Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import type { ReplaceTextResult } from './bridge.js'

/** Known warning codes emitted by the yjs bridge and plugins. */
export type WarningCode = 'bridge-already-wired' | 'sync-failed' | 'ysync-plugin-missing' | 'cursor-sync-not-installed'

/** Structured warning event for non-fatal warnings. */
export type WarningEvent = {
  code: WarningCode
  message: string
}

/**
 * Warning handler callback for non-fatal warnings.
 *
 * Known codes:
 * - `'bridge-already-wired'` — the same bridge handle is wired to multiple plugin instances.
 * - `'sync-failed'` — `syncToSharedText` failed (e.g. Y.Text detached).
 * - `'ysync-plugin-missing'` — ySyncPlugin state is not available; cursor broadcast skipped.
 * - `'cursor-sync-not-installed'` — cursor sync plugin is not installed on the EditorView.
 */
export type OnWarning = (event: WarningEvent) => void

/** Yjs transaction origin: text → ProseMirror direction. */
export const ORIGIN_TEXT_TO_PM = 'bridge:text-to-prosemirror'

/** Yjs transaction origin: ProseMirror → text direction. */
export const ORIGIN_PM_TO_TEXT = 'bridge:prosemirror-to-text'

/** Yjs transaction origin: bootstrap initialization. */
export const ORIGIN_INIT = 'bridge:init'

/** Configuration for {@link createYjsBridge}. */
export type YjsBridgeConfig = {
  doc: Doc
  sharedText: YText
  sharedProseMirror: YXmlFragment
  schema: Schema
  serialize: Serialize
  parse: Parse
  normalize?: Normalize
  /** Called on non-fatal errors (e.g. parse failures). Defaults to `console.error`. */
  onError?: OnError
}

/**
 * Result of the bootstrap phase in {@link createYjsBridge}.
 * Indicates which source was used to initialize the shared types.
 */
export type BootstrapResult = {
  source: 'text' | 'prosemirror' | 'both-match' | 'empty' | 'initial'
  /** `true` when format conversion (parse or serialize) failed during bootstrap. The bridge is still usable but the affected shared type may be stale. */
  parseError?: boolean
}

/** Handle returned by {@link createYjsBridge}. */
export type YjsBridgeHandle = {
  /** Result of the synchronous bootstrap phase. */
  readonly bootstrapResult: BootstrapResult
  /** Serialize `doc` and push to `Y.Text` using minimal diff. */
  syncToSharedText(doc: Node): ReplaceTextResult
  /** Returns `true` if the transaction originated from `y-prosemirror` sync. */
  isYjsSyncChange(tr: Transaction): boolean
  /** Remove the Y.Text observer. Call when tearing down. */
  dispose(): void
}
