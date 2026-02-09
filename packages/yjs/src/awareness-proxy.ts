import type { Awareness } from 'y-protocols/awareness'

/**
 * Create a Proxy around a Yjs {@link Awareness} that suppresses the specified
 * cursor field. This prevents y-prosemirror's built-in cursor management from
 * conflicting with the PM↔CM cursor sync plugin.
 *
 * Other `setLocalStateField` calls are passed through unchanged.
 */
export function createAwarenessProxy(awareness: Awareness, cursorField = 'pmCursor'): Awareness {
  return new Proxy(awareness, {
    get(target, prop, receiver) {
      if (prop === 'getLocalState') {
        return () => {
          const state = target.getLocalState()
          return state ? { ...state, [cursorField]: null } : state
        }
      }
      if (prop === 'setLocalStateField') {
        return (field: string, value: unknown) => {
          // Only suppress the cursor field; pass through other fields
          if (field === cursorField) return
          target.setLocalStateField(field, value)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  }) as Awareness
}
