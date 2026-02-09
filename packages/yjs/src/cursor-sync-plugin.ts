import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import type { Awareness } from 'y-protocols/awareness'
import { absolutePositionToRelativePosition, ySyncPluginKey } from 'y-prosemirror'
import { createRelativePositionFromTypeIndex } from 'yjs'
import type { Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import type { Serialize, LocateText, CursorMap } from '@pm-cm/core'
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '@pm-cm/core'

/** Plugin state for the cursor sync plugin. Read via {@link cursorSyncPluginKey}. */
export type CursorSyncState = {
  /** Pending CodeMirror cursor to broadcast. Set by {@link syncCmCursor}. */
  pendingCm: { anchor: number; head: number } | null
  /** Text offset mapped from the current PM selection anchor. `null` when no mapping is available. */
  mappedTextOffset: number | null
}

/** ProseMirror plugin key for {@link createCursorSyncPlugin}. Use to read the plugin state. */
export const cursorSyncPluginKey = new PluginKey<CursorSyncState>('pm-cm-cursor-sync')

/**
 * Internal shape of `ySyncPluginKey` state from y-prosemirror.
 * Not exported by upstream — kept here for explicit tracking.
 * Tested against y-prosemirror ^1.x.
 */
type YSyncPluginState = { type: YXmlFragment; binding: { mapping: Map<any, any> } }

function toRelativePosition(
  view: EditorView,
  pmPos: number,
): unknown | null {
  const ySyncState = ySyncPluginKey.getState(view.state) as YSyncPluginState | undefined
  if (!ySyncState?.type || !ySyncState?.binding) return null

  return absolutePositionToRelativePosition(
    pmPos,
    ySyncState.type,
    ySyncState.binding.mapping,
  )
}

/** Returns `false` when ySyncPlugin state is unavailable (plugin not installed). */
function broadcastPmCursor(
  awareness: Awareness,
  cursorFieldName: string,
  view: EditorView,
  pmAnchor: number,
  pmHead: number,
): boolean {
  const relAnchor = toRelativePosition(view, pmAnchor)
  const relHead = toRelativePosition(view, pmHead)
  if (relAnchor === null || relHead === null) return false

  awareness.setLocalStateField(cursorFieldName, { anchor: relAnchor, head: relHead })
  return true
}

function broadcastTextCursor(
  awareness: Awareness,
  cmCursorFieldName: string,
  sharedText: YText,
  textAnchor: number,
  textHead: number,
): void {
  const len = sharedText.length
  const clamp = (v: number) => Math.max(0, Math.min(v, len))
  const relAnchor = createRelativePositionFromTypeIndex(sharedText, clamp(textAnchor))
  const relHead = createRelativePositionFromTypeIndex(sharedText, clamp(textHead))
  awareness.setLocalStateField(cmCursorFieldName, { anchor: relAnchor, head: relHead })
}

/** Options for {@link createCursorSyncPlugin}. */
export type CursorSyncPluginOptions = {
  awareness: Awareness
  serialize: Serialize
  cursorFieldName?: string
  /** Awareness field used for CM/Y.Text cursor payloads. Default `'cursor'`. */
  cmCursorFieldName?: string
  locate?: LocateText
  /**
   * When provided, the plugin also broadcasts CM-format cursor positions
   * (Y.Text relative positions) to the awareness field specified by
   * `cmCursorFieldName`, so that remote `yCollab` instances can render the cursor.
   */
  sharedText?: YText
  /** Called for non-fatal warnings. Default `console.warn`. */
  onWarning?: (message: string) => void
}

/**
 * ProseMirror plugin that synchronizes cursor positions between PM and CM via Yjs awareness.
 *
 * - PM → awareness: automatically broadcasts when the PM view is focused and selection changes.
 * - CM → awareness: triggered by dispatching {@link syncCmCursor}.
 */
export function createCursorSyncPlugin(options: CursorSyncPluginOptions): Plugin {
  const { awareness, serialize, locate, sharedText } = options
  const warn = options.onWarning ?? console.warn
  const cursorFieldName = options.cursorFieldName ?? 'pmCursor'
  const cmCursorFieldName = options.cmCursorFieldName ?? 'cursor'

  let warnedSyncPluginMissing = false

  // Cached cursor map (serialize-based) — rebuilt only when doc changes
  let cachedMap: CursorMap | null = null
  let cachedMapDoc: Node | null = null

  function getOrBuildMap(doc: Node): CursorMap {
    if (cachedMapDoc !== doc || !cachedMap) {
      cachedMap = buildCursorMap(doc, serialize, locate)
      cachedMapDoc = doc
    }
    return cachedMap
  }

  return new Plugin<CursorSyncState>({
    key: cursorSyncPluginKey,

    state: {
      init(): CursorSyncState {
        return { pendingCm: null, mappedTextOffset: null }
      },
      apply(tr, prev, _oldState, newState): CursorSyncState {
        const cmMeta = tr.getMeta(cursorSyncPluginKey) as
          | { anchor: number; head: number }
          | undefined
        if (cmMeta) {
          return { pendingCm: cmMeta, mappedTextOffset: prev.mappedTextOffset }
        }

        // Compute PM → text offset when selection or doc changes
        let mappedTextOffset = prev.mappedTextOffset
        if (tr.selectionSet || tr.docChanged) {
          const map = getOrBuildMap(newState.doc)
          mappedTextOffset = cursorMapLookup(map, newState.selection.anchor)
        }

        return {
          pendingCm: prev.pendingCm !== null ? null : prev.pendingCm,
          mappedTextOffset,
        }
      },
    },

    view() {
      return {
        update(view, prevState) {
          const pluginState = cursorSyncPluginKey.getState(view.state)
          const prevPluginState = cursorSyncPluginKey.getState(prevState)

          // CM → awareness: broadcast when pendingCm is newly set
          if (
            pluginState?.pendingCm != null &&
            pluginState.pendingCm !== prevPluginState?.pendingCm
          ) {
            const map = getOrBuildMap(view.state.doc)
            const pmAnchor = reverseCursorMapLookup(map, pluginState.pendingCm.anchor)
            const pmHead = reverseCursorMapLookup(map, pluginState.pendingCm.head)
            if (pmAnchor !== null && pmHead !== null) {
              const ok = broadcastPmCursor(awareness, cursorFieldName, view, pmAnchor, pmHead)
              if (!ok && !warnedSyncPluginMissing) {
                warnedSyncPluginMissing = true
                warn('[pm-cm] cursorSyncPlugin: ySyncPlugin state not available — cursor broadcast skipped')
              }
            }
            // Also broadcast CM-format cursor so remote yCollab can render it
            if (sharedText) {
              broadcastTextCursor(
                awareness,
                cmCursorFieldName,
                sharedText,
                pluginState.pendingCm.anchor,
                pluginState.pendingCm.head,
              )
            }
            return
          }

          // PM → awareness: auto-broadcast on selection/doc change when focused
          if (
            view.hasFocus() &&
            (view.state.selection !== prevState.selection ||
              view.state.doc !== prevState.doc)
          ) {
            const { anchor, head } = view.state.selection
            const ok = broadcastPmCursor(awareness, cursorFieldName, view, anchor, head)
            if (!ok && !warnedSyncPluginMissing) {
              warnedSyncPluginMissing = true
              warn('[pm-cm] cursorSyncPlugin: ySyncPlugin state not available — cursor broadcast skipped')
            }
            // Also broadcast CM-format cursor so remote yCollab can render it.
            // When bridgeSyncPlugin runs before this plugin, Y.Text is already
            // synced so serialize-based offsets match Y.Text indices.
            if (sharedText) {
              const map = getOrBuildMap(view.state.doc)
              const textAnchor = cursorMapLookup(map, anchor)
              const textHead = cursorMapLookup(map, head)
              if (textAnchor !== null && textHead !== null) {
                broadcastTextCursor(awareness, cmCursorFieldName, sharedText, textAnchor, textHead)
              }
            }
          }
        },
      }
    },
  })
}

/**
 * Dispatch a CodeMirror cursor offset (or range) to the cursor sync plugin.
 * The plugin will convert it to a ProseMirror position and broadcast via awareness.
 *
 * @param view - The ProseMirror EditorView that has the cursor sync plugin installed.
 * @param anchor - CodeMirror text offset for the anchor.
 * @param head - CodeMirror text offset for the head (defaults to `anchor` for a collapsed cursor).
 * @param onWarning - Optional warning callback. Default `console.warn`.
 */
export function syncCmCursor(view: EditorView, anchor: number, head?: number, onWarning?: (message: string) => void): void {
  if (!cursorSyncPluginKey.getState(view.state)) {
    (onWarning ?? console.warn)('[pm-cm] syncCmCursor: cursor sync plugin is not installed on this EditorView')
    return
  }
  const sanitize = (v: number) => Math.max(0, Math.floor(v))
  view.dispatch(
    view.state.tr.setMeta(cursorSyncPluginKey, {
      anchor: sanitize(anchor),
      head: sanitize(head ?? anchor),
    }),
  )
}
