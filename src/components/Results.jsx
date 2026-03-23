import { useState } from 'react';
import {
  calculateEnergy,
  calculateAveragePower,
  calculateEnergyPenalty
} from '../utils/physics';

function parseTime(str) {
  const parts = str.split(':');
  if (parts.length !== 2) return null;
  const mins = parseInt(parts[0], 10);
  const secs = parseFloat(parts[1]);
  if (isNaN(mins) || isNaN(secs)) return null;
  return mins * 60 + secs;
}

function formatTime(seconds) {
  const tenths = Math.round(seconds * 10);
  const mins = Math.floor(tenths / 600);
  const secs = (tenths % 600) / 10;
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
}

function formatTimeDiff(seconds) {
  const sign = seconds >= 0 ? '+' : '';
  return `${sign}${seconds.toFixed(1)}s`;
}

function Results({ curveA, curveBNormalized, raceTime, onRaceTimeChange, finishTimeEstimate }) {
  const [inputValue, setInputValue] = useState(formatTime(raceTime));

  const { times: timesA, speeds: speedsA } = curveA;
  const { times: timesB, speeds: speedsBNorm } = curveBNormalized;

  const energyA = calculateEnergy(timesA, speedsA);
  const energyBNorm = calculateEnergy(timesB, speedsBNorm);

  const totalRaceEnergyA = energyA * raceTime;
  const totalRaceEnergyBNorm = energyBNorm * raceTime;
  const penalty = calculateEnergyPenalty(totalRaceEnergyBNorm, totalRaceEnergyA);

  const isWorse = finishTimeEstimate.timeDifference > 0;

  const handleBlur = () => {
    const seconds = parseTime(inputValue);
    if (seconds && seconds > 0) {
      onRaceTimeChange(seconds);
      setInputValue(formatTime(seconds));
    } else {
      setInputValue(formatTime(raceTime));
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') e.target.blur();
  };

  return (
    <div className="results">
      <h2>Energy Equivalence Analysis</h2>

      <div className="results-grid">
        <div className="result-section prediction">
          <h3>Rower A (Good Technique)</h3>
          <div className="metric">
            <span className="metric-label">2km Finish Time:</span>
            <input
              className="time-input"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder="m:ss.s"
            />
          </div>
        </div>

        <div className="result-section prediction">
          <h3>Rower B — Equivalent Finish Time</h3>
          <p className="explanation">
            Same energy budget as Rower A, using Rower B's velocity profile:
          </p>
          <div className="metric highlight">
            <span className="metric-label">Estimated Finish Time:</span>
            <span className={`metric-value ${isWorse ? 'worse' : 'better'}`}>
              {formatTime(finishTimeEstimate.finishTime)}
            </span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Time Difference:</span>
            <span className={`metric-value ${isWorse ? 'worse' : 'better'}`}>
              {formatTimeDiff(finishTimeEstimate.timeDifference)}
            </span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Race Energy Penalty:</span>
            <span className={`metric-value ${penalty.penalty > 0 ? 'penalty' : 'bonus'}`}>
              {penalty.percentPenalty > 0 ? '+' : ''}{penalty.percentPenalty.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Results;
