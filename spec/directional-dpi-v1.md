# Open Directional DPI Specification — Version 1.0 (`directional-dpi-v1`)

## 1. Scope & Design Goals

**Open Directional DPI v1** defines a deterministic, vendor-neutral, fixed-point algorithm and binary profile format for direction-dependent mouse sensitivity processing inside embedded mouse firmware (ARM Cortex-M0+/M4/M33, RISC-V, AVR) and host configuration tools (such as **OpenMouse**).

### Core Objectives
1. **Pure Integer / Fixed-Point Execution**: Zero floating-point operations (`float`/`double`) or `<math.h>` dependencies required at runtime, guaranteeing deterministic sub-microsecond execution at `1,000 Hz`–`8,000 Hz` polling rates.
2. **Eight-Octant Control Points (`0°..315°`)**: Continuous 360-degree directional scaling across 8 evenly spaced compass directions (`45°` apart) with smooth circular angular interpolation.
3. **Configurable Global Scalar Gain**: Master multiplier (`global_gain_q8_8`) that scales or blends the directional curve intensity.
4. **Bit-Exact `1.00x` Neutral Identity**: When disabled (`enabled == 0`) or when all 8 directional multipliers and global gain equal `1.00x` (`0x0100` in Q8.8), output `(out_dx, out_dy)` is bit-for-bit identical to input `(dx, dy)` with zero latency or drift.
5. **Sub-Count Fractional Accumulation**: Tracks Q16.16 signed remainders `(rem_x, rem_y)` across ticks so slow diagonal or sub-pixel movements never suffer from quantization deadzones or stair-stepping.
6. **Overflow & Saturation Safety**: Full 64-bit intermediate fixed-point products with clamping to the standard USB HID 16-bit signed report range (`-32767 .. +32767`).

---

## 2. Coordinate Convention & Eight Control Points

Standard USB HID and PixArt optical sensors (`PAW3370`, `PAW3395`) report 2D relative motion in screen coordinates:
- `$+X$`: Right (`East`)
- `$-X$`: Left (`West`)
- `$+Y$`: Down (`South`, toward the user)
- `$-Y$`: Up (`North`, away from the user)

To match standard polar mathematics while remaining intuitive in UI editors, Open Directional DPI v1 defines the motion angle $\theta \in [0^\circ, 360^\circ)$ counter-clockwise from $+X$ (East) in the Cartesian plane where $+X = \text{Right}$ and $+Y_{\text{screen}} = \text{Down}$ (or equivalently indexable by screen octants):

| Index | Identifier | Angle $\theta$ | Vector Sign $(dx, dy)$ in USB HID | Physical Mouse Motion |
| :---: | :--- | :---: | :---: | :--- |
| `0` | `DDPI_DIR_E` | $0^\circ$ | $dx > 0,\; dy = 0$ | Right (East) |
| `1` | `DDPI_DIR_SE` | $45^\circ$ | $dx > 0,\; dy > 0,\; |dx| = |dy|$ | Down-Right (South-East) |
| `2` | `DDPI_DIR_S` | $90^\circ$ | $dx = 0,\; dy > 0$ | Down / Pull Back (South) |
| `3` | `DDPI_DIR_SW` | $135^\circ$ | $dx < 0,\; dy > 0,\; |dx| = |dy|$ | Down-Left (South-West) |
| `4` | `DDPI_DIR_W` | $180^\circ$ | $dx < 0,\; dy = 0$ | Left (West) |
| `5` | `DDPI_DIR_NW` | $225^\circ$ | $dx < 0,\; dy < 0,\; |dx| = |dy|$ | Up-Left (North-West) |
| `6` | `DDPI_DIR_N` | $270^\circ$ | $dx = 0,\; dy < 0$ | Up / Push Forward (North) |
| `7` | `DDPI_DIR_NE` | $315^\circ$ | $dx > 0,\; dy < 0,\; |dx| = |dy|$ | Up-Right (North-East) |

---

## 3. Fixed-Point Representation (`Q8.8` and `Q16.16`)

- **Control Point Multipliers (`multipliers_q8_8[8]`)**:
  - Unsigned 16-bit fixed-point (`uint16_t`) in **Q8.8** format (`1 LSB = 1/256 ≈ 0.00390625`).
  - Neutral `1.00x` = `0x0100` (`256`).
  - Valid clamped range: `0x0010` (`0.0625x`, minimum non-zero sensitivity) to `0x0400` (`4.0000x`, maximum boost).
