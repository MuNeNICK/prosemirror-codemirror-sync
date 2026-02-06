import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignLeft,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListChecks,
  Minus,
  Quote,
  Table2,
} from 'lucide-react'
import type { EditorState as ProseMirrorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { ReactNode } from 'react'
import {
  applyMarkdownToProseMirror,
  createProseMirrorState,
  deleteTextRange,
  executeSlashCommand,
  EXTERNAL_SYNC_META,
  extractMarkdownFromProseMirror,
  getSlashCommandMatch,
  getSlashCommands,
  OPEN_SLASH_MENU_META,
  type SlashCommandMatch,
  type SlashCommandId,
  type SlashCommandSpec,
} from '../lib/prosemirrorEditor'
import { shouldSkipSync } from '../lib/sync'
import type { UpdateSource } from '../types/editor'
import { EditorView as ProseMirrorEditorView } from 'prosemirror-view'

type WysiwygPaneProps = {
  markdown: string
  onChange: (markdown: string) => void
  source: UpdateSource
}

type SlashMenuState = {
  query: string
  from: number
  to: number
  top: number
  left: number
  mode: 'slash' | 'manual'
}

type SlashCommandGroup = {
  key: string
  label: string
  ids: SlashCommandId[]
}

type RenderedSlashCommandGroup = {
  key: string
  label: string
  items: Array<{
    command: SlashCommandSpec
    index: number
  }>
  range: readonly [number, number]
}

const slashCommandIconById: Record<SlashCommandId, ReactNode> = {
  text: <AlignLeft size={20} />,
  heading1: <Heading1 size={20} />,
  heading2: <Heading2 size={20} />,
  heading3: <Heading3 size={20} />,
  bullet_list: <List size={20} />,
  todo_list: <ListChecks size={20} />,
  quote: <Quote size={20} />,
  code_block: <Code2 size={20} />,
  divider: <Minus size={20} />,
  table: <Table2 size={20} />,
}

const slashCommandGroups: SlashCommandGroup[] = [
  {
    key: 'text',
    label: 'Text',
    ids: ['text', 'heading1', 'heading2', 'heading3', 'quote'],
  },
  {
    key: 'list',
    label: 'List',
    ids: ['bullet_list', 'todo_list'],
  },
  {
    key: 'insert',
    label: 'Insert',
    ids: ['code_block', 'divider', 'table'],
  },
]

function nextMenuIndex(current: number, total: number): number {
  if (total <= 0) {
    return 0
  }

  return Math.min(current + 1, total - 1)
}

function previousMenuIndex(current: number, total: number): number {
  if (total <= 0) {
    return 0
  }

  return Math.max(current - 1, 0)
}

function isInListContext(state: ProseMirrorState): boolean {
  const { $from } = state.selection

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name
    if (
      nodeName === 'list_item' ||
      nodeName === 'task_item' ||
      nodeName === 'bullet_list' ||
      nodeName === 'ordered_list' ||
      nodeName === 'task_list'
    ) {
      return true
    }
  }

  return false
}

function getManualSlashCommandMatch(state: ProseMirrorState): SlashCommandMatch | null {
  const { selection } = state

  if (!selection.empty) {
    return null
  }

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parent.type.name === 'code_block') {
    return null
  }

  if ($from.parentOffset !== $from.parent.content.size) {
    return null
  }

  if (isInListContext(state)) {
    return null
  }

  const fullText = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')

  return {
    query: fullText.toLowerCase(),
    from: $from.start(),
    to: $from.pos,
  }
}

function buildSlashMenuGroups(commands: SlashCommandSpec[]): RenderedSlashCommandGroup[] {
  const indexById = new Map(commands.map((command, index) => [command.id, index]))
  const consumed = new Set<SlashCommandId>()
  const groups: RenderedSlashCommandGroup[] = []

  for (const group of slashCommandGroups) {
    const items = group.ids
      .map((id) => {
        const index = indexById.get(id)
        if (index === undefined) {
          return null
        }

        consumed.add(id)
        return {
          command: commands[index],
          index,
        }
      })
      .filter((item): item is { command: SlashCommandSpec; index: number } => item !== null)
      .sort((a, b) => a.index - b.index)

    if (items.length === 0) {
      continue
    }

    groups.push({
      key: group.key,
      label: group.label,
      items,
      range: [items[0].index, items[items.length - 1].index + 1] as const,
    })
  }

  const remainingItems = commands
    .map((command, index) => ({
      command,
      index,
    }))
    .filter(({ command }) => !consumed.has(command.id))

  if (remainingItems.length > 0) {
    groups.push({
      key: 'other',
      label: 'Other',
      items: remainingItems,
      range: [remainingItems[0].index, remainingItems[remainingItems.length - 1].index + 1] as const,
    })
  }

  return groups
}

