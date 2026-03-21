import { calculateEnergy, estimateFinishTime } from '../utils/physics';
import { calculateAverageVelocity } from '../utils/curves';

function Results({ optimalCurve, userCurve, params }) {
  const strokeTime = 60 / params.strokeRate;
  const targetAvgVelocity = params.raceDistance / (params.targetTime * 60);
  const totalStrokes = Math.round((params.targetTime * 60) / strokeTime);

  // Calculate energies
  const optimalEnergy = calculateEnergy(optimalCurve, strokeTime);
  const userEnergy = calculateEnergy(userCurve, strokeTime);
  const energyDiff = userEnergy - optimalEnergy;
  const energyDiffPercent = (energyDiff / optimalEnergy) * 100;

  // Calculate user's actual average velocity
  const userAvgVelocity = calculateAverageVelocity(userCurve);
  const velocityDiff = userAvgVelocity - targetAvgVelocity;

  // Estimate finish time if maintaining optimal energy budget
  const estimate = estimateFinishTime(userCurve, optimalEnergy, {
    strokeTime,
    raceDistance: params.raceDistance,
    targetTime: params.targetTime * 60, // convert to seconds
  });

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
      <h2>Analysis Results</h2>

      <div className="results-grid">
        <div className="result-section optimal">
          <h3>Optimal Curve</h3>
          <div className="metric">
            <span className="metric-label">Energy per Stroke:</span>
            <span className="metric-value">{optimalEnergy.toFixed(1)} J</span>
          </div>
          <div className="metric">
            <span className="metric-label">Total Energy for Race:</span>
            <span className="metric-value">{(optimalEnergy * totalStrokes).toFixed(0)} J</span>
          </div>
          <div className="metric">
            <span className="metric-label">Average Velocity:</span>
            <span className="metric-value">{targetAvgVelocity.toFixed(2)} m/s</span>
          </div>
          <div className="metric">
            <span className="metric-label">Finish Time:</span>
            <span className="metric-value">{formatTime(params.targetTime * 60)}</span>
          </div>
        </div>

        <div className="result-section user">
          <h3>Your Curve</h3>
          <div className="metric">
            <span className="metric-label">Energy per Stroke:</span>
            <span className="metric-value">{userEnergy.toFixed(1)} J</span>
          </div>
          <div className="metric">
            <span className="metric-label">Total Energy for Race:</span>
            <span className="metric-value">{(userEnergy * totalStrokes).toFixed(0)} J</span>
          </div>
          <div className="metric">
            <span className="metric-label">Average Velocity:</span>
            <span className="metric-value">
              {userAvgVelocity.toFixed(2)} m/s
              {Math.abs(velocityDiff) > 0.01 && (
                <span className={`diff ${velocityDiff > 0 ? 'positive' : 'negative'}`}>
                  {' '}({velocityDiff > 0 ? '+' : ''}{velocityDiff.toFixed(2)} m/s)
                </span>
              )}
            </span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Energy Difference:</span>
            <span className={`metric-value ${energyDiff > 0 ? 'worse' : 'better'}`}>
              {energyDiff > 0 ? '+' : ''}{energyDiff.toFixed(1)} J
              ({energyDiffPercent > 0 ? '+' : ''}{energyDiffPercent.toFixed(1)}%)
            </span>
          </div>
        </div>

        <div className="result-section comparison">
          <h3>Energy Budget Analysis</h3>
          <p className="explanation">
            If you maintain the optimal energy per stroke ({optimalEnergy.toFixed(1)} J):
          </p>
          <div className="metric highlight">
            <span className="metric-label">Achievable Velocity:</span>
            <span className="metric-value">{estimate.achievableAvgVelocity.toFixed(2)} m/s</span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Estimated Finish Time:</span>
            <span className="metric-value">
              {formatTime(estimate.finishTime)}
            </span>
          </div>
          <div className="metric highlight">
            <span className="metric-label">Time vs Target:</span>
            <span className={`metric-value ${estimate.timeDifference > 0 ? 'worse' : 'better'}`}>
              {formatTimeDiff(estimate.timeDifference)}
            </span>
          </div>
        </div>
      </div>

      <div className="insights">
        <h3>Key Insights</h3>
        <ul>
          {energyDiff > optimalEnergy * 0.05 && (
            <li className="insight-warning">
              Your curve requires {energyDiffPercent.toFixed(1)}% more energy due to speed
              variation. The cubic relationship between power and velocity means varying
              speed is energetically expensive.
            </li>
          )}
          {Math.abs(velocityDiff) > 0.1 && (
            <li className="insight-info">
              Your average velocity differs from target by {Math.abs(velocityDiff).toFixed(2)} m/s.
              This affects both finish time and energy requirements.
            </li>
          )}
          {energyDiff < optimalEnergy * 0.02 && energyDiff > 0 && (
            <li className="insight-success">
              Your curve is very close to optimal efficiency! Speed variation is minimal.
            </li>
          )}
          {estimate.timeDifference < -5 && (
            <li className="insight-success">
              With optimal energy usage, your curve could achieve a finish time
              {Math.abs(estimate.timeDifference).toFixed(1)}s faster than target!
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

export default Results;
