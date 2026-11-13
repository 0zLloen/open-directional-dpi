/**
 * Open Directional Sensitivity — KovaaK's provider
 *
 * KovaaK's own files hold no positions: Stats.csv has one row per kill (wall-clock
 * Timestamp, Bot, Shots, Hits, ...) and the .perf file 1 Hz counters. So the
 * trajectory comes from a mouse log (../mouse-log) recorded while playing a scenario
 * with static targets and one click per kill (e.g. 1wall 6targets); the kill list
 * keeps only flicks from one kill to the next with no missed click in between.
 *
 * Stats.csv (`FPSAimTrainer/stats/<Scenario> - Challenge - <date> Stats.csv`, CRLF)
 * starts with the kill list, ended by a blank line:
 *   Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots
 *   1,18:59:34.330,target,BB Gun,0.000000s,1,1,1.000000,1.000000,1.000000,1.000000,0,0
 * (3.9.x; 2019 builds had no OverShots and wrote Timestamp as 18:40:38:488).
 *
 * SPDX-License-Identifier: MIT
 */

import type { SubmovementAnalysis } from "../../core/trajectory-analysis/index.ts";
import {
  analyzeFlicks,
  flicksFromMouseLog,
  parseMouseTesterCsv,
  type Flick,
} from "../mouse-log/index.ts";

/** A kill and its click are logged by different clocks; this much disagreement still matches */
export const MATCH_TOLERANCE_MS = 30;

/** Kill times in ms (time of day; runs past midnight keep counting up) */
export function parseKovaaksKillTimes(statsCsv: string): number[] {
  const lines = statsCsv.replace(/^﻿/, "").split(/\r?\n/);
  const col = lines[0]!.split(",").indexOf("Timestamp");
  if (!lines[0]!.startsWith("Kill #,") || col < 0) {
    throw new Error('not a KovaaK\'s Stats.csv (first line must be "Kill #,Timestamp,...")');
  }
  const times: number[] = [];
  let dayMs = 0;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") break;
    const m = /^(\d+):(\d+):(\d+)[.:](\d+)$/.exec(line.split(",")[col] ?? "");
    if (!m) continue;
    const t = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 +
      Math.round(Number(`0.${m[4]}`) * 1000);
    if (times.length && t + dayMs < times[times.length - 1]!) dayMs += 86_400_000;
    times.push(t + dayMs);
  }
  return times;
}

/**
 * The flicks (from flicksFromMouseLog) that run from one kill's click to the next
 * kill's click. Stats.csv times are wall clock and the mouse log's count from its
 * first event, so first find the offset that lines up the most kills with clicks.
 */
export function selectKillFlicks(killTimes: readonly number[], flicks: readonly Flick[]): Flick[] {
  // Every click of the log; flicks[c - 1] runs from click c - 1 to click c
  const clicks = flicks.length ? [flicks[0]!.startTMs, ...flicks.map((f) => f.clickTMs)] : [];
  const nearest = (t: number): number => {
    let lo = 0;
    let hi = clicks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (clicks[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && t - clicks[lo - 1]! < clicks[lo]! - t ? lo - 1 : lo;
  };
  const matchAll = (offset: number): number[] =>
    killTimes.map((k) => {
      const i = nearest(k + offset);
      return Math.abs(clicks[i]! - (k + offset)) <= MATCH_TOLERANCE_MS ? i : -1;
    });

  let best: number[] = [];
  let bestCount = 0;
  for (const k of killTimes.slice(0, 5)) {
    for (const c of clicks) {
      const m = matchAll(c - k);
      const n = m.filter((i) => i >= 0).length;
      if (n > bestCount) [best, bestCount] = [m, n];
    }
  }
  if (bestCount < killTimes.length / 2) {
    throw new Error(
      `only ${bestCount} of ${killTimes.length} kills line up with clicks in the mouse log: ` +
      "was it recording during this run, and does the scenario kill with one click?"
    );
  }
  return best.flatMap((c, j) => (j > 0 && c > 0 && best[j - 1] === c - 1 ? [flicks[c - 1]!] : []));
}

/** One mouse log covering one or more KovaaK's runs, and each run's Stats.csv. */
export function ingestKovaaks(mouseTesterCsv: string, statsCsvs: readonly string[]): SubmovementAnalysis[] {
  const flicks = flicksFromMouseLog(parseMouseTesterCsv(mouseTesterCsv));
  return analyzeFlicks(statsCsvs.flatMap((s) => selectKillFlicks(parseKovaaksKillTimes(s), flicks)));
}
