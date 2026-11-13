# Open Directional DPI Specification — Version 1.0 (`directional-dpi-v1`)

The reference implementation is `core/directional_dpi.c`. Where this text and that file disagree, the code and the conformance vectors (§9) are authoritative and this text is the bug.

## 1. Scope & Design Goals

**Open Directional DPI v1** defines a deterministic, vendor-neutral, fixed-point algorithm and binary profile format for direction-dependent mouse sensitivity inside mouse firmware or a host filter, and for configuration tools such as **OpenMouse**.

1. **Integer only**: no `float`/`double` and no `<math.h>` at runtime. Products use 64-bit integer intermediates; a report needs at most two 32-bit unsigned divisions (the octant ratio, and the estimator decay when $L > 0$).
2. **Eight control points**: one multiplier per compass direction, $45^\circ$ apart, interpolated continuously ($C^0$) around the circle.
3. **Direction only**: the gain depends on the direction of motion, never on its speed (no acceleration curve).
4. **Global scalar gain**: `global_gain_q8_8` scales the whole curve.
5. **Exact neutral identity**: when the profile is disabled, in calibration bypass, or all multipliers and the global gain are `1.00x`, the output equals the input (only `-32768` becomes `-32767`).
6. **Sub-count remainders**: signed Q16.16 remainders `(rem_x, rem_y)` carry fractions across reports, so slow motion is not lost to quantization.
7. **Saturation without loss**: outputs clamp to `-32767 .. +32767`; the excess stays in the remainder and is emitted in later reports.

---

## 2. Coordinate Convention & Direction Indices

USB HID mice and their sensors report relative motion in screen coordinates:
- $+X$: right (East); $-X$: left (West)
- $+Y$: toward the user (South, down on screen); $-Y$: away from the user (North, up on screen)

The direction angle $\theta$ is measured from $+X$ toward $+Y$. Because $+Y$ points toward the user, increasing $\theta$ runs **clockwise** when looking down at the desk: East $0^\circ$, South $90^\circ$, West $180^\circ$, North $270^\circ$. This is the default multiplier order (**HID-CW**, `ddpi_direction_t`): index $k$ is the direction $\theta = 45k^\circ$.

With profile flag bit 3 (`DDPI_FLAG_FRAME_SENSOR_CCW`, JSON frame `odd-sensor-ccw`) the multipliers are stored **counter-clockwise** in tabletop order instead (`ddpi_ccw_direction_t`: `0 = E, 1 = NE, 2 = N, ... 7 = SE`). HID-CW direction $k$ then reads `multipliers_q8_8[(8 - k) mod 8]`. The physical meaning of each direction does not change with the frame.

| HID-CW index $k$ | Identifier | $\theta$ | Sign of $(dx, dy)$ | Physical motion | CCW-frame index |
| :---: | :--- | :---: | :---: | :--- | :---: |
| `0` | `DDPI_DIR_E` | $0^\circ$ | $dx > 0,\; dy = 0$ | Right (East) | `0` |
| `1` | `DDPI_DIR_SE` | $45^\circ$ | $dx > 0,\; dy > 0,\; \lvert dx\rvert = \lvert dy\rvert$ | Toward-right (South-East) | `7` |
| `2` | `DDPI_DIR_S` | $90^\circ$ | $dx = 0,\; dy > 0$ | Toward / pull back (South) | `6` |
| `3` | `DDPI_DIR_SW` | $135^\circ$ | $dx < 0,\; dy > 0,\; \lvert dx\rvert = \lvert dy\rvert$ | Toward-left (South-West) | `5` |
| `4` | `DDPI_DIR_W` | $180^\circ$ | $dx < 0,\; dy = 0$ | Left (West) | `4` |
| `5` | `DDPI_DIR_NW` | $225^\circ$ | $dx < 0,\; dy < 0,\; \lvert dx\rvert = \lvert dy\rvert$ | Away-left (North-West) | `3` |
| `6` | `DDPI_DIR_N` | $270^\circ$ | $dx = 0,\; dy < 0$ | Away / push forward (North) | `2` |
| `7` | `DDPI_DIR_NE` | $315^\circ$ | $dx > 0,\; dy < 0,\; \lvert dx\rvert = \lvert dy\rvert$ | Away-right (North-East) | `1` |

Below, $M[k]$ always means the multiplier for HID-CW direction $k$ after this frame mapping.