- **Global Gain (`global_gain_q8_8`)**:
  - Unsigned 16-bit fixed-point (`uint16_t`) in **Q8.8** format.
  - Neutral `1.00x` = `0x0100` (`256`).
  - Valid clamped range: `0x0010` (`0.0625x`) to `0x0400` (`4.0000x`).
- **Internal Scale & Remainder Accumulators**:
  - Signed 32-bit fixed-point (`int32_t`) in **Q16.16** format (`1.0 = 65536 = 0x00010000`).

---

## 4. Circular 360-Degree Octant Interpolation Algorithm

Given a non-zero signed sensor delta pair $(dx, dy) \in [-32768, 32767]^2$:

### Step 1 — Octant Classification (`0..7`)
Let $ax = |dx|$ and $ay = |dy|$ (promoted to `uint32_t` so `-32768` never overflows).
The 2D plane is partitioned into 8 sectors of $45^\circ$ each bounded by a cardinal axis ($k_{\text{card}} \in \{0, 2, 4, 6\}$) and its adjacent diagonal axis ($k_{\text{diag}} \in \{1, 3, 5, 7\}$):

| Quadrant Signs | Condition | Cardinal Control Point $M_{\text{card}}$ | Diagonal Control Point $M_{\text{diag}}$ | Major / Minor Axis $(u, v)$ |
| :--- | :--- | :--- | :--- | :--- |
| $dx \ge 0,\; dy \ge 0$ | $ax \ge ay$ | `M[0]` ($0^\circ$ E) | `M[1]` ($45^\circ$ SE) | $u = ax,\; v = ay$ |
| $dx \ge 0,\; dy \ge 0$ | $ay > ax$ | `M[2]` ($90^\circ$ S) | `M[1]` ($45^\circ$ SE) | $u = ay,\; v = ax$ |
| $dx < 0,\; dy \ge 0$ | $ay \ge ax$ | `M[2]` ($90^\circ$ S) | `M[3]` ($135^\circ$ SW) | $u = ay,\; v = ax$ |
| $dx < 0,\; dy \ge 0$ | $ax > ay$ | `M[4]` ($180^\circ$ W) | `M[3]` ($135^\circ$ SW) | $u = ax,\; v = ay$ |
| $dx < 0,\; dy < 0$ | $ax \ge ay$ | `M[4]` ($180^\circ$ W) | `M[5]` ($225^\circ$ NW) | $u = ax,\; v = ay$ |
| $dx < 0,\; dy < 0$ | $ay > ax$ | `M[6]` ($270^\circ$ N) | `M[5]` ($225^\circ$ NW) | $u = ay,\; v = ax$ |
| $dx \ge 0,\; dy < 0$ | $ay \ge ax$ | `M[6]` ($270^\circ$ N) | `M[7]` ($315^\circ$ NE) | $u = ay,\; v = ax$ |
| $dx \ge 0,\; dy < 0$ | $ax > ay$ | `M[0]` ($0^\circ$ E) | `M[7]` ($315^\circ$ NE) | $u = ax,\; v = ay$ |

Here $u = \max(|dx|, |dy|) > 0$ and $v = \min(|dx|, |dy|) \in [0, u]$.

### Step 2 — Continuous Angular Fraction $t \in [0, 65536]$ within the $45^\circ$ Octant
Using a fast, monotonic rational polynomial approximation of $\frac{4}{\pi}\arctan(v/u)$ (or exact linear-tangent ratio $t = \lfloor (v \ll 16) / u \rfloor$), notice:
- At the cardinal axis ($v = 0$): $t = 0$.
- At the $45^\circ$ diagonal ($v = u$): $t = 65536$ (`1.0` in Q16.16).
- Both neighbor octants sharing a cardinal axis ($v = 0$) evaluate to $M_{\text{card}}$, and both neighbor octants sharing a diagonal axis ($v = u$) evaluate to $M_{\text{diag}}$.
- Therefore, the interpolated directional multiplier $M(\theta)$ is **strictly continuous ($C^0$) around the entire $360^\circ$ circle**, with no boundary jumps at any octant transition!

