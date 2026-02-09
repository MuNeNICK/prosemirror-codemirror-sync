import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { YjsBridgeHandle } from './types.js'

type BridgeSyncState = { needsSync: boolean }

type BridgeSyncFailure = { ok: false; reason: 'detached' }

/** Options for {@link createBridgeSyncPlugin}. */
export type BridgeSyncPluginOptions = {
  /** Called when `syncToSharedText` fails (excludes `reason: 'unchanged'`). */
  onSyncFailure?: (result: BridgeSyncFailure, view: EditorView) => void
  /** Called for non-fatal warnings. Default `console.warn`. */
  onWarning?: (message: string) => void
}

/** ProseMirror plugin key for {@link createBridgeSyncPlugin}. Use to read the plugin state. */
export const bridgeSyncPluginKey = new PluginKey<BridgeSyncState>('pm-cm-bridge-sync')

const wiredBridges = new WeakSet<YjsBridgeHandle>()

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
  const warn = options.onWarning ?? console.warn
  if (wiredBridges.has(bridge)) {
    warn('[pm-cm] createBridgeSyncPlugin: this bridge is already wired to another plugin instance')
  }
  wiredBridges.add(bridge)

  return new Plugin<BridgeSyncState>({
    key: bridgeSyncPluginKey,

    state: {
      init(): BridgeSyncState {
        return { needsSync: false }
      },
      apply(tr, _prev): BridgeSyncState {
        if (!tr.docChanged) return { needsSync: false }
        if (bridge.isYjsSyncChange(tr)) return { needsSync: false }
        return { needsSync: true }
      },
    },

    view() {
      return {
        update(view) {
          const state = bridgeSyncPluginKey.getState(view.state)
          if (state?.needsSync) {
            const result = bridge.syncToSharedText(view.state.doc)
            if (!result.ok) {
              if (result.reason === 'detached') {
                options.onSyncFailure?.(result, view)
                warn(`[pm-cm] bridge sync failed: ${result.reason}`)
              }
            }
          }
        },
        destroy() {
          wiredBridges.delete(bridge)
        },
      }
    },
  })
}
