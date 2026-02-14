import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { YjsBridgeHandle, OnWarning } from './types.js'

type BridgeSyncState = { needsSync: boolean }

type BridgeSyncFailure = { ok: false; reason: 'detached' | 'serialize-error' }

/** Options for {@link createBridgeSyncPlugin}. */
export type BridgeSyncPluginOptions = {
  /** Called when `syncToSharedText` fails (excludes `reason: 'unchanged'`). */
  onSyncFailure?: (result: BridgeSyncFailure, view: EditorView) => void
  /** Called for non-fatal warnings. Default `console.warn`. */
  onWarning?: OnWarning
}

/** ProseMirror plugin key for {@link createBridgeSyncPlugin}. Use to read the plugin state. */
export const bridgeSyncPluginKey = new PluginKey<BridgeSyncState>('pm-cm-bridge-sync')

const wiredBridges = new WeakMap<YjsBridgeHandle, number>()

const defaultOnWarning: OnWarning = (event) => console.warn(`[pm-cm] ${event.code}: ${event.message}`)

/**
 * ProseMirror plugin that automatically syncs PM doc changes to Y.Text
 * via the bridge handle. Skips Yjs-originated changes to avoid loops.
 *
 * A warning is logged if the same bridge handle is wired more than once.
 * The guard is cleaned up when the plugin is destroyed.
 */
export function createBridgeSyncPlugin(
  bridge: YjsBridgeHandle,
  options: BridgeSyncPluginOptions = {},
): Plugin {
  const warn = options.onWarning ?? defaultOnWarning

  // Tracks whether any Yjs-originated docChange was seen in the current
  // dispatch batch. Reset in view.update after each cycle.
  // appendTransaction plugins (e.g. prosemirror-tables) may emit follow-up
  // transactions that lack ySyncPlugin meta — this flag prevents those
  // from triggering a spurious text→PM→text round-trip.
  let yjsBatchSeen = false
  // Closure flag consumed in view.update — avoids sticky plugin state across dispatches.
  let needsSync = false

  return new Plugin<BridgeSyncState>({
    key: bridgeSyncPluginKey,

    state: {
      init(): BridgeSyncState {
        return { needsSync: false }
      },
      apply(tr, _prev): BridgeSyncState {
        if (!tr.docChanged) return { needsSync }
        if (bridge.isYjsSyncChange(tr)) {
          yjsBatchSeen = true
          needsSync = false
          return { needsSync: false }
        }
        if (yjsBatchSeen) {
          needsSync = false
          return { needsSync: false }
        }
        needsSync = true
        return { needsSync: true }
      },
    },

    view() {
      const count = wiredBridges.get(bridge) ?? 0
      if (count > 0) {
        warn({ code: 'bridge-already-wired', message: 'this bridge is already wired to another plugin instance' })
      }
      wiredBridges.set(bridge, count + 1)

      return {
        update(view) {
          if (needsSync) {
            const result = bridge.syncToSharedText(view.state.doc)
            if (!result.ok) {
              if (result.reason !== 'unchanged') {
                options.onSyncFailure?.(result, view)
                warn({ code: 'sync-failed', message: `bridge sync failed: ${result.reason}` })
              }
            }
          }
          needsSync = false
          yjsBatchSeen = false
        },
        destroy() {
          const remaining = (wiredBridges.get(bridge) ?? 1) - 1
          if (remaining <= 0) wiredBridges.delete(bridge)
          else wiredBridges.set(bridge, remaining)
        },
      }
    },
  })
}
