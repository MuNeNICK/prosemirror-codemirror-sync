import { describe, it, expect, vi, afterEach } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createBridgeSyncPlugin, bridgeSyncPluginKey } from '../bridge-sync-plugin.js'
import type { YjsBridgeHandle } from '../types.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

function makeMockBridge(overrides?: Partial<YjsBridgeHandle>): YjsBridgeHandle {
  return {
    bootstrapResult: { source: 'empty' },
    syncToSharedText: vi.fn(() => ({ ok: true as const })),
    isYjsSyncChange: vi.fn(() => false),
    dispose: vi.fn(),
    ...overrides,
  }
}

function createView(bridge: YjsBridgeHandle, options?: Parameters<typeof createBridgeSyncPlugin>[1], extraPlugins?: Plugin[]): EditorView {
  const plugin = createBridgeSyncPlugin(bridge, options)
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])])
  const state = EditorState.create({ schema, doc, plugins: [plugin, ...(extraPlugins ?? [])] })
  return new EditorView(document.createElement('div'), { state })
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

describe('createBridgeSyncPlugin', () => {
  it('warns when the same bridge is wired twice', () => {
    const bridge = makeMockBridge()
    const onWarning = vi.fn()

    createBridgeSyncPlugin(bridge, { onWarning })
    createBridgeSyncPlugin(bridge, { onWarning })

    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'bridge-already-wired',
        message: expect.stringContaining('already wired'),
      }),
    )
  })

  it('uses console.warn by default', () => {
    const bridge = makeMockBridge()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    createBridgeSyncPlugin(bridge)
    createBridgeSyncPlugin(bridge)

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('already wired'))
    spy.mockRestore()
  })

  it('calls syncToSharedText on doc-changing transaction', () => {
    const bridge = makeMockBridge()
    const view = tracked(createView(bridge, { onWarning: vi.fn() }))

    // Insert text to trigger a doc change
    const tr = view.state.tr.insertText(' world', 6)
    view.dispatch(tr)

    expect(bridge.syncToSharedText).toHaveBeenCalledOnce()
  })

  it('does not sync on yjs-originated transaction', () => {
    const bridge = makeMockBridge({
      isYjsSyncChange: vi.fn(() => true),
    })
    const view = tracked(createView(bridge, { onWarning: vi.fn() }))

    const tr = view.state.tr.insertText(' world', 6)
    view.dispatch(tr)

    expect(bridge.syncToSharedText).not.toHaveBeenCalled()
  })

  it('calls onSyncFailure and onWarning when sync returns detached', () => {
    const onWarning = vi.fn()
    const onSyncFailure = vi.fn()
    const bridge = makeMockBridge({
      syncToSharedText: vi.fn(() => ({ ok: false as const, reason: 'detached' as const })),
    })
    const view = tracked(createView(bridge, { onWarning, onSyncFailure }))

    const tr = view.state.tr.insertText(' world', 6)
    view.dispatch(tr)

    expect(onSyncFailure).toHaveBeenCalledWith(
      { ok: false, reason: 'detached' },
      expect.any(Object),
    )
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'sync-failed',
        message: expect.stringContaining('detached'),
      }),
    )
  })

  it('does not call onSyncFailure when sync returns unchanged', () => {
    const onSyncFailure = vi.fn()
    const bridge = makeMockBridge({
      syncToSharedText: vi.fn(() => ({ ok: false as const, reason: 'unchanged' as const })),
    })
    const view = tracked(createView(bridge, { onWarning: vi.fn(), onSyncFailure }))

    const tr = view.state.tr.insertText(' world', 6)
    view.dispatch(tr)

    expect(onSyncFailure).not.toHaveBeenCalled()
  })

  it('does not sync when doc did not change', () => {
    const bridge = makeMockBridge()
    const view = tracked(createView(bridge, { onWarning: vi.fn() }))

    // Selection-only change
    const tr = view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(1)),
    )
    view.dispatch(tr)

    expect(bridge.syncToSharedText).not.toHaveBeenCalled()
  })

  it('suppresses sync when appendTransaction follows a yjs-originated change', () => {
    // Simulate: yjs sync change is the initial tr, then an appendTransaction
    // plugin (like prosemirror-tables) emits a follow-up docChanged tr without
    // ySyncPlugin meta.
    let callCount = 0
    const bridge = makeMockBridge({
      isYjsSyncChange: vi.fn(() => {
        callCount++
        // First call (the dispatched tr) is yjs-originated;
        // second call (appended tr) is not.
        return callCount === 1
      }),
    })

    // Plugin that appends a doc-changing transaction after the initial one
    const appendPlugin = new Plugin({
      appendTransaction(_trs, _oldState, newState) {
        // Only append once: if text is still 'hello', insert '!'
        const text = newState.doc.textContent
        if (!text.includes('!')) {
          return newState.tr.insertText('!', newState.doc.content.size - 1)
        }
        return null
      },
    })

    const view = tracked(createView(bridge, { onWarning: vi.fn() }, [appendPlugin]))

    // Dispatch a doc-changing tr that isYjsSyncChange returns true for
    const tr = view.state.tr.insertText(' world', 6)
    view.dispatch(tr)

    // The appended transaction should NOT trigger sync
    expect(bridge.syncToSharedText).not.toHaveBeenCalled()
  })

  it('preserves needsSync through a selection-only transaction in the same batch', () => {
    const bridge = makeMockBridge()

    // Plugin that appends a selection-only transaction after a doc change
    const appendPlugin = new Plugin({
      appendTransaction(trs, _oldState, newState) {
        if (trs.some((t) => t.docChanged)) {
          // Move selection to start (selection-only, no doc change)
          return newState.tr.setSelection(TextSelection.near(newState.doc.resolve(1)))
        }
        return null
      },
    })

    const view = tracked(createView(bridge, { onWarning: vi.fn() }, [appendPlugin]))

    const tr = view.state.tr.insertText(' world', 6)
    view.dispatch(tr)

    // Should still sync despite the appended selection-only transaction
    expect(bridge.syncToSharedText).toHaveBeenCalledOnce()
  })

  it('resets yjsBatchSeen between separate dispatches', () => {
    let callCount = 0
    const bridge = makeMockBridge({
      isYjsSyncChange: vi.fn(() => {
        callCount++
        // First dispatch: yjs-originated
        // Second dispatch: local
        return callCount === 1
      }),
    })

    const view = tracked(createView(bridge, { onWarning: vi.fn() }))

    // First dispatch: yjs-originated → no sync
    view.dispatch(view.state.tr.insertText(' yjs', 6))
    expect(bridge.syncToSharedText).not.toHaveBeenCalled()

    // Second dispatch: local → should sync
    view.dispatch(view.state.tr.insertText(' local', view.state.doc.content.size - 1))
    expect(bridge.syncToSharedText).toHaveBeenCalledOnce()
  })
})
