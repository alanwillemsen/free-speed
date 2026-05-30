import { useRef, useCallback, useEffect } from 'react';

// Screen Wake Lock that survives tab visibility changes.
//
// The platform automatically *releases* a screen wake lock whenever the page
// becomes hidden — screen off, tab switch, app backgrounded. The original code
// requested the lock once at capture start and never got it back, so the first
// time the phone blinked off (e.g. while being handed to a rower) the screen
// was free to sleep for good. Here we remember that the caller still *wants*
// the lock and re-request it every time the page returns to the foreground.
//
// `request()` marks intent + acquires; `release()` clears intent + drops it.
export function useWakeLock() {
  const lockRef = useRef(null);
  const wantRef = useRef(false);

  const acquire = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (lockRef.current) return; // already held
    if (document.visibilityState !== 'visible') return; // request would reject
    try {
      const lock = await navigator.wakeLock.request('screen');
      lockRef.current = lock;
      // The platform fires 'release' when it drops the lock on hide; clear our
      // handle so the next visibility change knows to ask for a fresh one.
      lock.addEventListener('release', () => {
        if (lockRef.current === lock) lockRef.current = null;
      });
    } catch { /* unsupported or denied — non-critical */ }
  }, []);

  const request = useCallback(() => {
    wantRef.current = true;
    return acquire();
  }, [acquire]);

  const release = useCallback(() => {
    wantRef.current = false;
    const lock = lockRef.current;
    lockRef.current = null;
    lock?.release?.().catch(() => {});
  }, []);

  // Re-acquire whenever we come back to the foreground and still want the lock.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wantRef.current) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquire]);

  // Drop the lock if the component unmounts mid-hold.
  useEffect(() => () => {
    wantRef.current = false;
    lockRef.current?.release?.().catch(() => {});
    lockRef.current = null;
  }, []);

  return { request, release };
}
