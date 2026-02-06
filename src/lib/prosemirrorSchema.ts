import { Schema } from 'prosemirror-model'
import { addListNodes } from 'prosemirror-schema-list'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { tableNodes } from 'prosemirror-tables'
import type { MarkSpec, NodeSpec } from 'prosemirror-model'

const taskListNodeSpec: NodeSpec = {
  group: 'block',
  content: 'task_item+',
  parseDOM: [{ tag: 'ul[data-type="task-list"]' }],
  toDOM() {
    return ['ul', { 'data-type': 'task-list', class: 'task-list' }, 0]
  },
}

const taskItemNodeSpec: NodeSpec = {
  attrs: {
    checked: { default: false },
  },
  defining: true,
  content: 'paragraph block*',
  parseDOM: [
    {
      tag: 'li[data-type="task-item"]',
      contentElement: '.task-item__content',
      getAttrs(dom) {
        const checked = (dom as HTMLElement).getAttribute('data-checked') === 'true'
        return { checked }
      },
    },
  ],
  toDOM(node) {
    const checked = node.attrs.checked === true

    return [
      'li',
      {
        'data-type': 'task-item',
        'data-checked': checked ? 'true' : 'false',
        class: checked ? 'task-item is-checked' : 'task-item',
      },
      [
        'input',
        {
          class: 'task-item__checkbox',
          'data-task-checkbox': 'true',
          type: 'checkbox',
          checked: checked ? 'checked' : null,
          contenteditable: 'false',
          'aria-hidden': 'true',
        },
      ],
      ['div', { class: 'task-item__content' }, 0],
    ]
  },
}

const strikeMarkSpec: MarkSpec = {
  parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
  toDOM() {
    return ['del', 0]
  },
}

let nodes = addListNodes(basicSchema.spec.nodes.remove('hard_break'), 'paragraph block*', 'block')
nodes = nodes.append(
  tableNodes({
    tableGroup: 'block',
    cellContent: 'block+',
    cellAttributes: {},
  }),
)
nodes = nodes.append({
  task_list: taskListNodeSpec,
  task_item: taskItemNodeSpec,
})

const marks = basicSchema.spec.marks.addToEnd('strike', strikeMarkSpec)

export const prosemirrorSchema = new Schema({
  nodes,
  marks,
})
