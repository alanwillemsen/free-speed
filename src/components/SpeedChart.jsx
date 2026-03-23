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

function SpeedChart({ curveA, curveB, onCurveBChange, onReset, landmarks, landmarksB, energyPenaltyPercent, strokeRate, onStrokeRateChange, isNewCurve }) {
  const chartRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const { times: timesA, speeds: speedsA } = curveA;
  const { times: timesB, speeds: speedsB } = curveB;

  // Convert phase [0,1] to time in seconds at the given stroke rate
  const strokeDuration = 60 / strokeRate;
  const timesA_s = timesA.map(t => t * strokeDuration);
  const timesB_s = timesB.map(t => t * strokeDuration);

  // Create annotations for landmarks
  const landmarkAnnotations = {};
  if (landmarks && landmarks.length > 0) {
    landmarks.forEach((landmark, idx) => {
      landmarkAnnotations[`landmark_${idx}`] = {
        type: 'line',
        xMin: landmark.time * strokeDuration,
        xMax: landmark.time * strokeDuration,
        borderColor: 'rgba(100, 100, 100, 0.6)',
        borderWidth: 1,
        borderDash: [3, 3],
        label: {
          display: true,
          content: landmark.label,
          position: 'start',
          backgroundColor: 'rgba(75, 192, 192, 0.85)',
          color: 'white',
          font: {
            size: 9,
            weight: 'normal'
          },
          padding: 3,
          rotation: 0
        }
      };
    });
  }

  // Rower B landmark annotations
  if (landmarksB && landmarksB.length > 0) {
    landmarksB.forEach((landmark, idx) => {
      landmarkAnnotations[`landmarkB_${idx}`] = {
        type: 'line',
        xMin: landmark.time * strokeDuration,
        xMax: landmark.time * strokeDuration,
        borderColor: 'rgba(255, 99, 132, 0.7)',
        borderWidth: 1,
        borderDash: [3, 3],
        label: {
          display: true,
          content: landmark.label,
          position: 'end',
          backgroundColor: 'rgba(255, 99, 132, 0.85)',
          color: 'white',
          font: {
            size: 9,
            weight: 'normal'
          },
          padding: 3,
          rotation: 0
        }
      };
    });
  }

  // Phase duration labels for each rower
  const findLm = (lms, label) => lms?.find(l => l.label === label);

  const addPhaseLabels = (lms, prefix, yRow, bgColor) => {
    const entry      = findLm(lms, 'ENTRY');
    const extraction = findLm(lms, 'EXTRACTION');
    const bodiesOver = findLm(lms, 'BODIES OVER');

    const phases = [
      { key: 'catch',    name: 'Catch',    start: 0,                end: entry?.time      },
      { key: 'drive',    name: 'Drive',    start: entry?.time,      end: extraction?.time },
      { key: 'hang',     name: 'Hang',     start: extraction?.time, end: bodiesOver?.time },
      { key: 'recovery', name: 'Recovery', start: extraction?.time, end: 1.0              },
    ];

    phases.forEach(({ key, name, start, end }) => {
      if (start == null || end == null || end <= start) return;
      const startS = start * strokeDuration;
      const endS = end * strokeDuration;
      landmarkAnnotations[`${prefix}_phase_${key}`] = {
        type: 'label',
        xValue: (startS + endS) / 2,
        yValue: yRow,
        content: [`${name}: ${(endS - startS).toFixed(2)}s`],
        backgroundColor: bgColor,
        color: 'white',
        font: { size: 9 },
        padding: { x: 5, y: 2 },
        textAlign: 'center',
      };
    });
  };

  addPhaseLabels(landmarks,  'A', 2.7,  'rgba(75, 192, 192, 0.85)');
  addPhaseLabels(landmarksB, 'B', 7.3,  'rgba(255, 99, 132, 0.85)');

  // Create data arrays with x,y coordinates using time in seconds
  const dataA = speedsA.map((speed, i) => ({ x: timesA_s[i], y: speed }));
  const dataB = speedsB.map((speed, i) => ({ x: timesB_s[i], y: speed }));

  const data = {
    datasets: [
      {
        label: 'Rower A (Good Technique)',
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
        label: 'Rower B',
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
          font: {
            size: 14,
            weight: 'bold'
          },
          generateLabels: (chart) => {
            const labels = ChartJS.defaults.plugins.legend.labels.generateLabels(chart);
            labels.forEach(label => {
              if (label.text === 'Rower A (Good Technique)') {
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
          font: {
            size: 11
          }
        },
      },
      y: {
        title: {
          display: true,
          text: 'Boat Speed (m/s)',
          font: {
            size: 14,
            weight: 'bold'
          }
        },
        min: 2,
        max: 8,
        ticks: {
          font: {
            size: 11
          }
        }
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

    // Find the closest index in timesB_s (times in seconds)
    const closestIndex = timesB_s.reduce((best, t, i) =>
      Math.abs(t - xValue) < Math.abs(timesB_s[best] - xValue) ? i : best, 0);

    if (closestIndex >= 0 && closestIndex < speedsB.length && yValue > 0 && yValue < 10) {
      const newSpeeds = [...speedsB];
      newSpeeds[closestIndex] = yValue;
      onCurveBChange(newSpeeds);
    }
  };

  const handleMouseDown = (event) => {
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
  }, [isDrawing, speedsB, timesB, strokeRate]);

  return (
    <div className="chart-container">
      {isNewCurve && (
        <div className="chart-instructions">
          <strong>Draw Rower B:</strong> Click and drag to draw a velocity profile. It will be scaled to match Rower A's average speed —
          currently requiring <strong>{energyPenaltyPercent > 0 ? '+' : ''}{(Math.round(energyPenaltyPercent * 10) / 10 || 0).toFixed(1)}% energy</strong> to maintain the same pace.
          <button className="btn btn-secondary" style={{ marginLeft: '1rem' }} onClick={onReset}>Reset</button>
        </div>
      )}
      <div className="chart-wrapper">
        <Line key={strokeRate} ref={chartRef} data={data} options={options} />
      </div>
      <div style={{ textAlign: 'center', fontSize: '0.85rem', color: '#666', marginTop: '0.25rem' }}>
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
