/**
 * Open Directional Sensitivity — calibration CLI
 *
 * Turns an aim-trainer session into an `open-directional-dpi-v1` profile JSON that
 * OpenMouse `importProfileJson` and `tools/odd_profile.py load` accept:
 *
 *   node --experimental-strip-types calibration/cli.ts mouse-log mouse-log.csv --dpi 800 > profile.json
 *   node --experimental-strip-types calibration/cli.ts kovaaks mouse-log.csv *Stats.csv --dpi 800 > profile.json
 *
 * Options: --only-at-dpi, --normalization mean-preserving (default) | cpi-headroom | none.
 * The profile goes to stdout, the per-direction summary to stderr.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { SubmovementAnalysis } from "./core/trajectory-analysis/index.ts";
import { ingestMouseLog } from "./providers/mouse-log/index.ts";
import { ingestKovaaks } from "./providers/kovaaks/index.ts";
import { aggregateDirectionalError } from "./core/directional-error/index.ts";
import {
  generateCalibratedProfile,
  type ProfileGenerationOptions,
} from "./core/profile-generation/index.ts";
import {
  clampDpi,
  DDPI_FLAG_ONLY_AT_BASE_DPI,
  DDPI_MAX_WINDOW_COUNTS,
  exportProfileJson,
} from "../integrations/openmouse/src/directional-dpi.ts";

/** Trials per direction below which the gain for that direction is unreliable */
export const MIN_TRIALS_PER_DIRECTION = 5;

const SECTOR_NAMES = [
  "right", "away-right", "away", "away-left",
  "left", "toward-left", "toward", "toward-right",
];

export interface ProfileOptions {
  /** DPI the user plays at (the DPI stage used in the trainer) */
  dpi: number;
  onlyAtBaseDpi?: boolean;
  normalization?: ProfileGenerationOptions["normalization"];
}

/**
 * Analyses -> canonical profile JSON. `baseDpi` is the sensor DPI to run:
 * the playing DPI, or the raised DPI for "cpi-headroom". The travel window
 * follows that DPI (about 0.5 mm: DPI / 50.8 counts).
 */
export function buildProfile(
  analyses: readonly SubmovementAnalysis[],
  opts: ProfileOptions
): { json: string; summary: string; sparseDirections: string[] } {
  const errors = aggregateDirectionalError(analyses);
  const generated = generateCalibratedProfile(errors, {
    baseCpi: opts.dpi,
    normalization: opts.normalization ?? "mean-preserving",
  });
  const p = generated.firmwareProfile;
  p.baseDpi = clampDpi(generated.recommendedSensorCpi);
  p.reserved = Math.min(DDPI_MAX_WINDOW_COUNTS, Math.max(1, Math.round(p.baseDpi / 50.8)));
  if (opts.onlyAtBaseDpi) p.flags |= DDPI_FLAG_ONLY_AT_BASE_DPI;

  const sparseDirections: string[] = [];
  const rows = errors.sectors.map((s, i) => {
    if (s.validTrialCount < MIN_TRIALS_PER_DIRECTION) sparseDirections.push(SECTOR_NAMES[i]!);
    return `${SECTOR_NAMES[i]!.padEnd(13)} ${String(s.validTrialCount).padStart(4)}  ` +
      `${s.medianRadialRatio.toFixed(3)}  ${generated.calibratedGainsCcw[i]!.toFixed(3)}`;
  });
  const summary =
    `direction        n  ratio   gain   (ratio > 1 = overshoot)\n${rows.join("\n")}\n` +
    `set the sensor to ${p.baseDpi} DPI` +
    (sparseDirections.length
      ? `\nfewer than ${MIN_TRIALS_PER_DIRECTION} flicks (gain unreliable): ${sparseDirections.join(", ")}`
      : "");
  return { json: exportProfileJson(p), summary, sparseDirections };
}

/** provider -> [file arguments, parser of those files' contents] */
const PROVIDERS: Record<string, [string, (texts: string[]) => SubmovementAnalysis[]]> = {
  "mouse-log": ["<mouse-log.csv>", ([log]) => ingestMouseLog(log!)],
  kovaaks: ["<mouse-log.csv> <Stats.csv>...", ([log, ...stats]) => ingestKovaaks(log!, stats)],
};

function main(): number {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        dpi: { type: "string" },
        "only-at-dpi": { type: "boolean", default: false },
        normalization: { type: "string", default: "mean-preserving" },
      },
    });
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const { values, positionals } = args;
  const [provider = "", ...files] = positionals;
  const dpi = Number(values.dpi);
  const normalization = values.normalization as ProfileOptions["normalization"];
  if (!PROVIDERS[provider] || files.length < (provider === "kovaaks" ? 2 : 1) ||
      !(dpi >= 50 && dpi <= 65535) ||
      !["mean-preserving", "cpi-headroom", "none"].includes(normalization!)) {
    for (const [name, [args]] of Object.entries(PROVIDERS)) {
      console.error(`usage: cli.ts ${name} ${args} --dpi <50..65535> [--only-at-dpi]` +
        " [--normalization mean-preserving|cpi-headroom|none] > profile.json");
    }
    return 2;
  }
  let analyses: SubmovementAnalysis[];
  try {
    analyses = PROVIDERS[provider]![1](files.map((f) => readFileSync(f, "utf8")));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  if (analyses.length === 0) {
    console.error(`no usable flicks in ${files.join(", ")}`);
    return 1;
  }
  const out = buildProfile(analyses, { dpi, onlyAtBaseDpi: values["only-at-dpi"], normalization });
  console.error(out.summary);
  console.log(out.json);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
