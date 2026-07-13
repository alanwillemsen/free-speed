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

// Rower icon from /public/rower.svg (1371 × 360 native).
// The hull occupies roughly the middle portion of the image; oars extend beyond.
// bowX = bow tip position, hullLen = hull length in px, cy = vertical centre, tint = CSS color.
// We scale the full image so that the hull portion matches hullLen, preserving aspect ratio.
const ICON_W = 1371;
const ICON_H = 360;
const ICON_ASPECT = ICON_W / ICON_H; // ≈ 3.81
// Measured from the actual SVG path coordinates:
// Hull stern ≈ x=210 (0.153), hull bow tip ≈ x=1336 (0.975)
const hullStartFraction = 0.153;
const hullEndFraction = 0.975;
const hullFraction = hullEndFraction - hullStartFraction; // 0.822

function RowerIcon({ bowX, hullLen, cy, tint }) {
  // Hull waterline sits at ≈ y=260 (0.722 of image height)
  const waterlineFraction = 0.722;

  const iconW = hullLen / hullFraction;
  const iconH = iconW / ICON_ASPECT;

  // Position so the bow tip aligns with bowX, and waterline aligns with cy
  const iconX = bowX - hullEndFraction * iconW;
  const iconY = cy - waterlineFraction * iconH;

  return (
    <image
      href="/rower.svg"
      x={iconX}
      y={iconY}
      width={iconW}
      height={iconH}
      preserveAspectRatio="xMidYMid meet"
      style={{ filter: tint ? `drop-shadow(0 0 0 ${tint})` : undefined, opacity: 0.85 }}
    />
  );
}