To match true circular angle $\theta = \arctan(v/u) / (\pi/4)$ to within `< 0.08°` across $[0^\circ, 45^\circ]$ using pure integer arithmetic:
Let $r = \lfloor (v \ll 16) / u \rfloor \in [0, 65536]$.
Since $\frac{4}{\pi}\arctan(x) \approx x + 0.2732395 x (1 - x)$, in Q16.16 (`0.2732395 * 65536 = 17907`):
$$t = r + \left\lfloor \frac{17907 \cdot r \cdot (65536 - r)}{2^{32}} \right\rfloor \in [0, 65536]$$
- At $r = 0$: $t = 0$.
- At $r = 65536$: $t = 65536$.
- Monotonically increasing on $[0, 65536]$ and computed in 3 integer instructions with zero lookup tables!

### Step 3 — Interpolated Multiplier & Global Scalar Gain (Q16.16)
1. Convert $M_{\text{card}}$ and $M_{\text{diag}}$ from Q8.8 to Q16.16:
   $$M_{\text{card},16} = M_{\text{card}} \ll 8, \qquad M_{\text{diag},16} = M_{\text{diag}} \ll 8$$
2. Linearly interpolate in Q16.16:
   $$M_{\text{dir},16} = M_{\text{card},16} + \left((M_{\text{diag},16} - M_{\text{card},16}) \cdot t \gg 16\right)$$
3. Apply the scalar directional gain (`global_gain_q8_8`):
   $$S_{16} = \left(M_{\text{dir},16} \cdot \text{global\_gain\_q8\_8}\right) \gg 8$$

---

## 5. Sub-Pixel Remainder Accumulation & Signed Saturation

### 5.1 Remainder Sign-Change Policy
To prevent "phantom drift" when reversing mouse direction, if `dx` changes sign (`(dx > 0 && rem_x < 0) || (dx < 0 && rem_x > 0)`), `rem_x` is cleared to `0` before accumulating (or preserved if `DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE` is set). The same rule applies to `dy` and `rem_y`.

### 5.2 Scaling & Truncation Toward Zero
For each axis ($c \in \{x, y\}$):
1. Compute 64-bit Q16.16 total:
   $$\text{total}_c = (\text{int64\_t})\,d_c \cdot S_{16} + \text{rem}_c$$
2. Extract integer output count via truncation toward zero (`total_c / 65536`):
   $$\text{out\_raw}_c = \text{total}_c / 65536$$
3. Store exact fractional remainder in `[-65535, +65535]`:
   $$\text{rem}_c = \text{total}_c - (\text{out\_raw}_c \cdot 65536)$$
4. Clamp $\text{out\_raw}_c$ to `[-32767, +32767]` (`int16_t` symmetric USB HID bounds; if clamped, `rem_c` is zeroed to prevent windup).

---

## 6. Versioned On-Wire & On-Flash Binary Profile Format (`28 Bytes`)

All multi-byte fields are **little-endian**.

```c
#define DDPI_PROFILE_MAGIC   0x4450u  /* "DP" in little-endian (0x50, 0x44) */
#define DDPI_PROFILE_VERSION 0x01u

typedef struct __attribute__((packed)) {
    uint16_t magic;                /* +0x00: 0x4450 ("DP") */
    uint8_t  version;              /* +0x02: 0x01 (Open Directional DPI v1) */
    uint8_t  flags;                /* +0x03: bit 0 = enabled, bit 1 = keep_rem_on_reverse, bit 2 = linear_octant */
    uint16_t base_dpi;             /* +0x04: Nominal sensor CPI/DPI (e.g., 800, 1600) */
    uint16_t global_gain_q8_8;     /* +0x06: Master scalar gain in Q8.8 (0x0100 = 1.00x) */
    uint16_t multipliers_q8_8[8];  /* +0x08..0x17: 8 octant multipliers in Q8.8 (E, SE, S, SW, W, NW, N, NE) */
    uint16_t reserved;             /* +0x18: 0x0000 (reserved for v1 alignment) */
    uint16_t crc16;                /* +0x1A: CRC-16-CCITT (poly 0x1021, init 0xFFFF) over bytes [0x00..0x19] */
} ddpi_profile_v1_t;               /* Total size: 28 bytes (fits inside a single 64-byte HID Feature report!) */
```
