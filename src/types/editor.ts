export type UpdateSource = 'markdown' | 'wysiwyg' | 'external'

export type SyncTarget = 'markdown' | 'wysiwyg'

export type SyncState = {
  markdown: string
  source: UpdateSource
  revision: number
}
