/**
 * OpenMouse — Open Directional DPI v1 Integration & Mock WebHID Test Suite
 *
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import {
  computePolarCurve360,
  createDefaultProfileV1,
  DDPI_FLAG_ENABLED,
  DdpiDirection,
  deserializeProfileV1,
  exportProfileJson,
  floatToQ8_8,
  importProfileJson,
  OpenMouseDirectionalDpiClient,
  SERIES_ONE_PRO_WIRED_BL_PID,
  serializeProfileV1,
} from "../src/directional-dpi.ts";
import { MockGloriousSeriesOneProHidDevice } from "../src/mock-hid.ts";

async function runTests(): Promise<void> {
  console.log("=== OpenMouse — Open Directional DPI v1 Integration Tests ===");

  /* Test 1: Stock Glorious Firmware Detection (Zero Experimental HID Commands Sent) */
  {
    const stockMock = new MockGloriousSeriesOneProHidDevice("stock-glorious");
    const client = new OpenMouseDirectionalDpiClient(stockMock);
    const caps = await client.detectCapabilities();
    assert.equal(caps.firmwareKind, "stock-glorious");
    assert.equal(caps.protocolVersion, 0);
    /* Verify zero custom HID packets were sent to stock firmware */
    assert.equal(stockMock.featurePacketsReceived, 0);
    console.log("  [PASS] 01. Stock firmware detected passively with 0 vendor HID packets sent");
  }

  /* Test 2: Custom Open Directional DPI v1 Capability Discovery */
  {
    const customMock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(customMock);
    const caps = await client.detectCapabilities();
    assert.equal(caps.firmwareKind, "open-directional-dpi-v1");
    assert.equal(caps.protocolVersion, 1);
    assert.equal(caps.maxSlots, 4);
    assert.equal(caps.wired1000Hz, true);
    assert.equal(caps.nvsStorage, true);
    assert.equal(caps.paw3370Sensor, true);
    assert.equal(caps.bootloaderReentry, true);
    assert.equal(caps.minDpi, 50);
    assert.equal(caps.maxDpi, 19000);
    console.log("  [PASS] 02. Custom Open Directional DPI v1 capability discovery over WebHID");
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
    await client.resetDefaults(0);
    assert.equal((await client.getProfile(0)).baseDpi, 800);

    customMock.simulatePowerCycleReboot();
    const afterReboot = await client.getProfile(0);
    assert.equal(afterReboot.baseDpi, 1600);
    assert.equal(afterReboot.multipliersQ8_8[DdpiDirection.S], 384);
    console.log("  [PASS] 03. Profile read/write, verified readback, and NVS flash persistence");
  }

  /* Test 4: Bit-Exact Parity Between TypeScript Mock Firmware and C Reference Vectors */
  {
    const customMock = new MockGloriousSeriesOneProHidDevice("open-directional-dpi-v1");
    const client = new OpenMouseDirectionalDpiClient(customMock);

    const prof = createDefaultProfileV1(800);
    prof.flags = DDPI_FLAG_ENABLED;
    prof.multipliersQ8_8 = [256, 320, 384, 320, 256, 224, 192, 224];
    await client.setProfile(prof, 0);

    /* Compare against exact C reference vectors from tests/test_directional_dpi.c */
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
    console.log("  [PASS] 04. Bit-exact parity between TypeScript engine and C reference vectors");
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

  console.log("\nAll 6/6 OpenMouse integration test suites passed.");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
