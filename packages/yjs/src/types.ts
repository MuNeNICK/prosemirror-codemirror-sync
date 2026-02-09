import type { Node, Schema } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import type { Serialize, Parse, Normalize, OnError } from '@pm-cm/core'
import type { Doc, Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import type { ReplaceTextResult } from './bridge.js'

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
  /** `true` when `parse()` failed during bootstrap. The bridge is still usable but Y.XmlFragment may be stale. */
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