function findGroupByIndex(
  groups: RenderedSlashCommandGroup[],
  index: number,
): RenderedSlashCommandGroup | null {
  const found = groups.find((group) => index >= group.range[0] && index < group.range[1])
  return found ?? null
}

export const WysiwygPane = memo(function WysiwygPane({ markdown, onChange, source }: WysiwygPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const slashMenuElementRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  const initialMarkdownRef = useRef(markdown)
  const [view, setView] = useState<EditorView | null>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)

  const slashMenuRef = useRef<SlashMenuState | null>(null)
  const slashIndexRef = useRef(0)
  const manualSlashModeRef = useRef(false)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    slashMenuRef.current = slashMenu
  }, [slashMenu])

  useEffect(() => {
    slashIndexRef.current = slashIndex
  }, [slashIndex])

  const slashCommands = useMemo(() => {
    return getSlashCommands(slashMenu?.query ?? '')
  }, [slashMenu?.query])

  const groupedSlashCommands = useMemo(() => {
    return buildSlashMenuGroups(slashCommands)
  }, [slashCommands])

  const activeSlashIndex =
    slashCommands.length === 0 ? 0 : Math.min(slashIndex, Math.max(0, slashCommands.length - 1))

  const activeSlashGroupKey = useMemo(() => {
    const activeGroup = findGroupByIndex(groupedSlashCommands, activeSlashIndex)
    return activeGroup?.key ?? null
  }, [groupedSlashCommands, activeSlashIndex])

  const applySlashCommand = useCallback(
    (command: SlashCommandSpec) => {
      if (!view || !slashMenu) {
        return
      }

      deleteTextRange(view, slashMenu.from, slashMenu.to)
      executeSlashCommand(view, command.id)
      manualSlashModeRef.current = false
      setSlashMenu(null)
    },
    [view, slashMenu],
  )

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

        if (transaction.getMeta(OPEN_SLASH_MENU_META) === true) {
          manualSlashModeRef.current = true
          setSlashIndex(0)
        }

        let slashMatch = getSlashCommandMatch(nextState)
        let slashMode: SlashMenuState['mode'] = 'slash'

        if (!slashMatch && manualSlashModeRef.current) {
          slashMatch = getManualSlashCommandMatch(nextState)
          if (slashMatch) {
            slashMode = 'manual'
          } else {
            manualSlashModeRef.current = false
          }
        }

        if (slashMatch) {
          if (slashMode === 'slash') {
            manualSlashModeRef.current = false
          }

          if (
            !slashMenuRef.current ||
            slashMenuRef.current.query !== slashMatch.query ||
            slashMenuRef.current.mode !== slashMode
          ) {
            setSlashIndex(0)
          }

          const cursorCoordinates = editorView.coordsAtPos(slashMatch.to)
          setSlashMenu({
            ...slashMatch,
            top: cursorCoordinates.bottom + 6,
            left: cursorCoordinates.left,
            mode: slashMode,
          })
        } else {
          setSlashMenu(null)
        }

        if (!transaction.docChanged || transaction.getMeta(EXTERNAL_SYNC_META) === true) {
          return
        }

        onChangeRef.current(extractMarkdownFromProseMirror(editorView))
      },
      handleKeyDown(view, event) {
        const currentSlashMenu = slashMenuRef.current

        if (!currentSlashMenu) {
          return false
        }

        const commands = getSlashCommands(currentSlashMenu.query)
        if (commands.length === 0) {
          if (event.key === 'Escape') {
            event.preventDefault()
            setSlashMenu(null)
            return true
          }

          return false
        }

        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault()
            setSlashIndex((currentIndex) => nextMenuIndex(currentIndex, commands.length))
            return true
          case 'ArrowUp':
            event.preventDefault()
            setSlashIndex((currentIndex) => previousMenuIndex(currentIndex, commands.length))
            return true
          case 'ArrowLeft': {
            event.preventDefault()
            const menuGroups = buildSlashMenuGroups(commands)
            const currentIndex = Math.min(slashIndexRef.current, Math.max(0, commands.length - 1))
            const activeGroup = findGroupByIndex(menuGroups, currentIndex)
            if (!activeGroup) {
              return true
            }

            const groupIndex = menuGroups.findIndex((group) => group.key === activeGroup.key)
            const previousGroup = menuGroups[groupIndex - 1]
            if (previousGroup) {
              setSlashIndex(previousGroup.range[1] - 1)
            }
            return true
          }
          case 'ArrowRight': {
            event.preventDefault()
            const menuGroups = buildSlashMenuGroups(commands)
            const currentIndex = Math.min(slashIndexRef.current, Math.max(0, commands.length - 1))
            const activeGroup = findGroupByIndex(menuGroups, currentIndex)
            if (!activeGroup) {
              return true
            }

            const groupIndex = menuGroups.findIndex((group) => group.key === activeGroup.key)
            const nextGroup = menuGroups[groupIndex + 1]
            if (nextGroup) {
              setSlashIndex(nextGroup.range[0])
            }
            return true
          }
          case 'Tab':
          case 'Enter': {
            event.preventDefault()
            const activeCommand = commands[Math.min(slashIndexRef.current, commands.length - 1)]
            deleteTextRange(view, currentSlashMenu.from, currentSlashMenu.to)
            executeSlashCommand(view, activeCommand.id)
            manualSlashModeRef.current = false
            setSlashMenu(null)
            return true
          }
          case 'Escape':
            event.preventDefault()
            manualSlashModeRef.current = false
            setSlashMenu(null)
            return true
          default:
            return false
        }
      },
      attributes: {
        class: 'wysiwyg-editor__content',
        'data-placeholder': "Type '/' to open commands",
      },
    })

    setView(editorView)

    return () => {
      editorView.destroy()
      setView(null)
      manualSlashModeRef.current = false
      setSlashMenu(null)
    }
  }, [])

  useEffect(() => {
    if (!slashMenu) {
      return
    }

    const documentRef = hostRef.current?.ownerDocument
    if (!documentRef) {
      return
    }

    const onPointerDownOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (slashMenuElementRef.current?.contains(target)) {
        return
      }

      if (hostRef.current?.contains(target)) {
        return
      }

      manualSlashModeRef.current = false
      setSlashMenu(null)
    }

    documentRef.addEventListener('pointerdown', onPointerDownOutside, true)
    return () => {
      documentRef.removeEventListener('pointerdown', onPointerDownOutside, true)
    }
  }, [slashMenu])

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
      <div className="pane__editor pane__editor--wysiwyg">
        <div ref={hostRef} className="wysiwyg-host" />
      </div>
      {slashMenu ? (
        <div
          ref={slashMenuElementRef}
          className="slash-menu"
          role="listbox"
          style={{
            top: `${slashMenu.top}px`,
            left: `${slashMenu.left}px`,
          }}
        >
          {slashCommands.length === 0 ? (
            <div className="slash-menu__empty">No matching commands</div>
          ) : (
            <>
              <nav className="slash-menu__tab-group">
                <ul>
                  {groupedSlashCommands.map((group) => (
                    <li
                      key={group.key}
                      className={group.key === activeSlashGroupKey ? 'selected' : ''}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        setSlashIndex(group.range[0])
                      }}
                    >
                      {group.label}
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="slash-menu__groups">
                {groupedSlashCommands.map((group) => (
                  <div key={group.key} className="slash-menu__group">
                    <h6>{group.label}</h6>
                    {group.items.map(({ command, index }) => {
                      const isActive = index === activeSlashIndex

                      return (
                        <button
                          key={command.id}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          className={`slash-menu__item${isActive ? ' is-active' : ''}`}
                          onMouseEnter={() => {
                            setSlashIndex(index)
                          }}
                          onMouseDown={(event) => {
                            event.preventDefault()
                          }}
                          onMouseUp={(event) => {
                            event.preventDefault()
                            applySlashCommand(command)
                          }}
                        >
                          <span className="slash-menu__item-icon" aria-hidden>
                            {slashCommandIconById[command.id]}
                          </span>
                          <span className="slash-menu__item-text">
                            <strong>{command.title}</strong>
                            <span>{command.description}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
})
