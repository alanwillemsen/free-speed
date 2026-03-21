/**
 * Physics calculations for rowing energy equivalence modeling
 * Based on P(t) = k * v(t)^3
 */

// Drag coefficient - calibrated value for rowing
const DRAG_COEFFICIENT = 50.0; // kg/m

/**
 * Calculate power at a given velocity
 * P = k * v^3
 */
export function calculatePower(velocity) {
  return DRAG_COEFFICIENT * Math.pow(velocity, 3);
}

/**
 * Calculate total energy for a velocity curve over time
 * E = ∫ P(t) dt = ∫ k * v(t)^3 dt
 *
 * Uses trapezoidal integration
 */
export function calculateEnergy(times, speeds) {
  if (times.length !== speeds.length || times.length < 2) {
    return 0;
  }

  let totalEnergy = 0;

  for (let i = 0; i < times.length - 1; i++) {
    const dt = times[i + 1] - times[i];
    const p1 = calculatePower(speeds[i]);
    const p2 = calculatePower(speeds[i + 1]);

    // Trapezoidal rule: (P1 + P2) / 2 * dt
    totalEnergy += (p1 + p2) / 2 * dt;
  }

  return totalEnergy;
}

/**
 * Calculate average power for a curve
 */
export function calculateAveragePower(times, speeds) {
  const totalEnergy = calculateEnergy(times, speeds);
  const totalTime = times[times.length - 1] - times[0];
  return totalEnergy / totalTime;
}

/**
 * Calculate energy for a full race
 * @param {number} strokeEnergy - Energy per stroke
 * @param {number} raceTime - Total race time in seconds
 * @param {number} strokeDuration - Duration of one stroke in seconds
 */
export function calculateRaceEnergy(strokeEnergy, raceTime, strokeDuration) {
  const numStrokes = raceTime / strokeDuration;
  return strokeEnergy * numStrokes;
}

/**
 * Estimate finish time for Curve B when constrained to Curve A's energy budget
 *
 * Formula: T_B = T_A * (MeanPower_B / MeanPower_A)^(1/3)
 *
 * @param {number} referenceTime - Finish time for Curve A (seconds)
 * @param {number} referencePower - Average power for Curve A
 * @param {number} testPower - Average power for Curve B (at same avg velocity)
 */
export function estimateFinishTime(referenceTime, referencePower, testPower) {
  const ratio = testPower / referencePower;
  const finishTime = referenceTime * Math.pow(ratio, 1/3);
  const timeDifference = finishTime - referenceTime;

  return {
    finishTime,
    timeDifference,
    ratio,
    percentIncrease: ((ratio - 1) * 100)
  };
}

/**
 * Calculate the energy penalty (extra energy due to velocity variation)
 */
export function calculateEnergyPenalty(actualEnergy, optimalEnergy) {
  return {
    penalty: actualEnergy - optimalEnergy,
    percentPenalty: ((actualEnergy / optimalEnergy - 1) * 100)
  };
}

/**
 * Scale a curve to achieve a target average velocity
 * Returns the scaling factor needed
 */
export function calculateScalingFactor(currentAvg, targetAvg) {
  return targetAvg / currentAvg;
}

/**
 * Calculate what average velocity Curve B could achieve with Curve A's energy budget
 *
 * If energy_A = ∫ k * v_A^3 dt and we want energy_B = energy_A with curve shape B:
 * energy_A = ∫ k * (c * v_B)^3 dt = c^3 * ∫ k * v_B^3 dt
 * So: c = (energy_A / energy_B)^(1/3)
 */
export function calculateEquivalentVelocity(energyA, energyB, avgVelocityB) {
  const scalingFactor = Math.pow(energyA / energyB, 1/3);
  return avgVelocityB * scalingFactor;
}
