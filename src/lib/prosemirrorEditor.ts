import { baseKeymap, chainCommands, createParagraphNear, liftEmptyBlock, newlineInCode, setBlockType, splitBlockKeepMarks, toggleMark } from 'prosemirror-commands'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Command } from 'prosemirror-state'
import { EditorState } from 'prosemirror-state'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { columnResizing, tableEditing } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'
import { markdownToProseMirrorDoc, normalizeMarkdown, proseMirrorDocToMarkdown } from './prosemirrorMarkdown'
import { prosemirrorSchema } from './prosemirrorSchema'

export const EXTERNAL_SYNC_META = 'external-sync'

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

function createKeymapPlugin() {
  const bindings: Record<string, Command> = {
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
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

function createPlugins() {
  return [
    columnResizing({
      handleWidth: 5,
      lastColumnResizable: true,
    }),
    tableEditing(),
    history(),
    dropCursor(),
    gapCursor(),
    createKeymapPlugin(),
    keymap(baseKeymap),
  ]
}

export function createProseMirrorState(markdown: string): EditorState {
  return EditorState.create({
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
