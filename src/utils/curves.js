/**
 * Curve manipulation and normalization utilities
 */

/**
 * Calculate average velocity from time and speed arrays
 */
export function calculateAverageVelocity(speeds) {
  if (speeds.length === 0) return 0;
  const sum = speeds.reduce((acc, v) => acc + v, 0);
  return sum / speeds.length;
}

/**
 * Normalize a curve to match a target average velocity
 * Multiplies all speeds by a scaling factor
 */
export function normalizeCurve(speeds, targetAvg) {
  const currentAvg = calculateAverageVelocity(speeds);
  if (currentAvg === 0) return speeds;

  const scalingFactor = targetAvg / currentAvg;
  return speeds.map(v => v * scalingFactor);
}

/**
 * Scale a curve by a factor
 */
export function scaleCurve(speeds, factor) {
  return speeds.map(v => v * factor);
}

/**
 * Smooth a curve using moving average
 */
export function smoothCurve(values, windowSize = 3) {
  if (values.length < windowSize) return [...values];

  const smoothed = [];
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;

    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < values.length) {
        sum += values[idx];
        count++;
      }
    }

    smoothed.push(sum / count);
  }

  return smoothed;
}

/**
 * Resample a curve to match the time points of another curve
 * Uses linear interpolation
 */
export function resampleCurve(sourceTimes, sourceSpeeds, targetTimes) {
  const resampled = [];

  for (const targetTime of targetTimes) {
    // Find the two points to interpolate between
    let i = 0;
    while (i < sourceTimes.length - 1 && sourceTimes[i + 1] < targetTime) {
      i++;
    }

    if (targetTime <= sourceTimes[0]) {
      resampled.push(sourceSpeeds[0]);
    } else if (targetTime >= sourceTimes[sourceTimes.length - 1]) {
      resampled.push(sourceSpeeds[sourceSpeeds.length - 1]);
    } else {
      // Linear interpolation
      const t1 = sourceTimes[i];
      const t2 = sourceTimes[i + 1];
      const v1 = sourceSpeeds[i];
      const v2 = sourceSpeeds[i + 1];

      const ratio = (targetTime - t1) / (t2 - t1);
      const interpolated = v1 + ratio * (v2 - v1);
      resampled.push(interpolated);
    }
  }

  return resampled;
}

/**
 * Generate a simple curve for initial Curve B
 * Creates a curve similar to the reference but with adjustable variation
 */
export function generateSimilarCurve(referenceTimes, referenceSpeeds, variationFactor = 1.0) {
  const avgSpeed = calculateAverageVelocity(referenceSpeeds);

  // Create a curve with similar shape but potentially different variation
  const newSpeeds = referenceSpeeds.map((speed, i) => {
    const deviation = speed - avgSpeed;
    return avgSpeed + deviation * variationFactor;
  });

  return newSpeeds;
}

/**
 * Update curve at a specific position (for drawing)
 * Updates points within a brush radius
 */
export function updateCurveAtPoint(times, speeds, targetTime, targetSpeed, brushRadius = 0.1) {
  const newSpeeds = [...speeds];

  for (let i = 0; i < times.length; i++) {
    const timeDiff = Math.abs(times[i] - targetTime);

    if (timeDiff <= brushRadius) {
      // Gaussian-like falloff
      const influence = Math.exp(-(timeDiff * timeDiff) / (2 * brushRadius * brushRadius / 9));

      // Blend between old and new value
      newSpeeds[i] = speeds[i] * (1 - influence * 0.5) + targetSpeed * (influence * 0.5);
    }
  }

  return newSpeeds;
}

/**
 * Find the closest time index for a given time value
 */
export function findClosestTimeIndex(times, targetTime) {
  let closestIndex = 0;
  let closestDiff = Math.abs(times[0] - targetTime);

  for (let i = 1; i < times.length; i++) {
    const diff = Math.abs(times[i] - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }

  return closestIndex;
}

/**
 * Calculate statistics for a curve
 */
export function calculateCurveStats(speeds) {
  const avg = calculateAverageVelocity(speeds);
  const min = Math.min(...speeds);
  const max = Math.max(...speeds);
  const range = max - min;

  // Calculate variance and standard deviation
  const variance = speeds.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / speeds.length;
  const stdDev = Math.sqrt(variance);

  return {
    avg,
    min,
    max,
    range,
    variance,
    stdDev
  };
}
