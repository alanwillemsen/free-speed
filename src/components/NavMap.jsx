import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { boatFixAt, destinationPoint } from '../utils/geo';
import { createCourseOverlay } from '../utils/courseOverlay';
import { createMarkOverlay } from '../utils/markOverlay';
import { loadMarks, subscribeMarks } from '../utils/courseMarks';
import { createBasemapLayers, getBasemap, toggleBasemap, subscribeBasemap } from '../utils/basemap';

// Course-down navigation map for the big screen. The rower faces the stern,
// so the display keeps the direction of travel pointing DOWN: the whole map
// rotates under a fixed boat dot, and a 50 m heading ray shows where the hull
// is pointed without the rower turning their head. Leaflet can't rotate a map
// natively, so the trick is an oversized square container (side = the
// wrapper's diagonal, so no corners show) spun with a CSS transform; markers
// counter-rotate implicitly because their icons are rotated by the compass
// heading, which the container rotation cancels to a constant screen-down.
const HEADING_RAY_M = 50;

// Boat dot + heading ray color. Deliberately NOT the theme accent: chartplotter
// magenta (the marine/aviation course-line convention) is the one saturated hue
// that occurs in neither water, terrain, nor basemap styling, so it stays
// readable in direct sun on OSM blue and satellite dark green alike — where the
// sun theme's navy sank into the water and the dark theme's yellow collided
// with the bank lines.
const NAV_COLOR = '#ff00cc';

