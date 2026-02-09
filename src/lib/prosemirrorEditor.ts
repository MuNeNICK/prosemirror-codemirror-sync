import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  setBlockType,
  splitBlockKeepMarks,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { history, redo as historyRedo, undo as historyUndo } from 'prosemirror-history'
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { Command, EditorState, PluginView } from 'prosemirror-state'
import {
  EditorState as ProseMirrorEditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from 'prosemirror-state'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { columnResizing, tableEditing } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import type { Awareness } from 'y-protocols/awareness'
import {
  initProseMirrorDoc,
  redo as yRedo,
  undo as yUndo,
  yCursorPlugin,
  ySyncPlugin,
  yUndoPlugin,
} from 'y-prosemirror'
import type { XmlFragment as YXmlFragment } from 'yjs'
import { markdownToProseMirrorDoc, normalizeMarkdown, proseMirrorDocToMarkdown } from './prosemirrorMarkdown'
import { prosemirrorSchema } from './prosemirrorSchema'

export const EXTERNAL_SYNC_META = 'external-sync'
export const OPEN_SLASH_MENU_META = 'open-slash-menu'

const BLOCK_HANDLE_DRAG_TYPE = 'application/x-prosemirror-block-handle'
const blockHandlePluginKey = new PluginKey('block-handle-plugin')

type ProseMirrorCollabOptions = {
  xmlFragment: YXmlFragment
  awareness: Awareness
}

type ProseMirrorCollabRuntime = ProseMirrorCollabOptions & {
  mapping: ReturnType<typeof initProseMirrorDoc>['mapping']
}

type IconDefinition = {
  viewBox: string
  nodes: ReadonlyArray<readonly [string, Record<string, string | number>]>
}

const DRAG_HANDLE_ICON: IconDefinition = {
  viewBox: '0 0 24 24',
  nodes: [
    [
      'path',
      {
        d: 'M11 18C11 19.1 10.1 20 9 20C7.9 20 7 19.1 7 18C7 16.9 7.9 16 9 16C10.1 16 11 16.9 11 18ZM9 10C7.9 10 7 10.9 7 12C7 13.1 7.9 14 9 14C10.1 14 11 13.1 11 12C11 10.9 10.1 10 9 10ZM9 4C7.9 4 7 4.9 7 6C7 7.1 7.9 8 9 8C10.1 8 11 7.1 11 6C11 4.9 10.1 4 9 4ZM15 8C16.1 8 17 7.1 17 6C17 4.9 16.1 4 15 4C13.9 4 13 4.9 13 6C13 7.1 13.9 8 15 8ZM15 10C13.9 10 13 10.9 13 12C13 13.1 13.9 14 15 14C16.1 14 17 13.1 17 12C17 10.9 16.1 10 15 10ZM15 16C13.9 16 13 16.9 13 18C13 19.1 13.9 20 15 20C16.1 20 17 19.1 17 18C17 16.9 16.1 16 15 16Z',
        fill: 'currentColor',
        stroke: 'none',
      },
    ],
  ],
}

const PLUS_ICON: IconDefinition = {
  viewBox: '0 0 24 24',
  nodes: [
    [
      'path',
      {
        d: 'M18 13H13V18C13 18.55 12.55 19 12 19C11.45 19 11 18.55 11 18V13H6C5.45 13 5 12.55 5 12C5 11.45 5.45 11 6 11H11V6C11 5.45 11.45 5 12 5C12.55 5 13 5.45 13 6V11H18C18.55 11 19 11.45 19 12C19 12.55 18.55 13 18 13Z',
        fill: 'currentColor',
        stroke: 'none',
      },
    ],
  ],
}

function createSvgIcon(iconDefinition: IconDefinition) {
  const svgNamespace = 'http://www.w3.org/2000/svg'
  const svgElement = document.createElementNS(svgNamespace, 'svg')
  svgElement.setAttribute('viewBox', iconDefinition.viewBox)
  svgElement.setAttribute('fill', 'none')
  svgElement.setAttribute('stroke', 'currentColor')
  svgElement.setAttribute('stroke-width', '2')
  svgElement.setAttribute('stroke-linecap', 'round')
  svgElement.setAttribute('stroke-linejoin', 'round')
  svgElement.setAttribute('aria-hidden', 'true')
  svgElement.classList.add('pm-block-handle-icon')

  for (const [tagName, attrs] of iconDefinition.nodes) {
    const element = document.createElementNS(svgNamespace, tagName)
    for (const [attrKey, attrValue] of Object.entries(attrs)) {
      if (attrValue === undefined) {
        continue
      }

      element.setAttribute(attrKey, String(attrValue))
    }
    svgElement.append(element)
  }

  return svgElement
}

type TopLevelBlock = {
  before: number
  after: number
  node: ProseMirrorNode
}

export type SlashCommandId =
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullet_list'
  | 'todo_list'
  | 'quote'
  | 'code_block'
  | 'divider'
  | 'table'

export type SlashCommandSpec = {
  id: SlashCommandId
  title: string
  description: string
  keywords: string[]
}

export type SlashCommandMatch = {
  query: string
  from: number
  to: number
}

const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    id: 'text',
    title: 'Text',
    description: 'Convert block to plain text',
    keywords: ['paragraph', 'plain', 'text'],
  },
  {
    id: 'heading1',
    title: 'Heading 1',
    description: 'Large section heading',
    keywords: ['h1', 'title', 'heading'],
  },
  {
    id: 'heading2',
    title: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['h2', 'subtitle', 'heading'],
  },
  {
    id: 'heading3',
    title: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3', 'heading'],
  },
  {
    id: 'bullet_list',
    title: 'Bulleted List',
    description: 'Create a bullet list',
    keywords: ['list', 'bullet', 'ul'],
  },
  {
    id: 'todo_list',
    title: 'To-do List',
    description: 'Create a checkbox task list',
    keywords: ['task', 'todo', 'checkbox'],
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Create a quote block',
    keywords: ['blockquote', 'quote'],
  },
  {
    id: 'code_block',
    title: 'Code Block',
    description: 'Create a code block',
    keywords: ['code', 'snippet'],
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Insert a horizontal divider',
    keywords: ['hr', 'divider', 'separator'],
  },
  {
    id: 'table',
    title: 'Table',
    description: 'Insert a 3x3 table',
    keywords: ['table', 'grid'],
  },
]

