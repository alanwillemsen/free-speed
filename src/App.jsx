import { useState, useEffect } from 'react';
import Parameters from './components/Parameters';
import SpeedChart from './components/SpeedChart';
import Results from './components/Results';
import { generateOptimalCurve, smoothCurve } from './utils/curves';
import { calibrateDragCoefficient } from './utils/physics';
import './App.css';

function App() {
  const [params, setParams] = useState({
    strokeRate: 30, // strokes per minute
    raceDistance: 2000, // meters
    targetTime: 7, // minutes
  });

  const [optimalCurve, setOptimalCurve] = useState([]);
  const [userCurve, setUserCurve] = useState([]);

  const numPoints = 100;

  // Recalculate curves when parameters change
  useEffect(() => {
    const strokeTime = 60 / params.strokeRate; // seconds
    const avgVelocity = params.raceDistance / (params.targetTime * 60); // m/s

    // Calibrate physics model
    calibrateDragCoefficient(avgVelocity);

    // Generate new optimal curve
    const newOptimalCurve = generateOptimalCurve(avgVelocity, strokeTime, numPoints);
    setOptimalCurve(newOptimalCurve);

    // Reset user curve to optimal
    setUserCurve([...newOptimalCurve]);
  }, [params]);

  const handleParamsChange = (newParams) => {
    setParams(newParams);
  };

  const handleUserCurveChange = (newCurve) => {
    // Apply smoothing to prevent jagged curves
    const smoothed = smoothCurve(newCurve, 5);
    setUserCurve(smoothed);
  };

  const handleResetCurve = () => {
    setUserCurve([...optimalCurve]);
  };

  const strokeTime = 60 / params.strokeRate;
  const avgVelocity = params.raceDistance / (params.targetTime * 60);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Rowing Speed Curve Analysis</h1>
        <p className="subtitle">
          Explore how hull speed variation affects energy expenditure during rowing.
          Due to the cubic relationship between power and velocity (P = k·v³),
          varying speed requires more energy than maintaining constant velocity.
        </p>
      </header>

      <div className="app-content">
        <div className="sidebar">
          <Parameters params={params} onParamsChange={handleParamsChange} />

          <div className="controls">
            <button className="reset-button" onClick={handleResetCurve}>
              Reset to Optimal Curve
            </button>
          </div>

          <div className="info-box">
            <h3>How to Use</h3>
            <ol>
              <li>Adjust race parameters above</li>
              <li>Click and drag on the chart to modify the speed curve</li>
              <li>Observe energy differences below</li>
            </ol>
            <p className="note">
              <strong>Note:</strong> The optimal curve (teal) represents minimal
              speed variation. Try drawing curves with greater variation to see
              the energy penalty!
            </p>
          </div>
        </div>

        <div className="main-content">
          <SpeedChart
            optimalCurve={optimalCurve}
            userCurve={userCurve}
            onUserCurveChange={handleUserCurveChange}
            strokeTime={strokeTime}
            avgVelocity={avgVelocity}
          />

          <Results
            optimalCurve={optimalCurve}
            userCurve={userCurve}
            params={params}
          />
        </div>
      </div>

      <footer className="app-footer">
        <p>
          Physics Principle: Energy = ∫ P dt = ∫ (k·v³) dt.
          Minimizing speed variation minimizes energy for a given average velocity.
        </p>
      </footer>
    </div>
  );
}

export default App;
