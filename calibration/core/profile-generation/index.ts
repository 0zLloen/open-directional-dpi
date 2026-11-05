/**
 * Open Directional Sensitivity — Calibrated Profile Generator
 *
 * Transforms 8-sector DirectionalErrorSummary statistics into a calibrated
 * Open Directional Sensitivity profile (`DdpiProfileV1` + CPI headroom metadata).
 *
 * SPDX-License-Identifier: MIT
 */

import type { DirectionalErrorSummary } from "../directional-error/index.ts";
import {
  createDefaultProfileV1,
  DDPI_DEFAULT_WINDOW_COUNTS,
  DDPI_FLAG_ENABLED,
  DDPI_FLAG_FRAME_SENSOR_CCW,
  floatToQ8_8,
  q8_8ToFloat,
  serializeProfileV1,
  deserializeProfileV1,
  type DdpiProfileV1,
  type EightMultipliers,
} from "../../../integrations/openmouse/src/directional-dpi.ts";

export interface ProfileGenerationOptions {
  /** User's target base CPI (e.g. 800, 1600) */
  baseCpi: number;
  /** Minimum allowed directional gain before normalization (default 0.80) */
  minGain?: number;
  /** Maximum allowed directional gain before normalization (default 1.25) */
  maxGain?: number;
  /** Circular neighbor smoothing weight (default 0.15 for each neighbor, 0.70 center) */
  neighborSmoothing?: number;
  /** Travel-window estimator length L in sensor counts (default 16) */
  windowCounts?: number;
  /** Normalization mode: "cpi-headroom" scales sensor CPI by max(G) so firmware gains <= 1.0 */
  normalization?: "none" | "cpi-headroom" | "mean-preserving";
}

export interface GeneratedCalibrationProfile {
  /** Unnormalized CCW directional gains (0=Right, 1=Away-Right, 2=Away, ..., 7=Toward-Right) */
  calibratedGainsCcw: EightMultipliers;
  /** Recommended hardware sensor CPI (`round(baseCpi * maxGain)` when using cpi-headroom) */
  recommendedSensorCpi: number;
  /** Ready-to-flash 28-byte firmware profile structure (with CRC-16 and CCW frame flag) */
  firmwareProfile: DdpiProfileV1;
}

/**
 * Generate a calibrated Open Directional Sensitivity profile from directional error stats.
 */
export function generateCalibratedProfile(
  summary: DirectionalErrorSummary,
  options: ProfileGenerationOptions
): GeneratedCalibrationProfile {
  const minGain = options.minGain ?? 0.8;
  const maxGain = options.maxGain ?? 1.25;
  const wNeighbor = options.neighborSmoothing ?? 0.15;
  const wCenter = 1.0 - 2.0 * wNeighbor;
  const windowCounts = options.windowCounts ?? DDPI_DEFAULT_WINDOW_COUNTS;
  const normalization = options.normalization ?? "cpi-headroom";

  // 1. Inverse median radial ratio per sector: G_raw = clamp(1 / medianRatio, minGain, maxGain)
  const rawGains = summary.sectors.map((s) => {
    if (s.validTrialCount === 0 || s.medianRadialRatio <= 0) {
      return 1.0;
    }
    const inv = 1.0 / s.medianRadialRatio;
    return Math.min(maxGain, Math.max(minGain, inv));
  });

  // 2. Circular periodic smoothing across adjacent octants
  const smoothedCcw: EightMultipliers = [1, 1, 1, 1, 1, 1, 1, 1];
  for (let i = 0; i < 8; i++) {
    if (summary.sectors[i]!.validTrialCount === 0) {
      smoothedCcw[i] = 1.0;
      continue;
    }
    const prev = rawGains[(i + 7) % 8]!;
    const cur = rawGains[i]!;
    const next = rawGains[(i + 1) % 8]!;
    const val = wNeighbor * prev + wCenter * cur + wNeighbor * next;
    smoothedCcw[i] = Number(
      Math.min(maxGain, Math.max(minGain, val)).toFixed(4)
    );
  }

  // 3. Apply requested normalization mode
  let recommendedSensorCpi = Math.round(options.baseCpi);
  const firmwareMultipliersQ8_8: EightMultipliers = [
    256, 256, 256, 256, 256, 256, 256, 256,
  ];

  if (normalization === "cpi-headroom") {
    const peakGain = Math.max(...smoothedCcw, 1.0);
    recommendedSensorCpi = Math.round(options.baseCpi * peakGain);
    for (let i = 0; i < 8; i++) {
      const internalGain = smoothedCcw[i]! / peakGain;
      firmwareMultipliersQ8_8[i] = floatToQ8_8(Math.min(1.0, internalGain));
    }
  } else if (normalization === "mean-preserving") {
    const meanGain = smoothedCcw.reduce((a, b) => a + b, 0) / 8.0;
    for (let i = 0; i < 8; i++) {
      firmwareMultipliersQ8_8[i] = floatToQ8_8(smoothedCcw[i]! / meanGain);
    }
  } else {
    for (let i = 0; i < 8; i++) {
      firmwareMultipliersQ8_8[i] = floatToQ8_8(smoothedCcw[i]!);
    }
  }

  const baseProfile = createDefaultProfileV1(options.baseCpi);
  baseProfile.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW;
  baseProfile.multipliersQ8_8 = firmwareMultipliersQ8_8;
  baseProfile.reserved = windowCounts & 0xff;

  const serialized = serializeProfileV1(baseProfile);
  const signedProfile = deserializeProfileV1(serialized);

  // Ensure calibratedGainsCcw reflects exact Q8.8 quantization when normalization="none"
  if (normalization === "none") {
    for (let i = 0; i < 8; i++) {
      smoothedCcw[i] = q8_8ToFloat(signedProfile.multipliersQ8_8[i]!);
    }
  }

  return {
    calibratedGainsCcw: smoothedCcw,
    recommendedSensorCpi,
    firmwareProfile: signedProfile,
  };
}
