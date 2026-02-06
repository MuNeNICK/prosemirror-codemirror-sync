import { toggleMark } from 'prosemirror-commands'
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  Minus,
  Quote,
  Table2,
  Type,
} from 'lucide-react'
import type { MarkType } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { ReactNode } from 'react'
import {
  insertDivider,
  insertTable,
  runCommand,
  setBlockQuote,
  setCodeBlock,
  setHeadingBlock,
  setParagraphBlock,
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

function isMarkActive(state: EditorState, markType: MarkType): boolean {
  const { from, to, empty } = state.selection

  if (empty) {
    return Boolean(markType.isInSet(state.storedMarks || state.selection.$from.marks()))
  }

  return state.doc.rangeHasMark(from, to, markType)
}

function isInAncestorNode(state: EditorState, nodeName: string): boolean {
  const { $from } = state.selection

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === nodeName) {
      return true
    }
  }

  return false
}

function isHeadingLevel(state: EditorState, level: 1 | 2): boolean {
  const { $from } = state.selection
  return $from.parent.type.name === 'heading' && Number($from.parent.attrs.level ?? 0) === level
}

function buttonClass(active = false): string {
  return active ? 'toolbar__button is-active' : 'toolbar__button'
}

type ToolbarButtonProps = {
  active?: boolean
  label: string
  onClick: () => void
  icon: ReactNode
}

function ToolbarButton({ active = false, label, onClick, icon }: ToolbarButtonProps) {
  return (
    <button
      aria-label={label}
      className={buttonClass(active)}
      title={label}
      type="button"
      onClick={onClick}
    >
      <span className="toolbar__button-icon" aria-hidden>
        {icon}
      </span>
    </button>
  )
}

export function EditorToolbar({ view }: EditorToolbarProps) {
  if (!view) {
    return (
      <div className="toolbar" aria-hidden>
        <button className="toolbar__button" disabled type="button">
          B
        </button>
      </div>
    )
  }

  const strong = prosemirrorSchema.marks.strong
  const em = prosemirrorSchema.marks.em
  const imageNode = prosemirrorSchema.nodes.image
  const linkMark = prosemirrorSchema.marks.link
  const state = view.state

  const setLink = () => {
    if (!linkMark) {
      return
    }

    const url = window.prompt('Enter link URL', 'https://')
    if (url === null) {
      return
    }

    const trimmed = url.trim()
    const { from, to, empty } = view.state.selection

    if (empty) {
      window.alert('Select some text before setting a link.')
      return
    }

    if (trimmed.length === 0) {
      const transaction = view.state.tr.removeMark(from, to, linkMark)
      view.dispatch(transaction.scrollIntoView())
      return
    }

    if (!isValidUrl(trimmed)) {
      window.alert('Enter a valid http/https URL.')
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

    const url = window.prompt('Enter image URL', 'https://')
    if (!url) {
      return
    }

    const trimmed = url.trim()

    if (!isValidUrl(trimmed)) {
      window.alert('Enter a valid http/https URL.')
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
      <div className="toolbar__group">
        <ToolbarButton
          active={state.selection.$from.parent.type.name === 'paragraph'}
          icon={<Type size={15} />}
          label="Text"
          onClick={() => {
            withFocus(view, () => setParagraphBlock(view))
          }}
        />
        <ToolbarButton
          active={isHeadingLevel(state, 1)}
          icon={<Heading1 size={15} />}
          label="Heading 1"
          onClick={() => {
            withFocus(view, () => setHeadingBlock(view, 1))
          }}
        />
        <ToolbarButton
          active={isHeadingLevel(state, 2)}
          icon={<Heading2 size={15} />}
          label="Heading 2"
          onClick={() => {
            withFocus(view, () => setHeadingBlock(view, 2))
          }}
        />
      </div>

      <div className="toolbar__group">
        <ToolbarButton
          active={Boolean(strong && isMarkActive(state, strong))}
          icon={<Bold size={15} />}
          label="Bold"
          onClick={() => {
            if (!strong) {
              return
            }

            withFocus(view, () => {
              runCommand(view, toggleMark(strong))
            })
          }}
        />
        <ToolbarButton
          active={Boolean(em && isMarkActive(state, em))}
          icon={<Italic size={15} />}
          label="Italic"
          onClick={() => {
            if (!em) {
              return
            }

            withFocus(view, () => {
              runCommand(view, toggleMark(em))
            })
          }}
        />
      </div>

      <div className="toolbar__group">
        <ToolbarButton
          active={isInAncestorNode(state, 'bullet_list')}
          icon={<List size={15} />}
          label="Bulleted list"
          onClick={() => {
            withFocus(view, () => {
              wrapSelectionInBulletList(view)
            })
          }}
        />
        <ToolbarButton
          active={isInAncestorNode(state, 'task_list')}
          icon={<ListChecks size={15} />}
          label="To-do list"
          onClick={() => {
            withFocus(view, () => {
              if (!toggleTaskItemChecked(view)) {
                wrapSelectionInTaskList(view)
              }
            })
          }}
        />
        <ToolbarButton
          active={isInAncestorNode(state, 'blockquote')}
          icon={<Quote size={15} />}
          label="Quote"
          onClick={() => {
            withFocus(view, () => setBlockQuote(view))
          }}
        />
        <ToolbarButton
          active={isInAncestorNode(state, 'code_block')}
          icon={<Code2 size={15} />}
          label="Code block"
          onClick={() => {
            withFocus(view, () => setCodeBlock(view))
          }}
        />
      </div>

      <div className="toolbar__group">
        <ToolbarButton
          icon={<Minus size={15} />}
          label="Divider"
          onClick={() => {
            withFocus(view, () => insertDivider(view))
          }}
        />
        <ToolbarButton
          icon={<Table2 size={15} />}
          label="Table"
          onClick={() => {
            withFocus(view, () => {
              insertTable(view, 3, 3)
            })
          }}
        />
        <ToolbarButton
          icon={<Link2 size={15} />}
          label="Link"
          onClick={() => {
            withFocus(view, setLink)
          }}
        />
        <ToolbarButton
          icon={<ImagePlus size={15} />}
          label="Image"
          onClick={() => {
            withFocus(view, setImage)
          }}
        />
      </div>
    </div>
  )
}
