// free-speed relay: a WebSocket room per peer id, hosted in a Durable Object.
//
// Why this exists: the coach and rower phones are on cell data, usually on
// different carriers, each behind carrier-grade NAT. WebRTC between them needs
// a TURN relay, and the public one PeerJS ships with no longer resolves. So
// instead of NAT traversal, both phones open an ordinary outbound WebSocket to
// this Worker and the room forwards frames between them. Same path a TURN
// relay would take, with the handshake machinery removed.
//
// Model
//   Room "<id>"  — one HOST (the phone whose peer id this is) and one GUEST
//                  (whoever dialled that id). Newest connection of a role wins:
//                  a phone that reconnects after a drop displaces its own
//                  zombie socket instead of being refused.
//   Frames       — JSON text. Anything that does not start with {"_relay" is
//                  app data and is forwarded verbatim to the other role.
//                  {"_relay":...} frames are control messages for the room.
//
// Wire protocol (relay -> client)
//   {"_relay":"hello","role":"host"|"guest","peer":{"id","name"}|null}
//   {"_relay":"peer","online":true|false,"id":"<peer id>","name":""}
//   {"_relay":"pong"}                 answer to a client {"_relay":"ping"}
// Wire protocol (client -> relay)
//   {"_relay":"ping"}                 liveness; answered without waking the room
//   {"_relay":"presence","name":"","busy":false}   host only; shown by /presence
//   {"_relay":"kick"}                 host only; closes the current guest
//
// HTTP
//   GET /room/<id>/presence  -> {"online":bool,"name":"","busy":bool,"guests":n}
//   GET /room/<id>?role=host|guest&from=<own id>   (WebSocket upgrade)
//
// Close codes: 4001 replaced by a newer socket, 4002 reaped as silent,
// 4003 kicked by the host, 4400 bad request (client must not retry).

const REAP_INTERVAL_MS = 60_000;   // how often a room checks for silent sockets
const REAP_AFTER_MS = 90_000;      // silence (no ping, no data) that counts as dead
const ROOM_ID_RE = /^[a-z0-9-]{1,64}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...CORS } });
}

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    // Sockets we closed ourselves in this activation; stops a double
    // "peer offline" when the runtime also reports the close.
    this.gone = new WeakSet();
    // Last app-data frame per socket: data counts as liveness for the reaper
    // too, so a phone streaming with a throttled ping timer is never reaped.
    this.lastData = new WeakMap();
    // Client liveness pings are answered by the runtime itself: no wake-up,
    // not billed, and the timestamp of the last one is readable in alarm().
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"_relay":"ping"}', '{"_relay":"pong"}'),
    );
  }

  sockets(role) {
    return role ? this.ctx.getWebSockets(role) : this.ctx.getWebSockets();
  }

  att(ws) {
    try { return ws.deserializeAttachment() || {}; } catch { return {}; }
  }

  send(ws, obj) {
    try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch { /* closing */ }
  }

  presence() {
    const host = this.sockets('host')[0];
    const a = host ? this.att(host) : null;
    return { online: !!host, name: a?.name || '', busy: !!a?.busy, guests: this.sockets('guest').length };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/presence')) return json(this.presence());
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return text('expected a WebSocket upgrade', 426);
    }
    const role = url.searchParams.get('role');
    const from = (url.searchParams.get('from') || '').slice(0, 64);
    if (role !== 'host' && role !== 'guest') return text('role must be host or guest', 400);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Newest wins. The displaced socket is almost always this same phone's
    // previous life (reload, frozen tab, dropped radio) still lingering.
    for (const old of this.sockets(role)) {
      this.gone.add(old);
      try { old.close(4001, 'replaced'); } catch { /* already dead */ }
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, from, name: '', busy: false, since: Date.now() });

    const otherRole = role === 'host' ? 'guest' : 'host';
    const other = this.sockets(otherRole)[0];
    const oa = other ? this.att(other) : null;
    this.send(server, { _relay: 'hello', role, peer: other ? { id: oa.from || '', name: oa.name || '' } : null });
    if (other) this.send(other, { _relay: 'peer', online: true, id: from, name: '' });

    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(Date.now() + REAP_INTERVAL_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    this.lastData.set(ws, Date.now());
    if (typeof message === 'string' && message.startsWith('{"_relay"')) {
      this.control(ws, message);
      return;
    }
    const a = this.att(ws);
    if (!a.role) return;
    for (const target of this.sockets(a.role === 'host' ? 'guest' : 'host')) this.send(target, message);
  }

  control(ws, raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    const a = this.att(ws);
    switch (frame._relay) {
      case 'ping': // normally auto-answered before reaching us
        this.send(ws, '{"_relay":"pong"}');
        break;
      case 'presence':
        if (a.role === 'host') {
          ws.serializeAttachment({ ...a, name: String(frame.name || '').slice(0, 64), busy: !!frame.busy });
        }
        break;
      case 'kick':
        if (a.role === 'host') {
          for (const g of this.sockets('guest')) {
            // Tell the guest first: a server-initiated close can take a
            // while to finish on the client, and the UI should not wait.
            this.send(g, { _relay: 'peer', online: false, id: a.from || '', kicked: true });
            this.gone.add(g);
            try { g.close(4003, 'kicked'); } catch { /* ignore */ }
            this.dropped(g);
          }
        }
        break;
      default:
        break;
    }
  }

  webSocketClose(ws) {
    if (this.gone.has(ws)) return;
    this.dropped(ws);
  }

  webSocketError(ws) {
    if (this.gone.has(ws)) return;
    this.gone.add(ws);
    try { ws.close(1011, 'error'); } catch { /* ignore */ }
    this.dropped(ws);
  }

  // Tell the other role its peer is gone — unless a replacement of the same
  // role is already attached, in which case the other side never saw a gap.
  dropped(ws) {
    const a = this.att(ws);
    if (!a.role) return;
    if (this.sockets(a.role).some((s) => s !== ws)) return;
    for (const target of this.sockets(a.role === 'host' ? 'guest' : 'host')) {
      this.send(target, { _relay: 'peer', online: false, id: a.from || '' });
    }
  }

  // Reap sockets whose phone vanished without a TCP close (radio dropped,
  // battery died). Clients ping every 10 s, so 90 s of silence is decisive.
  async alarm() {
    const now = Date.now();
    let live = 0;
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const seen = Math.max(a.since || 0, pinged ? pinged.getTime() : 0, this.lastData.get(ws) || 0);
      if (now - seen > REAP_AFTER_MS) {
        this.gone.add(ws);
        try { ws.close(4002, 'timeout'); } catch { /* ignore */ }
        this.dropped(ws);
      } else {
        live += 1;
      }
    }
    if (live) await this.ctx.storage.setAlarm(now + REAP_INTERVAL_MS);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    // Tolerate a mount prefix (the Vite dev proxy serves us under /relay).
    const path = url.pathname.replace(/^\/relay(?=\/|$)/, '');
    if (path === '' || path === '/') return text('free-speed relay ok');
    const m = path.match(/^\/room\/([^/]+)(\/presence)?\/?$/);
    if (!m) return text('not found', 404);
    const id = decodeURIComponent(m[1]).toLowerCase();
    if (!ROOM_ID_RE.test(id)) return text('bad room id', 400);
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    const res = await stub.fetch(request);
    if (res.status === 101) return res; // WebSocket handed through untouched
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};
