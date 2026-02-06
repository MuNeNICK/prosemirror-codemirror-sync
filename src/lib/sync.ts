import type { SyncTarget, UpdateSource } from '../types/editor'

type CodeMirrorLikeView = {
  state: {
    doc: {
      length: number
      toString: () => string
    }
  }
  dispatch: (transaction: {
    changes: {
      from: number
      to: number
      insert: string
    }
  }) => void
}

export function shouldSkipSync(lastSource: UpdateSource, nextTarget: SyncTarget): boolean {
  return (
    (lastSource === 'markdown' && nextTarget === 'markdown') ||
    (lastSource === 'wysiwyg' && nextTarget === 'wysiwyg')
  )
}

export function applyMarkdownToCodeMirror(view: CodeMirrorLikeView, markdown: string): boolean {
  const currentMarkdown = view.state.doc.toString()

  if (currentMarkdown === markdown) {
    return false
  }

  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: markdown,
    },
  })

  return true
}
