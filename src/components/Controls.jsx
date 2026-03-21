import { calculateAverageVelocity, calculateCurveStats } from '../utils/curves';

function Controls({ curveA, curveB, curveBNormalized, onReset, onSmooth }) {
  const avgA = calculateAverageVelocity(curveA.speeds);
  const avgB = calculateAverageVelocity(curveB.speeds);
  const avgBNorm = calculateAverageVelocity(curveBNormalized.speeds);

  const statsA = calculateCurveStats(curveA.speeds);
  const statsB = calculateCurveStats(curveB.speeds);
  const statsBNorm = calculateCurveStats(curveBNormalized.speeds);

  return (
    <div className="controls">
      <h2>Curve Controls</h2>

      <div className="control-buttons">
        <button className="btn btn-secondary" onClick={onSmooth}>
          Smooth Curve B
        </button>
        <button className="btn btn-secondary" onClick={onReset}>
          Reset Curve B
        </button>
      </div>

      <div className="curve-stats">
        <h3>Curve Statistics</h3>

        <div className="stats-section">
          <h4>Curve A (Reference)</h4>
          <div className="stat-row">
            <span className="stat-label">Average:</span>
            <span className="stat-value">{statsA.avg.toFixed(3)} m/s</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Range:</span>
            <span className="stat-value">
              {statsA.min.toFixed(2)} - {statsA.max.toFixed(2)} m/s
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Variation:</span>
            <span className="stat-value">{statsA.range.toFixed(2)} m/s</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Std Dev:</span>
            <span className="stat-value">{statsA.stdDev.toFixed(3)} m/s</span>
          </div>
        </div>

        <div className="stats-section">
          <h4>Curve B (Test)</h4>
          <div className="stat-row">
            <span className="stat-label">Stroke Duration:</span>
            <span className="stat-value">
              {curveB.times[curveB.times.length - 1].toFixed(2)} s
              ({(60 / curveB.times[curveB.times.length - 1]).toFixed(1)} spm)
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Average:</span>
            <span className="stat-value">
              {statsB.avg.toFixed(3)} m/s
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Range:</span>
            <span className="stat-value">
              {statsB.min.toFixed(2)} - {statsB.max.toFixed(2)} m/s
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Variation:</span>
            <span className="stat-value">{statsB.range.toFixed(2)} m/s</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Std Dev:</span>
            <span className="stat-value">{statsB.stdDev.toFixed(3)} m/s</span>
          </div>
        </div>

        <div className="stats-comparison">
          <h4>Comparison (B vs A)</h4>
          <div className="stat-row">
            <span className="stat-label">Variation Ratio:</span>
            <span className="stat-value">
              {(statsB.range / statsA.range).toFixed(2)}x
              {statsB.range > statsA.range && (
                <span className="info-badge">More variable</span>
              )}
              {statsB.range < statsA.range && (
                <span className="success-badge">Less variable</span>
              )}
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Std Dev Ratio:</span>
            <span className="stat-value">{(statsB.stdDev / statsA.stdDev).toFixed(2)}x</span>
          </div>
        </div>
      </div>

      <div className="info-box">
        <h3>How to Use</h3>
        <ol>
          <li><strong>Draw Curve B:</strong> Click and drag on the chart to draw your test curve freehand</li>
          <li><strong>Smooth (optional):</strong> If your drawn curve is jagged, click "Smooth Curve B"</li>
          <li><strong>View Results:</strong> The comparison updates automatically as you draw</li>
          <li><strong>Iterate:</strong> Reset and try different curve shapes to understand velocity variation effects</li>
        </ol>
      </div>
    </div>
  );
}

export default Controls;
