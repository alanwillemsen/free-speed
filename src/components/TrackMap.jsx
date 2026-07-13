import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { boatFixAt } from '../utils/geo';
import { createCourseOverlay } from '../utils/courseOverlay';
import { createMarkOverlay } from '../utils/markOverlay';
import { loadMarks, subscribeMarks } from '../utils/courseMarks';
import { createBasemapLayers, getBasemap, toggleBasemap, subscribeBasemap } from '../utils/basemap';

// Boat marker: a north-pointing arrow rotated to the heading, or a plain dot
// when the direction is unknown (stationary / single fix).
const ARROW_SVG =
  '<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 2 L19 21 L12 17 L5 21 Z" fill="#2563eb" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const DOT_SVG =
  '<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="6" fill="#2563eb" stroke="#ffffff" stroke-width="2"/></svg>';

function boatIcon(heading) {
  return L.divIcon({
    className: 'track-map-boat',
    html: `<div class="track-map-boat-rot" style="transform:rotate(${heading ?? 0}deg)">${
      heading != null ? ARROW_SVG : DOT_SVG
    }</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// OSM map showing the session's GPS track and (optionally) the boat's position
// and direction of travel. The view follows the boat until the user drags the
// map away; a re-center button brings it back.
function TrackMap({ track, boat, label }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  // Water-data fetch behind the course lines: 'loading' | 'error' | 'ready' | null.
  const [courseStatus, setCourseStatus] = useState(null);
  const [basemap, setBasemapState] = useState(getBasemap);

  useEffect(() => subscribeBasemap(setBasemapState), []);

  useEffect(() => {
    const map = L.map(containerRef.current, { zoomControl: true });
    const base = createBasemapLayers(map);
    const line = L.polyline([], { color: '#667eea', weight: 3, opacity: 0.85 }).addTo(map);
    const marker = L.marker([0, 0], { icon: boatIcon(null), interactive: false, zIndexOffset: 1000 });
    // River course (banks + divider) traced from OSM water data around the boat.
    const course = createCourseOverlay(map, setCourseStatus);
    // User-placed buoys/hazards/course-end lines (edited on the #course page).
    const marks = createMarkOverlay(map);
    marks.setMarks(loadMarks());
    const unsubMarks = subscribeMarks((m) => marks.setMarks(m));
    map.setView([0, 0], 2);
    map.on('dragstart', () => setFollow(false));
    // hasView: first real coordinates set the initial view (fit track / center boat)
    mapRef.current = { map, line, marker, course, hasView: false };
    // Leaflet sizes itself once at init; layout shifts around the map (panels
    // appearing, orientation changes) would otherwise leave stale tiles.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);
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

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const latlngs = track.map((p) => [p.lat, p.lon]);
    m.line.setLatLngs(latlngs);
    if (!m.hasView && latlngs.length > 0) {
      m.hasView = true;
      if (latlngs.length > 1) {
        m.map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24], maxZoom: 17 });
      } else {
        m.map.setView(latlngs[0], 16);
      }
    }
  }, [track]);

  // Anchor for the course overlay: the boat when shown, otherwise the end of
  // the recorded track — so a saved session still shows banks and divider.
  const courseFix = useMemo(
    () => boat ?? (track.length > 0 ? boatFixAt(track, track[track.length - 1].t) : null),
    [boat, track]
  );
  useEffect(() => {
    if (courseFix) mapRef.current?.course.update(courseFix);
  }, [courseFix]);

  const boatLat = boat?.lat, boatLon = boat?.lon, boatHeading = boat?.heading;
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (boatLat == null) {
      m.marker.remove();
      return;
    }
    m.marker.setLatLng([boatLat, boatLon]);
    m.marker.setIcon(boatIcon(boatHeading));
    if (!m.map.hasLayer(m.marker)) m.marker.addTo(m.map);
    if (!m.hasView) {
      m.hasView = true;
      m.map.setView([boatLat, boatLon], 16);
    } else if (followRef.current) {
      m.map.panTo([boatLat, boatLon]);
    }
  }, [boatLat, boatLon, boatHeading]);

  const recenter = () => {
    setFollow(true);
    const m = mapRef.current;
    if (!m) return;
    if (boatLat != null) m.map.panTo([boatLat, boatLon]);
    else if (track.length > 1) m.map.fitBounds(L.latLngBounds(track.map((p) => [p.lat, p.lon])), { padding: [24, 24], maxZoom: 17 });
  };

  return (
    <div className="live-map">
      {label && <div className="live-map-label">{label}</div>}
      <div ref={containerRef} className="live-map-canvas" />
      {courseStatus === 'loading' && (
        <div className="live-map-course-status">Loading course…</div>
      )}
      {courseStatus === 'error' && (
        <button
          className="live-map-course-status is-error"
          onClick={() => mapRef.current?.course.retry()}
        >
          Course unavailable — tap to retry
        </button>
      )}
      {!follow && (
        <button className="live-map-recenter" onClick={recenter} aria-label="Re-center on boat" title="Re-center on boat">
          ⌖
        </button>
      )}
      <button
        className="live-map-basemap"
        onClick={toggleBasemap}
        aria-label={basemap === 'sat' ? 'Switch to street map' : 'Switch to satellite'}
        title={basemap === 'sat' ? 'Switch to street map' : 'Switch to satellite'}
      >
        {basemap === 'sat' ? '🗺' : '🛰'}
      </button>
    </div>
  );
}

export default TrackMap;