function getTopLevelBlocks(state: EditorState): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = []

  state.doc.forEach((node, offset) => {
    blocks.push({
      before: offset,
      after: offset + node.nodeSize,
      node,
    })
  })

  return blocks
}

function getBlockAtBefore(state: EditorState, before: number): TopLevelBlock | null {
  const block = getTopLevelBlocks(state).find((item) => item.before === before)
  return block ?? null
}

function getDropTargetFromEvent(
  view: EditorView,
  event: DragEvent,
): { before: number; place: 'before' | 'after' } | null {
  const pointElement =
    event.target instanceof Element
      ? event.target
      : document.elementFromPoint(event.clientX, event.clientY)

  const matchedElement = pointElement?.closest<HTMLElement>('[data-pm-top-level-before]')

  if (matchedElement && view.dom.contains(matchedElement)) {
    const before = Number(matchedElement.dataset.pmTopLevelBefore)
    if (!Number.isNaN(before)) {
      const rect = matchedElement.getBoundingClientRect()
      const place = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
      return { before, place }
    }
  }

  const allBlocks = Array.from(
    view.dom.querySelectorAll<HTMLElement>('[data-pm-top-level-before]'),
  ).filter((blockElement) => !Number.isNaN(Number(blockElement.dataset.pmTopLevelBefore)))

  if (allBlocks.length === 0) {
    return null
  }

  const firstBlock = allBlocks[0]
  const firstRect = firstBlock.getBoundingClientRect()
  if (event.clientY <= firstRect.top) {
    const before = Number(firstBlock.dataset.pmTopLevelBefore)
    return Number.isNaN(before) ? null : { before, place: 'before' }
  }

  const lastBlock = allBlocks[allBlocks.length - 1]
  const lastBefore = Number(lastBlock.dataset.pmTopLevelBefore)
  const lastRect = lastBlock.getBoundingClientRect()
  if (event.clientY >= lastRect.bottom) {
    return Number.isNaN(lastBefore) ? null : { before: lastBefore, place: 'after' }
  }

  let nearest: { before: number; place: 'before' | 'after'; distance: number } | null = null

  for (const blockElement of allBlocks) {
    const before = Number(blockElement.dataset.pmTopLevelBefore)
    if (Number.isNaN(before)) {
      continue
    }

    const rect = blockElement.getBoundingClientRect()
    const centerY = rect.top + rect.height / 2
    const distance = Math.abs(event.clientY - centerY)
    const place: 'before' | 'after' = event.clientY > centerY ? 'after' : 'before'

    if (!nearest || distance < nearest.distance) {
      nearest = { before, place, distance }
    }
  }

  if (!nearest) {
    return null
  }

  return {
    before: nearest.before,
    place: nearest.place,
  }
}

