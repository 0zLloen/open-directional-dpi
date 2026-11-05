/**
 * OpenMouse — Open Directional DPI v1 Protocol Client, Editor Model & Serializer
 *
 * Compatible with Glorious Forge Series One Pro (258a:2018 wired / 258a:2031 wireless)
 * and any mouse firmware implementing Open Directional DPI v1 (spec/directional-dpi-v1.md).
 *
 * SPDX-License-Identifier: MIT
 */

export const GLORIOUS_VID = 0x258a;
export const SERIES_ONE_PRO_WIRED_PID = 0x2018;
export const SERIES_ONE_PRO_WIRELESS_PID = 0x2031;
export const SERIES_ONE_PRO_WIRED_BL_PID = 0x2103;
export const SERIES_ONE_PRO_WIRELESS_BL_PID = 0x2113;

export const DDPI_PROFILE_MAGIC = 0x4450; // "DP" in little-endian
export const DDPI_PROFILE_VERSION = 0x01;
export const DDPI_PROFILE_BYTE_LENGTH = 28;
export const DDPI_HID_PACKET_LENGTH = 64;
export const DDPI_HID_NAMESPACE = 0xdf;
export const DDPI_BOOTLOADER_CONFIRM_MAGIC = 0x424c5253; // "BLRS"

export const DDPI_Q8_8_ONE = 0x0100; // 1.0000x (256)
export const DDPI_Q8_8_MIN = 0x0010; // 0.0625x (16)
export const DDPI_Q8_8_MAX = 0x0400; // 4.0000x (1024)
export const DDPI_Q16_16_ONE = 65536;

export const DDPI_FLAG_ENABLED = 1 << 0;
export const DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE = 1 << 1;
export const DDPI_FLAG_LINEAR_OCTANT_RATIO = 1 << 2;
export const DDPI_FLAG_FRAME_SENSOR_CCW = 1 << 3;
export const DDPI_FLAG_MODEL_LINEAR_2X2 = 1 << 4;
export const DDPI_FLAG_RESET_REMAINDER_ON_REVERSE = 1 << 5;
export const DDPI_FLAG_BYPASS_FOR_CALIBRATION = 1 << 6;
export const DDPI_DEFAULT_WINDOW_COUNTS = 16;
export const DDPI_MAX_WINDOW_COUNTS = 128;

export const DDPI_STATUS_OK = 0xa1;
export const DDPI_STATUS_ERR_CRC_OR_FMT = 0xa2;
export const DDPI_STATUS_ERR_UNSUPPORTED = 0xa3;
export const DDPI_STATUS_ERR_RANGE = 0xa4;

export const DdpiDirection = {
  E: 0,  //   0 deg: Right (+X, 0)
  SE: 1, //  45 deg: Down-Right (+X, +Y)
  S: 2,  //  90 deg: Down (0, +Y)
  SW: 3, // 135 deg: Down-Left (-X, +Y)
  W: 4,  // 180 deg: Left (-X, 0)
  NW: 5, // 225 deg: Up-Left (-X, -Y)
  N: 6,  // 270 deg: Up (0, -Y)
  NE: 7, // 315 deg: Up-Right (+X, -Y)
} as const;
export type DdpiDirection = (typeof DdpiDirection)[keyof typeof DdpiDirection];

export const DDPI_DIRECTION_LABELS: readonly string[] = [
  "E (0° Right)",
  "SE (45° Down-Right)",
  "S (90° Down)",
  "SW (135° Down-Left)",
  "W (180° Left)",
  "NW (225° Up-Left)",
  "N (270° Up)",
  "NE (315° Up-Right)",
];

export const DdpiHidOpcode = {
  GET_CAPABILITIES: 0x01,
  GET_PROFILE: 0x02,
  SET_PROFILE: 0x03,
  SAVE_FLASH: 0x04,
  RESET_DEFAULTS: 0x05,
  SET_ENABLED: 0x06,
  SIMULATE_DELTA: 0x07,
  ENTER_BOOTLOADER: 0x0f,
} as const;
export type DdpiHidOpcode = (typeof DdpiHidOpcode)[keyof typeof DdpiHidOpcode];

