/**
 * Open Directional Sensitivity — Trajectory Analysis Engine
 *
 * Segments high-frequency mouse trajectories into primary ballistic submovements
 * and secondary corrective phases using kinematic velocity-minimum detection.
 *
 * SPDX-License-Identifier: MIT
 */

export interface TrajectorySample {
  /** Cumulative X displacement from trial origin (in counts or pixels) */
  x: number;
  /** Cumulative Y displacement from trial origin (in HID coordinates: +Y = toward user) */
  y: number;
  /** Monotonic timestamp in milliseconds */
  tMs: number;
}

export interface CalibrationTrialInput {
  /** Target X position relative to trial origin (HID coordinates) */
  targetX: number;
  /** Target Y position relative to trial origin (HID coordinates: -Y = away/north) */
  targetY: number;
  /** Target radius (for hit validation) */
  targetRadius: number;
  /** Ordered trajectory samples starting at (0, 0) */
  samples: readonly TrajectorySample[];
}

export interface SubmovementAnalysis {
  /** Counter-clockwise tabletop angle of target in degrees [0, 360) (0=Right, 90=Away/-Y_HID) */
  targetAngleCcwDeg: number;
  /** Nearest 8-way CCW sector index (0..7) */
  sectorCcw: number;
  /** Straight-line distance from origin to target center */
  targetDistance: number;
  /** Distance traveled at the end of the primary ballistic submovement */
  primaryDistance: number;
  /** Ratio primaryDistance / targetDistance (> 1.0 = overshoot, < 1.0 = undershoot) */
  radialRatio: number;
  /** Signed angular error at primary submovement endpoint in degrees */
  headingErrorDeg: number;
  /** Total path length divided by straight-line distance (>= 1.0) */
  pathLengthRatio: number;
  /** Number of discrete velocity peaks (corrections = max(0, peaks - 1)) */
  submovementCount: number;
}

/**
 * Compute counter-clockwise tabletop angle in degrees [0, 360) from HID coordinates
 * where +X is Right (0 deg) and -Y_HID is Away/North (90 deg).
 */
export function computeCcwAngleDeg(dx: number, dyHid: number): number {
  const rad = Math.atan2(-dyHid, dx);
  const deg = (rad * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * Map a counter-clockwise tabletop angle [0, 360) to the nearest 8-octant index (0..7).
 */
export function angleToCcwSector(angleCcwDeg: number): number {
  const normalized = ((angleCcwDeg % 360) + 360) % 360;
  return Math.round(normalized / 45) % 8;
}

/**
 * Analyze a single center-out aiming trial and extract primary ballistic submovement metrics.
 */
export function analyzeTrialTrajectory(
  trial: CalibrationTrialInput
): SubmovementAnalysis | null {
  const { samples, targetX, targetY } = trial;
  const targetDistance = Math.hypot(targetX, targetY);
  if (samples.length < 4 || targetDistance < 1e-3) {
    return null;
  }

  const targetAngleCcwDeg = computeCcwAngleDeg(targetX, targetY);
  const sectorCcw = angleToCcwSector(targetAngleCcwDeg);

  // Unit vector toward target
  const ux = targetX / targetDistance;
  const uy = targetY / targetDistance;

  const speeds: number[] = [0];
  let totalPathLen = 0;
  let peakSpeed = 0;
  let peakIdx = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const dt = Math.max(0.125, cur.tMs - prev.tMs);
    const step = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    totalPathLen += step;
    const v = step / dt;
    speeds.push(v);
    if (v > peakSpeed) {
      peakSpeed = v;
      peakIdx = i;
    }
  }

  if (peakSpeed <= 0) {
    return null;
  }

  // Locate end of primary ballistic submovement:
  // first local velocity minimum after peakSpeed where speed drops below 18% of peakSpeed
  // and projected travel exceeds 40% of targetDistance.
  let primaryIdx = samples.length - 1;
  let submovementCount = 1;
  let inDip = false;

  for (let i = Math.max(1, peakIdx + 1); i < samples.length; i++) {
    const pt = samples[i]!;
    const projDist = pt.x * ux + pt.y * uy;
    const v = speeds[i]!;

    if (
      primaryIdx === samples.length - 1 &&
      projDist >= targetDistance * 0.4 &&
      v <= peakSpeed * 0.18
    ) {
      primaryIdx = i;
    }

    if (v <= peakSpeed * 0.2) {
      inDip = true;
    } else if (inDip && v >= peakSpeed * 0.22) {
      submovementCount++;
      inDip = false;
    }
  }

  const primaryPt = samples[primaryIdx]!;
  // Projected distance along target axis at primary submovement endpoint
  const primaryProjected = primaryPt.x * ux + primaryPt.y * uy;
  const primaryDistance = Math.max(0, primaryProjected);
  const radialRatio = primaryDistance / targetDistance;

  const primaryAngleCcw = computeCcwAngleDeg(primaryPt.x, primaryPt.y);
  let headingErrorDeg = primaryAngleCcw - targetAngleCcwDeg;
  if (headingErrorDeg > 180) headingErrorDeg -= 360;
  if (headingErrorDeg < -180) headingErrorDeg += 360;

  return {
    targetAngleCcwDeg,
    sectorCcw,
    targetDistance,
    primaryDistance,
    radialRatio,
    headingErrorDeg,
    pathLengthRatio: totalPathLen / targetDistance,
    submovementCount,
  };
}
