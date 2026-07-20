import { useState, useRef, useEffect, useCallback } from 'react';
import Peer from 'peerjs';
import QRCode from 'qrcode';

// Shared WebRTC peer-link plumbing for the dual-phone capture pages (Oar Capture
// and Live Capture). Owns the peerjs connection lifecycle only: claiming a short
// code on the public broker, QR / join-URL pairing, and a reliable data channel.
// Message *semantics* belong to each page — pass an `onData(msg)` handler. The
// hook handles ping/pong round-trip timing internally.

const PEER_ID_PREFIX = 'freespeed-';
const PEER_ID_RETRIES = 5;
// PeerJS error types that mean "couldn't reach / lost the signalling server" —
// transient and not fatal (the data channel is peer-to-peer). We retry these
// quietly instead of dead-ending in 'error', so a rower already on the water
// reconnects on its own once signalling recovers.
const TRANSIENT_BROKER_ERRORS = new Set(['network', 'socket-error', 'socket-closed', 'server-error']);
// Errors that no amount of retrying can fix (platform / config, not weather).
// Everything else is eligible for the self-healing watchdog below.
const PERMANENT_ERRORS = new Set(['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable']);
// Watchdog cadence, and the tick-to-tick gap that means "this page was just
// suspended long enough that the broker may have reaped us" (brokers reap at
// ~60 s of missed heartbeats; anything over this is already suspicious).
const WATCHDOG_MS = 10000;
const SUSPEND_GAP_MS = 30000;
// Data-channel heartbeat. WebRTC gives no timely close event when the other
// end freezes or drops off — the connection just goes silent while both sides
// still report open. Each side pings over the link; a side that has heard
// nothing (pings, pongs, or real data all count) for CONN_STALE_MS declares
// the channel dead and closes it, which feeds the normal reconnect paths.
const HEARTBEAT_MS = 5000;
const CONN_STALE_MS = 15000;
// How long we give an initiated dial to reach 'open' before treating it as
// failed and redialing. PeerJS has no connect timeout of its own, and a dial to
// a peer that froze while still ghost-registered on the broker never gets a
// 'peer-unavailable' either — the broker relays the offer to a page that will
// never answer, so the attempt hangs forever with no event. Without this, the
// coach's redial after the rower's freeze stalls on a dead pending connection
// and never recovers even after the rower re-registers.
const DIAL_TIMEOUT_MS = 12000;

function makeShortCode() {
  // 5-digit numeric code: easy to read out loud, easy to type.
  return String(Math.floor(10000 + Math.random() * 90000));
}

// In dev we proxy a local PeerJS signalling server at the same origin (see
// vite.config.js), so phones pair over the LAN with no public broker and no
// internet — and no Cloudflare rate-limit. Production falls back to the PeerJS
// cloud default unless VITE_PEER_HOST is set.
function peerOptions() {
  const env = import.meta.env;
  const host = env?.VITE_PEER_HOST;
  if (host) {
    const secure = env.VITE_PEER_SECURE != null
      ? env.VITE_PEER_SECURE === 'true'
      : window.location.protocol === 'https:';
    return {
      host,
      port: Number(env.VITE_PEER_PORT) || (secure ? 443 : 80),
      path: env.VITE_PEER_PATH || '/',
      secure,
      key: 'peerjs',
    };
  }
  if (env?.DEV) {
    const secure = window.location.protocol === 'https:';
    return {
      host: window.location.hostname,
      port: Number(window.location.port) || (secure ? 443 : 80),
      path: '/',
      secure,
      key: 'peerjs',
    };
  }
  return undefined; // production default: PeerJS cloud
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
  // `as` tells the opener which role the sender is inviting them into (the
  // page's onJoin reads it) — a coach's invite makes the opener a rower and
  // vice versa. Omitted for pages without roles (oar).
  return inviteRole ? `${base}&as=${inviteRole}` : base;
}

