import { useState, useRef, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';

// WebSocket-relay transport for the dual-phone link. Same surface as
// usePeerLink (useLink.js picks one), different plumbing: instead of WebRTC
// through a signalling broker plus STUN/TURN, each phone keeps one outbound
// WebSocket to a room on the relay Worker (relay/), which forwards frames
// between the room's host and its guest. Two phones on two cell carriers both
// sit behind carrier-grade NAT, so WebRTC between them either fails outright or
// ends up on a TURN relay anyway — this is that relay path with the NAT
// traversal removed, and one TLS connection per phone to keep alive.
//
// Rooms are named by peer id. Every phone hosts its own room (`myPeerId`);
// dialling a remote id joins *their* room as the guest. The relay admits one
// guest per room, newest wins, so a phone reconnecting after a drop displaces
// its own zombie socket instead of being refused.
//
// Pages see the same message semantics as before (`onData(msg)` objects with a
// `type`); the one wire-level difference is that sendBatch packs the three
// sample arrays into a single 'batch' frame, which the receiving hook unpacks.

const PEER_ID_PREFIX = 'freespeed-';
const RELAY_URL = import.meta.env.VITE_RELAY_URL || '';

// Client → relay liveness. The relay answers {"_relay":"ping"} without waking
// the room; silence past RELAY_STALE_MS means our own socket is dead (radio
// dropped, tab frozen) even though the browser still reports it open.
const RELAY_PING_MS = 5000;
const RELAY_STALE_MS = 16000;
// After a wake signal that makes the socket suspect (device back online, page
// back in the foreground) we ping at once and allow only this long for the
// answer before reconnecting.
const VERIFY_MS = 3000;
// End-to-end liveness over the relayed link, same cadence as usePeerLink.
const HEARTBEAT_MS = 5000;
const CONN_STALE_MS = 15000;
// Presence refresh + "is everything still up" sweep.
const WATCHDOG_MS = 3000;
const PROBE_TIMEOUT_MS = 4000;
// Relay close codes (see relay/src/index.js). 4001: a newer socket of our role
// took the room (yield, see ManagedSocket). 4400: bad request, stop retrying.
const CLOSE_REPLACED = 4001;
const CLOSE_BAD_REQUEST = 4400;
const YIELD_RETRY_MS = 10000;

export function relayConfigured() {
  return !!RELAY_URL;
}

// VITE_RELAY_URL may be absolute (wss://…workers.dev) or a same-origin path
// (/relay in dev, proxied by Vite to a local `wrangler dev`).
function relayBase() {
  const raw = RELAY_URL.startsWith('/') ? window.location.origin + RELAY_URL : RELAY_URL;
  const u = new URL(raw);
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const path = u.pathname.replace(/\/+$/, '');
  return {
    ws: `${secure ? 'wss' : 'ws'}://${u.host}${path}`,
    http: `${secure ? 'https' : 'http'}://${u.host}${path}`,
  };
}

function makeShortCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

export function shortFromPeerId(peerId) {
  return peerId?.startsWith(PEER_ID_PREFIX) ? peerId.slice(PEER_ID_PREFIX.length) : peerId;
}

function parseJoinFromHash(page) {
  const h = window.location.hash;
  if (!h.startsWith(`#${page}`)) return null;
  const m = h.match(/[?&]join=([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

function buildJoinUrl(page, shortCode, inviteRole) {
  const base = `${window.location.origin}${window.location.pathname}#${page}?join=${shortCode}`;
  return inviteRole ? `${base}&as=${inviteRole}` : base;
}

// A WebSocket that stays up: reconnects with capped exponential backoff, pings
// the relay, and treats prolonged silence as a dead socket. Frames arrive
// parsed; relay pongs are consumed here. `onDown` fires whenever a socket that
// had opened goes away, before any reconnect.
//
// Displacement: the relay admits one socket per role per room, newest wins,
// and closes the older one with 4001. That is usually this same phone's
// previous life — but it can be a second live tab of the app on one phone.
// Rather than fight it (two tabs displacing each other every second), a
// displaced socket yields: it re-claims only once `canClaim()` says the slot
// is free again, checking every YIELD_RETRY_MS.
class ManagedSocket {
  constructor(url, { onFrame, onDown, onFatal, canClaim }) {
    this.url = url;
    this.onFrame = onFrame;
    this.onDown = onDown;
    this.onFatal = onFatal;
    this.canClaim = canClaim;
    this.ws = null;
    this.wasUp = false;      // current socket reached open
    this.wasUpOnce = false;  // any socket ever reached open
    this.retryTimer = null;
    this.pingTimer = null;
    this.verifyTimer = null;
    this.attempts = 0;
    this.lastHeard = 0;
    this.stopped = false;
    this.fatal = false;
    this.yielded = false;    // displaced by a newer socket of our role
    this.checking = false;   // canClaim() in flight
  }

  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  start() {
    this.stopped = false;
    if (!this.ws && !this.retryTimer && !this.checking) this.connect();
  }

  // Wake signal: reconnect now if down (skipping the backoff wait), or drop a
  // socket that has gone silent so the reconnect path runs.
  nudge() {
    if (this.stopped || this.fatal || this.checking) return;
    if (this.ws) {
      if (this.open && Date.now() - this.lastHeard > RELAY_STALE_MS) this.reset();
      return;
    }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.connect();
  }

  // Wake signal where the socket is suspect: ping now and give the relay
  // VERIFY_MS to answer, instead of waiting out the normal stale window.
  verify() {
    if (this.stopped || this.fatal || this.checking) return;
    if (!this.ws) { this.nudge(); return; }
    if (!this.open) return;
    const heard = this.lastHeard;
    this.send('{"_relay":"ping"}');
    clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null;
      if (this.open && this.lastHeard === heard) this.reset();
    }, VERIFY_MS);
  }

  // Drop the current socket and reconnect immediately.
  reset() {
    if (this.stopped || this.fatal) return;
    this.kill();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (!this.checking) this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.kill();
  }

  send(obj) {
    if (!this.open) return false;
    try {
      this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  connect() {
    if (this.yielded && this.canClaim) {
      this.checking = true;
      Promise.resolve()
        .then(() => this.canClaim())
        .then((free) => free, () => true)
        .then((free) => {
          this.checking = false;
          if (this.stopped || this.fatal) return;
          if (free) {
            this.yielded = false;
            this.openSocket();
          } else {
            this.scheduleRetry(YIELD_RETRY_MS);
          }
        });
      return;
    }
    this.openSocket();
  }

  openSocket() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.wasUp = false;
    this.lastHeard = Date.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.wasUp = true;
      this.wasUpOnce = true;
      this.lastHeard = Date.now();
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame && frame._relay === 'pong') return;
      this.onFrame?.(frame);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.wasUp) this.onDown?.();
      if (ev.code === CLOSE_BAD_REQUEST) {
        this.fatal = true;
        this.onFatal?.(ev.reason || 'rejected by relay');
        return;
      }
      if (ev.code === CLOSE_REPLACED) this.yielded = true;
      if (!this.stopped) this.scheduleRetry(ev.code === CLOSE_REPLACED ? YIELD_RETRY_MS : undefined);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  kill() {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
    if (this.wasUp) this.onDown?.();
    this.wasUp = false;
  }

  // Backoff 1s, 2s, 4s … capped at 15s, or a fixed delay when given.
  scheduleRetry(delay) {
    if (this.stopped || this.retryTimer) return;
    const wait = delay ?? Math.min(1000 * 2 ** this.attempts, 15000);
    if (delay == null) this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, wait);
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.open) return;
      if (Date.now() - this.lastHeard > RELAY_STALE_MS) {
        // Our own socket is dead; the browser just hasn't noticed.
        this.kill();
        this.scheduleRetry();
        return;
      }
      this.send('{"_relay":"ping"}');
    }, RELAY_PING_MS);
  }

  stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

