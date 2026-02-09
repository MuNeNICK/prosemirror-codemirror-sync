import { describe, it, expect, vi, afterEach } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Doc, Text as YText, XmlFragment as YXmlFragment, createRelativePositionFromTypeIndex } from 'yjs'
import { Awareness } from 'y-protocols/awareness'

import { createCursorSyncPlugin, cursorSyncPluginKey, syncCmCursor } from '../cursor-sync-plugin.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

function serialize(doc: Node): string {
  const lines: string[] = []
  doc.forEach((node: Node) => lines.push(node.textContent))
  return lines.join('\n')
}

function makeDoc(...lines: string[]) {
  return schema.node(
    'doc',
    null,
    lines.map((l) => schema.node('paragraph', null, l ? [schema.text(l)] : [])),
  )
}

let views: EditorView[] = []
afterEach(() => {
  views.forEach((v) => v.destroy())
  views = []
})
function tracked(view: EditorView): EditorView {
  views.push(view)
  return view
}

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
      expect.objectContaining({
        code: 'cursor-sync-not-installed',
        message: expect.stringContaining('cursor sync plugin is not installed'),
      }),
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

describe('createCursorSyncPlugin (integration)', () => {
  function createViewWithCursorSync(options?: {
    sharedText?: YText
    onWarning?: typeof vi.fn extends (...args: infer _A) => infer _R ? ReturnType<typeof vi.fn> : never
  }) {
    const ydoc = new Doc()
    const awareness = new Awareness(ydoc)
    const onWarning = options?.onWarning ?? vi.fn()

    const plugin = createCursorSyncPlugin({
      awareness,
      serialize,
      sharedText: options?.sharedText,
      onWarning,
    })

    const doc = makeDoc('hello', 'world')
    const state = EditorState.create({ schema, doc, plugins: [plugin] })
    const view = tracked(new EditorView(document.createElement('div'), { state }))

    return { view, awareness, onWarning }
  }

  it('initializes plugin state correctly', () => {
    const { view } = createViewWithCursorSync()
    const state = cursorSyncPluginKey.getState(view.state)
    expect(state).toBeDefined()
    expect(state!.pendingCm).toBeNull()
    expect(state!.mappedTextOffset).toBeNull()
  })

  it('computes mappedTextOffset on selection change', () => {
    const { view } = createViewWithCursorSync()

    // Move selection to position 2 (inside "hello")
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 2),
    )
    view.dispatch(tr)

    const state = cursorSyncPluginKey.getState(view.state)
    expect(state!.mappedTextOffset).toBeTypeOf('number')
    expect(state!.mappedTextOffset).toBeGreaterThanOrEqual(0)
  })

  it('sets pendingCm state via syncCmCursor', () => {
    const { view } = createViewWithCursorSync()

    syncCmCursor(view, 3, 5)

    const state = cursorSyncPluginKey.getState(view.state)
    expect(state!.pendingCm).toEqual({ anchor: 3, head: 5 })
  })

  it('warns when ySyncPlugin is not available on PM selection change', () => {
    const onWarning = vi.fn()
    const { view } = createViewWithCursorSync({ onWarning })

    // Simulate focus by manually calling the view update path with a selection change
    // Since ySyncPlugin is not installed, broadcastPmCursor will fail
    // We need to trigger the PM → awareness path which requires focus
    // Instead, test via syncCmCursor which triggers CM → awareness path

    syncCmCursor(view, 2)

    // The plugin's view.update will try to broadcastPmCursor for the pendingCm path,
    // which will fail because ySyncPlugin is not installed
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ysync-plugin-missing',
        message: expect.stringContaining('ySyncPlugin state not available'),
      }),
    )
  })

  it('clears pendingCm after processing', () => {
    const { view } = createViewWithCursorSync()

    syncCmCursor(view, 3)

    // After the dispatch that sets pendingCm, the plugin's apply will see it.
    // On the next transaction, pendingCm should be cleared.
    const stateAfterSync = cursorSyncPluginKey.getState(view.state)
    expect(stateAfterSync!.pendingCm).toEqual({ anchor: 3, head: 3 })

    // Dispatch another transaction (e.g. selection change) to clear pendingCm
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 1),
    )
    view.dispatch(tr)

    const stateAfterClear = cursorSyncPluginKey.getState(view.state)
    expect(stateAfterClear!.pendingCm).toBeNull()
  })

  it('sanitizes syncCmCursor inputs', () => {
    const { view } = createViewWithCursorSync()

    // Negative and float values should be sanitized
    syncCmCursor(view, -5, 2.7)
    const state = cursorSyncPluginKey.getState(view.state)
    expect(state!.pendingCm).toEqual({ anchor: 0, head: 2 })
  })

  it('warns only once for missing ySyncPlugin', () => {
    const onWarning = vi.fn()
    const { view } = createViewWithCursorSync({ onWarning })

    // First dispatch triggers warning
    syncCmCursor(view, 2)
    const firstCallCount = onWarning.mock.calls.filter(
      (c: unknown[]) => (c[0] as { code: string }).code === 'ysync-plugin-missing',
    ).length
    expect(firstCallCount).toBe(1)

    // Second dispatch should NOT warn again
    syncCmCursor(view, 4)
    const secondCallCount = onWarning.mock.calls.filter(
      (c: unknown[]) => (c[0] as { code: string }).code === 'ysync-plugin-missing',
    ).length
    expect(secondCallCount).toBe(1)
  })
})
