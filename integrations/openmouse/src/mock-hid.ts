/**
 * Mock WebHID Device for Glorious Forge Series One Pro (Stock & Patched Firmware)
 *
 * Simulates both:
 *   1. Stock Compx Firmware (258a:2018, rev 1.01)
 *   2. Stock firmware + adapters/glorious-cm2856 patch: same USB descriptors,
 *      "DP01" stamped into the stock firmware-version answer, and the Open
 *      Directional DPI v1 commands answered like ddpi_hid_handle_feature_report()
 *      with the patch's save and bootloader callbacks.
 *
 * Never interacts with physical USB hardware; enables 100% offline testing.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  computeDirectionalScaleQ16_16,
  crc16Ccitt,
  createDefaultProfileV1,
  DDPI_BOOTLOADER_CONFIRM_MAGIC,
  DDPI_DEFAULT_WINDOW_COUNTS,
  DDPI_DPI_MAX,
  DDPI_DPI_MIN,
  DDPI_FLAG_BYPASS_FOR_CALIBRATION,
  DDPI_FLAG_ENABLED,
  DDPI_FLAG_RESET_REMAINDER_ON_REVERSE,
  DDPI_HID_NAMESPACE,
  DDPI_HID_PACKET_LENGTH,
  DDPI_MAX_WINDOW_COUNTS,
  DDPI_PROFILE_BYTE_LENGTH,
  DDPI_PROFILE_VERSION,
  DDPI_Q16_16_ONE,
  DDPI_Q8_8_MAX,
  DDPI_Q8_8_MIN,
  DDPI_STATUS_ERR_CRC_OR_FMT,
  DDPI_STATUS_ERR_RANGE,
  DDPI_STATUS_ERR_UNSUPPORTED,
  DDPI_STATUS_OK,
  DdpiHidOpcode,
  type DdpiProfileV1,
  deserializeProfileV1,
  GLORIOUS_VID,
  isProfileIdentity,
  SERIES_ONE_PRO_WIRED_BL_PID,
  SERIES_ONE_PRO_WIRED_PID,
  serializeProfileV1,
  type WebHidFeatureTransport,
} from "./directional-dpi.ts";

/** clamp_rem_i32() in core/directional_dpi.c: 32767 counts in Q16.16 */
const REM_LIMIT = 2147418112n;

export class MockGloriousSeriesOneProHidDevice implements WebHidFeatureTransport {
  public vendorId = GLORIOUS_VID;
  public productId = SERIES_ONE_PRO_WIRED_PID;
  public productName = "Series One PRO";
  public bcdDevice = 0x0101;

  /** Simulated top of nRF52840 256 KB SRAM (0x2003FFFC) */
  public sramBootloaderMagicWord = 0x00000000;
  public inBootloaderMode = false;
  public featurePacketsReceived = 0;
  /** Packets framed as Open Directional DPI ('D','P' .. 0xDF) */
  public oddPacketsReceived = 0;
  /** Sensor DPI the mock firmware reports in GET_CAPABILITIES (0 = unknown) */
  public sensorDpi = 0;

  /* One live profile (max_slots = 1, the slot byte is ignored) and its flash copy */
  private profile = createDefaultProfileV1(800);
  private flash = serializeProfileV1(this.profile);
  private remXQ16_16 = 0n;
  private remYQ16_16 = 0n;
  private lastOctant = 0;
  private lastScaleQ16_16 = DDPI_Q16_16_ONE;
  private lastResponse = new Uint8Array(DDPI_HID_PACKET_LENGTH);

  public readonly mode: "stock-glorious" | "open-directional-dpi-v1";

  constructor(mode: "stock-glorious" | "open-directional-dpi-v1") {
    this.mode = mode;
  }