function chainAvailableCommands(commands: Array<Command | null>): Command {
  const availableCommands = commands.filter((command): command is Command => command !== null)
  return chainCommands(...availableCommands)
}

function makeListItemCommand(
  builder: (listItemType: typeof prosemirrorSchema.nodes.list_item) => Command,
): Command | null {
  const listItemType = prosemirrorSchema.nodes.list_item
  return listItemType ? builder(listItemType) : null
}

function makeTaskItemCommand(
  builder: (taskItemType: typeof prosemirrorSchema.nodes.task_item) => Command,
): Command | null {
  const taskItemType = prosemirrorSchema.nodes.task_item
  return taskItemType ? builder(taskItemType) : null
}

function createInputRulesPlugin() {
  const rules = []

  const headingType = prosemirrorSchema.nodes.heading
  if (headingType) {
    rules.push(textblockTypeInputRule(/^#\s$/, headingType, { level: 1 }))
    rules.push(textblockTypeInputRule(/^##\s$/, headingType, { level: 2 }))
    rules.push(textblockTypeInputRule(/^###\s$/, headingType, { level: 3 }))
  }

  const blockquoteType = prosemirrorSchema.nodes.blockquote
  if (blockquoteType) {
    rules.push(wrappingInputRule(/^>\s$/, blockquoteType))
  }

  const bulletListType = prosemirrorSchema.nodes.bullet_list
  if (bulletListType) {
    rules.push(wrappingInputRule(/^[-*+]\s$/, bulletListType))
  }

  const orderedListType = prosemirrorSchema.nodes.ordered_list
  if (orderedListType) {
    rules.push(
      wrappingInputRule(/^(\d+)\.\s$/, orderedListType, (match) => ({
        order: Number(match[1]),
      })),
    )
  }

  const codeBlockType = prosemirrorSchema.nodes.code_block
  if (codeBlockType) {
    rules.push(textblockTypeInputRule(/^```$/, codeBlockType))
  }

  return inputRules({ rules })
}

function createKeymapPlugin(collabEnabled: boolean) {
  const bindings: Record<string, Command> = {
    'Mod-z': collabEnabled ? yUndo : historyUndo,
    'Shift-Mod-z': collabEnabled ? yRedo : historyRedo,
    'Mod-y': collabEnabled ? yRedo : historyRedo,
  }

  if (prosemirrorSchema.marks.strong) {
    bindings['Mod-b'] = toggleMark(prosemirrorSchema.marks.strong)
  }

  if (prosemirrorSchema.marks.em) {
    bindings['Mod-i'] = toggleMark(prosemirrorSchema.marks.em)
  }

  if (prosemirrorSchema.nodes.heading) {
    bindings['Mod-Alt-2'] = setBlockType(prosemirrorSchema.nodes.heading, { level: 2 })
  }

  bindings.Enter = chainAvailableCommands([
    makeTaskItemCommand((taskItemType) => splitListItem(taskItemType)),
    makeListItemCommand((listItemType) => splitListItem(listItemType)),
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlockKeepMarks,
  ])

  bindings.Tab = chainAvailableCommands([
    makeTaskItemCommand((taskItemType) => sinkListItem(taskItemType)),
    makeListItemCommand((listItemType) => sinkListItem(listItemType)),
  ])

  bindings['Shift-Tab'] = chainAvailableCommands([
    makeTaskItemCommand((taskItemType) => liftListItem(taskItemType)),
    makeListItemCommand((listItemType) => liftListItem(listItemType)),
  ])

  return keymap(bindings)
}

function toggleTaskItemCheckedAtPos(view: EditorView, pos: number): boolean {
  const taskItemType = prosemirrorSchema.nodes.task_item
  if (!taskItemType) {
    return false
  }

  const docSize = view.state.doc.content.size
  const resolvedPosition = view.state.doc.resolve(Math.min(Math.max(pos, 0), docSize))

  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth)
    if (node.type !== taskItemType) {
      continue
    }

    const before = resolvedPosition.before(depth)
    const transaction = view.state.tr.setNodeMarkup(before, taskItemType, {
      ...node.attrs,
      checked: node.attrs.checked !== true,
    })
    view.dispatch(transaction.scrollIntoView())
    return true
  }

  return false
}

function createTaskCheckboxPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (!(event instanceof MouseEvent)) {
            return false
          }

          const target = event.target
          if (!(target instanceof Element)) {
            return false
          }

          const taskItemElement = target.closest<HTMLElement>('li[data-type="task-item"]')
          if (!taskItemElement || !view.dom.contains(taskItemElement)) {
            return false
          }

          const checkboxElement = target.closest<HTMLElement>('[data-task-checkbox]')
          if (!checkboxElement) {
            return false
          }

          const position = view.posAtDOM(taskItemElement, 0)
          const toggled = toggleTaskItemCheckedAtPos(view, position)
          if (!toggled) {
            return false
          }

          event.preventDefault()
          return true
        },
      },
    },
  })
}

function createBlockHandlePlugin(): Plugin {
  let draggingFromBefore: number | null = null

  return new Plugin({
    key: blockHandlePluginKey,
    props: {
      decorations(state) {
        const decorations: Decoration[] = []

        state.doc.forEach((node, offset) => {
          if (!node.isBlock) {
            return
          }

          const before = offset
          const after = offset + node.nodeSize

          decorations.push(
            Decoration.node(before, after, {
              class: 'pm-top-level-block',
              'data-pm-top-level-before': String(before),
            }),
          )
        })

        return DecorationSet.create(state.doc, decorations)
      },
      handleDOMEvents: {
        dragover(_view, event) {
          if (!(event instanceof DragEvent) || draggingFromBefore === null) {
            return false
          }

          event.preventDefault()
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move'
          }

          return true
        },
        dragenter(_view, event) {
          if (!(event instanceof DragEvent) || draggingFromBefore === null) {
            return false
          }

          event.preventDefault()
          return true
        },
        drop(view, event) {
          if (!(event instanceof DragEvent) || draggingFromBefore === null) {
            return false
          }

          event.preventDefault()

          const target = getDropTargetFromEvent(view, event)
          if (!target) {
            draggingFromBefore = null
            return false
          }

          const moved = moveTopLevelBlock(
            view,
            draggingFromBefore,
            target.before,
            target.place,
          )

          draggingFromBefore = null
          return moved
        },
      },
    },
    view(view) {
      let currentView = view
      const documentRef = currentView.dom.ownerDocument
      const windowRef = documentRef.defaultView
      const menuElement = documentRef.createElement('div')
      const addButton = documentRef.createElement('button')
      const dragButton = documentRef.createElement('button')
      let hoveredBefore: number | null = null

      const hideHandle = () => {
        hoveredBefore = null
        menuElement.removeAttribute('data-before')
        menuElement.classList.remove('is-visible')
      }

      const positionHandleForBefore = (before: number): boolean => {
        const block = currentView.dom.querySelector<HTMLElement>(
          `[data-pm-top-level-before="${before}"]`,
        )

        if (!block) {
          hideHandle()
          return false
        }

        const rect = block.getBoundingClientRect()
        const menuWidth = menuElement.getBoundingClientRect().width || 66
        const menuHeight = menuElement.getBoundingClientRect().height || 32
        const blockStyle = windowRef?.getComputedStyle(block)
        const paddingTop = blockStyle ? Number.parseFloat(blockStyle.paddingTop) || 0 : 0
        const left = Math.max(4, rect.left - menuWidth - 8)
        const topOffset = rect.height > menuHeight ? Math.min(paddingTop, rect.height - menuHeight) : 0
        const top = rect.top + topOffset

        menuElement.style.left = `${Math.round(left)}px`
        menuElement.style.top = `${Math.round(top)}px`
        menuElement.dataset.before = String(before)
        menuElement.classList.add('is-visible')
        hoveredBefore = before
        return true
      }

      const findBlockByPointerY = (clientY: number): HTMLElement | null => {
        const blocks = Array.from(
          currentView.dom.querySelectorAll<HTMLElement>('[data-pm-top-level-before]'),
        )

        let nearestBlock: HTMLElement | null = null
        let nearestDistance = Number.POSITIVE_INFINITY

        for (const blockElement of blocks) {
          const rect = blockElement.getBoundingClientRect()
          if (clientY >= rect.top && clientY <= rect.bottom) {
            return blockElement
          }

          const distance = Math.min(Math.abs(clientY - rect.top), Math.abs(clientY - rect.bottom))
          if (distance < nearestDistance) {
            nearestDistance = distance
            nearestBlock = blockElement
          }
        }

        return nearestDistance <= 10 ? nearestBlock : null
      }

      const isInTransitZone = (clientX: number, clientY: number): boolean => {
        if (hoveredBefore === null) {
          return false
        }

        const activeBlock = currentView.dom.querySelector<HTMLElement>(
          `[data-pm-top-level-before="${hoveredBefore}"]`,
        )

        if (!activeBlock) {
          return false
        }

        const blockRect = activeBlock.getBoundingClientRect()
        const menuRect = menuElement.getBoundingClientRect()

        const left = Math.min(menuRect.left, blockRect.left) - 8
        const right = Math.max(menuRect.right, blockRect.left + 14) + 8
        const top = Math.min(menuRect.top, blockRect.top) - 8
        const bottom = Math.max(menuRect.bottom, blockRect.bottom) + 8

        return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom
      }

      const updateFromPointer = (target: EventTarget | null, clientX: number, clientY: number) => {
        if (draggingFromBefore !== null) {
          return
        }

        const targetElement =
          target instanceof Element
            ? target
            : target instanceof Node
              ? target.parentElement
              : null

        if (!targetElement) {
          hideHandle()
          return
        }

        if (targetElement === menuElement || menuElement.contains(targetElement)) {
          return
        }

        if (!currentView.dom.contains(targetElement)) {
          if (isInTransitZone(clientX, clientY)) {
            return
          }
          hideHandle()
          return
        }

        const block =
          targetElement.closest<HTMLElement>('[data-pm-top-level-before]') ??
          findBlockByPointerY(clientY)
        if (!block) {
          if (isInTransitZone(clientX, clientY)) {
            return
          }
          hideHandle()
          return
        }

        const before = Number(block.dataset.pmTopLevelBefore)
        if (Number.isNaN(before)) {
          hideHandle()
          return
        }

        positionHandleForBefore(before)
      }

      const repositionAfterLayout = () => {
        if (hoveredBefore === null || draggingFromBefore !== null) {
          return
        }

        positionHandleForBefore(hoveredBefore)
      }

      const onPointerMove = (event: PointerEvent) => {
        updateFromPointer(event.target, event.clientX, event.clientY)
      }

      const onScrollOrResize = () => {
        repositionAfterLayout()
      }

      menuElement.className = 'pm-floating-block-menu'
      menuElement.setAttribute('contenteditable', 'false')

      addButton.type = 'button'
      addButton.className = 'pm-floating-block-button pm-floating-block-button--add'
      addButton.setAttribute('aria-label', 'Insert new block below')
      addButton.append(createSvgIcon(PLUS_ICON))

      dragButton.type = 'button'
      dragButton.className = 'pm-floating-block-button pm-floating-block-button--drag'
      dragButton.draggable = true
      dragButton.setAttribute('aria-label', 'Drag block to reorder')
      dragButton.append(createSvgIcon(DRAG_HANDLE_ICON))

      const setPressedState = (buttonElement: HTMLElement, pressed: boolean) => {
        buttonElement.classList.toggle('is-active', pressed)
      }

      dragButton.addEventListener('pointerdown', () => {
        setPressedState(dragButton, true)
      })

      dragButton.addEventListener('pointerup', () => {
        setPressedState(dragButton, false)
      })

      dragButton.addEventListener('pointercancel', () => {
        setPressedState(dragButton, false)
      })

      addButton.addEventListener('mousedown', (mouseEvent) => {
        mouseEvent.preventDefault()
      })

      addButton.addEventListener('pointerdown', () => {
        setPressedState(addButton, true)
      })

      addButton.addEventListener('pointerup', () => {
        setPressedState(addButton, false)
      })

      addButton.addEventListener('pointercancel', () => {
        setPressedState(addButton, false)
      })

      addButton.addEventListener('click', () => {
        const before = hoveredBefore ?? Number(menuElement.dataset.before)
        if (Number.isNaN(before)) {
          return
        }

        const block = getBlockAtBefore(currentView.state, before)
        const paragraphType = prosemirrorSchema.nodes.paragraph
        if (!block || !paragraphType) {
          return
        }

        const insertPos = block.after
        const transaction = currentView.state.tr.insert(insertPos, paragraphType.create())
        transaction.setSelection(TextSelection.create(transaction.doc, insertPos + 1))
        transaction.setMeta(OPEN_SLASH_MENU_META, true)
        currentView.dispatch(transaction.scrollIntoView())
        currentView.focus()
        hoveredBefore = insertPos
      })

      dragButton.addEventListener('dragstart', (dragEvent) => {
        const before = hoveredBefore ?? Number(menuElement.dataset.before)
        if (Number.isNaN(before) || !getBlockAtBefore(currentView.state, before)) {
          dragEvent.preventDefault()
          return
        }

        currentView.dispatch(
          currentView.state.tr.setSelection(NodeSelection.create(currentView.state.doc, before)),
        )
        currentView.focus()

        draggingFromBefore = before
        setPressedState(dragButton, true)
        dragEvent.dataTransfer?.setData(BLOCK_HANDLE_DRAG_TYPE, String(before))
        dragEvent.dataTransfer?.setData('text/plain', 'block-handle')
        if (dragEvent.dataTransfer) {
          dragEvent.dataTransfer.effectAllowed = 'move'
        }
        menuElement.classList.add('is-dragging')
        dragButton.classList.add('is-dragging')
      })

      dragButton.addEventListener('dragend', () => {
        draggingFromBefore = null
        menuElement.classList.remove('is-dragging')
        dragButton.classList.remove('is-dragging')
        setPressedState(dragButton, false)
        hideHandle()
      })

      menuElement.append(addButton, dragButton)

      documentRef.body.append(menuElement)
      documentRef.addEventListener('pointermove', onPointerMove, true)
      documentRef.addEventListener('scroll', onScrollOrResize, true)
      windowRef?.addEventListener('resize', onScrollOrResize)

      const pluginView: PluginView = {
        update(updatedView) {
          currentView = updatedView
          repositionAfterLayout()
        },
        destroy() {
          draggingFromBefore = null
          documentRef.removeEventListener('pointermove', onPointerMove, true)
          documentRef.removeEventListener('scroll', onScrollOrResize, true)
          windowRef?.removeEventListener('resize', onScrollOrResize)
          menuElement.remove()
        },
      }

      return pluginView
    },
  })
}

function createPlugins(collab?: ProseMirrorCollabRuntime) {
  const plugins: Plugin[] = [
    createInputRulesPlugin(),
    createTaskCheckboxPlugin(),
    createBlockHandlePlugin(),
    columnResizing({
      handleWidth: 5,
      lastColumnResizable: true,
    }),
    tableEditing(),
    dropCursor(),
    gapCursor(),
    createKeymapPlugin(Boolean(collab)),
    keymap(baseKeymap),
  ]

  if (collab) {
    // Thin awareness proxy: disables yCursorPlugin's own cursor lifecycle
    // (auto-set on focus / auto-clear on blur) so that pmCursor is managed
    // externally by WysiwygPane.
    const pmAwareness = new Proxy(collab.awareness, {
      get(target, prop, receiver) {
        if (prop === 'getLocalState') {
          return () => {
            const state = target.getLocalState()
            return state ? { ...state, pmCursor: null } : state
          }
        }
        if (prop === 'setLocalStateField') {
          return () => {} // no-op
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Awareness

    return [
      ySyncPlugin(collab.xmlFragment, { mapping: collab.mapping }),
      yCursorPlugin(pmAwareness, {}, 'pmCursor'),
      yUndoPlugin(),
      ...plugins,
    ]
  }

  return [history(), ...plugins]
}

export function createProseMirrorState(
  markdown: string,
  collab?: ProseMirrorCollabOptions,
): EditorState {
  if (collab) {
    const { doc, mapping } = initProseMirrorDoc(collab.xmlFragment, prosemirrorSchema)
    return ProseMirrorEditorState.create({
      schema: prosemirrorSchema,
      doc,
      plugins: createPlugins({
        ...collab,
        mapping,
      }),
    })
  }

  return ProseMirrorEditorState.create({
    schema: prosemirrorSchema,
    doc: markdownToProseMirrorDoc(markdown, prosemirrorSchema),
    plugins: createPlugins(),
  })
}

export function extractMarkdownFromProseMirror(view: EditorView): string {
  return proseMirrorDocToMarkdown(view.state.doc)
}

export function applyMarkdownToProseMirror(view: EditorView, markdown: string): boolean {
  const incoming = normalizeMarkdown(markdown)
  const current = normalizeMarkdown(extractMarkdownFromProseMirror(view))

  if (incoming === current) {
    return false
  }

  const nextDoc = markdownToProseMirrorDoc(incoming, prosemirrorSchema)
  const transaction = view.state.tr
  transaction.replaceWith(0, transaction.doc.content.size, nextDoc.content)
  transaction.setMeta(EXTERNAL_SYNC_META, true)
  view.dispatch(transaction)
  return true
}

export function runCommand(view: EditorView, command: Command): boolean {
  return command(view.state, view.dispatch, view)
}

export function createTableNode(rows: number, cols: number) {
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

export function insertTable(view: EditorView, rows = 3, cols = 3): boolean {
  const tableNode = createTableNode(rows, cols)
  if (!tableNode) {
    return false
  }

  const transaction = view.state.tr.replaceSelectionWith(tableNode)
  view.dispatch(transaction.scrollIntoView())
  return true
}

export function wrapSelectionInBulletList(view: EditorView): boolean {
  const bulletListType = prosemirrorSchema.nodes.bullet_list
  if (!bulletListType) {
    return false
  }

  return runCommand(view, wrapInList(bulletListType))
}

export function wrapSelectionInTaskList(view: EditorView): boolean {
  const taskListType = prosemirrorSchema.nodes.task_list
  if (!taskListType) {
    return false
  }

  return runCommand(view, wrapInList(taskListType))
}

export function toggleTaskItemChecked(view: EditorView): boolean {
  const taskItemType = prosemirrorSchema.nodes.task_item
  if (!taskItemType) {
    return false
  }

  const { $from } = view.state.selection

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type !== taskItemType) {
      continue
    }

    const position = $from.before(depth)
    const checked = node.attrs.checked === true
    const transaction = view.state.tr.setNodeMarkup(position, taskItemType, {
      ...node.attrs,
      checked: !checked,
    })

    view.dispatch(transaction.scrollIntoView())
    return true
  }

  return false
}

export function moveTopLevelBlock(
  view: EditorView,
  sourceBefore: number,
  targetBefore: number | null,
  place: 'before' | 'after' = 'before',
): boolean {
  const sourceBlock = getBlockAtBefore(view.state, sourceBefore)
  if (!sourceBlock) {
    return false
  }

  const targetBlock = targetBefore === null ? null : getBlockAtBefore(view.state, targetBefore)

  let insertionPosition = view.state.doc.content.size

  if (targetBlock) {
    insertionPosition = place === 'before' ? targetBlock.before : targetBlock.after
  }

  if (sourceBefore < insertionPosition) {
    insertionPosition -= sourceBlock.node.nodeSize
  }

  if (insertionPosition === sourceBlock.before) {
    return false
  }

  const transaction = view.state.tr
    .delete(sourceBlock.before, sourceBlock.after)
    .insert(insertionPosition, sourceBlock.node)

  transaction.setSelection(NodeSelection.create(transaction.doc, insertionPosition))
  view.dispatch(transaction.scrollIntoView())

  return true
}

export function setParagraphBlock(view: EditorView): boolean {
  const paragraphType = prosemirrorSchema.nodes.paragraph
  return paragraphType ? runCommand(view, setBlockType(paragraphType)) : false
}

export function setHeadingBlock(view: EditorView, level: 1 | 2 | 3): boolean {
  const headingType = prosemirrorSchema.nodes.heading
  return headingType ? runCommand(view, setBlockType(headingType, { level })) : false
}

export function setCodeBlock(view: EditorView): boolean {
  const codeBlockType = prosemirrorSchema.nodes.code_block
  return codeBlockType ? runCommand(view, setBlockType(codeBlockType)) : false
}

export function setBlockQuote(view: EditorView): boolean {
  const blockquoteType = prosemirrorSchema.nodes.blockquote
  return blockquoteType ? runCommand(view, wrapIn(blockquoteType)) : false
}

export function insertDivider(view: EditorView): boolean {
  const hrType = prosemirrorSchema.nodes.horizontal_rule
  if (!hrType) {
    return false
  }

  const transaction = view.state.tr.replaceSelectionWith(hrType.create())
  view.dispatch(transaction.scrollIntoView())
  return true
}

function isInListContext(state: EditorState): boolean {
  const { $from } = state.selection

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const nodeType = $from.node(depth).type.name
    if (
      nodeType === 'list_item' ||
      nodeType === 'task_item' ||
      nodeType === 'bullet_list' ||
      nodeType === 'ordered_list' ||
      nodeType === 'task_list'
    ) {
      return true
    }
  }

  return false
}

export function getSlashCommandMatch(state: EditorState): SlashCommandMatch | null {
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

  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const match = /(^|[\s])\/([a-zA-Z0-9_-]*)$/.exec(textBeforeCursor)

  if (!match) {
    return null
  }

  const prefix = match[1] ?? ''
  const fromInText = textBeforeCursor.length - match[0].length + prefix.length

  return {
    query: (match[2] ?? '').toLowerCase(),
    from: $from.start() + fromInText,
    to: $from.pos,
  }
}

export function getSlashCommands(query: string): SlashCommandSpec[] {
  const normalized = query.trim().toLowerCase()

  if (normalized.length === 0) {
    return SLASH_COMMANDS
  }

  return SLASH_COMMANDS.filter((command) => {
    return (
      command.title.toLowerCase().includes(normalized) ||
      command.description.toLowerCase().includes(normalized) ||
      command.keywords.some((keyword) => keyword.includes(normalized))
    )
  })
}

export function deleteTextRange(view: EditorView, from: number, to: number): void {
  if (from >= to) {
    return
  }

  view.dispatch(view.state.tr.delete(from, to))
}

export function executeSlashCommand(view: EditorView, id: SlashCommandId): boolean {
  switch (id) {
    case 'text':
      return setParagraphBlock(view)
    case 'heading1':
      return setHeadingBlock(view, 1)
    case 'heading2':
      return setHeadingBlock(view, 2)
    case 'heading3':
      return setHeadingBlock(view, 3)
    case 'bullet_list':
      return wrapSelectionInBulletList(view)
    case 'todo_list':
      return wrapSelectionInTaskList(view)
    case 'quote':
      return setBlockQuote(view)
    case 'code_block':
      return setCodeBlock(view)
    case 'divider':
      return insertDivider(view)
    case 'table':
      return insertTable(view)
    default:
      return false
  }
}
