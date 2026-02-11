export { createYjsBridge, replaceSharedText, replaceSharedProseMirror } from './bridge.js'
export type { YjsBridgeOptions, ReplaceResult, ReplaceTextResult, ReplaceProseMirrorResult } from './bridge.js'
export { createAwarenessProxy } from './awareness-proxy.js'
export { createCollabPlugins } from './collab-plugins.js'
export type { CollabPluginsOptions, ProseMirrorMapping, YCursorPluginOpts, YUndoPluginOpts } from './collab-plugins.js'
export {
  ORIGIN_TEXT_TO_PM,
  ORIGIN_PM_TO_TEXT,
  ORIGIN_INIT,
} from './types.js'
export type {
  BootstrapResult,
  YjsBridgeConfig,
  YjsBridgeHandle,
  WarningCode,
  WarningEvent,
  OnWarning,
} from './types.js'

// Cursor mapping re-exported from @pm-cm/core
export { buildCursorMap, cursorMapLookup, reverseCursorMapLookup } from '@pm-cm/core'
export type { TextSegment, CursorMap, SerializeWithMap, CursorMapWriter, Matcher, MatchResult, MatchRun } from '@pm-cm/core'

// Bridge sync plugin (auto PM→Y.Text wiring)
export { createBridgeSyncPlugin, bridgeSyncPluginKey } from './bridge-sync-plugin.js'
export type { BridgeSyncPluginOptions } from './bridge-sync-plugin.js'

// Cursor sync plugin
export { createCursorSyncPlugin, cursorSyncPluginKey, syncCmCursor } from './cursor-sync-plugin.js'
export type { CursorSyncState, CursorSyncPluginOptions } from './cursor-sync-plugin.js'

// Re-export types from @pm-cm/core
export { createCursorMapWriter, wrapSerialize } from '@pm-cm/core'
export type { Serialize, Parse, Normalize, OnError, ErrorCode, ErrorEvent } from '@pm-cm/core'