  async sendFeatureReport(reportId: number, data: Uint8Array): Promise<void> {
    if (reportId !== 0x00) {
      throw new Error(`Unsupported Feature Report ID: ${reportId}`);
    }
    this.featurePacketsReceived++;

    const req =
      data.length === 65 && data[0] === 0x00 ? data.subarray(1, 65) : data;
    const resp = new Uint8Array(DDPI_HID_PACKET_LENGTH);
    this.lastResponse = resp;
    const isOdd = req[0] === 0x44 && req[1] === 0x50 && req[5] === DDPI_HID_NAMESPACE;
    if (isOdd) {
      this.oddPacketsReceived++;
    }

    /* Stock Compx bootloader entry commands (0xB0 / 0x03) work in both modes */
    if ((req[6] === 0xb0 && req[7] === 0x04) || (req[0] === 0x00 && req[5] === 0x03)) {
      this.triggerCompxBootloaderReset();
      resp[0] = 0xa1;
      return;
    }

    /* Stock firmware-version query (build_and_verify_patch.py test 3): v1.0.0.0, PID 2018 */
    if (req[3] === 0x06 && req[4] === 0x00 && req[5] === 0x81) {
      resp.set([0xa1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0x20, 0x18]);
      if (this.mode === "open-directional-dpi-v1") {
        resp.set([0x44, 0x50, 0x30, 0x31], 16); // "DP01"
      }
      return;
    }

    if (this.mode === "stock-glorious" || !isOdd) {
      resp[0] = DDPI_STATUS_ERR_UNSUPPORTED; // 0xA3 Result_UnkownCommand
      return;
    }

    /* Open Directional DPI v1, as ddpi_hid_handle_feature_report() */
    resp[0] = 0x44; // 'D'
    resp[1] = 0x50; // 'P'
    resp[2] = DDPI_PROFILE_VERSION;
    resp[3] = DDPI_STATUS_OK;
    resp[4] = req[4]!;
    resp[5] = DDPI_HID_NAMESPACE;
    resp[6] = req[6]!;
    resp[7] = req[7]!;

    const expCrc = crc16Ccitt(req, 62);
    const actCrc = req[62]! | (req[63]! << 8);
    if (req[2] !== DDPI_PROFILE_VERSION || expCrc !== actCrc) {
      resp[3] = DDPI_STATUS_ERR_CRC_OR_FMT;
      this.signPacket(resp);
      return;
    }

    const opcode = req[6] as DdpiHidOpcode;
    const payload = resp.subarray(8, 62);
    const reqPayload = req.subarray(8, 62);
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const reqDv = new DataView(reqPayload.buffer, reqPayload.byteOffset, reqPayload.byteLength);

    switch (opcode) {
      case DdpiHidOpcode.GET_CAPABILITIES: {
        payload.set([0x44, 0x50, 0x30, 0x31, DDPI_PROFILE_VERSION, 1, 0], 0); // "DP01", v1, 1 slot, active 0
        payload[7] = 0x3a; // nvs_storage | bootloader_reentry | travel_window | linear_2x2
        dv.setUint16(8, DDPI_DPI_MIN, true);
        dv.setUint16(10, DDPI_DPI_MAX, true);
        dv.setUint16(12, DDPI_Q8_8_MIN, true);
        dv.setUint16(14, DDPI_Q8_8_MAX, true);
        payload[16] = DDPI_DEFAULT_WINDOW_COUNTS;
        payload[17] = DDPI_MAX_WINDOW_COUNTS;
        dv.setUint16(18, this.sensorDpi, true);
        if (this.sensorDpi !== 0) payload[7] |= 0x40; // sensor_dpi known
        break;
      }

      case DdpiHidOpcode.GET_PROFILE:
        payload.set(serializeProfileV1(this.profile), 0);
        break;

      case DdpiHidOpcode.SET_PROFILE: {
        try {
          this.profile = deserializeProfileV1(
            serializeProfileV1(
              deserializeProfileV1(reqPayload.subarray(0, DDPI_PROFILE_BYTE_LENGTH))
            )
          );
        } catch {
          resp[3] = DDPI_STATUS_ERR_CRC_OR_FMT;
          break;
        }
        if (isProfileIdentity(this.profile)) {
          this.resetRemainders();
        }
        payload.set(serializeProfileV1(this.profile), 0);
        break;
      }

      case DdpiHidOpcode.SAVE_FLASH:
        this.flash = serializeProfileV1(this.profile);
        payload.set(this.flash, 0);
        break;

      case DdpiHidOpcode.RESET_DEFAULTS:
        /* Keeps base_dpi; ddpi_engine_init() clears all engine state */
        this.profile = createDefaultProfileV1(this.profile.baseDpi);
        this.resetRemainders();
        this.lastOctant = 0;
        this.lastScaleQ16_16 = DDPI_Q16_16_ONE;
        payload.set(serializeProfileV1(this.profile), 0);
        break;

      case DdpiHidOpcode.SET_ENABLED: {
        const mode = reqPayload[0]!;
        let flags = this.profile.flags;
        if (mode === 2) {
          flags |= DDPI_FLAG_BYPASS_FOR_CALIBRATION;
          this.resetRemainders();
        } else if (mode !== 0) {
          flags = (flags | DDPI_FLAG_ENABLED) & ~DDPI_FLAG_BYPASS_FOR_CALIBRATION;
        } else {
          flags &= ~(DDPI_FLAG_ENABLED | DDPI_FLAG_BYPASS_FOR_CALIBRATION);
          this.resetRemainders();
        }
        this.profile = deserializeProfileV1(serializeProfileV1({ ...this.profile, flags }));
        payload[0] = this.profile.flags;
        break;
      }

      case DdpiHidOpcode.SIMULATE_DELTA: {
        const [outDx, outDy] = this.processDelta(reqDv.getInt16(0, true), reqDv.getInt16(2, true));
        dv.setInt16(0, outDx, true);
        dv.setInt16(2, outDy, true);
        dv.setInt32(4, Number(this.remXQ16_16), true);
        dv.setInt32(8, Number(this.remYQ16_16), true);
        dv.setUint8(12, this.lastOctant);
        dv.setUint32(13, this.lastScaleQ16_16, true);
        break;
      }

      case DdpiHidOpcode.ENTER_BOOTLOADER:
        if (reqDv.getUint32(0, true) !== DDPI_BOOTLOADER_CONFIRM_MAGIC) {
          resp[3] = DDPI_STATUS_ERR_RANGE;
        } else {
          this.triggerCompxBootloaderReset();
        }
        break;

      default:
        resp[3] = DDPI_STATUS_ERR_UNSUPPORTED;
        break;
    }

    this.signPacket(resp);
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    if (reportId !== 0x00) {
      throw new Error(`Unsupported Feature Report ID: ${reportId}`);
    }
    const copy = new Uint8Array(this.lastResponse);
    return new DataView(copy.buffer);
  }

