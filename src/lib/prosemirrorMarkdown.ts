import type {
  BlockContent,
  Content,
  Delete,
  Emphasis,
  Heading,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  PhrasingContent,
  Root,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
} from 'mdast'
import type { Mark, Node as ProseMirrorNode, Schema } from 'prosemirror-model'
import { unified } from 'unified'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks)
const markdownStringifier = unified()
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    fences: true,
    listItemIndent: 'one',
    join: [() => 0],
  })

export function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function appendMark(marks: Mark[], nextMark: Mark): Mark[] {
  if (marks.some((mark) => mark.type === nextMark.type)) {
    return marks
  }

  return [...marks, nextMark]
}

function textNode(schema: Schema, value: string, marks: Mark[] = []): ProseMirrorNode {
  return schema.text(value, marks)
}

function inlineChildrenToProseMirror(
  children: PhrasingContent[],
  schema: Schema,
  activeMarks: Mark[] = [],
): ProseMirrorNode[] {
  const inlineNodes: ProseMirrorNode[] = []

  for (const child of children) {
    switch (child.type) {
      case 'text': {
        const text = child as Text
        if (text.value.length > 0) {
          inlineNodes.push(textNode(schema, text.value, activeMarks))
        }
        break
      }
      case 'strong': {
        const strong = child as Strong
        const strongMark = schema.marks.strong
        if (!strongMark) {
          inlineNodes.push(...inlineChildrenToProseMirror(strong.children, schema, activeMarks))
          break
        }

        inlineNodes.push(
          ...inlineChildrenToProseMirror(
            strong.children,
            schema,
            appendMark(activeMarks, strongMark.create()),
          ),
        )
        break
      }
      case 'emphasis': {
        const emphasis = child as Emphasis
        const emMark = schema.marks.em
        if (!emMark) {
          inlineNodes.push(...inlineChildrenToProseMirror(emphasis.children, schema, activeMarks))
          break
        }

        inlineNodes.push(
          ...inlineChildrenToProseMirror(
            emphasis.children,
            schema,
            appendMark(activeMarks, emMark.create()),
          ),
        )
        break
      }
      case 'delete': {
        const deletion = child as Delete
        const strikeMark = schema.marks.strike
        if (!strikeMark) {
          inlineNodes.push(...inlineChildrenToProseMirror(deletion.children, schema, activeMarks))
          break
        }

        inlineNodes.push(
          ...inlineChildrenToProseMirror(
            deletion.children,
            schema,
            appendMark(activeMarks, strikeMark.create()),
          ),
        )
        break
      }
      case 'inlineCode': {
        const inlineCode = child as InlineCode
        const codeMark = schema.marks.code

        if (!codeMark) {
          inlineNodes.push(textNode(schema, inlineCode.value, activeMarks))
          break
        }

        inlineNodes.push(textNode(schema, inlineCode.value, appendMark(activeMarks, codeMark.create())))
        break
      }
      case 'link': {
        const link = child as Link
        const linkMark = schema.marks.link

        if (!linkMark) {
          inlineNodes.push(...inlineChildrenToProseMirror(link.children, schema, activeMarks))
          break
        }

        inlineNodes.push(
          ...inlineChildrenToProseMirror(
            link.children,
            schema,
            appendMark(
              activeMarks,
              linkMark.create({
                href: link.url,
                title: link.title ?? null,
              }),
            ),
          ),
        )
        break
      }
      case 'image': {
        const image = child as Image
        if (schema.nodes.image) {
          inlineNodes.push(
            schema.nodes.image.create({
              src: image.url,
              alt: image.alt ?? null,
              title: image.title ?? null,
            }),
          )
        }
        break
      }
      default:
        break
    }
  }

  return inlineNodes
}

