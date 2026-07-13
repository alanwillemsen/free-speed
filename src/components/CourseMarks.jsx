import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import AppShell from './AppShell';
import {
  MARK_TYPES,
  loadMarks,
  saveMarks,
  makeMark,
  mergeMarks,
  encodeShareParam,
  decodeShareParam,
} from '../utils/courseMarks';
import { createMarkOverlay, markIcon, dockWidthAt, dockLengthM } from '../utils/markOverlay';

// Map editor for local course knowledge OSM doesn't have: centre-line buoys
// (which often sit off the geometric middle), shallow-water hazard buoys, and
// the end of the rowable course (a do-not-pass line across the water — dam or
// shallows). Marks placed here render on the live map and the big-screen nav.
//
// Interaction model: arm a tool, tap the map to drop marks (the course-end
// tool takes two taps — one per bank); tap a mark to select it, drag to move,
// delete from the panel. Everything persists locally; Share link / Export /
// Import move a set between phones.

const TOOL_GLYPHS = {
  center:
    '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#facc15" stroke="#111827" stroke-width="2"/></svg>',
  hazard:
    '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#dc2626" stroke="#ffffff" stroke-width="2.5"/><circle cx="12" cy="12" r="3" fill="#ffffff"/></svg>',
  end:
    '<svg width="18" height="18" viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" stroke="#ef4444" stroke-width="3" stroke-dasharray="4 3"/><circle cx="3" cy="12" r="3" fill="#dc2626"/><circle cx="21" cy="12" r="3" fill="#dc2626"/></svg>',
  dock:
    '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="8" rx="1" fill="#d97706" stroke="#111827" stroke-width="2"/></svg>',
};

const TOOL_HINTS = {
  center: 'Tap the map where the centre buoy floats — the course line will run through it',
  hazard: 'Tap the map over the shallow spot',
  end: 'Tap one bank, then the other, to draw the do-not-pass line',
  dock: 'Tap one end of the dock edge, along the shore',
};

