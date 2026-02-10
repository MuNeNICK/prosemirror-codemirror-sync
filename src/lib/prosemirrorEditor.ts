import type { EditorState } from 'prosemirror-state'
import { EditorState as ProseMirrorEditorState } from 'prosemirror-state'
import type { Awareness } from 'y-protocols/awareness'
import type { Text as YText, XmlFragment as YXmlFragment } from 'yjs'
import { createCollabPlugins } from '@pm-cm/yjs'
import type { YjsBridgeHandle } from '@pm-cm/yjs'
import type { Serialize } from '@pm-cm/core'
import { createEditorPlugins } from './prosemirrorPlugins'
import { markdownToProseMirrorDoc } from './prosemirrorMarkdown'
import { prosemirrorSchema } from './prosemirrorSchema'

export type ProseMirrorCollabOptions = {
  sharedProseMirror: YXmlFragment
  awareness: Awareness
  serialize?: Serialize
  sharedText?: YText
  bridge?: YjsBridgeHandle
}

export function createProseMirrorState(
  markdown: string,
  collab?: ProseMirrorCollabOptions,
): EditorState {
  if (collab) {
    const { plugins: collabPlugins, doc } = createCollabPlugins(prosemirrorSchema, {
      sharedProseMirror: collab.sharedProseMirror,
      awareness: collab.awareness,
      serialize: collab.serialize,
      cursorSync: !!collab.serialize,
      sharedText: collab.sharedText,
      bridge: collab.bridge,
    })
    return ProseMirrorEditorState.create({
      schema: prosemirrorSchema,
      doc,
      plugins: createEditorPlugins(collabPlugins),
    })
  }

  return ProseMirrorEditorState.create({
    schema: prosemirrorSchema,
    doc: markdownToProseMirrorDoc(markdown, prosemirrorSchema),
    plugins: createEditorPlugins(),
  })
}

// Re-export from prosemirrorPlugins for backward compatibility
export {
  OPEN_SLASH_MENU_META,
  createEditorPlugins,
  runCommand,
  createTableNode,
  insertTable,
  wrapSelectionInBulletList,
  wrapSelectionInTaskList,
  toggleTaskItemChecked,
  moveTopLevelBlock,
  setParagraphBlock,
  setHeadingBlock,
  setCodeBlock,
  setBlockQuote,
  insertDivider,
  getSlashCommandMatch,
  getSlashCommands,
  deleteTextRange,
  executeSlashCommand,
} from './prosemirrorPlugins'

export type {
  SlashCommandId,
  SlashCommandSpec,
  SlashCommandMatch,
} from './prosemirrorPlugins'
