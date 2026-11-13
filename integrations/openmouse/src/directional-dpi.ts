/**
 * OpenMouse — Open Directional DPI v1 Protocol Client, Editor Model & Serializer
 *
 * Compatible with the Glorious Forge Series One Pro running the stock-firmware patch, by
 * cable (258a:2018) or through its 2.4 GHz receiver (258a:2031, spec/hid-protocol-v1.md §2.3),
 * and any mouse firmware implementing Open Directional DPI v1 (spec/directional-dpi-v1.md).
 * Verified: the same packets from tools/odd_profile.py on a retail mouse, both routes
 * (2026-11-13). Not yet run over WebHID on hardware; tested against mock-hid.ts only.
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
/** Single DPI stage (like Corsair PureVector): the curve applies only while the sensor runs at baseDpi */
export const DDPI_FLAG_ONLY_AT_BASE_DPI = 1 << 7;
export const DDPI_DEFAULT_WINDOW_COUNTS = 16;
export const DDPI_MAX_WINDOW_COUNTS = 128;
export const DDPI_DPI_MIN = 50;
export const DDPI_DPI_MAX = 65535;

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

/**
 * Shareable profile JSON. `directionalMultipliers` always names physical HID
 * directions (E = right, S = toward the user, N = away) whatever `frame` the
 * firmware profile stores its array in. Fields added after the first release
 * (frame .. onlyAtBaseDpi) are optional on import and default to the old behaviour.
 */
export interface DdpiProfileJsonExport {
  schema: "open-directional-dpi-v1";
  version: 1;
  enabled: boolean;
  keepRemainderOnReverse: boolean;
  linearOctantRatio: boolean;
  resetRemainderOnReverse: boolean;
  /** Order of the 28-byte profile's multiplier array (DDPI_FLAG_FRAME_SENSOR_CCW) */
  frame: "hid-cw" | "odd-sensor-ccw";
  model: "angular-gain" | "linear-2x2";
  /** Travel-window length L in counts (0 = instantaneous) */
  windowCounts: number;
  /** Idle gap that resets the direction estimator, multiple of 5; 0 = firmware default (50 ms) */
  idleResetMs: number;
  /** Apply only while the sensor runs at baseDpi (one DPI stage, like Corsair PureVector) */
  onlyAtBaseDpi: boolean;
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
  /** "unsupported": not a Glorious Series One Pro and no "[OpenDDPIv1]" product string */
  firmwareKind: "stock-glorious" | "unsupported" | "open-directional-dpi-v1";
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
  /** Current sensor DPI as reported by the firmware (0 = unknown; then onlyAtBaseDpi has no effect) */
  sensorDpi: number;
}