The curve applies to the axes the sensor reports. A rotated sensor must be corrected before the engine (e.g. in the sensor driver), not after it.

---

## 3. Fixed-Point Representation (`Q8.8` and `Q16.16`)

- **Multipliers (`multipliers_q8_8[8]`) and global gain (`global_gain_q8_8`)**: unsigned 16-bit **Q8.8** (`1 LSB = 1/256`). Neutral `1.00x` = `0x0100` (`256`). Valid range `0x0010` (`0.0625x`) to `0x0400` (`4.0000x`).
- **Scale and remainders**: **Q16.16** (`1.0 = 65536`). The scale is unsigned 32-bit; remainders are signed 32-bit.

---

## 4. Directional Scale (`ddpi_compute_scale_q16_16`)

Input: a direction vector $(dx, dy) \in [-32768, 32767]^2$. In the engine this is the estimator output of §5 (the raw report when $L = 0$). Zero motion or an identity profile (§6.1) returns exactly `65536` and octant `0`.

### Step 1 — Octant classification (`0..7`)
Let $ax = |dx|$ and $ay = |dy|$ (as `uint32_t`, so `-32768` does not overflow). Octant $o$ is the $45^\circ$ sector $[45o^\circ, 45(o+1)^\circ]$ in HID-CW angle, bounded by a cardinal $M_{\text{card}}$ and a diagonal $M_{\text{diag}}$:

| $o$ | Quadrant signs | Condition | $M_{\text{card}}$ | $M_{\text{diag}}$ | $(u, v)$ |
| :---: | :--- | :--- | :--- | :--- | :--- |
| `0` | $dx \ge 0,\; dy \ge 0$ | $ax \ge ay$ | `M[0]` E | `M[1]` SE | $u = ax,\; v = ay$ |
| `1` | $dx \ge 0,\; dy \ge 0$ | $ay > ax$ | `M[2]` S | `M[1]` SE | $u = ay,\; v = ax$ |
| `2` | $dx < 0,\; dy \ge 0$ | $ay \ge ax$ | `M[2]` S | `M[3]` SW | $u = ay,\; v = ax$ |
| `3` | $dx < 0,\; dy \ge 0$ | $ax > ay$ | `M[4]` W | `M[3]` SW | $u = ax,\; v = ay$ |
| `4` | $dx < 0,\; dy < 0$ | $ax \ge ay$ | `M[4]` W | `M[5]` NW | $u = ax,\; v = ay$ |
| `5` | $dx < 0,\; dy < 0$ | $ay > ax$ | `M[6]` N | `M[5]` NW | $u = ay,\; v = ax$ |
| `6` | $dx \ge 0,\; dy < 0$ | $ay \ge ax$ | `M[6]` N | `M[7]` NE | $u = ay,\; v = ax$ |
| `7` | $dx \ge 0,\; dy < 0$ | $ax > ay$ | `M[0]` E | `M[7]` NE | $u = ax,\; v = ay$ |

So $u = \max(ax, ay) > 0$ and $v = \min(ax, ay)$.

### Step 2 — Fraction $t \in [0, 65536]$ across the octant
1. Tangent ratio: $r = 65536$ if $v \ge u$, else $r = \lfloor (v \ll 16) / u \rfloor$ (32-bit unsigned division).
2. With flag bit 2 (`DDPI_FLAG_LINEAR_OCTANT_RATIO`): $t = r$. This interpolates linearly in $\tan$; the angle error peaks at about $4.07^\circ$.
3. Otherwise (default, circular): for $0 < r < 65536$, using $\frac{4}{\pi}\arctan(x) \approx x + 0.3477\,x(1 - x)$ and $0.3477 \times 65536 \approx 22787$:
   $$t = \min\left(65536,\; r + \left\lfloor \frac{22787 \cdot r \cdot (65536 - r)}{2^{32}} \right\rfloor\right)$$
   ($t = r$ at $r = 0$ and $r = 65536$). $t$ is monotonic in $r$ and its maximum error against the true angle is about $0.215^\circ$ (at $r \approx 42300$, i.e. near $33^\circ$ into the octant).

At a cardinal axis ($v = 0$) $t = 0$, and at a diagonal ($v = u$) $t = 65536$; neighbouring octants share these boundary values, so the curve is continuous around the whole circle.

