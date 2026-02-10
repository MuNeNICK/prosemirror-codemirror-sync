import { describe, it, expect } from 'vitest'
import { Node, Schema } from 'prosemirror-model'
import { EditorState, Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createViewBridge, diffText } from '../bridge.js'
import type { IncrementalParse, IncrementalParseResult } from '../types.js'

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

const incrementalParse: IncrementalParse = ({ prevDoc, prevText, text, diff, schema: s }) => {
  const oldLines = prevText.split('\n')
  const newLines = text.split('\n')

  let firstLine = 0, charCount = 0
  for (let i = 0; i < oldLines.length; i++) {
    if (charCount + oldLines[i].length >= diff.start) { firstLine = i; break }
    charCount += oldLines[i].length + 1
  }

  let commonSuffix = 0
  while (
    commonSuffix < oldLines.length &&
    commonSuffix < newLines.length &&
    oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
  ) commonSuffix++

  const lastNewLine = newLines.length - commonSuffix
  const lastOldLine = oldLines.length - commonSuffix

  const children: Node[] = []
  for (let i = 0; i < firstLine; i++) children.push(prevDoc.child(i))
  for (let i = firstLine; i < lastNewLine; i++) {
    const line = newLines[i]
    children.push(s.node('paragraph', null, line ? [s.text(line)] : []))
  }
  for (let i = lastOldLine; i < prevDoc.childCount; i++) children.push(prevDoc.child(i))

  return s.node('doc', null, children)
}

/** Same as incrementalParse but returns { doc, from, to, toB } to skip findDiffStart/End */
const incrementalParseWithRange: IncrementalParse = ({ prevDoc, prevText, text, diff, schema: s }) => {
  const oldLines = prevText.split('\n')
  const newLines = text.split('\n')

  let firstLine = 0, charCount = 0
  for (let i = 0; i < oldLines.length; i++) {
    if (charCount + oldLines[i].length >= diff.start) { firstLine = i; break }
    charCount += oldLines[i].length + 1
  }

  let commonSuffix = 0
  while (
    commonSuffix < oldLines.length &&
    commonSuffix < newLines.length &&
    oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
  ) commonSuffix++

  const lastNewLine = newLines.length - commonSuffix
  const lastOldLine = oldLines.length - commonSuffix

  const children: Node[] = []
  for (let i = 0; i < firstLine; i++) children.push(prevDoc.child(i))
  for (let i = firstLine; i < lastNewLine; i++) {
    const line = newLines[i]
    children.push(s.node('paragraph', null, line ? [s.text(line)] : []))
  }
  for (let i = lastOldLine; i < prevDoc.childCount; i++) children.push(prevDoc.child(i))

  const doc = s.node('doc', null, children)

  // Compute PM positions for the changed range
  let from = 0
  for (let i = 0; i < firstLine; i++) from += prevDoc.child(i).nodeSize
  let to = from
  for (let i = firstLine; i < lastOldLine; i++) to += prevDoc.child(i).nodeSize
  let toB = from
  for (let i = firstLine; i < lastNewLine; i++) toB += doc.child(i).nodeSize

  return { doc, from, to, toB }
}

function makeLargeText(lineCount: number, lineWidth = 48): string {
  const lines = Array.from({ length: lineCount }, (_, i) => {
    const prefix = `line-${String(i).padStart(6, '0')}-`
    return prefix + 'x'.repeat(Math.max(0, lineWidth - prefix.length))
  })
  return lines.join('\n')
}

function changeSingleCharacter(text: string, targetLine: number): string {
  const lines = text.split('\n')
  const chars = lines[targetLine].split('')
  chars[chars.length - 1] = chars[chars.length - 1] === 'x' ? 'y' : 'x'
  lines[targetLine] = chars.join('')
  return lines.join('\n')
}

