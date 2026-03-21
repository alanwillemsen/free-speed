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

function SpeedChart({ optimalCurve, userCurve, onUserCurveChange, strokeTime, avgVelocity }) {
  const chartRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Generate time labels (in seconds within stroke)
  const timeLabels = optimalCurve.map((_, i) =>
    ((i / (optimalCurve.length - 1)) * strokeTime).toFixed(2)
  );

  const data = {
    labels: timeLabels,
    datasets: [
      {
        label: 'Optimal Curve',
        data: optimalCurve,
        borderColor: 'rgba(75, 192, 192, 0.5)',
        backgroundColor: 'rgba(75, 192, 192, 0.1)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
      },
      {
        label: 'Your Curve',
        data: userCurve,
        borderColor: 'rgba(255, 99, 132, 1)',
        backgroundColor: 'rgba(255, 99, 132, 0.2)',
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
      },
      title: {
        display: true,
        text: 'Hull Speed During Stroke Cycle',
        font: {
          size: 18,
        },
      },
      tooltip: {
        callbacks: {
          label: function(context) {
            return `${context.dataset.label}: ${context.parsed.y.toFixed(2)} m/s`;
          },
        },
      },
      annotation: {
        annotations: {
          catch: {
            type: 'line',
            xMin: 0,
            xMax: 0,
            borderColor: 'rgba(0, 0, 0, 0.3)',
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
              display: true,
              content: 'Catch',
              position: 'start',
            },
          },
          finish: {
            type: 'line',
            xMin: Math.floor(timeLabels.length / 2),
            xMax: Math.floor(timeLabels.length / 2),
            borderColor: 'rgba(0, 0, 0, 0.3)',
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
              display: true,
              content: 'Finish',
              position: 'start',
            },
          },
          drivePhase: {
            type: 'box',
            xMin: 0,
            xMax: Math.floor(timeLabels.length / 2),
            backgroundColor: 'rgba(255, 206, 86, 0.1)',
            borderWidth: 0,
            label: {
              display: true,
              content: 'Drive Phase',
              position: 'center',
            },
          },
          recoveryPhase: {
            type: 'box',
            xMin: Math.floor(timeLabels.length / 2),
            xMax: timeLabels.length - 1,
            backgroundColor: 'rgba(153, 102, 255, 0.1)',
            borderWidth: 0,
            label: {
              display: true,
              content: 'Recovery Phase',
              position: 'center',
            },
          },
        },
      },
    },
    scales: {
      x: {
        title: {
          display: true,
          text: 'Time in Stroke (seconds)',
        },
        ticks: {
          maxTicksLimit: 10,
        },
      },
      y: {
        title: {
          display: true,
          text: 'Hull Speed (m/s)',
        },
        min: Math.max(0, avgVelocity * 0.5),
        max: avgVelocity * 1.5,
      },
    },
  };

  // Handle drawing on the chart
  const handleMouseDown = (event) => {
    setIsDrawing(true);
    updateCurveFromMouse(event);
  };

  const handleMouseMove = (event) => {
    if (isDrawing) {
      updateCurveFromMouse(event);
    }
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
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
    const xValue = xScale.getValueForPixel(x);
    const yValue = yScale.getValueForPixel(y);

    if (xValue >= 0 && xValue < userCurve.length && yValue > 0) {
      // Update the curve at this point with a brush effect
      const newCurve = [...userCurve];
      const brushSize = 3;

      for (let i = 0; i < userCurve.length; i++) {
        const distance = Math.abs(i - xValue);
        if (distance <= brushSize) {
          const influence = Math.max(0, 1 - distance / brushSize);
          newCurve[i] = userCurve[i] * (1 - influence * 0.3) + yValue * (influence * 0.3);
        }
      }

      onUserCurveChange(newCurve);
    }
  };

  // Add event listeners for drawing
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const canvas = chart.canvas;
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseUp);
    };
  }, [isDrawing, userCurve]);

  return (
    <div className="chart-container">
      <div className="chart-instructions">
        Click and drag on the chart to modify the speed curve
      </div>
      <div className="chart-wrapper">
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  );
}

export default SpeedChart;