function CourseMarks() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [marks, setMarks] = useState(loadMarks);
  const [tool, setTool] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [pendingEnd, setPendingEnd] = useState(null); // first tap of an end line
  const [pendingDock, setPendingDock] = useState(null); // { a, b? } — dock edge taps so far
  const [toast, setToast] = useState(null);
  const toolRef = useRef(null);
  toolRef.current = tool;
  const pendingEndRef = useRef(null);
  pendingEndRef.current = pendingEnd;
  const pendingDockRef = useRef(null);
  pendingDockRef.current = pendingDock;
  const fileRef = useRef(null);
  const toastTimer = useRef(null);

  const notify = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Persist every change; saveMarks also notifies any mounted map overlays.
  useEffect(() => {
    saveMarks(marks);
  }, [marks]);

  useEffect(() => {
    const map = L.map(containerRef.current, { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const overlay = createMarkOverlay(map, {
      interactive: true,
      onSelect: (id) => {
        setTool(null);
        setPendingEnd(null);
        setPendingDock(null);
        setSelectedId(id);
      },
      onMove: (id, patch) =>
        setMarks((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m))),
    });
    map.on('click', (e) => {
      const t = toolRef.current;
      if (!t) {
        setSelectedId(null);
        return;
      }
      const { lat, lng } = e.latlng;
      if (t === 'end') {
        const first = pendingEndRef.current;
        if (!first) {
          setPendingEnd({ lat, lon: lng });
        } else {
          setMarks((ms) => [...ms, makeMark('end', first.lat, first.lon, lat, lng)]);
          setPendingEnd(null);
          setTool(null);
        }
      } else if (t === 'dock') {
        // Three taps: two ends of the long edge, then the far side for width.
        const pd = pendingDockRef.current;
        if (!pd) {
          setPendingDock({ a: { lat, lon: lng } });
        } else if (!pd.b) {
          setPendingDock({ ...pd, b: { lat, lon: lng } });
        } else {
          let w = dockWidthAt(pd.a, pd.b, { lat, lon: lng });
          if (Math.abs(w) < 0.5) w = w < 0 ? -0.5 : 0.5;
          setMarks((ms) => [...ms, makeMark('dock', pd.a.lat, pd.a.lon, pd.b.lat, pd.b.lon, w)]);
          setPendingDock(null);
          setTool(null);
        }
      } else {
        setMarks((ms) => [...ms, makeMark(t, lat, lng)]);
      }
    });

    // Initial view: the marks you have, else where you are, else the world.
    const existing = loadMarks();
    if (existing.length > 0) {
      const pts = existing.flatMap((m) =>
        m.type === 'end' ? [[m.lat, m.lon], [m.lat2, m.lon2]] : [[m.lat, m.lon]]
      );
      map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 16 });
    } else {
      map.setView([0, 0], 2);
      navigator.geolocation?.getCurrentPosition(
        (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
        () => {},
        { maximumAge: 60000, timeout: 10000 }
      );
    }

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);
    mapRef.current = { map, overlay };
    return () => {
      ro.disconnect();
      overlay.destroy();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // A shared link (#course?marks=…) imports on arrival — at mount, or via a
  // hash change if the page is already open. The param is stripped before the
  // prompt so a dev-mode double effect or a reload can't re-ask.
  useEffect(() => {
    const tryImport = () => {
      const q = window.location.hash.indexOf('?');
      if (q < 0) return;
      const params = new URLSearchParams(window.location.hash.slice(q + 1));
      const shared = params.get('marks');
      if (!shared) return;
      history.replaceState(null, '', window.location.pathname + '#course');
      const incoming = decodeShareParam(shared);
      if (incoming.length === 0) {
        notify('Shared link had no readable marks');
        return;
      }
      if (!window.confirm(`Import ${incoming.length} shared course mark${incoming.length === 1 ? '' : 's'}?`)) return;
      // The persist effect keeps the store current, so merging against
      // loadMarks() is merging against the live state — no race.
      const { marks: merged, added } = mergeMarks(loadMarks(), incoming);
      notify(added > 0 ? `Imported ${added} mark${added === 1 ? '' : 's'}` : 'Already have all of these');
      if (added > 0) {
        setMarks(merged);
        const pts = incoming.flatMap((m) =>
          m.type === 'end' ? [[m.lat, m.lon], [m.lat2, m.lon2]] : [[m.lat, m.lon]]
        );
        mapRef.current?.map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 16 });
      }
    };
    tryImport();
    window.addEventListener('hashchange', tryImport);
    return () => window.removeEventListener('hashchange', tryImport);
  }, []);

  useEffect(() => {
    mapRef.current?.overlay.setMarks(marks, selectedId);
  }, [marks, selectedId]);

  // Ghost marker for the first tap of a course-end line.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !pendingEnd) return;
    const ghost = L.marker([pendingEnd.lat, pendingEnd.lon], {
      icon: markIcon('end'),
      interactive: false,
      opacity: 0.6,
    }).addTo(m.map);
    return () => ghost.remove();
  }, [pendingEnd]);

  // Ghost for the dock taps so far: a dot for the first corner, then the edge.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !pendingDock) return;
    const ghosts = [
      L.circleMarker([pendingDock.a.lat, pendingDock.a.lon], {
        radius: 5, color: '#d97706', weight: 3, fillOpacity: 0.5, interactive: false,
      }).addTo(m.map),
    ];
    if (pendingDock.b) {
      ghosts.push(
        L.polyline(
          [[pendingDock.a.lat, pendingDock.a.lon], [pendingDock.b.lat, pendingDock.b.lon]],
          { color: '#d97706', weight: 3, dashArray: '4 6', interactive: false }
        ).addTo(m.map)
      );
    }
    return () => ghosts.forEach((g) => g.remove());
  }, [pendingDock]);

  const armTool = (t) => {
    setSelectedId(null);
    setPendingEnd(null);
    setPendingDock(null);
    setTool((cur) => (cur === t ? null : t));
  };

  const deleteSelected = () => {
    setMarks((ms) => ms.filter((m) => m.id !== selectedId));
    setSelectedId(null);
  };

  const copyLink = async () => {
    if (marks.length === 0) {
      notify('No marks to share yet');
      return;
    }
    const url = `${window.location.origin}${window.location.pathname}#course?marks=${encodeShareParam(marks)}`;
    try {
      await navigator.clipboard.writeText(url);
      notify('Share link copied');
    } catch {
      window.prompt('Copy this link:', url);
    }
  };

  const exportFile = () => {
    const blob = new Blob([JSON.stringify({ formatVersion: 1, marks }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'course-marks.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    file.text().then((text) => {
      let incoming = [];
      try {
        const parsed = JSON.parse(text);
        incoming = Array.isArray(parsed) ? parsed : parsed?.marks;
      } catch {
        /* fall through to the empty check */
      }
      if (!Array.isArray(incoming) || incoming.length === 0) {
        notify("Couldn't read marks from that file");
        return;
      }
      const { marks: merged, added } = mergeMarks(marks, incoming);
      notify(added > 0 ? `Imported ${added} mark${added === 1 ? '' : 's'}` : 'Already have all of these');
      if (added > 0) setMarks(merged);
    });
  };

  const selected = marks.find((m) => m.id === selectedId);
  const hint =
    tool === 'end' && pendingEnd ? 'Now tap the far bank'
    : tool === 'dock' && pendingDock?.b ? "Tap the dock's far side to set its width"
    : tool === 'dock' && pendingDock ? 'Tap the other end of the dock edge'
    : tool ? TOOL_HINTS[tool] : null;

  return (
    <AppShell page="course" title="Course Marks">
      <div className="course-page">
        <div className="course-toolbar">
          {Object.keys(MARK_TYPES).map((t) => (
            <button
              key={t}
              className={`course-tool${tool === t ? ' active' : ''}`}
              onClick={() => armTool(t)}
              aria-pressed={tool === t}
            >
              <span dangerouslySetInnerHTML={{ __html: TOOL_GLYPHS[t] }} />
              {MARK_TYPES[t].label}
            </button>
          ))}
          <div className="course-toolbar-spacer" />
          <button className="course-tool" onClick={copyLink}>Share link</button>
          <button className="course-tool" onClick={exportFile}>Export</button>
          <button className="course-tool" onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={importFile} />
        </div>

        <div className="course-map-wrap">
          <div ref={containerRef} className="course-map" />
          {hint && <div className="course-hint">{hint}</div>}
          {toast && <div className="course-toast">{toast}</div>}
          {selected && (
            <div className="course-mark-panel">
              <span className="course-mark-panel-label">
                <span dangerouslySetInnerHTML={{ __html: TOOL_GLYPHS[selected.type] }} />
                {MARK_TYPES[selected.type].label}
              </span>
              <span className="course-mark-panel-coords">
                {selected.type === 'dock'
                  ? `${dockLengthM(selected).toFixed(0)} m × ${Math.abs(selected.w).toFixed(1)} m`
                  : `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}`}
              </span>
              <button className="course-mark-delete" onClick={deleteSelected}>Delete</button>
              <button className="course-mark-close" onClick={() => setSelectedId(null)} aria-label="Close">✕</button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

export default CourseMarks;
