# Open Directional Sensitivity (`open-directional-dpi`)

Per-direction mouse sensitivity: one static multiplier for each of 8 directions, blended around the circle and applied inside the mouse firmware (or a host filter). The gain depends only on the direction of motion, never on its speed. The repo holds the spec, a portable fixed-point C11 engine, a calibration pipeline that derives the 8 gains from aim-trainer flicks, and adapters for several firmwares.

Corsair's PureVector does the same kind of thing (a static sensitivity per direction), but only on Corsair mice, for one DPI stage, and with unpublished blend math. Here the math, the profile format and conformance vectors are open, and the engine runs on other mice.

---

## Supported Mice / Integration Routes

| Route | Mice | Code | Profile comes from |
| :--- | :--- | :--- | :--- |
| Stock-firmware binary patch | Glorious Series One Pro (Compx CM2856: nRF52840 + PAW3370), stock firmware `CM2856_Mouse_USB v1.00.00` | `adapters/glorious-cm2856/` | HID feature report (OpenMouse), saved to flash |
| Zephyr input filter | Any mouse or trackball on the Zephyr input subsystem; ZMK (including splits); Keychron ZGM once its source is released | `adapters/zephyr/`, `zephyr/module.yml` | Devicetree; HID feature report if the firmware routes it; Zephyr settings |
| QMK `pointing_device` | QMK pointing devices (PMW33xx, PAW3222, ADNS, Cirque, ...) | `adapters/qmk/` | `keymap.c` |
| Linux host filter | Any relative mouse on Linux (evdev -> uinput) | `adapters/linux-evdev/` | Command line |

Notes:
- Glorious patch: `make -C adapters/glorious-cm2856 check` only compiles and links the patch. The full build (`build_and_verify_patch.py`) also needs the user-supplied stock image in `adapters/stock/` (not in the repo) and `compx_hex_tool.py` from [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re), cloned next to this repo or pointed to with `COMPX_TOOLS=<path to platforms/compx-nrf52/tools>`. That repo also holds the Compx USB flasher and the reverse-engineering notes for this mouse.
  - Stock image: `compx_hex_tool.py decode --target mouse -o adapters/stock/CM2856_Mouse_USB_v1.00.00_20220810.bin <official CM2856_Mouse_USB_v1.00.00_20220810.hex>`. The official package is no longer downloadable from Glorious; its SHA-256 is in mouse-firmware-re.
  - Checked against the real stock image (2026-11-13): all four hook sites call the expected stock functions, and the 7 Unicorn emulation tests pass (`pip install unicorn`).
  - Flash: back up first with `compx_usb_flasher.py dump --out backup.hex`, then `compx_usb_flasher.py flash --firmware-hex adapters/build/CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex`. The USB backup cannot reach the pairing pages (0x88000+), and the bootloader's `Erase` extent is unknown.
  - Flashed on a retail mouse (2026-11-13) with the read-back-verified flasher from mouse-firmware-re: it boots, the version reply carries `DP01`, and `GET_CAPABILITIES` / `GET_PROFILE` answer. Not yet tested on hardware: motion with a non-identity profile, `SAVE_FLASH`, and the boot-chord recovery. This mouse has no idle reset of the direction estimator yet (no verified stock millisecond tick).