### Step 3 — Interpolated multiplier and global gain
$$M_{\text{card},16} = M_{\text{card}} \ll 8, \qquad M_{\text{diag},16} = M_{\text{diag}} \ll 8$$
$$M_{\text{dir},16} = M_{\text{card},16} + \left\lfloor \frac{(M_{\text{diag},16} - M_{\text{card},16}) \cdot t}{2^{16}} \right\rfloor$$
$$S_{16} = \left\lfloor \frac{M_{\text{dir},16} \cdot \text{global\_gain\_q8\_8}}{2^{8}} \right\rfloor$$
The products use 64-bit integers; the signed difference is shifted arithmetically (rounds toward $-\infty$).

---

## 5. Travel-Window Direction Estimator

Used only by the angular-gain model (§6.2). The window length $L$ is the low byte of the profile's `reserved` field (§7.2), `0..128` counts; larger stored values act as `128`.

- **$L = 0$**: the direction is the raw report $(dx, dy)$ itself.
- **$L > 0$**: the engine keeps a vector $\mathbf{d} = (d_x, d_y)$ (`dir_x_q16_16`, `dir_y_q16_16`; only its angle matters). For each non-zero report $\Delta = (dx, dy)$ with $s = |dx| + |dy|$:
  1. Decay: $\alpha_{16} = \lfloor (2L \ll 16) / (2L + s) \rfloor$. This is $\frac{2L}{2L + s} = \frac{1}{1 + s/2L}$, the first-order rational (Padé $[0/1]$) approximation of $e^{-s/2L}$, so the old direction fades with distance travelled (about $1/e$ per $2L$ counts) rather than per report.
  2. Update: $d_c \leftarrow \lfloor d_c \cdot \alpha_{16} / 2^{16} \rfloor + 256 \cdot \Delta_c$ for $c \in \{x, y\}$ (64-bit math, arithmetic shift).
  3. Bound: while $|d_x| > 16383$ or $|d_y| > 16383$, halve both ($d_c \leftarrow d_c \gg 1$). Halving both keeps the angle, and the bound lets $\mathbf{d}$ pass as `int16_t` to §4 without wrapping. This also applies to the first report after a reset, where $|\Delta| \ge 128$ would otherwise wrap.
  4. The scale for this report is $S_{16} = \text{scale}(d_x, d_y)$ from §4; it is applied to the raw $\Delta$ (§6.4).

  Because each report adds its full $256 \cdot \Delta$ and the decay depends on distance, one 1 kHz report of $(2, -2)$ and the matching 8 kHz reports $(1, 0), (0, -1)$ end up with nearly the same direction.

**Idle reset.** `ddpi_process_motion(engine, dx, dy, now_ms, ...)` runs `ddpi_process_delta` after this check: for a non-zero report, if `now_ms - last_motion_ms >= idle_ms` (unsigned, so a wrapping millisecond clock works) then $\mathbf{d} \leftarrow (0, 0)$; then `last_motion_ms = now_ms`. Zero reports do not update `last_motion_ms`. `idle_ms` is the high byte of `reserved` times 5 ms, or 50 ms (`DDPI_DEFAULT_IDLE_MS`) when that byte is 0. Remainders are not touched. `ddpi_process_delta` alone never resets $\mathbf{d}$ (the Glorious patch and `SIMULATE_DELTA` use it), so with $L > 0$ the first $\sim L$ counts of a new flick lean toward the previous direction there.

---

## 6. Per-Report Processing (`ddpi_process_delta`)

### 6.1 Identity bypass
The profile is an identity when flag bit 0 (`ENABLED`) is clear, or flag bit 6 (`BYPASS_FOR_CALIBRATION`) is set, or the global gain and all 8 multipliers are `0x0100`. Then `out = in` (with `-32768` clamped to `-32767`), and the estimator and remainders are left untouched. Loading an identity profile (`ddpi_engine_set_profile`) clears the remainders and $\mathbf{d}$.

A report of $(0, 0)$ outputs $(0, 0)$ and changes no state.

### 6.2 Angular-gain model (default)
Update the estimator (§5), compute $S_{16}$ (§4), then emit each axis with the raw delta: $\text{scaled}_c = \Delta_c \cdot S_{16}$ (§6.4).

