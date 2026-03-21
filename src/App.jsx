import { useState, useEffect } from 'react';
import SpeedChart from './components/SpeedChart';
import Controls from './components/Controls';
import Results from './components/Results';
import BoatVisualization from './components/BoatVisualization';
import { normalizeCurve, smoothCurve } from './utils/curves';
import { deriveSimpleLandmarks } from './utils/landmarks';
import { calculateEnergy, calculateAveragePower, estimateFinishTime } from './utils/physics';
import referenceCurveData from './data/referenceCurve.json';
import './App.css';

function App() {
  // Load reference curve (Curve A)
  const [curveA] = useState({
    times: referenceCurveData.times,
    speeds: referenceCurveData.speeds,
  });

  // Derive landmarks from Curve A
  const [landmarks] = useState(
    deriveSimpleLandmarks(referenceCurveData.times, referenceCurveData.speeds)
  );

  // Initialize Curve B as a copy of Curve A
  const [curveB, setCurveB] = useState({
    times: [...referenceCurveData.times],
    speeds: [...referenceCurveData.speeds],
  });

  // Store Curve B's stroke duration separately (can be different from Curve A)
  const [curveBStrokeDuration, setCurveBStrokeDuration] = useState(
    referenceCurveData.times[referenceCurveData.times.length - 1]
  );

  // Normalized version of Curve B (matched to Curve A's average)
  const [curveBNormalized, setCurveBNormalized] = useState({
    times: [...referenceCurveData.times],
    speeds: [...referenceCurveData.speeds],
  });


  // Race parameters - calculate finish time from Curve A's average velocity
  const avgVelocityA = referenceCurveData.metadata.avgSpeed;
  const raceDistance = 2000; // meters
  const calculatedFinishTime = raceDistance / avgVelocityA; // seconds

  const raceParams = {
    raceDistance: raceDistance,
    raceTime: calculatedFinishTime,
  };

  // Auto-normalize Curve B whenever it changes
  useEffect(() => {
    const avgA = curveA.speeds.reduce((a, b) => a + b, 0) / curveA.speeds.length;
    const normalizedSpeeds = normalizeCurve(curveB.speeds, avgA);

    setCurveBNormalized({
      times: curveB.times,
      speeds: normalizedSpeeds,
    });
  }, [curveB, curveA]);

  const handleCurveBChange = (newSpeeds) => {
    // Enforce periodic boundary: end value must match start value
    const correctedSpeeds = [...newSpeeds];
    correctedSpeeds[correctedSpeeds.length - 1] = correctedSpeeds[0];

    setCurveB({
      times: curveB.times,
      speeds: correctedSpeeds,
    });
  };

  const handleReset = () => {
    // Reset Curve B to match Curve A
    setCurveB({
      times: [...curveA.times],
      speeds: [...curveA.speeds],
    });
  };

  const handleSmooth = () => {
    // Apply smoothing to Curve B
    const smoothed = smoothCurve(curveB.speeds, 5);

    // Enforce periodic boundary: end value must match start value
    smoothed[smoothed.length - 1] = smoothed[0];

    setCurveB({
      times: curveB.times,
      speeds: smoothed,
    });
  };

  const handleStrokeDurationChange = (newDuration) => {
    // Update stroke duration and rescale time axis
    setCurveBStrokeDuration(newDuration);

    // Rescale the time points
    const numPoints = curveB.times.length;
    const newTimes = Array.from({ length: numPoints }, (_, i) =>
      (i / (numPoints - 1)) * newDuration
    );

    setCurveB({
      times: newTimes,
      speeds: curveB.speeds, // Keep same speed values, just stretched/compressed over time
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Dynamic Energy-Equivalence Modeling for Rowing</h1>
        <p className="subtitle">
          Analyze how intra-stroke velocity variation affects metabolic cost and race performance.
          Due to the cubic power-velocity relationship (P ∝ v³), identical average speeds can
          result in vastly different energy expenditures.
        </p>
      </header>

      <div className="app-content">
        <div className="sidebar">
          <Controls
            curveA={curveA}
            curveB={curveB}
            curveBNormalized={curveBNormalized}
            onReset={handleReset}
            onSmooth={handleSmooth}
          />
        </div>

        <div className="main-content">
          <SpeedChart
            curveA={curveA}
            curveB={curveB}
            onCurveBChange={handleCurveBChange}
            onStrokeDurationChange={handleStrokeDurationChange}
            landmarks={landmarks}
          />

          {(() => {
            // Calculate time difference for boat visualization
            const { times: timesA, speeds: speedsA } = curveA;
            const { speeds: speedsBNorm } = curveBNormalized;
            const avgPowerA = calculateAveragePower(timesA, speedsA);
            const avgPowerBNorm = calculateAveragePower(timesA, speedsBNorm);
            const estimate = estimateFinishTime(raceParams.raceTime, avgPowerA, avgPowerBNorm);

            return (
              <>
                <BoatVisualization
                  timeDifference={estimate.timeDifference}
                  avgVelocityA={avgVelocityA}
                />

                <Results
                  curveA={curveA}
                  curveB={curveB}
                  curveBNormalized={curveBNormalized}
                  raceParams={raceParams}
                />
              </>
            );
          })()}
        </div>
      </div>

      <footer className="app-footer">
        <p>
          <strong>Reference:</strong> Curve A represents measured data from Speed Curve.xlsx.
          Draw Curve B to model alternative velocity profiles and compare energy efficiency.
        </p>
        <p>
          <strong>Formula:</strong> T_B = T_A × (P̄_B / P̄_A)^(1/3) where P = k·v³
        </p>
      </footer>
    </div>
  );
}

export default App;
