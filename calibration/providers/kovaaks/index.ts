/**
 * Open Directional Sensitivity — KovaaK's Telemetry Provider
 *
 * Parses KovaaK's directional flick summary / per-shot CSV exports into
 * SubmovementAnalysis records for Open Directional Sensitivity calibration.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  angleToCcwSector,
  computeCcwAngleDeg,
  type SubmovementAnalysis,
} from "../../core/trajectory-analysis/index.ts";

/**
 * Parse KovaaK's directional flick CSV lines with columns:
 *   TargetDX,TargetDY,InitialLandingDX,InitialLandingDY,PathLength,Submovements
 */
export function parseKovaaksDirectionalCsv(
  csvText: string
): SubmovementAnalysis[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const results: SubmovementAnalysis[] = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith("targetdx")) {
      continue;
    }
    const parts = line.split(",").map((s) => Number(s.trim()));
    if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) {
      continue;
    }
    const [targetDx, targetDy, landDx, landDy, pathLen, submoves] = parts as [
      number,
      number,
      number,
      number,
      number | undefined,
      number | undefined,
    ];
    const targetDistance = Math.hypot(targetDx, targetDy);
    if (targetDistance < 1e-3) continue;

    const targetAngleCcwDeg = computeCcwAngleDeg(targetDx, targetDy);
    const sectorCcw = angleToCcwSector(targetAngleCcwDeg);
    const ux = targetDx / targetDistance;
    const uy = targetDy / targetDistance;
    const primaryDistance = Math.max(0, landDx * ux + landDy * uy);
    const radialRatio = primaryDistance / targetDistance;

    const landAngleCcw = computeCcwAngleDeg(landDx, landDy);
    let headingErrorDeg = landAngleCcw - targetAngleCcwDeg;
    if (headingErrorDeg > 180) headingErrorDeg -= 360;
    if (headingErrorDeg < -180) headingErrorDeg += 360;

    results.push({
      targetAngleCcwDeg,
      sectorCcw,
      targetDistance,
      primaryDistance,
      radialRatio,
      headingErrorDeg,
      pathLengthRatio:
        pathLen && pathLen >= targetDistance ? pathLen / targetDistance : 1.0,
      submovementCount: submoves && submoves >= 1 ? Math.round(submoves) : 1,
    });
  }
  return results;
}
