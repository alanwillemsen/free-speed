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

function interpolateSpeed(times, speeds, t) {
  if (t <= times[0]) return speeds[0];
  if (t >= times[times.length - 1]) return speeds[speeds.length - 1];
  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= t) i++;
  const ratio = (t - times[i]) / (times[i + 1] - times[i]);
  return speeds[i] + ratio * (speeds[i + 1] - speeds[i]);
}

/**
 * Fit a parabola through three points and return the vertex (x, y).
 * Falls back to the middle point if the parabola is degenerate.
 */
function parabolaVertex(x0, y0, x1, y1, x2, y2) {
  const d01 = x1 - x0, d12 = x2 - x1, d02 = x2 - x0;
  const a = (d01 * (y2 - y1) - d12 * (y1 - y0)) / (d01 * d12 * d02);
  if (Math.abs(a) < 1e-12) return { x: x1, y: y1 };
  const b = (y1 - y0) / d01 - a * (x0 + x1);
  const vx = -b / (2 * a);
  const vy = a * vx * vx + b * vx + (y0 - a * x0 * x0 - b * x0);
  return { x: vx, y: vy };
}

/**
 * Linearly interpolate the zero-crossing of the acceleration array between
 * indices i and i+1 (where accel is treated as point values at times[i]).
 * Returns the interpolated time and the speed at that time.
 */
function accelZeroCrossing(times, speeds, accel, i) {
  const t0 = times[i], a0 = accel[i];
  const t1 = times[i + 1], a1 = accel[i + 1];
  const t = Math.abs(a0 - a1) > 1e-12 ? t0 + (t1 - t0) * a0 / (a0 - a1) : t0;
  return { time: t, speed: interpolateSpeed(times, speeds, t) };
}

/**
 * Derive rowing phase landmarks from speed curve
 * Phases: FULL REACH → ENTRY → EXTRACTION → BODIES OVER → PEAK SPEED → FULL REACH
 */
export function deriveSimpleLandmarks(times, speeds) {
  if (!times || !speeds || times.length < 2) {
    return [];
  }

  const landmarks = [];
  const midTime = times[Math.floor(times.length / 2)];

  // 1. FULL REACH - at beginning
  landmarks.push({
    time: times[0],
    speed: speeds[0],
    label: 'FULL REACH'
  });

  // 2. ENTRY - true minimum via parabolic interpolation
  const minSpeed = Math.min(...speeds);
  const minIndex = speeds.indexOf(minSpeed);
  if (minIndex > 0) {
    let entryTime = times[minIndex], entrySpeed = speeds[minIndex];
    if (minIndex > 0 && minIndex < speeds.length - 1) {
      const v = parabolaVertex(
        times[minIndex - 1], speeds[minIndex - 1],
        times[minIndex],     speeds[minIndex],
        times[minIndex + 1], speeds[minIndex + 1]
      );
      if (v.x >= times[minIndex - 1] && v.x <= times[minIndex + 1]) {
        entryTime = v.x;
        entrySpeed = v.y;
      }
    }
    landmarks.push({ time: entryTime, speed: entrySpeed, label: 'ENTRY' });
  }

  // 3. EXTRACTION - zero-crossing of acceleration (pos→neg) closest to mid-stroke
  const accel = calculateAcceleration(times, speeds);
  const decelerationStarts = [];
  for (let i = 0; i < accel.length - 1; i++) {
    if (accel[i] >= 0 && accel[i + 1] < 0) {
      decelerationStarts.push(i);
    }
  }
  let extractionIndex = -1;
  if (decelerationStarts.length > 0) {
    extractionIndex = decelerationStarts.reduce((best, idx) =>
      Math.abs(times[idx] - midTime) < Math.abs(times[best] - midTime) ? idx : best
    );
    const ext = accelZeroCrossing(times, speeds, accel, extractionIndex);
    landmarks.push({ time: ext.time, speed: ext.speed, label: 'EXTRACTION' });

    // BODIES OVER - zero-crossing of acceleration (neg→pos) after extraction
    for (let i = extractionIndex + 1; i < accel.length - 1; i++) {
      if (accel[i] < 0 && accel[i + 1] >= 0) {
        const bo = accelZeroCrossing(times, speeds, accel, i);
        landmarks.push({ time: bo.time, speed: bo.speed, label: 'BODIES OVER' });
        break;
      }
    }
  }

  // 4. PEAK SPEED - true maximum via parabolic interpolation
  const maxSpeed = Math.max(...speeds);
  const maxIndex = speeds.indexOf(maxSpeed);
  if (maxIndex > 0 && maxIndex < speeds.length - 1) {
    let peakTime = times[maxIndex], peakSpeed = speeds[maxIndex];
    const v = parabolaVertex(
      times[maxIndex - 1], speeds[maxIndex - 1],
      times[maxIndex],     speeds[maxIndex],
      times[maxIndex + 1], speeds[maxIndex + 1]
    );
    if (v.x >= times[maxIndex - 1] && v.x <= times[maxIndex + 1]) {
      peakTime = v.x;
      peakSpeed = v.y;
    }
    landmarks.push({ time: peakTime, speed: peakSpeed, label: 'PEAK SPEED' });
  }

  return landmarks;
}
