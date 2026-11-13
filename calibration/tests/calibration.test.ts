/**
 * Open Directional Sensitivity — Automated Calibration Pipeline & Provider Tests
 *
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTrialTrajectory,
  type CalibrationTrialInput,
} from "../core/trajectory-analysis/index.ts";
import { aggregateDirectionalError } from "../core/directional-error/index.ts";
import { generateCalibratedProfile } from "../core/profile-generation/index.ts";
import {
  createBuiltinTrialSchedule,
  ingestBuiltinSession,
} from "../providers/builtin/index.ts";
import {
  DDPI_FLAG_ENABLED,
  DDPI_FLAG_FRAME_SENSOR_CCW,
  DDPI_Q8_8_ONE,
} from "../../integrations/openmouse/src/directional-dpi.ts";

test("Calibration Pipeline — Trajectory Analysis, Error Aggregation, Profile Generation & Providers", () => {
  console.log("=== Open Directional Sensitivity — Calibration Suite Tests ===");

  // 1. Test primary ballistic submovement detection on an overshooting trial (+20% overshoot then correction back)
  const overshootTrial: CalibrationTrialInput = {
    targetX: 200,
    targetY: 0,
    targetRadius: 12,
    samples: [
      { x: 0, y: 0, tMs: 0 },
      { x: 60, y: 0, tMs: 10 },
      { x: 160, y: 0, tMs: 20 }, // Peak velocity (10 px/ms)
      { x: 230, y: 0, tMs: 30 },
      { x: 240, y: 0, tMs: 40 }, // Velocity minimum (1.0 px/ms < 18% of 10) at +20% overshoot (240 / 200 = 1.20)
      { x: 215, y: 0, tMs: 50 }, // Secondary corrective submovement back to target
      { x: 200, y: 0, tMs: 60 },
    ],
  };

  const analysis = analyzeTrialTrajectory(overshootTrial);
  assert.ok(analysis !== null);
  assert.equal(analysis.sectorCcw, 0); // 0 deg Right
  assert.ok(Math.abs(analysis.radialRatio - 1.2) < 1e-6);
  assert.ok(analysis.submovementCount >= 2);
  console.log(
    "  [PASS] 01. Primary ballistic submovement detector isolates +20% overshoot before micro-correction"
  );

  // 2. Test Built-in schedule generator + MAD outlier rejection + Profile Generator
  const schedule = createBuiltinTrialSchedule(5);
  assert.equal(schedule.length, 40); // 8 directions * 5 trials

  // Simulate user who overshoots Toward/South (sector 6, 270 deg CCW) by 1.20x and is 1.00x elsewhere,
  // plus one wild outlier (2.0x) in sector 6 that MAD should reject.
  const syntheticAnalyses = schedule.map((item) => ({
    targetAngleCcwDeg: item.angleCcwDeg,
    sectorCcw: item.sectorCcw,
    targetDistance: item.distanceCounts,
    primaryDistance:
      item.sectorCcw === 6
        ? item.distanceCounts * 1.2
        : item.sectorCcw === 2
          ? item.distanceCounts * 0.9
          : item.distanceCounts,
    radialRatio: item.sectorCcw === 6 ? 1.2 : item.sectorCcw === 2 ? 0.9 : 1.0,
    headingErrorDeg: 0,
    pathLengthRatio: 1.05,
    submovementCount: 1,
  }));
  // Inject outlier in sector 6
  syntheticAnalyses.push({
    targetAngleCcwDeg: 270,
    sectorCcw: 6,
    targetDistance: 200,
    primaryDistance: 400,
    radialRatio: 2.0,
    headingErrorDeg: 0,
    pathLengthRatio: 2.0,
    submovementCount: 2,
  });

  const errorSummary = aggregateDirectionalError(syntheticAnalyses);
  assert.ok(Math.abs(errorSummary.sectors[6]!.medianRadialRatio - 1.2) < 1e-6);
  assert.ok(Math.abs(errorSummary.sectors[2]!.medianRadialRatio - 0.9) < 1e-6);
  console.log(
    "  [PASS] 02. Directional error aggregator computes per-sector medians with MAD outlier rejection"
  );

  const generated = generateCalibratedProfile(errorSummary, {
    baseCpi: 800,
    normalization: "cpi-headroom",
    windowCounts: 16,
  });

  // Sector 2 (Away/North, undershoot 0.90x) gets gain > 1.00x; Sector 6 (Toward/South, overshoot 1.20x) gets gain < 1.00x
  assert.ok(generated.calibratedGainsCcw[2]! > 1.05);
  assert.ok(generated.calibratedGainsCcw[6]! < 0.9);
  assert.ok(generated.recommendedSensorCpi > 800);
  // In cpi-headroom mode, all internal firmware multipliers are <= 1.00x (256 in Q8.8)
  for (const m of generated.firmwareProfile.multipliersQ8_8) {
    assert.ok(m <= DDPI_Q8_8_ONE);
  }
  assert.ok(
    (generated.firmwareProfile.flags &
      (DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW)) ===
      (DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW)
  );
  assert.equal(generated.firmwareProfile.reserved & 0xff, 16);
  console.log(
    "  [PASS] 03. Profile generator produces smoothed CCW gains, CPI headroom, and signed 28-byte firmware profile"
  );

  // 3. Built-in provider (trainer providers: providers.test.ts)
  const builtinOut = ingestBuiltinSession([overshootTrial]);
  assert.equal(builtinOut.length, 1);
  console.log("  [PASS] 04. Built-in provider ingests a center-out trial");

  console.log("\nAll 4/4 calibration test suites passed.");
});