### 6.3 Linear 2×2 model (flag bit 4, `DDPI_FLAG_MODEL_LINEAR_2X2`)
No estimator and no octant. With $G$ = `global_gain_q8_8`, in Q16.16:
$$g_x = M[\text{E}] \cdot G, \quad g_y = M[\text{N}] \cdot G, \quad h = \operatorname{trunc}\!\left(\frac{M[\text{NE}] \cdot G - M[\text{NW}] \cdot G}{2}\right)$$
$$\text{scaled}_x = dx \cdot g_x - dy \cdot h, \qquad \text{scaled}_y = dy \cdot g_y - dx \cdot h$$
Only E, N, NE and NW are used: the matrix is symmetric (W behaves like E, S like N), and $h > 0$ boosts NE/SW motion and reduces NW/SE motion.

### 6.4 Remainders, truncation and saturation
For each axis $c$ with raw delta $\Delta_c$ and $\text{scaled}_c$ in Q16.16 (an axis with $\Delta_c = 0$ and $\text{scaled}_c = 0$ outputs `0` and keeps its remainder):
1. **Reversal policy.** By default the remainder is kept when the motion reverses. With flag bit 5 (`DDPI_FLAG_RESET_REMAINDER_ON_REVERSE`), $\text{rem}_c \leftarrow 0$ first if $\Delta_c$ and $\text{rem}_c$ have opposite signs. Flag bit 1 (`KEEP_REMAINDER_ON_REVERSE`) is a legacy alias of the default and has no effect.
2. $\text{total}_c = \text{scaled}_c + \text{rem}_c$ (64-bit).
3. $\text{out}_c = \operatorname{trunc}(\text{total}_c / 65536)$ (toward zero), then clamped to `[-32767, +32767]`.
4. $\text{rem}_c = \text{total}_c - \text{out}_c \cdot 65536$, clamped to $\pm 32767 \cdot 65536$ (`±2147418112`). Without saturation $|\text{rem}_c| < 65536$; when the output clamps, the excess is **carried** in the remainder (it is not zeroed) and comes out in the next reports. Only excess beyond 32767 counts is dropped.

Example (test 06): gain `2.00x`, input `(20000, -20000)` gives `(32767, -32767)` and carries `7233` counts per axis; the next input `(1, -1)` gives `(7235, -7235)`.

---

## 7. Binary Profile Format (`28 Bytes`)

All multi-byte fields are **little-endian**.

```c
#define DDPI_PROFILE_MAGIC   0x4450u  /* "DP": bytes 0x50, 0x44 */
#define DDPI_PROFILE_VERSION 0x01u

typedef struct __attribute__((packed)) {
    uint16_t magic;                /* +0x00: 0x4450 */
    uint8_t  version;              /* +0x02: 0x01 */
    uint8_t  flags;                /* +0x03: DDPI_FLAG_* (§7.1) */
    uint16_t base_dpi;             /* +0x04: sensor CPI the profile was made for, 50..65535 */
    uint16_t global_gain_q8_8;     /* +0x06: Q8.8, 0x0010..0x0400 */
    uint16_t multipliers_q8_8[8];  /* +0x08..0x17: Q8.8, 0x0010..0x0400, order per flag bit 3 */
    uint16_t reserved;             /* +0x18: low byte = travel window L, high byte = idle timeout (§7.2) */
    uint16_t crc16;                /* +0x1A: CRC-16-CCITT (poly 0x1021, init 0xFFFF) over bytes 0x00..0x19 */
} ddpi_profile_v1_t;               /* 28 bytes: fits in one 64-byte HID Feature report */
```

`base_dpi` (`DDPI_DPI_MIN 50 .. DDPI_DPI_MAX 65535`) is not used by the transform; hosts and `ddpi_profile_normalize_cpi_headroom` use it.

### 7.1 Flags

| Bit | Name | JSON | Meaning |
| :---: | :--- | :--- | :--- |
| 0 | `DDPI_FLAG_ENABLED` | `enabled` | Apply the curve. Clear = identity. |
| 1 | `DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE` | `keepRemainderOnReverse` | Legacy, no effect: remainders are kept on reversal unless bit 5 is set. |
| 2 | `DDPI_FLAG_LINEAR_OCTANT_RATIO` | `linearOctantRatio` | $t = r$ instead of the circular correction (§4 Step 2). |
| 3 | `DDPI_FLAG_FRAME_SENSOR_CCW` | `frame: "odd-sensor-ccw"` | Multipliers stored CCW (`0=E, 1=NE, 2=N ... 7=SE`); HID-CW direction $k$ reads index $(8 - k) \bmod 8$ (§2). |
| 4 | `DDPI_FLAG_MODEL_LINEAR_2X2` | `model: "linear-2x2"` | Stateless 2×2 model from E/N/NE/NW (§6.3). |
| 5 | `DDPI_FLAG_RESET_REMAINDER_ON_REVERSE` | `resetRemainderOnReverse` | Clear an axis remainder when the raw delta opposes it (§6.4). |
| 6 | `DDPI_FLAG_BYPASS_FOR_CALIBRATION` | — | Transient 1.00x bypass while calibrating (HID `SET_ENABLED` mode 2). Never exported to JSON; hosts should not save a profile with it set. |
| 7 | — | — | Reserved, write 0. |

