import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import { PeerServer } from 'peer'

const httpsConfig = fs.existsSync('.cert/key.pem')
  ? { key: fs.readFileSync('.cert/key.pem'), cert: fs.readFileSync('.cert/cert.pem') }
  : undefined

const PEER_PORT = 9000

// Run a local PeerJS signalling server alongside the dev server so two phones
// pair over the LAN without the public cloud broker (which rate-limits, and
// needs internet the boat won't have). The app reaches it through the `/peerjs`
// proxy below, so the WebSocket rides the dev server's already-trusted cert
// instead of needing a second self-signed exception.
function localPeerServer() {
  let peerServer
  return {
    name: 'local-peer-server',
    configureServer() {
      if (peerServer) return
      peerServer = PeerServer({ port: PEER_PORT, path: '/', key: 'peerjs', allow_discovery: true })
    },
    closeBundle() { try { peerServer?.close?.() } catch { /* ignore */ } },
  }
}

export default defineConfig({
  plugins: [react(), localPeerServer()],
  server: {
    host: true,
    https: httpsConfig,
    proxy: {
      // HTTP API (/peerjs/id, /peerjs/peers) + the WebSocket (/peerjs) both live
      // under this prefix; `ws: true` forwards the upgrade.
      '/peerjs': { target: `http://localhost:${PEER_PORT}`, ws: true, changeOrigin: true },
    },
  },
})
