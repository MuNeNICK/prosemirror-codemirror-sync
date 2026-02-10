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
import type { EditorState as ProseMirrorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { ReactNode } from 'react'
import { createProseMirrorState } from '../lib/prosemirrorEditor'
import {
  deleteTextRange,
  executeSlashCommand,
  getSlashCommandMatch,
  getSlashCommands,
  OPEN_SLASH_MENU_META,
  type SlashCommandMatch,
  type SlashCommandId,
  type SlashCommandSpec,
} from '../lib/prosemirrorPlugins'
import { EditorView as ProseMirrorEditorView } from 'prosemirror-view'
import type { Awareness } from 'y-protocols/awareness'
import type { Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import type { Serialize } from '@pm-cm/core'
import type { YjsBridgeHandle } from '@pm-cm/yjs'

type WysiwygPaneProps = {
  initialText: string
  sharedProseMirror?: YXmlFragment
  awareness?: Awareness
  serialize?: Serialize
  sharedText?: YText
  bridge?: YjsBridgeHandle
  onTransaction?: (view: EditorView, tr: Transaction) => void
  onViewReady?: (view: EditorView | null) => void
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
  items: Array<{ command: SlashCommandSpec; index: number }>
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
  { key: 'text', label: 'Text', ids: ['text', 'heading1', 'heading2', 'heading3', 'quote'] },
  { key: 'list', label: 'List', ids: ['bullet_list', 'todo_list'] },
  { key: 'insert', label: 'Insert', ids: ['code_block', 'divider', 'table'] },
]

function nextMenuIndex(current: number, total: number): number {
  return total <= 0 ? 0 : Math.min(current + 1, total - 1)
}

function previousMenuIndex(current: number, total: number): number {
  return total <= 0 ? 0 : Math.max(current - 1, 0)
}

function isInListContext(state: ProseMirrorState): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeName = $from.node(depth).type.name
    if (nodeName === 'list_item' || nodeName === 'task_item' || nodeName === 'bullet_list' || nodeName === 'ordered_list' || nodeName === 'task_list') {
      return true
    }
  }
  return false
}

function getManualSlashCommandMatch(state: ProseMirrorState): SlashCommandMatch | null {
  const { selection } = state
  if (!selection.empty) return null
  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parent.type.name === 'code_block') return null
  if ($from.parentOffset !== $from.parent.content.size) return null
  if (isInListContext(state)) return null
  const fullText = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  return { query: fullText.toLowerCase(), from: $from.start(), to: $from.pos }
}

function buildSlashMenuGroups(commands: SlashCommandSpec[]): RenderedSlashCommandGroup[] {
  const indexById = new Map(commands.map((command, index) => [command.id, index]))
  const consumed = new Set<SlashCommandId>()
  const groups: RenderedSlashCommandGroup[] = []

  for (const group of slashCommandGroups) {
    const items = group.ids
      .map((id) => {
        const index = indexById.get(id)
        if (index === undefined) return null
        consumed.add(id)
        return { command: commands[index], index }
      })
      .filter((item): item is { command: SlashCommandSpec; index: number } => item !== null)
      .sort((a, b) => a.index - b.index)

    if (items.length > 0) {
      groups.push({ key: group.key, label: group.label, items, range: [items[0].index, items[items.length - 1].index + 1] as const })
    }
  }

  const remainingItems = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => !consumed.has(command.id))

  if (remainingItems.length > 0) {
    groups.push({ key: 'other', label: 'Other', items: remainingItems, range: [remainingItems[0].index, remainingItems[remainingItems.length - 1].index + 1] as const })
  }

  return groups
}

function findGroupByIndex(groups: RenderedSlashCommandGroup[], index: number): RenderedSlashCommandGroup | null {
  return groups.find((group) => index >= group.range[0] && index < group.range[1]) ?? null
}

