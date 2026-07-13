// Leaflet layer bundle for user-placed course marks (see utils/courseMarks).
//
// Used two ways: read-only on the live/nav maps (interactive=false) and as
// the editing surface on the course-marks page (interactive=true: markers are
// draggable and clicks select). All icons are rotationally symmetric circles
// on purpose — NavMap spins the whole map container to keep the course
// pointing down, and a symmetric glyph reads the same at any angle.
import L from 'leaflet';

// Casing-under-core, like the course overlay, so marks survive pale sun tiles
// and the inverted night basemap.
const END_LINE_CASING = { color: '#111827', weight: 8, opacity: 0.85, interactive: false };
const END_LINE_CORE = { color: '#ef4444', weight: 4, opacity: 1, dashArray: '6 10', interactive: false };

const CENTER_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10" fill="none" stroke="#ffffff" stroke-opacity="0.8" stroke-width="1.5"/>' +
  '<circle cx="12" cy="12" r="8" fill="#facc15" stroke="#111827" stroke-width="2"/></svg>';

const HAZARD_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10" fill="none" stroke="#111827" stroke-opacity="0.55" stroke-width="1.5"/>' +
  '<circle cx="12" cy="12" r="8" fill="#dc2626" stroke="#ffffff" stroke-width="2.5"/>' +
  '<circle cx="12" cy="12" r="3" fill="#ffffff"/></svg>';

const END_SVG =
  '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">' +
  '<circle cx="9" cy="9" r="6.5" fill="#dc2626" stroke="#ffffff" stroke-width="2"/></svg>';

const ICONS = { center: [CENTER_SVG, 24], hazard: [HAZARD_SVG, 24], end: [END_SVG, 18] };

// Dock: a true-size geographic polygon (scales with zoom), wood-coloured with
// a dark outline so it reads on both the day tiles and the inverted night
// basemap.
const DOCK_STYLE = { color: '#111827', weight: 2, opacity: 0.9, fillColor: '#d97706', fillOpacity: 0.85 };
const DOCK_STYLE_SELECTED = { ...DOCK_STYLE, color: '#7c8cf0', weight: 3 };

const HANDLE_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="5.5" fill="#ffffff" stroke="#2563eb" stroke-width="2.5"/></svg>';

const handleIcon = () =>
  L.divIcon({ className: 'course-mark course-mark-handle', html: HANDLE_SVG, iconSize: [16, 16], iconAnchor: [8, 8] });

// --- Dock rectangle geometry (planar metres around corner A) ---

const M_PER_DEG = 111320;

function dockFrame(aLat, aLon) {
  const k = Math.cos((aLat * Math.PI) / 180);
  return {
    toXY: (lat, lon) => [(lon - aLon) * k * M_PER_DEG, (lat - aLat) * M_PER_DEG],
    toLL: ([x, y]) => [aLat + y / M_PER_DEG, aLon + x / (k * M_PER_DEG)],
  };
}

// Corners A → B → B+n·w → A+n·w, where n is the left normal of the A→B edge
// and w is the dock's signed width in metres.
export function dockCorners(mark) {
  const { toXY, toLL } = dockFrame(mark.lat, mark.lon);
  const [bx, by] = toXY(mark.lat2, mark.lon2);
  const len = Math.hypot(bx, by) || 1;
  const nx = (-by / len) * mark.w;
  const ny = (bx / len) * mark.w;
  return [
    [mark.lat, mark.lon],
    [mark.lat2, mark.lon2],
    toLL([bx + nx, by + ny]),
    toLL([nx, ny]),
  ];
}

export function dockLengthM(mark) {
  const { toXY } = dockFrame(mark.lat, mark.lon);
  const [bx, by] = toXY(mark.lat2, mark.lon2);
  return Math.hypot(bx, by);
}

// Signed perpendicular distance (metres) from the A→B edge to point p:
// the dock width implied by tapping/dragging at p. Positive = left of A→B.
export function dockWidthAt(a, b, p) {
  const { toXY } = dockFrame(a.lat, a.lon);
  const [bx, by] = toXY(b.lat, b.lon);
  const [px, py] = toXY(p.lat, p.lon);
  const len = Math.hypot(bx, by) || 1;
  return (bx * py - by * px) / len;
}

