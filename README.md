# Open Directional Sensitivity (`open-directional-dpi`)

Per-direction mouse sensitivity: one static multiplier for each of 8 directions, blended around the circle and applied inside the mouse firmware (or a host filter). The gain depends only on the direction of motion, never on its speed. The repo holds the spec, a portable fixed-point C11 engine, a calibration pipeline that derives the 8 gains from aim-trainer flicks, and adapters for several firmwares.

Corsair's PureVector does the same kind of thing (a static sensitivity per direction), but only on Corsair mice, for one DPI stage, and with unpublished blend math. Here the math, the profile format and conformance vectors are open, and the engine runs on other mice.

---

## Supported Mice / Integration Routes

| Route | Mice | Code | Profile comes from |
| :--- | :--- | :--- | :--- |
| Stock-firmware binary patch | Glorious Series One Pro (Compx CM2856: nRF52840 + PAW3370), stock firmware `CM2856_Mouse_USB v1.00.00` | `adapters/glorious-cm2856/` | HID feature report over the cable or the 2.4 GHz receiver: `tools/odd_profile.py` (Linux; Windows and macOS through hidapi, untested) or **Send to mouse** in `calibrate.html` (WebHID); saved to flash |
| Zephyr input filter | Any mouse or trackball on the Zephyr input subsystem; ZMK (including splits); Keychron ZGM once its source is released | `adapters/zephyr/`, `zephyr/module.yml` | Devicetree (`calibration/cli.ts ... --format dts`); HID feature report if the firmware routes it; Zephyr settings |
| QMK `pointing_device` | QMK pointing devices (PMW33xx, PAW3222, ADNS, Cirque, ...) | `adapters/qmk/` | `keymap.c` (`calibration/cli.ts ... --format qmk`); with raw HID (`RAW_ENABLE`, or VIA / Vial, which keep working) the HID protocol in 32-byte frames: the WebHID client in `integrations/openmouse`; saved to EEPROM with `EECONFIG_USER_DATA_SIZE` |
| Linux host filter | Any relative mouse on Linux (evdev -> uinput) | `adapters/linux-evdev/` | Command line (`calibration/cli.ts ... --format evdev` prints the arguments) |