// show: 'all' (default) renders numbers + race graphic; 'metrics' just the
// numbers (for the calculator's side column); 'race' just the graphic (full
// width below, where the boats are big enough to read).
function BoatVisualization({ timeDifference, avgVelocityA, raceTime, onRaceTimeChange, energyPenaltyPercent, estimatedFinishTime, show = 'all' }) {
  const [inputValue, setInputValue] = useState(formatTime(raceTime));

  const boatLength = 8.2; // racing single (1x) length in metres
  const raceDistance = 2000;

  const distanceDifference = Math.abs(avgVelocityA * timeDifference);
  // timeDifference = potential - now, so it's negative in the usual case: the
  // smoother potential stroke finishes ahead of where you are now.
  const isPotentialFaster = timeDifference < 0;

  const svgWidth = 800;
  const svgHeight = 180;
  const trackHeight = 70;
  const trackY = 15;
  const boatAY = trackY + 18; // vertical center of boat A
  const boatBY = trackY + trackHeight - 18; // vertical center of boat B
  const buoyY = trackY + trackHeight / 2;

  const finishLineX = svgWidth - 50;
  const minVisibleDistance = 100;
  // The trailing boat needs room for: hull + oar overhang + label text + gap.
  // Label "Rower B" is ~55px at fontSize 11 in an 800px-wide SVG.
  // We solve: finishLineX - distDiff * scale - hullLen * scale - oarOverhang - labelPx - gap > 0
  // oar overhang = (hullStartFraction / hullFraction) * hullLen * scale ≈ 0.186 * hullLen * scale
  // Rearranging for scale: scale < finishLineX / (distDiff + hullLen * 1.186 + labelMetres)
  const oarFactor = 1 + hullStartFraction / hullFraction; // ≈ 1.186
  const labelPx = 70; // pixels needed for label text + gap
  // We need: loserBowX - hullLen*scale*oarFactor - labelPx > 0
  // loserBowX = finishLineX - distDiff * scale
  // So: finishLineX - distDiff*scale - hullLen*scale*oarFactor - labelPx > 0
  // scale * (distDiff + hullLen*oarFactor) < finishLineX - labelPx
  const maxScale = distanceDifference > 0
    ? (finishLineX - labelPx) / (distanceDifference + boatLength * oarFactor)
    : Infinity;
  const minScale = svgWidth / 1000; // don't zoom out beyond 1000m visible
  const defaultScale = svgWidth / Math.max(minVisibleDistance, distanceDifference + boatLength * oarFactor + 25);
  const scale = Math.max(minScale, Math.min(defaultScale, maxScale));
  const visibleDistance = svgWidth / scale;
  const boatLengthPx = boatLength * scale;

  const winnerPosition = finishLineX; // bow tip at finish
  const loserPosition = finishLineX - (distanceDifference * scale);

  // Boat A is "Your potential", Boat B is "You now": potential leads when faster.
  const boatAPosition = isPotentialFaster ? winnerPosition : loserPosition;
  const boatBPosition = isPotentialFaster ? loserPosition : winnerPosition;
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

  // Colour the potential/difference green when there's real time to gain,
  // red in the rare case your current stroke is already smoother than the reference.
  const resultClass = absDifference < 0.1 ? '' : isPotentialFaster ? 'better' : 'worse';

  const showMetrics = show !== 'race';
  const showRace = show !== 'metrics';

  return (
    <div className="boat-visualization">
      <h3>{showRace ? 'Race Finish Visualization' : 'Results'}</h3>

      {showMetrics && (
      <div className="race-metrics">
        <div className="race-metric">
          <span className="race-metric-label">Your current 2k time:</span>
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
          <span className="race-metric-label">Your potential 2k time:</span>
          <span className={`race-metric-value ${resultClass}`}>
            {formatTime(estimatedFinishTime)}
          </span>
        </div>
        <div className="race-metric">
          <span className="race-metric-label">Time difference:</span>
          <span className={`race-metric-value ${resultClass}`}>
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
      )}

      {showMetrics && (
      <p className="viz-description">
        {absDifference < 0.1
          ? 'Both velocity profiles require the same energy — boats finish together.'
          : <>With the same total energy, your potential finishes {isPotentialFaster ? 'ahead' : 'behind'} by <span className="distance-diff">{absDifference.toFixed(1)}m</span>.</>
        }
      </p>
      )}

      {showRace && (
      <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} width="100%" className="boat-svg">
        {/* Water */}
        <rect x="0" y={trackY} width={svgWidth} height={trackHeight} fill="#E3F2FD" stroke="#90CAF9" strokeWidth="1" />

        {/* Finish line */}
        <line x1={finishLineX} y1={trackY} x2={finishLineX} y2={trackY + trackHeight} stroke="#FF5722" strokeWidth="3" strokeDasharray="4,4" />
        <text x={finishLineX} y={trackY - 4} fontSize="11" fontWeight="bold" fill="#FF5722" textAnchor="middle">FINISH</text>

        {/* Distance markers */}
        {(() => {
          const step = visibleDistance <= 100 ? 20
            : visibleDistance <= 300 ? 50
            : visibleDistance <= 600 ? 100
            : 200;
          const marks = [];
          for (let d = raceDistance; d >= raceDistance - visibleDistance; d -= step) {
            marks.push(d);
          }
          return marks.map(dist => {
            const x = finishLineX - ((raceDistance - dist) * scale);
            return (
              <g key={dist}>
                <line x1={x} y1={trackY + trackHeight} x2={x} y2={trackY + trackHeight + 5} stroke="#999" strokeWidth="1" />
                <text x={x} y={trackY + trackHeight + 16} fontSize="10" fill="#666" textAnchor="middle">{dist}m</text>
              </g>
            );
          });
        })()}

        {/* Buoy lane markers */}
        {(() => {
          const buoys = [];
          const buoySpacing = 10;
          const redZone = raceDistance - 250;
          const startDist = Math.floor((raceDistance - visibleDistance) / buoySpacing) * buoySpacing;
          for (let d = startDist; d <= raceDistance; d += buoySpacing) {
            const x = finishLineX - ((raceDistance - d) * scale);
            if (x < -5 || x > svgWidth + 5) continue;
            const isRed = d >= redZone;
            buoys.push(
              <circle key={`buoy-${d}`} cx={x} cy={buoyY} r={2.5} fill={isRed ? '#dc2626' : '#eab308'} stroke={isRed ? '#991b1b' : '#a16207'} strokeWidth="0.8" />
            );
          }
          return buoys;
        })()}

        {/* Boat A */}
        <g>
          <RowerIcon bowX={boatAPosition} hullLen={boatLengthPx} cy={boatAY} />
          <text
            x={boatAPosition - boatLengthPx - 16}
            y={boatAY + 4}
            fontSize="11"
            fontWeight="bold"
            fill="rgba(45, 140, 140, 1)"
            textAnchor="end"
          >Your potential</text>
        </g>

        {/* Boat B */}
        <g>
          <RowerIcon bowX={boatBPosition} hullLen={boatLengthPx} cy={boatBY} />
          <text
            x={boatBPosition - boatLengthPx - 16}
            y={boatBY + 4}
            fontSize="11"
            fontWeight="bold"
            fill="rgba(200, 60, 90, 1)"
            textAnchor="end"
          >You now</text>
        </g>

        {/* Dimension line (architectural style) */}
        {absDifference > 1 && (() => {
          const dimY = trackY + trackHeight + 24;
          const tickH = 6;
          const leftX = Math.min(boatAPosition, boatBPosition);
          const rightX = Math.max(boatAPosition, boatBPosition);
          // Extension lines from bow balls down to dimension line
          const extTop = trackY + trackHeight + 4;
          return (
            <g stroke="#555" strokeWidth="1">
              {/* Extension lines */}
              <line x1={leftX} y1={extTop} x2={leftX} y2={dimY + tickH} />
              <line x1={rightX} y1={extTop} x2={rightX} y2={dimY + tickH} />
              {/* Dimension line */}
              <line x1={leftX} y1={dimY} x2={rightX} y2={dimY} />
              {/* Tick marks (perpendicular serifs) */}
              <line x1={leftX} y1={dimY - tickH} x2={leftX} y2={dimY + tickH} strokeWidth="1.5" />
              <line x1={rightX} y1={dimY - tickH} x2={rightX} y2={dimY + tickH} strokeWidth="1.5" />
              {/* Measurement text */}
              <text
                x={(leftX + rightX) / 2}
                y={dimY + tickH + 14}
                fontSize="12"
                fontWeight="bold"
                fill="#333"
                textAnchor="middle"
                stroke="none"
              >{absDifference.toFixed(1)}m</text>
            </g>
          );
        })()}
      </svg>
      )}

      {showRace && absDifference < 0.1 && <p className="viz-note">≈ Curves have similar efficiency profiles.</p>}
      {showRace && absDifference >= 0.1 && !isPotentialFaster && <p className="viz-note success">✓ You now are more efficient and would finish ahead!</p>}
    </div>
  );
}

export default BoatVisualization;
