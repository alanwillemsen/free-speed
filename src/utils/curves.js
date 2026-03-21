/**
 * Curve generation and manipulation utilities
 */

/**
 * Generate an optimal speed curve (nearly constant with slight sinusoidal variation)
 * This represents the most energy-efficient speed profile
 *
 * @param {number} avgVelocity - Target average velocity (m/s)
 * @param {number} strokeTime - Duration of one stroke (seconds)
 * @param {number} numPoints - Number of data points
 * @returns {Array<number>} Speed curve values
 */
export function generateOptimalCurve(avgVelocity, strokeTime, numPoints = 100) {
  const curve = [];

  // Create a gentle sinusoidal variation (±3% of average)
  // This represents realistic minimal variation in rowing
  const amplitude = avgVelocity * 0.03;

  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1); // 0 to 1
    const angle = t * 2 * Math.PI; // One complete cycle

    // Sine wave with slight variation
    // Lower speed during recovery (latter half), higher during drive
    const variation = amplitude * Math.sin(angle - Math.PI / 2);
    curve.push(avgVelocity + variation);
  }

  // Normalize to ensure exact average
  return normalizeCurve(curve, avgVelocity);
}

/**
 * Calculate the average velocity of a speed curve
 *
 * @param {Array<number>} curve - Speed curve values
 * @returns {number} Average velocity
 */
export function calculateAverageVelocity(curve) {
  if (curve.length === 0) return 0;
  const sum = curve.reduce((acc, val) => acc + val, 0);
  return sum / curve.length;
}

/**
 * Normalize a curve to match a target average velocity
 *
 * @param {Array<number>} curve - Input curve
 * @param {number} targetAvg - Target average velocity
 * @returns {Array<number>} Normalized curve
 */
export function normalizeCurve(curve, targetAvg) {
  const currentAvg = calculateAverageVelocity(curve);
  if (currentAvg === 0) return curve;

  const scale = targetAvg / currentAvg;
  return curve.map(v => v * scale);
}

/**
 * Smooth a curve using moving average
 * Helps remove jagged edges from user drawing
 *
 * @param {Array<number>} curve - Input curve
 * @param {number} windowSize - Size of smoothing window (odd number)
 * @returns {Array<number>} Smoothed curve
 */
export function smoothCurve(curve, windowSize = 5) {
  if (curve.length < windowSize) return [...curve];

  const smoothed = [];
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < curve.length; i++) {
    let sum = 0;
    let count = 0;

    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < curve.length) {
        sum += curve[idx];
        count++;
      }
    }

    smoothed.push(sum / count);
  }

  return smoothed;
}

/**
 * Update curve at a specific position (for drawing interaction)
 *
 * @param {Array<number>} curve - Current curve
 * @param {number} xRatio - X position (0 to 1)
 * @param {number} yValue - New Y value (velocity)
 * @param {number} brushSize - Size of influence area
 * @returns {Array<number>} Updated curve
 */
export function updateCurveAtPoint(curve, xRatio, yValue, brushSize = 5) {
  const newCurve = [...curve];
  const centerIdx = Math.round(xRatio * (curve.length - 1));

  // Update points within brush size using Gaussian-like falloff
  for (let i = 0; i < curve.length; i++) {
    const distance = Math.abs(i - centerIdx);
    if (distance <= brushSize) {
      const influence = 1 - (distance / brushSize);
      // Blend between old and new value based on influence
      newCurve[i] = curve[i] * (1 - influence) + yValue * influence;
    }
  }

  return newCurve;
}

/**
 * Generate a realistic rowing curve with distinct drive and recovery phases
 * Alternative to optimal curve for demonstration
 *
 * @param {number} avgVelocity - Target average velocity
 * @param {number} strokeTime - Duration of one stroke
 * @param {number} numPoints - Number of data points
 * @returns {Array<number>} Speed curve
 */
export function generateRealisticCurve(avgVelocity, strokeTime, numPoints = 100) {
  const curve = [];

  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);

    // Drive phase: 0-0.5, rapid acceleration then deceleration
    // Recovery phase: 0.5-1.0, slower return
    let velocity;
    if (t < 0.5) {
      // Drive: starts slower, peaks mid-drive, ends fast
      const driveT = t * 2;
      velocity = avgVelocity * (0.85 + 0.3 * Math.sin(driveT * Math.PI));
    } else {
      // Recovery: starts fast, slows down gradually
      const recoveryT = (t - 0.5) * 2;
      velocity = avgVelocity * (1.15 - 0.3 * Math.sin(recoveryT * Math.PI));
    }

    curve.push(velocity);
  }

  return normalizeCurve(curve, avgVelocity);
}
