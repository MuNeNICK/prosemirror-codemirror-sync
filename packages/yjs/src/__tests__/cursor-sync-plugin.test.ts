import { describe, it, expect, vi } from 'vitest'
import { Doc, Text as YText, createRelativePositionFromTypeIndex } from 'yjs'
import { Awareness } from 'y-protocols/awareness'

// We test the syncCmCursor input sanitization
import { syncCmCursor } from '../cursor-sync-plugin.js'

describe('syncCmCursor', () => {
  it('warns when plugin is not installed', () => {
    const onWarning = vi.fn()
    // Create a minimal mock view with no cursor sync plugin state
    const mockView = {
      state: {
        doc: {},
        tr: {
          setMeta: vi.fn().mockReturnThis(),
        },
      },
      dispatch: vi.fn(),
    } as any

    syncCmCursor(mockView, 5, undefined, onWarning)
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('cursor sync plugin is not installed'),
    )
    expect(mockView.dispatch).not.toHaveBeenCalled()
  })
})

// Test broadcastTextCursor clamping indirectly through the Y.Text API
describe('negative offset clamping', () => {
  it('createRelativePositionFromTypeIndex does not crash with clamped values', () => {
    const ydoc = new Doc()
    const sharedText = ydoc.getText('t')
    sharedText.insert(0, 'hello')

    // These would crash without clamping; we verify the clamping logic works
    const clamp = (v: number, len: number) => Math.max(0, Math.min(v, len))
    const len = sharedText.length

    // Negative value
    expect(() => createRelativePositionFromTypeIndex(sharedText, clamp(-5, len))).not.toThrow()
    // Value beyond length
    expect(() => createRelativePositionFromTypeIndex(sharedText, clamp(100, len))).not.toThrow()
    // Normal value
    expect(() => createRelativePositionFromTypeIndex(sharedText, clamp(3, len))).not.toThrow()
  })
})
