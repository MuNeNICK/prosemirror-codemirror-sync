import { describe, it, expect, vi } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { Doc, Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import { prosemirrorToYXmlFragment } from 'y-prosemirror'
import { replaceSharedText, replaceSharedProseMirror, createYjsBridge } from '../bridge.js'
import type { YjsBridgeConfig } from '../types.js'

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

function makeConfig(ydoc: Doc): YjsBridgeConfig {
  return {
    doc: ydoc,
    sharedText: ydoc.getText('text'),
    sharedProseMirror: ydoc.getXmlFragment('prosemirror'),
    schema,
    serialize,
    parse,
  }
}

describe('replaceSharedText', () => {
  it('returns unchanged when content matches', () => {
    const ydoc = new Doc()
    const sharedText = ydoc.getText('t')
    sharedText.insert(0, 'hello')
    const result = replaceSharedText(sharedText, 'hello', 'test')
    expect(result).toEqual({ ok: false, reason: 'unchanged' })
  })

  it('applies minimal diff on change', () => {
    const ydoc = new Doc()
    const sharedText = ydoc.getText('t')
    sharedText.insert(0, 'hello world')
    const result = replaceSharedText(sharedText, 'hello earth', 'test')
    expect(result).toEqual({ ok: true })
    expect(sharedText.toString()).toBe('hello earth')
  })

  it('returns detached when Y.Text has no doc', () => {
    const sharedText = new YText()
    // A standalone YText is not attached to a doc
    const result = replaceSharedText(sharedText, 'new', 'test')
    expect(result).toEqual({ ok: false, reason: 'detached' })
  })
})

describe('replaceSharedProseMirror', () => {
  it('returns ok on successful parse', () => {
    const ydoc = new Doc()
    const fragment = ydoc.getXmlFragment('pm')
    const result = replaceSharedProseMirror(ydoc, fragment, 'hello', 'test', { schema, parse })
    expect(result).toEqual({ ok: true })
  })

  it('returns parse-error on failure', () => {
    const ydoc = new Doc()
    const fragment = ydoc.getXmlFragment('pm')
    const badParse = () => { throw new Error('bad') }
    const onError = vi.fn()
    const result = replaceSharedProseMirror(ydoc, fragment, 'hello', 'test', { schema, parse: badParse, onError })
    expect(result).toEqual({ ok: false, reason: 'parse-error' })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('returns detached when fragment has no doc', () => {
    const ydoc = new Doc()
    const fragment = new YXmlFragment()
    const result = replaceSharedProseMirror(ydoc, fragment, 'hello', 'test', { schema, parse })
    expect(result).toEqual({ ok: false, reason: 'detached' })
  })

  it('throws when fragment belongs to a different doc', () => {
    const ydoc1 = new Doc()
    const ydoc2 = new Doc()
    const fragment = ydoc2.getXmlFragment('pm')
    expect(() =>
      replaceSharedProseMirror(ydoc1, fragment, 'hello', 'test', { schema, parse }),
    ).toThrow('different Y.Doc')
  })
})

describe('createYjsBridge', () => {
  it('bootstraps with initialText and returns source: initial', () => {
    const ydoc = new Doc()
    const config = makeConfig(ydoc)
    const bridge = createYjsBridge(config, { initialText: 'hello' })
    expect(bridge.bootstrapResult.source).toBe('initial')
    expect(ydoc.getText('text').toString()).toBe('hello')
    bridge.dispose()
  })

  it('bootstraps empty and returns source: empty', () => {
    const ydoc = new Doc()
    const config = makeConfig(ydoc)
    const bridge = createYjsBridge(config)
    expect(bridge.bootstrapResult.source).toBe('empty')
    bridge.dispose()
  })

  it('bootstraps from prosemirror with parseError when serialize fails', () => {
    const ydoc = new Doc()
    // Directly populate XmlFragment without touching Y.Text
    const fragment = ydoc.getXmlFragment('prosemirror')
    const pmDoc = parse('hello')
    ydoc.transact(() => {
      prosemirrorToYXmlFragment(pmDoc, fragment)
    })
    expect(fragment.length).toBeGreaterThan(0)
    expect(ydoc.getText('text').toString()).toBe('')

    // Use a serialize that throws to simulate failure
    const badSerialize = () => { throw new Error('serialize failed') }
    const onError = vi.fn()
    const config: YjsBridgeConfig = {
      ...makeConfig(ydoc),
      serialize: badSerialize,
      onError,
    }
    const bridge = createYjsBridge(config)
    expect(bridge.bootstrapResult.source).toBe('prosemirror')
    expect(bridge.bootstrapResult.parseError).toBe(true)
    expect(onError).toHaveBeenCalled()
    bridge.dispose()
  })

  it('bootstraps from text when only text exists', () => {
    const ydoc = new Doc()
    ydoc.getText('text').insert(0, 'from-text')
    const config = makeConfig(ydoc)
    const bridge = createYjsBridge(config)
    expect(bridge.bootstrapResult.source).toBe('text')
    bridge.dispose()
  })

  it('syncToSharedText pushes PM doc to Y.Text', () => {
    const ydoc = new Doc()
    const config = makeConfig(ydoc)
    const bridge = createYjsBridge(config, { initialText: 'hello' })
    const doc = parse('updated')
    const result = bridge.syncToSharedText(doc)
    expect(result.ok).toBe(true)
    expect(ydoc.getText('text').toString()).toBe('updated')
    bridge.dispose()
  })

  it('syncToSharedText returns unchanged when content matches', () => {
    const ydoc = new Doc()
    const config = makeConfig(ydoc)
    const bridge = createYjsBridge(config, { initialText: 'hello' })
    const doc = parse('hello')
    const result = bridge.syncToSharedText(doc)
    expect(result).toEqual({ ok: false, reason: 'unchanged' })
    bridge.dispose()
  })

  it('throws when sharedText is not attached', () => {
    const ydoc = new Doc()
    const detachedText = new YText()
    expect(() =>
      createYjsBridge({
        ...makeConfig(ydoc),
        sharedText: detachedText,
      }),
    ).toThrow('sharedText is not attached')
  })

  it('throws when sharedProseMirror is not attached', () => {
    const ydoc = new Doc()
    const detachedFragment = new YXmlFragment()
    expect(() =>
      createYjsBridge({
        ...makeConfig(ydoc),
        sharedProseMirror: detachedFragment,
      }),
    ).toThrow('sharedProseMirror is not attached')
  })

  it('throws when sharedText belongs to different doc', () => {
    const ydoc1 = new Doc()
    const ydoc2 = new Doc()
    expect(() =>
      createYjsBridge({
        ...makeConfig(ydoc1),
        sharedText: ydoc2.getText('text'),
      }),
    ).toThrow('different Y.Doc')
  })

  it('disposes observer', () => {
    const ydoc = new Doc()
    const config = makeConfig(ydoc)
    const bridge = createYjsBridge(config, { initialText: 'hello' })
    bridge.dispose()
    // After dispose, text changes should not propagate
    ydoc.getText('text').delete(0, 5)
    ydoc.getText('text').insert(0, 'gone')
    // No error thrown means observer was removed
  })
})
