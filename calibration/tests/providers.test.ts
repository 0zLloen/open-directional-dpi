/**
 * Open Directional Sensitivity — trainer provider tests (mouse log, KovaaK's, evdev
 * logger, CLI). Fixtures use the real file layouts with made-up values.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { aggregateDirectionalError } from "../core/directional-error/index.ts";
import {
  flicksFromMouseLog,
  ingestMouseLog,
  parseMouseTesterCsv,
} from "../providers/mouse-log/index.ts";
import { MOUSETESTER_HEADER, evdevToMouseTesterRows } from "../providers/mouse-log/record-evdev.ts";
import {
  ingestKovaaks,
  parseKovaaksKillTimes,
  selectKillFlicks,
} from "../providers/kovaaks/index.ts";
import { buildProfile, FORMATS } from "../cli.ts";
import { importProfileJson } from "../../integrations/openmouse/src/directional-dpi.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const fixture = (name: string): string => readFileSync(here(`fixtures/${name}`), "utf8");

/**
 * A 1 kHz MouseTester log of a center-out session (out to a target, click, back to
 * the center, click). Every primary movement is minimum-jerk and stops at
 * ratio[direction] x the distance, then a slow correction lands on the target.
 */
function syntheticSession(ratioCcw: readonly number[], reps = 6): string {
  const rows = ["synthetic", "800", MOUSETESTER_HEADER];
  let t = 0;
  let px = 0;
  let py = 0; // HID frame
  const click = (): void => {
    rows.push(`0,0,${t},1`);
    rows.push(`0,0,${t + 30},2`);
  };
  const moveTo = (x: number, y: number, ms: number): void => {
    const [x0, y0] = [px, py];
    for (let i = 1; i <= ms; i++) {
      const s = i / ms;
      const k = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
      const [nx, ny] = [Math.round(x0 + (x - x0) * k), Math.round(y0 + (y - y0) * k)];
      if (nx !== px || ny !== py) rows.push(`${nx - px},${-(ny - py)},${t + i},0`);
      [px, py] = [nx, ny];
    }
    t += ms;
  };
  const flick = (tx: number, ty: number): void => {
    const deg = Math.atan2(-(ty - py), tx - px) * (180 / Math.PI);
    const r = ratioCcw[Math.round(((deg + 360) % 360) / 45) % 8]!;
    t += 200;
    moveTo(px + (tx - px) * r, py + (ty - py) * r, 180);
    t += 60;
    moveTo(tx, ty, 120);
    t += 80;
    click();
  };
  click();
  for (let rep = 0; rep < reps; rep++) {
    for (let s = 0; s < 8; s++) {
      const d = [300, 450, 600][rep % 3]!;
      const a = (s * 45 * Math.PI) / 180;
      flick(Math.round(d * Math.cos(a)), Math.round(-d * Math.sin(a)));
      flick(0, 0);
    }
  }
  return rows.join("\n");
}

// Overshoots toward the user (CCW sector 6) by 15%, undershoots away (sector 2) by 10%
const RATIOS = [1, 1, 0.9, 1, 1, 1, 1.15, 1];

test("mouse log: MouseTester layout, Y sign, click-to-click flicks", () => {
  const events = parseMouseTesterCsv(fixture("mousetester-log.csv"));
  assert.equal(events.length, 18);
  assert.equal(events[8]!.dy, 30); // logged as -30 (+y = away in MouseTester): 30 counts toward the user
  const flicks = flicksFromMouseLog(events);
  assert.deepEqual(
    flicks.map((f) => [f.startTMs, f.clickTMs, f.targetX, f.targetY]),
    [[0, 300, 100, 0], [300, 420, 0, 30], [420, 700, 0, 70], [700, 1000, 0, -100]]
  );
  assert.throws(() => parseMouseTesterCsv("not,a,log\n"), /not a MouseTester log/);
});

test("mouse log: per-direction overshoot recovered from a synthetic session", () => {
  const analyses = ingestMouseLog(syntheticSession(RATIOS));
  assert.equal(analyses.length, 96);
  const summary = aggregateDirectionalError(analyses);
  summary.sectors.forEach((s, i) => {
    assert.equal(s.validTrialCount, 12);
    // the velocity-minimum detector stops ~1.5% short of the primary endpoint in every direction
    assert.ok(Math.abs(s.medianRadialRatio / RATIOS[i]! - 0.985) < 0.02, `sector ${i}: ${s.medianRadialRatio}`);
  });
});

