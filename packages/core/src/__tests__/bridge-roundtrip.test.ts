import { describe, it, expect } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createViewBridge } from '../bridge.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] as const },
    text: { inline: true },
  },
})

function serialize(doc: Node): string {
  const lines: string[] = []
  doc.forEach((node) => lines.push(node.textContent))
  return lines.join('\n')
}

function parseLossy(text: string) {
  const canonical = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')

  const paragraphs = canonical.split('\n').map((line) =>
    schema.node('paragraph', null, line ? [schema.text(line)] : []),
  )
  return schema.node('doc', null, paragraphs)
}

function makeTrackedView(text: string): { view: EditorView; getDispatchCount: () => number } {
  let dispatchCount = 0
  let view: EditorView

  view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ schema, doc: parseLossy(text) }),
    dispatchTransaction(tr) {
      dispatchCount++
      view.updateState(view.state.apply(tr))
    },
  })

  return { view, getDispatchCount: () => dispatchCount }
}

describe('bridge: roundtrip stability', () => {
  it.each([
    'alpha  beta',
    'trailing space   ',
    'x    y    z',
  ])('lossy parse should stabilize at semantic level: "%s"', (input) => {
    // A lossy parser will normalize text, so serialize(parse(text)) !== text.
    // But after one roundtrip the doc should be semantically stable.
    const parsed = parseLossy(input)
    const reparsed = parseLossy(serialize(parsed))
    expect(parsed.eq(reparsed)).toBe(true)
  })

  it('should not dispatch PM transaction when text differs but doc is semantically unchanged', () => {
    const bridge = createViewBridge({ schema, serialize, parse: parseLossy })
    const { view, getDispatchCount } = makeTrackedView('alpha beta')

    // "alpha  beta" parses to same doc as "alpha beta" (lossy normalization)
    const raw = 'alpha  beta'
    const r1 = bridge.applyText(view, raw)
    const r2 = bridge.applyText(view, raw)
    const r3 = bridge.applyText(view, raw)

    // doc.eq guard catches that parsed doc equals current doc
    expect(r1).toEqual({ ok: false, reason: 'unchanged' })
    expect(r2).toEqual({ ok: false, reason: 'unchanged' })
    expect(r3).toEqual({ ok: false, reason: 'unchanged' })

    // No dispatches at all — semantic equality prevents churn
    expect(getDispatchCount()).toBe(0)

    view.destroy()
  })

  it('should self-stabilize under repeated upstream echoes of the same raw payload', () => {
    const bridge = createViewBridge({ schema, serialize, parse: parseLossy })
    const { view } = makeTrackedView('alpha beta')

    const rawEcho = 'alpha  beta'
    let applied = 0

    for (let i = 0; i < 20; i++) {
      const result = bridge.applyText(view, rawEcho)
      if (!result.ok) break
      applied++
    }

    // Acceptance criterion: converge within <= 2 apply attempts.
    expect(applied).toBeLessThanOrEqual(2)

    view.destroy()
  })

  it('should dispatch when text changes produce a semantically different document', () => {
    const bridge = createViewBridge({ schema, serialize, parse: parseLossy })
    const { view, getDispatchCount } = makeTrackedView('hello')

    const r1 = bridge.applyText(view, 'world')
    expect(r1).toEqual({ ok: true })
    expect(getDispatchCount()).toBe(1)

    // Same text again — unchanged
    const r2 = bridge.applyText(view, 'world')
    expect(r2).toEqual({ ok: false, reason: 'unchanged' })
    expect(getDispatchCount()).toBe(1)

    view.destroy()
  })
})
