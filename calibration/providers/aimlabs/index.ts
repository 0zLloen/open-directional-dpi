/**
 * Open Directional Sensitivity — Aimlabs SpiderShot / Mouselabs Telemetry Provider
 *
 * Converts Aimlabs SpiderShot center-out task exports into SubmovementAnalysis
 * observations for Open Directional Sensitivity profile generation.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  angleToCcwSector,
  computeCcwAngleDeg,
  type SubmovementAnalysis,
} from "../../core/trajectory-analysis/index.ts";

export interface AimlabsSpiderShotTrial {
  /** Target angle in degrees CCW (0=Right, 90=Up/Away) or target delta (dx, dyHid) */
  angleCcwDeg?: number;
  targetDx?: number;
  targetDyHid?: number;
  /** Target distance in counts/units */
  targetDistance: number;
  /** Distance traveled at initial flick stop before micro-correction */
  initialFlickDistance: number;
  /** Optional angular error in degrees */
  angularErrorDeg?: number;
}

export interface AimlabsCalibrationExport {
  taskName: string;
  trials: readonly AimlabsSpiderShotTrial[];
}

/**
 * Ingest an Aimlabs SpiderShot directional export into SubmovementAnalysis records.
 */
export function ingestAimlabsExport(
  data: AimlabsCalibrationExport
): SubmovementAnalysis[] {
  const results: SubmovementAnalysis[] = [];
  for (const t of data.trials) {
    if (t.targetDistance <= 0 || t.initialFlickDistance <= 0) {
      continue;
    }
    const targetAngleCcwDeg =
      t.angleCcwDeg !== undefined
        ? ((t.angleCcwDeg % 360) + 360) % 360
        : computeCcwAngleDeg(t.targetDx ?? 1, t.targetDyHid ?? 0);
    const sectorCcw = angleToCcwSector(targetAngleCcwDeg);
    const radialRatio = t.initialFlickDistance / t.targetDistance;

    results.push({
      targetAngleCcwDeg,
      sectorCcw,
      targetDistance: t.targetDistance,
      primaryDistance: t.initialFlickDistance,
      radialRatio,
      headingErrorDeg: t.angularErrorDeg ?? 0,
      pathLengthRatio: Math.max(1.0, radialRatio),
      submovementCount: Math.abs(radialRatio - 1.0) > 0.08 ? 2 : 1,
    });
  }
  return results;
}