export interface WebHidFeatureTransport {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
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
  return Math.max(DDPI_DPI_MIN, Math.min(DDPI_DPI_MAX, Math.round(dpi)));
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
  if (
    (profile.flags & DDPI_FLAG_ENABLED) === 0 ||
    (profile.flags & DDPI_FLAG_BYPASS_FOR_CALIBRATION) !== 0
  ) {
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
    baseDpi < DDPI_DPI_MIN ||
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
 * Index into profile.multipliersQ8_8 for a HID clockwise direction (DdpiDirection),
 * honouring DDPI_FLAG_FRAME_SENSOR_CCW. Mirrors get_sector_multiplier_q8_8() in C.
 */
export function multiplierIndexForDirection(flags: number, hidCwIdx: number): number {
  return (flags & DDPI_FLAG_FRAME_SENSOR_CCW) !== 0 ? (8 - hidCwIdx) & 7 : hidCwIdx & 7;
}

/**
 * Reference TypeScript implementation of ddpi_compute_scale_q16_16(), checked
 * bit-for-bit against the C engine by tests/vectors/scale_vectors.json.
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
  let cardIdx: DdpiDirection = DdpiDirection.E;
  let diagIdx: DdpiDirection = DdpiDirection.SE;
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
      (22787n * BigInt(r) * BigInt(65536 - r)) >> 32n
    );
    t = Math.min(65536, r + corr);
  }

  const m = profile.multipliersQ8_8;
  const mCardQ16 = m[multiplierIndexForDirection(profile.flags, cardIdx)]! << 8;
  const mDiagQ16 = m[multiplierIndexForDirection(profile.flags, diagIdx)]! << 8;
  const diffQ16 = mDiagQ16 - mCardQ16;
  const mDirQ16 =
    mCardQ16 + Number((BigInt(diffQ16) * BigInt(t)) >> 16n);
  const scaleQ16_16 = Number(
    (BigInt(mDirQ16) * BigInt(profile.globalGainQ8_8)) >> 8n
  );

  return { scaleQ16_16, octant };
}

/** directionalMultipliers keys in HID clockwise order (index = DdpiDirection) */
const JSON_DIRECTION_KEYS = [
  "E_0",
  "SE_45",
  "S_90",
  "SW_135",
  "W_180",
  "NW_225",
  "N_270",
  "NE_315",
] as const;
const JSON_FRAMES = ["hid-cw", "odd-sensor-ccw"] as const;
const JSON_MODELS = ["angular-gain", "linear-2x2"] as const;

/**
 * Export a DdpiProfileV1 to human-readable JSON for OpenMouse profile sharing.
 * DDPI_FLAG_BYPASS_FOR_CALIBRATION is transient and not exported.
 */
export function exportProfileJson(profile: DdpiProfileV1): string {
  const has = (bit: number): boolean => (profile.flags & bit) !== 0;
  const directionalMultipliers = Object.fromEntries(
    JSON_DIRECTION_KEYS.map((key, dir) => [
      key,
      q8_8ToFloat(
        profile.multipliersQ8_8[multiplierIndexForDirection(profile.flags, dir)]!
      ),
    ])
  ) as DdpiProfileJsonExport["directionalMultipliers"];
  const doc: DdpiProfileJsonExport = {
    schema: "open-directional-dpi-v1",
    version: 1,
    enabled: has(DDPI_FLAG_ENABLED),
    keepRemainderOnReverse: has(DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE),
    linearOctantRatio: has(DDPI_FLAG_LINEAR_OCTANT_RATIO),
    resetRemainderOnReverse: has(DDPI_FLAG_RESET_REMAINDER_ON_REVERSE),
    frame: has(DDPI_FLAG_FRAME_SENSOR_CCW) ? "odd-sensor-ccw" : "hid-cw",
    model: has(DDPI_FLAG_MODEL_LINEAR_2X2) ? "linear-2x2" : "angular-gain",
    windowCounts: Math.min(DDPI_MAX_WINDOW_COUNTS, profile.reserved & 0xff),
    idleResetMs: ((profile.reserved >> 8) & 0xff) * 5,
    onlyAtBaseDpi: has(DDPI_FLAG_ONLY_AT_BASE_DPI),
    baseDpi: profile.baseDpi,
    globalGain: q8_8ToFloat(profile.globalGainQ8_8),
    directionalMultipliers,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Import and validate an OpenMouse Directional DPI JSON profile string.
 * Throws a descriptive Error for anything that is not a valid profile.
 * Unknown fields are ignored; fields missing from older files take their old defaults.
 */
export function importProfileJson(jsonStr: string): DdpiProfileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Profile is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Profile JSON must be an object");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schema !== "open-directional-dpi-v1" || doc.version !== 1) {
    throw new Error("Invalid Open Directional DPI JSON schema or version");
  }

  const bool = (key: string): boolean => {
    const v = doc[key] ?? false;
    if (typeof v !== "boolean") throw new Error(`"${key}" must be true or false`);
    return v;
  };
  const int = (key: string, min: number, max: number, fallback?: number): number => {
    const v = doc[key] ?? fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(`"${key}" must be an integer in ${min}..${max}`);
    }
    return v;
  };
  const oneOf = (key: string, allowed: readonly string[]): string => {
    const v = doc[key] ?? allowed[0];
    if (typeof v !== "string" || !allowed.includes(v)) {
      throw new Error(`"${key}" must be one of: ${allowed.join(", ")}`);
    }
    return v;
  };
  const q8_8 = (v: unknown, what: string): number => {
    const q = typeof v === "number" ? Math.round(v * DDPI_Q8_8_ONE) : NaN;
    if (!(q >= DDPI_Q8_8_MIN && q <= DDPI_Q8_8_MAX)) {
      throw new Error(
        `${what} must be a number in ${DDPI_Q8_8_MIN / DDPI_Q8_8_ONE}..${DDPI_Q8_8_MAX / DDPI_Q8_8_ONE}`
      );
    }
    return q;
  };

  const flags =
    (bool("enabled") ? DDPI_FLAG_ENABLED : 0) |
    (bool("keepRemainderOnReverse") ? DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE : 0) |
    (bool("linearOctantRatio") ? DDPI_FLAG_LINEAR_OCTANT_RATIO : 0) |
    (bool("resetRemainderOnReverse") ? DDPI_FLAG_RESET_REMAINDER_ON_REVERSE : 0) |
    (oneOf("frame", JSON_FRAMES) === "odd-sensor-ccw" ? DDPI_FLAG_FRAME_SENSOR_CCW : 0) |
    (oneOf("model", JSON_MODELS) === "linear-2x2" ? DDPI_FLAG_MODEL_LINEAR_2X2 : 0) |
    (bool("onlyAtBaseDpi") ? DDPI_FLAG_ONLY_AT_BASE_DPI : 0);

  const windowCounts = int("windowCounts", 0, DDPI_MAX_WINDOW_COUNTS, 0);
  const idleResetMs = int("idleResetMs", 0, 255 * 5, 0);
  if (idleResetMs % 5 !== 0) {
    throw new Error(`"idleResetMs" must be a multiple of 5`);
  }

  const dm = doc.directionalMultipliers;
  if (typeof dm !== "object" || dm === null || Array.isArray(dm)) {
    throw new Error(`"directionalMultipliers" must be an object`);
  }
  const multipliersQ8_8: EightMultipliers = [0, 0, 0, 0, 0, 0, 0, 0];
  JSON_DIRECTION_KEYS.forEach((key, dir) => {
    multipliersQ8_8[multiplierIndexForDirection(flags, dir)] = q8_8(
      (dm as Record<string, unknown>)[key],
      `"directionalMultipliers.${key}"`
    );
  });

  const profile: DdpiProfileV1 = {
    magic: DDPI_PROFILE_MAGIC,
    version: DDPI_PROFILE_VERSION,
    flags,
    baseDpi: int("baseDpi", DDPI_DPI_MIN, DDPI_DPI_MAX),
    globalGainQ8_8: q8_8(doc.globalGain, `"globalGain"`),
    multipliersQ8_8,
    reserved: ((idleResetMs / 5) << 8) | windowCounts,
    crc16: 0,
  };
  return deserializeProfileV1(serializeProfileV1(profile));
}

/**
 * Generate a 360-point polar sensitivity curve (1-degree steps) for OpenMouse UI rendering.
 * For the linear-2x2 model the multiplier is |out| / |in| of the C engine's matrix
 * (that model also bends the direction, which the curve does not show).
 */
export function computePolarCurve360(
  profile: DdpiProfileV1
): Array<{ angleDeg: number; effectiveDpi: number; multiplier: number }> {
  const points: Array<{
    angleDeg: number;
    effectiveDpi: number;
    multiplier: number;
  }> = [];
  /* ddpi_process_delta's 2x2 path: gx = M[E]·G, gy = M[N]·G, h = trunc((M[NE]·G - M[NW]·G) / 2) */
  const gain = (dir: number): number =>
    profile.multipliersQ8_8[multiplierIndexForDirection(profile.flags, dir)]! *
    profile.globalGainQ8_8;
  const linear2x2 =
    (profile.flags & DDPI_FLAG_MODEL_LINEAR_2X2) !== 0 && !isProfileIdentity(profile);
  const gx = gain(DdpiDirection.E);
  const gy = gain(DdpiDirection.N);
  const h = Math.trunc((gain(DdpiDirection.NE) - gain(DdpiDirection.NW)) / 2);
  for (let deg = 0; deg < 360; deg++) {
    const rad = (deg * Math.PI) / 180;
    const dx = Math.round(1000 * Math.cos(rad));
    const dy = Math.round(1000 * Math.sin(rad));
    const mult = linear2x2
      ? Math.hypot(dx * gx - dy * h, dy * gy - dx * h) /
        (DDPI_Q16_16_ONE * Math.hypot(dx, dy))
      : computeDirectionalScaleQ16_16(profile, dx, dy).scaleQ16_16 / DDPI_Q16_16_ONE;
    points.push({
      angleDeg: deg,
      effectiveDpi: Math.round(profile.baseDpi * mult),
      multiplier: Number(mult.toFixed(4)),
    });
  }
  return points;
}

/* GET_REPORT is retried until this deadline: through the 2.4 GHz receiver SAVE_FLASH
 * answers after ~770 ms (spec/hid-protocol-v1.md §2.3) */
const ANSWER_DEADLINE_MS = 2000;
const ANSWER_POLL_MS = 10;

/**
 * Of the Glorious devices a host can open, the cable (258a:2018) wins over the
 * 2.4 GHz receiver (258a:2031) when both are present, as in tools/odd_profile.py.
 */
export function preferCable<T extends { vendorId: number; productId: number }>(
  devices: readonly T[]
): T | undefined {
  return (
    devices.find(
      (d) => d.vendorId === GLORIOUS_VID && d.productId === SERIES_ONE_PRO_WIRED_PID
    ) ?? devices[0]
  );
}

/**
 * OpenMouse WebHID Protocol Client for Open Directional DPI v1.
 * Includes passive stock-vs-custom firmware detection so experimental commands
 * are never transmitted to stock Glorious firmware.
 */
export class OpenMouseDirectionalDpiClient {
  /** Request sequence numbers stay in 5..255: stock Glorious firmware rejects body[4] >= 5
   *  before running any handler, so a request can never trigger a stock command. */
  private seq = 5;
  private readonly transport: WebHidFeatureTransport;

