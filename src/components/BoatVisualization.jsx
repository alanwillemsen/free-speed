/**
 * Boat Visualization Component
 * Shows two boats at the finish line with relative positions based on time difference
 */

function BoatVisualization({ timeDifference, avgVelocityA }) {
  const boatLength = 17.4; // meters (rowing 8)
  const raceDistance = 2000; // meters

  // Calculate distance difference based on time difference
  // Distance = velocity × time
  const distanceDifference = Math.abs(avgVelocityA * timeDifference); // meters

  // Determine which boat is faster (finishes first)
  const isCurveBFaster = timeDifference < 0;

  // Visualization parameters
  const svgWidth = 800;
  const svgHeight = 200;
  const trackHeight = 60;
  const trackY = (svgHeight - trackHeight) / 2;

  // Scale: show last 100m of the race for better visibility
  const visibleDistance = 100; // meters
  const scale = svgWidth / visibleDistance; // pixels per meter

  // Boat dimensions (scaled)
  const boatLengthPx = boatLength * scale;
  const boatHeight = 20;

  // Position boats: winner at finish line, loser behind
  const finishLineX = svgWidth - 10;
  const winnerPosition = finishLineX;
  const loserPosition = finishLineX - (distanceDifference * scale);

  // Assign positions based on who wins
  const boatAPosition = isCurveBFaster ? loserPosition : winnerPosition;
  const boatBPosition = isCurveBFaster ? winnerPosition : loserPosition;

  const absDifference = distanceDifference;

  return (
    <div className="boat-visualization">
      <h3>Race Finish Visualization</h3>
      <p className="viz-description">
        Position when the winning boat ({isCurveBFaster ? 'Curve B' : 'Curve A'}) crosses the finish line
        {absDifference > 0 && (
          <span className="distance-diff">
            {' '}— {absDifference.toFixed(1)}m ahead
          </span>
        )}
      </p>

      <svg width={svgWidth} height={svgHeight} className="boat-svg">
        {/* Water background */}
        <rect
          x="0"
          y={trackY}
          width={svgWidth}
          height={trackHeight}
          fill="#E3F2FD"
          stroke="#90CAF9"
          strokeWidth="1"
        />

        {/* Finish line */}
        <line
          x1={svgWidth - 10}
          y1={trackY}
          x2={svgWidth - 10}
          y2={trackY + trackHeight}
          stroke="#FF5722"
          strokeWidth="4"
          strokeDasharray="5,5"
        />
        <text
          x={svgWidth - 8}
          y={trackY - 5}
          fontSize="12"
          fontWeight="bold"
          fill="#FF5722"
        >
          FINISH
        </text>

        {/* Distance markers */}
        {[80, 60, 40, 20].map(dist => {
          const x = svgWidth - (dist * scale);
          return (
            <g key={dist}>
              <line
                x1={x}
                y1={trackY + trackHeight}
                x2={x}
                y2={trackY + trackHeight + 5}
                stroke="#999"
                strokeWidth="1"
              />
              <text
                x={x}
                y={trackY + trackHeight + 18}
                fontSize="10"
                fill="#666"
                textAnchor="middle"
              >
                {dist}m
              </text>
            </g>
          );
        })}

        {/* Boat A (Reference) */}
        <g>
          <rect
            x={boatAPosition - boatLengthPx}
            y={trackY + 10}
            width={boatLengthPx}
            height={boatHeight}
            fill="#4CAF50"
            stroke="#2E7D32"
            strokeWidth="2"
            rx="3"
          />
          {/* Bow (pointed end) */}
          <polygon
            points={`
              ${boatAPosition},${trackY + 10 + boatHeight / 2}
              ${boatAPosition - 10},${trackY + 10}
              ${boatAPosition - 10},${trackY + 10 + boatHeight}
            `}
            fill="#4CAF50"
            stroke="#2E7D32"
            strokeWidth="2"
          />
          <text
            x={boatAPosition - boatLengthPx / 2}
            y={trackY + 20 + boatHeight / 2}
            fontSize="11"
            fontWeight="bold"
            fill="white"
            textAnchor="middle"
          >
            Curve A
          </text>
        </g>

        {/* Boat B (Test) */}
        <g>
          <rect
            x={boatBPosition - boatLengthPx}
            y={trackY + 30}
            width={boatLengthPx}
            height={boatHeight}
            fill={isCurveBFaster ? "#2196F3" : "#FF5722"}
            stroke={isCurveBFaster ? "#1565C0" : "#D84315"}
            strokeWidth="2"
            rx="3"
          />
          {/* Bow (pointed end) */}
          <polygon
            points={`
              ${boatBPosition},${trackY + 30 + boatHeight / 2}
              ${boatBPosition - 10},${trackY + 30}
              ${boatBPosition - 10},${trackY + 30 + boatHeight}
            `}
            fill={isCurveBFaster ? "#2196F3" : "#FF5722"}
            stroke={isCurveBFaster ? "#1565C0" : "#D84315"}
            strokeWidth="2"
          />
          <text
            x={boatBPosition - boatLengthPx / 2}
            y={trackY + 40 + boatHeight / 2}
            fontSize="11"
            fontWeight="bold"
            fill="white"
            textAnchor="middle"
          >
            Curve B
          </text>
        </g>

        {/* Distance indicator if boats are separated */}
        {absDifference > 1 && (
          <g>
            <line
              x1={boatBPosition}
              y1={trackY + trackHeight + 30}
              x2={boatAPosition}
              y2={trackY + trackHeight + 30}
              stroke="#666"
              strokeWidth="2"
              markerEnd="url(#arrowhead)"
              markerStart="url(#arrowhead)"
            />
            <text
              x={(boatBPosition + boatAPosition) / 2}
              y={trackY + trackHeight + 45}
              fontSize="12"
              fontWeight="bold"
              fill="#333"
              textAnchor="middle"
            >
              {absDifference.toFixed(1)}m
            </text>
          </g>
        )}

        {/* Arrow marker definition */}
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="10"
            refX="5"
            refY="5"
            orient="auto"
          >
            <polygon points="0 0, 10 5, 0 10" fill="#666" />
          </marker>
        </defs>
      </svg>

      {isCurveBFaster && (
        <p className="viz-note success">
          ✓ Curve B is more efficient and would finish ahead!
        </p>
      )}
      {!isCurveBFaster && absDifference > 0.1 && (
        <p className="viz-note warning">
          ⚠ Curve B is less efficient and would finish behind.
        </p>
      )}
      {absDifference < 0.1 && (
        <p className="viz-note">
          ≈ Curves have similar efficiency profiles.
        </p>
      )}
    </div>
  );
}

export default BoatVisualization;