// GET /room/<id>/presence → { online, name, busy, guests } or null on failure.
async function fetchPresence(id, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${relayBase().http}/room/${encodeURIComponent(id)}/presence`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function useRelayLink({ page, onData, onOpen, onClose, onJoin, fixedId, getPresence, inviteRole }) {
  const [myPeerId, setMyPeerId] = useState('');
  const [remoteShortCode, setRemoteShortCode] = useState('');
  const [peerStatus, setPeerStatus] = useState('idle'); // idle | initializing | online | reconnecting | connecting | connected | error
  const [peerError, setPeerError] = useState('');
  const [lastPing, setLastPing] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [connectedPeerId, setConnectedPeerId] = useState(''); // remote id of the live link

  const myIdRef = useRef('');
  const homeRef = useRef(null);      // ManagedSocket: host of our own room
  const homeReadyRef = useRef(false); // got the room's hello on the current socket
  const dialRef = useRef(null);      // ManagedSocket: guest in the remote's room
  const targetRef = useRef(null);    // remote id we dialled (null = not dialling)
  const connRef = useRef(null);      // { sock, id } — the live relayed link, if any
  const startedRef = useRef(false);
  const everStartedRef = useRef(false);
  const intentionalRef = useRef(false);
  const fatalRef = useRef(false);
  const heartbeatTimerRef = useRef(null);
  const lastHeardRef = useRef(0);
  const pingStartRef = useRef(null);
  const autoConnectOnReadyRef = useRef(false);
  const lastPresenceRef = useRef('');
  const ensureAliveRef = useRef(null);

  // Keep latest callbacks reachable from stable socket handlers.
  const onDataRef = useRef(onData);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onJoinRef = useRef(onJoin);
  const getPresenceRef = useRef(getPresence);
  const fixedIdRef = useRef(fixedId);
  onDataRef.current = onData;
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;
  onJoinRef.current = onJoin;
  getPresenceRef.current = getPresence;
  fixedIdRef.current = fixedId;

  // Status is derived from the refs rather than threaded through every
  // transition — far fewer ways to end up stuck on a stale label.
  const refreshStatus = useCallback(() => {
    if (fatalRef.current) return; // 'error' already shown
    if (connRef.current) setPeerStatus('connected');
    else if (targetRef.current) setPeerStatus('connecting');
    else if (homeReadyRef.current) setPeerStatus('online');
    else if (everStartedRef.current) setPeerStatus(myIdRef.current && homeRef.current?.wasUpOnce ? 'reconnecting' : 'initializing');
    else setPeerStatus('idle');
  }, []);

  const peerDetached = useCallback(() => {
    if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    if (!connRef.current) return;
    connRef.current = null;
    setConnectedPeerId('');
    onCloseRef.current?.();
    refreshStatus();
  }, [refreshStatus]);

  const peerAttached = useCallback((sock, id) => {
    const cur = connRef.current;
    if (cur && cur.sock === sock && cur.id === id) return; // duplicate notice
    if (cur) peerDetached();
    connRef.current = { sock, id };
    lastHeardRef.current = Date.now();
    setConnectedPeerId(id);
    refreshStatus();
    // End-to-end heartbeat. The relay tells us when the other side's socket
    // closes, but a phone whose radio just died stays "connected" there for a
    // while — this notices within CONN_STALE_MS.
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = setInterval(() => {
      const c = connRef.current;
      if (!c || c.sock !== sock) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
        return;
      }
      if (Date.now() - lastHeardRef.current > CONN_STALE_MS) {
        peerDetached();
        // Dialling side: re-enter the room — a fresh hello says whether the
        // host is really still there.
        if (sock === dialRef.current) sock.reset();
        return;
      }
      sock.send({ type: 'ping', t: 'hb' });
    }, HEARTBEAT_MS);
    onOpenRef.current?.({ peer: id, send: (msg) => { sock.send(msg); } });
  }, [peerDetached, refreshStatus]);

  const sendPresence = useCallback((force) => {
    const home = homeRef.current;
    if (!home?.open) return;
    const p = getPresenceRef.current?.() || {};
    // `_relay` must be the first key: the relay recognises control frames by
    // their leading bytes so it never has to parse the sample stream.
    const frame = JSON.stringify({ _relay: 'presence', name: p.name || '', busy: !!p.busy });
    if (!force && frame === lastPresenceRef.current) return;
    lastPresenceRef.current = frame;
    home.send(frame);
  }, []);

  // Frames from either socket. Control frames drive attach/detach; app data is
  // only honoured from the socket that carries the live link.
  const handleFrame = useCallback((sock, frame) => {
    if (!frame || typeof frame !== 'object') return;
    if (frame._relay) {
      const isHome = sock === homeRef.current;
      if (frame._relay === 'hello') {
        if (isHome) {
          homeReadyRef.current = true;
          setMyPeerId(myIdRef.current);
          sendPresence(true);
          if (frame.peer?.id) peerAttached(sock, frame.peer.id);
          else if (connRef.current?.sock === sock) peerDetached();
        } else if (sock === dialRef.current) {
          if (frame.peer) peerAttached(sock, targetRef.current);
          else if (connRef.current?.sock === sock) peerDetached();
        }
        refreshStatus();
      } else if (frame._relay === 'peer') {
        if (frame.online) {
          if (isHome) peerAttached(sock, frame.id || 'guest');
          else if (sock === dialRef.current) peerAttached(sock, targetRef.current);
        } else if (connRef.current?.sock === sock) {
          peerDetached();
        }
      }
      return;
    }
    if (connRef.current?.sock !== sock) return;
    lastHeardRef.current = Date.now();
    if (frame.type === 'ping') {
      sock.send({ type: 'pong', t: frame.t });
      return;
    }
    if (frame.type === 'pong') {
      if (pingStartRef.current && frame.t === pingStartRef.current.t) {
        setLastPing(Math.round(performance.now() - pingStartRef.current.start));
        pingStartRef.current = null;
      }
      return;
    }
    if (frame.type === 'batch') {
      for (const k of ['motion', 'orientation', 'gps']) {
        if (Array.isArray(frame[k]) && frame[k].length) onDataRef.current?.({ type: k, samples: frame[k] });
      }
      return;
    }
    onDataRef.current?.(frame);
  }, [peerAttached, peerDetached, refreshStatus, sendPresence]);

  const failFatal = useCallback((reason) => {
    fatalRef.current = true;
    setPeerError(String(reason));
    setPeerStatus('error');
  }, []);

  const initPeer = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    everStartedRef.current = true;
    intentionalRef.current = false;
    fatalRef.current = false;
    setPeerError('');
    // A stable id (from pairStore) lets a coach find the same rower on a later
    // day; without one, a throwaway 5-digit code for this session.
    const id = myIdRef.current || fixedIdRef.current || PEER_ID_PREFIX + makeShortCode();
    myIdRef.current = id;
    const base = relayBase();
    const home = new ManagedSocket(
      `${base.ws}/room/${encodeURIComponent(id)}?role=host&from=${encodeURIComponent(id)}`,
      {
        onFrame: (f) => handleFrame(home, f),
        onDown: () => {
          homeReadyRef.current = false;
          if (connRef.current?.sock === home) peerDetached();
          refreshStatus();
        },
        onFatal: failFatal,
        // After being displaced: re-claim our room only once nobody hosts it.
        canClaim: async () => { const p = await fetchPresence(id); return !p || !p.online; },
      },
    );
    homeRef.current = home;
    refreshStatus();
    home.start();
  }, [handleFrame, peerDetached, refreshStatus, failFatal]);

  const connectToRemote = useCallback((overrideCode) => {
    if (!myIdRef.current) return;
    // Codes are lowercase (numeric, or base36 from pairStore); lowercase the
    // input so a phone that auto-capitalised still matches.
    const raw = (overrideCode ?? remoteShortCode).trim().toLowerCase();
    if (!raw) return;
    const targetId = raw.startsWith(PEER_ID_PREFIX) ? raw : PEER_ID_PREFIX + raw;
    intentionalRef.current = false;
    if (targetRef.current === targetId && dialRef.current) {
      dialRef.current.nudge();
      refreshStatus();
      return;
    }
    const old = dialRef.current;
    dialRef.current = null;
    if (connRef.current?.sock === old) peerDetached();
    old?.stop();
    targetRef.current = targetId;
    const base = relayBase();
    const dial = new ManagedSocket(
      `${base.ws}/room/${encodeURIComponent(targetId)}?role=guest&from=${encodeURIComponent(myIdRef.current)}`,
      {
        onFrame: (f) => handleFrame(dial, f),
        onDown: () => {
          if (connRef.current?.sock === dial) peerDetached();
          refreshStatus();
        },
        onFatal: failFatal,
        // After being displaced (another coach took the room): wait for the
        // guest slot to free up rather than trading it back and forth.
        canClaim: async () => { const p = await fetchPresence(targetId); return !p || !p.guests; },
      },
    );
    dialRef.current = dial;
    refreshStatus();
    dial.start();
  }, [remoteShortCode, handleFrame, peerDetached, refreshStatus, failFatal]);

  // Revive anything the platform silently killed (frozen tab, locked phone,
  // StrictMode's unmount/remount) and keep presence fresh. Idempotent.
  // `suspect` marks wake signals after which an open socket is probably dead
  // (device back online, page back in the foreground): verify it now.
  const ensureAlive = useCallback((suspect = false) => {
    if (intentionalRef.current || !everStartedRef.current || fatalRef.current) return;
    const poke = (sock) => (suspect ? sock.verify() : sock.nudge());
    if (!homeRef.current) {
      startedRef.current = false;
      initPeer();
    } else {
      poke(homeRef.current);
    }
    if (targetRef.current) {
      if (!dialRef.current) connectToRemote(targetRef.current);
      else poke(dialRef.current);
    }
    sendPresence(false);
  }, [initPeer, connectToRemote, sendPresence]);
  ensureAliveRef.current = ensureAlive;

  useEffect(() => {
    const wake = (ev) => {
      if (document.visibilityState === 'hidden') return;
      ensureAliveRef.current?.(ev?.type !== 'focus');
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    const id = setInterval(() => ensureAliveRef.current?.(), WATCHDOG_MS);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      clearInterval(id);
    };
  }, []);

  // QR for the join URL once we have our own id.
  useEffect(() => {
    if (!myPeerId) { setQrDataUrl(''); return; }
    const url = buildJoinUrl(page, shortFromPeerId(myPeerId), inviteRole);
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [myPeerId, page, inviteRole]);

  // Opened via a join URL (scanned the other phone's QR): prefill the remote
  // code, notify the page, go online, and dial once we are.
  useEffect(() => {
    const join = parseJoinFromHash(page);
    if (!join) return;
    setRemoteShortCode(join);
    onJoinRef.current?.(join);
    autoConnectOnReadyRef.current = true;
    initPeer();
  }, [page, initPeer]);

  useEffect(() => {
    if (peerStatus !== 'online') return;
    if (!autoConnectOnReadyRef.current) return;
    autoConnectOnReadyRef.current = false;
    connectToRemote();
  }, [peerStatus, connectToRemote]);

  // Tear down on unmount. StrictMode runs mount → cleanup → mount on the same
  // instance; the refs survive, so the mount half clears the intentional flag
  // and the watchdog rebuilds the sockets on its next tick.
  useEffect(() => {
    intentionalRef.current = false;
    // Remount after a teardown (StrictMode in dev): rebuild straight away
    // rather than on the next watchdog tick. The short delay lets the torn-down
    // socket's close reach the relay first, so it cannot displace the new one.
    let revive;
    if (everStartedRef.current) revive = setTimeout(() => ensureAliveRef.current?.(), 300);
    return () => {
      clearTimeout(revive);
      intentionalRef.current = true;
      if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
      const home = homeRef.current;
      const dial = dialRef.current;
      homeRef.current = null;
      dialRef.current = null;
      homeReadyRef.current = false;
      connRef.current = null;
      startedRef.current = false;
      dial?.stop();
      home?.stop();
    };
  }, []);

  const sendData = useCallback((msg) => {
    connRef.current?.sock.send(msg);
  }, []);

  // Flush a { motion, orientation, gps } buffer as one frame (fewer relay
  // messages than three); the receiving hook splits it back out.
  const sendBatch = useCallback((buf) => {
    const c = connRef.current;
    if (!c) return;
    const frame = { type: 'batch' };
    let any = false;
    for (const k of ['motion', 'orientation', 'gps']) {
      if (buf[k]?.length) { frame[k] = buf[k]; any = true; }
    }
    if (any) c.sock.send(frame);
  }, []);

  const isOpen = useCallback(() => !!connRef.current, []);

  // Presence check for the coach's roster: ask the relay whether that rower's
  // room has its host attached. Plain GET, always resolves.
  const probe = useCallback(async (peerId) => {
    if (!peerId) return { online: false };
    const id = peerId.startsWith(PEER_ID_PREFIX) ? peerId : PEER_ID_PREFIX + peerId;
    const p = await fetchPresence(id);
    return p ? { online: !!p.online, name: p.name || '', busy: !!p.busy } : { online: false };
  }, []);

  // Drop the live link without going offline ourselves, so the user can pair
  // afresh. Stops any redial; a guest attached to our room is told to leave.
  const disconnect = useCallback(() => {
    targetRef.current = null;
    const dial = dialRef.current;
    dialRef.current = null;
    dial?.stop();
    const home = homeRef.current;
    if (connRef.current && connRef.current.sock === home) home.send('{"_relay":"kick"}');
    const had = !!connRef.current;
    peerDetached();
    if (!had) onCloseRef.current?.();
    refreshStatus();
  }, [peerDetached, refreshStatus]);

  const sendPing = useCallback(() => {
    const c = connRef.current;
    if (!c) return;
    const t = Math.random().toString(36).slice(2);
    pingStartRef.current = { t, start: performance.now() };
    c.sock.send({ type: 'ping', t });
  }, []);

  return {
    myPeerId,
    shortCode: myPeerId ? shortFromPeerId(myPeerId) : '',
    joinUrl: myPeerId ? buildJoinUrl(page, shortFromPeerId(myPeerId), inviteRole) : '',
    hasPeer: !!myPeerId,
    peerStatus,
    peerError,
    qrDataUrl,
    lastPing,
    remoteShortCode,
    setRemoteShortCode,
    connectedPeerId,
    initPeer,
    connectToRemote,
    disconnect,
    probe,
    sendPing,
    sendData,
    sendBatch,
    isOpen,
  };
}
