# Open Directional Sensitivity (`open-directional-dpi`)

An open-source, vendor-neutral specification, portable fixed-point C reference engine, biomechanical calibration suite, and firmware adapter collection for **direction-dependent mouse sensitivity** (Open Directional Sensitivity / Open Directional DPI v1).

---

## Repository Structure

```text
open-directional-dpi/
├── spec/
│   ├── directional-dpi-v1.md        # Mathematical transform, travel-window estimator, and profile standard
│   └── hid-protocol-v1.md           # 64-byte USB HID Feature report configuration protocol
├── core/
│   ├── directional_dpi.h            # Zero-dependency C11 fixed-point API (Q8.8 / Q16.16)
│   └── directional_dpi.c            # Reference implementation (8-octant circular + linear 2x2 + travel window)
├── tests/
│   ├── Makefile
│   └── test_directional_dpi.c       # 12 unit & golden vector suites (including 1 kHz vs 8 kHz chunking invariance)
├── calibration/
│   ├── core/
│   │   ├── trajectory-analysis/     # Primary ballistic submovement & velocity-minimum detector
│   │   ├── directional-error/       # 8-sector CCW error aggregation with MAD outlier rejection
│   │   └── profile-generation/      # Smoothed gain calculation, CPI headroom & firmware profile signing
│   ├── providers/
│   │   ├── builtin/                 # Built-in 8-direction Pointer Lock calibration tool & scheduler
│   │   ├── aimfroge/                # AimFroge open aim-trainer telemetry adapter
│   │   ├── kovaaks/                 # KovaaK's directional flick CSV parser
│   │   └── aimlabs/                 # Aimlabs SpiderShot / Mouselabs export importer
│   └── tests/
│       └── calibration.test.ts      # End-to-end calibration & provider test suite
├── adapters/
│   ├── zmk/                         # ZMK Firmware input processor module (`zmk,input-processor-directional-dpi`)
│   ├── qmk/                         # QMK Firmware `pointing_device` adapter (`pointing_device_task_odd`)
│   ├── zgm/                         # Keychron ZGM / Zephyr high-polling paired sensor frame filter
│   └── linux-evdev/                 # Linux `evdev`-to-`uinput` host prototype for testing on any mouse
├── integrations/
│   └── openmouse/
│       ├── index.html               # Standalone WebHID 8-octant polar sensitivity editor & live simulator
│       ├── calibrate.html           # 5-minute Pointer Lock biomechanical calibration tool
│       ├── src/directional-dpi.ts   # TypeScript codec, bit-exact engine mirror, and WebHID client
│       └── test/                    # Automated TypeScript parity and mock-HID test suites
├── hardware/
│   └── glorious-series-one-pro/     # Hardware port, reverse engineering, and surgical patch for Glorious Series One Pro
├── .github/workflows/
│   └── ci.yml                       # Automated C, Linux evdev, and TypeScript CI pipeline
├── LICENSE                          # MIT License
└── CONTRIBUTING.md                  # Contribution and hardware verification guidelines
```

---

## Key Features

1. **Polling-Rate Invariant Travel-Window Direction Estimator:**
   - Smooths the direction vector $\mathbf{d}_k$ over a configurable travel distance $L$ (default $L = 16$ sensor counts, $\approx 0.5\text{ mm}$ at $800\text{ CPI}$) with automatic idle-gap reset ($\ge 50\text{ ms}$) so slow micro-adjustments at $1\text{ kHz}$ and $8\text{ kHz}$ follow the same trajectory instead of snapping to $45^\circ$ single-count axes.
2. **Dual Coordinate & Transform Models:**
   - **8-Octant Circular Angular Gain (`angular-gain`):** Smooth periodic interpolation across 8 compass sectors in either HID coordinates (`CW`) or tabletop coordinates (`odd-sensor-ccw`: $0^\circ = \text{Right}$, $90^\circ = \text{Away/North}$).
   - **Stateless Linear $2\times 2$ Matrix (`linear-2x2`):** Symmetric per-axis sensitivity and off-diagonal shear ($M = \begin{bmatrix} m_{xx} & m_{xy} \\ m_{yx} & m_{yy} \end{bmatrix}$).
3. **CPI Headroom Normalization (`ddpi_profile_normalize_cpi_headroom`):**
   - Computes $\text{sensor\_cpi} = \operatorname{round}(\text{base\_cpi} \times \max G)$ and normalizes internal firmware multipliers to $\le 1.00\times$ so firmware only scales down and never emits 2-count step quantization.
4. **5-Minute Biomechanical Browser Calibration (`integrations/openmouse/calibrate.html`):**
   - Uses `requestPointerLock({ unadjustedMovement: true })` to measure primary-submovement overshoot/undershoot across 8 directions and automatically derives calibrated directional gains.

---

## Quick Start: Run All Tests

```bash
# 1. Build and run the 12 C Reference Engine unit & golden vector tests
make -C tests test

# 2. Build the Linux evdev-to-uinput host filter
make -C adapters/linux-evdev

# 3. Run the 6 OpenMouse TypeScript protocol & bit-exact parity test suites
node --experimental-strip-types --test integrations/openmouse/test/directional-dpi.test.ts
```
