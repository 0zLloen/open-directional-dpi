/**
 * Open Directional Sensitivity — calibration CLI
 *
 * Turns an aim-trainer session into an `open-directional-dpi-v1` profile JSON that
 * `tools/odd_profile.py load` accepts, or prints a profile JSON for another adapter:
 *
 *   node --experimental-strip-types calibration/cli.ts mouse-log mouse-log.csv --dpi 800 > profile.json
 *   node --experimental-strip-types calibration/cli.ts kovaaks mouse-log.csv *Stats.csv --dpi 800 > profile.json
 *   node --experimental-strip-types calibration/cli.ts format profile.json --format qmk
 *
 * Options: --only-at-dpi, --normalization mean-preserving (default) | cpi-headroom | none,
 * --window N (travel window in counts, 0..128), --format json (default) | evdev | qmk | dts.
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
import * as ddpi from "../integrations/openmouse/src/directional-dpi.ts";
import {
  clampDpi,
  DDPI_FLAG_ENABLED,
  DDPI_FLAG_FRAME_SENSOR_CCW,
  DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE,
  DDPI_FLAG_ONLY_AT_BASE_DPI,
  DDPI_MAX_WINDOW_COUNTS,
  DdpiDirection,
  exportProfileJson,
  importProfileJson,
  multiplierIndexForDirection,
  type DdpiProfileV1,
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
  /** Travel window L in counts (0 = per-report direction); default DPI / 50.8 */
  windowCounts?: number;
}

/**
 * Analyses -> canonical profile JSON. `baseDpi` is the sensor DPI to run:
 * the playing DPI, or the raised DPI for "cpi-headroom". The travel window
 * follows that DPI (about 0.5 mm: DPI / 50.8 counts) unless `windowCounts` is given.
 */
export function buildProfile(
  analyses: readonly SubmovementAnalysis[],
  opts: ProfileOptions
): { json: string; profile: DdpiProfileV1; summary: string; sparseDirections: string[] } {
  const errors = aggregateDirectionalError(analyses);
  const generated = generateCalibratedProfile(errors, {
    baseCpi: opts.dpi,
    normalization: opts.normalization ?? "mean-preserving",
  });
  const p = generated.firmwareProfile;
  p.baseDpi = clampDpi(generated.recommendedSensorCpi);
  p.reserved = opts.windowCounts ??
    Math.min(DDPI_MAX_WINDOW_COUNTS, Math.max(1, Math.round(p.baseDpi / 50.8)));
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
  return { json: exportProfileJson(p), profile: p, summary, sparseDirections };
}

/** E SE S SW W NW N NE: the order of the evdev arguments, DDPI_DIR_* and multipliers-q8-8 */
const HID_DIRECTIONS = Object.keys(DdpiDirection);
const hidMultipliers = (p: DdpiProfileV1): number[] =>
  HID_DIRECTIONS.map((_, d) => p.multipliersQ8_8[multiplierIndexForDirection(p.flags, d)]!);
