import type { Awareness } from 'y-protocols/awareness'

/**
 * Create a Proxy around a Yjs {@link Awareness} that adapts the cursor sync
 * plugin's awareness field for y-prosemirror's `yCursorPlugin`.
 *
 * y-prosemirror (npm 1.3.7) hardcodes `"cursor"` in `createDecorations`,
 * but the cursor sync plugin writes to a separate field (default `"pmCursor"`)
 * to avoid conflicts with y-codemirror.next's `"cursor"` (Y.Text-based).
 *
 * This proxy:
 * - **`getStates()`**: remaps `cursorField` → `"cursor"` so yCursorPlugin
 *   finds the PM cursor data under the hardcoded `"cursor"` key.
 * - **`getLocalState()`**: returns `cursor: null` so yCursorPlugin's
 *   `updateCursorInfo` never tries to broadcast its own cursor.
 * - **`setLocalStateField("cursor", …)`**: suppressed (no-op) so
 *   yCursorPlugin cannot overwrite the field managed by the sync plugin.
 */
export function createAwarenessProxy(awareness: Awareness, cursorField = 'pmCursor'): Awareness {
  return new Proxy(awareness, {
    get(target, prop, receiver) {
      if (prop === 'getLocalState') {
        return () => {
          const state = target.getLocalState()
          // Hide "cursor" so yCursorPlugin's updateCursorInfo sees null
          return state ? { ...state, cursor: null } : state
        }
      }
      if (prop === 'setLocalStateField') {
        return (field: string, value: unknown) => {
          // Block yCursorPlugin's writes to "cursor"
          if (field === 'cursor') return
          target.setLocalStateField(field, value)
        }
      }
      if (prop === 'getStates') {
        return () => {
          const states = target.getStates()
          // Remap cursorField → "cursor" so yCursorPlugin reads PM cursor data.
          // Only override when the client actually has cursorField — clients
          // without cursor sync (e.g. using yCursorPlugin directly) keep their
          // original "cursor" intact.
          const remapped = new Map<number, Record<string, unknown>>()
          states.forEach((state, clientId) => {
            const s = state as Record<string, unknown>
            if (cursorField in s) {
              remapped.set(clientId, { ...s, cursor: s[cursorField] ?? null })
            } else {
              remapped.set(clientId, s)
            }
          })
          return remapped
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  }) as Awareness
}
