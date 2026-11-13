/**
 * Open Directional Sensitivity — mouse log provider
 *
 * Calibrates from a raw mouse log recorded while playing any aim-trainer task
 * with static click targets (Aimlabs SpiderShot, KovaaK's 1wall 6targets, ...).
 * Each left click ends a flick that started at the previous click: the click is
 * on the target, so the counts between two clicks are the target vector and the
 * events in between are the trajectory, in sensor counts.
 *
 * Log format: MouseTester's CSV (github.com/microe1/MouseTester, MIT,
 * MouseTester/MouseLog.cs Save/Load), also written by record-evdev.ts:
 *   line 1  description
 *   line 2  CPI
 *   line 3  xCount,yCount,Time (ms),buttonflags   (older logs: no buttonflags)
 *   then one row per raw input event: lLastX, -lLastY (MouseTester negates Y,
 *   so +y = away), ms since the first event, RAWMOUSE usButtonFlags
 *   (0x0001 = left button down).
 *
 * SPDX-License-Identifier: MIT
 */

import {
  analyzeTrialTrajectory,
  type SubmovementAnalysis,
  type TrajectorySample,
} from "../../core/trajectory-analysis/index.ts";
import { median } from "../../core/directional-error/index.ts";

export interface MouseLogEvent {
  dx: number;
  /** HID frame: +dy = toward the user */
  dy: number;
  tMs: number;
  leftDown: boolean;
}

export interface Flick {
  startTMs: number;
  /** Time of the left click that ends the flick (mouse log clock) */
  clickTMs: number;
  /** Counts from the previous click to this click (HID frame) */
  targetX: number;
  targetY: number;
  /** Trajectory from the previous click, resampled; runs on to POST_CLICK_MS after the click */
  samples: TrajectorySample[];
}

/** Resampling step: 1..8 kHz raw events are too noisy for the velocity-minimum detector */
export const RESAMPLE_MS = 4;
/** Motion kept after the click, so a flick shot that is still moving gets its real stop point */
export const POST_CLICK_MS = 100;
/** Longer click-to-click gaps are pauses, not flicks */
export const MAX_FLICK_MS = 1500;
/** Shorter flicks (relative to the median) are corrections or double clicks */
export const MIN_FLICK_FRACTION = 0.3;

export function parseMouseTesterCsv(text: string): MouseLogEvent[] {
  const lines = text.split(/\r?\n/);
  if (!lines[2]?.startsWith("xCount,yCount,Time")) {
    throw new Error('not a MouseTester log (line 3 must be "xCount,yCount,Time (ms),buttonflags")');
  }
  const events: MouseLogEvent[] = [];
  for (const line of lines.slice(3)) {
    const f = line.split(",").map(Number);
    if (f.length < 3 || f.some(Number.isNaN)) continue;
    events.push({ dx: f[0]!, dy: -f[1]! || 0, tMs: f[2]!, leftDown: ((f[3] ?? 0) & 0x0001) !== 0 });
  }
  return events;
}

function resample(samples: readonly TrajectorySample[]): TrajectorySample[] {
  const out: TrajectorySample[] = [];
  const end = samples[samples.length - 1]!.tMs;
  let i = 0;
  for (let t = 0; ; t += RESAMPLE_MS) {
    while (i + 1 < samples.length && samples[i + 1]!.tMs <= t) i++;
    out.push({ x: samples[i]!.x, y: samples[i]!.y, tMs: t });
    if (t >= end) return out;
  }
}

/** Split a log into click-to-click flicks. */
export function flicksFromMouseLog(events: readonly MouseLogEvent[]): Flick[] {
  let x = 0;
  let y = 0;
  const pts = events.map((e) => ({ x: (x += e.dx), y: (y += e.dy), tMs: e.tMs }));
  const clicks = events.flatMap((e, i) => (e.leftDown ? [i] : []));
  const flicks: Flick[] = [];
  for (let k = 1; k < clicks.length; k++) {
    const a = pts[clicks[k - 1]!]!;
    const b = pts[clicks[k]!]!;
    const next = k + 1 < clicks.length ? pts[clicks[k + 1]!]!.tMs : Infinity;
    const until = Math.min(b.tMs + POST_CLICK_MS, next);
    const samples: TrajectorySample[] = [];
    for (let i = clicks[k - 1]!; i < pts.length && pts[i]!.tMs <= until; i++) {
      samples.push({ x: pts[i]!.x - a.x, y: pts[i]!.y - a.y, tMs: pts[i]!.tMs - a.tMs });
    }
    flicks.push({
      startTMs: a.tMs,
      clickTMs: b.tMs,
      targetX: b.x - a.x,
      targetY: b.y - a.y,
      samples: resample(samples),
    });
  }
  return flicks;
}

/** Drop pauses and corrections, then measure each flick's primary submovement. */
export function analyzeFlicks(flicks: readonly Flick[]): SubmovementAnalysis[] {
  const minDistance =
    MIN_FLICK_FRACTION * median(flicks.map((f) => Math.hypot(f.targetX, f.targetY)));
  return flicks.flatMap((f) => {
    if (Math.hypot(f.targetX, f.targetY) < minDistance) return [];
    if (f.clickTMs - f.startTMs > MAX_FLICK_MS) return [];
    const a = analyzeTrialTrajectory({ ...f, targetRadius: 0 });
    return a ? [a] : [];
  });
}

export function ingestMouseLog(mouseTesterCsv: string): SubmovementAnalysis[] {
  return analyzeFlicks(flicksFromMouseLog(parseMouseTesterCsv(mouseTesterCsv)));
}
