declare module 'y-websocket' {
  import type { Awareness } from 'y-protocols/awareness'
  import type { Doc } from 'yjs'

  export class WebsocketProvider {
    awareness: Awareness
    wsconnected: boolean
    constructor(serverUrl: string, roomName: string, doc: Doc, options?: {
      connect?: boolean
      awareness?: Awareness
      params?: Record<string, string>
      resyncInterval?: number
      maxBackoffTime?: number
      disableBc?: boolean
    })
    connect(): void
    disconnect(): void
    destroy(): void
  }
}
