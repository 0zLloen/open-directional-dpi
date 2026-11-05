/**
 * Open Directional Sensitivity — Directional Error Aggregator
 *
 * Aggregates per-trial SubmovementAnalysis observations across the 8 counter-clockwise
 * sectors (`odd-sensor-ccw`), performing Median Absolute Deviation (MAD) outlier
 * rejection and computing per-sector overshoot/undershoot statistics.
 *
 * SPDX-License-Identifier: MIT
 */

import type { SubmovementAnalysis } from "../trajectory-analysis/index.ts";

export interface SectorErrorStats {
  /** CCW sector index (0=Right, 1=Away-Right, 2=Away, ..., 7=Toward-Right) */
  sectorCcw: number;
  /** Center angle in degrees CCW [0, 315] */
  centerAngleDeg: number;
  /** Number of valid trials retained after outlier rejection */
  validTrialCount: number;
  /** Robust median of primaryDistance / targetDistance (> 1 = overshoot, < 1 = undershoot) */
  medianRadialRatio: number;
  /** Median Absolute Deviation (MAD) of radialRatio */
  madRadialRatio: number;
  /** Median signed heading error in degrees */
  medianHeadingErrorDeg: number;
}

export interface DirectionalErrorSummary {
  sectors: readonly [
    SectorErrorStats,
    SectorErrorStats,
    SectorErrorStats,
    SectorErrorStats,
    SectorErrorStats,
    SectorErrorStats,
    SectorErrorStats,
    SectorErrorStats,
  ];
  totalValidTrials: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 1.0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : 0.5 * (sorted[mid - 1]! + sorted[mid]!);
}

/**
 * Aggregate analyzed trials into 8 counter-clockwise sector statistics with MAD filtering.
 */
export function aggregateDirectionalError(
  analyses: readonly SubmovementAnalysis[]
): DirectionalErrorSummary {
  const bySector: SubmovementAnalysis[][] = Array.from({ length: 8 }, () => []);
  for (const a of analyses) {
    if (a.radialRatio >= 0.4 && a.radialRatio <= 2.2) {
      bySector[a.sectorCcw & 7]!.push(a);
    }
  }

  let totalValidTrials = 0;
  const sectorStats = bySector.map((items, sectorIdx): SectorErrorStats => {
    const rawRatios = items.map((x) => x.radialRatio);
    const med = median(rawRatios);
    const absDevs = rawRatios.map((r) => Math.abs(r - med));
    const mad = median(absDevs);
    const threshold = Math.max(0.15, 3.0 * mad * 1.4826);

    const filtered = items.filter(
      (x) => Math.abs(x.radialRatio - med) <= threshold
    );
    totalValidTrials += filtered.length;

    const cleanRatios = filtered.map((x) => x.radialRatio);
    const cleanHeadings = filtered.map((x) => x.headingErrorDeg);

    return {
      sectorCcw: sectorIdx,
      centerAngleDeg: sectorIdx * 45,
      validTrialCount: filtered.length,
      medianRadialRatio: cleanRatios.length > 0 ? median(cleanRatios) : 1.0,
      madRadialRatio: mad,
      medianHeadingErrorDeg:
        cleanHeadings.length > 0 ? median(cleanHeadings) : 0.0,
    };
  });

  return {
    sectors: sectorStats as unknown as DirectionalErrorSummary["sectors"],
    totalValidTrials,
  };
}