test("profile: canonical JSON for importProfileJson and tools/odd_profile.py", () => {
  const analyses = ingestMouseLog(syntheticSession(RATIOS));

  const out = buildProfile(analyses, { dpi: 1600, onlyAtBaseDpi: true });
  const doc = JSON.parse(out.json);
  assert.equal(doc.schema, "open-directional-dpi-v1");
  assert.equal(doc.baseDpi, 1600);
  assert.equal(doc.windowCounts, Math.round(1600 / 50.8));
  assert.equal(doc.onlyAtBaseDpi, true);
  assert.deepEqual(out.sparseDirections, []);
  const m = doc.directionalMultipliers;
  // overshoot toward the user -> lower gain there; undershoot away -> higher gain
  assert.ok(m.S_90 < m.E_0 && m.E_0 < m.N_270, JSON.stringify(m));
  assert.ok(Math.abs(m.E_0 - m.W_180) < 0.01);
  const mean = Object.values(m as Record<string, number>).reduce((a, b) => a + b, 0) / 8;
  assert.ok(Math.abs(mean - 1) < 0.01); // mean-preserving (default)
  importProfileJson(out.json);

  const dir = mkdtempSync(join(tmpdir(), "odd-cal-"));
  writeFileSync(join(dir, "profile.json"), out.json);
  const py = spawnSync("python3", [here("../../tools/odd_profile.py"), "encode", join(dir, "profile.json")]);
  assert.equal(py.status, 0, py.stderr.toString());

  const headroom = JSON.parse(buildProfile(analyses, { dpi: 800, normalization: "cpi-headroom" }).json);
  assert.ok(headroom.baseDpi > 800); // run the sensor at the raised DPI ...
  assert.equal(headroom.windowCounts, Math.round(headroom.baseDpi / 50.8));
  for (const v of Object.values(headroom.directionalMultipliers as Record<string, number>)) {
    assert.ok(v <= 1); // ... and only scale down
  }
});

