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

function SpeedChart({ curveA, curveB, onCurveBChange, onStrokeDurationChange, landmarks }) {
  const chartRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isDraggingEndpoint, setIsDraggingEndpoint] = useState(false);

  const { times: timesA, speeds: speedsA } = curveA;
  const { times: timesB, speeds: speedsB } = curveB;

  // Create annotations for landmarks
  const landmarkAnnotations = {};
  if (landmarks && landmarks.length > 0) {
    landmarks.forEach((landmark, idx) => {
      const timeIndex = timesA.findIndex(t => Math.abs(t - landmark.time) < 0.01);
      if (timeIndex !== -1) {
        landmarkAnnotations[`landmark_${idx}`] = {
          type: 'line',
          xMin: timeIndex,
          xMax: timeIndex,
          borderColor: 'rgba(100, 100, 100, 0.6)',
          borderWidth: 1,
          borderDash: [3, 3],
          label: {
            display: true,
            content: landmark.label,
            position: 'start',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            font: {
              size: 9,
              weight: 'normal'
            },
            padding: 3,
            rotation: 0
          }
        };
      }
    });
  }

  // Add draggable endpoint for Curve B
  const endpointIndex = timesB.length - 1;
  landmarkAnnotations['curveBEndpoint'] = {
    type: 'point',
    xValue: endpointIndex,
    yValue: speedsB[endpointIndex],
    backgroundColor: 'rgba(255, 99, 132, 0.8)',
    borderColor: 'rgb(255, 99, 132)',
    borderWidth: 3,
    radius: 8,
    label: {
      display: true,
      content: '← Drag to adjust stroke rate',
      position: 'end',
      backgroundColor: 'rgba(255, 99, 132, 0.9)',
      color: 'white',
      font: {
        size: 10,
        weight: 'bold'
      },
      padding: 4
    }
  };

  // Calculate stroke rates
  const strokeRateA = 60 / timesA[timesA.length - 1];
  const strokeRateB = 60 / timesB[timesB.length - 1];

  // Create data arrays with x,y coordinates using actual time values
  const dataA = speedsA.map((speed, i) => ({ x: timesA[i], y: speed }));
  const dataB = speedsB.map((speed, i) => ({ x: timesB[i], y: speed }));

  const data = {
    datasets: [
      {
        label: `Curve B (${strokeRateB.toFixed(1)} spm)`,
        data: dataB,
        borderColor: 'rgba(255, 99, 132, 1)',
        backgroundColor: 'rgba(255, 99, 132, 0.1)',
        borderWidth: 3,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      },
      {
        label: `Curve A (${strokeRateA.toFixed(1)} spm)`,
        data: dataA,
        borderColor: 'rgba(75, 192, 192, 0.7)',
        backgroundColor: 'rgba(75, 192, 192, 0.1)',
        borderWidth: 2,
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
          font: {
            size: 14,
            weight: 'bold'
          }
        }
      },
      title: {
        display: true,
        text: 'Intra-Stroke Velocity Curves',
        font: {
          size: 18,
          weight: 'bold'
        },
      },
      tooltip: {
        enabled: false, // Disable tooltip so it doesn't interfere with drawing
      },
      annotation: {
        annotations: landmarkAnnotations
      }
    },
    scales: {
      x: {
        type: 'linear',
        min: 0,
        max: 3,
        title: {
          display: true,
          text: 'Time in Stroke (seconds)',
          font: {
            size: 14,
            weight: 'bold'
          }
        },
        ticks: {
          maxTicksLimit: 10,
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
        min: 3,
        max: 7,
        ticks: {
          font: {
            size: 11
          }
        }
      },
    },
  };

  // Handle drawing on the chart
  const handleMouseDown = (event) => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvasPosition = chart.canvas.getBoundingClientRect();
    const x = event.clientX - canvasPosition.left;
    const xScale = chart.scales.x;
    const xValue = xScale.getValueForPixel(x);
    const xIndex = Math.round(xValue);

    console.log('Mouse down at xIndex:', xIndex, 'total points:', timesA.length);

    // Check if clicking near the RIGHT edge of the chart (last 10% of x-axis)
    const totalLabels = timesA.length;
    const endpointThreshold = Math.floor(totalLabels * 0.9);

    if (xIndex >= endpointThreshold) {
      console.log('ENDPOINT DRAG STARTED');
      setIsDraggingEndpoint(true);
      event.preventDefault();
    } else {
      console.log('Normal drawing');
      setIsDrawing(true);
      updateCurveFromMouse(event);
    }
  };

  const handleMouseMove = (event) => {
    if (isDrawing) {
      updateCurveFromMouse(event);
    } else if (isDraggingEndpoint) {
      updateStrokeDurationFromMouse(event);
    }
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
    setIsDraggingEndpoint(false);
  };

  const updateCurveFromMouse = (event) => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvasPosition = chart.canvas.getBoundingClientRect();
    const x = event.clientX - canvasPosition.left;
    const y = event.clientY - canvasPosition.top;

    // Get the chart scales
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;

    // Convert pixel coordinates to data coordinates
    const xIndex = Math.round(xScale.getValueForPixel(x));
    const yValue = yScale.getValueForPixel(y);

    if (xIndex >= 0 && xIndex < speedsB.length && yValue > 0 && yValue < 10) {
      // Freehand drawing - directly set the value at this point
      const newSpeeds = [...speedsB];
      newSpeeds[xIndex] = yValue;
      onCurveBChange(newSpeeds);
    }
  };

  const updateStrokeDurationFromMouse = (event) => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvasPosition = chart.canvas.getBoundingClientRect();
    const x = event.clientX - canvasPosition.left;
    const xScale = chart.scales.x;

    // Get the time value directly from the linear scale
    const newDuration = xScale.getValueForPixel(x);

    console.log('Updating duration to:', newDuration.toFixed(2), 'seconds');

    // Don't allow stroke duration to be too short or too long
    if (newDuration >= 0.5 && newDuration <= 3.0) {
      onStrokeDurationChange(newDuration);
    }
  };

  // Add event listeners for drawing
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvas = chart.canvas;
    if (isDrawing) {
      canvas.style.cursor = 'crosshair';
    } else if (isDraggingEndpoint) {
      canvas.style.cursor = 'ew-resize';
    } else {
      canvas.style.cursor = 'default';
    }

    const handleMouseDownWrapper = (e) => handleMouseDown(e);
    const handleMouseMoveWrapper = (e) => handleMouseMove(e);
    const handleMouseUpWrapper = () => handleMouseUp();
    const handleMouseLeaveWrapper = () => handleMouseUp();

    canvas.addEventListener('mousedown', handleMouseDownWrapper);
    canvas.addEventListener('mousemove', handleMouseMoveWrapper);
    canvas.addEventListener('mouseup', handleMouseUpWrapper);
    canvas.addEventListener('mouseleave', handleMouseLeaveWrapper);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDownWrapper);
      canvas.removeEventListener('mousemove', handleMouseMoveWrapper);
      canvas.removeEventListener('mouseup', handleMouseUpWrapper);
      canvas.removeEventListener('mouseleave', handleMouseLeaveWrapper);
    };
  }, [isDrawing, isDraggingEndpoint, speedsB, timesB]);

  return (
    <div className="chart-container">
      <div className="chart-instructions">
        <strong>Draw:</strong> Click and drag to draw Curve B. <strong>Adjust stroke rate:</strong> Drag the endpoint left/right. Comparison updates automatically.
      </div>
      <div className="chart-wrapper">
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  );
}

export default SpeedChart;
