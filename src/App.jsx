import { useState, useEffect, useRef } from 'react';
import SpeedChart from './components/SpeedChart';
import BoatVisualization from './components/BoatVisualization';
import SavedCurves, { parseShareHash, EXAMPLE_CURVES } from './components/SavedCurves';
import CurveHeader from './components/CurveHeader';
import LiveCapture from './components/LiveCapture';
import OarCapture from './components/OarCapture';
import VideoAnalysis from './components/VideoAnalysis';
import Tradeoffs from './components/Tradeoffs';
import Sessions from './components/Sessions';
import CourseMarks from './components/CourseMarks';
import AppShell from './components/AppShell';
import { offsetCurveToAverage } from './utils/curves';
import { calculateEnergy, estimateFinishTime, calculateEnergyPenalty } from './utils/physics';
import referenceCurveData from './data/referenceCurve.json';
import './App.css';

const STORAGE_KEY = 'freespeed_curves';
const RAW_AVG_SPEED = referenceCurveData.speeds.reduce((a, b) => a + b, 0) / referenceCurveData.speeds.length;
const RACE_DISTANCE = 2000;

function App() {
  const pageFromHash = () => {
    const h = window.location.hash;
    // Shared-curve links (#s=...) open in the calculator, which decodes them.
    if (h === '#calculator' || h.startsWith('#s=')) return 'calculator';
    if (h === '#oar' || h.startsWith('#oar?')) return 'oar';
    if (h === '#analyze' || h.startsWith('#analyze?')) return 'analyze';
    if (h === '#strokes') return 'strokes';
    if (h === '#sessions') return 'sessions';
    if (h === '#tradeoffs') return 'tradeoffs';
    if (h === '#course' || h.startsWith('#course?')) return 'course';
    if (h === '#link') return 'live'; // live page with the link-setup panel open
    return 'live'; // home page (covers '' and legacy #live links)
  };
  const [activePage, setActivePage] = useState(pageFromHash);


  useEffect(() => {
    const onHash = () => setActivePage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [curveARaw] = useState({
    times: referenceCurveData.times,
    speeds: referenceCurveData.speeds,
  });

  const sharedOnLoad = (() => {
    try { return parseShareHash(); } catch { return null; }
  })();

  const defaultEntry = sharedOnLoad ?? EXAMPLE_CURVES[0];

  const [raceTime, setRaceTime] = useState(defaultEntry?.raceTime ?? 450);
  const [strokeRate, setStrokeRate] = useState(defaultEntry?.strokeRate ?? 36);

  const targetAvgSpeed = RACE_DISTANCE / raceTime;
  const speedScale = targetAvgSpeed / RAW_AVG_SPEED;
  const curveA = {
    times: curveARaw.times,
    speeds: curveARaw.speeds.map(s => s * speedScale),
  };

  const [curveB, setCurveB] = useState(() => {
    if (defaultEntry?.speeds?.length === referenceCurveData.times.length) {
      return { times: [...referenceCurveData.times], speeds: defaultEntry.speeds };
    }
    return { times: [...referenceCurveData.times], speeds: curveARaw.speeds.map(s => s * speedScale) };
  });

  const [curveBNormalized, setCurveBNormalized] = useState({
    times: [...referenceCurveData.times],
    speeds: curveARaw.speeds.map(s => s * speedScale),
  });

  // null = creating a new curve; entry object = viewing a saved/example curve
  const [viewingCurve, setViewingCurve] = useState(sharedOnLoad ?? EXAMPLE_CURVES[0]);

  // Once the user navigates (loads a curve or creates a new one), stop seeding
  // the header from the shared URL so that "New curve" gives a blank header.
  const sharedConsumed = useRef(false);

  // true when a new curve has unsaved changes (drawn or title/desc edited)
  const [isDirty, setIsDirty] = useState(false);

  // incremented after saving a new curve so SavedCurves re-reads localStorage
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const normalizedSpeeds = offsetCurveToAverage(curveB.speeds, targetAvgSpeed);
    setCurveBNormalized({ times: curveB.times, speeds: normalizedSpeeds });
  }, [curveB, raceTime]);

  const confirmDiscard = () =>
    !isDirty || window.confirm('You have unsaved changes. Discard them?');

  const handleCurveBChange = (newSpeeds) => {
    const correctedSpeeds = [...newSpeeds];
    correctedSpeeds[correctedSpeeds.length - 1] = correctedSpeeds[0];
    setCurveB({ times: curveB.times, speeds: correctedSpeeds });
    setIsDirty(true);
  };

  const handleReset = () => {
    setCurveB({ times: [...curveA.times], speeds: [...curveA.speeds] });
  };

  const handleLoadCurve = (entry) => {
    if (isDirty && !confirmDiscard()) return;
    sharedConsumed.current = true;
    if (entry.raceTime) setRaceTime(entry.raceTime);
    if (entry.strokeRate) setStrokeRate(entry.strokeRate);
    setCurveB({ times: [...referenceCurveData.times], speeds: entry.speeds });
    setViewingCurve(entry);
    setIsDirty(false);
  };

  const handleNewCurve = () => {
    if (isDirty && !confirmDiscard()) return;
    sharedConsumed.current = true;
    setViewingCurve(null);
    setIsDirty(false);
    handleReset();
  };

  const handleSave = (name, desc) => {
    if (!viewingCurve || viewingCurve.isExample || viewingCurve.isShared) {
      // Save as a new entry (also covers: saving a modified example as a new
      // curve, and saving a share-link curve into this browser).
      const resolvedName = viewingCurve?.isExample && (name || 'Untitled') === viewingCurve.name
        ? `${name} (copy)`
        : (name || 'Untitled');
      const entry = {
        id: Date.now(),
        name: resolvedName,
        desc,
        speeds: curveB.speeds,
        raceTime,
        strokeRate,
        savedAt: new Date().toISOString(),
      };
      const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...existing]));
      setViewingCurve(entry);
    } else {
      // Update existing saved entry
      const updated = { ...viewingCurve, speeds: curveB.speeds, raceTime, strokeRate };
      const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existing.map(e => e.id === updated.id ? updated : e)));
      setViewingCurve(updated);
    }
    setIsDirty(false);
    setRefreshKey(k => k + 1);
  };

  const handleUpdateCurve = (updatedEntry) => {
    if (updatedEntry.isExample) return; // examples are read-only in storage
    setViewingCurve(updatedEntry);
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const next = existing.map(e => e.id === updatedEntry.id ? updatedEntry : e);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setRefreshKey(k => k + 1);
  };

  const handleDuplicateExample = (entry) => {
    const copy = {
      id: Date.now(),
      name: entry.name,
      desc: entry.desc,
      speeds: entry.speeds,
      raceTime: entry.raceTime,
      strokeRate: entry.strokeRate,
      savedAt: new Date().toISOString(),
    };
    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    localStorage.setItem(STORAGE_KEY, JSON.stringify([copy, ...existing]));
    setRefreshKey(k => k + 1);
  };

  // Mean cubic speed ∝ average power (P = k·v³). We use the plain mean of v³ —
  // the same convention as the live "untapped" free-speed metric
  // (freeSpeedSecondsFor) — so the calculator's time difference matches it exactly.
  // (calculateAveragePower integrates trapezoidally, which drops the closed curve's
  // duplicated endpoint and disagrees by a few percent.)
  const meanCube = (speeds) => speeds.reduce((a, v) => a + v * v * v, 0) / speeds.length;
  const avgPowerA = meanCube(curveA.speeds);
  const avgPowerBNorm = meanCube(curveBNormalized.speeds);
  // raceTime is your *current* 2k time (it comes from the measured pace of the
  // stroke you opened). Your potential is the faster time the same energy would
  // yield with the smoother reference curve: T_pot = raceTime * (P_A / P_B)^(1/3).
  const estimate = estimateFinishTime(raceTime, avgPowerBNorm, avgPowerA);
  const energyA = calculateEnergy(curveA.times, curveA.speeds);
  const energyBNorm = calculateEnergy(curveBNormalized.times, curveBNormalized.speeds);
  const penalty = calculateEnergyPenalty(energyBNorm * raceTime, energyA * raceTime);

  // The live capture page stays mounted whatever page is showing, so a rower's
  // capture keeps running in the background while they look at other pages (the
  // pipeline pauses itself off the water). Hiding instead of unmounting keeps
  // the sensor listeners, GPS watch, recording, and coach link alive. The
  // Stroke Analysis page is the same component in its analysis variant — a
  // separate instance, so loading a file never clobbers a running capture.
  const otherPage =
    activePage === 'strokes' ? <LiveCapture variant="analysis" /> :
    activePage === 'sessions' ? <Sessions /> :
    activePage === 'oar' ? <OarCapture /> :
    activePage === 'analyze' ? <VideoAnalysis /> :
    activePage === 'tradeoffs' ? <Tradeoffs /> :
    activePage === 'course' ? <CourseMarks /> :
    null;

  return (
    <>
    <div style={activePage === 'live' ? undefined : { display: 'none' }}>
      <LiveCapture active={activePage === 'live'} />
    </div>
    {otherPage}
    {activePage === 'calculator' && (
    <AppShell page="calculator" title="Rowing Efficiency Calculator">
    <div className="app">
      <div className="app-content">
        <SavedCurves
          onLoad={handleLoadCurve}
          onNew={handleNewCurve}
          onDuplicate={handleDuplicateExample}
          viewingCurveId={viewingCurve?.id}
          refreshKey={refreshKey}
        />

        <div className="main-content">
          <p className="subtitle">
            How much time are you leaving on the water? Draw a boat speed profile and see how
            a smoother stroke — same average speed, less energy — translates to a faster finish time.
          </p>

          {/* Wide screens: title/description with the results under it in a
              left column that matches the chart's height, chart to the right.
              Narrow screens: header → chart → results, stacked. */}
          <div className="calc-columns">
            <div className="calc-side-col">
              <CurveHeader
                key={viewingCurve?.id ?? 'new'}
                entry={viewingCurve}
                isNew={!viewingCurve}
                isDirty={isDirty}
                initialName={!sharedConsumed.current ? sharedOnLoad?.name : undefined}
                initialDesc={!sharedConsumed.current ? sharedOnLoad?.desc : undefined}
                onSave={handleSave}
                onUpdate={handleUpdateCurve}
                onDirty={() => setIsDirty(true)}
              />

              <aside className="calc-results-col">
                <BoatVisualization
                  show="metrics"
                  timeDifference={estimate.timeDifference}
                  avgVelocityA={targetAvgSpeed}
                  raceTime={raceTime}
                  onRaceTimeChange={setRaceTime}
                  estimatedFinishTime={estimate.finishTime}
                  energyPenaltyPercent={penalty.percentPenalty}
                />
              </aside>
            </div>

            <div className="calc-chart-col">
              <SpeedChart
                curveA={curveA}
                curveB={curveBNormalized}
                onCurveBChange={handleCurveBChange}
                onReset={handleReset}
                energyPenaltyPercent={penalty.percentPenalty}
                strokeRate={strokeRate}
                onStrokeRateChange={setStrokeRate}
                isNewCurve={!viewingCurve}
              />
            </div>
          </div>

          {/* The race graphic needs the full page width to be readable — the
              side column only carries the numbers. */}
          <BoatVisualization
            show="race"
            timeDifference={estimate.timeDifference}
            avgVelocityA={targetAvgSpeed}
            raceTime={raceTime}
            onRaceTimeChange={setRaceTime}
            estimatedFinishTime={estimate.finishTime}
            energyPenaltyPercent={penalty.percentPenalty}
          />
        </div>
      </div>
    </div>
    </AppShell>
    )}
    </>
  );
}

export default App;