test("kovaaks: Stats.csv kill times, clock alignment, flicks with a miss dropped", () => {
  const kills = parseKovaaksKillTimes(fixture("kovaaks-stats.csv"));
  assert.deepEqual(kills, [68374330, 68374632, 68375028, 68375335]);
  assert.deepEqual(parseKovaaksKillTimes("Kill #,Timestamp,Bot\r\n1,23:59:59:990,a\r\n2,00:00:00:400,a\r\n"),
    [86399990, 86400400]); // 2019 layout, past midnight
  assert.throws(() => parseKovaaksKillTimes(fixture("mousetester-log.csv")), /not a KovaaK's Stats.csv/);

  const flicks = flicksFromMouseLog(parseMouseTesterCsv(fixture("mousetester-log.csv")));
  // kill 3 came after a miss (click at 420 ms): 300 -> 420 -> 700 are not kill-to-kill flicks
  assert.deepEqual(selectKillFlicks(kills, flicks).map((f) => f.clickTMs), [300, 1000]);
  assert.throws(() => selectKillFlicks([0, 2000, 4000, 6000], flicks), /line up with clicks/);
});

test("kovaaks: end to end on a synthetic session", () => {
  const log = syntheticSession(RATIOS);
  const events = parseMouseTesterCsv(log);
  const clickTimes = events.filter((e) => e.leftDown).map((e) => e.tMs);
  // the run starts at 18:00:00.000 wall clock; kill i is click i, the 10th click a miss
  const stamp = (ms: number): string => {
    const d = new Date(Date.UTC(2026, 0, 1, 18) + ms);
    return d.toISOString().slice(11, 23);
  };
  const statsRows = clickTimes.flatMap((t, i) => (i === 10 ? [] : [`${i},${stamp(t + (i % 3) * 4)},target,BB Gun,0s,1,1`]));
  const stats = `Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits\r\n${statsRows.join("\r\n")}\r\n\r\nWeapon,Shots\r\n`;
  const analyses = ingestKovaaks(log, [stats]);
  assert.equal(analyses.length, 96 - 2); // the flicks into and out of the miss click
});

test("record-evdev: input_event bytes -> MouseTester rows, any chunking", () => {
  const ev = (sec: number, usec: number, type: number, code: number, value: number): Buffer => {
    const b = Buffer.alloc(24);
    b.writeBigInt64LE(BigInt(sec));
    b.writeBigInt64LE(BigInt(usec), 8);
    b.writeUInt16LE(type, 16);
    b.writeUInt16LE(code, 18);
    b.writeInt32LE(value, 20);
    return b;
  };
  const bytes = Buffer.concat([
    ev(100, 0, 2, 0, 5), ev(100, 0, 2, 1, 3), ev(100, 0, 0, 0, 0), // move right 5, toward the user 3
    ev(100, 10500, 1, 0x110, 1), ev(100, 10500, 0, 0, 0), // left down
    ev(100, 15000, 1, 0x110, 2), ev(100, 15000, 0, 0, 0), // autorepeat: no row
    ev(100, 20000, 2, 1, -2), ev(100, 20000, 1, 0x110, 0), ev(100, 20000, 0, 0, 0), // away 2, left up
  ]);
  const convert = evdevToMouseTesterRows();
  const rows = convert(bytes.subarray(0, 30)) + convert(bytes.subarray(30));
  assert.equal(rows, "5,-3,0.000,0\n0,0,10.500,1\n0,2,20.000,2\n");
  const events = parseMouseTesterCsv(`x\n400\n${MOUSETESTER_HEADER}\n${rows}`);
  assert.deepEqual(events.map((e) => [e.dx, e.dy, e.leftDown]), [[5, 3, false], [0, 0, true], [0, -2, false]]);
});

test("cli: mouse log -> profile JSON on stdout, usage errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "odd-cli-"));
  writeFileSync(join(dir, "log.csv"), syntheticSession(RATIOS));
  const cli = here("../cli.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });

  const ok = run("mouse-log", join(dir, "log.csv"), "--dpi", "800");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(importProfileJson(ok.stdout).baseDpi, 800);
  assert.match(ok.stderr, /set the sensor to 800 DPI/);
  assert.equal(run("aimlabs", join(dir, "log.csv"), "--dpi", "800").stdout, ok.stdout); // alias of mouse-log

  assert.equal(run("mouse-log", join(dir, "log.csv")).status, 2); // no --dpi
  assert.equal(run("kovaaks", join(dir, "log.csv"), "--dpi", "800").status, 2); // no Stats.csv
  const bad = run("kovaaks", join(dir, "log.csv"), here("fixtures/mousetester-log.csv"), "--dpi", "800");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a KovaaK's Stats.csv/);

  // an existing profile JSON (calibrate.html, odd_profile.py export) to another adapter's format
  writeFileSync(join(dir, "profile.json"), ok.stdout);
  const ev = run("format", join(dir, "profile.json"), "--format", "evdev", "--window", "0");
  assert.equal(ev.status, 0, ev.stderr);
  assert.match(ev.stdout, /^(\S+ ){8}0\n$/);
  assert.equal(run("format", join(dir, "profile.json"), "--window", "129").status, 2);
  assert.equal(run("format", join(dir, "profile.json"), "--format", "xml").status, 2);
});

test("cli: --window and the evdev, QMK and devicetree formats", () => {
  const analyses = ingestMouseLog(syntheticSession(RATIOS));
  const out = buildProfile(analyses, { dpi: 800, windowCounts: 0 });
  const doc = JSON.parse(out.json);
  assert.equal(doc.windowCounts, 0);
  // Q8.8 in HID order E SE S SW W NW N NE (the JSON keys name HID directions)
  const keys = ["E_0", "SE_45", "S_90", "SW_135", "W_180", "NW_225", "N_270", "NE_315"];
  const hid = keys.map((k) => Math.round(doc.directionalMultipliers[k] * 256));

  // odd_evdev_filter <dev> E SE S SW W NW N NE window; it parses each with strtod * 256 + 0.5
  const ev = FORMATS.evdev!(out.profile).split(" ").map(Number);
  assert.deepEqual(ev.slice(0, 8).map((v) => Math.floor(v * 256 + 0.5)), hid);
  assert.equal(ev[8], 0);

  const dts = FORMATS.dts!(out.profile);
  assert.match(dts, new RegExp(`\tmultipliers-q8-8 = <${hid.join(" ")}>;`));
  assert.match(dts, /\tbase-dpi = <800>;\n\tglobal-gain-q8-8 = <256>;/);
  assert.match(dts, /\twindow-counts = <0>;\n\tidle-ms = <50>;/);

  // The QMK lines compile against the QMK adapter (standalone mode) and set exactly this profile
  const dir = mkdtempSync(join(tmpdir(), "odd-qmk-"));
  writeFileSync(join(dir, "keymap.c"), `#include "${here("../../core/directional_dpi.h")}"
#include <stdio.h>
void           odd_qmk_init(uint16_t base_dpi);
ddpi_engine_t *odd_qmk_get_engine(void);
int main(void) {
    odd_qmk_init(400u);
${FORMATS.qmk!(out.profile)}
    const ddpi_profile_v1_t *q = &odd_qmk_get_engine()->profile;
    printf("%u %u %u", q->flags, q->base_dpi, q->global_gain_q8_8);
    for (int i = 0; i < 8; i++) printf(" %u", q->multipliers_q8_8[i]);
    printf(" %u\\n", q->reserved);
    return 0;
}
`);
  const cc = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-o", join(dir, "keymap"),
    join(dir, "keymap.c"), here("../../core/directional_dpi.c"), here("../../adapters/qmk/odd_pointing_device.c")],
  { encoding: "utf8" });
  assert.equal(cc.status, 0, cc.stderr);
  assert.equal(spawnSync(join(dir, "keymap"), { encoding: "utf8" }).stdout, `1 800 256 ${hid.join(" ")} 0\n`);

  // onlyAtBaseDpi: QMK knows the CPI; the evdev filter and the devicetree have no such setting
  const only = buildProfile(analyses, { dpi: 800, onlyAtBaseDpi: true }).profile;
  assert.match(FORMATS.qmk!(only), /p\.flags = DDPI_FLAG_ENABLED \| DDPI_FLAG_ONLY_AT_BASE_DPI;/);
  assert.throws(() => FORMATS.evdev!(only), /odd_evdev_filter cannot take DDPI_FLAG_ONLY_AT_BASE_DPI/);
  assert.throws(() => FORMATS.dts!(only), /devicetree cannot take DDPI_FLAG_ONLY_AT_BASE_DPI/);
});
