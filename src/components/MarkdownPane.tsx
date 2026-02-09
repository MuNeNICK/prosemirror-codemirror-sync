import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { memo, useEffect, useMemo, useRef } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { Text as YText } from 'yjs'
import { yCollab } from 'y-codemirror.next'

type MarkdownPaneProps = {
  sharedMarkdown: YText
  awareness: Awareness
  scrollToOffset?: number
  onCursorPositionChange?: (mdOffset: number) => void
}

export const MarkdownPane = memo(function MarkdownPane({
  sharedMarkdown,
  awareness,
  scrollToOffset,
  onCursorPositionChange,
}: MarkdownPaneProps) {
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const onCursorPositionChangeRef = useRef(onCursorPositionChange)

  useEffect(() => {
    onCursorPositionChangeRef.current = onCursorPositionChange
  }, [onCursorPositionChange])

  const cursorListener = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!update.view.hasFocus) return
        if (!update.selectionSet && !update.docChanged) return
        onCursorPositionChangeRef.current?.(update.state.selection.main.head)
      }),
    [],
  )

  const extensions = useMemo(
    () => [markdownLanguage(), yCollab(sharedMarkdown, awareness), cursorListener],
    [sharedMarkdown, awareness, cursorListener],
  )

  useEffect(() => {
    if (scrollToOffset === undefined) return
    const view = cmRef.current?.view
    if (!view) return

    // Don't scroll if CodeMirror has focus (user is editing there)
    if (view.hasFocus) return

    const docLength = view.state.doc.length
    const clampedOffset = Math.min(scrollToOffset, docLength)

    view.dispatch({
      selection: { anchor: clampedOffset },
      effects: EditorView.scrollIntoView(clampedOffset, { y: 'center' }),
    })
  }, [scrollToOffset])

  return (
    <div className="pane">
      <CodeMirror
        ref={cmRef}
        aria-label="Markdown editor"
        className="pane__editor pane__editor--markdown"
        extensions={extensions}
        height="100%"
        value={sharedMarkdown.toString()}
      />
    </div>
  )
})