const windowCounts = (p: DdpiProfileV1): number => Math.min(DDPI_MAX_WINDOW_COUNTS, p.reserved & 0xff);
const idleMs = (p: DdpiProfileV1): number => (p.reserved >> 8) * 5 || 50; // 0 = firmware default, 50 ms
const hex = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(4, "0")}`;
/** C names of the DDPI_FLAG_* bits set in `flags` */
const flagNames = (flags: number): string[] =>
  Object.entries(ddpi)
    .filter(([name, bit]) => name.startsWith("DDPI_FLAG_") && (flags & (bit as number)) !== 0)
    .map(([name]) => name);

/** The evdev arguments and the devicetree hold only an enabled angular-gain curve */
function assertPlainCurve(p: DdpiProfileV1, target: string, idleSettable: boolean): void {
  const extra = flagNames(p.flags &
    ~(DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW | DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE));
  if ((p.flags & DDPI_FLAG_ENABLED) === 0) extra.push("a disabled profile");
  if (!idleSettable && idleMs(p) !== 50) extra.push(`idleResetMs ${idleMs(p)}`);
  if (extra.length) throw new Error(`${target} cannot take ${extra.join(", ")}: use --format json or qmk`);
}

/** Output formats: the profile as each adapter takes it (see its README) */
export const FORMATS: Record<string, (p: DdpiProfileV1) => string> = {
  json: exportProfileJson,
  /** odd_evdev_filter arguments after the device: E SE S SW W NW N NE window (global gain folded in) */
  evdev: (p) => {
    assertPlainCurve(p, "odd_evdev_filter", false);
    return [...hidMultipliers(p).map((m) => (m * p.globalGainQ8_8) / 65536), windowCounts(p)].join(" ");
  },
  /** adapters/qmk: lines for keyboard_post_init_user() */
  qmk: (p) => [
    "    /* after odd_qmk_init(): profile from calibration/cli.ts */",
    "    ddpi_profile_v1_t p = odd_qmk_get_engine()->profile;",
    `    p.flags = ${flagNames(p.flags & ~DDPI_FLAG_FRAME_SENSOR_CCW).join(" | ") || "0"};`,
    `    p.base_dpi = ${p.baseDpi};`,
    `    p.global_gain_q8_8 = ${hex(p.globalGainQ8_8)};`,
    ...hidMultipliers(p).map((m, d) => `    p.multipliers_q8_8[DDPI_DIR_${HID_DIRECTIONS[d]}] = ${hex(m)};`),
    `    p.reserved = ${hex(p.reserved)}; /* travel window ${windowCounts(p)} counts, idle reset ${idleMs(p)} ms */`,
    "    ddpi_engine_set_profile(odd_qmk_get_engine(), &p);",
  ].join("\n"),
  /** adapters/zephyr: properties of the odd,directional-dpi node */
  dts: (p) => {
    assertPlainCurve(p, "the devicetree", true);
    return [
      "\t/* odd,directional-dpi properties from calibration/cli.ts */",
      `\tbase-dpi = <${p.baseDpi}>;`,
      `\tglobal-gain-q8-8 = <${p.globalGainQ8_8}>;`,
      `\tmultipliers-q8-8 = <${hidMultipliers(p).join(" ")}>; /* ${HID_DIRECTIONS.join(" ")} */`,
      `\twindow-counts = <${windowCounts(p)}>;`,
      `\tidle-ms = <${idleMs(p)}>;`,
    ].join("\n");
  },
};

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
        window: { type: "string" },
        format: { type: "string", default: "json" },
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
  const window = values.window === undefined ? undefined : Number(values.window);
  const convert = provider === "format";
  if (!(convert ? files.length === 1
        : Object.hasOwn(PROVIDERS, provider) && files.length >= (provider === "kovaaks" ? 2 : 1) &&
          dpi >= 50 && dpi <= 65535 &&
          ["mean-preserving", "cpi-headroom", "none"].includes(normalization!)) ||
      !Object.hasOwn(FORMATS, values.format!) ||
      !(window === undefined || (Number.isInteger(window) && window >= 0 && window <= DDPI_MAX_WINDOW_COUNTS))) {
    const common = " [--window <0..128>] [--format json|evdev|qmk|dts]";
    for (const [name, [args]] of Object.entries(PROVIDERS)) {
      console.error(`usage: cli.ts ${name} ${args} --dpi <50..65535> [--only-at-dpi]` +
        ` [--normalization mean-preserving|cpi-headroom|none]${common} > profile.json`);
    }
    console.error(`       cli.ts format <profile.json>${common}`);
    return 2;
  }
  let profile: DdpiProfileV1;
  let summary: string;
  let text: string;
  try {
    if (convert) {
      profile = importProfileJson(readFileSync(files[0]!, "utf8"));
      if (window !== undefined) profile.reserved = (profile.reserved & 0xff00) | window;
      summary = `set the sensor to ${profile.baseDpi} DPI`;
    } else {
      const analyses = PROVIDERS[provider]![1](files.map((f) => readFileSync(f, "utf8")));
      if (analyses.length === 0) throw new Error(`no usable flicks in ${files.join(", ")}`);
      ({ profile, summary } = buildProfile(analyses, {
        dpi, onlyAtBaseDpi: values["only-at-dpi"], normalization, windowCounts: window,
      }));
    }
    text = FORMATS[values.format!]!(profile);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.error(summary);
  console.log(text);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