`ddpi_profile_set_ccw_frame()` converts a profile between the two orders in place (swapping index $i \leftrightarrow 8 - i$ for $i = 1..3$) and toggles bit 3.

### 7.2 `reserved` field
- **Low byte**: travel-window length $L$ in counts, `0..128` (`0` = per-report direction). Values above 128 act as 128 and are clamped when the engine loads the profile. The neutral default profile (`ddpi_profile_init_default`) has $L = 0$; adapters and the calibration pipeline use `DDPI_DEFAULT_WINDOW_COUNTS` = 16.
- **High byte**: idle timeout in 5 ms units (`1..255` = 5..1275 ms); `0` means `DDPI_DEFAULT_IDLE_MS` = 50 ms.

### 7.3 Validation
`ddpi_profile_deserialize` rejects a buffer unless magic is `0x4450`, version is `0x01`, the CRC matches, `base_dpi >= 50`, and the global gain and all 8 multipliers are in `0x0010..0x0400`. Flags and `reserved` are not checked. `ddpi_profile_sanitize_and_sign` (run when the engine loads a profile and when serializing) clamps `base_dpi`, the gains and the window byte into range, rewrites magic and version, and recomputes the CRC.

The neutral default profile: flags `0` (disabled), `base_dpi` as given (`0` -> 800), gain and multipliers `0x0100`, `reserved = 0`.

---

## 8. JSON Profile File (`open-directional-dpi-v1`)

Written by OpenMouse `exportProfileJson` and the calibration page, read by `importProfileJson` (`integrations/openmouse/src/directional-dpi.ts`).

| Field | Type / range | Profile field | Default when missing |
| :--- | :--- | :--- | :--- |
| `schema` | `"open-directional-dpi-v1"` | — | required |
| `version` | `1` | — | required |
| `enabled`, `keepRemainderOnReverse`, `linearOctantRatio`, `resetRemainderOnReverse` | boolean | flag bits 0, 1, 2, 5 | `false` |
| `frame` | `"hid-cw"` \| `"odd-sensor-ccw"` | flag bit 3 | `"hid-cw"` |
| `model` | `"angular-gain"` \| `"linear-2x2"` | flag bit 4 | `"angular-gain"` |
| `windowCounts` | integer `0..128` | `reserved` low byte | `0` |
| `idleResetMs` | integer `0..1275`, multiple of 5 (`0` = firmware default 50 ms) | `reserved` high byte × 5 | `0` |
| `baseDpi` | integer `50..65535` | `base_dpi` | required |
| `globalGain` | number `0.0625..4` (rounded to 1/256) | `global_gain_q8_8` | required |
| `directionalMultipliers` | object with `E_0, SE_45, S_90, SW_135, W_180, NW_225, N_270, NE_315`, each `0.0625..4` | `multipliers_q8_8` | required |

The `directionalMultipliers` keys always name physical HID directions (E right, S toward the user), in either frame; the importer places them according to `frame`. Unknown fields are ignored; invalid values are rejected with an error naming the field.

---

## 9. Conformance Vectors

`tests/vectors/scale_vectors.json` holds 2592 results of `ddpi_compute_scale_q16_16` (8 serialized profiles × 324 `(dx, dy)` pairs, with `scale_q16_16` and `octant`), generated from the C engine by `tests/gen_vectors.c` (`make -C tests vectors`). Any implementation must reproduce every entry; the OpenMouse TypeScript mirror is checked against all of them. The vectors cover §4 and §7 (frames, linear ratio, global gain, extremes, bypass); the estimator (§5) and remainders (§6.4) are covered by the C unit tests in `tests/test_directional_dpi.c`. The format is described in `tests/vectors/README.md`.
