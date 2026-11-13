/**
 * Open Directional Sensitivity — Linux mouse logger
 *
 * Records a mouse's raw counts and left clicks from evdev in MouseTester's CSV
 * format (see ./index.ts) while a game runs, Proton included:
 *
 *   node --experimental-strip-types calibration/providers/mouse-log/record-evdev.ts \
 *     /dev/input/by-id/usb-<your mouse>-event-mouse > mouse-log.csv
 *
 * Stop with Ctrl+C. Needs read access to the node (root or the `input` group). The
 * device is not grabbed, so the game still gets every event.
 *
 * SPDX-License-Identifier: MIT
 */

import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

// struct input_event on 64-bit Linux: struct timeval (2 x int64), u16 type, u16 code, s32 value
const EVENT_BYTES = 24;
const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const REL_X = 0;
const REL_Y = 1;
const BTN_LEFT = 0x110;
// RAWMOUSE usButtonFlags, as MouseTester logs them
const RI_MOUSE_LEFT_BUTTON_DOWN = 0x0001;
const RI_MOUSE_LEFT_BUTTON_UP = 0x0002;

export const MOUSETESTER_HEADER = "xCount,yCount,Time (ms),buttonflags";

/** Returns a function that turns evdev bytes (any chunking) into MouseTester rows, one per SYN_REPORT. */
export function evdevToMouseTesterRows(): (chunk: Buffer) => string {
  let pending = Buffer.alloc(0);
  let t0: bigint | null = null;
  let dx = 0;
  let dy = 0;
  let flags = 0;
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let rows = "";
    let off = 0;
    for (; off + EVENT_BYTES <= pending.length; off += EVENT_BYTES) {
      const type = pending.readUInt16LE(off + 16);
      const code = pending.readUInt16LE(off + 18);
      const value = pending.readInt32LE(off + 20);
      if (type === EV_REL && code === REL_X) dx += value;
      else if (type === EV_REL && code === REL_Y) dy += value;
      else if (type === EV_KEY && code === BTN_LEFT && value !== 2) {
        flags |= value ? RI_MOUSE_LEFT_BUTTON_DOWN : RI_MOUSE_LEFT_BUTTON_UP;
      } else if (type === EV_SYN && code === 0 && (dx || dy || flags)) {
        const us = pending.readBigInt64LE(off) * 1_000_000n + pending.readBigInt64LE(off + 8);
        t0 ??= us;
        // MouseTester stores -lLastY (+y = away); evdev REL_Y is +down like lLastY
        rows += `${dx},${-dy},${(Number(us - t0) / 1000).toFixed(3)},${flags}\n`;
        dx = dy = flags = 0;
      }
    }
    pending = pending.subarray(off);
    return rows;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: record-evdev.ts /dev/input/by-id/<mouse>-event-mouse > mouse-log.csv");
    process.exit(2);
  }
  const convert = evdevToMouseTesterRows();
  // Line 2 is MouseTester's CPI field (its default, 400); the calibration does not use it
  process.stdout.write(`open-directional-dpi record-evdev ${path}\n400\n${MOUSETESTER_HEADER}\n`);
  createReadStream(path)
    .on("data", (chunk) => process.stdout.write(convert(chunk as Buffer)))
    .on("error", (err) => {
      console.error(`${path}: ${err.message}`);
      process.exit(1);
    });
  process.on("SIGINT", () => process.exit(0));
  console.error(`recording ${path}; Ctrl+C to stop`);
}
