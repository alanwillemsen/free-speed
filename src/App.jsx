import { useState, useEffect } from 'react';
import SpeedChart from './components/SpeedChart';
import BoatVisualization from './components/BoatVisualization';
import { normalizeCurve } from './utils/curves';
import { deriveSimpleLandmarks } from './utils/landmarks';
import { calculateEnergy, calculateAveragePower, estimateFinishTime, calculateEnergyPenalty } from './utils/physics';
import referenceCurveData from './data/referenceCurve.json';
import './App.css';

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

  // User-entered finish time for Curve A (seconds), default 6:30
  const [raceTime, setRaceTime] = useState(390);

  // Stroke rate for x-axis display (strokes per minute), default 36
  const [strokeRate, setStrokeRate] = useState(36);

  // Scale Curve A's shape to match the target average speed
  const targetAvgSpeed = RACE_DISTANCE / raceTime;
  const speedScale = targetAvgSpeed / RAW_AVG_SPEED;
  const curveA = {
    times: curveARaw.times,
    speeds: curveARaw.speeds.map(s => s * speedScale),
  };

  const [curveB, setCurveB] = useState({
    times: [...referenceCurveData.times],
    speeds: curveARaw.speeds.map(s => s * speedScale),
  });

  const [curveBNormalized, setCurveBNormalized] = useState({
    times: [...referenceCurveData.times],
    speeds: curveARaw.speeds.map(s => s * speedScale),
  });

  // Re-normalize Curve B whenever curveB or raceTime changes
  useEffect(() => {
    const normalizedSpeeds = normalizeCurve(curveB.speeds, targetAvgSpeed);
    setCurveBNormalized({ times: curveB.times, speeds: normalizedSpeeds });
  }, [curveB, raceTime]);


  const handleCurveBChange = (newSpeeds) => {
    const correctedSpeeds = [...newSpeeds];
    correctedSpeeds[correctedSpeeds.length - 1] = correctedSpeeds[0];
    setCurveB({ times: curveB.times, speeds: correctedSpeeds });
  };

  const handleReset = () => {
    setCurveB({ times: [...curveA.times], speeds: [...curveA.speeds] });
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
        <div className="main-content">
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
