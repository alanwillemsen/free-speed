/**
 * Physics calculations for rowing dynamics
 * Simplified model: drag force proportional to v³
 */

// Drag coefficient calibrated such that constant velocity achieves target time
// We'll calibrate this based on the default parameters
let dragCoefficient = 1.0; // Will be set by calibration

/**
 * Set the drag coefficient based on race parameters
 * For constant velocity rowing, we need the coefficient that makes the physics work out
 */
export function calibrateDragCoefficient(avgVelocity) {
  // We use a simplified model where power = k * v³
  // The coefficient is calibrated so our calculations are relative
  // Using a reference value based on typical rowing physics
  dragCoefficient = 50.0; // Empirical constant for rowing (kg/m)
}

/**
 * Calculate drag force at a given velocity
 * F = k * v² (simplified from full fluid dynamics)
 */
export function calculateDragForce(velocity) {
  return dragCoefficient * velocity * velocity;
}

/**
 * Calculate power required at a given velocity
 * P = F * v = k * v³
 */
export function calculatePower(velocity) {
  return dragCoefficient * velocity * velocity * velocity;
}

/**
 * Calculate energy for a speed curve over one stroke
 * Integrates power over time using trapezoidal rule
 *
 * @param {Array<number>} speedCurve - Array of velocities (m/s)
 * @param {number} strokeTime - Duration of one stroke (seconds)
 * @returns {number} Energy in Joules
 */
export function calculateEnergy(speedCurve, strokeTime) {
  if (speedCurve.length < 2) return 0;

  const dt = strokeTime / (speedCurve.length - 1);
  let energy = 0;

  // Trapezoidal integration: E = ∫ P dt
  for (let i = 0; i < speedCurve.length - 1; i++) {
    const p1 = calculatePower(speedCurve[i]);
    const p2 = calculatePower(speedCurve[i + 1]);
    energy += (p1 + p2) / 2 * dt;
  }

  return energy;
}

/**
 * Estimate finish time if user maintains optimal energy budget
 *
 * @param {Array<number>} userCurve - User's speed curve
 * @param {number} optimalEnergy - Energy per stroke for optimal curve
 * @param {object} params - Race parameters
 * @returns {object} { finishTime, timeDifference, userEnergy, userAvgVelocity }
 */
export function estimateFinishTime(userCurve, optimalEnergy, params) {
  const { strokeTime, raceDistance, targetTime } = params;

  // Calculate user's actual average velocity and energy
  const userAvgVelocity = userCurve.reduce((sum, v) => sum + v, 0) / userCurve.length;
  const userEnergy = calculateEnergy(userCurve, strokeTime);

  // If user curve uses same energy per stroke, what average velocity could they achieve?
  // Since E = ∫(k*v³)dt, for constant velocity: E = k*v³*T
  // So v = (E / (k*T))^(1/3)
  const achievableAvgVelocity = Math.pow(optimalEnergy / (dragCoefficient * strokeTime), 1/3);

  // Calculate finish time with this velocity
  const finishTime = raceDistance / achievableAvgVelocity;
  const timeDifference = finishTime - targetTime;

  return {
    finishTime,
    timeDifference,
    userEnergy,
    userAvgVelocity,
    achievableAvgVelocity
  };
}

/**
 * Calculate the theoretical minimum energy for a given average velocity
 * This is the energy for perfectly constant velocity
 */
export function calculateMinimumEnergy(avgVelocity, strokeTime) {
  const constantPower = calculatePower(avgVelocity);
  return constantPower * strokeTime;
}
