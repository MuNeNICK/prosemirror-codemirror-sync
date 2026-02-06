import { memo, useEffect, useRef, useState } from 'react'
import type { EditorView } from 'prosemirror-view'
import { EditorToolbar } from './EditorToolbar'
import {
  applyMarkdownToProseMirror,
  createProseMirrorState,
  EXTERNAL_SYNC_META,
  extractMarkdownFromProseMirror,
} from '../lib/prosemirrorEditor'
import { shouldSkipSync } from '../lib/sync'
import type { UpdateSource } from '../types/editor'
import { EditorView as ProseMirrorEditorView } from 'prosemirror-view'

type WysiwygPaneProps = {
  markdown: string
  onChange: (markdown: string) => void
  source: UpdateSource
}

export const WysiwygPane = memo(function WysiwygPane({ markdown, onChange, source }: WysiwygPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  const initialMarkdownRef = useRef(markdown)
  const [view, setView] = useState<EditorView | null>(null)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const hostElement = hostRef.current
    if (!hostElement) {
      return
    }

    const editorView = new ProseMirrorEditorView(hostElement, {
      state: createProseMirrorState(initialMarkdownRef.current),
      dispatchTransaction(transaction) {
        const nextState = editorView.state.apply(transaction)
        editorView.updateState(nextState)

        if (!transaction.docChanged || transaction.getMeta(EXTERNAL_SYNC_META) === true) {
          return
        }

        onChangeRef.current(extractMarkdownFromProseMirror(editorView))
      },
      attributes: {
        class: 'wysiwyg-editor__content',
      },
    })

    setView(editorView)

    return () => {
      editorView.destroy()
      setView(null)
    }
  }, [])

  useEffect(() => {
    if (!view) {
      return
    }

    if (shouldSkipSync(source, 'wysiwyg')) {
      return
    }

    applyMarkdownToProseMirror(view, markdown)
  }, [view, markdown, source])

  return (
    <div className="pane">
      <div className="pane__header">
        <h2>WYSIWYG</h2>
      </div>
      <EditorToolbar view={view} />
      <div className="pane__editor pane__editor--wysiwyg">
        <div ref={hostRef} className="wysiwyg-host" />
      </div>
    </div>
  )
})
