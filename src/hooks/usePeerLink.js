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

function buildJoinUrl(page, shortCode) {
  return `${window.location.origin}${window.location.pathname}#${page}?join=${shortCode}`;
}

export function usePeerLink({ page, onData, onOpen, onClose, onJoin, fixedId, getPresence }) {
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
      setConnectedPeerId(conn.peer);
      setPeerStatus('connected');
      onOpenRef.current?.(conn);
    });
    conn.on('data', (msg) => {
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
        if (err?.type === 'peer-unavailable') return;

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

        startedRef.current = false; // allow a manual re-enable
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
  }, [remoteShortCode, setupConnHandlers]);

  // Keep a stable reference for the reconnect timer to call without a dep cycle.
  connectFnRef.current = connectToRemote;

  // Generate a QR for the join URL once we have our own peer id.
  useEffect(() => {
    if (!myPeerId) { setQrDataUrl(''); return; }
    const url = buildJoinUrl(page, shortFromPeerId(myPeerId));
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [myPeerId, page]);

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
  useEffect(() => () => {
    intentionalRef.current = true;
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (brokerRetryTimerRef.current) { clearTimeout(brokerRetryTimerRef.current); brokerRetryTimerRef.current = null; }
    connRef.current?.close?.();
    peerRef.current?.destroy?.();
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
