import { describe, expect, it, vi } from 'vitest'
import { applyMarkdownToCodeMirror, shouldSkipSync } from './sync'

describe('shouldSkipSync', () => {
  it('skips syncing when source and target are both markdown', () => {
    expect(shouldSkipSync('markdown', 'markdown')).toBe(true)
  })

  it('skips syncing when source and target are both wysiwyg', () => {
    expect(shouldSkipSync('wysiwyg', 'wysiwyg')).toBe(true)
  })

  it('does not skip cross-pane sync', () => {
    expect(shouldSkipSync('markdown', 'wysiwyg')).toBe(false)
    expect(shouldSkipSync('wysiwyg', 'markdown')).toBe(false)
  })
})

describe('applyMarkdownToCodeMirror', () => {
  it('does nothing when markdown has not changed', () => {
    const dispatch = vi.fn()
    const view = {
      state: {
        doc: {
          length: 5,
          toString: () => 'hello',
        },
      },
      dispatch,
    }

    const updated = applyMarkdownToCodeMirror(view, 'hello')

    expect(updated).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches full document replacement when markdown changes', () => {
    const dispatch = vi.fn()
    const view = {
      state: {
        doc: {
          length: 5,
          toString: () => 'hello',
        },
      },
      dispatch,
    }

    const updated = applyMarkdownToCodeMirror(view, 'updated')

    expect(updated).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({
      changes: {
        from: 0,
        to: 5,
        insert: 'updated',
      },
    })
  })
})