  /** Simulate power-cycle reload from NVS flash (0x0007E000) */
  public simulatePowerCycleReboot(): void {
    this.profile = deserializeProfileV1(this.flash);
    this.resetRemainders();
  }

  private triggerCompxBootloaderReset(): void {
    this.sramBootloaderMagicWord = 0xa55aa55a;
    this.inBootloaderMode = true;
    this.productId = SERIES_ONE_PRO_WIRED_BL_PID; // 258a:2103
  }

  private signPacket(pkt: Uint8Array): void {
    const crc = crc16Ccitt(pkt, 62);
    pkt[62] = crc & 0xff;
    pkt[63] = (crc >> 8) & 0xff;
  }

  private resetRemainders(): void {
    this.remXQ16_16 = 0n;
    this.remYQ16_16 = 0n;
  }

  /**
   * ddpi_process_delta() for the angular model.
   * ponytail: no travel-window estimator (L treated as 0) and no linear-2x2 model;
   * port update_direction_estimator / the 2x2 path if a test needs them.
   */
  private processDelta(inDx: number, inDy: number): [number, number] {
    if (isProfileIdentity(this.profile)) {
      this.lastScaleQ16_16 = DDPI_Q16_16_ONE;
      return [Math.max(-32767, inDx), Math.max(-32767, inDy)];
    }
    if (inDx === 0 && inDy === 0) {
      return [0, 0];
    }
    const { scaleQ16_16, octant } = computeDirectionalScaleQ16_16(this.profile, inDx, inDy);
    this.lastOctant = octant;
    this.lastScaleQ16_16 = scaleQ16_16;
    const resetOnReverse = (this.profile.flags & DDPI_FLAG_RESET_REMAINDER_ON_REVERSE) !== 0;

    /* emit_from_q16_with_remainder(): truncate, clamp the report, carry the excess */
    const emit = (delta: number, rem: bigint): [number, bigint] => {
      if (delta === 0) return [0, rem];
      if (resetOnReverse && ((delta > 0 && rem < 0n) || (delta < 0 && rem > 0n))) {
        rem = 0n;
      }
      const total = BigInt(delta) * BigInt(scaleQ16_16) + rem;
      const out = Math.max(-32767, Math.min(32767, Number(total / 65536n)));
      const left = total - BigInt(out) * 65536n;
      return [out, left > REM_LIMIT ? REM_LIMIT : left < -REM_LIMIT ? -REM_LIMIT : left];
    };
    const [outDx, remX] = emit(inDx, this.remXQ16_16);
    const [outDy, remY] = emit(inDy, this.remYQ16_16);
    this.remXQ16_16 = remX;
    this.remYQ16_16 = remY;
    return [outDx, outDy];
  }
}
