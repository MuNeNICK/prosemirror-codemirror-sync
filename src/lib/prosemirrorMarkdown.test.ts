import { describe, expect, it } from 'vitest'
import { markdownToProseMirrorDoc, proseMirrorDocToMarkdown } from './prosemirrorMarkdown'
import { prosemirrorSchema } from './prosemirrorSchema'

describe('prosemirror markdown conversion', () => {
  it('parses GFM task list and table into ProseMirror nodes', () => {
    const markdown = `# Title\n\n- [ ] todo\n- [x] done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n`

    const doc = markdownToProseMirrorDoc(markdown, prosemirrorSchema)

    expect(doc.child(0).type.name).toBe('heading')
    expect(doc.child(1).type.name).toBe('task_list')
    expect(doc.child(2).type.name).toBe('table')
  })

  it('serializes ProseMirror document to markdown with key constructs', () => {
    const markdown = `## Header\n\n- bullet\n\n- [x] task\n\n![alt](https://example.com/a.png)\n`

    const doc = markdownToProseMirrorDoc(markdown, prosemirrorSchema)
    const result = proseMirrorDocToMarkdown(doc)

    expect(result).toContain('## Header')
    expect(result).toContain('- [ ] bullet')
    expect(result).toContain('- [x] task')
    expect(result).toContain('![alt](https://example.com/a.png)')
  })
})
