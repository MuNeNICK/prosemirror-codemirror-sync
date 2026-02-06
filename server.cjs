const http = require('http')
const { WebSocketServer } = require('ws')

const Y = require('yjs')
const { encoding, decoding, map } = require('lib0')
const awarenessProtocol = require('y-protocols/awareness')
const syncProtocol = require('y-protocols/sync')

const messageSync = 0
const messageAwareness = 1

const docs = new Map()

function getYDoc(docName) {
  return map.setIfUndefined(docs, docName, () => {
    const doc = new Y.Doc()
    doc.gc = true
    return doc
  })
}

const server = http.createServer((_req, res) => {
  res.writeHead(200)
  res.end('y-websocket server')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const docName = (req.url || '').slice(1).split('?')[0] || 'default'
  const doc = getYDoc(docName)
  const awareness = new awarenessProtocol.Awareness(doc)

  const send = (buf) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(buf, (err) => { if (err) console.error(err) })
    }
  }

  // Send initial sync step 1
  const syncEncoder = encoding.createEncoder()
  encoding.writeVarUint(syncEncoder, messageSync)
  syncProtocol.writeSyncStep1(syncEncoder, doc)
  send(encoding.toUint8Array(syncEncoder))

  // Send awareness states
  const awarenessStates = awareness.getStates()
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys()))
    )
    send(encoding.toUint8Array(awarenessEncoder))
  }

  const docUpdateHandler = (update, origin) => {
    if (origin === ws) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    send(encoding.toUint8Array(encoder))
  }

  const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
    if (origin === ws) return
    const changedClients = added.concat(updated, removed)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
    )
    send(encoding.toUint8Array(encoder))
  }

  doc.on('update', docUpdateHandler)
  awareness.on('change', awarenessChangeHandler)

  ws.on('message', (data) => {
    const buf = new Uint8Array(data)
    const decoder = decoding.createDecoder(buf)
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case messageSync: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
        if (encoding.length(encoder) > 1) {
          send(encoding.toUint8Array(encoder))
        }
        break
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          ws
        )
        break
      }
    }
  })

  ws.on('close', () => {
    doc.off('update', docUpdateHandler)
    awareness.off('change', awarenessChangeHandler)
  })
})

const PORT = process.env.PORT || 1234
server.listen(PORT, () => {
  console.log(`y-websocket server running on port ${PORT}`)
})