function blockChildrenToProseMirror(children: Content[], schema: Schema): ProseMirrorNode[] {
  const blockNodes: ProseMirrorNode[] = []

  for (const child of children) {
    switch (child.type) {
      case 'paragraph': {
        const inlineNodes = inlineChildrenToProseMirror(child.children, schema)
        blockNodes.push(schema.nodes.paragraph.create(null, inlineNodes))
        break
      }
      case 'heading': {
        const heading = child as Heading
        const level = Math.max(1, Math.min(6, heading.depth))
        const inlineNodes = inlineChildrenToProseMirror(heading.children, schema)
        blockNodes.push(schema.nodes.heading.create({ level }, inlineNodes))
        break
      }
      case 'blockquote': {
        const nested = blockChildrenToProseMirror(child.children, schema)
        blockNodes.push(schema.nodes.blockquote.create(null, nested))
        break
      }
      case 'code': {
        blockNodes.push(
          schema.nodes.code_block.create(
            {
              params: child.lang ?? null,
            },
            child.value ? schema.text(child.value) : undefined,
          ),
        )
        break
      }
      case 'thematicBreak': {
        blockNodes.push(schema.nodes.horizontal_rule.create())
        break
      }
      case 'list': {
        const list = child as List
        const hasTaskItems = list.children.some(
          (listItem) => typeof listItem.checked === 'boolean' && schema.nodes.task_list && schema.nodes.task_item,
        )

        if (hasTaskItems && schema.nodes.task_list && schema.nodes.task_item) {
          const taskItems = list.children.map((listItem) => {
            const taskItem = listItem as ListItem
            const taskChildren = blockChildrenToProseMirror(taskItem.children as Content[], schema)
            const normalized = taskChildren.length > 0 ? taskChildren : [schema.nodes.paragraph.create()]

            return schema.nodes.task_item.create(
              {
                checked: taskItem.checked === true,
              },
              normalized,
            )
          })

          if (taskItems.length > 0) {
            blockNodes.push(schema.nodes.task_list.create(null, taskItems))
          }

          break
        }

        const listItems = list.children.map((listItem) => {
          const item = listItem as ListItem
          const itemChildren = blockChildrenToProseMirror(item.children as Content[], schema)
          const normalized = itemChildren.length > 0 ? itemChildren : [schema.nodes.paragraph.create()]
          return schema.nodes.list_item.create(null, normalized)
        })

        if (listItems.length === 0) {
          break
        }

        if (list.ordered) {
          blockNodes.push(
            schema.nodes.ordered_list.create(
              {
                order: list.start ?? 1,
              },
              listItems,
            ),
          )
        } else {
          blockNodes.push(schema.nodes.bullet_list.create(null, listItems))
        }
        break
      }
      case 'table': {
        const table = child as Table
        if (!schema.nodes.table || !schema.nodes.table_row || !schema.nodes.table_cell || !schema.nodes.table_header) {
          break
        }

        const rows = table.children.length > 0 ? table.children : [{ type: 'tableRow', children: [] as TableCell[] }]
        const pmRows = rows.map((row, rowIndex) => {
          const currentRow = row as TableRow
          const cells = currentRow.children.length > 0 ? currentRow.children : [{ type: 'tableCell', children: [] }]
          const pmCells = cells.map((cell) => {
            const inlineNodes = inlineChildrenToProseMirror(cell.children, schema)
            const paragraph = schema.nodes.paragraph.create(null, inlineNodes)
            const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell
            return cellType.create(null, [paragraph])
          })

          return schema.nodes.table_row.create(null, pmCells)
        })

        blockNodes.push(schema.nodes.table.create(null, pmRows))
        break
      }
      default:
        break
    }
  }

  return blockNodes
}

function markToMdastNode(markName: string, child: PhrasingContent, attrs?: Record<string, unknown>): PhrasingContent {
  switch (markName) {
    case 'strong':
      return { type: 'strong', children: [child] }
    case 'em':
      return { type: 'emphasis', children: [child] }
    case 'strike':
      return { type: 'delete', children: [child] }
    case 'link':
      return {
        type: 'link',
        url: String(attrs?.href ?? ''),
        title: attrs?.title ? String(attrs.title) : null,
        children: [child],
      }
    default:
      return child
  }
}

