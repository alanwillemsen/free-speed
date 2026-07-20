import { useState, useEffect, useRef } from 'react';
import AppShell from './AppShell';
import * as sessionLibrary from '../utils/sessionLibrary';

// Past stroke-capture sessions, auto-saved when a capture stops. Each row can
// be reopened for review, shared/exported as the same JSON file the old
// auto-download produced, renamed, or deleted. A downloaded file from another
// device can be pulled back in with Import, which opens it in review — the
// review page saves it to the library automatically. The list renders from
// lightweight summary records — the multi-MB recording blobs are only touched
// by the per-row actions.

const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const fmtDuration = (ms) => {
  if (!(ms > 0)) return '0:00';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const fmtBytes = (n) => {
  if (!(n > 0)) return '0 KB';
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};

// Same stamp convention as the live page's downloadRecording, so on-demand
// downloads are named exactly like the old auto-downloads.
const fileFor = async (id) => {
  const blob = await sessionLibrary.getRecordingBlob(id);
  if (!blob) return null;
  const stamp = String(id).replace(/[:.]/g, '-');
  return new File([blob], `free-speed-${stamp}.json`, { type: 'application/json' });
};

function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [estimate, setEstimate] = useState(null);
  const [menuFor, setMenuFor] = useState(null); // id of the row whose ⋮ menu is open
  const importInputRef = useRef(null);

  const refresh = () => {
    sessionLibrary.listSessions().then(setSessions);
    sessionLibrary.estimateUsage().then(setEstimate);
  };
  useEffect(refresh, []);

  const openSession = async (id, meta) => {
    const blob = await sessionLibrary.getRecordingBlob(id);
    if (!blob) { alert('Could not load this session.'); return; }
    // Hand the unparsed blob to the review instance; it runs the same deferred
    // "Replaying…" load path as a picked file. The meta rides along so the
    // review title bar can show this session's name/datetime.
    sessionLibrary.putOpen(blob, meta);
    window.location.hash = '#strokes';
  };

  // Import a stroke-data file downloaded from another device. It's handed to the
  // review instance exactly like opening a saved session — the review page saves
  // whatever it loads into the library, so the imported row appears here on
  // return. No pipeline runs on this page, so the summary is computed there.
  const importFile = (file) => {
    if (!file) return;
    sessionLibrary.putOpen(file);
    window.location.hash = '#strokes';
  };

  const exportSession = async (id) => {
    const file = await fileFor(id);
    if (!file) { alert('Could not load this session.'); return; }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Falls back to download if sharing fails for any reason other than the
  // user dismissing the share sheet.
  const shareSession = async (id) => {
    const file = await fileFor(id);
    if (!file) { alert('Could not load this session.'); return; }
    if (!navigator.canShare?.({ files: [file] })) { exportSession(id); return; }
    try {
      await navigator.share({ files: [file], title: 'Free Speed session' });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      exportSession(id);
    }
  };

  const renameSession = async (s) => {
    const next = window.prompt('Name this session', s.name || '');
    if (next == null) return; // cancelled
    try { await sessionLibrary.renameSession(s.id, next); } catch { /* refresh shows the truth */ }
    refresh();
  };

  const removeSession = async (id) => {
    if (!window.confirm('Delete this session? Its stroke data will be gone unless you exported it.')) return;
    try { await sessionLibrary.deleteSession(id); } catch { /* refresh shows the truth */ }
    refresh();
  };

  const canShare = typeof navigator !== 'undefined' && !!navigator.canShare;

  const importAction = (
    <>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ''; // allow re-importing the same file
          importFile(f);
        }}
      />
      <button className="app-bar-btn app-bar-text-btn" onClick={() => importInputRef.current?.click()} title="Import stroke data">
        Import
      </button>
    </>
  );

  return (
    <AppShell page="sessions" title="Sessions" actions={importAction}>
      <div className="sessions-page">
        {sessions.length === 0 ? (
          <p className="sessions-empty">
            No saved sessions yet. Finish a row on{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = ''; }}>
              Live Stroke Capture
            </a>{' '}
            and it will be saved here automatically, or{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); importInputRef.current?.click(); }}>
              import
            </a>{' '}
            a file.
          </p>
        ) : (
          <ul className="sessions-list">
            {sessions.map((s) => (
              <li key={s.id} className="sessions-row">
                <button
                  className="sessions-row-main"
                  onClick={() => openSession(s.id, { name: s.name, startedAt: s.startedAt })}
                >
                  <span className="sessions-row-title">
                    {s.name || fmtWhen(s.startedAt)}
                    {s.kind === 'coach' && <span className="sessions-tag">coach</span>}
                  </span>
                  <span className="sessions-row-meta">
                    {s.name && <>{fmtWhen(s.startedAt)}{' · '}</>}
                    {s.strokeCount} strokes · {Math.round(s.distance || 0)} m
                    {' · '}{fmtDuration(s.durationMs)} · {fmtBytes(s.bytes)}
                  </span>
                </button>
                <div className="va-actions-menu">
                  <button
                    className="app-bar-btn"
                    onClick={() => setMenuFor(menuFor === s.id ? null : s.id)}
                    aria-label="Session actions"
                    aria-expanded={menuFor === s.id}
                  >⋮</button>
                  {menuFor === s.id && (
                    <>
                      <div className="va-menu-scrim" onClick={() => setMenuFor(null)} />
                      <div className="va-menu-panel va-menu-panel-right" role="menu">
                        <button role="menuitem" onClick={() => { setMenuFor(null); openSession(s.id, { name: s.name, startedAt: s.startedAt }); }}>Open</button>
                        <button role="menuitem" onClick={() => { setMenuFor(null); renameSession(s); }}>Rename</button>
                        {canShare && (
                          <button role="menuitem" onClick={() => { setMenuFor(null); shareSession(s.id); }}>Share</button>
                        )}
                        <button role="menuitem" onClick={() => { setMenuFor(null); exportSession(s.id); }}>Export</button>
                        <button role="menuitem" onClick={() => { setMenuFor(null); removeSession(s.id); }}>Delete</button>
                      </div>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {estimate && (
          <p className="sessions-storage">
            Storage: {fmtBytes(estimate.usage)} used of {fmtBytes(estimate.quota)}
          </p>
        )}
      </div>
    </AppShell>
  );
}

export default Sessions;
