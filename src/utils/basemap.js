// Shared basemap choice for every Leaflet map in the app: OSM street tiles or
// Esri World Imagery satellite (free, no API key). The preference persists in
// localStorage and is broadcast to all mounted maps, so toggling on one map
// switches them all — the live map, the big-screen nav, and the mark editor
// should never disagree about what the water looks like.
//
// Night mode inverts street tiles with a CSS filter; that would mangle
// imagery, so the active kind is mirrored as a `basemap-sat` class on the
// map container and the dark-theme filter rules skip satellite (App.css).
import L from 'leaflet';

const KEY = 'freespeed_basemap_v1';

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const SAT_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SAT_ATTRIB = 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics';

export function getBasemap() {
  try {
    return localStorage.getItem(KEY) === 'sat' ? 'sat' : 'osm';
  } catch {
    return 'osm';
  }
}

const listeners = new Set();

export function setBasemap(kind) {
  try {
    localStorage.setItem(KEY, kind === 'sat' ? 'sat' : 'osm');
  } catch {
    /* private mode — the toggle still works for this session via listeners */
  }
  listeners.forEach((fn) => fn(getBasemap()));
}

export function toggleBasemap() {
  setBasemap(getBasemap() === 'sat' ? 'osm' : 'sat');
}

export function subscribeBasemap(fn) {
  listeners.add(fn);
  const onStorage = (e) => {
    if (e.key === KEY) fn(getBasemap());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

// Replaces the per-map `L.tileLayer(...).addTo(map)` call: adds the preferred
// base layer, follows preference changes while mounted. `attribution: false`
// for maps that render their own credit line (NavMap).
export function createBasemapLayers(map, { attribution = true } = {}) {
  const osm = L.tileLayer(OSM_URL, {
    maxZoom: 19,
    attribution: attribution ? OSM_ATTRIB : undefined,
  });
  // Esri serves z19 imagery over most populated areas; past its native max
  // Leaflet upscales z18 rather than showing broken tiles.
  const sat = L.tileLayer(SAT_URL, {
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: attribution ? SAT_ATTRIB : undefined,
  });
  let current = null;
  const apply = (kind) => {
    const next = kind === 'sat' ? sat : osm;
    if (next === current) return;
    if (current) current.remove();
    next.addTo(map);
    current = next;
    map.getContainer().classList.toggle('basemap-sat', kind === 'sat');
  };
  apply(getBasemap());
  const unsub = subscribeBasemap(apply);
  return {
    destroy() {
      unsub();
      // map.remove() usually runs right after; guard for double cleanup
      if (current) current.remove();
      current = null;
    },
  };
}
