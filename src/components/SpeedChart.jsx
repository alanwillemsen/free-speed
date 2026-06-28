import { useRef, useEffect, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import annotationPlugin from 'chartjs-plugin-annotation';
import { catchStartIndex, rollCurve, catchAlignedPhases } from '../utils/curves';
import { useChartChrome } from '../utils/chartTheme';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  annotationPlugin
);

function SpeedChart({ curveA, curveB, onCurveBChange, onReset, energyPenaltyPercent, strokeRate, onStrokeRateChange, isNewCurve }) {
  const chartRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const { times: timesA, speeds: speedsA } = curveA;
  const { times: timesB, speeds: speedsB } = curveB;

  // Convert phase [0,1] to time in seconds at the given stroke rate
  const strokeDuration = 60 / strokeRate;
  const timesA_s = timesA.map(t => t * strokeDuration);
  const timesB_s = timesB.map(t => t * strokeDuration);

  // Roll both curves so each begins at its catch — where the boat starts slowing
  // hard into its slowest point — matching the live-capture profile. Display
  // only: the stored curves and every physics figure (roll-invariant) are
  // unchanged. The draw handler maps clicks back through offsetB.
  // While drawing, freeze offsetB (captured at drag start) so editing a point
  // can't move the detected catch and shift the whole curve mid-drag; it
  // re-aligns on release.
  const dragOffsetRef = useRef(0);
  const offsetA = catchStartIndex(speedsA);
  const offsetB = isDrawing ? dragOffsetRef.current : catchStartIndex(speedsB);
  const rolledA = rollCurve(speedsA, offsetA);
  const rolledB = rollCurve(speedsB, offsetB);

  // Compute Y-axis bounds from actual data with padding
  const allSpeeds = [...speedsA, ...speedsB];
  const dataMin = Math.min(...allSpeeds);
  const dataMax = Math.max(...allSpeeds);
  const padding = (dataMax - dataMin) * 0.15;
  const yMin = Math.floor((dataMin - padding) * 2) / 2; // round down to nearest 0.5
  const yMax = Math.ceil((dataMax + padding) * 2) / 2;  // round up to nearest 0.5

  // Average speed line (same for both curves after normalization).
  const avgSpeed = speedsB.reduce((a, b) => a + b, 0) / speedsB.length;

  const landmarkAnnotations = {
    avgSpeed: {
      type: 'line',
      yMin: avgSpeed,
      yMax: avgSpeed,
      borderColor: 'rgba(100, 100, 100, 0.4)',
      borderWidth: 1.5,
      borderDash: [8, 4],
    },
  };

  // Catch / drive / recovery of the "You now" curve, shown as labelled bands
  // split by the two phase boundaries (see catchAlignedPhases):
  //   catch    — the opening deceleration, until the steep drop eases
  //   drive    — the long middle
  //   recovery — the surge to top speed and back
  const phases = catchAlignedPhases(rolledB);
  const segments = [
    { name: 'Catch',    start: 0,               end: phases.catchEnd },
    { name: 'Drive',    start: phases.catchEnd, end: phases.driveEnd },
    { name: 'Recovery', start: phases.driveEnd, end: 1 },
  ];
  const labelY = yMax - (yMax - yMin) * 0.08;
  [phases.catchEnd, phases.driveEnd].forEach((b, idx) => {
    landmarkAnnotations[`phaseDiv_${idx}`] = {
      type: 'line',
      xMin: b * strokeDuration,
      xMax: b * strokeDuration,
      borderColor: 'rgba(255, 99, 132, 0.5)',
      borderWidth: 1,
      borderDash: [4, 4],
    };
  });
  segments.forEach((seg, idx) => {
    if (seg.end <= seg.start) return;
    const startS = seg.start * strokeDuration;
    const endS = seg.end * strokeDuration;
    landmarkAnnotations[`phaseLbl_${idx}`] = {
      type: 'label',
      xValue: (startS + endS) / 2,
      yValue: labelY,
      content: [seg.name, `${(endS - startS).toFixed(2)}s`],
      backgroundColor: 'rgba(255, 99, 132, 0.85)',
      color: 'white',
      font: { size: 10 },
      padding: { x: 5, y: 2 },
      textAlign: 'center',
    };
  });

  // Create data arrays with x,y coordinates using time in seconds
  const dataA = rolledA.map((speed, i) => ({ x: timesA_s[i], y: speed }));
  const dataB = rolledB.map((speed, i) => ({ x: timesB_s[i], y: speed }));

  const data = {
    datasets: [
      {
        label: 'Your potential',
        data: dataA,
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.1)',
        borderWidth: 4,
        borderDash: [5, 5],
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      },
      {
        label: 'You now',
        data: dataB,
        borderColor: 'rgba(255, 99, 132, 1)',
        backgroundColor: 'rgba(255, 99, 132, 0.1)',
        borderWidth: 3,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      },
    ],
  };

  const chrome = useChartChrome();
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'top',
        labels: {
          usePointStyle: true,
          pointStyle: 'line',
          color: chrome.title,
          font: {
            size: 14,
            weight: 'bold'
          },
          generateLabels: (chart) => {
            const labels = ChartJS.defaults.plugins.legend.labels.generateLabels(chart);
            labels.forEach(label => {
              if (label.text === 'Your potential') {
                label.lineDash = [5, 5];
              }
            });
            return labels;
          }
        }
      },
      title: {
        display: true,
        text: 'Per-stroke speed profile',
        color: chrome.title,
        font: {
          size: 18,
          weight: 'bold'
        },
      },
      tooltip: {
        enabled: false,
      },
      annotation: {
        annotations: landmarkAnnotations
      }
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: strokeDuration,
        title: {
          display: false,
        },
        ticks: {
          maxTicksLimit: 10,
          callback: (val) => val.toFixed(2),
          color: chrome.tick,
          font: {
            size: 11
          }
        },
        grid: { color: chrome.grid },
      },
      y: {
        title: {
          display: true,
          text: 'Boat Speed (m/s)',
          color: chrome.title,
          font: {
            size: 14,
            weight: 'bold'
          }
        },
        min: yMin,
        max: yMax,
        ticks: {
          color: chrome.tick,
          font: {
            size: 11
          }
        },
        grid: { color: chrome.grid }
      },
    },
  };

  const updateCurveFromMouse = (event) => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvasPosition = chart.canvas.getBoundingClientRect();
    const x = event.clientX - canvasPosition.left;
    const y = event.clientY - canvasPosition.top;

    const xScale = chart.scales.x;
    const yScale = chart.scales.y;

    // Ignore clicks outside the plot area
    if (x < xScale.left || x > xScale.right || y < yScale.top || y > yScale.bottom) return;

    const xValue = xScale.getValueForPixel(x);
    const yValue = yScale.getValueForPixel(y);

    // Find the closest point on the displayed (rolled) curve, then map it back
    // to the stored index via offsetB so the edit lands on the right point.
    const displayIndex = timesB_s.reduce((best, t, i) =>
      Math.abs(t - xValue) < Math.abs(timesB_s[best] - xValue) ? i : best, 0);

    if (displayIndex >= 0 && displayIndex < speedsB.length && yValue > 0 && yValue < 10) {
      const m = speedsB.length - 1;
      const storedIndex = (offsetB + displayIndex) % m;
      const newSpeeds = [...speedsB];
      newSpeeds[storedIndex] = yValue;
      onCurveBChange(newSpeeds);
    }
  };

  const handleMouseDown = (event) => {
    dragOffsetRef.current = catchStartIndex(speedsB); // freeze alignment for the drag
    setIsDrawing(true);
    updateCurveFromMouse(event);
  };

  const handleMouseMove = (event) => {
    if (isDrawing) updateCurveFromMouse(event);
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
  };

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvas = chart.canvas;
    canvas.style.cursor = isDrawing ? 'crosshair' : 'default';

    const onDown = (e) => handleMouseDown(e);
    const onMove = (e) => handleMouseMove(e);
    const onUp = () => handleMouseUp();

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onUp);

    return () => {
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mouseleave', onUp);
    };
  }, [isDrawing, speedsB, timesB, strokeRate, offsetB]);

  return (
    <div className="chart-container">
      {isNewCurve && (
        <div className="chart-instructions">
          <strong>Draw your stroke:</strong> Click and drag to draw a velocity profile. It will be scaled to match your potential average speed —
          currently requiring <strong>{energyPenaltyPercent > 0 ? '+' : ''}{(Math.round(energyPenaltyPercent * 10) / 10 || 0).toFixed(1)}% energy</strong> to maintain the same pace.
          <button className="btn btn-secondary" style={{ marginLeft: '1rem' }} onClick={onReset}>Reset</button>
        </div>
      )}
      <div className="chart-wrapper">
        <Line key={strokeRate} ref={chartRef} data={data} options={options} />
      </div>
      <div style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: '0.25rem' }}>
        Time (s) at&nbsp;
        <select
          value={strokeRate}
          onChange={e => onStrokeRateChange(parseInt(e.target.value))}
          style={{ fontSize: '0.85rem' }}
        >
          {Array.from({ length: 51 }, (_, i) => 10 + i).map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        &nbsp;strokes/min&ensp;·&ensp;<span style={{ fontStyle: 'italic' }}>stroke rate only affects this scale, not efficiency</span>
      </div>
    </div>
  );
}

export default SpeedChart;
