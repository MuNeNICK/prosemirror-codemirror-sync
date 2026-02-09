import type { Node, Schema } from 'prosemirror-model'
import type { EditorState, Plugin } from 'prosemirror-state'
import type { DecorationAttrs } from 'prosemirror-view'
import type { Awareness } from 'y-protocols/awareness'
import type { Serialize, LocateText } from '@pm-cm/core'
import { initProseMirrorDoc, yCursorPlugin, ySyncPlugin, yUndoPlugin } from 'y-prosemirror'
import type { AbstractType, Text as YText, UndoManager } from 'yjs'
import type { XmlFragment as YXmlFragment } from 'yjs'
import { createAwarenessProxy } from './awareness-proxy.js'
import { createBridgeSyncPlugin } from './bridge-sync-plugin.js'
import { createCursorSyncPlugin } from './cursor-sync-plugin.js'
import type { YjsBridgeHandle } from './types.js'

/** Yjs ↔ ProseMirror node mapping used by `y-prosemirror`. */
export type ProseMirrorMapping = Map<AbstractType<any>, Node | Node[]>

/** Options forwarded to `yCursorPlugin` from y-prosemirror. */
export type YCursorPluginOpts = {
  awarenessStateFilter?: (currentClientId: number, userClientId: number, user: unknown) => boolean
  cursorBuilder?: (user: unknown, clientId: number) => HTMLElement
  selectionBuilder?: (user: unknown, clientId: number) => DecorationAttrs
  getSelection?: (state: EditorState) => unknown
}

/** Options forwarded to `yUndoPlugin` from y-prosemirror. */
export type YUndoPluginOpts = {
  protectedNodes?: Set<string>
  trackedOrigins?: unknown[]
  undoManager?: UndoManager | null
}

/** Options for {@link createCollabPlugins}. */
export type CollabPluginsOptions = {
  /** Shared ProseMirror document in Yjs. */
  sharedProseMirror: YXmlFragment
  awareness: Awareness
  cursorFieldName?: string
  serialize?: Serialize
  /** Awareness field used for CM/Y.Text cursor payloads. Default `'cursor'`. */
  cmCursorFieldName?: string
  locate?: LocateText
  /**
   * Enable PM↔CM cursor sync. Default `false`.
   *
   * When enabled, an {@link createAwarenessProxy | awareness proxy} is applied
   * to suppress y-prosemirror's built-in cursor management.
   */
  cursorSync?: boolean
  /**
   * The shared `Y.Text` instance. When provided, the cursor sync plugin also
   * broadcasts CM-format cursor positions so remote `yCollab` instances render them.
   */
  sharedText?: YText
  /**
   * When provided, a bridge sync plugin is inserted before the cursor sync plugin
   * to ensure Y.Text is synced before cursor positions are computed. This guarantees
   * that serialize-based offsets match Y.Text indices.
   */
  bridge?: YjsBridgeHandle
  /** Extra options forwarded to `yCursorPlugin`. */
  yCursorPluginOpts?: YCursorPluginOpts
  /** Extra options forwarded to `yUndoPlugin`. */
  yUndoPluginOpts?: YUndoPluginOpts
  /** Called for non-fatal warnings. Propagated to child plugins. Default `console.warn`. */
  onWarning?: (message: string) => void
}

/**
 * Bundle `ySyncPlugin`, `yCursorPlugin`, `yUndoPlugin` from y-prosemirror,
 * plus an optional PM↔CM cursor sync plugin.
 *
 * @throws If `cursorSync: true` but `serialize` is not provided.
 */
export function createCollabPlugins(
  schema: Schema,
  options: CollabPluginsOptions,
): { plugins: Plugin[]; doc: Node; mapping: ProseMirrorMapping } {
  const cursorFieldName = options.cursorFieldName ?? 'pmCursor'
  const enableCursorSync = options.cursorSync ?? false
  const { sharedProseMirror } = options

  if (enableCursorSync && !options.serialize) {
    throw new Error('createCollabPlugins: cursorSync requires serialize to be provided')
  }
  const { doc, mapping } = initProseMirrorDoc(sharedProseMirror, schema)
  const pmAwareness = enableCursorSync
    ? createAwarenessProxy(options.awareness, cursorFieldName)
    : options.awareness

  const plugins: Plugin[] = [
    ySyncPlugin(sharedProseMirror, { mapping }),
    yCursorPlugin(pmAwareness, options.yCursorPluginOpts ?? {}, cursorFieldName),
    yUndoPlugin(options.yUndoPluginOpts),
  ]

  // Bridge sync plugin must run before cursor sync plugin so that
  // Y.Text is updated before cursor positions are computed.
  if (options.bridge) {
    plugins.push(createBridgeSyncPlugin(options.bridge, { onWarning: options.onWarning }))
  }

  if (enableCursorSync && options.serialize) {
    plugins.push(
      createCursorSyncPlugin({
        awareness: options.awareness,
        serialize: options.serialize,
        cursorFieldName,
        cmCursorFieldName: options.cmCursorFieldName,
        locate: options.locate,
        sharedText: options.sharedText,
        onWarning: options.onWarning,
      }),
    )
  }

  return { plugins, doc, mapping }
}
