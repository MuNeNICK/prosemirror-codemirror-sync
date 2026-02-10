import { describe, expect, it } from 'vitest'
import { TextSelection, type Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { createProseMirrorState } from './prosemirrorEditor'
import {
  getSlashCommandMatch,
  getSlashCommands,
  moveTopLevelBlock,
} from './prosemirrorPlugins'

function stateWithCursorAtEnd(markdown: string) {
  const state = createProseMirrorState(markdown)
  let targetPosition: number | null = null

  state.doc.descendants((node, position) => {
    if (targetPosition !== null) {
      return false
    }

    if (!node.isTextblock) {
      return true
    }

    targetPosition = position + 1 + node.content.size
    return false
  })

  if (targetPosition === null) {
    return state
  }

  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, targetPosition)))
}

function stateWithCursorAt(markdown: string, position: number) {
  const state = createProseMirrorState(markdown)
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)))
}

function createMutableView(markdown: string): { view: EditorView; getState: () => ReturnType<typeof createProseMirrorState> } {
  let currentState = createProseMirrorState(markdown)

  const view = {
    get state() {
      return currentState
    },
    dispatch(transaction: Transaction) {
      currentState = currentState.apply(transaction)
    },
  } as unknown as EditorView

  return {
    view,
    getState: () => currentState,
  }
}

function beforePositionOfIndex(state: ReturnType<typeof createProseMirrorState>, index: number): number {
  let before = 0
  for (let i = 0; i < index; i += 1) {
    before += state.doc.child(i).nodeSize
  }
  return before
}

describe('getSlashCommandMatch', () => {
  it('detects slash query at start of paragraph', () => {
    const state = stateWithCursorAtEnd('/tab')
    const match = getSlashCommandMatch(state)

    expect(match?.query).toBe('tab')
    expect(match?.from).toBeLessThan(match?.to ?? 0)
  })

  it('detects slash query after a whitespace', () => {
    const state = stateWithCursorAtEnd('hello /he')
    const match = getSlashCommandMatch(state)

    expect(match?.query).toBe('he')
  })

  it('returns null when slash query contains spaces', () => {
    const state = stateWithCursorAtEnd('/hello world')
    const match = getSlashCommandMatch(state)

    expect(match).toBeNull()
  })

  it('returns null when cursor is not at end of text block', () => {
    const state = stateWithCursorAt('/hello', 4)
    const match = getSlashCommandMatch(state)

    expect(match).toBeNull()
  })

  it('returns null inside list items', () => {
    const state = stateWithCursorAtEnd('- /table')
    const match = getSlashCommandMatch(state)

    expect(match).toBeNull()
  })
})

describe('getSlashCommands', () => {
  it('returns all commands when query is empty', () => {
    expect(getSlashCommands('').length).toBeGreaterThanOrEqual(8)
  })

  it('filters commands by query', () => {
    const results = getSlashCommands('table')
    expect(results.some((command) => command.id === 'table')).toBe(true)
  })
})

describe('moveTopLevelBlock', () => {
  it('moves a block after another block', () => {
    const { view, getState } = createMutableView('A\nB\nC')
    const sourceBefore = beforePositionOfIndex(getState(), 0)
    const targetBefore = beforePositionOfIndex(getState(), 1)

    const moved = moveTopLevelBlock(view, sourceBefore, targetBefore, 'after')

    expect(moved).toBe(true)
    expect(getState().doc.child(0).textContent).toBe('B')
    expect(getState().doc.child(1).textContent).toBe('A')
    expect(getState().doc.child(2).textContent).toBe('C')
  })

  it('returns false when moving block to the same position', () => {
    const { view, getState } = createMutableView('A\nB')
    const sourceBefore = beforePositionOfIndex(getState(), 1)

    const moved = moveTopLevelBlock(view, sourceBefore, sourceBefore, 'before')

    expect(moved).toBe(false)
    expect(getState().doc.child(0).textContent).toBe('A')
    expect(getState().doc.child(1).textContent).toBe('B')
  })
})