- Zephyr: setup, devicetree properties and the HID hook are in [`adapters/zephyr/README.md`](adapters/zephyr/README.md).
- Linux evdev: the virtual mouse copies the source's bus/VID/PID, name and input properties, so libinput quirks and per-device desktop settings still apply. udev cannot give it the source's hwdb entry (`MOUSE_DPI`, which libinput's adaptive speed divides by), except for Bluetooth mice; when the source has one, the filter prints the udev rule that restores it.
- QMK: without `MOUSE_EXTENDED_REPORT`, reports are 8-bit and gains above 1.00x lose counts; see [`adapters/qmk/README.md`](adapters/qmk/README.md).

---

## Repository Structure

```text
open-directional-dpi/
├── spec/
│   ├── directional-dpi-v1.md        # Transform, travel-window estimator, 28-byte profile, JSON file
│   └── hid-protocol-v1.md           # 64-byte USB HID Feature report configuration protocol
├── core/
│   ├── directional_dpi.h            # Zero-dependency C11 fixed-point API (Q8.8 / Q16.16)
│   └── directional_dpi.c            # Reference engine (8-octant circular + linear 2x2 + travel window)
├── tests/
│   ├── Makefile                     # `make test`, `make vectors`
│   ├── test_directional_dpi.c       # 16 C unit tests
│   ├── gen_vectors.c                # Writes the conformance vectors from the C engine
│   └── vectors/                     # scale_vectors.json (8 profiles x 324 deltas) + format README
├── calibration/
│   ├── core/
│   │   ├── trajectory-analysis/     # Primary ballistic submovement & velocity-minimum detector
│   │   ├── directional-error/       # 8-sector CCW error aggregation with MAD outlier rejection
│   │   └── profile-generation/      # Smoothed gains, CPI headroom & signed firmware profile
│   ├── providers/
│   │   ├── builtin/                 # calibrate.html (Pointer Lock calibration page) & scheduler
│   │   ├── aimfroge/                # AimFroge open aim-trainer telemetry adapter
│   │   ├── kovaaks/                 # KovaaK's directional flick CSV parser
│   │   └── aimlabs/                 # Aimlabs SpiderShot / Mouselabs export importer
│   └── tests/
│       └── calibration.test.ts      # Calibration pipeline & provider tests
├── adapters/
│   ├── glorious-cm2856/             # Stock-firmware patch (`stock_ddpi_patch.c/.ld`, `make check`)
│   ├── zephyr/                      # Zephyr / ZMK / Keychron ZGM input filter (`odd,directional-dpi`)
│   ├── qmk/                         # QMK `pointing_device` adapter (`pointing_device_task_odd`)
│   └── linux-evdev/                 # evdev -> uinput host filter for any mouse
├── integrations/
│   └── openmouse/
│       ├── src/directional-dpi.ts   # TypeScript codec, scale mirror, JSON import/export, WebHID client
│       ├── src/mock-hid.ts          # Mock Glorious device (stock and custom firmware) for tests
│       └── test/                    # C-vector parity, JSON and mock-HID tests
├── zephyr/
│   └── module.yml                   # Makes the repo root a Zephyr module (`open-directional-dpi`)
├── .github/workflows/
│   ├── ci.yml                       # C tests, vector check, adapter builds, ARM patch link, TypeScript
│   └── zephyr.yml                   # Zephyr native_sim tests (v4.5.0, v3.7.2) + ZMK nice_nano build
├── LICENSE                          # MIT License
└── CONTRIBUTING.md                  # Contribution guidelines
```

---

## Key Features

1. **Travel-window direction estimator:**
   - The direction used for the gain comes from the last stretch of travel, not from one report, so 1 kHz and 8 kHz reports of the same path get the same gain instead of snapping to single-count axes.
   - The window length $L$ (0..128 counts) is stored in the profile. The core's neutral default profile has $L = 0$ (per-report direction); the adapters and the calibration output use $L = 16$ ($\approx 0.5\text{ mm}$ at $800\text{ CPI}$).
   - Adapters with a clock (Zephyr, QMK, evdev) call `ddpi_process_motion()`, which restarts the estimator after an idle gap (profile setting, default 50 ms).
2. **Two transform models:**
   - **8-octant circular angular gain (`angular-gain`):** continuous interpolation between 8 compass multipliers, stored in HID order (`hid-cw`) or tabletop order (`odd-sensor-ccw`: $0^\circ = \text{Right}$, $90^\circ = \text{Away}$).
   - **Linear $2\times 2$ matrix (`linear-2x2`):** per-axis gain plus shear from the E/N/NE/NW multipliers, no direction state.
3. **CPI headroom normalization (`ddpi_profile_normalize_cpi_headroom`):**
   - Computes $\text{sensor\_cpi} = \operatorname{round}(\text{base\_cpi} \times \max G)$ and normalizes the multipliers to $\le 1.00\times$, so firmware only scales down and never emits 2-count steps.
4. **Browser calibration (`calibration/providers/builtin/calibrate.html`):**
   - Uses `requestPointerLock({ unadjustedMovement: true })` to measure primary-submovement overshoot/undershoot in 8 directions and exports an `open-directional-dpi-v1` JSON profile that OpenMouse `importProfileJson` accepts.
   - Calibrate with the curve off: the page sees motion after the mouse (or host filter) applied the active curve, and exports absolute gains, so a recalibration through an active curve undoes the previous one. HID mice: `bypassForCalibration()` in OpenMouse (exact 1.00x, end it with `setEnabled()`) or disable the curve. evdev: stop the filter. QMK / devicetree curves: flash a flat curve first.
5. **Conformance vectors (`tests/vectors/`):** 2592 scale/octant results from the C engine; the TypeScript mirror must match every one.

---

## Quick Start: Run All Checks

```bash
# C engine: 16 unit tests
make -C tests test

# Conformance vectors: regenerate from the engine; the diff must be empty
make -C tests vectors && git diff --exit-code -- tests/vectors

# TypeScript (Node >= 22.6): 17 OpenMouse suites incl. C-vector parity, then 4 calibration suites
node --experimental-strip-types --test integrations/openmouse/test/directional-dpi.test.ts
node --experimental-strip-types --test calibration/tests/calibration.test.ts

# Linux evdev filter: build and self-test (no root or /dev/uinput needed)
make -C adapters/linux-evdev check

# QMK adapter: standalone compile check (8-bit and extended reports)
gcc -std=c11 -Wall -Wextra -Werror -pedantic -c adapters/qmk/odd_pointing_device.c -o /dev/null
gcc -std=c11 -Wall -Wextra -Werror -pedantic -DMOUSE_EXTENDED_REPORT -c adapters/qmk/odd_pointing_device.c -o /dev/null

# Glorious stock patch: compile + link with arm-none-eabi-gcc (CROSS=/path/bin/arm-none-eabi- if not on PATH)
make -C adapters/glorious-cm2856 check

# Zephyr filter: native_sim ztests (needs a Zephyr workspace, see adapters/zephyr/README.md)
$ZEPHYR_BASE/scripts/twister -T adapters/zephyr/tests -p native_sim/native/64
```