// Chevron marking the far end of the heading ray. Drawn pointing north (up)
// and rotated to the heading like the map, so on screen it always points down.
function chevronIcon(heading) {
  return L.divIcon({
    className: 'bignav-marker',
    html:
      `<div class="bignav-marker-rot" style="transform:rotate(${heading}deg)">` +
      '<svg width="38" height="38" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5 17 L12 7 L19 17" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>' +
      `<path d="M5 17 L12 7 L19 17" fill="none" stroke="${NAV_COLOR}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
      '</svg></div>',
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

function NavMap({ track, trackColor }) {
  const wrapRef = useRef(null);
  const rotorRef = useRef(null);
  const mapRef = useRef(null);
  // Visible wrapper height in px, for placing the boat near the top of the
  // screen regardless of zoom (the look-ahead offset is screen-relative).
  const wrapHeightRef = useRef(0);
  // Side of the square rotated container: the wrapper's diagonal, so the map
  // fills the view at every rotation angle.
  const [side, setSide] = useState(0);
  const [zoom, setZoom] = useState(17);
  // Cumulative screen rotation in degrees — never reduced mod 360, so the CSS
  // transition always takes the short way round instead of spinning back.
  const [rot, setRot] = useState(0);
  const rotRef = useRef(0);
  // Water-data fetch behind the course lines: 'loading' | 'error' | 'ready' | null.
  const [courseStatus, setCourseStatus] = useState(null);
  const [basemap, setBasemapState] = useState(getBasemap);

  useEffect(() => subscribeBasemap(setBasemapState), []);

  // Latest fix + direction of travel straight from the session track.
  const boat = useMemo(
    () => (track.length > 0 ? boatFixAt(track, track[track.length - 1].t) : null),
    [track]
  );

  useEffect(() => {
    // Non-interactive by design: at arm's length mid-stroke there's no
    // dragging or pinching, and stray splashes must not move the view.
    const map = L.map(rotorRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });
    const base = createBasemapLayers(map, { attribution: false });
    const line = L.polyline([], { weight: 3, opacity: 0.7 }).addTo(map);
    // River course from OSM water data: banks + mid-channel divider, so the
    // rower can hold the correct side. Added after the track, before the boat
    // layers, so the course draws over the trail but under dot/ray/chevron.
    const course = createCourseOverlay(map, setCourseStatus);
    // User-placed buoys/hazards/course-end lines. Their icons are circles, so
    // the rotating container doesn't matter — they read the same at any angle.
    const marks = createMarkOverlay(map);
    marks.setMarks(loadMarks());
    const unsubMarks = subscribeMarks((m) => marks.setMarks(m));
    // White casing under the ray, same trick as the course lines: in glare the
    // edge contrast survives long after the hue does.
    const rayCase = L.polyline([], { weight: 11, opacity: 0.95, color: '#ffffff' });
    const ray = L.polyline([], { weight: 6, opacity: 1, color: NAV_COLOR });
    const dot = L.circleMarker([0, 0], { radius: 10, color: '#ffffff', weight: 3, fillColor: NAV_COLOR, fillOpacity: 1 });
    const tip = L.marker([0, 0], { interactive: false, zIndexOffset: 1000 });
    map.setView([0, 0], 2);
    mapRef.current = { map, line, rayCase, ray, dot, tip, course, hasView: false };
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      wrapHeightRef.current = height;
      setSide(Math.ceil(Math.hypot(width, height)));
    });
    ro.observe(wrapRef.current);
    return () => {
      ro.disconnect();
      unsubMarks();
      marks.destroy();
      course.destroy();
      base.destroy();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // The rotor is resized via React state, after which Leaflet must re-measure
  // (it caches its container size). The default pan re-anchors the current
  // center in the new box — the view is often set while the box is still 0×0.
  useEffect(() => {
    if (side > 0) mapRef.current?.map.invalidateSize({ animate: false });
  }, [side]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    m.line.setLatLngs(track.map((p) => [p.lat, p.lon]));
    m.line.setStyle({ color: trackColor });
  }, [track, trackColor]);

  const lat = boat?.lat, lon = boat?.lon, heading = boat?.heading;
  useEffect(() => {
    const m = mapRef.current;
    if (!m || lat == null) return;

    m.dot.setLatLng([lat, lon]);
    if (!m.map.hasLayer(m.dot)) m.dot.addTo(m.map);
    m.course.update({ lat, lon, heading });

    // Heading ray: boat → 75 m ahead along the course, chevron at the tip.
    // Without a heading (stationary / first fix) show just the dot and hold
    // the last rotation rather than snapping back to north-up.
    let center = [lat, lon];
    if (heading != null) {
      const ahead = destinationPoint(lat, lon, heading, HEADING_RAY_M);
      m.rayCase.setLatLngs([[lat, lon], [ahead.lat, ahead.lon]]);
      m.ray.setLatLngs([[lat, lon], [ahead.lat, ahead.lon]]);
      m.tip.setLatLng([ahead.lat, ahead.lon]);
      m.tip.setIcon(chevronIcon(heading));
      if (!m.map.hasLayer(m.ray)) {
        m.rayCase.addTo(m.map);
        m.ray.addTo(m.map);
        m.tip.addTo(m.map);
        // The ray starts at the boat, so its casing would otherwise stripe
        // across the dot added on an earlier fix.
        m.dot.bringToFront();
      }
      // Rotate so the heading lands at 180° on screen (course-down), stepping
      // by the shortest arc from wherever the dial currently is.
      const target = 180 - heading;
      const delta = ((target - rotRef.current) % 360 + 540) % 360 - 180;
      rotRef.current += delta;
      setRot(rotRef.current);
      // Center ahead of the boat so the dot rides near the top of the screen
      // and the map real estate goes to the water being rowed into (below).
      // The offset is a fraction of the visible height converted to meters at
      // the current zoom — a fixed metric offset would push the boat off the
      // top of the frame when zoomed in.
      const metersPerPx =
        (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8);
      const aheadM = wrapHeightRef.current * 0.25 * metersPerPx;
      center = destinationPoint(lat, lon, heading, aheadM);
      center = [center.lat, center.lon];
    } else {
      m.rayCase.remove();
      m.ray.remove();
      m.tip.remove();
    }

    if (!m.hasView) {
      m.hasView = true;
      m.map.setView(center, zoom, { animate: false });
    } else if (m.map.getZoom() !== zoom) {
      m.map.setView(center, zoom, { animate: false });
    } else {
      // Linear ~1 s glide matching both the fix rate and the rotation
      // transition, so position and orientation move as one.
      m.map.panTo(center, { animate: true, duration: 0.95, easeLinearity: 1 });
    }
    // `side` is a dep so the boat-ahead offset (a fraction of the measured
    // wrapper height) is reapplied once the ResizeObserver reports a size —
    // the first fix can land before it fires.
  }, [lat, lon, heading, zoom, side]);

  return (
    <div ref={wrapRef} className="bignav">
      <div
        ref={rotorRef}
        className="bignav-rotor"
        style={{
          width: side,
          height: side,
          transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        }}
      />
      {boat == null && <div className="bignav-wait">waiting for GPS…</div>}
      {courseStatus === 'loading' && (
        <div className="bignav-course-status">loading course…</div>
      )}
      {courseStatus === 'error' && (
        <button
          className="bignav-course-status is-error"
          onClick={() => mapRef.current?.course.retry()}
        >
          no course — tap to retry
        </button>
      )}
      <div className="bignav-zoom">
        <button className="bigscreen-ctrl" onClick={() => setZoom((z) => Math.min(19, z + 1))} aria-label="Zoom in">+</button>
        <button className="bigscreen-ctrl" onClick={() => setZoom((z) => Math.max(13, z - 1))} aria-label="Zoom out">−</button>
        <button
          className="bigscreen-ctrl"
          onClick={toggleBasemap}
          aria-label={basemap === 'sat' ? 'Switch to street map' : 'Switch to satellite'}
        >
          {basemap === 'sat' ? '🗺' : '🛰'}
        </button>
      </div>
      {/* Attribution stays screen-horizontal, outside the rotated container. */}
      <div className="bignav-attrib">{basemap === 'sat' ? '© Esri, Maxar' : '© OpenStreetMap'}</div>
    </div>
  );
}

export default NavMap;