Notes:
- Glorious patch: the Compx USB flasher, `compx_hex_tool.py` and the reverse-engineering notes for this mouse are in [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re) (clone it next to this repo, or point `COMPX_TOOLS` at its `platforms/compx-nrf52/tools`). Porting the patch to another stock firmware: [`docs/porting-checklist.md`](docs/porting-checklist.md).
  - Never publish or commit the built `.hex` / `.bin`, or any other vendor image (repo, release, issue or discussion): it contains Glorious's firmware. Everyone builds it from their own stock image. The one build output that may go on a release is `adapters/build/OpenDDPIv1-patch.json`: it holds only the bytes this project wrote (hook instructions and patch code; the build asserts that every other byte equals the stock image), and `apply_patch.py` turns it plus your own stock image into the flashable `.hex` (see [Windows and macOS](#windows-and-macos-untested)).
  - Stock image: `compx_hex_tool.py decode --target mouse -o adapters/stock/CM2856_Mouse_USB_v1.00.00_20220810.bin <official CM2856_Mouse_USB_v1.00.00_20220810.hex>`. The official package is no longer downloadable from Glorious; its SHA-256 is in mouse-firmware-re (`devices/glorious-series-one-pro/device.yaml`). No package? On a mouse still on stock v1.0.0.0: `compx_usb_flasher.py dump --out mine.hex`, then `python3 adapters/glorious-cm2856/build_and_verify_patch.py --stock-hex mine.hex` (the official `.hex` works the same way). The build refuses any stock image whose decoded SHA-256 is not `e50510e0eb213e69d62a088d6f5b792fb88b0f3dc56d3c9c21dd0ca8b6e892be`.
  - Build: `make -C adapters/glorious-cm2856 check` only compiles and links the patch. `python3 adapters/glorious-cm2856/build_and_verify_patch.py` writes the flashable `adapters/build/CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex` and the patch file `OpenDDPIv1-patch.json`. It needs the stock image, `compx_hex_tool.py`, `arm-none-eabi-gcc` (or `CROSS=<prefix>`, as for make) and unicorn (`pip install unicorn`), and exits non-zero if any of them is missing. Checked against the real stock image (2026-11-13): all four hook sites and both 2.4 GHz length reads match the expected stock code, and the 10 Unicorn emulation tests pass, including the 2.4 GHz relay, the 64-byte reply cap, a second identical `SAVE_FLASH` that skips the page erase, and the idle reset of the direction estimator after 50 sensor-read ticks.
  - Flash (verified on Linux with hidraw; Windows and macOS: see [below](#windows-and-macos-untested)): back up first with `compx_usb_flasher.py dump --out backup.hex`, then `compx_usb_flasher.py flash --firmware-hex adapters/build/CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex`. The backup covers `0x6000..0x4D7FF` only (the bootloader refuses reads from `0x4D800` up), so it holds neither the saved profile (`0x7E000`) nor the pairing pages (`0x88000`+). `Erase` clears `0x1E000` up to at least `0x4D7FF`, keeps `0x6000..0x1DFFF` and does not reach `0x7E000` (verified 2026-11-13); whether it reaches `0x88000`+ is unknown. The patch's linker region ends at `0x1E000`, so the whole image stays in the range `Erase` keeps.
  - Profiles: `python3 tools/odd_profile.py load profile.json --save` (the JSON from `calibrate.html` or `calibration/cli.ts`), `info` shows the current DPI and profile, `export` and `reset` do what they say. It needs access to the mouse's hidraw node: install mouse-firmware-re `devices/glorious-series-one-pro/udev/70-glorious-series-one-pro.rules` (cable, receiver and bootloader), or run it as root. `--device /dev/hidrawN` only picks among supported nodes; any other node is refused. It works over the cable and through the 2.4 GHz receiver (`258a:2031`, verified 2026-11-13: info, load, save, export, reset; the receiver's own queries still answer normally afterwards). A profile saved through the receiver survived switching the mouse off and on (2026-11-13, build `21ea252`). The receiver path needs a patch build with the 2.4 GHz relay (commit `505404c` / PR #6 or later); older builds get "no DP01 stamp through the receiver" from `odd_profile.py`.
  - Windows and macOS: `apply_patch.py`, the flasher and `odd_profile.py` through hidapi ([below](#windows-and-macos-untested)), or **Send to mouse** in `calibrate.html` (WebHID, Chrome or Edge), which sends the profile calibrated in that page, by cable or through the receiver with the same envelope; **Save on mouse** keeps it. None of these has been tried on Windows or macOS yet (2026-11-13). The OpenMouse app does not include the client in `integrations/openmouse` yet.
  - `odd_profile.py` backends: `hidraw` (Linux default, standard library) and `hidapi` (Windows and macOS default; `pip install hidapi`). On Linux, `--backend hidapi` loads cython-hidapi's `hidraw` module, never its libusb `hid` module, which detaches the kernel driver from the interface while it is open. With hidapi it picks the collection with usage page `0xFFFF`, usage `0` (interface 2, the node the hidraw backend picks; interface 1 also has vendor collections, which Windows lists as devices of their own). Feature reports go out as 65 bytes (report ID `0` + 64) and the report-ID byte hidapi puts first in replies is dropped; Windows needs exactly these full-length buffers. Only checked against fakes (`tools/test_odd_profile.py`, 2026-11-13).
  - `odd_profile.py` also speaks the QMK raw HID transport of `spec/hid-protocol-v1.md` §6 (32-byte frames on usage page `0xFF60`, usage `0x61`), on both backends. It probes a QMK interface with `GET_CAPABILITIES` only when no mouse is found or `--device` names it, and sends nothing else unless the answer carries `DP01`; a VIA or Vial board without the adapter answers `0xFF` to the first frame and the probe stops. A raw HID interface that does not open (no access, or held by another program) is skipped and named in the "No supported device found" message, unless `--device` names it. Close the VIA and Vial apps first. Only checked against fakes (2026-11-13); no board has run it.
  - Verified on a retail mouse (2026-11-13), flashed with the read-back-verified flasher from mouse-firmware-re: it boots, the version reply carries `DP01`, and `GET_CAPABILITIES` / `GET_PROFILE` answer. With a RAM-only profile (up at 0.50x, window 0), up-and-down hand motion went from an up/down count ratio of 0.913 to 0.618 on the cable. Through the 2.4 GHz receiver the curve applies the same way: 0.938 flat vs 0.570 with up at 0.50x. `SIMULATE_DELTA` with the sensor idle matched the C engine bit for bit. `SAVE_FLASH` writes the profile to `0x7E000`: it survived a reboot and two full USB flashes (stock image restored, then the patch flashed again). Rolling back with the official `.hex` was verified the same way. Polling with the patch: 1000 Hz on the cable, about 963 Hz through the receiver while moving. Browser polling testers (OpenMouse showed 565 Hz) count coalesced `pointermove` events, not USB reports.
  - Hardware-verified build: commit `21ea252` (branch `fix/audit-followups`, after PR #7 was merged), decoded image SHA-256 `34d827d537816fff3e5595bbe4c7b736e6af428a724f4732307385911f422c34`, 96,992 B, `0x6000..0x1DADF`, flashed and read back with the mouse-firmware-re flasher (2026-11-13). It adds the unchanged-save compare, the idle reset and the clock in `GET_CAPABILITIES` to `505404c`, the first build with the 2.4 GHz relay (SHA-256 `0ed3cb4b74d0ab5192f3708c40b25be52912c91876b973d0d8d3b821c17b794a`, 96,864 B, `0x6000..0x1DA5F`; a rebuild with Zephyr SDK 0.16.9 (gcc 12.2.0) gave the same code). Verified on `21ea252` through the receiver (2026-11-13): the curve applies (up/down ratio 0.681 with up at 0.50x, against 0.938 flat in the earlier test), and a second identical `SAVE_FLASH` answers in 24 ms instead of 402 ms (no page erase, no `0xA4`).
  - Idle reset: the patch resets the direction estimator after the profile's idle gap (default 50 ms), counting stock sensor-read calls as milliseconds (one per 1 ms TIMER1 tick while the mouse is still, from the stock disassembly). Verified on the cable (2026-11-13, `21ea252`): with the mouse still, the clock in `GET_CAPABILITIES` bytes `20..23`, read once a second for 12 s, ran at 1000.0 ticks/s. The reset itself is checked in Unicorn (test 10). Over 2.4 GHz the rate cannot be read: while the mouse sends no reports the receiver answers `0xA4`, so host commands do not reach it. Inferred to be the same (same TIMER1 tick). `505404c` has no idle reset.
  - Recovery, verified on the cable (2026-11-13, `21ea252`): DDPI `ENTER_BOOTLOADER` with the magic `"BLRS"` (`0x424C5253`) gives the bootloader `258a:2103` after 1.0 s; without it the patch answers `0xA4` (range error) and stays in the application. Holding LMB + RMB + DPI while the mouse powers up on the cable also gives `258a:2103` "Glorious bootloader", which confirms that the three pins the patch samples (P1.15, P1.13, P1.00) read low with the chord held. Which pin is which button (Left, Right, DPI) comes from the stock disassembly; this test does not tell them apart. To leave the bootloader without writing anything: `compx_usb_flasher.py dump --out <new file> --end 0x6020` (reads 32 bytes, then sends Exit); it returned the mouse to `258a:2018` three times.
  - Not yet tested on hardware: `calibrate.html` with the mouse in a real browser (**Send to mouse**, **Save on mouse**, **Turn curve off for calibration**), the idle-clock rate over 2.4 GHz (inferred, see above), and the ZMK board for this mouse in mouse-firmware-re (`devices/glorious-series-one-pro/zmk-board/`, never flashed), whose boot chord is separate code from the patch's.
- Zephyr: setup, devicetree properties and the HID hook are in [`adapters/zephyr/README.md`](adapters/zephyr/README.md).
- Linux evdev: the virtual mouse copies the source's bus/VID/PID, name and input properties, so libinput quirks and per-device desktop settings still apply. udev cannot give it the source's hwdb entry (`MOUSE_DPI`, which libinput's adaptive speed divides by), except for Bluetooth mice; when the source has one, the filter prints the udev rule that restores it.
- QMK: without `MOUSE_EXTENDED_REPORT`, reports are 8-bit and gains above 1.00x lose counts; see [`adapters/qmk/README.md`](adapters/qmk/README.md). The raw HID route (spec §6) is inferred from the QMK 0.34.8 and vial-qmk sources and tested against a mock board; not yet built in QMK or run on a device (2026-11-13). `calibrate.html` and `tools/odd_profile.py` do not speak it yet.

---

## Windows and macOS (untested)

Nothing in this section has been run on Windows or macOS yet (2026-11-13). The prebuilt patch file and `apply_patch.py` were checked on Linux, `odd_profile.py` with hidapi only against fakes.

1. Install Python 3.10 or later (python.org; on Windows tick "Add python.exe to PATH"), then the PyPI package `hidapi`: `python -m pip install hidapi` (Windows: `py -m pip install hidapi`). Not the package named `hid`, a different library; `odd_profile.py` refuses it. No udev rules or root access are needed on these systems.
2. Get this repo and [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re) side by side (`git clone` both into the same folder), or set `COMPX_TOOLS` to mouse-firmware-re's `platforms/compx-nrf52/tools`. Its `compx_usb_flasher.py` needs a version with `--backend hidapi`, the default there off Linux.
3. **Do not run the `compx_usb_flasher.py` commands below on Windows or macOS until the bootloader's report descriptor is recorded; dump and flash from Linux until then.** Both switch the mouse into its bootloader (`258a:2103`), where the flasher's hidapi backend looks for the collection with usage page `0xFFFF`, usage `0`, a pair verified for the application only. If the bootloader uses another one, the mouse stays in it and only the flasher on Linux can send `Exit` (`dump --out exit.hex --end 0x6020`). `apply_patch.py` is safe to run anywhere.
   Download `OpenDDPIv1-patch.json` from this repo's GitHub release. It has no stock bytes, so you also need your own stock image: the official `CM2856_Mouse_USB_v1.00.00_20220810.hex`, or a dump of a mouse still on stock v1.0.0.0. Then (from the repo root; `py` instead of `python` on Windows):
   ```text
   python ../mouse-firmware-re/platforms/compx-nrf52/tools/compx_usb_flasher.py dump --out backup.hex
   python adapters/glorious-cm2856/apply_patch.py --stock-hex backup.hex --patch OpenDDPIv1-patch.json -o OpenDDPIv1.hex
   python ../mouse-firmware-re/platforms/compx-nrf52/tools/compx_usb_flasher.py flash --firmware-hex OpenDDPIv1.hex
   ```
   The dump is your backup and, without the official `.hex`, your stock image (pass the official `.hex` to `--stock-hex` instead if you have it).
   `apply_patch.py` refuses a stock image whose decoded SHA-256 is not the patch file's (`e50510e0...`), and writes nothing unless the patched image matches the patch file's SHA-256, the image the Linux build checked in Unicorn. Checked on Linux (2026-11-13): from the official `.hex` and from a retail dump it wrote the build's `.hex` byte for byte (image SHA-256 `34d827d5...`, the hardware-verified build `21ea252`), and it refused a stock image with one changed byte and a patch file with one changed digit. To go back to stock, flash the official `.hex` (verified on Linux, see above).
4. Profiles: `python tools/odd_profile.py info`, `load profile.json --save`, `export`, `reset`, as on Linux; hidapi is the default backend there. `--device` takes the path it lists when several devices are found.

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
│   ├── test_directional_dpi.c       # 17 C unit tests
│   ├── gen_vectors.c                # Writes the conformance vectors from the C engine
│   └── vectors/                     # scale_vectors.json (8 profiles x 324 deltas) + format README
├── calibration/
│   ├── core/
│   │   ├── trajectory-analysis/     # Primary ballistic submovement & velocity-minimum detector
│   │   ├── directional-error/       # 8-sector CCW error aggregation with MAD outlier rejection
│   │   └── profile-generation/      # Smoothed gains, CPI headroom & signed firmware profile
│   ├── providers/
│   │   ├── builtin/                 # calibrate.html (Pointer Lock calibration page, WebHID Send to mouse) & scheduler
│   │   ├── mouse-log/               # Raw mouse log (MouseTester CSV) -> click-to-click flicks; Linux evdev logger
│   │   └── kovaaks/                 # Mouse log filtered by KovaaK's Stats.csv kills
│   ├── cli.ts                       # Provider -> profile JSON; `format` converts one for evdev / QMK / devicetree
│   ├── README.md                    # How to calibrate from Aimlabs / KovaaK's; what the trainers export
│   └── tests/                       # Pipeline, provider, CLI format and calibrate.html WebHID tests, fixtures
├── adapters/
│   ├── glorious-cm2856/             # Stock-firmware patch: stock_ddpi_patch.c/.ld (make check), build_and_verify_patch.py (.hex + patch file + 10 Unicorn tests; needs the stock image), apply_patch.py (patch file + your stock .hex -> .hex), test_apply_patch.py
│   ├── zephyr/                      # Zephyr / ZMK / Keychron ZGM input filter (`odd,directional-dpi`)
│   ├── qmk/                         # QMK `pointing_device` adapter (`pointing_device_task_odd`), raw HID protocol hook (`odd_raw_hid.c`)
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
│   └── module.yml                   # Makes the repo root a Zephyr module (`open-directional-dpi`)
├── .github/workflows/
│   ├── ci.yml                       # Vendor-binary guard, C tests, vector check, adapter builds, ARM patch link, TypeScript tests and type-check, odd_profile.py and patch-file tests
│   └── zephyr.yml                   # Zephyr native_sim tests (v4.5.0, v3.7.2) + ZMK nice_nano build
├── package.json, tsconfig.json      # TypeScript type-check (`npm ci && npx tsc -p tsconfig.json`)
├── LICENSE                          # MIT License
└── CONTRIBUTING.md                  # Contribution guidelines
```

---

## Key Features

1. **Travel-window direction estimator:**
   - The direction used for the gain comes from the last stretch of travel, not from one report, so 1 kHz and 8 kHz reports of the same path get the same gain instead of snapping to single-count axes.
   - The window length $L$ (0..128 counts) is stored in the profile. The core's neutral default profile has $L = 0$ (per-report direction); the adapters and the calibration output use $L = 16$ ($\approx 0.5\text{ mm}$ at $800\text{ CPI}$).
   - Adapters with a clock (Zephyr, QMK, evdev, and the Glorious patch, which counts the stock 1 ms sensor-read ticks (1000 per second on the cable, verified 2026-11-13; see the Glorious notes)) call `ddpi_process_motion()`, which restarts the estimator after an idle gap (profile setting, default 50 ms).
2. **Two transform models:**
   - **8-octant circular angular gain (`angular-gain`):** continuous interpolation between 8 compass multipliers, stored in HID order (`hid-cw`) or tabletop order (`odd-sensor-ccw`: $0^\circ = \text{Right}$, $90^\circ = \text{Away}$).
   - **Linear $2\times 2$ matrix (`linear-2x2`):** per-axis gain plus shear from the E/N/NE/NW multipliers, no direction state.
3. **CPI headroom normalization (`ddpi_profile_normalize_cpi_headroom`):**
   - Computes $\text{sensor\_cpi} = \operatorname{round}(\text{base\_cpi} \times \max G)$ and normalizes the multipliers to $\le 1.00\times$, so firmware only scales down and never emits 2-count steps.
4. **Browser calibration (`calibration/providers/builtin/calibrate.html`):**
   - Uses `requestPointerLock({ unadjustedMovement: true })` to measure primary-submovement overshoot/undershoot in 8 directions and exports an `open-directional-dpi-v1` JSON profile that `tools/odd_profile.py load` accepts. In Chrome or Edge, **Send to mouse** puts the result on a patched Glorious or an `[OpenDDPIv1]` device over WebHID (not yet tried on hardware).
   - Aim trainers (Aimlabs SpiderShot, KovaaK's): `calibration/cli.ts` makes the same JSON from a raw mouse log recorded while playing; see [`calibration/README.md`](calibration/README.md) for the steps and what each trainer exports. Not yet run on a real Aimlabs or KovaaK's session (2026-11-13); the tests use made-up logs.
   - `cli.ts format profile.json --format evdev|qmk|dts` turns a profile JSON into the evdev filter's arguments, `keymap.c` lines or devicetree properties.
   - Calibrate with the curve off: the page sees motion after the mouse (or host filter) applied the active curve, and exports absolute gains, so a recalibration through an active curve undoes the previous one. Glorious: **Turn curve off for calibration** in `calibrate.html`, or `python3 tools/odd_profile.py reset` (RAM only). Other HID firmware, including QMK with raw HID: `SET_ENABLED` mode 2 (`bypassForCalibration()` in `integrations/openmouse`, exact 1.00x, end it with `setEnabled()`). evdev: stop the filter. QMK without raw HID / devicetree curves: flash a flat curve first.
5. **Conformance vectors (`tests/vectors/`):** 2592 scale/octant results from the C engine; the TypeScript mirror must match every one.
6. **Single DPI stage (like Corsair PureVector):** a profile with `onlyAtBaseDpi` (flag bit 7) applies only while the sensor runs at its `baseDpi`; every other DPI stage passes through unchanged. It needs firmware that reports the current DPI: the Glorious patch (reads the stock firmware's active DPI) and QMK (`pointing_device_get_cpi()`). Elsewhere the flag has no effect and the curve applies at every DPI. In `calibrate.html`, tick "Only at this DPI" and enter that stage's DPI as the base CPI.

---

## Quick Start: Run All Checks

```bash
# C engine: 17 unit tests, then the QMK raw HID transport (tests/test_qmk_raw_hid.c)
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

# QMK adapter: standalone compile check (8-bit and extended reports, raw HID)
gcc -std=c11 -Wall -Wextra -Werror -pedantic -c adapters/qmk/odd_pointing_device.c -o /dev/null
gcc -std=c11 -Wall -Wextra -Werror -pedantic -DMOUSE_EXTENDED_REPORT -c adapters/qmk/odd_pointing_device.c -o /dev/null
gcc -std=c11 -Wall -Wextra -Werror -pedantic -DRAW_ENABLE -c adapters/qmk/odd_pointing_device.c -o /dev/null

# Glorious stock patch: compile + link with arm-none-eabi-gcc (CROSS=/path/bin/arm-none-eabi- if not on PATH)
make -C adapters/glorious-cm2856 check

# Glorious stock patch: full build + 10 Unicorn tests (needs your stock image and unicorn; not in CI)
python3 adapters/glorious-cm2856/build_and_verify_patch.py

# Zephyr filter: native_sim ztests (needs a Zephyr workspace, see adapters/zephyr/README.md)
$ZEPHYR_BASE/scripts/twister -T adapters/zephyr/tests -p native_sim/native/64
```
