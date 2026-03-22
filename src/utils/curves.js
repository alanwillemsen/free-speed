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
 * Interpolate speed at a given phase using linear interpolation
 */
function interpolateSpeed(times, speeds, t) {
  if (t <= times[0]) return speeds[0];
  if (t >= times[times.length - 1]) return speeds[speeds.length - 1];
  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= t) i++;
  const ratio = (t - times[i]) / (times[i + 1] - times[i]);
  return speeds[i] + ratio * (speeds[i + 1] - speeds[i]);
}

/**
 * Reshape a curve for a late entry (slow catch / missing water).
 *
 * Always reshapes relative to a reference curve (Crew A) so results are
 * deterministic regardless of drag history.
 *
 * As entry moves right:
 *  - Recovery extends at the same deceleration rate → lower minimum speed
 *  - Drive phase compresses and shifts down by the same delta
 *  - Boat slows down more before the catch, with lower speeds throughout
 */
export function reshapeCurveAtEntry(refTimes, refSpeeds, newEntryPhase) {
  const minIdx = refSpeeds.indexOf(Math.min(...refSpeeds));
  const refEntryPhase = refTimes[minIdx];
  const vMin = refSpeeds[minIdx];
  const vStart = refSpeeds[0];

  // Linear deceleration: extend the recovery at the same rate as the reference
  const decelPerPhase = refEntryPhase > 0 ? (vStart - vMin) / refEntryPhase : 0;
  const vMinNew = Math.max(vStart * 0.25, vStart - decelPerPhase * newEntryPhase);
  const delta = vMinNew - vMin; // negative when entry is later than reference

  const postOld = 1 - refEntryPhase;
  const postNew  = 1 - newEntryPhase;

  return refTimes.map(t => {
    if (t <= newEntryPhase) {
      // Pre-entry: stretch reference shape, scale speeds to reach vMinNew
      const tRef = newEntryPhase > 0 ? t * refEntryPhase / newEntryPhase : 0;
      const sRef = interpolateSpeed(refTimes, refSpeeds, tRef);
      if (Math.abs(vMin - vStart) < 1e-6) return vStart;
      return vStart + (sRef - vStart) * (vMinNew - vStart) / (vMin - vStart);
    } else {
      // Post-entry: compress drive phase, shift all speeds down by delta
      const tRef = postNew > 0
        ? refEntryPhase + (t - newEntryPhase) * postOld / postNew
        : refEntryPhase;
      return interpolateSpeed(refTimes, refSpeeds, tRef) + delta;
    }
  });
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