function makeTrackedView(initialText: string) {
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

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

describe('bridge: scale benchmark', () => {
  const sizes = [1_000, 5_000, 10_000, 50_000]

  it('compare: no cache vs cache vs cache+incremental vs full optimization', { timeout: 30_000 }, () => {
    const results: string[] = []
    results.push('')
    results.push('  Size     | No optimization | Cache only | Cache+Incr | +Diff      | +Diff+Range')
    results.push('  ---------+-----------------+------------+------------+------------+------------')

    for (const size of sizes) {
      const initial = makeLargeText(size)
      const mid = Math.floor(size / 2)
      const iterations = 10

      // --- Baseline: no optimization (parseCacheSize=0, no incrementalParse) ---
      const bridgeBaseline = createViewBridge({ schema, serialize, parse, parseCacheSize: 0 })
      const { view: v1 } = makeTrackedView(initial)
      bridgeBaseline.applyText(v1, changeSingleCharacter(initial, mid))

      const baselineTimes: number[] = []
      for (let i = 0; i < iterations; i++) {
        const next = changeSingleCharacter(initial, mid + i + 1)
        const t0 = performance.now()
        bridgeBaseline.applyText(v1, next)
        baselineTimes.push(performance.now() - t0)
      }
      v1.destroy()

      // --- Cache only (default config) ---
      const bridgeCached = createViewBridge({ schema, serialize, parse })
      const { view: v2 } = makeTrackedView(initial)
      bridgeCached.applyText(v2, changeSingleCharacter(initial, mid))

      const cachedTimes: number[] = []
      for (let i = 0; i < iterations; i++) {
        const next = changeSingleCharacter(initial, mid + i + 1)
        const t0 = performance.now()
        bridgeCached.applyText(v2, next)
        cachedTimes.push(performance.now() - t0)
      }
      v2.destroy()

      // --- Cache + IncrementalParse ---
      const bridgeIncremental = createViewBridge({ schema, serialize, parse, incrementalParse })
      const { view: v3 } = makeTrackedView(initial)
      bridgeIncremental.applyText(v3, changeSingleCharacter(initial, mid))

      const incrementalTimes: number[] = []
      for (let i = 0; i < iterations; i++) {
        const next = changeSingleCharacter(initial, mid + i + 1)
        const t0 = performance.now()
        bridgeIncremental.applyText(v3, next)
        incrementalTimes.push(performance.now() - t0)
      }
      v3.destroy()

      // --- Cache + IncrementalParse + pre-computed diff ---
      const bridgeFull = createViewBridge({ schema, serialize, parse, incrementalParse })
      const { view: v4 } = makeTrackedView(initial)
      let prevText = initial
      bridgeFull.applyText(v4, changeSingleCharacter(initial, mid))
      prevText = changeSingleCharacter(initial, mid)

      const fullTimes: number[] = []
      for (let i = 0; i < iterations; i++) {
        const next = changeSingleCharacter(initial, mid + i + 1)
        // Pre-compute diff outside the timer (simulating CM changeset)
        const diff = diffText(prevText, next)
        const t0 = performance.now()
        bridgeFull.applyText(v4, next, { diff })
        fullTimes.push(performance.now() - t0)
        prevText = next
      }
      v4.destroy()

      // --- Full optimization: Cache + IncrementalParse(range) + diff + normalized ---
      const bridgeMax = createViewBridge({ schema, serialize, parse, incrementalParse: incrementalParseWithRange })
      const { view: v5 } = makeTrackedView(initial)
      let prevText5 = initial
      bridgeMax.applyText(v5, changeSingleCharacter(initial, mid))
      prevText5 = changeSingleCharacter(initial, mid)

      const maxTimes: number[] = []
      for (let i = 0; i < iterations; i++) {
        const next = changeSingleCharacter(initial, mid + i + 1)
        const diff = diffText(prevText5, next)
        const t0 = performance.now()
        bridgeMax.applyText(v5, next, { diff, normalized: true })
        maxTimes.push(performance.now() - t0)
        prevText5 = next
      }
      v5.destroy()

      const bMs = median(baselineTimes).toFixed(1)
      const cMs = median(cachedTimes).toFixed(1)
      const iMs = median(incrementalTimes).toFixed(1)
      const fMs = median(fullTimes).toFixed(1)
      const mMs = median(maxTimes).toFixed(1)

      results.push(
        `  ${String(size).padStart(6)} ln |` +
        ` ${bMs.padStart(12)} ms |` +
        ` ${cMs.padStart(7)} ms |` +
        ` ${iMs.padStart(7)} ms |` +
        ` ${fMs.padStart(7)} ms |` +
        ` ${mMs.padStart(7)} ms`
      )
    }

    console.log(results.join('\n'))
    expect(true).toBe(true)
  })

  it('repeated identical text (echo loop) performance', () => {
    const results: string[] = []
    results.push('')
    results.push('  Echo loop (100 repeated calls, same text):')

    for (const size of [1_000, 10_000, 50_000]) {
      const initial = makeLargeText(size)
      const bridge = createViewBridge({ schema, serialize, parse })
      const { view } = makeTrackedView(initial)

      // First call to establish cache
      bridge.applyText(view, initial)

      const times: number[] = []
      for (let i = 0; i < 100; i++) {
        const t0 = performance.now()
        bridge.applyText(view, initial)
        times.push(performance.now() - t0)
      }

      const med = median(times)
      results.push(`    ${String(size).padStart(6)} lines: median ${med.toFixed(4)}ms`)

      view.destroy()
    }

    console.log(results.join('\n'))
    // Note: remaining cost is normalize() regex on the incoming text (O(n))
    // No serialize, no parse, no doc.eq — only normalize + string comparison
    expect(true).toBe(true)
  })
})
