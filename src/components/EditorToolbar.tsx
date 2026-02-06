import { setBlockType, toggleMark } from 'prosemirror-commands'
import type { EditorView } from 'prosemirror-view'
import {
  runCommand,
  toggleTaskItemChecked,
  wrapSelectionInBulletList,
  wrapSelectionInTaskList,
} from '../lib/prosemirrorEditor'
import { prosemirrorSchema } from '../lib/prosemirrorSchema'

type EditorToolbarProps = {
  view: EditorView | null
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function withFocus(view: EditorView, command: () => void): void {
  view.focus()
  command()
}

function createTableNode(rows: number, cols: number) {
  const tableType = prosemirrorSchema.nodes.table
  const rowType = prosemirrorSchema.nodes.table_row
  const cellType = prosemirrorSchema.nodes.table_cell
  const headerType = prosemirrorSchema.nodes.table_header
  const paragraphType = prosemirrorSchema.nodes.paragraph

  if (!tableType || !rowType || !cellType || !headerType || !paragraphType) {
    return null
  }

  const tableRows = Array.from({ length: rows }, (_, rowIndex) => {
    const currentCellType = rowIndex === 0 ? headerType : cellType
    const cells = Array.from({ length: cols }, () => currentCellType.create(null, paragraphType.create()))
    return rowType.create(null, cells)
  })

  return tableType.create(null, tableRows)
}

export function EditorToolbar({ view }: EditorToolbarProps) {
  if (!view) {
    return (
      <div className="toolbar" aria-hidden>
        <button disabled type="button">
          B
        </button>
      </div>
    )
  }

  const strong = prosemirrorSchema.marks.strong
  const em = prosemirrorSchema.marks.em
  const heading = prosemirrorSchema.nodes.heading
  const codeBlock = prosemirrorSchema.nodes.code_block
  const imageNode = prosemirrorSchema.nodes.image
  const linkMark = prosemirrorSchema.marks.link

  const setLink = () => {
    if (!linkMark) {
      return
    }

    const url = window.prompt('リンクURLを入力してください', 'https://')
    if (url === null) {
      return
    }

    const trimmed = url.trim()
    const { from, to, empty } = view.state.selection

    if (empty) {
      window.alert('リンクを設定するには、先にテキストを選択してください。')
      return
    }

    if (trimmed.length === 0) {
      const transaction = view.state.tr.removeMark(from, to, linkMark)
      view.dispatch(transaction.scrollIntoView())
      return
    }

    if (!isValidUrl(trimmed)) {
      window.alert('http/https の有効なURLを入力してください。')
      return
    }

    const transaction = view.state.tr.addMark(
      from,
      to,
      linkMark.create({
        href: trimmed,
        title: null,
      }),
    )
    view.dispatch(transaction.scrollIntoView())
  }

  const setImage = () => {
    if (!imageNode) {
      return
    }

    const url = window.prompt('画像URLを入力してください', 'https://')
    if (!url) {
      return
    }

    const trimmed = url.trim()

    if (!isValidUrl(trimmed)) {
      window.alert('http/https の有効なURLを入力してください。')
      return
    }

    const transaction = view.state.tr.replaceSelectionWith(
      imageNode.create({
        src: trimmed,
        alt: '',
        title: null,
      }),
    )

    view.dispatch(transaction.scrollIntoView())
  }

  return (
    <div className="toolbar" role="toolbar" aria-label="WYSIWYG actions">
      <button
        type="button"
        onClick={() => {
          if (!strong) {
            return
          }

          withFocus(view, () => {
            runCommand(view, toggleMark(strong))
          })
        }}
      >
        B
      </button>
      <button
        type="button"
        onClick={() => {
          if (!em) {
            return
          }

          withFocus(view, () => {
            runCommand(view, toggleMark(em))
          })
        }}
      >
        I
      </button>
      <button
        type="button"
        onClick={() => {
          if (!heading) {
            return
          }

          withFocus(view, () => {
            runCommand(view, setBlockType(heading, { level: 2 }))
          })
        }}
      >
        H2
      </button>
      <button
        type="button"
        onClick={() => {
          if (!codeBlock) {
            return
          }

          withFocus(view, () => {
            runCommand(view, setBlockType(codeBlock))
          })
        }}
      >
        Code
      </button>
      <button
        type="button"
        onClick={() => {
          withFocus(view, () => {
            wrapSelectionInBulletList(view)
          })
        }}
      >
        List
      </button>
      <button
        type="button"
        onClick={() => {
          withFocus(view, () => {
            if (!toggleTaskItemChecked(view)) {
              wrapSelectionInTaskList(view)
            }
          })
        }}
      >
        Task
      </button>
      <button
        type="button"
        onClick={() => {
          withFocus(view, () => {
            const tableNode = createTableNode(3, 3)
            if (!tableNode) {
              return
            }

            const transaction = view.state.tr.replaceSelectionWith(tableNode)
            view.dispatch(transaction.scrollIntoView())
          })
        }}
      >
        Table
      </button>
      <button
        type="button"
        onClick={() => {
          withFocus(view, setLink)
        }}
      >
        Link
      </button>
      <button
        type="button"
        onClick={() => {
          withFocus(view, setImage)
        }}
      >
        Image
      </button>
    </div>
  )
}
