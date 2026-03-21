/**
 * Derive landmarks from a speed curve
 */

/**
 * Find local minima and maxima in the curve
 */
function findExtrema(times, speeds) {
  const extrema = [];

  for (let i = 1; i < speeds.length - 1; i++) {
    // Local minimum
    if (speeds[i] < speeds[i - 1] && speeds[i] < speeds[i + 1]) {
      extrema.push({
        time: times[i],
        speed: speeds[i],
        type: 'min',
        index: i
      });
    }
    // Local maximum
    if (speeds[i] > speeds[i - 1] && speeds[i] > speeds[i + 1]) {
      extrema.push({
        time: times[i],
        speed: speeds[i],
        type: 'max',
        index: i
      });
    }
  }

  return extrema;
}

/**
 * Derive rowing phase landmarks from speed curve
 */
export function deriveLandmarks(times, speeds) {
  if (!times || !speeds || times.length < 2) {
    return [];
  }

  const landmarks = [];

  // Find global min and max
  const minSpeed = Math.min(...speeds);
  const maxSpeed = Math.max(...speeds);
  const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  // Find indices
  const minIndex = speeds.indexOf(minSpeed);
  const maxIndex = speeds.indexOf(maxSpeed);

  // Start/End point (should be same due to periodic boundary)
  landmarks.push({
    time: times[0],
    speed: speeds[0],
    label: 'START/END'
  });

  // Minimum speed point (catch/entry phase)
  if (minIndex > 0 && minIndex < speeds.length - 1) {
    landmarks.push({
      time: times[minIndex],
      speed: speeds[minIndex],
      label: 'MIN SPEED (Catch)'
    });
  }

  // Maximum speed point (peak velocity)
  if (maxIndex > 0 && maxIndex < speeds.length - 1) {
    landmarks.push({
      time: times[maxIndex],
      speed: speeds[maxIndex],
      label: 'MAX SPEED'
    });
  }

  // Find midpoint of stroke
  const midIndex = Math.floor(speeds.length / 2);
  if (midIndex > 0 && midIndex < speeds.length - 1) {
    landmarks.push({
      time: times[midIndex],
      speed: speeds[midIndex],
      label: 'MID-STROKE'
    });
  }

  // Find all local extrema for additional detail
  const extrema = findExtrema(times, speeds);

  // Add significant local extrema (not too close to global extrema)
  extrema.forEach(ext => {
    const isCloseToGlobal = Math.abs(ext.index - minIndex) < 3 ||
                           Math.abs(ext.index - maxIndex) < 3 ||
                           Math.abs(ext.index - midIndex) < 3;

    if (!isCloseToGlobal) {
      const label = ext.type === 'max' ? 'Local Peak' : 'Local Trough';
      landmarks.push({
        time: ext.time,
        speed: ext.speed,
        label: label
      });
    }
  });

  // Sort by time
  landmarks.sort((a, b) => a.time - b.time);

  return landmarks;
}

/**
 * Calculate acceleration (first derivative of speed)
 */
function calculateAcceleration(times, speeds) {
  const acceleration = [];

  for (let i = 0; i < speeds.length - 1; i++) {
    const dt = times[i + 1] - times[i];
    const dv = speeds[i + 1] - speeds[i];
    acceleration.push(dv / dt);
  }

  // Last point uses same as second-to-last
  acceleration.push(acceleration[acceleration.length - 1]);

  return acceleration;
}

/**
 * Find max acceleration point
 */
function findMaxAcceleration(times, speeds) {
  const acceleration = calculateAcceleration(times, speeds);
  const maxAccel = Math.max(...acceleration);
  const maxAccelIndex = acceleration.indexOf(maxAccel);
  return maxAccelIndex;
}

/**
 * Find where acceleration stops (goes to zero or negative)
 */
function findAccelerationStop(times, speeds, startIndex) {
  const acceleration = calculateAcceleration(times, speeds);

  // Look for where acceleration becomes zero or negative after startIndex
  for (let i = startIndex; i < acceleration.length; i++) {
    if (acceleration[i] <= 0) {
      return i;
    }
  }

  return acceleration.length - 1;
}

/**
 * Derive rowing phase landmarks from speed curve
 * Phases: FULL REACH → ENTRY → OAR PERPENDICULAR → EXTRACTION → PEAK SPEED → FULL REACH
 */
export function deriveSimpleLandmarks(times, speeds) {
  if (!times || !speeds || times.length < 2) {
    return [];
  }

  const landmarks = [];

  // 1. FULL REACH - at beginning
  landmarks.push({
    time: times[0],
    speed: speeds[0],
    label: 'FULL REACH'
  });

  // 2. ENTRY - at minimum speed (catch)
  const minSpeed = Math.min(...speeds);
  const minIndex = speeds.indexOf(minSpeed);
  if (minIndex > 0) {
    landmarks.push({
      time: times[minIndex],
      speed: speeds[minIndex],
      label: 'ENTRY'
    });
  }

  // 3. OAR PERPENDICULAR - max acceleration point (before extraction)
  const maxAccelIndex = findMaxAcceleration(times, speeds);
  if (maxAccelIndex > minIndex && maxAccelIndex < speeds.length - 1) {
    landmarks.push({
      time: times[maxAccelIndex],
      speed: speeds[maxAccelIndex],
      label: 'OAR PERPENDICULAR'
    });
  }

  // 4. EXTRACTION - when acceleration stops
  const extractionIndex = findAccelerationStop(times, speeds, maxAccelIndex);
  if (extractionIndex > maxAccelIndex && extractionIndex < speeds.length - 1) {
    landmarks.push({
      time: times[extractionIndex],
      speed: speeds[extractionIndex],
      label: 'EXTRACTION'
    });
  }

  // 5. PEAK SPEED - at maximum speed
  const maxSpeed = Math.max(...speeds);
  const maxIndex = speeds.indexOf(maxSpeed);
  if (maxIndex > 0 && maxIndex < speeds.length - 1) {
    landmarks.push({
      time: times[maxIndex],
      speed: speeds[maxIndex],
      label: 'PEAK SPEED'
    });
  }

  return landmarks;
}
