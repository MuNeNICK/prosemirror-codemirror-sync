import { describe, it, expect, vi, afterEach } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
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

function createView(bridge: YjsBridgeHandle, options?: Parameters<typeof createBridgeSyncPlugin>[1]): EditorView {
  const plugin = createBridgeSyncPlugin(bridge, options)
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])])
  const state = EditorState.create({ schema, doc, plugins: [plugin] })
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
      expect.stringContaining('already wired'),
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
      expect.stringContaining('detached'),
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
      view.state.selection.constructor.near(view.state.doc.resolve(1)),
    )
    view.dispatch(tr)

    expect(bridge.syncToSharedText).not.toHaveBeenCalled()
  })
})
