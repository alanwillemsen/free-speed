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

function makeShortCode() {
  // 5-digit numeric code: easy to read out loud, easy to type.
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

function buildJoinUrl(page, shortCode) {
  return `${window.location.origin}${window.location.pathname}#${page}?join=${shortCode}`;
}

export function usePeerLink({ page, onData, onOpen, onClose, onJoin }) {
  const [myPeerId, setMyPeerId] = useState('');
  const [remoteShortCode, setRemoteShortCode] = useState('');
  const [peerStatus, setPeerStatus] = useState('idle'); // idle | initializing | online | connecting | connected | error
  const [peerError, setPeerError] = useState('');
  const [lastPing, setLastPing] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');

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

  // Keep latest callbacks reachable from stable connection handlers without
  // rebuilding the peer each render.
  const onDataRef = useRef(onData);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onJoinRef = useRef(onJoin);
  onDataRef.current = onData;
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;
  onJoinRef.current = onJoin;

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
    if (peerRef.current) return;
    setPeerStatus('initializing');
    setPeerError('');

    let attempts = 0;
    const tryClaim = () => {
      attempts += 1;
      const shortCode = makeShortCode();
      const desiredId = PEER_ID_PREFIX + shortCode;
      const peer = new Peer(desiredId);
      let opened = false;

      peer.on('open', (id) => {
        opened = true;
        peerRef.current = peer;
        setMyPeerId(id);
        setPeerStatus('online');
      });
      peer.on('connection', (conn) => {
        setupConnHandlers(conn);
        setPeerStatus('connecting');
      });
      peer.on('error', (err) => {
        if (!opened && err?.type === 'unavailable-id' && attempts < PEER_ID_RETRIES) {
          // Collision on the public broker — pick a new code and retry.
          try { peer.destroy(); } catch { /* ignore */ }
          tryClaim();
          return;
        }
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
    const raw = (overrideCode ?? remoteShortCode).trim();
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
    initPeer,
    connectToRemote,
    sendPing,
    sendData,
    sendBatch,
    isOpen,
  };
}
