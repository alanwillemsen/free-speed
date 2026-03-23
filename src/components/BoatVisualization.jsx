import { useState } from 'react';

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

function BoatVisualization({ timeDifference, avgVelocityA, raceTime, onRaceTimeChange, energyPenaltyPercent, estimatedFinishTime }) {
  const [inputValue, setInputValue] = useState(formatTime(raceTime));

  const boatLength = 8;
  const raceDistance = 2000;

  const distanceDifference = Math.abs(avgVelocityA * timeDifference);
  const isCurveBFaster = timeDifference < 0;

  const svgWidth = 800;
  const svgHeight = 200;
  const trackHeight = 60;
  const trackY = (svgHeight - trackHeight) / 2;
  const visibleDistance = 100;
  const scale = svgWidth / visibleDistance;
  const boatLengthPx = boatLength * scale;
  const boatHeight = 20;

  const finishLineX = svgWidth - 60;
  const winnerPosition = finishLineX;
  const loserPosition = finishLineX - (distanceDifference * scale);

  const boatAPosition = isCurveBFaster ? loserPosition : winnerPosition;
  const boatBPosition = isCurveBFaster ? winnerPosition : loserPosition;
  const absDifference = distanceDifference;

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

  const isWorse = timeDifference > 0;

  return (
    <div className="boat-visualization">
      <h3>Race Finish Visualization</h3>

      <div className="race-metrics">
        <div className="race-metric">
          <span className="race-metric-label">Rower A finish time:</span>
          <input
            className="time-input"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="m:ss.s"
          />
        </div>
        <div className="race-metric">
          <span className="race-metric-label">Rower B equivalent:</span>
          <span className={`race-metric-value ${isWorse ? 'worse' : absDifference < 0.1 ? '' : 'better'}`}>
            {formatTime(estimatedFinishTime)}
          </span>
        </div>
        <div className="race-metric">
          <span className="race-metric-label">Time difference:</span>
          <span className={`race-metric-value ${isWorse ? 'worse' : absDifference < 0.1 ? '' : 'better'}`}>
            {absDifference < 0.1 ? '0.0s' : formatTimeDiff(timeDifference)}
          </span>
        </div>
        <div className="race-metric">
          <span className="race-metric-label">Energy penalty:</span>
          <span className={`race-metric-value ${energyPenaltyPercent > 0.1 ? 'worse' : energyPenaltyPercent < -0.1 ? 'better' : ''}`}>
            {energyPenaltyPercent > 0 ? '+' : ''}{(Math.round(energyPenaltyPercent * 10) / 10 || 0).toFixed(1)}%
          </span>
        </div>
      </div>

      <p className="viz-description">
        {absDifference < 0.1
          ? 'Both velocity profiles require the same energy — boats finish together.'
          : <>If both rowers expend the same total energy, {isCurveBFaster ? 'Rower B finishes ahead' : 'Rower A finishes ahead'} by <span className="distance-diff">{absDifference.toFixed(1)}m</span>.</>
        }
      </p>

      <svg width={svgWidth} height={svgHeight} className="boat-svg">
        <rect x="0" y={trackY} width={svgWidth} height={trackHeight} fill="#E3F2FD" stroke="#90CAF9" strokeWidth="1" />

        <line x1={finishLineX} y1={trackY} x2={finishLineX} y2={trackY + trackHeight} stroke="#FF5722" strokeWidth="4" strokeDasharray="5,5" />
        <text x={finishLineX + 5} y={trackY - 5} fontSize="12" fontWeight="bold" fill="#FF5722">FINISH</text>

        {[1920, 1940, 1960, 1980, 2000].map(dist => {
          const x = finishLineX - ((raceDistance - dist) * scale);
          return (
            <g key={dist}>
              <line x1={x} y1={trackY + trackHeight} x2={x} y2={trackY + trackHeight + 5} stroke="#999" strokeWidth="1" />
              <text x={x} y={trackY + trackHeight + 18} fontSize="10" fill="#666" textAnchor="middle">{dist}m</text>
            </g>
          );
        })}

        {/* Boat A */}
        <g>
          <rect x={boatAPosition - boatLengthPx} y={trackY + 10} width={boatLengthPx} height={boatHeight} fill="rgba(75, 192, 192, 0.9)" stroke="rgba(75, 192, 192, 1)" strokeWidth="2" rx="3" />
          <polygon points={`${boatAPosition},${trackY + 10 + boatHeight / 2} ${boatAPosition - 10},${trackY + 10} ${boatAPosition - 10},${trackY + 10 + boatHeight}`} fill="rgba(75, 192, 192, 0.9)" stroke="rgba(75, 192, 192, 1)" strokeWidth="2" />
          <text x={boatAPosition - boatLengthPx / 2} y={trackY + 20 + boatHeight / 2} fontSize="11" fontWeight="bold" fill="white" textAnchor="middle">Rower A</text>
        </g>

        {/* Boat B */}
        <g>
          <rect x={boatBPosition - boatLengthPx} y={trackY + 30} width={boatLengthPx} height={boatHeight} fill="rgba(255, 99, 132, 0.9)" stroke="rgba(255, 99, 132, 1)" strokeWidth="2" rx="3" />
          <polygon points={`${boatBPosition},${trackY + 30 + boatHeight / 2} ${boatBPosition - 10},${trackY + 30} ${boatBPosition - 10},${trackY + 30 + boatHeight}`} fill="rgba(255, 99, 132, 0.9)" stroke="rgba(255, 99, 132, 1)" strokeWidth="2" />
          <text x={boatBPosition - boatLengthPx / 2} y={trackY + 40 + boatHeight / 2} fontSize="11" fontWeight="bold" fill="white" textAnchor="middle">Rower B</text>
        </g>

        {absDifference > 1 && (
          <g>
            <line x1={boatBPosition} y1={trackY + trackHeight + 30} x2={boatAPosition} y2={trackY + trackHeight + 30} stroke="#666" strokeWidth="2" markerEnd="url(#arrowhead)" markerStart="url(#arrowhead)" />
            <text x={(boatBPosition + boatAPosition) / 2} y={trackY + trackHeight + 45} fontSize="12" fontWeight="bold" fill="#333" textAnchor="middle">{absDifference.toFixed(1)}m</text>
          </g>
        )}

        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
            <polygon points="0 0, 10 5, 0 10" fill="#666" />
          </marker>
        </defs>
      </svg>

      {absDifference < 0.1 && <p className="viz-note">≈ Curves have similar efficiency profiles.</p>}
      {absDifference >= 0.1 && isCurveBFaster && <p className="viz-note success">✓ Rower B is more efficient and would finish ahead!</p>}
      {absDifference >= 0.1 && !isCurveBFaster && <p className="viz-note warning">⚠ Rower B is less efficient and would finish behind.</p>}
    </div>
  );
}

export default BoatVisualization;
