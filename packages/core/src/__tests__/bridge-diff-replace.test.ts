import { describe, it, expect } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState, Transaction } from 'prosemirror-state'
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
  doc.forEach((node: Node) => lines.push(node.textContent))
  return lines.join('\n')
}

function parse(text: string) {
  const paragraphs = text.split('\n').map((line) =>
    schema.node('paragraph', null, line ? [schema.text(line)] : []),
  )
  return schema.node('doc', null, paragraphs)
}

function makeLargeText(lineCount: number, lineWidth = 48): string {
  const lines = Array.from({ length: lineCount }, (_, i) => {
    const prefix = `line-${String(i).padStart(4, '0')}-`
    return prefix + 'x'.repeat(Math.max(0, lineWidth - prefix.length))
  })
  return lines.join('\n')
}

function changeSingleCharacter(text: string, targetLine: number): string {
  const lines = text.split('\n')
  const line = lines[targetLine]
  const chars = line.split('')
  chars[chars.length - 1] = chars[chars.length - 1] === 'x' ? 'y' : 'x'
  lines[targetLine] = chars.join('')
  return lines.join('\n')
}

function touchedOldRangeSize(tr: Transaction): number {
  let touched = 0
  for (const step of tr.steps) {
    step.getMap().forEach((oldStart, oldEnd) => {
      touched += Math.max(0, oldEnd - oldStart)
    })
  }
  return touched
}

function makeTrackedView(initialText: string): { view: EditorView; getLastTr: () => Transaction | null } {
  let lastTr: Transaction | null = null
  let view: EditorView
  view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ schema, doc: parse(initialText) }),
    dispatchTransaction(tr) {
      lastTr = tr
      view.updateState(view.state.apply(tr))
    },
  })
  return { view, getLastTr: () => lastTr }
}

describe('bridge: diff-based replace', () => {
  it('single-character edits should not touch most of the old PM document', () => {
    const initial = makeLargeText(400)
    const next = changeSingleCharacter(initial, 200)
    const bridge = createViewBridge({ schema, serialize, parse })
    const { view, getLastTr } = makeTrackedView(initial)

    const beforeSize = view.state.doc.content.size
    const result = bridge.applyText(view, next)

    expect(result).toEqual({ ok: true })
    const tr = getLastTr()
    expect(tr).not.toBeNull()

    const touchedRatio = touchedOldRangeSize(tr!) / beforeSize
    // Acceptance criterion: a one-char edit should touch <= 15% of old content.
    expect(touchedRatio).toBeLessThanOrEqual(0.15)

    view.destroy()
  })

  it('single-line edits should preserve most untouched block node identities', () => {
    const initial = makeLargeText(250)
    const next = changeSingleCharacter(initial, 125)
    const bridge = createViewBridge({ schema, serialize, parse })
    const { view } = makeTrackedView(initial)

    const beforeBlocks = Array.from({ length: view.state.doc.childCount }, (_, i) => view.state.doc.child(i))

    const result = bridge.applyText(view, next)
    expect(result).toEqual({ ok: true })

    const preserved = beforeBlocks.filter((node, i) => view.state.doc.child(i) === node).length
    const preservationRatio = preserved / beforeBlocks.length
    // Acceptance criterion: keep >= 90% of block identities for a local one-line change.
    expect(preservationRatio).toBeGreaterThanOrEqual(0.9)

    view.destroy()
  })

  it('replacement churn should stay near-constant as docs grow (size threshold)', () => {
    const bridge = createViewBridge({ schema, serialize, parse })

    function changedBlockCount(lineCount: number): number {
      const initial = makeLargeText(lineCount)
      const next = changeSingleCharacter(initial, Math.floor(lineCount / 2))
      const { view } = makeTrackedView(initial)
      const beforeBlocks = Array.from({ length: view.state.doc.childCount }, (_, i) => view.state.doc.child(i))
      bridge.applyText(view, next)
      const changed = beforeBlocks.filter((node, i) => view.state.doc.child(i) !== node).length
      view.destroy()
      return changed
    }

    const changedAt50 = changedBlockCount(50)
    const changedAt500 = changedBlockCount(500)

    // Acceptance criteria:
    // - small docs: at most 5 changed blocks for a one-char edit
    // - large docs: at most 10 changed blocks for the same one-char edit
    expect(changedAt50).toBeLessThanOrEqual(5)
    expect(changedAt500).toBeLessThanOrEqual(10)
  })
})
