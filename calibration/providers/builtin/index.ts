/**
 * Open Directional Sensitivity — Built-in Center-Out Calibration Provider
 *
 * Generates randomized 8-direction center-out trial schedules and ingests raw
 * Pointer Lock / evdev movement logs into the trajectory analysis pipeline.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  analyzeTrialTrajectory,
  type CalibrationTrialInput,
  type SubmovementAnalysis,
} from "../../core/trajectory-analysis/index.ts";

export interface BuiltinTrialScheduleItem {
  sectorCcw: number;
  angleCcwDeg: number;
  distanceCounts: number;
  targetX: number;
  targetY: number;
  targetRadius: number;
}

/**
 * Generate a balanced, deterministic or randomized center-out trial schedule
 * across all 8 counter-clockwise directions at 3 radial distances.
 */
export function createBuiltinTrialSchedule(
  trialsPerDirection = 8,
  distances: readonly [number, number, number] = [140, 210, 280],
  targetRadius = 14
): BuiltinTrialScheduleItem[] {
  const schedule: BuiltinTrialScheduleItem[] = [];
  for (let t = 0; t < trialsPerDirection; t++) {
    const dist = distances[t % distances.length]!;
    for (let s = 0; s < 8; s++) {
      const deg = s * 45;
      const rad = (deg * Math.PI) / 180;
      schedule.push({
        sectorCcw: s,
        angleCcwDeg: deg,
        distanceCounts: dist,
        targetX: Number((dist * Math.cos(rad)).toFixed(2)),
        targetY: Number((-dist * Math.sin(rad)).toFixed(2)),
        targetRadius,
      });
    }
  }
  return schedule;
}

/**
 * Analyze a batch of completed built-in calibration trials.
 */
export function ingestBuiltinSession(
  trials: readonly CalibrationTrialInput[]
): SubmovementAnalysis[] {
  const results: SubmovementAnalysis[] = [];
  for (const t of trials) {
    const a = analyzeTrialTrajectory(t);
    if (a !== null) {
      results.push(a);
    }
  }
  return results;
}
