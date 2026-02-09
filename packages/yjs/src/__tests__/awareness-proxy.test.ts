import { describe, it, expect, vi } from 'vitest'
import { Doc } from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createAwarenessProxy } from '../awareness-proxy.js'

function makeAwareness(): Awareness {
  return new Awareness(new Doc())
}

describe('createAwarenessProxy', () => {
  it('suppresses the cursor field', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    proxy.setLocalStateField('pmCursor', { anchor: 0, head: 0 })
    const state = awareness.getLocalState()
    expect(state?.pmCursor).toBeUndefined()
  })

  it('passes through other fields', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    proxy.setLocalStateField('user', { name: 'Alice' })
    const state = awareness.getLocalState()
    expect(state?.user).toEqual({ name: 'Alice' })
  })

  it('getLocalState omits the cursor field', () => {
    const awareness = makeAwareness()
    awareness.setLocalStateField('pmCursor', { anchor: 1, head: 2 })
    awareness.setLocalStateField('user', { name: 'Bob' })

    const proxy = createAwarenessProxy(awareness, 'pmCursor')
    const state = proxy.getLocalState()
    expect(state?.pmCursor).toBeNull()
    expect(state?.user).toEqual({ name: 'Bob' })
  })

  it('uses default cursor field name', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness)

    proxy.setLocalStateField('pmCursor', { anchor: 0, head: 0 })
    const state = awareness.getLocalState()
    expect(state?.pmCursor).toBeUndefined()
  })

  it('binds methods to the original target', () => {
    const awareness = makeAwareness()
    const proxy = createAwarenessProxy(awareness, 'pmCursor')

    // destroy should not throw
    expect(() => proxy.destroy()).not.toThrow()
  })
})
