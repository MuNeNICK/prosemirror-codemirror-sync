import { describe, it, expect, vi } from 'vitest'
import { Doc } from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createAwarenessProxy } from '../awareness-proxy.js'

function makeAwareness(): Awareness {
  return new Awareness(new Doc())
}

describe('createAwarenessProxy', () => {
  it('suppresses "cursor" writes (blocks yCursorPlugin)', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    proxy.setLocalStateField('cursor', { anchor: 0, head: 0 })
    const state = awareness.getLocalState()
    expect(state?.cursor).toBeUndefined()
  })

  it('passes through other fields including cursorField', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    proxy.setLocalStateField('user', { name: 'Alice' })
    proxy.setLocalStateField('pmCursor', { anchor: 1, head: 2 })
    const state = awareness.getLocalState()
    expect(state?.user).toEqual({ name: 'Alice' })
    expect(state?.pmCursor).toEqual({ anchor: 1, head: 2 })
  })

  it('getLocalState hides "cursor" so yCursorPlugin sees null', () => {
    const awareness = makeAwareness()
    awareness.setLocalStateField('cursor', { anchor: 1, head: 2 })
    awareness.setLocalStateField('user', { name: 'Bob' })

    const proxy = createAwarenessProxy(awareness, 'pmCursor')
    const state = proxy.getLocalState()
    expect(state?.cursor).toBeNull()
    expect(state?.user).toEqual({ name: 'Bob' })
  })

  it('uses default cursor field name (pmCursor)', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness)

    // "cursor" writes are blocked
    proxy.setLocalStateField('cursor', { anchor: 0, head: 0 })
    expect(awareness.getLocalState()?.cursor).toBeUndefined()

    // "pmCursor" writes pass through
    proxy.setLocalStateField('pmCursor', { anchor: 3, head: 3 })
    expect(awareness.getLocalState()?.pmCursor).toEqual({ anchor: 3, head: 3 })
  })

  it('binds methods to the original target', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    // destroy should not throw
    expect(() => proxy.destroy()).not.toThrow()
  })

  it('getStates remaps cursorField → "cursor"', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    // Set pmCursor on real awareness (simulating cursor sync plugin)
    awareness.setLocalStateField('pmCursor', { anchor: 5, head: 5 })
    awareness.setLocalStateField('user', { name: 'Alice' })

    // getStates via proxy remaps pmCursor → cursor
    const states = proxy.getStates()
    const localState = states.get(awareness.doc.clientID) as Record<string, unknown>
    expect(localState?.cursor).toEqual({ anchor: 5, head: 5 })
    expect(localState?.user).toEqual({ name: 'Alice' })
  })

  it('getStates preserves original cursor when cursorField is absent', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    awareness.setLocalStateField('user', { name: 'Alice' })

    const states = proxy.getStates()
    const localState = states.get(awareness.doc.clientID) as Record<string, unknown>
    // No pmCursor set → original state preserved (cursor is undefined)
    expect(localState?.cursor).toBeUndefined()
    expect(localState?.user).toEqual({ name: 'Alice' })
  })

  it('getStates preserves cursor from clients without cursorField', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    // Simulate a CM-only client that has cursor but no pmCursor
    awareness.setLocalStateField('cursor', { anchor: 10, head: 20 })

    const states = proxy.getStates()
    const localState = states.get(awareness.doc.clientID) as Record<string, unknown>
    // cursor is preserved because pmCursor is absent
    expect(localState?.cursor).toEqual({ anchor: 10, head: 20 })
  })

  it('on/off delegates to real awareness', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    const changeHandler = vi.fn()
    proxy.on('change', changeHandler)

    awareness.setLocalStateField('user', { name: 'Bob' })
    expect(changeHandler).toHaveBeenCalled()

    proxy.off('change', changeHandler)
    changeHandler.mockClear()

    awareness.setLocalStateField('user', { name: 'Charlie' })
    expect(changeHandler).not.toHaveBeenCalled()
  })

  it('change event fires when cursor field is set on real awareness', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    const changeHandler = vi.fn()
    proxy.on('change', changeHandler)

    // Set pmCursor on real awareness (not via proxy)
    awareness.setLocalStateField('pmCursor', { anchor: 3, head: 3 })

    // The handler must fire so yCursorPlugin can react to remote cursor changes
    expect(changeHandler).toHaveBeenCalled()
  })
})
