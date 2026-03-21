import { useState } from 'react';

function Parameters({ params, onParamsChange }) {
  const handleChange = (field, value) => {
    onParamsChange({ ...params, [field]: value });
  };

  // Calculate derived values
  const strokeDuration = 60 / params.strokeRate; // seconds
  const avgVelocity = params.raceDistance / (params.targetTime * 60); // m/s
  const totalStrokes = Math.round((params.targetTime * 60) / strokeDuration);

  return (
    <div className="parameters">
      <h2>Race Parameters</h2>

      <div className="param-group">
        <label>
          Stroke Rate (strokes/min):
          <input
            type="number"
            min="20"
            max="40"
            step="1"
            value={params.strokeRate}
            onChange={(e) => handleChange('strokeRate', parseFloat(e.target.value))}
          />
          <input
            type="range"
            min="20"
            max="40"
            step="1"
            value={params.strokeRate}
            onChange={(e) => handleChange('strokeRate', parseFloat(e.target.value))}
          />
        </label>
      </div>

      <div className="param-group">
        <label>
          Race Distance (meters):
          <input
            type="number"
            min="500"
            max="5000"
            step="100"
            value={params.raceDistance}
            onChange={(e) => handleChange('raceDistance', parseFloat(e.target.value))}
          />
        </label>
      </div>

      <div className="param-group">
        <label>
          Target Finish Time (minutes):
          <input
            type="number"
            min="5"
            max="10"
            step="0.1"
            value={params.targetTime}
            onChange={(e) => handleChange('targetTime', parseFloat(e.target.value))}
          />
          <input
            type="range"
            min="5"
            max="10"
            step="0.1"
            value={params.targetTime}
            onChange={(e) => handleChange('targetTime', parseFloat(e.target.value))}
          />
        </label>
      </div>

      <div className="calculated-params">
        <h3>Calculated Values</h3>
        <div className="calc-row">
          <span className="calc-label">Average Velocity:</span>
          <span className="calc-value">{avgVelocity.toFixed(2)} m/s</span>
        </div>
        <div className="calc-row">
          <span className="calc-label">Stroke Duration:</span>
          <span className="calc-value">{strokeDuration.toFixed(2)} s</span>
        </div>
        <div className="calc-row">
          <span className="calc-label">Total Strokes:</span>
          <span className="calc-value">{totalStrokes}</span>
        </div>
      </div>
    </div>
  );
}

export default Parameters;