function textWithMarksToMdast(text: string, marks: readonly Mark[]): PhrasingContent[] {
  const hasCode = marks.some((mark) => mark.type.name === 'code')
  if (hasCode) {
    return [{ type: 'inlineCode', value: text }]
  }

  let node: PhrasingContent = { type: 'text', value: text }
  const priority = ['strong', 'em', 'strike', 'link'] as const

  for (const name of priority) {
    const mark = marks.find((currentMark) => currentMark.type.name === name)
    if (mark) {
      node = markToMdastNode(name, node, mark.attrs as Record<string, unknown>)
    }
  }

  return [node]
}

function inlineFromProseMirror(node: ProseMirrorNode): PhrasingContent[] {
  const inlineChildren: PhrasingContent[] = []

  node.forEach((childNode) => {
    switch (childNode.type.name) {
      case 'text': {
        if (childNode.text) {
          inlineChildren.push(...textWithMarksToMdast(childNode.text, childNode.marks))
        }
        break
      }
      case 'image': {
        inlineChildren.push({
          type: 'image',
          url: String(childNode.attrs.src ?? ''),
          alt: childNode.attrs.alt ? String(childNode.attrs.alt) : null,
          title: childNode.attrs.title ? String(childNode.attrs.title) : null,
        })
        break
      }
      default:
        if (childNode.textContent.length > 0) {
          inlineChildren.push({ type: 'text', value: childNode.textContent })
        }
        break
    }
  })

  return inlineChildren
}

function tableCellToMdast(cellNode: ProseMirrorNode): TableCell {
  const phrasingChildren: PhrasingContent[] = []

  cellNode.forEach((childNode, index) => {
    if (index > 0 && phrasingChildren.length > 0) {
      phrasingChildren.push({ type: 'text', value: ' ' })
    }

    if (childNode.type.name === 'paragraph') {
      phrasingChildren.push(...inlineFromProseMirror(childNode))
      return
    }

    if (childNode.isTextblock && childNode.textContent.length > 0) {
      phrasingChildren.push({ type: 'text', value: childNode.textContent })
      return
    }

    if (childNode.type.name === 'image') {
      phrasingChildren.push({
        type: 'image',
        url: String(childNode.attrs.src ?? ''),
        alt: childNode.attrs.alt ? String(childNode.attrs.alt) : null,
        title: childNode.attrs.title ? String(childNode.attrs.title) : null,
      })
    }
  })

  return {
    type: 'tableCell',
    children: phrasingChildren.length > 0 ? phrasingChildren : [{ type: 'text', value: '' }],
  }
}