export function markIcon(type, selected = false) {
  const [svg, size] = ICONS[type];
  return L.divIcon({
    className: `course-mark${selected ? ' selected' : ''}`,
    html: svg,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// onSelect(id) fires on marker tap; onMove(id, patch) fires after a drag with
// { lat, lon } or { lat2, lon2 } depending on which end moved.
export function createMarkOverlay(map, { interactive = false, onSelect, onMove } = {}) {
  const group = L.layerGroup().addTo(map);
  let destroyed = false;

  const makeMarker = (latlng, type, mark, selected) => {
    const marker = L.marker(latlng, {
      icon: markIcon(type, selected),
      interactive,
      draggable: interactive,
      zIndexOffset: 500,
    }).addTo(group);
    if (interactive) {
      marker.on('click', () => onSelect?.(mark.id));
    }
    return marker;
  };

  const build = (marks, selectedId) => {
    group.clearLayers();
    for (const mark of marks) {
      const selected = mark.id === selectedId;
      if (mark.type === 'end') {
        const pts = () => [[mark.lat, mark.lon], [mark.lat2, mark.lon2]];
        const casing = L.polyline(pts(), END_LINE_CASING).addTo(group);
        const core = L.polyline(pts(), END_LINE_CORE).addTo(group);
        const a = makeMarker([mark.lat, mark.lon], 'end', mark, selected);
        const b = makeMarker([mark.lat2, mark.lon2], 'end', mark, selected);
        if (interactive) {
          const live = () => {
            const line = [a.getLatLng(), b.getLatLng()];
            casing.setLatLngs(line);
            core.setLatLngs(line);
          };
          a.on('drag', live);
          b.on('drag', live);
          a.on('dragend', () => {
            const p = a.getLatLng();
            onMove?.(mark.id, { lat: p.lat, lon: p.lng });
          });
          b.on('dragend', () => {
            const p = b.getLatLng();
            onMove?.(mark.id, { lat2: p.lat, lon2: p.lng });
          });
        }
      } else if (mark.type === 'dock') {
        const poly = L.polygon(dockCorners(mark), {
          ...(selected ? DOCK_STYLE_SELECTED : DOCK_STYLE),
          interactive,
          // clicks select the dock; without this they'd bubble on to the map,
          // whose click handler would immediately deselect it again
          bubblingMouseEvents: false,
        }).addTo(group);
        if (interactive) {
          poly.on('click', () => onSelect?.(mark.id));
          if (selected) {
            // Three drag handles: the two ends of the long edge, and the
            // middle of the far side for the width.
            const corners = dockCorners(mark);
            const farMid = [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2];
            const opts = { icon: handleIcon(), draggable: true, zIndexOffset: 600 };
            const hA = L.marker([mark.lat, mark.lon], opts).addTo(group);
            const hB = L.marker([mark.lat2, mark.lon2], opts).addTo(group);
            const hW = L.marker(farMid, opts).addTo(group);
            const current = () => {
              const a = hA.getLatLng();
              const b = hB.getLatLng();
              return { lat: a.lat, lon: a.lng, lat2: b.lat, lon2: b.lng, w: mark.w };
            };
            const redraw = (m) => poly.setLatLngs(dockCorners(m));
            hA.on('drag', () => redraw(current()));
            hB.on('drag', () => redraw(current()));
            hA.on('dragend', () => {
              const p = hA.getLatLng();
              onMove?.(mark.id, { lat: p.lat, lon: p.lng });
            });
            hB.on('dragend', () => {
              const p = hB.getLatLng();
              onMove?.(mark.id, { lat2: p.lat, lon2: p.lng });
            });
            const draggedWidth = () => {
              const p = hW.getLatLng();
              const w = dockWidthAt(
                { lat: mark.lat, lon: mark.lon },
                { lat: mark.lat2, lon: mark.lon2 },
                { lat: p.lat, lon: p.lng }
              );
              return Math.abs(w) < 0.5 ? (w < 0 ? -0.5 : 0.5) : w;
            };
            hW.on('drag', () => redraw({ ...current(), w: draggedWidth() }));
            hW.on('dragend', () => onMove?.(mark.id, { w: draggedWidth() }));
          }
        }
      } else {
        const marker = makeMarker([mark.lat, mark.lon], mark.type, mark, selected);
        if (interactive) {
          marker.on('dragend', () => {
            const p = marker.getLatLng();
            onMove?.(mark.id, { lat: p.lat, lon: p.lng });
          });
        }
      }
    }
  };

  return {
    setMarks(marks, selectedId = null) {
      if (!destroyed) build(marks, selectedId);
    },
    destroy() {
      destroyed = true;
      group.remove();
    },
  };
}
