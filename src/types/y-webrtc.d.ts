declare module 'y-webrtc' {
  import type { Doc } from 'yjs'

  export type WebrtcProviderOptions = {
    signaling?: string[]
    password?: string
    awareness?: unknown
    maxConns?: number
    filterBcConns?: boolean
    peerOpts?: Record<string, unknown>
  }

  export class WebrtcProvider {
    constructor(roomName: string, doc: Doc, options?: WebrtcProviderOptions)
    destroy(): void
  }
}