export type EightMultipliers = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface DdpiProfileV1 {
  magic: number;
  version: number;
  flags: number;
  baseDpi: number;
  globalGainQ8_8: number;
  multipliersQ8_8: EightMultipliers;
  reserved: number;
  crc16: number;
}

export interface DdpiProfileJsonExport {
  schema: "open-directional-dpi-v1";
  version: 1;
  enabled: boolean;
  keepRemainderOnReverse: boolean;
  linearOctantRatio: boolean;
  baseDpi: number;
  globalGain: number;
  directionalMultipliers: {
    E_0: number;
    SE_45: number;
    S_90: number;
    SW_135: number;
    W_180: number;
    NW_225: number;
    N_270: number;
    NE_315: number;
  };
}

export interface DdpiDeviceCapabilities {
  firmwareKind: "stock-glorious" | "open-directional-dpi-v1";
  protocolVersion: number;
  maxSlots: number;
  activeSlot: number;
  wired1000Hz: boolean;
  nvsStorage: boolean;
  paw3370Sensor: boolean;
  bootloaderReentry: boolean;
  minDpi: number;
  maxDpi: number;
  minMultiplierQ8_8: number;
  maxMultiplierQ8_8: number;
}

export interface WebHidFeatureTransport {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly bcdDevice?: number;
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

/**
 * Compute CRC-16-CCITT (polynomial 0x1021, initial value 0xFFFF).
 * Matches ddpi_crc16_ccitt() in core/directional_dpi.c bit-for-bit.
 */
export function crc16Ccitt(data: Uint8Array, length = data.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= (data[i]! & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

export function floatToQ8_8(multiplier: number): number {
  const raw = Math.round(multiplier * DDPI_Q8_8_ONE);
  return Math.max(DDPI_Q8_8_MIN, Math.min(DDPI_Q8_8_MAX, raw));
}

export function q8_8ToFloat(q8_8: number): number {
  return Number((q8_8 / DDPI_Q8_8_ONE).toFixed(4));
}

export function clampQ8_8(val: number): number {
  return Math.max(DDPI_Q8_8_MIN, Math.min(DDPI_Q8_8_MAX, Math.round(val)));
}

export function clampDpi(dpi: number): number {
  return Math.max(50, Math.min(19000, Math.round(dpi)));
}

export function createDefaultProfileV1(baseDpi = 800): DdpiProfileV1 {
  const profile: DdpiProfileV1 = {
    magic: DDPI_PROFILE_MAGIC,
    version: DDPI_PROFILE_VERSION,
    flags: 0,
    baseDpi: clampDpi(baseDpi),
    globalGainQ8_8: DDPI_Q8_8_ONE,
    multipliersQ8_8: [
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
      DDPI_Q8_8_ONE,
    ],
    reserved: 0,
    crc16: 0,
  };
  const bytes = serializeProfileV1(profile);
  profile.crc16 = bytes[26]! | (bytes[27]! << 8);
  return profile;
}

export function isProfileIdentity(profile: DdpiProfileV1): boolean {
  if ((profile.flags & DDPI_FLAG_ENABLED) === 0) {
    return true;
  }
  if (profile.globalGainQ8_8 !== DDPI_Q8_8_ONE) {
    return false;
  }
  return profile.multipliersQ8_8.every((m) => m === DDPI_Q8_8_ONE);
}

/**
 * Serialize a DdpiProfileV1 into a 28-byte little-endian Uint8Array with CRC-16-CCITT.
 */
export function serializeProfileV1(profile: DdpiProfileV1): Uint8Array {
  const buf = new Uint8Array(DDPI_PROFILE_BYTE_LENGTH);
  const dv = new DataView(buf.buffer);

  dv.setUint16(0, DDPI_PROFILE_MAGIC, true);
  dv.setUint8(2, DDPI_PROFILE_VERSION);
  dv.setUint8(3, profile.flags & 0xff);
  dv.setUint16(4, clampDpi(profile.baseDpi), true);
  dv.setUint16(6, clampQ8_8(profile.globalGainQ8_8), true);
  for (let i = 0; i < 8; i++) {
    dv.setUint16(8 + i * 2, clampQ8_8(profile.multipliersQ8_8[i]!), true);
  }
  const win = Math.min(DDPI_MAX_WINDOW_COUNTS, profile.reserved & 0xff);
  const res = (profile.reserved & 0xff00) | win;
  dv.setUint16(24, res, true);
  const crc = crc16Ccitt(buf, 26);
  dv.setUint16(26, crc, true);
  return buf;
}

/**
 * Deserialize and validate a 28-byte buffer into a DdpiProfileV1.
 */
export function deserializeProfileV1(buf: Uint8Array): DdpiProfileV1 {
  if (buf.byteLength < DDPI_PROFILE_BYTE_LENGTH) {
    throw new Error(`Invalid profile buffer length: ${buf.byteLength}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, DDPI_PROFILE_BYTE_LENGTH);
  const magic = dv.getUint16(0, true);
  const version = dv.getUint8(2);
  if (magic !== DDPI_PROFILE_MAGIC || version !== DDPI_PROFILE_VERSION) {
    throw new Error(
      `Unsupported profile header: magic=0x${magic.toString(16)} ver=${version}`
    );
  }

  const expectedCrc = crc16Ccitt(
    new Uint8Array(buf.buffer, buf.byteOffset, 26),
    26
  );
  const actualCrc = dv.getUint16(26, true);
  if (expectedCrc !== actualCrc) {
    throw new Error(
      `Profile CRC-16 mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`
    );
  }

  const flags = dv.getUint8(3);
  const baseDpi = dv.getUint16(4, true);
  const globalGainQ8_8 = dv.getUint16(6, true);
  if (
    baseDpi < 50 ||
    baseDpi > 19000 ||
    globalGainQ8_8 < DDPI_Q8_8_MIN ||
    globalGainQ8_8 > DDPI_Q8_8_MAX
  ) {
    throw new Error("Profile baseDpi or globalGain out of v1 bounds");
  }

  const multipliersQ8_8: EightMultipliers = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) {
    const m = dv.getUint16(8 + i * 2, true);
    if (m < DDPI_Q8_8_MIN || m > DDPI_Q8_8_MAX) {
      throw new Error(`Multiplier[${i}] out of bounds: ${m}`);
    }
    multipliersQ8_8[i] = m;
  }

  return {
    magic,
    version,
    flags,
    baseDpi,
    globalGainQ8_8,
    multipliersQ8_8,
    reserved: dv.getUint16(24, true),
    crc16: actualCrc,
  };
}

/**
 * Reference TypeScript implementation of ddpi_compute_scale_q16_16() matching C engine bit-for-bit.
 */
export function computeDirectionalScaleQ16_16(
  profile: DdpiProfileV1,
  dx: number,
  dy: number
): { scaleQ16_16: number; octant: number } {
  if ((dx === 0 && dy === 0) || isProfileIdentity(profile)) {
    return { scaleQ16_16: DDPI_Q16_16_ONE, octant: 0 };
  }

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let cardIdx = DdpiDirection.E;
  let diagIdx = DdpiDirection.SE;
  let octant = 0;
  let u = ax;
  let v = ay;

  if (dx >= 0 && dy >= 0) {
    if (ax >= ay) {
      cardIdx = DdpiDirection.E;
      diagIdx = DdpiDirection.SE;
      octant = 0;
      u = ax;
      v = ay;
    } else {
      cardIdx = DdpiDirection.S;
      diagIdx = DdpiDirection.SE;
      octant = 1;
      u = ay;
      v = ax;
    }
  } else if (dx < 0 && dy >= 0) {
    if (ay >= ax) {
      cardIdx = DdpiDirection.S;
      diagIdx = DdpiDirection.SW;
      octant = 2;
      u = ay;
      v = ax;
    } else {
      cardIdx = DdpiDirection.W;
      diagIdx = DdpiDirection.SW;
      octant = 3;
      u = ax;
      v = ay;
    }
  } else if (dx < 0 && dy < 0) {
    if (ax >= ay) {
      cardIdx = DdpiDirection.W;
      diagIdx = DdpiDirection.NW;
      octant = 4;
      u = ax;
      v = ay;
    } else {
      cardIdx = DdpiDirection.N;
      diagIdx = DdpiDirection.NW;
      octant = 5;
      u = ay;
      v = ax;
    }
  } else {
    if (ay >= ax) {
      cardIdx = DdpiDirection.N;
      diagIdx = DdpiDirection.NE;
      octant = 6;
      u = ay;
      v = ax;
    } else {
      cardIdx = DdpiDirection.E;
      diagIdx = DdpiDirection.NE;
      octant = 7;
      u = ax;
      v = ay;
    }
  }

  const r = u > 0 ? Math.floor((v * 65536) / u) : 0;
  let t = r;
  if (
    (profile.flags & DDPI_FLAG_LINEAR_OCTANT_RATIO) === 0 &&
    r > 0 &&
    r < 65536
  ) {
    const corr = Number(
      (17907n * BigInt(r) * BigInt(65536 - r)) >> 32n
    );
    t = Math.min(65536, r + corr);
  }

  const mCardQ16 = profile.multipliersQ8_8[cardIdx]! << 8;
  const mDiagQ16 = profile.multipliersQ8_8[diagIdx]! << 8;
  const diffQ16 = mDiagQ16 - mCardQ16;
  const mDirQ16 =
    mCardQ16 + Number((BigInt(diffQ16) * BigInt(t)) >> 16n);
  const scaleQ16_16 = Number(
    (BigInt(mDirQ16) * BigInt(profile.globalGainQ8_8)) >> 8n
  );

  return { scaleQ16_16, octant };
}

/**
 * Export a DdpiProfileV1 to human-readable JSON for OpenMouse profile sharing.
 */
export function exportProfileJson(profile: DdpiProfileV1): string {
  const m = profile.multipliersQ8_8;
  const doc: DdpiProfileJsonExport = {
    schema: "open-directional-dpi-v1",
    version: 1,
    enabled: (profile.flags & DDPI_FLAG_ENABLED) !== 0,
    keepRemainderOnReverse:
      (profile.flags & DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE) !== 0,
    linearOctantRatio: (profile.flags & DDPI_FLAG_LINEAR_OCTANT_RATIO) !== 0,
    baseDpi: profile.baseDpi,
    globalGain: q8_8ToFloat(profile.globalGainQ8_8),
    directionalMultipliers: {
      E_0: q8_8ToFloat(m[0]),
      SE_45: q8_8ToFloat(m[1]),
      S_90: q8_8ToFloat(m[2]),
      SW_135: q8_8ToFloat(m[3]),
      W_180: q8_8ToFloat(m[4]),
      NW_225: q8_8ToFloat(m[5]),
      N_270: q8_8ToFloat(m[6]),
      NE_315: q8_8ToFloat(m[7]),
    },
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Import and validate an OpenMouse Directional DPI JSON profile string.
 */
export function importProfileJson(jsonStr: string): DdpiProfileV1 {
  const parsed = JSON.parse(jsonStr) as DdpiProfileJsonExport;
  if (parsed.schema !== "open-directional-dpi-v1" || parsed.version !== 1) {
    throw new Error("Invalid Open Directional DPI JSON schema or version");
  }
  let flags = 0;
  if (parsed.enabled) flags |= DDPI_FLAG_ENABLED;
  if (parsed.keepRemainderOnReverse) flags |= DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE;
  if (parsed.linearOctantRatio) flags |= DDPI_FLAG_LINEAR_OCTANT_RATIO;

  const dm = parsed.directionalMultipliers;
  const profile: DdpiProfileV1 = {
    magic: DDPI_PROFILE_MAGIC,
    version: DDPI_PROFILE_VERSION,
    flags,
    baseDpi: clampDpi(parsed.baseDpi),
    globalGainQ8_8: floatToQ8_8(parsed.globalGain),
    multipliersQ8_8: [
      floatToQ8_8(dm.E_0),
      floatToQ8_8(dm.SE_45),
      floatToQ8_8(dm.S_90),
      floatToQ8_8(dm.SW_135),
      floatToQ8_8(dm.W_180),
      floatToQ8_8(dm.NW_225),
      floatToQ8_8(dm.N_270),
      floatToQ8_8(dm.NE_315),
    ],
    reserved: 0,
    crc16: 0,
  };
  const raw = serializeProfileV1(profile);
  return deserializeProfileV1(raw);
}

/**
 * Generate a 360-point polar sensitivity curve (1-degree steps) for OpenMouse UI rendering.
 */
export function computePolarCurve360(
  profile: DdpiProfileV1
): Array<{ angleDeg: number; effectiveDpi: number; multiplier: number }> {
  const points: Array<{
    angleDeg: number;
    effectiveDpi: number;
    multiplier: number;
  }> = [];
  for (let deg = 0; deg < 360; deg++) {
    const rad = (deg * Math.PI) / 180;
    const dx = Math.round(1000 * Math.cos(rad));
    const dy = Math.round(1000 * Math.sin(rad));
    const { scaleQ16_16 } = computeDirectionalScaleQ16_16(profile, dx, dy);
    const mult = scaleQ16_16 / DDPI_Q16_16_ONE;
    points.push({
      angleDeg: deg,
      effectiveDpi: Math.round(profile.baseDpi * mult),
      multiplier: Number(mult.toFixed(4)),
    });
  }
  return points;
}

/**
 * OpenMouse WebHID Protocol Client for Open Directional DPI v1.
 * Includes passive stock-vs-custom firmware detection so experimental commands
 * are never transmitted to stock Glorious firmware.
 */
export class OpenMouseDirectionalDpiClient {
  private seq = 1;
  private readonly transport: WebHidFeatureTransport;

  constructor(transport: WebHidFeatureTransport) {
    this.transport = transport;
  }

  /**
   * Detect whether the connected Glorious Series One Pro is running stock Compx
   * firmware or custom Open Directional DPI v1 firmware.
   *
   * Safety Rule: Performs passive USB descriptor inspection first (productName / bcdDevice).
   * If passive inspection shows unmodified stock firmware, returns "stock-glorious"
   * immediately WITHOUT sending any custom vendor HID packets.
   */
  async detectCapabilities(): Promise<DdpiDeviceCapabilities> {
    const isCustomDescriptor =
      this.transport.productName.includes("[OpenDDPIv1]") ||
      (this.transport.bcdDevice !== undefined &&
        this.transport.bcdDevice >= 0x0201);

    if (!isCustomDescriptor) {
      return {
        firmwareKind: "stock-glorious",
        protocolVersion: 0,
        maxSlots: 0,
        activeSlot: 0,
        wired1000Hz: true,
        nvsStorage: false,
        paw3370Sensor: true,
        bootloaderReentry: true,
        minDpi: 50,
        maxDpi: 19000,
        minMultiplierQ8_8: DDPI_Q8_8_ONE,
        maxMultiplierQ8_8: DDPI_Q8_8_ONE,
      };
    }

    const resp = await this.sendCommand(
      DdpiHidOpcode.GET_CAPABILITIES,
      0,
      new Uint8Array(0)
    );
    const magic = String.fromCharCode(
      resp[8]!,
      resp[9]!,
      resp[10]!,
      resp[11]!
    );
    if (magic !== "DP01") {
      throw new Error(`Unexpected capability signature: ${magic}`);
    }
    const dv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    const hwFlags = resp[15]!;
    return {
      firmwareKind: "open-directional-dpi-v1",
      protocolVersion: resp[12]!,
      maxSlots: resp[13]!,
      activeSlot: resp[14]!,
      wired1000Hz: (hwFlags & 0x01) !== 0,
      nvsStorage: (hwFlags & 0x02) !== 0,
      paw3370Sensor: (hwFlags & 0x04) !== 0,
      bootloaderReentry: (hwFlags & 0x08) !== 0,
      minDpi: dv.getUint16(16, true),
      maxDpi: dv.getUint16(18, true),
      minMultiplierQ8_8: dv.getUint16(20, true),
      maxMultiplierQ8_8: dv.getUint16(22, true),
    };
  }

  async getProfile(slot = 0): Promise<DdpiProfileV1> {
    const resp = await this.sendCommand(
      DdpiHidOpcode.GET_PROFILE,
      slot,
      new Uint8Array(0)
    );
    return deserializeProfileV1(resp.subarray(8, 8 + DDPI_PROFILE_BYTE_LENGTH));
  }

  async setProfile(profile: DdpiProfileV1, slot = 0): Promise<DdpiProfileV1> {
    const payload = serializeProfileV1(profile);
    const resp = await this.sendCommand(DdpiHidOpcode.SET_PROFILE, slot, payload);
    return deserializeProfileV1(resp.subarray(8, 8 + DDPI_PROFILE_BYTE_LENGTH));
  }

  async setEnabled(enabled: boolean, slot = 0): Promise<boolean> {
    const payload = new Uint8Array([enabled ? 1 : 0]);
    const resp = await this.sendCommand(DdpiHidOpcode.SET_ENABLED, slot, payload);
    return (resp[8]! & DDPI_FLAG_ENABLED) !== 0;
  }

  async saveToFlash(slot = 0): Promise<DdpiProfileV1> {
    const resp = await this.sendCommand(
      DdpiHidOpcode.SAVE_FLASH,
      slot,
      new Uint8Array(0)
    );
    return deserializeProfileV1(resp.subarray(8, 8 + DDPI_PROFILE_BYTE_LENGTH));
  }

  async resetDefaults(slot = 0): Promise<DdpiProfileV1> {
    const resp = await this.sendCommand(
      DdpiHidOpcode.RESET_DEFAULTS,
      slot,
      new Uint8Array(0)
    );
    return deserializeProfileV1(resp.subarray(8, 8 + DDPI_PROFILE_BYTE_LENGTH));
  }

  async simulateDelta(
    dx: number,
    dy: number
  ): Promise<{
    outDx: number;
    outDy: number;
    remXQ16_16: number;
    remYQ16_16: number;
    octant: number;
    scaleQ16_16: number;
  }> {
    const payload = new Uint8Array(4);
    const dvReq = new DataView(payload.buffer);
    dvReq.setInt16(0, dx, true);
    dvReq.setInt16(2, dy, true);

    const resp = await this.sendCommand(DdpiHidOpcode.SIMULATE_DELTA, 0, payload);
    const dvResp = new DataView(resp.buffer, resp.byteOffset + 8, 17);
    return {
      outDx: dvResp.getInt16(0, true),
      outDy: dvResp.getInt16(2, true),
      remXQ16_16: dvResp.getInt32(4, true),
      remYQ16_16: dvResp.getInt32(8, true),
      octant: dvResp.getUint8(12),
      scaleQ16_16: dvResp.getUint32(13, true),
    };
  }

  async enterBootloader(): Promise<void> {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(
      0,
      DDPI_BOOTLOADER_CONFIRM_MAGIC,
      true
    );
    await this.sendCommand(DdpiHidOpcode.ENTER_BOOTLOADER, 0, payload);
  }

  private async sendCommand(
    opcode: DdpiHidOpcode,
    slot: number,
    payload: Uint8Array
  ): Promise<Uint8Array> {
    const pkt = new Uint8Array(DDPI_HID_PACKET_LENGTH);
    const seq = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;

    pkt[0] = 0x44; // 'D'
    pkt[1] = 0x50; // 'P'
    pkt[2] = DDPI_PROFILE_VERSION;
    pkt[3] = 0x00;
    pkt[4] = seq;
    pkt[5] = DDPI_HID_NAMESPACE;
    pkt[6] = opcode;
    pkt[7] = slot & 0xff;
    pkt.set(payload.subarray(0, 54), 8);

    const reqCrc = crc16Ccitt(pkt, 62);
    pkt[62] = reqCrc & 0xff;
    pkt[63] = (reqCrc >> 8) & 0xff;

    await this.transport.sendFeatureReport(0x00, pkt);
    const dv = await this.transport.receiveFeatureReport(0x00);
    const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    /* Strip leading Report ID 0x00 if WebHID/HIDAPI returned 65 bytes */
    const resp =
      raw.length === 65 && raw[0] === 0x00 ? raw.subarray(1, 65) : raw;

    if (resp.length !== DDPI_HID_PACKET_LENGTH) {
      throw new Error(`Invalid Feature report response length: ${resp.length}`);
    }
    const expCrc = crc16Ccitt(resp, 62);
    const actCrc = resp[62]! | (resp[63]! << 8);
    if (expCrc !== actCrc) {
      throw new Error("Response packet CRC-16 mismatch");
    }
    if (resp[3] !== DDPI_STATUS_OK) {
      throw new Error(
        `Firmware returned error status 0x${resp[3]!.toString(16)} for opcode 0x${opcode.toString(16)}`
      );
    }
    return resp;
  }
}
