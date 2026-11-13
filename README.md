# Open Directional Sensitivity (`open-directional-dpi`)

Per-direction mouse sensitivity: one static multiplier for each of 8 directions, blended around the circle and applied inside the mouse firmware (or a host filter). The gain depends only on the direction of motion, never on its speed. The repo holds the spec, a portable fixed-point C11 engine, a calibration pipeline that derives the 8 gains from aim-trainer flicks, and adapters for several firmwares.

Corsair's PureVector does the same kind of thing (a static sensitivity per direction), but only on Corsair mice, for one DPI stage, and with unpublished blend math. Here the math, the profile format and conformance vectors are open, and the engine runs on other mice.

---

## Supported Mice / Integration Routes

| Route | Mice | Code | Profile comes from |
| :--- | :--- | :--- | :--- |
| Stock-firmware binary patch | Glorious Series One Pro (Compx CM2856: nRF52840 + PAW3370), stock firmware `CM2856_Mouse_USB v1.00.00` | [`adapters/glorious-cm2856/`](adapters/glorious-cm2856/README.md) | HID feature report over the cable or the 2.4 GHz receiver: `tools/odd_profile.py` (Linux; Windows and macOS through hidapi, untested) or **Send to mouse** in `calibrate.html` (WebHID); saved to flash |
| Zephyr input filter | Any mouse or trackball on the Zephyr input subsystem; ZMK (including splits); Keychron ZGM once its source is released | [`adapters/zephyr/`](adapters/zephyr/README.md), `zephyr/module.yml` | Devicetree (`calibration/cli.ts ... --format dts`); HID feature report if the firmware routes it; Zephyr settings |
| QMK `pointing_device` | QMK pointing devices (PMW33xx, PAW3222, ADNS, Cirque, ...) | [`adapters/qmk/`](adapters/qmk/README.md) | `keymap.c` (`calibration/cli.ts ... --format qmk`); with raw HID (`RAW_ENABLE`, or VIA / Vial, which keep working) the HID protocol in 32-byte frames: `tools/odd_profile.py` (tested against fakes only) or the WebHID client in `integrations/openmouse`, not `calibrate.html` yet; saved to EEPROM with `EECONFIG_USER_DATA_SIZE` |
| Linux host filter | Any relative mouse on Linux (evdev -> uinput) | [`adapters/linux-evdev/`](adapters/linux-evdev/) | Command line (`calibration/cli.ts ... --format evdev` prints the arguments; [how to run it](calibration/README.md#5-load-it-onto-the-mouse)) |

- **Glorious Series One Pro:** [`adapters/glorious-cm2856/README.md`](adapters/glorious-cm2856/README.md) covers the stock image, build, flash and rollback, loading profiles by cable or through the 2.4 GHz receiver, [Windows and macOS (untested)](adapters/glorious-cm2856/README.md#windows-and-macos-untested), recovery, and what has run on hardware. Never publish or commit the built `.hex` / `.bin` or any other vendor image; only `OpenDDPIv1-patch.json` may go on a release. Porting the patch to another stock firmware: [`docs/porting-checklist.md`](docs/porting-checklist.md).
- **Zephyr / ZMK:** setup, devicetree properties and the HID hook are in [`adapters/zephyr/README.md`](adapters/zephyr/README.md).
- **QMK:** without `MOUSE_EXTENDED_REPORT`, reports are 8-bit and gains above 1.00x lose counts. The raw HID route (spec §6) is inferred from the QMK 0.34.8 and vial-qmk sources and tested against a mock board; not yet built in QMK or run on a device (2026-11-13). See [`adapters/qmk/README.md`](adapters/qmk/README.md).
- **Linux evdev:** the virtual mouse copies the source's bus/VID/PID, name and input properties, so libinput quirks and per-device desktop settings still apply. udev cannot give it the source's hwdb entry (`MOUSE_DPI`, which libinput's adaptive speed divides by), except for Bluetooth mice; when the source has one, the filter prints the udev rule that restores it.

---

## Calibrate

[`web/calibrate.html`](web/calibrate.html) is hosted at <https://0zlloen.github.io/open-directional-dpi/> (`.github/workflows/pages.yml` publishes it from `main`). It uses `requestPointerLock({ unadjustedMovement: true })` to measure primary-submovement overshoot/undershoot in 8 directions and exports an `open-directional-dpi-v1` JSON profile that `tools/odd_profile.py load` accepts. In Chrome or Edge, **Send to mouse** puts the result on a patched Glorious or an `[OpenDDPIv1]` device over WebHID (not yet tried on hardware).

To use your own copy, serve the folder (`python3 -m http.server` in `web`, then `http://localhost:8000/calibrate.html`): WebHID needs https or localhost, and Connect may not work from a `file://` page.

Three providers make the profile; [`calibration/README.md`](calibration/README.md) has the steps. No aim trainer exports the trajectory of each flick, so `mouse-log` and `kovaaks` read a raw mouse log instead ([What the trainers export](calibration/README.md#what-the-trainers-export)):

| Provider | Use with |
| :--- | :--- |
| `mouse-log` (also `aimlabs`) | Aimlabs SpiderShot, or any task with static targets and one click per target: `calibration/cli.ts` reads a raw mouse log recorded while you play |
| `kovaaks` | KovaaK's static clicking scenarios: the mouse log plus the run's `Stats.csv` |
| `builtin` | The page above, nothing to install (not a `cli.ts` provider) |

`mouse-log` and `kovaaks` have not been run on a real Aimlabs or KovaaK's session yet (2026-11-13); the tests use made-up logs.

`cli.ts format profile.json --format evdev|qmk|dts` turns a profile JSON into the evdev filter's arguments, `keymap.c` lines or devicetree properties.

Calibrate with the curve off: the page sees motion after the mouse (or host filter) applied the active curve, and exports absolute gains, so a recalibration through an active curve undoes the previous one. How to turn it off on each route: [step 1 of the calibration guide](calibration/README.md#1-turn-the-current-curve-off).

---

## Key Features

1. **Travel-window direction estimator:**
   - The direction used for the gain comes from the last stretch of travel, not from one report, so 1 kHz and 8 kHz reports of the same path get the same gain instead of snapping to single-count axes.
   - The window length $L$ (0..128 counts) is stored in the profile. The core's neutral default profile has $L = 0$ (per-report direction); the adapters and the calibration output use $L = 16$ ($\approx 0.5\text{ mm}$ at $800\text{ CPI}$).
   - Adapters with a clock call `ddpi_process_motion()`, which restarts the estimator after an idle gap (profile setting, default 50 ms): Zephyr, QMK, evdev and the Glorious patch (see its [idle-reset clock](adapters/glorious-cm2856/README.md#idle-reset-clock)).
2. **Two transform models:**
   - **8-octant circular angular gain (`angular-gain`):** continuous interpolation between 8 compass multipliers, stored in HID order (`hid-cw`) or tabletop order (`odd-sensor-ccw`: $0^\circ = \text{Right}$, $90^\circ = \text{Away}$).
   - **Linear $2\times 2$ matrix (`linear-2x2`):** per-axis gain plus shear from the E/N/NE/NW multipliers, no direction state.
3. **CPI headroom normalization (`ddpi_profile_normalize_cpi_headroom`):**
   - Computes $\text{sensor\_cpi} = \operatorname{round}(\text{base\_cpi} \times \max G)$ and normalizes the multipliers to $\le 1.00\times$, so firmware only scales down and never emits 2-count steps.
4. **Conformance vectors (`tests/vectors/`):** 2592 scale/octant results from the C engine; the TypeScript mirror must match every one.
5. **Single DPI stage (like Corsair PureVector):** a profile with `onlyAtBaseDpi` (flag bit 7) applies only while the sensor runs at its `baseDpi`; every other DPI stage passes through unchanged. It needs firmware that reports the current DPI: the Glorious patch (records the DPI the stock firmware writes to the sensor, so a held DPI-shift key turns the curve off; emulation only, builds after `56afbb4`; see [DPI tracking](adapters/glorious-cm2856/README.md#dpi-tracking-and-dpi-shift)) and QMK (`pointing_device_get_cpi()`). Elsewhere the flag has no effect and the curve applies at every DPI. In `calibrate.html`, tick "Only at this DPI" and enter that stage's DPI as the base CPI.

---

## Quick Start: Run All Checks

```bash
# C engine: 17 unit tests
make -C tests test

# Conformance vectors: regenerate from the engine; the diff must be empty
make -C tests vectors && git diff --exit-code -- tests/vectors

# TypeScript (Node >= 22.6): 21 OpenMouse suites incl. C-vector and odd_profile.py parity, the 2.4 GHz receiver and QMK raw HID, then the calibration, CLI and calibrate.html WebHID tests
node --experimental-strip-types --test integrations/openmouse/test/directional-dpi.test.ts
node --experimental-strip-types --test calibration/tests/*.test.ts

# TypeScript type-check (strict, upstream mouse-protocol options)
npm ci && npx tsc -p tsconfig.json

# odd_profile.py device layer against a fake cable, receiver, QMK boards and hidapi (no hardware)
python3 tools/test_odd_profile.py

# Glorious patch file and apply_patch.py on a synthetic image (no vendor bytes, no toolchain)
python3 adapters/glorious-cm2856/test_apply_patch.py

# Linux evdev filter: build and self-test (no root or /dev/uinput needed)
make -C adapters/linux-evdev check

# QMK adapter: compile with its stand-in types (8-bit and extended reports, raw HID), then the raw HID transport test
make -C adapters/qmk check

# Glorious stock patch: compile + link with arm-none-eabi-gcc (CROSS=/path/bin/arm-none-eabi- if not on PATH)
make -C adapters/glorious-cm2856 check

# Glorious stock patch: full build + 11 Unicorn tests (needs your stock image and unicorn; not in CI)
python3 adapters/glorious-cm2856/build_and_verify_patch.py

# Zephyr filter: native_sim ztests (needs a Zephyr workspace, see adapters/zephyr/README.md)
$ZEPHYR_BASE/scripts/twister -T adapters/zephyr/tests -p native_sim/native/64
```

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
├── tests/                           # Core engine tests only (adapter tests live with each adapter)
│   ├── Makefile                     # `make test` (the 17 unit tests), `make vectors`
│   ├── test_directional_dpi.c       # 17 C unit tests
│   ├── gen_vectors.c                # Writes the conformance vectors from the C engine
│   └── vectors/                     # scale_vectors.json (8 profiles x 324 deltas) + format README
├── calibration/
│   ├── core/
│   │   ├── trajectory-analysis/     # Primary ballistic submovement & velocity-minimum detector
│   │   ├── directional-error/       # 8-sector CCW error aggregation with MAD outlier rejection
│   │   └── profile-generation/      # Smoothed gains, CPI headroom & signed firmware profile
│   ├── providers/
│   │   ├── builtin/                 # TypeScript schedule generator and log ingestion, used by the calibration tests; web/calibrate.html does not import it
│   │   ├── mouse-log/               # Raw mouse log (MouseTester CSV) -> click-to-click flicks; Linux evdev logger; `aimlabs` in cli.ts
│   │   └── kovaaks/                 # Mouse log filtered by KovaaK's Stats.csv kills
│   ├── cli.ts                       # Provider -> profile JSON; `format` converts one for evdev / QMK / devicetree
│   ├── README.md                    # How to calibrate from Aimlabs / KovaaK's; what the trainers export
│   └── tests/                       # Pipeline, provider, CLI format and calibrate.html WebHID tests, fixtures
├── web/
│   └── calibrate.html               # Pointer Lock calibration page, WebHID Send to mouse (GitHub Pages)
├── adapters/
│   ├── glorious-cm2856/             # Stock-firmware patch for the Glorious Series One Pro
│   │   └── README.md                # Stock image, build, flash, profiles, 2.4 GHz, Windows/macOS, recovery, hardware results
│   ├── zephyr/                      # Zephyr / ZMK / Keychron ZGM input filter (`odd,directional-dpi`), README.md
│   ├── qmk/                         # QMK `pointing_device` adapter (`pointing_device_task_odd`), raw HID hook (`odd_raw_hid.c`), README.md
│   │   ├── Makefile                 # `make check`: compile with stand-in types, then the raw HID test
│   │   └── tests/                   # test_qmk_raw_hid.c: raw HID framing, probe answer, SAVE_FLASH on the host
│   └── linux-evdev/                 # evdev -> uinput host filter for any mouse
├── integrations/
│   └── openmouse/
│       ├── src/directional-dpi.ts   # TypeScript codec, scale mirror, JSON import/export, WebHID client
│       ├── src/mock-hid.ts          # Mock Glorious mouse (stock and patched firmware), 2.4 GHz receiver and QMK raw HID board for tests
│       └── test/                    # C-vector parity, JSON and mock-HID tests
├── tools/
│   ├── odd_profile.py               # Load / save / export profiles (Linux hidraw stdlib; hidapi on Windows/macOS; QMK raw HID)
│   └── test_odd_profile.py          # Its device layer against a fake cable, receiver, QMK boards and hidapi (no hardware)
├── docs/
│   └── porting-checklist.md         # What a port of the patch to another stock firmware needs
├── zephyr/
│   └── module.yml                   # Makes the repo a Zephyr module (`open-directional-dpi`); Zephyr looks for it at the module root, the code is in adapters/zephyr
├── .github/workflows/
│   ├── ci.yml                       # Vendor-binary guard, C tests, vector check, adapter builds and tests, ARM patch link, TypeScript tests and type-check, odd_profile.py and patch-file tests
│   ├── pages.yml                    # Publishes web/calibrate.html to GitHub Pages
│   └── zephyr.yml                   # Zephyr native_sim tests (v4.5.0, v3.7.2) + ZMK nice_nano build
├── package.json, tsconfig.json      # TypeScript type-check (`npm ci && npx tsc -p tsconfig.json`)
├── LICENSE                          # MIT License
└── CONTRIBUTING.md                  # Contribution guidelines
```

---

## License and contributing

MIT, see [`LICENSE`](LICENSE). Before a pull request, read [`CONTRIBUTING.md`](CONTRIBUTING.md): no vendor binaries, the fixed-point core rules, and the checks to run.
