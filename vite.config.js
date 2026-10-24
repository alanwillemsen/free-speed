import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import { spawn } from 'child_process'
import { PeerServer } from 'peer'

const httpsConfig = fs.existsSync('.cert/key.pem')
  ? { key: fs.readFileSync('.cert/key.pem'), cert: fs.readFileSync('.cert/cert.pem') }
  : undefined

const PEER_PORT = 9000
const RELAY_PORT = 8787

// Run a local PeerJS signalling server alongside the dev server so two phones
// can pair over the LAN with the WebRTC fallback transport (see
// src/hooks/useLink.js). The app reaches it through the `/peerjs` proxy below,
// so the WebSocket rides the dev server's already-trusted cert instead of
// needing a second self-signed exception.
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

// Run a local copy of the relay Worker (relay/) with `wrangler dev`, the same
// way: the app reaches it through the `/relay` proxy below. `.env.development`
// points VITE_RELAY_URL at that path, so dev uses the relay transport exactly
// as production does, with no Cloudflare account and no internet needed.
function localRelayServer() {
  let child
  return {
    name: 'local-relay-server',
    configureServer(server) {
      if (child) return
      child = spawn(
        'npx',
        ['wrangler', 'dev', '-c', 'relay/wrangler.toml', '--port', String(RELAY_PORT), '--ip', '127.0.0.1'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
      )
      const log = (chunk) => {
        const line = chunk.toString().trim()
        if (/Ready on|error|Error/.test(line)) server.config.logger.info(`[relay] ${line}`)
      }
      child.stdout.on('data', log)
      child.stderr.on('data', log)
      child.on('exit', (code) => {
        if (code && code !== 0) server.config.logger.warn(`[relay] wrangler dev exited with code ${code}`)
        child = null
      })
      const stop = () => { try { child?.kill() } catch { /* ignore */ } }
      server.httpServer?.once('close', stop)
      process.once('exit', stop)
    },
  }
}

export default defineConfig({
  plugins: [react(), localPeerServer(), localRelayServer()],
  server: {
    host: true,
    https: httpsConfig,
    proxy: {
      // HTTP API (/peerjs/id, /peerjs/peers) + the WebSocket (/peerjs) both live
      // under this prefix; `ws: true` forwards the upgrade.
      '/peerjs': { target: `http://localhost:${PEER_PORT}`, ws: true, changeOrigin: true },
      // Relay Worker: /relay/room/<id> (WebSocket) and /relay/room/<id>/presence.
      '/relay': { target: `http://127.0.0.1:${RELAY_PORT}`, ws: true, changeOrigin: true, rewrite: (p) => p.replace(/^\/relay/, '') },
    },
  },
})