export const WysiwygPane = memo(function WysiwygPane({
  initialText,
  sharedProseMirror,
  awareness,
  serialize,
  sharedText,
  bridge,
  onTransaction,
  onViewReady,
}: WysiwygPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const slashMenuElementRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const slashMenuRef = useRef<SlashMenuState | null>(null)
  const slashIndexRef = useRef(0)
  const manualSlashModeRef = useRef(false)
  const onTransactionRef = useRef(onTransaction)
  const onViewReadyRef = useRef(onViewReady)

  useEffect(() => { onTransactionRef.current = onTransaction }, [onTransaction])
  useEffect(() => { onViewReadyRef.current = onViewReady }, [onViewReady])
  useEffect(() => { slashMenuRef.current = slashMenu }, [slashMenu])
  useEffect(() => { slashIndexRef.current = slashIndex }, [slashIndex])

  const slashCommands = useMemo(() => getSlashCommands(slashMenu?.query ?? ''), [slashMenu?.query])
  const groupedSlashCommands = useMemo(() => buildSlashMenuGroups(slashCommands), [slashCommands])
  const activeSlashIndex = slashCommands.length === 0 ? 0 : Math.min(slashIndex, Math.max(0, slashCommands.length - 1))
  const activeSlashGroupKey = useMemo(() => findGroupByIndex(groupedSlashCommands, activeSlashIndex)?.key ?? null, [groupedSlashCommands, activeSlashIndex])

  const applySlashCommand = useCallback(
    (command: SlashCommandSpec) => {
      const view = viewRef.current
      if (!view || !slashMenu) return
      deleteTextRange(view, slashMenu.from, slashMenu.to)
      executeSlashCommand(view, command.id)
      manualSlashModeRef.current = false
      setSlashMenu(null)
    },
    [slashMenu],
  )

  useEffect(() => {
    const hostElement = hostRef.current
    if (!hostElement) return

    const collab = sharedProseMirror && awareness ? { sharedProseMirror, awareness, serialize, sharedText, bridge } : undefined

    const editorView = new ProseMirrorEditorView(hostElement, {
      state: createProseMirrorState(initialText, collab),
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
          if (slashMode === 'slash') manualSlashModeRef.current = false
          if (!slashMenuRef.current || slashMenuRef.current.query !== slashMatch.query || slashMenuRef.current.mode !== slashMode) {
            setSlashIndex(0)
          }
          const coords = editorView.coordsAtPos(slashMatch.to)
          setSlashMenu({ ...slashMatch, top: coords.bottom + 6, left: coords.left, mode: slashMode })
        } else {
          setSlashMenu(null)
        }

        onTransactionRef.current?.(editorView, transaction)
      },
      handleKeyDown(view, event) {
        const currentSlashMenu = slashMenuRef.current
        if (!currentSlashMenu) return false

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
            setSlashIndex((i) => nextMenuIndex(i, commands.length))
            return true
          case 'ArrowUp':
            event.preventDefault()
            setSlashIndex((i) => previousMenuIndex(i, commands.length))
            return true
          case 'ArrowLeft': {
            event.preventDefault()
            const groups = buildSlashMenuGroups(commands)
            const idx = Math.min(slashIndexRef.current, Math.max(0, commands.length - 1))
            const active = findGroupByIndex(groups, idx)
            if (!active) return true
            const gi = groups.findIndex((g) => g.key === active.key)
            const prev = groups[gi - 1]
            if (prev) setSlashIndex(prev.range[1] - 1)
            return true
          }
          case 'ArrowRight': {
            event.preventDefault()
            const groups = buildSlashMenuGroups(commands)
            const idx = Math.min(slashIndexRef.current, Math.max(0, commands.length - 1))
            const active = findGroupByIndex(groups, idx)
            if (!active) return true
            const gi = groups.findIndex((g) => g.key === active.key)
            const next = groups[gi + 1]
            if (next) setSlashIndex(next.range[0])
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
      handleClick(_view, _pos, event) {
        const anchor = (event.target as HTMLElement).closest?.('a')
        if (!anchor) return false
        event.preventDefault()
        window.location.assign(anchor.href)
        return true
      },
      attributes: {
        class: 'wysiwyg-editor__content',
        'data-placeholder': "Type '/' to open commands",
      },
    })

    viewRef.current = editorView
    onViewReadyRef.current?.(editorView)

    return () => {
      editorView.destroy()
      viewRef.current = null
      manualSlashModeRef.current = false
      setSlashMenu(null)
      onViewReadyRef.current?.(null)
    }
  }, [initialText, sharedProseMirror, awareness, serialize, sharedText, bridge])

  useEffect(() => {
    if (!slashMenu) return
    const documentRef = hostRef.current?.ownerDocument
    if (!documentRef) return

    const onPointerDownOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (slashMenuElementRef.current?.contains(target)) return
      if (hostRef.current?.contains(target)) return
      manualSlashModeRef.current = false
      setSlashMenu(null)
    }

    documentRef.addEventListener('pointerdown', onPointerDownOutside, true)
    return () => documentRef.removeEventListener('pointerdown', onPointerDownOutside, true)
  }, [slashMenu])

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
          style={{ top: `${slashMenu.top}px`, left: `${slashMenu.left}px` }}
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
                      onMouseDown={(e) => { e.preventDefault(); setSlashIndex(group.range[0]) }}
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
                    {group.items.map(({ command, index }) => (
                      <button
                        key={command.id}
                        type="button"
                        role="option"
                        aria-selected={index === activeSlashIndex}
                        className={`slash-menu__item${index === activeSlashIndex ? ' is-active' : ''}`}
                        onMouseEnter={() => setSlashIndex(index)}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseUp={(e) => { e.preventDefault(); applySlashCommand(command) }}
                      >
                        <span className="slash-menu__item-icon" aria-hidden>
                          {slashCommandIconById[command.id]}
                        </span>
                        <span className="slash-menu__item-text">
                          <strong>{command.title}</strong>
                          <span>{command.description}</span>
                        </span>
                      </button>
                    ))}
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
