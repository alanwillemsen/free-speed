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
        <div className="footer-links">
          <a href="/math.html" target="_blank" rel="noopener noreferrer">
            Mathematical background — energy-equivalence model, variables, and derivations
          </a>
          <a href="https://github.com/alanwillemsen/free-speed" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository">
            <svg height="20" width="20" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
                .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
                -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
                .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
                .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
                0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
        </div>
      </footer>
    </div>
  );
}

export default App;
