import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import type { Awareness } from 'y-protocols/awareness'
import { absolutePositionToRelativePosition, ySyncPluginKey } from 'y-prosemirror'
import { createRelativePositionFromTypeIndex, createAbsolutePositionFromRelativePosition } from 'yjs'
import type { Text as YText, XmlFragment as YXmlFragment, RelativePosition } from 'yjs'
import type { Serialize, SerializeWithMap, CursorMap } from '@pm-cm/core'
import { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '@pm-cm/core'
import type { OnWarning } from './types.js'

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
 * Tested against y-prosemirror ^1.3.x.
 */
type YSyncPluginState = { type: YXmlFragment; binding: { mapping: Map<unknown, unknown> } }

function getYSyncState(view: EditorView): YSyncPluginState | null {
  const raw = ySyncPluginKey.getState(view.state) as Record<string, unknown> | undefined
  if (!raw) return null
  if (
    typeof raw === 'object' &&
    'type' in raw && raw.type &&
    'binding' in raw && raw.binding &&
    typeof raw.binding === 'object' &&
    'mapping' in (raw.binding as Record<string, unknown>) &&
    (raw.binding as Record<string, unknown>).mapping instanceof Map
  ) {
    return raw as unknown as YSyncPluginState
  }
  return null
}

function toRelativePosition(
  view: EditorView,
  pmPos: number,
): unknown | null {
  const ySyncState = getYSyncState(view)
  if (!ySyncState) return null

  return absolutePositionToRelativePosition(
    pmPos,
    ySyncState.type,
    ySyncState.binding.mapping as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- y-prosemirror internal mapping type
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

const defaultOnWarning: OnWarning = (event) => console.warn(`[pm-cm] ${event.code}: ${event.message}`)

/** Options for {@link createCursorSyncPlugin}. */
export type CursorSyncPluginOptions = {
  awareness: Awareness
  serialize: Serialize | SerializeWithMap
  cursorFieldName?: string
  /** Awareness field used for CM/Y.Text cursor payloads. Default `'cursor'`. */
  cmCursorFieldName?: string
  /**
   * When provided, the plugin also broadcasts CM-format cursor positions
   * (Y.Text relative positions) to the awareness field specified by
   * `cmCursorFieldName`, so that remote `yCollab` instances can render the cursor.
   */
  sharedText?: YText
  /** Called for non-fatal warnings. Default `console.warn`. */
  onWarning?: OnWarning
}

/**
 * ProseMirror plugin that synchronizes cursor positions between PM and CM via Yjs awareness.
 *
 * - PM → awareness: automatically broadcasts when the PM view is focused and selection changes.
 * - CM → awareness: triggered by dispatching {@link syncCmCursor}.
 */
export function createCursorSyncPlugin(options: CursorSyncPluginOptions): Plugin {
  const { awareness, serialize, sharedText } = options
  const warn = options.onWarning ?? defaultOnWarning
  const cursorFieldName = options.cursorFieldName ?? 'pmCursor'
  const cmCursorFieldName = options.cmCursorFieldName ?? 'cursor'

  let warnedSyncPluginMissing = false

  // Cached cursor map (serialize-based) — rebuilt only when doc changes
  let cachedMap: CursorMap | null = null
  let cachedMapDoc: Node | null = null

  function getOrBuildMap(doc: Node): CursorMap {
    if (cachedMapDoc !== doc || !cachedMap) {
      cachedMap = buildCursorMap(doc, serialize)
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

    view(editorView) {
      // Suppress awareness listener reactions when PM broadcasts to cmCursorFieldName
      let suppressCmReaction = false
      // Track last resolved CM cursor to avoid redundant pmCursor broadcasts
      let lastCmAbsAnchor = -1
      let lastCmAbsHead = -1
      // Set when the awareness listener already broadcast pmCursor for the
      // current CM cursor change, so pendingCm can skip its own broadcast.
      let cmCursorHandledByListener = false

      // When sharedText is available, yCollab writes the CM cursor (including
      // range selections) to awareness[cmCursorFieldName]. This listener
      // converts those Y.Text relative positions to PM positions and
      // broadcasts to pmCursor — so the app never needs to forward CM ranges.
      const handleAwarenessUpdate = (
        { updated }: { added: number[]; updated: number[]; removed: number[] },
      ) => {
        if (suppressCmReaction) return
        if (!sharedText?.doc) return
        if (!updated.includes(awareness.clientID)) return

        const localState = awareness.getLocalState() as Record<string, unknown> | null
        if (!localState) return

        const cmCursor = localState[cmCursorFieldName] as
          | { anchor: RelativePosition; head: RelativePosition }
          | undefined
        if (!cmCursor?.anchor || !cmCursor?.head) return

        const absAnchor = createAbsolutePositionFromRelativePosition(cmCursor.anchor, sharedText.doc!)
        const absHead = createAbsolutePositionFromRelativePosition(cmCursor.head, sharedText.doc!)
        if (!absAnchor || !absHead) return

        // Skip if unchanged (prevents loops from our own pmCursor broadcast)
        if (absAnchor.index === lastCmAbsAnchor && absHead.index === lastCmAbsHead) return
        lastCmAbsAnchor = absAnchor.index
        lastCmAbsHead = absHead.index

        const map = getOrBuildMap(editorView.state.doc)
        const pmAnchor = reverseCursorMapLookup(map, absAnchor.index)
        const pmHead = reverseCursorMapLookup(map, absHead.index)
        if (pmAnchor === null || pmHead === null) return

        cmCursorHandledByListener = true
        const ok = broadcastPmCursor(awareness, cursorFieldName, editorView, pmAnchor, pmHead)
        if (!ok && !warnedSyncPluginMissing) {
          warnedSyncPluginMissing = true
          warn({ code: 'ysync-plugin-missing', message: 'ySyncPlugin state not available — cursor broadcast skipped' })
        }
      }

      if (sharedText) {
        awareness.on('update', handleAwarenessUpdate)
      }

      return {
        update(view, prevState) {
          const pluginState = cursorSyncPluginKey.getState(view.state)
          const prevPluginState = cursorSyncPluginKey.getState(prevState)

          // CM → awareness: broadcast when pendingCm is newly set.
          // If the awareness listener already converted yCollab's range to
          // pmCursor, skip here to avoid overwriting with collapsed data.
          if (
            pluginState?.pendingCm != null &&
            pluginState.pendingCm !== prevPluginState?.pendingCm
          ) {
            if (!cmCursorHandledByListener) {
              const map = getOrBuildMap(view.state.doc)
              const pmAnchor = reverseCursorMapLookup(map, pluginState.pendingCm.anchor)
              const pmHead = reverseCursorMapLookup(map, pluginState.pendingCm.head)
              if (pmAnchor !== null && pmHead !== null) {
                const ok = broadcastPmCursor(awareness, cursorFieldName, view, pmAnchor, pmHead)
                if (!ok && !warnedSyncPluginMissing) {
                  warnedSyncPluginMissing = true
                  warn({ code: 'ysync-plugin-missing', message: 'ySyncPlugin state not available — cursor broadcast skipped' })
                }
              }
              // Also broadcast CM-format cursor so remote yCollab can render it.
              // (When yCollab is active the listener handles this; this path
              // covers the case where syncCmCursor is called without yCollab.)
              if (sharedText) {
                broadcastTextCursor(
                  awareness,
                  cmCursorFieldName,
                  sharedText,
                  pluginState.pendingCm.anchor,
                  pluginState.pendingCm.head,
                )
              }
            }
            cmCursorHandledByListener = false
            return
          }

          // PM → awareness: auto-broadcast on selection/doc change when focused.
          // suppressCmReaction wraps ALL awareness writes so the listener
          // does not echo stale CM cursor back to pmCursor.
          if (
            view.hasFocus() &&
            (view.state.selection !== prevState.selection ||
              view.state.doc !== prevState.doc)
          ) {
            suppressCmReaction = true
            const { anchor, head } = view.state.selection
            const ok = broadcastPmCursor(awareness, cursorFieldName, view, anchor, head)
            if (!ok && !warnedSyncPluginMissing) {
              warnedSyncPluginMissing = true
              warn({ code: 'ysync-plugin-missing', message: 'ySyncPlugin state not available — cursor broadcast skipped' })
            }
            // Also broadcast CM-format cursor so remote yCollab can render it.
            if (sharedText) {
              const map = getOrBuildMap(view.state.doc)
              const textAnchor = cursorMapLookup(map, anchor)
              const textHead = cursorMapLookup(map, head)
              if (textAnchor !== null && textHead !== null) {
                broadcastTextCursor(awareness, cmCursorFieldName, sharedText, textAnchor, textHead)
              }
            }
            suppressCmReaction = false
          }
        },
        destroy() {
          if (sharedText) {
            awareness.off('update', handleAwarenessUpdate)
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
export function syncCmCursor(view: EditorView, anchor: number, head?: number, onWarning?: OnWarning): void {
  if (!cursorSyncPluginKey.getState(view.state)) {
    (onWarning ?? defaultOnWarning)({ code: 'cursor-sync-not-installed', message: 'cursor sync plugin is not installed on this EditorView' })
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