  constructor(transport: WebHidFeatureTransport) {
    this.transport = transport;
  }

  /** The Glorious 2.4 GHz receiver relays requests to the mouse (spec/hid-protocol-v1.md §2.3) */
  private get relay(): boolean {
    return (
      this.transport.vendorId === GLORIOUS_VID &&
      this.transport.productId === SERIES_ONE_PRO_WIRELESS_PID
    );
  }

  /**
   * Detect whether the device speaks Open Directional DPI v1 (spec/hid-protocol-v1.md §2.2).
   *
   * Safety Rule: no Open Directional DPI packet goes to a device that has not
   * identified itself first: product string "[OpenDDPIv1]" (any device), or for
   * the Glorious Series One Pro IDs only, the "DP01" stamp the stock-firmware
   * patch adds to the stock firmware-version answer (through the receiver: the
   * relayed query and the stamp at 12..15, §2.3).
   * Otherwise returns "stock-glorious" / "unsupported".
   * Throws if the receiver cannot reach the mouse.
   */
  async detectCapabilities(): Promise<DdpiDeviceCapabilities> {
    const t = this.transport;
    const glorious =
      t.vendorId === GLORIOUS_VID &&
      (t.productId === SERIES_ONE_PRO_WIRED_PID ||
        t.productId === SERIES_ONE_PRO_WIRELESS_PID);
    const speaksOdd =
      t.productName.includes("[OpenDDPIv1]") ||
      (glorious && (await this.gloriousVersionHasPatchStamp()));

    if (!speaksOdd) {
      return {
        firmwareKind: glorious ? "stock-glorious" : "unsupported",
        protocolVersion: 0,
        maxSlots: 0,
        activeSlot: 0,
        wired1000Hz: glorious,
        nvsStorage: false,
        paw3370Sensor: glorious,
        bootloaderReentry: glorious && !this.relay, // the Compx bootloader is USB only
        minDpi: glorious ? 50 : 0,
        maxDpi: glorious ? 19000 : 0,
        minMultiplierQ8_8: DDPI_Q8_8_ONE,
        maxMultiplierQ8_8: DDPI_Q8_8_ONE,
        sensorDpi: 0,
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
      bootloaderReentry: !this.relay && (hwFlags & 0x08) !== 0, // enterBootloader() needs the cable
      minDpi: dv.getUint16(16, true),
      maxDpi: dv.getUint16(18, true),
      minMultiplierQ8_8: dv.getUint16(20, true),
      maxMultiplierQ8_8: dv.getUint16(22, true),
      sensorDpi: dv.getUint16(26, true),
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

  /**
   * Exact 1.00x passthrough while calibrating (SET_ENABLED mode 2): a calibration
   * measured through the active curve would be relative to it. Returns the
   * ENABLED flag, which is kept; pass it to setEnabled() to end the bypass.
   */
  async bypassForCalibration(slot = 0): Promise<boolean> {
    const resp = await this.sendCommand(DdpiHidOpcode.SET_ENABLED, slot, new Uint8Array([2]));
    return (resp[8]! & DDPI_FLAG_ENABLED) !== 0;
  }

  /**
   * Persist the active profile. Call it only on an explicit user action (a Save
   * button), never on every edit: on the Glorious every save erases a flash page,
   * and through the 2.4 GHz receiver the answer takes ~770 ms.
   */
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
    if (this.relay) {
      throw new Error("ENTER_BOOTLOADER needs the cable: the Compx bootloader is USB only");
    }
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(
      0,
      DDPI_BOOTLOADER_CONFIRM_MAGIC,
      true
    );
    /* The device normally resets without answering: only an error status fails */
    await this.sendCommand(DdpiHidOpcode.ENTER_BOOTLOADER, 0, payload, true);
  }

  private async sendCommand(
    opcode: DdpiHidOpcode,
    slot: number,
    payload: Uint8Array,
    mayNotAnswer = false
  ): Promise<Uint8Array> {
    const pkt = new Uint8Array(DDPI_HID_PACKET_LENGTH);
    const seq = this.seq;
    this.seq = this.seq >= 255 ? 5 : this.seq + 1;

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
    if (this.relay) {
      /* Relay envelope (§2.3): target mouse, forward 0x3A + 6 = 64 bytes; outside the CRC */
      pkt[2] = 0x02;
      pkt[3] = 0x3a;
    }

    await this.transport.sendFeatureReport(0x00, pkt);
    /* Only the answer echoing this seq and opcode counts; until it is ready the
     * device may still return its previous answer */
    const resp = await this.pollAnswer(
      (r) =>
        r.length === DDPI_HID_PACKET_LENGTH &&
        r[0] === 0x44 &&
        r[1] === 0x50 &&
        r[4] === seq &&
        r[5] === DDPI_HID_NAMESPACE &&
        r[6] === opcode
    ).catch((err: unknown) => {
      if (!mayNotAnswer) throw err;
      return undefined; // e.g. the device left the bus while resetting
    });
    if (resp === undefined) {
      if (mayNotAnswer) return new Uint8Array(0);
      throw new Error(
        `No answer to opcode 0x${opcode.toString(16)} within ${ANSWER_DEADLINE_MS} ms`
      );
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

  /**
   * GET_REPORT(Feature 0), without a leading Report ID, until `isAnswer` accepts
   * it; undefined if it never does within ANSWER_DEADLINE_MS. The Glorious patch
   * answers from the main loop (via the 2.4 GHz receiver: after a radio round
   * trip, and SAVE_FLASH erases a flash page first), so the first GET_REPORT can
   * return the previous answer. The receiver shows 0xA0 while a request is pending
   * and 0xA4 while the link is down; 0xA4 can be transient (SAVE_FLASH), so only
   * a 0xA4 at the deadline means the mouse is unreachable.
   */
  private async pollAnswer(
    isAnswer: (resp: Uint8Array) => boolean
  ): Promise<Uint8Array | undefined> {
    const deadline = Date.now() + ANSWER_DEADLINE_MS;
    for (let i = 0; ; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
      const dv = await this.transport.receiveFeatureReport(0x00);
      const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      /* Strip leading Report ID 0x00 if WebHID/HIDAPI returned 65 bytes */
      const resp = raw.length === 65 && raw[0] === 0x00 ? raw.subarray(1, 65) : raw;
      if (isAnswer(resp)) return resp;
      if (Date.now() >= deadline) {
        if (this.relay && resp[0] === 0xa4) {
          throw new Error(
            "The 2.4 GHz receiver cannot reach the mouse (switched off, asleep or out of range)"
          );
        }
        return undefined;
      }
    }
  }

  /**
   * Stock Glorious firmware-version query ([4] = 0x00, [5] = 0x81), which
   * stock_ddpi_patch.c stamps with "DP01". Stock firmware just answers it.
   * Cable: [3] = 0x06, stamp at [16..19]. Receiver (§2.3): [2] = 0x02 relays it to
   * the mouse and [3] = 0x0A copies back 16 bytes; only patch builds that
   * understand the relay envelope also stamp [12..15].
   */
  private async gloriousVersionHasPatchStamp(): Promise<boolean> {
    const req = new Uint8Array(DDPI_HID_PACKET_LENGTH);
    req.set(this.relay ? [0x02, 0x0a, 0x00, 0x81] : [0x00, 0x06, 0x00, 0x81], 2);
    await this.transport.sendFeatureReport(0x00, req);
    /* A finished answer echoes the query; stock firmware that does not echo it
     * costs the whole deadline */
    const resp = await this.pollAnswer(
      (r) => r[0] === 0xa1 && r[4] === 0x00 && r[5] === 0x81
    );
    const at = this.relay ? 12 : 16;
    return resp !== undefined && String.fromCharCode(...resp.subarray(at, at + 4)) === "DP01";
  }
}
