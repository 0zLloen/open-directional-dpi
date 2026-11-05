/**
 * Mock WebHID Device for Glorious Forge Series One Pro (Stock & Custom Firmware)
 *
 * Simulates both:
 *   1. Stock Compx Firmware (258a:2018 / 258a:2031, rev 1.01/1.00)
 *   2. Custom Open Directional DPI v1 Firmware (258a:2018, rev 2.01, "[OpenDDPIv1]")
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
  DDPI_FLAG_ENABLED,
  DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE,
  DDPI_HID_NAMESPACE,
  DDPI_HID_PACKET_LENGTH,
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

export class MockGloriousSeriesOneProHidDevice implements WebHidFeatureTransport {
  public vendorId = GLORIOUS_VID;
  public productId = SERIES_ONE_PRO_WIRED_PID;
  public productName: string;
  public bcdDevice: number;

  /** Simulated top of nRF52840 256 KB SRAM (0x2003FFFC) */
  public sramBootloaderMagicWord = 0x00000000;
  public inBootloaderMode = false;
  public featurePacketsReceived = 0;

  private ramSlots: DdpiProfileV1[] = [
    createDefaultProfileV1(800),
    createDefaultProfileV1(1600),
    createDefaultProfileV1(3200),
    createDefaultProfileV1(800),
  ];
  private nvsFlashSlots: Uint8Array[] = this.ramSlots.map((p) =>
    serializeProfileV1(p)
  );
  private remXQ16_16 = 0;
  private remYQ16_16 = 0;
  private lastResponse = new Uint8Array(DDPI_HID_PACKET_LENGTH);

  public readonly mode: "stock-glorious" | "open-directional-dpi-v1";

  constructor(mode: "stock-glorious" | "open-directional-dpi-v1") {
    this.mode = mode;
    if (mode === "stock-glorious") {
      this.productName = "Series One PRO";
      this.bcdDevice = 0x0101;
    } else {
      this.productName = "Series One PRO [OpenDDPIv1]";
      this.bcdDevice = 0x0201;
    }
  }

  async sendFeatureReport(reportId: number, data: Uint8Array): Promise<void> {
    if (reportId !== 0x00) {
      throw new Error(`Unsupported Feature Report ID: ${reportId}`);
    }
    this.featurePacketsReceived++;

    const req =
      data.length === 65 && data[0] === 0x00 ? data.subarray(1, 65) : data;
    const resp = new Uint8Array(DDPI_HID_PACKET_LENGTH);

    /* Stock Compx bootloader entry commands (0xB0 / 0x03) work in both modes */
    if ((req[6] === 0xb0 && req[7] === 0x04) || (req[0] === 0x00 && req[5] === 0x03)) {
      this.triggerCompxBootloaderReset();
      resp[0] = 0xa1;
      this.lastResponse = resp;
      return;
    }

    if (this.mode === "stock-glorious") {
      /* Simulate stock CM2856_Mouse_USB_v1.00.00_20220810.hex @ 0x0001451C */
      if (req[5] === 0x01 && req[6] === 0x81) {
        resp[0] = 0xa1;
        resp[8] = 1;
        resp[9] = 0;
        resp[10] = 0;
        resp[11] = 0;
      } else {
        resp[0] = DDPI_STATUS_ERR_UNSUPPORTED; // 0xA3 Result_UnkownCommand
      }
      this.lastResponse = resp;
      return;
    }

    /* Open Directional DPI v1 Custom Firmware Handler */
    if (req[0] !== 0x44 || req[1] !== 0x50 || req[5] !== DDPI_HID_NAMESPACE) {
      resp[0] = DDPI_STATUS_ERR_UNSUPPORTED;
      this.lastResponse = resp;
      return;
    }

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
      this.lastResponse = resp;
      return;
    }

    const opcode = req[6] as DdpiHidOpcode;
    const slot = Math.min(3, req[7]! & 0x03);
    const payload = resp.subarray(8, 62);
    const reqPayload = req.subarray(8, 62);
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    switch (opcode) {
      case DdpiHidOpcode.GET_CAPABILITIES: {
        payload[0] = 0x44; // 'D'
        payload[1] = 0x50; // 'P'
        payload[2] = 0x30; // '0'
        payload[3] = 0x31; // '1'
        payload[4] = DDPI_PROFILE_VERSION;
        payload[5] = 4; // max_slots
        payload[6] = 0; // active_slot
        payload[7] = 0x0f; // wired_1000hz | nvs_storage | paw3370_sensor | bootloader_reentry
        dv.setUint16(8, 50, true);
        dv.setUint16(10, 19000, true);
        dv.setUint16(12, DDPI_Q8_8_MIN, true);
        dv.setUint16(14, DDPI_Q8_8_MAX, true);
        break;
      }

      case DdpiHidOpcode.GET_PROFILE: {
        payload.set(serializeProfileV1(this.ramSlots[slot]!), 0);
        break;
      }

      case DdpiHidOpcode.SET_PROFILE: {
        try {
          const incoming = deserializeProfileV1(
            reqPayload.subarray(0, DDPI_PROFILE_BYTE_LENGTH)
          );
          this.ramSlots[slot] = incoming;
          if (isProfileIdentity(incoming)) {
            this.remXQ16_16 = 0;
            this.remYQ16_16 = 0;
          }
          payload.set(serializeProfileV1(this.ramSlots[slot]!), 0);
        } catch {
          resp[3] = DDPI_STATUS_ERR_CRC_OR_FMT;
        }
        break;
      }

      case DdpiHidOpcode.SAVE_FLASH: {
        const serialized = serializeProfileV1(this.ramSlots[slot]!);
        this.nvsFlashSlots[slot] = new Uint8Array(serialized);
        payload.set(serialized, 0);
        break;
      }

      case DdpiHidOpcode.RESET_DEFAULTS: {
        this.ramSlots[slot] = createDefaultProfileV1(800);
        this.remXQ16_16 = 0;
        this.remYQ16_16 = 0;
        payload.set(serializeProfileV1(this.ramSlots[slot]!), 0);
        break;
      }

      case DdpiHidOpcode.SET_ENABLED: {
        const prof = this.ramSlots[slot]!;
        if (reqPayload[0]! !== 0) {
          prof.flags |= DDPI_FLAG_ENABLED;
        } else {
          prof.flags &= ~DDPI_FLAG_ENABLED;
          this.remXQ16_16 = 0;
          this.remYQ16_16 = 0;
        }
        const updated = deserializeProfileV1(serializeProfileV1(prof));
        this.ramSlots[slot] = updated;
        payload[0] = updated.flags;
        break;
      }

      case DdpiHidOpcode.SIMULATE_DELTA: {
        const reqDv = new DataView(
          reqPayload.buffer,
          reqPayload.byteOffset,
          reqPayload.byteLength
        );
        const inDx = reqDv.getInt16(0, true);
        const inDy = reqDv.getInt16(2, true);
        const res = this.processDeltaInternal(this.ramSlots[0]!, inDx, inDy);
        dv.setInt16(0, res.outDx, true);
        dv.setInt16(2, res.outDy, true);
        dv.setInt32(4, this.remXQ16_16, true);
        dv.setInt32(8, this.remYQ16_16, true);
        dv.setUint8(12, res.octant);
        dv.setUint32(13, res.scaleQ16_16, true);
        break;
      }

      case DdpiHidOpcode.ENTER_BOOTLOADER: {
        const reqDv = new DataView(
          reqPayload.buffer,
          reqPayload.byteOffset,
          reqPayload.byteLength
        );
        const magicArg = reqDv.getUint32(0, true);
        if (magicArg !== DDPI_BOOTLOADER_CONFIRM_MAGIC) {
          resp[3] = DDPI_STATUS_ERR_RANGE;
        } else {
          this.triggerCompxBootloaderReset();
        }
        break;
      }

      default:
        resp[3] = DDPI_STATUS_ERR_UNSUPPORTED;
        break;
    }

    this.signPacket(resp);
    this.lastResponse = resp;
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
    this.ramSlots = this.nvsFlashSlots.map((raw) => deserializeProfileV1(raw));
    this.remXQ16_16 = 0;
    this.remYQ16_16 = 0;
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

  private processDeltaInternal(
    profile: DdpiProfileV1,
    inDx: number,
    inDy: number
  ): { outDx: number; outDy: number; octant: number; scaleQ16_16: number } {
    if (isProfileIdentity(profile)) {
      return {
        outDx: Math.max(-32767, inDx),
        outDy: Math.max(-32767, inDy),
        octant: 0,
        scaleQ16_16: DDPI_Q16_16_ONE,
      };
    }
    if (inDx === 0 && inDy === 0) {
      return { outDx: 0, outDy: 0, octant: 0, scaleQ16_16: DDPI_Q16_16_ONE };
    }
    const { scaleQ16_16, octant } = computeDirectionalScaleQ16_16(
      profile,
      inDx,
      inDy
    );
    const keepRem =
      (profile.flags & DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE) !== 0;

    const scaleAxis = (
      delta: number,
      remRef: "remXQ16_16" | "remYQ16_16"
    ): number => {
      if (delta === 0) return 0;
      if (!keepRem) {
        if (
          (delta > 0 && this[remRef] < 0) ||
          (delta < 0 && this[remRef] > 0)
        ) {
          this[remRef] = 0;
        }
      }
      const total =
        BigInt(delta) * BigInt(scaleQ16_16) + BigInt(this[remRef]);
      const outInt = Number(total / 65536n);
      const newRem = Number(total - BigInt(outInt) * 65536n);
      if (outInt > 32767) {
        this[remRef] = 0;
        return 32767;
      }
      if (outInt < -32767) {
        this[remRef] = 0;
        return -32767;
      }
      this[remRef] = newRem;
      return outInt;
    };

    const outDx = scaleAxis(inDx, "remXQ16_16");
    const outDy = scaleAxis(inDy, "remYQ16_16");
    return { outDx, outDy, octant, scaleQ16_16 };
  }
}
