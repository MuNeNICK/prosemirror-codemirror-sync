import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import CodeMirror from '@uiw/react-codemirror'
import { memo, useMemo } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { Text as YText } from 'yjs'
import { yCollab } from 'y-codemirror.next'

type MarkdownPaneProps = {
  sharedMarkdown: YText
  awareness: Awareness
}

export const MarkdownPane = memo(function MarkdownPane({
  sharedMarkdown,
  awareness,
}: MarkdownPaneProps) {
  const extensions = useMemo(
    () => [markdownLanguage(), yCollab(sharedMarkdown, awareness)],
    [sharedMarkdown, awareness],
  )

  return (
    <div className="pane">
      <CodeMirror
        aria-label="Markdown editor"
        className="pane__editor pane__editor--markdown"
        extensions={extensions}
        height="100%"
        value={sharedMarkdown.toString()}
      />
    </div>
  )
})
