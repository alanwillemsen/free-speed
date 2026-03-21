import {
  calculateEnergy,
  calculateAveragePower,
  estimateFinishTime,
  calculateEnergyPenalty
} from '../utils/physics';
import { calculateAverageVelocity } from '../utils/curves';

function Results({ curveA, curveB, curveBNormalized, raceParams }) {
  const { times: timesA, speeds: speedsA } = curveA;
  const { times: timesB, speeds: speedsB } = curveB;
  const { speeds: speedsBNorm } = curveBNormalized;

  // Calculate energies and powers
  const energyA = calculateEnergy(timesA, speedsA);
  const energyB = calculateEnergy(timesB, speedsB);
  const energyBNorm = calculateEnergy(timesB, speedsBNorm);

  const avgPowerA = calculateAveragePower(timesA, speedsA);
  const avgPowerBNorm = calculateAveragePower(timesB, speedsBNorm);

  // Calculate average velocities
  const avgVelocityA = calculateAverageVelocity(speedsA);
  const avgVelocityB = calculateAverageVelocity(speedsB);
  const avgVelocityBNorm = calculateAverageVelocity(speedsBNorm);

  // Calculate stroke duration
  const strokeDuration = timesA[timesA.length - 1] - timesA[0];

  // Calculate race energy
  const strokesPerRace = raceParams.raceTime / strokeDuration;
  const totalRaceEnergyA = energyA * strokesPerRace;
  const totalRaceEnergyBNorm = energyBNorm * strokesPerRace;

  // Estimate finish time for Curve B with same energy budget
  const finishTimeEstimate = estimateFinishTime(
    raceParams.raceTime,
    avgPowerA,
    avgPowerBNorm
  );

  // Calculate energy penalty
  const penalty = calculateEnergyPenalty(energyBNorm, energyA);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins}:${secs.padStart(4, '0')}`;
  };

  const formatTimeDiff = (seconds) => {
    const sign = seconds >= 0 ? '+' : '';
    return `${sign}${seconds.toFixed(1)}s`;
  };

  return (
    <div className="results">
      <h2>Energy Equivalence Analysis</h2>

      <div className="results-grid">
        {/* Curve A Stats */}
        <div className="result-section curve-a">
          <h3>Curve A (Reference)</h3>
          <div className="metric">
            <span className="metric-label">Average Velocity:</span>
            <span className="metric-value">{avgVelocityA.toFixed(3)} m/s</span>
          </div>
          <div className="metric">
            <span className="metric-label">Energy per Stroke:</span>
            <span className="metric-value">{energyA.toFixed(1)} J</span>
          </div>
          <div className="metric">
            <span className="metric-label">Average Power:</span>
            <span className="metric-value">{avgPowerA.toFixed(1)} W</span>
          </div>
          <div className="metric">
            <span className="metric-label">Total Race Energy:</span>
            <span className="metric-value">{(totalRaceEnergyA / 1000).toFixed(1)} kJ</span>
          </div>
          <div className="metric">
            <span className="metric-label">2km Finish Time:</span>
            <span className="metric-value">{formatTime(raceParams.raceTime)}</span>
          </div>
        </div>

        {/* Curve B Stats (Current) */}
        <div className="result-section curve-b-current">
          <h3>Curve B (Current)</h3>
          <div className="metric">
            <span className="metric-label">Average Velocity:</span>
            <span className="metric-value">
              {avgVelocityB.toFixed(3)} m/s
              {Math.abs(avgVelocityB - avgVelocityA) > 0.01 && (
                <span className="diff-note"> (not normalized)</span>
              )}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">Energy per Stroke:</span>
            <span className="metric-value">{energyB.toFixed(1)} J</span>
          </div>
        </div>

        {/* Curve B Normalized */}
        <div className="result-section curve-b-norm">
          <h3>Curve B (Normalized to Curve A)</h3>
          <div className="metric">
            <span className="metric-label">Average Velocity:</span>
            <span className="metric-value">{avgVelocityBNorm.toFixed(3)} m/s</span>
          </div>
          <div className="metric">
            <span className="metric-label">Energy per Stroke:</span>
            <span className="metric-value">{energyBNorm.toFixed(1)} J</span>
          </div>
          <div className="metric">
            <span className="metric-label">Average Power:</span>
            <span className="metric-value">{avgPowerBNorm.toFixed(1)} W</span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Energy Penalty:</span>
            <span className={`metric-value ${penalty.penalty > 0 ? 'penalty' : 'bonus'}`}>
              {penalty.penalty > 0 ? '+' : ''}{penalty.penalty.toFixed(1)} J
              ({penalty.percentPenalty > 0 ? '+' : ''}{penalty.percentPenalty.toFixed(1)}%)
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">Total Race Energy:</span>
            <span className="metric-value">{(totalRaceEnergyBNorm / 1000).toFixed(1)} kJ</span>
          </div>
        </div>

        {/* Energy Budget Prediction */}
        <div className="result-section prediction">
          <h3>Equivalent Finish Time Prediction</h3>
          <p className="explanation">
            If the rower uses Curve B's efficiency profile but maintains Curve A's
            total energy budget ({(totalRaceEnergyA / 1000).toFixed(1)} kJ):
          </p>
          <div className="metric highlight">
            <span className="metric-label">Estimated Finish Time:</span>
            <span className={`metric-value ${finishTimeEstimate.timeDifference > 0 ? 'worse' : 'better'}`}>
              {formatTime(finishTimeEstimate.finishTime)}
            </span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Time Difference:</span>
            <span className={`metric-value ${finishTimeEstimate.timeDifference > 0 ? 'worse' : 'better'}`}>
              {formatTimeDiff(finishTimeEstimate.timeDifference)}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">Power Ratio (B/A):</span>
            <span className="metric-value">{finishTimeEstimate.ratio.toFixed(4)}</span>
          </div>
        </div>
      </div>

      {/* Insights */}
      <div className="insights">
        <h3>Key Insights</h3>
        <ul>
          {penalty.percentPenalty > 5 && (
            <li className="insight-warning">
              <strong>High Energy Penalty:</strong> Curve B requires {penalty.percentPenalty.toFixed(1)}%
              more energy than Curve A at the same average velocity due to greater speed variation.
              This is caused by the cubic power-velocity relationship (P ∝ v³).
            </li>
          )}
          {penalty.percentPenalty > 1 && penalty.percentPenalty <= 5 && (
            <li className="insight-info">
              <strong>Moderate Energy Penalty:</strong> Curve B shows {penalty.percentPenalty.toFixed(1)}%
              higher energy expenditure due to velocity fluctuations ("boat check").
            </li>
          )}
          {penalty.percentPenalty <= 1 && penalty.percentPenalty > -1 && (
            <li className="insight-success">
              <strong>Similar Efficiency:</strong> Curve B has nearly the same energy profile
              as Curve A. The velocity variation patterns are comparable.
            </li>
          )}
          {finishTimeEstimate.timeDifference > 5 && (
            <li className="insight-warning">
              <strong>Significant Time Impact:</strong> Using Curve B's efficiency profile
              with the same energy budget would result in a {formatTimeDiff(finishTimeEstimate.timeDifference)}
              slower finish time. Reducing "boat check" is critical for performance.
            </li>
          )}
          {finishTimeEstimate.timeDifference > 1 && finishTimeEstimate.timeDifference <= 5 && (
            <li className="insight-info">
              <strong>Measurable Time Impact:</strong> The efficiency difference translates
              to {formatTimeDiff(finishTimeEstimate.timeDifference)} in a 2km race.
            </li>
          )}
          <li className="insight-info">
            <strong>Physics Principle:</strong> Because power scales as v³, maintaining steadier
            boat speed throughout the stroke cycle minimizes energy waste and improves race times.
          </li>
        </ul>
      </div>

      {/* Calculation Details */}
      <div className="calculation-details">
        <h4>Calculation Methodology</h4>
        <p>
          Energy is calculated using: E = ∫ P(t) dt = ∫ k·v(t)³ dt
        </p>
        <p>
          Finish time estimate uses: T_B = T_A × (P̄_B / P̄_A)^(1/3)
        </p>
        <p>
          Stroke rate: {(60 / strokeDuration).toFixed(1)} strokes/min
        </p>
      </div>
    </div>
  );
}

export default Results;