function blockFromProseMirror(node: ProseMirrorNode): BlockContent | null {
  switch (node.type.name) {
    case 'paragraph':
      return {
        type: 'paragraph',
        children: inlineFromProseMirror(node),
      }
    case 'heading': {
      const depth = Math.max(1, Math.min(6, Number(node.attrs.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6
      return {
        type: 'heading',
        depth,
        children: inlineFromProseMirror(node),
      }
    }
    case 'blockquote': {
      const children: BlockContent[] = []
      node.forEach((childNode) => {
        const mapped = blockFromProseMirror(childNode)
        if (mapped) {
          children.push(mapped)
        }
      })
      return {
        type: 'blockquote',
        children,
      }
    }
    case 'code_block':
      return {
        type: 'code',
        lang: node.attrs.params ? String(node.attrs.params) : null,
        value: node.textContent,
      }
    case 'horizontal_rule':
      return { type: 'thematicBreak' }
    case 'bullet_list': {
      const children: ListItem[] = []
      node.forEach((childNode) => {
        if (childNode.type.name !== 'list_item') {
          return
        }

        const listItemChildren: BlockContent[] = []
        childNode.forEach((listItemChild) => {
          const mapped = blockFromProseMirror(listItemChild)
          if (mapped) {
            listItemChildren.push(mapped)
          }
        })

        children.push({
          type: 'listItem',
          spread: false,
          children: listItemChildren,
        })
      })

      return {
        type: 'list',
        ordered: false,
        spread: false,
        children,
      }
    }
    case 'ordered_list': {
      const children: ListItem[] = []
      node.forEach((childNode) => {
        if (childNode.type.name !== 'list_item') {
          return
        }

        const listItemChildren: BlockContent[] = []
        childNode.forEach((listItemChild) => {
          const mapped = blockFromProseMirror(listItemChild)
          if (mapped) {
            listItemChildren.push(mapped)
          }
        })

        children.push({
          type: 'listItem',
          spread: false,
          children: listItemChildren,
        })
      })

      return {
        type: 'list',
        ordered: true,
        start: Number(node.attrs.order ?? 1),
        spread: false,
        children,
      }
    }
    case 'task_list': {
      const children: ListItem[] = []

      node.forEach((taskItemNode) => {
        if (taskItemNode.type.name !== 'task_item') {
          return
        }

        const listItemChildren: BlockContent[] = []
        taskItemNode.forEach((taskItemChild) => {
          const mapped = blockFromProseMirror(taskItemChild)
          if (mapped) {
            listItemChildren.push(mapped)
          }
        })

        children.push({
          type: 'listItem',
          spread: false,
          checked: taskItemNode.attrs.checked === true,
          children: listItemChildren,
        })
      })

      return {
        type: 'list',
        ordered: false,
        spread: false,
        children,
      }
    }
    case 'table': {
      const tableRows: TableRow[] = []
      node.forEach((rowNode) => {
        if (rowNode.type.name !== 'table_row') {
          return
        }

        const tableCells: TableCell[] = []
        rowNode.forEach((cellNode) => {
          if (cellNode.type.name !== 'table_cell' && cellNode.type.name !== 'table_header') {
            return
          }

          tableCells.push(tableCellToMdast(cellNode))
        })

        tableRows.push({ type: 'tableRow', children: tableCells })
      })

      return {
        type: 'table',
        align: [],
        children: tableRows,
      }
    }
    default:
      return null
  }
}

function insertEmptyParagraphsForGaps(children: Content[]): Content[] {
  const result: Content[] = []

  for (let i = 0; i < children.length; i++) {
    const child = children[i]

    if (child.type === 'blockquote') {
      child.children = insertEmptyParagraphsForGaps(child.children) as BlockContent[]
    } else if (child.type === 'list') {
      for (const item of child.children) {
        item.children = insertEmptyParagraphsForGaps(item.children) as BlockContent[]
      }
    }

    if (i > 0) {
      const prev = children[i - 1]
      if (prev.position && child.position) {
        const gap = child.position.start.line - prev.position.end.line - 1
        for (let j = 0; j < gap; j++) {
          result.push({ type: 'paragraph', children: [] })
        }
      }
    }

    result.push(child)
  }

  return result
}

function splitBreakParagraphs(children: Content[]): Content[] {
  const result: Content[] = []

  for (const child of children) {
    if (child.type === 'blockquote') {
      child.children = splitBreakParagraphs(child.children) as BlockContent[]
    } else if (child.type === 'list') {
      for (const item of child.children) {
        item.children = splitBreakParagraphs(item.children) as BlockContent[]
      }
    }

    if (child.type !== 'paragraph') {
      result.push(child)
      continue
    }

    if (!child.children.some((c) => c.type === 'break')) {
      result.push(child)
      continue
    }

    let current: PhrasingContent[] = []
    for (const inline of child.children) {
      if (inline.type === 'break') {
        result.push({ type: 'paragraph', children: current })
        current = []
      } else {
        current.push(inline)
      }
    }
    result.push({ type: 'paragraph', children: current })
  }

  return result
}

export function markdownToProseMirrorDoc(markdown: string, schema: Schema): ProseMirrorNode {
  try {
    const parsedTree = markdownParser.runSync(
      markdownParser.parse(normalizeMarkdown(markdown)),
    ) as Root
    parsedTree.children = insertEmptyParagraphsForGaps(parsedTree.children) as Root['children']
    parsedTree.children = splitBreakParagraphs(parsedTree.children) as Root['children']
    const blockNodes = blockChildrenToProseMirror(parsedTree.children, schema)

    if (blockNodes.length === 0) {
      return schema.node('doc', null, [schema.nodes.paragraph.create()])
    }

    return schema.node('doc', null, blockNodes)
  } catch {
    return schema.node('doc', null, [schema.nodes.paragraph.create(null, schema.text(markdown))])
  }
}

export type TextSegment = {
  pmStart: number // PM position (inclusive)
  pmEnd: number   // PM position (exclusive)
  mdStart: number // MD offset (inclusive)
  mdEnd: number   // MD offset (exclusive)
}

export type CursorMap = {
  segments: TextSegment[]
  mdLength: number
}

export function buildCursorMap(doc: ProseMirrorNode): CursorMap {
  const fullMd = proseMirrorDocToMarkdown(doc)
  const segments: TextSegment[] = []
  let mdSearchFrom = 0

  function walkChildren(node: ProseMirrorNode, contentStart: number): void {
    node.forEach((child, offset) => {
      const childPos = contentStart + offset

      if (child.isText && child.text) {
        const text = child.text
        const idx = fullMd.indexOf(text, mdSearchFrom)
        if (idx >= 0) {
          segments.push({
            pmStart: childPos,
            pmEnd: childPos + text.length,
            mdStart: idx,
            mdEnd: idx + text.length,
          })
          mdSearchFrom = idx + text.length
        }
        return
      }

      if (child.isLeaf) {
        return
      }

      // Container node: content starts at childPos + 1 (open tag)
      walkChildren(child, childPos + 1)
    })
  }

  // doc's content starts at position 0
  walkChildren(doc, 0)

  return { segments, mdLength: fullMd.length }
}

export function reverseCursorMapLookup(map: CursorMap, mdOffset: number): number | null {
  const { segments } = map
  if (segments.length === 0) return null

  // Binary search for the segment containing mdOffset
  let lo = 0
  let hi = segments.length - 1

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const seg = segments[mid]

    if (mdOffset < seg.mdStart) {
      hi = mid - 1
    } else if (mdOffset >= seg.mdEnd) {
      lo = mid + 1
    } else {
      // Inside segment: exact mapping
      return seg.pmStart + (mdOffset - seg.mdStart)
    }
  }

  // mdOffset is between segments — snap to nearest boundary
  const before = hi >= 0 ? segments[hi] : null
  const after = lo < segments.length ? segments[lo] : null

  if (!before) return after ? after.pmStart : 0
  if (!after) return before.pmEnd

  const distBefore = mdOffset - before.mdEnd
  const distAfter = after.mdStart - mdOffset
  return distBefore <= distAfter ? before.pmEnd : after.pmStart
}

export function cursorMapLookup(map: CursorMap, pmPos: number): number | null {
  const { segments } = map
  if (segments.length === 0) return null

  // Binary search for the segment containing pmPos
  let lo = 0
  let hi = segments.length - 1

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const seg = segments[mid]

    if (pmPos < seg.pmStart) {
      hi = mid - 1
    } else if (pmPos >= seg.pmEnd) {
      lo = mid + 1
    } else {
      // Inside segment: exact mapping
      return seg.mdStart + (pmPos - seg.pmStart)
    }
  }

  // pmPos is between segments — snap to nearest boundary
  // After binary search: hi < lo, pmPos falls between segments[hi] and segments[lo]
  const before = hi >= 0 ? segments[hi] : null
  const after = lo < segments.length ? segments[lo] : null

  if (!before) return after ? after.mdStart : 0
  if (!after) return before.mdEnd

  const distBefore = pmPos - before.pmEnd
  const distAfter = after.pmStart - pmPos
  return distBefore <= distAfter ? before.mdEnd : after.mdStart
}

export function proseMirrorDocToMarkdown(doc: ProseMirrorNode): string {
  const root: Root = {
    type: 'root',
    children: [],
  }

  doc.forEach((childNode) => {
    const mapped = blockFromProseMirror(childNode)
    if (mapped) {
      root.children.push(mapped)
    }
  })

  const markdown = markdownStringifier.stringify(root)
  return typeof markdown === 'string' ? markdown.replace(/\n$/, '') : ''
}
