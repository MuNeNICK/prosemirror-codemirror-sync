import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createViewBridge, createBoundViewBridge } from '../bridge.js'
import type { ViewBridgeConfig } from '../bridge.js'

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

function parse(text: string) {
  const paragraphs = text.split('\n').map((line) =>
    schema.node('paragraph', null, line ? [schema.text(line)] : []),
  )
  return schema.node('doc', null, paragraphs)
}

function makeView(text: string): EditorView {
  const dom = document.createElement('div')
  return new EditorView(dom, {
    state: EditorState.create({ schema, doc: parse(text) }),
  })
}

const baseConfig: ViewBridgeConfig = { schema, serialize, parse }

describe('createViewBridge', () => {
  let view: EditorView

  beforeEach(() => {
    view = makeView('hello')
  })

  it('extractText returns serialized doc', () => {
    const bridge = createViewBridge(baseConfig)
    expect(bridge.extractText(view)).toBe('hello')
  })

  it('applyText replaces document and returns ok', () => {
    const bridge = createViewBridge(baseConfig)
    const result = bridge.applyText(view, 'world')
    expect(result).toEqual({ ok: true })
    expect(bridge.extractText(view)).toBe('world')
  })

  it('applyText returns unchanged when text matches', () => {
    const bridge = createViewBridge(baseConfig)
    const result = bridge.applyText(view, 'hello')
    expect(result).toEqual({ ok: false, reason: 'unchanged' })
  })

  it('applyText returns parse-error on bad input', () => {
    const onError = vi.fn()
    const badParse = () => { throw new Error('bad') }
    const bridge = createViewBridge({ ...baseConfig, parse: badParse, onError })
    const result = bridge.applyText(view, 'anything')
    expect(result).toEqual({ ok: false, reason: 'parse-error' })
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'parse-error', message: expect.any(String), cause: expect.any(Error) }),
    )
  })

  it('isBridgeChange detects bridge-originated transactions', () => {
    const bridge = createViewBridge(baseConfig)
    let bridgeTr = false
    const dom = document.createElement('div')
    const v = new EditorView(dom, {
      state: EditorState.create({ schema, doc: parse('hello') }),
      dispatchTransaction(tr) {
        bridgeTr = bridge.isBridgeChange(tr)
        v.updateState(v.state.apply(tr))
      },
    })
    bridge.applyText(v, 'world')
    expect(bridgeTr).toBe(true)
    v.destroy()
  })

  it('applyText with addToHistory: false sets meta', () => {
    const bridge = createViewBridge(baseConfig)
    let historyMeta: unknown
    const dom = document.createElement('div')
    const v = new EditorView(dom, {
      state: EditorState.create({ schema, doc: parse('hello') }),
      dispatchTransaction(tr) {
        historyMeta = tr.getMeta('addToHistory')
        v.updateState(v.state.apply(tr))
      },
    })
    bridge.applyText(v, 'world', { addToHistory: false })
    expect(historyMeta).toBe(false)
    v.destroy()
  })
})

describe('createBoundViewBridge', () => {
  it('proxies to inner bridge with bound view', () => {
    const view = makeView('hello')
    const bound = createBoundViewBridge(view, baseConfig)
    expect(bound.extractText()).toBe('hello')

    const result = bound.applyText('world')
    expect(result).toEqual({ ok: true })
    expect(bound.extractText()).toBe('world')
  })

  it('setView switches the bound view', () => {
    const view1 = makeView('hello')
    const view2 = makeView('goodbye')
    const bound = createBoundViewBridge(view1, baseConfig)
    expect(bound.extractText()).toBe('hello')

    bound.setView(view2)
    expect(bound.extractText()).toBe('goodbye')
    view1.destroy()
    view2.destroy()
  })
})
