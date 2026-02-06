import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import CodeMirror from '@uiw/react-codemirror'
import { memo, useMemo } from 'react'

type MarkdownPaneProps = {
  markdown: string
  onChange: (markdown: string) => void
}

export const MarkdownPane = memo(function MarkdownPane({ markdown, onChange }: MarkdownPaneProps) {
  const extensions = useMemo(() => [markdownLanguage()], [])

  return (
    <div className="pane">
      <CodeMirror
        aria-label="Markdown editor"
        className="pane__editor pane__editor--markdown"
        extensions={extensions}
        height="100%"
        onChange={onChange}
        value={markdown}
      />
    </div>
  )
})
