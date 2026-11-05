/**
 * Open Directional Sensitivity — AimFroge Telemetry Provider
 *
 * Converts AimFroge open aim-trainer flick session logs into SubmovementAnalysis
 * observations for directional sensitivity profile generation.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  analyzeTrialTrajectory,
  type SubmovementAnalysis,
  type TrajectorySample,
} from "../../core/trajectory-analysis/index.ts";

export interface AimFrogeFlickEvent {
  originX: number;
  originY: number;
  targetX: number;
  targetY: number;
  targetRadius: number;
  trace: ReadonlyArray<{ x: number; y: number; timestampMs: number }>;
}

export interface AimFrogeSessionLog {
  version: string;
  scenarioName: string;
  baseCpi: number;
  flicks: readonly AimFrogeFlickEvent[];
}

/**
 * Parse an AimFroge session log and extract per-direction submovement analyses.
 */
export function ingestAimFrogeSession(
  log: AimFrogeSessionLog
): SubmovementAnalysis[] {
  const analyses: SubmovementAnalysis[] = [];
  for (const flick of log.flicks) {
    const samples: TrajectorySample[] = flick.trace.map((pt) => ({
      x: pt.x - flick.originX,
      y: pt.y - flick.originY,
      tMs: pt.timestampMs,
    }));
    const res = analyzeTrialTrajectory({
      targetX: flick.targetX - flick.originX,
      targetY: flick.targetY - flick.originY,
      targetRadius: flick.targetRadius,
      samples,
    });
    if (res !== null) {
      analyses.push(res);
    }
  }
  return analyses;
}
