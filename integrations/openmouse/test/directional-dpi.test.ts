/**
 * OpenMouse — Open Directional DPI v1 Integration & Mock WebHID Test Suite
 *
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clampDpi,
  computeDirectionalScaleQ16_16,
  computePolarCurve360,
  createDefaultProfileV1,
  DDPI_DPI_MAX,
  DDPI_DPI_MIN,
  DDPI_FLAG_BYPASS_FOR_CALIBRATION,
  DDPI_FLAG_ENABLED,
  DDPI_FLAG_FRAME_SENSOR_CCW,
  DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE,
  DDPI_FLAG_MODEL_LINEAR_2X2,
  DDPI_FLAG_ONLY_AT_BASE_DPI,
  DDPI_Q16_16_ONE,
  DdpiDirection,
  type DdpiProfileV1,
  deserializeProfileV1,
  type EightMultipliers,
  exportProfileJson,
  floatToQ8_8,
  importProfileJson,
  isProfileIdentity,
  OpenMouseDirectionalDpiClient,
  preferCable,
  SERIES_ONE_PRO_WIRED_BL_PID,
  serializeProfileV1,
  type WebHidFeatureTransport,
} from "../src/directional-dpi.ts";
import { MockGloriousReceiverHidDevice, MockGloriousSeriesOneProHidDevice, MockQmkRawHidDevice } from "../src/mock-hid.ts";

async function runTests(): Promise<void> {
  console.log("=== OpenMouse — Open Directional DPI v1 Integration Tests ===");

  /* Test 1: Stock Glorious firmware gets only the stock version query, no ODD packet */
  {
    const stockMock = new MockGloriousSeriesOneProHidDevice("stock-glorious");
    const client = new OpenMouseDirectionalDpiClient(stockMock);
    const caps = await client.detectCapabilities();
    assert.equal(caps.firmwareKind, "stock-glorious");
    assert.equal(caps.protocolVersion, 0);
    assert.equal(stockMock.featurePacketsReceived, 1);
    assert.equal(stockMock.oddPacketsReceived, 0);
    console.log("  [PASS] 01. Stock firmware detected with 0 Open Directional DPI packets sent");
  }

  /* Test 2: Patched Glorious (stock descriptors) found by its "DP01" version stamp */
  {
    const customMock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(customMock);
    const caps = await client.detectCapabilities();
    assert.equal(caps.firmwareKind, "open-directional-dpi-v1");
    assert.equal(caps.protocolVersion, 1);
    assert.equal(caps.maxSlots, 1);
    assert.equal(caps.wired1000Hz, false);
    assert.equal(caps.nvsStorage, true);
    assert.equal(caps.paw3370Sensor, false);
    assert.equal(caps.bootloaderReentry, true);
    assert.equal(caps.minDpi, 50);
    assert.equal(caps.maxDpi, DDPI_DPI_MAX);
    console.log("  [PASS] 02. Patched Glorious detected by version stamp, capabilities as the core reports");
  }

  /* Test 3: Profile Read, Write, Enable/Disable, NVS Save, and Reboot Persistence */
  {
    const customMock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(customMock);

    const initial = await client.getProfile(0);
    assert.equal(initial.baseDpi, 800);
    assert.equal(initial.flags & DDPI_FLAG_ENABLED, 0);

    const updated = createDefaultProfileV1(1600);
    updated.flags = DDPI_FLAG_ENABLED;
    updated.globalGainQ8_8 = floatToQ8_8(1.0);
    updated.multipliersQ8_8[DdpiDirection.E] = floatToQ8_8(1.0);
    updated.multipliersQ8_8[DdpiDirection.SE] = floatToQ8_8(1.25);
    updated.multipliersQ8_8[DdpiDirection.S] = floatToQ8_8(1.5);
    updated.multipliersQ8_8[DdpiDirection.SW] = floatToQ8_8(1.25);
    updated.multipliersQ8_8[DdpiDirection.W] = floatToQ8_8(1.0);
    updated.multipliersQ8_8[DdpiDirection.NW] = floatToQ8_8(0.875);
    updated.multipliersQ8_8[DdpiDirection.N] = floatToQ8_8(0.75);
    updated.multipliersQ8_8[DdpiDirection.NE] = floatToQ8_8(0.875);

    const readback = await client.setProfile(updated, 0);
    assert.equal(readback.baseDpi, 1600);
    assert.equal(readback.multipliersQ8_8[DdpiDirection.S], 384);
    assert.equal(readback.multipliersQ8_8[DdpiDirection.N], 192);

    /* Save to NVS flash, modify RAM, then simulate power-cycle reboot */
    await client.saveToFlash(0);
    const reset = await client.resetDefaults(0);
    assert.equal(reset.baseDpi, 1600); // RESET_DEFAULTS keeps base_dpi
    assert.deepEqual([reset.flags, reset.multipliersQ8_8[DdpiDirection.S]], [0, 256]);
    assert.deepEqual(await client.getProfile(0), reset);

    customMock.simulatePowerCycleReboot();
    const afterReboot = await client.getProfile(0);
    assert.equal(afterReboot.baseDpi, 1600);
    assert.equal(afterReboot.multipliersQ8_8[DdpiDirection.S], 384);
    console.log("  [PASS] 03. Profile read/write, verified readback, and NVS flash persistence");
  }

  /* Test 4: Mock firmware SIMULATE_DELTA over WebHID (C engine parity is test 07) */
  {
    const customMock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(customMock);

    const prof = createDefaultProfileV1(800);
    prof.flags = DDPI_FLAG_ENABLED;
    prof.multipliersQ8_8 = [256, 320, 384, 320, 256, 224, 192, 224];
    await client.setProfile(prof, 0);

    /* Hand-computed: each axis/diagonal gets its own multiplier, truncated toward zero */
    const expectedVectors = [
      { dx: 100, dy: 0, outDx: 100, outDy: 0 },
      { dx: 71, dy: 71, outDx: 88, outDy: 88 },
      { dx: 0, dy: 100, outDx: 0, outDy: 150 },
      { dx: -71, dy: 71, outDx: -88, outDy: 88 },
      { dx: -100, dy: 0, outDx: -100, outDy: 0 },
      { dx: -71, dy: -71, outDx: -62, outDy: -62 },
      { dx: 0, dy: -100, outDx: 0, outDy: -75 },
      { dx: 71, dy: -71, outDx: 62, outDy: -62 },
    ];

    for (const vec of expectedVectors) {
      await client.setEnabled(false, 0);
      await client.setEnabled(true, 0); // resets remainders
      const sim = await client.simulateDelta(vec.dx, vec.dy);
      assert.equal(sim.outDx, vec.outDx);
      assert.equal(sim.outDy, vec.outDy);
    }

    /* Like the C engine (§6.4): remainder kept on reversal, excess carried past the clamp */
    const g15 = createDefaultProfileV1(800);
    g15.flags = DDPI_FLAG_ENABLED;
    g15.globalGainQ8_8 = 384;
    await client.setProfile(g15, 0);
    await client.setEnabled(false, 0);
    await client.setEnabled(true, 0);
    const outs: number[] = [];
    for (const dx of [1, -1, -1, 30000, 1]) {
      outs.push((await client.simulateDelta(dx, 0)).outDx);
    }
    assert.deepEqual(outs, [1, -1, -1, 32767, 12234]);
    console.log("  [PASS] 04. Mock firmware SIMULATE_DELTA round trip over WebHID");
  }

  /* Test 5: JSON Profile Import/Export & 360-Degree Polar Curve Generation */
  {
    const prof = createDefaultProfileV1(1200);
    prof.flags = DDPI_FLAG_ENABLED;
    prof.globalGainQ8_8 = floatToQ8_8(1.25);
    prof.multipliersQ8_8[DdpiDirection.E] = floatToQ8_8(1.5);

    const json = exportProfileJson(prof);
    const reimported = importProfileJson(json);
    assert.deepEqual(serializeProfileV1(reimported), serializeProfileV1(prof));

    const curve = computePolarCurve360(reimported);
    assert.equal(curve.length, 360);
    assert.equal(curve[0]!.effectiveDpi, Math.round(1200 * 1.5 * 1.25));
    console.log("  [PASS] 05. JSON profile import/export and 360-degree polar curve generator");
  }

  /* Test 6: Safe Bootloader Re-Entry (0x2003FFFC = 0xA55AA55A -> 258a:2103) */
  {
    const customMock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(customMock);
    assert.equal(customMock.inBootloaderMode, false);
    await client.enterBootloader();
    assert.equal(customMock.inBootloaderMode, true);
    assert.equal(customMock.sramBootloaderMagicWord, 0xa55aa55a);
    assert.equal(customMock.productId, SERIES_ONE_PRO_WIRED_BL_PID);
    console.log("  [PASS] 06. Safe bootloader re-entry (0x2003FFFC = 0xA55AA55A -> 258a:2103)");
  }

  const hex = (p: DdpiProfileV1): string =>
    Buffer.from(serializeProfileV1(p)).toString("hex");

  /* Test 7: Bit-exact parity with the C engine (tests/vectors, `make -C tests vectors`) */
  {
    const suite = JSON.parse(
      readFileSync(
        new URL("../../../tests/vectors/scale_vectors.json", import.meta.url),
        "utf8"
      )
    ) as { profiles: Array<{ name: string; bytes: string; vectors: number[][] }> };
    let checked = 0;
    for (const p of suite.profiles) {
      const prof = deserializeProfileV1(Uint8Array.from(Buffer.from(p.bytes, "hex")));
      assert.equal(hex(prof), p.bytes, `${p.name}: TS serializer differs from C`);
      for (const [dx, dy, scaleQ16_16, octant] of p.vectors) {
        assert.deepEqual(
          computeDirectionalScaleQ16_16(prof, dx!, dy!),
          { scaleQ16_16, octant },
          `${p.name} (${dx}, ${dy})`
        );
        checked++;
      }
    }
    assert.ok(checked >= 2000, `only ${checked} C vectors found`);
    console.log(`  [PASS] 07. Bit-exact parity with ${checked} C engine vectors`);
  }

  /* Test 8: odd-sensor-ccw profiles map to the same physical directions as HID-CW */
  {
    const ccw = createDefaultProfileV1(800);
    ccw.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW;
    ccw.multipliersQ8_8 = [256, 288, 384, 320, 224, 192, 128, 160]; // CCW: 2 = away 1.5x, 6 = toward 0.5x
    assert.equal(computeDirectionalScaleQ16_16(ccw, 0, -100).scaleQ16_16, 98304);
    assert.equal(computeDirectionalScaleQ16_16(ccw, 0, 100).scaleQ16_16, 32768);
    const cw: DdpiProfileV1 = {
      ...ccw,
      flags: DDPI_FLAG_ENABLED,
      multipliersQ8_8: ccw.multipliersQ8_8.map(
        (_, i) => ccw.multipliersQ8_8[(8 - i) & 7]!
      ) as EightMultipliers,
    };
    assert.deepEqual(computePolarCurve360(cw), computePolarCurve360(ccw));
    console.log("  [PASS] 08. CCW-frame profiles scale the same physical directions as HID-CW");
  }

  /* Test 9: Calibration bypass is an exact identity, like the C engine */
  {
    const p = createDefaultProfileV1(800);
    p.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_BYPASS_FOR_CALIBRATION;
    p.multipliersQ8_8[DdpiDirection.E] = 512;
    assert.equal(isProfileIdentity(p), true);
    assert.deepEqual(computeDirectionalScaleQ16_16(p, 100, 0), {
      scaleQ16_16: DDPI_Q16_16_ONE,
      octant: 0,
    });
    p.flags = DDPI_FLAG_ENABLED;
    assert.equal(computeDirectionalScaleQ16_16(p, 100, 0).scaleQ16_16, 2 * DDPI_Q16_16_ONE);
    console.log("  [PASS] 09. Calibration bypass flag yields 1.00x");
  }

  /* Test 10: 45000 CPI survives bytes and JSON; DPI range is 50..65535 like C */
  {
    const p = createDefaultProfileV1(45000);
    assert.equal(p.baseDpi, 45000);
    assert.equal(deserializeProfileV1(serializeProfileV1(p)).baseDpi, 45000);
    assert.equal(importProfileJson(exportProfileJson(p)).baseDpi, 45000);
    assert.equal(clampDpi(70000), DDPI_DPI_MAX);
    assert.equal(clampDpi(10), DDPI_DPI_MIN);
    assert.deepEqual([DDPI_DPI_MIN, DDPI_DPI_MAX], [50, 65535]);
    console.log("  [PASS] 10. 45000 CPI profile round-trips through bytes and JSON");
  }

  /* Test 11: JSON round trip keeps all 28 bytes (except the transient bypass bit) */
  {
    let cases = 0;
    for (let flags = 0; flags < 128; flags++) {
      for (const windowCounts of [0, 1, 16, 128]) {
        for (const idleUnits of [0, 1, 10, 255]) {
          const p = createDefaultProfileV1(1600);
          p.flags = flags;
          p.globalGainQ8_8 = 300;
          p.multipliersQ8_8 = [16, 200, 256, 300, 384, 512, 1000, 1024];
          p.reserved = (idleUnits << 8) | windowCounts;
          assert.equal(
            hex(importProfileJson(exportProfileJson(p))),
            hex({ ...p, flags: flags & ~DDPI_FLAG_BYPASS_FOR_CALIBRATION }),
            `flags=${flags} window=${windowCounts} idleUnits=${idleUnits}`
          );
          cases++;
        }
      }
    }
    console.log(`  [PASS] 11. JSON export/import is byte-exact over ${cases} flag/window/idle combinations`);
  }

  /* Test 12: Files from the original exporter (no frame/model/window fields) import as before */
  {
    const legacy = `{
  "schema": "open-directional-dpi-v1",
  "version": 1,
  "enabled": true,
  "keepRemainderOnReverse": true,
  "linearOctantRatio": false,
  "baseDpi": 1200,
  "globalGain": 1.25,
  "directionalMultipliers": {
    "E_0": 1.5, "SE_45": 1.25, "S_90": 1.5, "SW_135": 1,
    "W_180": 1, "NW_225": 0.875, "N_270": 0.75, "NE_315": 0.875
  }
}`;
    const p = importProfileJson(legacy);
    assert.equal(p.flags, DDPI_FLAG_ENABLED | DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE);
    assert.equal(p.reserved, 0);
    assert.equal(p.baseDpi, 1200);
    assert.equal(p.globalGainQ8_8, 320);
    assert.deepEqual(p.multipliersQ8_8, [384, 320, 384, 256, 256, 224, 192, 224]);
    console.log("  [PASS] 12. Legacy JSON profiles import unchanged");
  }

  /* Test 13: Malformed or out-of-range JSON is rejected with a clear error */
  {
    const valid = JSON.parse(exportProfileJson(createDefaultProfileV1(800)));
    const dm = valid.directionalMultipliers;
    const bad: Array<[string, RegExp]> = [
      ["not json", /not valid JSON/],
      ["[]", /must be an object/],
      ["null", /must be an object/],
      [JSON.stringify({ ...valid, schema: "odd.profile.v1" }), /schema/],
      [JSON.stringify({ ...valid, enabled: "yes" }), /"enabled"/],
      [JSON.stringify({ ...valid, baseDpi: "800" }), /"baseDpi"/],
      [JSON.stringify({ ...valid, baseDpi: 70000 }), /"baseDpi"/],
      [JSON.stringify({ ...valid, baseDpi: 800.5 }), /"baseDpi"/],
      [JSON.stringify({ ...valid, baseDpi: undefined }), /"baseDpi"/],
      [JSON.stringify({ ...valid, frame: "ccw" }), /"frame"/],
      [JSON.stringify({ ...valid, model: 2 }), /"model"/],
      [JSON.stringify({ ...valid, windowCounts: 129 }), /"windowCounts"/],
      [JSON.stringify({ ...valid, idleResetMs: 52 }), /"idleResetMs"/],
      [JSON.stringify({ ...valid, idleResetMs: 1280 }), /"idleResetMs"/],
      [JSON.stringify({ ...valid, globalGain: 5 }), /"globalGain"/],
      [JSON.stringify({ ...valid, directionalMultipliers: { ...dm, N_270: 0.01 } }), /N_270/],
      [JSON.stringify({ ...valid, directionalMultipliers: { ...dm, SE_45: undefined } }), /SE_45/],
      [JSON.stringify({ ...valid, directionalMultipliers: [1, 1, 1, 1, 1, 1, 1, 1] }), /"directionalMultipliers"/],
    ];
    for (const [json, err] of bad) {
      assert.throws(() => importProfileJson(json), err, json);
    }
    console.log(`  [PASS] 13. ${bad.length} malformed JSON profiles rejected`);
  }

  /* Test 14: calibrate.html export imports with each CCW gain on its physical direction */
  {
    const html = readFileSync(
      new URL("../../../calibration/providers/builtin/calibrate.html", import.meta.url),
      "utf8"
    );
    const src = /\/\/ --- profile export[^\n]*\n([\s\S]*?)\/\/ --- end profile export ---/.exec(html)?.[1];
    assert.ok(src, "buildProfileJson block not found in calibrate.html");
    const buildProfileJson = new Function(`${src}\nreturn buildProfileJson;`)() as (
      gainsCcw: number[],
      baseCpi: number,
      windowCounts: number
    ) => { directionalMultipliers: Record<string, number> };

    const gainsCcw = [1.0, 1.05, 1.2, 0.95, 0.9, 0.85, 0.8, 1.1]; // 0 right, 1 away-right, 2 away .. 7 toward-right
    const doc = buildProfileJson(gainsCcw, 1600, 16);
    assert.equal(doc.directionalMultipliers.N_270, gainsCcw[2]); // away
    assert.equal(doc.directionalMultipliers.S_90, gainsCcw[6]); // toward
    const p = importProfileJson(JSON.stringify(doc));
    assert.equal(p.flags, DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW);
    assert.equal(p.baseDpi, 1600);
    assert.equal(p.globalGainQ8_8, 256);
    assert.equal(p.reserved, (10 << 8) | 16); // idle 50 ms, window 16
    /* Unnormalized, so the sensor stays at baseDpi: no CPI advice that would apply the peak gain twice */
    assert.equal((doc as Record<string, unknown>).recommendedSensorCpi, undefined);
    /* Same array profile-generation flashes with normalization "none" */
    assert.deepEqual(p.multipliersQ8_8, gainsCcw.map(floatToQ8_8));
    /* CCW sector i as an HID motion (+X right, -Y away) gets exactly gain i */
    const ccwMotions = [[100, 0], [100, -100], [0, -100], [-100, -100], [-100, 0], [-100, 100], [0, 100], [100, 100]];
    ccwMotions.forEach(([dx, dy], i) => {
      assert.equal(
        computeDirectionalScaleQ16_16(p, dx!, dy!).scaleQ16_16,
        floatToQ8_8(gainsCcw[i]!) << 8,
        `CCW sector ${i}`
      );
    });
    console.log("  [PASS] 14. calibrate.html export maps CCW gains to physical directions");
  }

  /* Test 15: Other devices need the "[OpenDDPIv1]" product string */
  {
    const dev = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    Object.assign(dev, { vendorId: 0x1d50, productId: 0x615e, productName: "Corne" });
    assert.equal((await new OpenMouseDirectionalDpiClient(dev).detectCapabilities()).firmwareKind, "unsupported");
    assert.equal(dev.featurePacketsReceived, 0);

    dev.productName = "Zephyr mouse [OpenDDPIv1]";
    const caps = await new OpenMouseDirectionalDpiClient(dev).detectCapabilities();
    assert.equal(caps.firmwareKind, "open-directional-dpi-v1");
    assert.equal(dev.featurePacketsReceived, 1); // GET_CAPABILITIES only
    console.log("  [PASS] 15. Non-Glorious devices: product-string marker required");
  }

  /* Test 16: linear-2x2 polar curve follows the C engine's matrix, not the angular blend */
  {
    const p = createDefaultProfileV1(800);
    p.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_MODEL_LINEAR_2X2;
    p.multipliersQ8_8[DdpiDirection.NE] = 384; // h = (1.5 - 1.0) / 2 = 0.25
    const curve = computePolarCurve360(p);
    /* (707,-707) -> (883.75,-883.75); (-707,-707) -> 0.75x; (1000,0) -> (1000,-250) */
    assert.deepEqual(
      [curve[315]!.multiplier, curve[225]!.multiplier, curve[0]!.multiplier],
      [1.25, 0.75, 1.0308]
    );
    console.log("  [PASS] 16. linear-2x2 polar curve matches the 2x2 engine model");
  }

  /* Test 17: a device that answers from its main loop (Glorious patch, 2.4 GHz receiver):
   * GET_REPORT returns the previous answer until the request has been processed */
  {
    const inner = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    let ready: Uint8Array = new Uint8Array(64);
    let pending: Uint8Array | undefined;
    let gets = 0;
    let staleGets = 2;
    const lagging: WebHidFeatureTransport = {
      vendorId: inner.vendorId,
      productId: inner.productId,
      productName: inner.productName,
      async sendFeatureReport(_id, data) {
        pending = data.slice();
        gets = 0;
      },
      async receiveFeatureReport(id) {
        if (pending && ++gets > staleGets) {
          await inner.sendFeatureReport(id, pending);
          ready = new Uint8Array((await inner.receiveFeatureReport(id)).buffer);
          pending = undefined;
        }
        return new DataView(ready.slice().buffer);
      },
    };
    const client = new OpenMouseDirectionalDpiClient(lagging);
    assert.equal((await client.detectCapabilities()).firmwareKind, "open-directional-dpi-v1");
    const p = createDefaultProfileV1(800);
    p.flags = DDPI_FLAG_ENABLED;
    p.multipliersQ8_8[DdpiDirection.S] = 384;
    assert.equal((await client.setProfile(p)).multipliersQ8_8[DdpiDirection.S], 384);

    /* Calibration bypass: exact 1.00x, ENABLED kept; setEnabled(true) ends it */
    assert.equal(await client.bypassForCalibration(), true);
    assert.equal((await client.simulateDelta(0, 100)).outDy, 100);
    await client.setEnabled(true);
    assert.equal((await client.simulateDelta(0, 100)).outDy, 150);

    assert.equal((await client.saveToFlash()).multipliersQ8_8[DdpiDirection.S], 384);
    assert.equal(pending, undefined, "saveToFlash resolved before the device ran SAVE_FLASH");
    assert.equal((await client.resetDefaults()).multipliersQ8_8[DdpiDirection.S], 256);

    /* Never answered: an error instead of the previous answer */
    staleGets = Infinity;
    await assert.rejects(client.getProfile(), /No answer to opcode 0x2/);
    /* ...except ENTER_BOOTLOADER, which normally resets without answering */
    await client.enterBootloader();
    console.log("  [PASS] 17. Late answers are waited for and matched by seq/opcode; calibration bypass");
  }

  {
    /* 18. Single DPI stage: JSON round trip, old JSON defaults to off, sensor DPI in capabilities */
    const p = createDefaultProfileV1(800);
    p.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_ONLY_AT_BASE_DPI;
    p.multipliersQ8_8[DdpiDirection.N] = 128;
    const json = exportProfileJson(p);
    assert.equal(JSON.parse(json).onlyAtBaseDpi, true);
    assert.equal(importProfileJson(json).flags & DDPI_FLAG_ONLY_AT_BASE_DPI, DDPI_FLAG_ONLY_AT_BASE_DPI);
    const old = JSON.parse(json);
    delete old.onlyAtBaseDpi;
    assert.equal(importProfileJson(JSON.stringify(old)).flags & DDPI_FLAG_ONLY_AT_BASE_DPI, 0);

    const mock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(mock);
    assert.equal((await client.detectCapabilities()).sensorDpi, 0);
    mock.sensorDpi = 1600;
    assert.equal((await client.detectCapabilities()).sensorDpi, 1600);
    assert.equal((await client.detectCapabilities()).clockMs, null);
    mock.clockMs = 0x12345678;
    assert.equal((await client.detectCapabilities()).clockMs, 0x12345678);
    console.log("  [PASS] 18. Single DPI stage flag (JSON) and sensor DPI in capabilities");
  }

  {
    /* 19. tools/odd_profile.py encodes and decodes exactly like importProfileJson / exportProfileJson */
    const tool = fileURLToPath(new URL("../../../tools/odd_profile.py", import.meta.url));
    const py = (...args: string[]): string => execFileSync("python3", ["-I", tool, ...args], { encoding: "utf8" });
    const docs: Record<string, unknown>[] = [
      JSON.parse(exportProfileJson(createDefaultProfileV1(800))),
      {
        schema: "open-directional-dpi-v1", version: 1, enabled: true, frame: "odd-sensor-ccw", model: "angular-gain",
        windowCounts: 31, idleResetMs: 50, onlyAtBaseDpi: true, baseDpi: 1600, globalGain: 1.03125,
        directionalMultipliers: { E_0: 1, SE_45: 0.9, S_90: 0.8125, SW_135: 0.95, W_180: 1.25, NW_225: 0.0625, N_270: 4, NE_315: 0.33333 },
      },
      {
        schema: "open-directional-dpi-v1", version: 1, enabled: true, model: "linear-2x2", resetRemainderOnReverse: true,
        linearOctantRatio: true, keepRemainderOnReverse: true, baseDpi: 26000, globalGain: 0.75,
        directionalMultipliers: { E_0: 1.1, SE_45: 1.2, S_90: 1.3, SW_135: 1.4, W_180: 1.5, NW_225: 1.6, N_270: 1.7, NE_315: 1.8 },
      },
    ];
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      const ts = Buffer.from(serializeProfileV1(importProfileJson(json))).toString("hex");
      const file = `${tool}.parity-${process.pid}.json`;
      writeFileSync(file, json);
      try {
        assert.equal(py("encode", file).trim(), ts, `encode differs for ${json}`);
      } finally {
        unlinkSync(file);
      }
      assert.deepEqual(JSON.parse(py("decode", ts)), JSON.parse(exportProfileJson(importProfileJson(json))));
    }
    assert.throws(() => py("encode", "/nonexistent.json"), "missing file must fail");
    console.log("  [PASS] 19. tools/odd_profile.py matches the TypeScript JSON mapping byte for byte");
  }

  {
    /* 20. Through the 2.4 GHz receiver (258a:2031): relayed detection, relay envelope, transient 0xA4 */
    const rx = new MockGloriousReceiverHidDevice(new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1"));
    const client = new OpenMouseDirectionalDpiClient(rx);
    const caps = await client.detectCapabilities();
    assert.equal(caps.firmwareKind, "open-directional-dpi-v1");
    assert.equal(caps.bootloaderReentry, false, "enterBootloader() cannot work through the receiver");
    const p = createDefaultProfileV1(800);
    p.flags = DDPI_FLAG_ENABLED;
    p.multipliersQ8_8[DdpiDirection.N] = 128;
    assert.equal((await client.setProfile(p)).multipliersQ8_8[DdpiDirection.N], 128);
    const t0 = Date.now();
    assert.equal((await client.saveToFlash()).multipliersQ8_8[DdpiDirection.N], 128);
    assert.ok(Date.now() - t0 >= 770, "SAVE_FLASH answered before the transient 0xA4 cleared");
    rx.mouse.simulatePowerCycleReboot();
    assert.equal((await client.getProfile()).multipliersQ8_8[DdpiDirection.N], 128);
    await assert.rejects(client.enterBootloader(), /needs the cable/);
    assert.equal(rx.mouse.inBootloaderMode, false);
    assert.equal(rx.localPackets, 0, "a request ran a receiver-local handler");

    /* The receiver copies back the request's length: the stock 0x06 query loses the 12..15 stamp */
    await rx.sendFeatureReport(0, Uint8Array.from([0, 0, 0x02, 0x06, 0x00, 0x81]));
    await new Promise((r) => setTimeout(r, 20));
    const ver = new Uint8Array((await rx.receiveFeatureReport(0)).buffer);
    assert.deepEqual([ver[0], ver[5], [...ver.subarray(12, 16)]], [0xa1, 0x81, [0, 0, 0, 0]]);

    /* Stock mouse behind the receiver: no stamp, so no envelope request */
    const stockRx = new MockGloriousReceiverHidDevice(new MockGloriousSeriesOneProHidDevice("stock-glorious"));
    const stockCaps = await new OpenMouseDirectionalDpiClient(stockRx).detectCapabilities();
    assert.deepEqual([stockCaps.firmwareKind, stockCaps.bootloaderReentry], ["stock-glorious", false]);
    assert.deepEqual([stockRx.mouse.featurePacketsReceived, stockRx.mouse.oddPacketsReceived, stockRx.localPackets], [1, 0, 0]);

    /* Mouse off: only a 0xA4 still there at the 2 s deadline is an error */
    rx.mouseOn = false;
    await assert.rejects(client.getProfile(), /cannot reach the mouse/);

    const cable = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    assert.equal(preferCable([rx, cable]), cable);
    assert.equal(preferCable([rx]), rx);
    console.log("  [PASS] 20. 2.4 GHz receiver: relayed detection and envelope, transient 0xA4, cable preferred");
  }

  {
    /* 21. QMK raw HID (spec/hid-protocol-v1.md §6): the GET_CAPABILITIES probe identifies the
     * adapter; VIA / Vial boards without it and raw HID without a handler are left alone */
    const kb = new MockQmkRawHidDevice("ddpi");
    kb.viaAppOpen = true; // the VIA app's reports on the same interface are skipped
    const client = new OpenMouseDirectionalDpiClient(kb);
    const caps = await client.detectCapabilities();
    assert.deepEqual([caps.firmwareKind, caps.bootloaderReentry, kb.framesReceived], ["open-directional-dpi-v1", false, 6]);
    const p = createDefaultProfileV1(800);
    p.flags = DDPI_FLAG_ENABLED;
    p.multipliersQ8_8[DdpiDirection.S] = 192;
    assert.equal((await client.setProfile(p)).multipliersQ8_8[DdpiDirection.S], 192);
    assert.equal((await client.getProfile()).multipliersQ8_8[DdpiDirection.S], 192);
    assert.equal((await client.simulateDelta(0, 100)).outDy, 75);
    await assert.rejects(client.enterBootloader(), /status 0xa3/);
    assert.equal(kb.engine.oddPacketsReceived, 5);

    /* Probe only: VIA answers 0xFF to the first frame, a handler-less board never answers,
     * and a Vial board mid-unlock echoes every frame (the reads come back as zeros) */
    const others = (["via", "silent", "vial-unlocking"] as const).map((s) => new MockQmkRawHidDevice(s));
    const kinds = await Promise.all(others.map(async (d) => (await new OpenMouseDirectionalDpiClient(d).detectCapabilities()).firmwareKind));
    assert.deepEqual(kinds, ["unsupported", "unsupported", "unsupported"]);
    assert.deepEqual([others[0]!.framesReceived, others[1]!.framesReceived], [1, 1]);
    assert.equal(others[2]!.engine.oddPacketsReceived, 0);

    /* §6.3 rule 3: a valid answer (CRC, status 0xA1) without "DP01" is a foreign 0xDF handler */
    const foreign = new MockQmkRawHidDevice("ddpi");
    foreign.engine.capsMagic = "XX01";
    assert.equal((await new OpenMouseDirectionalDpiClient(foreign).detectCapabilities()).firmwareKind, "unsupported");
    assert.equal(foreign.framesReceived, 6);

    /* A WebHID error is not "unsupported": it reaches the caller */
    const closed = new MockQmkRawHidDevice("ddpi");
    closed.sendReport = async () => {
      throw new DOMException("The device must be opened first.", "InvalidStateError");
    };
    await assert.rejects(new OpenMouseDirectionalDpiClient(closed).detectCapabilities(), { name: "InvalidStateError" });

    /* Only the 0xFF60 / 0x61 interface is probed */
    const keys = new MockQmkRawHidDevice("ddpi");
    keys.collections = [{ usagePage: 0x01, usage: 0x06 }];
    assert.equal((await new OpenMouseDirectionalDpiClient(keys).detectCapabilities()).firmwareKind, "unsupported");
    assert.equal(keys.framesReceived, 0);
    console.log("  [PASS] 21. QMK raw HID: probe identifies the adapter, VIA / Vial / no-handler boards stay unsupported");
  }

  console.log("\nAll 21/21 OpenMouse integration test suites passed.");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
