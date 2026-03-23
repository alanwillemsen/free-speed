import { useState, useEffect, useRef } from 'react';
import SpeedChart from './components/SpeedChart';
import BoatVisualization from './components/BoatVisualization';
import SavedCurves, { parseShareHash, EXAMPLE_CURVES } from './components/SavedCurves';
import CurveHeader from './components/CurveHeader';
import { normalizeCurve } from './utils/curves';
import { deriveSimpleLandmarks } from './utils/landmarks';
import { calculateEnergy, calculateAveragePower, estimateFinishTime, calculateEnergyPenalty } from './utils/physics';
import referenceCurveData from './data/referenceCurve.json';
import './App.css';

const STORAGE_KEY = 'freespeed_curves';
const RAW_AVG_SPEED = referenceCurveData.speeds.reduce((a, b) => a + b, 0) / referenceCurveData.speeds.length;
const RACE_DISTANCE = 2000;

function App() {
  const [curveARaw] = useState({
    times: referenceCurveData.times,
    speeds: referenceCurveData.speeds,
  });

  const [landmarks] = useState(
    deriveSimpleLandmarks(referenceCurveData.times, referenceCurveData.speeds)
  );

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
    const normalizedSpeeds = normalizeCurve(curveB.speeds, targetAvgSpeed);
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
    if (!viewingCurve || viewingCurve.isExample) {
      // Save as a new entry (also covers: saving a modified example as a new curve)
      const resolvedName = (name || 'Untitled') === (viewingCurve?.name ?? '')
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

  const avgPowerA = calculateAveragePower(curveA.times, curveA.speeds);
  const avgPowerBNorm = calculateAveragePower(curveBNormalized.times, curveBNormalized.speeds);
  const estimate = estimateFinishTime(raceTime, avgPowerA, avgPowerBNorm);
  const energyA = calculateEnergy(curveA.times, curveA.speeds);
  const energyBNorm = calculateEnergy(curveBNormalized.times, curveBNormalized.speeds);
  const penalty = calculateEnergyPenalty(energyBNorm * raceTime, energyA * raceTime);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Free Speed Calculator</h1>
        <p className="subtitle">
          How much time are you leaving on the water? Draw a boat speed profile and see how
          a smoother stroke — same average speed, less energy — translates to a faster finish time.
        </p>
      </header>

      <div className="app-content">
        <SavedCurves
          onLoad={handleLoadCurve}
          onNew={handleNewCurve}
          onDuplicate={handleDuplicateExample}
          viewingCurveId={viewingCurve?.id}
          refreshKey={refreshKey}
        />

        <div className="main-content">
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

          <SpeedChart
            curveA={curveA}
            curveB={curveBNormalized}
            onCurveBChange={handleCurveBChange}
            onReset={handleReset}
            landmarks={landmarks}
            landmarksB={deriveSimpleLandmarks(curveBNormalized.times, curveBNormalized.speeds)}
            energyPenaltyPercent={penalty.percentPenalty}
            strokeRate={strokeRate}
            onStrokeRateChange={setStrokeRate}
            isNewCurve={!viewingCurve}
          />

          <BoatVisualization
            timeDifference={estimate.timeDifference}
            avgVelocityA={targetAvgSpeed}
            raceTime={raceTime}
            onRaceTimeChange={setRaceTime}
            estimatedFinishTime={estimate.finishTime}
            energyPenaltyPercent={penalty.percentPenalty}
          />
        </div>
      </div>

      <footer className="app-footer">
        <p>
          <a href="/math.html" target="_blank" rel="noopener noreferrer">
            Mathematical background — energy-equivalence model, variables, and derivations
          </a>
        </p>
      </footer>
    </div>
  );
}

export default App;