export function usePeerLink({ page, onData, onOpen, onClose, onJoin, fixedId, getPresence, inviteRole }) {
  const [myPeerId, setMyPeerId] = useState('');
  const [remoteShortCode, setRemoteShortCode] = useState('');
  const [peerStatus, setPeerStatus] = useState('idle'); // idle | initializing | online | connecting | connected | error
  const [peerError, setPeerError] = useState('');
  const [lastPing, setLastPing] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [connectedPeerId, setConnectedPeerId] = useState(''); // remote id of the live data channel

  const peerRef = useRef(null);
  const connRef = useRef(null);
  const pingStartRef = useRef(null);
  const autoConnectOnReadyRef = useRef(false);

  // Auto-reconnect bookkeeping. A live capture must survive a backgrounded tab
  // or a network blip during the hand-off into the boat; the original code just
  // went 'online' on drop and waited for a human to re-enter the code.
  const lastTargetRef = useRef(null);   // id we initiated to (only the initiator reconnects the data channel)
  const intentionalRef = useRef(false); // true while tearing down on purpose — don't reconnect
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const connectFnRef = useRef(null);    // breaks the setupConnHandlers ↔ connectToRemote cycle
  // Broker-level (signalling-server) reconnect: recreate the peer with backoff
  // when we can't reach the server at all (vs. reconnectTimerRef, which redials
  // the data channel to a peer once our own peer is online).
  const brokerRetryTimerRef = useRef(null);
  const brokerAttemptsRef = useRef(0);
  // Guards against a second initPeer() spawning a competing peer for the same id
  // while the first is still mid-handshake (e.g. React StrictMode double-invoking
  // an auto-enable effect, or a manual tap racing it). Reset only on a fatal error.
  const startedRef = useRef(false);
  // Self-healing bookkeeping: whether the link was ever enabled this session
  // (the watchdog only revives what the user turned on), whether we hit an
  // unfixable error (stop trying), and a stable handle on ensureAlive so
  // timers and peer callbacks created in older closures can reach the
  // current revive logic.
  const everStartedRef = useRef(false);
  const permanentErrorRef = useRef(false);
  const ensureAliveRef = useRef(null);
  const lastAliveTickRef = useRef(Date.now());
  // Heartbeat over the live data channel (see HEARTBEAT_MS above).
  const heartbeatTimerRef = useRef(null);
  const lastHeardRef = useRef(0);
  // Watches an initiated dial that hasn't reached 'open' yet (see DIAL_TIMEOUT_MS).
  const dialTimeoutRef = useRef(null);

  // Keep latest callbacks reachable from stable connection handlers without
  // rebuilding the peer each render.
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

  // Schedule a data-channel reconnect with capped exponential backoff. Only the
  // side that originally dialed (lastTargetRef set) redials; the side that was
  // dialed just waits for peer.on('connection') to fire again.
  const scheduleReconnect = useCallback(() => {
    if (intentionalRef.current) return;
    if (!lastTargetRef.current) return;
    if (reconnectTimerRef.current) return;
    if (connRef.current?.open) return;
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(1000 * 2 ** attempt, 15000); // 1s, 2s, 4s … cap 15s
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptsRef.current = attempt + 1;
      const peer = peerRef.current;
      // Make sure the broker link is alive before redialing the peer.
      if (peer && peer.disconnected && !peer.destroyed) {
        try { peer.reconnect(); } catch { /* ignore */ }
      }
      connectFnRef.current?.(lastTargetRef.current);
    }, delay);
  }, []);

  const setupConnHandlers = useCallback((conn) => {
    connRef.current = conn;
    conn.on('open', () => {
      reconnectAttemptsRef.current = 0; // healthy link — reset backoff
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (dialTimeoutRef.current) { clearTimeout(dialTimeoutRef.current); dialTimeoutRef.current = null; }
      setConnectedPeerId(conn.peer);
      setPeerStatus('connected');
      // Start the liveness heartbeat for this connection. The interval both
      // pings and checks staleness; it self-cancels once it's no longer the
      // active connection (a zombie's own close event may never fire).
      lastHeardRef.current = Date.now();
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = setInterval(() => {
        if (connRef.current !== conn || !conn.open) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
          return;
        }
        if (Date.now() - lastHeardRef.current > CONN_STALE_MS) {
          // Silent for too long: the other end froze or vanished without a
          // close event. Close locally — the close handler runs the normal
          // teardown and, on the dialing side, the redial loop.
          try { conn.close(); } catch { /* ignore */ }
          return;
        }
        try { conn.send({ type: 'ping', t: 'hb' }); } catch { /* ignore */ }
      }, HEARTBEAT_MS);
      onOpenRef.current?.(conn);
    });
    conn.on('data', (msg) => {
      lastHeardRef.current = Date.now();
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') {
        try { conn.send({ type: 'pong', t: msg.t }); } catch { /* ignore */ }
        return;
      }
      if (msg.type === 'pong') {
        if (pingStartRef.current && msg.t === pingStartRef.current.t) {
          setLastPing(Math.round(performance.now() - pingStartRef.current.start));
          pingStartRef.current = null;
        }
        return;
      }
      onDataRef.current?.(msg);
    });
    conn.on('close', () => {
      if (dialTimeoutRef.current) { clearTimeout(dialTimeoutRef.current); dialTimeoutRef.current = null; }
      connRef.current = null;
      setConnectedPeerId('');
      onCloseRef.current?.();
      if (!intentionalRef.current && lastTargetRef.current) {
        setPeerStatus('connecting'); // we'll keep retrying
        scheduleReconnect();
      } else {
        setPeerStatus('online');
      }
    });
    conn.on('error', (err) => {
      if (dialTimeoutRef.current) { clearTimeout(dialTimeoutRef.current); dialTimeoutRef.current = null; }
      setPeerError(String(err?.message ?? err));
      // A transient data-channel error on an initiated link → retry rather than
      // dead-end in 'error'.
      if (!intentionalRef.current && lastTargetRef.current) scheduleReconnect();
      else setPeerStatus('error');
    });
  }, [scheduleReconnect]);

  const initPeer = useCallback(() => {
    if (peerRef.current || startedRef.current) return;
    startedRef.current = true;
    everStartedRef.current = true;
    intentionalRef.current = false; // enabling the link is explicit intent to be online
    // A fresh claim sequence supersedes any broker retry an older, dead
    // generation scheduled — let it fire and two peers race for the same id.
    if (brokerRetryTimerRef.current) { clearTimeout(brokerRetryTimerRef.current); brokerRetryTimerRef.current = null; }
    setPeerStatus('initializing');
    setPeerError('');

    // A stable id (from pairStore) lets a coach reconnect on a later day; without
    // one we fall back to a throwaway random code per session.
    const stableId = fixedIdRef.current;
    let attempts = 0;
    let fellBack = false; // true once we give up on the stable id this session

    // Recreate the peer after a backoff when the signalling server is
    // unreachable. Hoisted so tryClaim's error handler can reach it.
    function scheduleBrokerRetry() {
      if (intentionalRef.current) return;
      if (brokerRetryTimerRef.current) return;
      const n = brokerAttemptsRef.current++;
      const delay = Math.min(2000 * 2 ** n, 20000); // 2s, 4s, 8s … cap 20s
      brokerRetryTimerRef.current = setTimeout(() => {
        brokerRetryTimerRef.current = null;
        if (!intentionalRef.current && !peerRef.current) tryClaim();
      }, delay);
    }

    const tryClaim = () => {
      attempts += 1;
      const useStable = !!stableId && !fellBack;
      const desiredId = useStable ? stableId : PEER_ID_PREFIX + makeShortCode();
      const peer = new Peer(desiredId, peerOptions());
      let opened = false;

      peer.on('open', (id) => {
        opened = true;
        peerRef.current = peer;
        // Healthy again — clear any pending broker retry/backoff.
        brokerAttemptsRef.current = 0;
        if (brokerRetryTimerRef.current) { clearTimeout(brokerRetryTimerRef.current); brokerRetryTimerRef.current = null; }
        setMyPeerId(id);
        setPeerStatus('online');
        // If we're the dialing side and the data channel didn't survive
        // whatever killed the old peer, pick the redial loop back up.
        if (lastTargetRef.current && !connRef.current?.open) scheduleReconnect();
      });
      peer.on('connection', (conn) => {
        // Presence probe (see `probe`): answer with our advertised name + busy
        // flag and stay out of the main link's state machine entirely.
        if (conn.metadata?.probe) {
          conn.on('data', (msg) => {
            if (msg?.type === 'presence?') {
              const p = getPresenceRef.current?.() || {};
              try { conn.send({ type: 'presence', name: p.name || '', busy: !!p.busy }); } catch { /* ignore */ }
            }
          });
          return;
        }
        setupConnHandlers(conn);
        setPeerStatus('connecting');
      });
      peer.on('error', (err) => {
        if (opened && err?.type === 'unavailable-id') {
          // Re-registering after a freeze/sleep while the broker still holds
          // our previous session as a ghost: reconnect() gets rejected even
          // though it's our own id. Drop this peer and let the watchdog
          // re-claim once the ghost expires (seconds) — never dead-end here,
          // a rower mid-row can't reach the phone to fix it.
          try { peer.destroy(); } catch { /* ignore */ }
          if (peerRef.current === peer) peerRef.current = null;
          startedRef.current = false;
          setPeerStatus('reconnecting');
          setTimeout(() => ensureAliveRef.current?.(), 3000);
          return;
        }
        if (!opened && err?.type === 'unavailable-id') {
          // Id already held on the broker — usually our own just-closed/reloaded
          // tab still lingering (the broker frees it within a few seconds). Retry
          // the same stable id a few times; if it stays stuck, fall back to a
          // throwaway random id so the link still works this session instead of
          // dead-ending. A random-id collision just picks another id.
          try { peer.destroy(); } catch { /* ignore */ }
          if (useStable && attempts < PEER_ID_RETRIES) {
            setTimeout(tryClaim, 800);
          } else if (useStable) {
            fellBack = true;
            attempts = 0;
            tryClaim();
          } else if (attempts < PEER_ID_RETRIES) {
            tryClaim();
          } else {
            startedRef.current = false; // allow a manual re-enable
            setPeerError(String(err?.message ?? err));
            setPeerStatus('error');
          }
          return;
        }
        // A failed dial to an offline/unknown peer (probe or a stale reconnect
        // target) surfaces here as 'peer-unavailable'. That's not fatal to our
        // own peer — swallow it so presence probing and reconnects can continue.
        // But if it was our *initiated* dial that failed (the error names our
        // target), keep redialing with backoff instead of hanging in
        // 'Connecting…' forever — a coach often dials before the rower's phone
        // has (re)registered with the broker, and this way the link completes
        // by itself the moment the rower comes online.
        if (err?.type === 'peer-unavailable') {
          const target = lastTargetRef.current;
          if (target && !connRef.current?.open && String(err?.message ?? '').includes(target)) {
            scheduleReconnect();
          }
          return;
        }

        // Lost / never reached the signalling server. Not an error to surface —
        // keep the link alive and retry in the background. If we were already
        // registered, just rebuild the socket; otherwise recreate the peer.
        if (TRANSIENT_BROKER_ERRORS.has(err?.type)) {
          if (opened && !peer.destroyed) {
            try { peer.reconnect(); } catch { /* ignore */ }
            setPeerStatus((s) => (s === 'connected' ? s : 'reconnecting'));
          } else {
            try { peer.destroy(); } catch { /* ignore */ }
            setPeerStatus('reconnecting');
            scheduleBrokerRetry();
          }
          return;
        }

        // Anything else is fatal for this peer object. Truly permanent causes
        // (incompatible browser, bad config) stop the watchdog; the rest stay
        // eligible for an automatic rebuild on its next tick.
        if (PERMANENT_ERRORS.has(err?.type)) permanentErrorRef.current = true;
        startedRef.current = false; // allow a re-enable (manual or watchdog)
        setPeerError(String(err?.message ?? err));
        setPeerStatus('error');
      });
      peer.on('disconnected', () => {
        // Lost the broker link (commonly when the tab was backgrounded). Rejoin
        // it with the same id so we can re-establish / re-accept data channels.
        // Both sides do this; only the initiator additionally redials the conn.
        if (!intentionalRef.current && !peer.destroyed) {
          try { peer.reconnect(); } catch { /* ignore */ }
        }
        setPeerStatus((s) => (s === 'connected' ? 'connecting' : s));
        if (lastTargetRef.current) scheduleReconnect();
      });
    };
    tryClaim();
  }, [setupConnHandlers, scheduleReconnect]);

  // Revive the link after anything that silently killed it: reconnect a
  // disconnected peer, rebuild a destroyed or dead-ended one. Idempotent and
  // cheap, so it's safe to call on every wake signal / watchdog tick — it
  // no-ops while healthy, while a claim is already in flight (startedRef set,
  // peer pending), and when the link was never enabled, was torn down on
  // purpose, or died of something retrying can't fix.
  const ensureAlive = useCallback(() => {
    const gap = Date.now() - lastAliveTickRef.current;
    lastAliveTickRef.current = Date.now();
    if (intentionalRef.current || !everStartedRef.current || permanentErrorRef.current) return;
    const peer = peerRef.current;
    if (peer) {
      if (peer.destroyed) {
        peerRef.current = null;
        startedRef.current = false;
        initPeer();
      } else if (peer.disconnected) {
        try { peer.reconnect(); } catch { /* ignore */ }
      } else if (gap > SUSPEND_GAP_MS) {
        // The page just resumed from a long suspension (frozen tab, locked
        // phone). The broker has likely reaped our registration, but the
        // socket died silently — the client still believes it's open (a
        // zombie), so peer.disconnected never goes true and no error ever
        // fires. Force a reconnect cycle: disconnect() drops only the broker
        // socket (existing data connections are untouched) and reconnect()
        // re-registers the same id. On a healthy link this is a harmless blip.
        try { peer.disconnect(); } catch { /* ignore */ }
        try { peer.reconnect(); } catch { /* ignore */ }
      }
      return;
    }
    if (!startedRef.current) initPeer();
  }, [initPeer]);
  ensureAliveRef.current = ensureAlive;

  // Self-healing loop. A rower's phone gets frozen by the mobile browser (screen
  // off, app backgrounded, tab swapped), the broker reaps its registration, and
  // nobody can touch the screen mid-row — so the link has to come back entirely
  // on its own. Wake-style events catch the moment the platform lets the page
  // run again; the slow interval catches dead-ends with no event (a fatal error
  // while foregrounded, a rejected re-registration).
  useEffect(() => {
    const wake = () => { if (document.visibilityState !== 'hidden') ensureAliveRef.current?.(); };
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

  const connectToRemote = useCallback((overrideCode) => {
    if (!peerRef.current) return;
    // Codes are always lowercase (numeric, or base36 from mintId); lowercase the
    // input so a phone that auto-capitalised the typed letters still matches.
    const raw = (overrideCode ?? remoteShortCode).trim().toLowerCase();
    if (!raw) return;
    // Accept either the bare short code ("12345") or the full peer id
    // ("freespeed-12345") so the typed and scanned paths both work.
    const targetId = raw.startsWith(PEER_ID_PREFIX) ? raw : PEER_ID_PREFIX + raw;
    // Remember the target so a dropped data channel auto-redials it.
    lastTargetRef.current = targetId;
    intentionalRef.current = false;
    setPeerStatus('connecting');
    const conn = peerRef.current.connect(targetId, { reliable: true });
    setupConnHandlers(conn);
    // Guard against a dial that never resolves (frozen ghost peer, dropped
    // signalling mid-handshake): if it hasn't opened in time, tear it down and
    // redial. Closing a not-yet-open conn doesn't emit 'close' (PeerJS bails
    // early), so we drive the reconnect path ourselves.
    if (dialTimeoutRef.current) { clearTimeout(dialTimeoutRef.current); dialTimeoutRef.current = null; }
    dialTimeoutRef.current = setTimeout(() => {
      dialTimeoutRef.current = null;
      if (connRef.current !== conn || conn.open) return;
      try { conn.close(); } catch { /* ignore */ }
      connRef.current = null;
      if (!intentionalRef.current && lastTargetRef.current) scheduleReconnect();
    }, DIAL_TIMEOUT_MS);
  }, [remoteShortCode, setupConnHandlers, scheduleReconnect]);

  // Keep a stable reference for the reconnect timer to call without a dep cycle.
  connectFnRef.current = connectToRemote;

  // Generate a QR for the join URL once we have our own peer id.
  useEffect(() => {
    if (!myPeerId) { setQrDataUrl(''); return; }
    const url = buildJoinUrl(page, shortFromPeerId(myPeerId), inviteRole);
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [myPeerId, page, inviteRole]);

  // Opened via a join URL (e.g. scanned the other phone's QR): prefill the
  // remote code, notify the page, init the peer, and auto-connect once online.
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

  // Tear down peerjs on unmount — mark intentional so no reconnect is scheduled.
  // The mount half clears the flag again: React StrictMode runs mount →
  // cleanup → mount on the same instance, and the ref survives it — without
  // the reset, every auto-reconnect path stays permanently disabled in dev
  // (a rower's phone would never recover from a dropped link without a
  // manual page refresh).
  useEffect(() => {
    intentionalRef.current = false;
    return () => {
      intentionalRef.current = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (brokerRetryTimerRef.current) { clearTimeout(brokerRetryTimerRef.current); brokerRetryTimerRef.current = null; }
      if (heartbeatTimerRef.current) { clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
      if (dialTimeoutRef.current) { clearTimeout(dialTimeoutRef.current); dialTimeoutRef.current = null; }
      connRef.current?.close?.();
      peerRef.current?.destroy?.();
    };
  }, []);

  const sendData = useCallback((msg) => {
    const conn = connRef.current;
    if (!conn || !conn.open) return;
    try { conn.send(msg); } catch { /* ignore */ }
  }, []);

  // Flush a { motion, orientation, gps } buffer of arrays. No-op when no peer;
  // the caller clears its buffer regardless.
  const sendBatch = useCallback((buf) => {
    const conn = connRef.current;
    if (!conn || !conn.open) return;
    if (buf.motion?.length) { try { conn.send({ type: 'motion', samples: buf.motion }); } catch { /* ignore */ } }
    if (buf.orientation?.length) { try { conn.send({ type: 'orientation', samples: buf.orientation }); } catch { /* ignore */ } }
    if (buf.gps?.length) { try { conn.send({ type: 'gps', samples: buf.gps }); } catch { /* ignore */ } }
  }, []);

  const isOpen = useCallback(() => !!connRef.current?.open, []);

  // One-shot presence check: open a throwaway data channel to `peerId`, ask for
  // its presence, and resolve { online, name, busy }. Used by a coach to light up
  // which saved rowers are currently on. Tagged metadata.probe so the remote
  // answers without treating it as the real coach link. Always resolves.
  const probe = useCallback((peerId, timeoutMs = 4000) => new Promise((resolve) => {
    const peer = peerRef.current;
    if (!peer || peer.destroyed || !peerId) { resolve({ online: false }); return; }
    const targetId = peerId.startsWith(PEER_ID_PREFIX) ? peerId : PEER_ID_PREFIX + peerId;
    let conn;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn?.close(); } catch { /* ignore */ }
      resolve(res);
    };
    const timer = setTimeout(() => finish({ online: false }), timeoutMs);
    try {
      conn = peer.connect(targetId, { reliable: true, metadata: { probe: true } });
    } catch { finish({ online: false }); return; }
    // A successful open already proves the peer is online; the presence reply just
    // enriches it with name/busy. So on open we ask, then fall back to a bare
    // "online" if the (small) reply doesn't arrive shortly.
    conn.on('open', () => {
      try { conn.send({ type: 'presence?' }); } catch { /* ignore */ }
      setTimeout(() => finish({ online: true, name: '', busy: false }), 1200);
    });
    conn.on('data', (msg) => {
      if (msg?.type === 'presence') finish({ online: true, name: msg.name, busy: !!msg.busy });
    });
    conn.on('error', () => finish({ online: false }));
  }), []);

  // Intentionally drop the live data channel without tearing down our own peer,
  // so the user can pair afresh. Clearing lastTargetRef stops the auto-redial;
  // the conn's 'close' handler then settles us back to 'online' and fires onClose.
  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (dialTimeoutRef.current) { clearTimeout(dialTimeoutRef.current); dialTimeoutRef.current = null; }
    lastTargetRef.current = null;
    reconnectAttemptsRef.current = 0;
    const conn = connRef.current;
    connRef.current = null;
    setConnectedPeerId('');
    setPeerStatus('online');
    try { conn?.close(); } catch { /* ignore */ }
    onCloseRef.current?.();
  }, []);

  const sendPing = useCallback(() => {
    const conn = connRef.current;
    if (!conn || !conn.open) return;
    const t = Math.random().toString(36).slice(2);
    pingStartRef.current = { t, start: performance.now() };
    try { conn.send({ type: 'ping', t }); } catch { /* ignore */ }
  }, []);

  return {
    myPeerId,
    shortCode: myPeerId ? shortFromPeerId(myPeerId) : '',
    // The same join URL the QR encodes — for share-sheet / copy-link pairing.
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
