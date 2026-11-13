# QMK Adapter (`adapters/qmk/`)

Integrates the portable C reference engine ([`core/directional_dpi.c`](../../core/directional_dpi.c)) into QMK's `pointing_device` pipeline. Works with any QMK pointing device driver (PMW33xx, PAW3222, ADNS, Cirque, ...): it only touches the `report_mouse_t` that `pointing_device_task_user()` receives.

## Setup

1. Put this repository inside your keymap folder, e.g. `keymaps/<you>/odd/` (QMK adds the keymap folder to its source and include search paths).
2. `rules.mk`:
   ```makefile
   POINTING_DEVICE_ENABLE = yes
   MOUSE_EXTENDED_REPORT = yes
   SRC += odd/core/directional_dpi.c odd/adapters/qmk/odd_pointing_device.c
   ```
3. `keymap.c`:
   ```c
   #include "odd/core/directional_dpi.h"

   void           odd_qmk_init(uint16_t base_dpi);
   ddpi_engine_t *odd_qmk_get_engine(void);
   report_mouse_t pointing_device_task_odd(report_mouse_t mouse_report);

   void keyboard_post_init_user(void) {
       odd_qmk_init(pointing_device_get_cpi()); /* travel window L = 16 counts */
       ddpi_profile_v1_t p = odd_qmk_get_engine()->profile;
       p.flags |= DDPI_FLAG_ENABLED;
       p.multipliers_q8_8[DDPI_DIR_S] = 0x00C0; /* 0.75x toward you; values from the calibration tool */
       ddpi_engine_set_profile(odd_qmk_get_engine(), &p);
   }

   report_mouse_t pointing_device_task_user(report_mouse_t mouse_report) {
       return pointing_device_task_odd(mouse_report);
   }
   ```

The direction estimator restarts after the profile's idle gap (default 50 ms) using `timer_read32()`, so each flick starts from its own direction.

`node --experimental-strip-types calibration/cli.ts format profile.json --format qmk` prints the `keyboard_post_init_user()` lines for a calibrated profile. To load profiles from a host instead of reflashing, see [HID protocol over raw HID](#hid-protocol-over-raw-hid-via-vial).

## Single DPI stage

To apply the curve at one DPI stage only (like Corsair PureVector), add to the profile in `keyboard_post_init_user()`:

```c
p.flags |= DDPI_FLAG_ONLY_AT_BASE_DPI;
p.base_dpi = 1600;
```

The adapter feeds `pointing_device_get_cpi()` to the engine on every report, so the curve applies only while it returns 1600; every other DPI passes through unchanged.

## Report width

Without `MOUSE_EXTENDED_REPORT`, QMK reports are 8-bit: drivers already clamp the sensor delta to ±127 (`CONSTRAIN_HID_XY`) before `pointing_device_task_user()` runs, and the adapter saturates the scaled output to ±127 too, so fast motion with gains above 1.00x loses counts. Enable `MOUSE_EXTENDED_REPORT`, or keep all gains ≤ 1.00x and raise the sensor CPI instead (`ddpi_profile_normalize_cpi_headroom()` computes it).

## HID protocol over raw HID (VIA, Vial)

With raw HID the board speaks the same protocol as the other routes (`GET_PROFILE`, `SET_PROFILE`, `SIMULATE_DELTA`, `SET_ENABLED`, `SAVE_FLASH`, ...), so a host can load a calibrated profile without reflashing. QMK has no vendor Feature report, so the 64-byte packets travel over QMK's raw HID interface (usage page `0xFF60`, usage `0x61`) in 32-byte frames that start with `0xDF` ([`spec/hid-protocol-v1.md`](../../spec/hid-protocol-v1.md) §6). Inferred from the QMK 0.34.8 and vial-qmk sources (2026-11-13); not yet built in QMK or run on a device.

1. `rules.mk`: raw HID, and the hook file. `VIA_ENABLE = yes` already turns raw HID on (Vial keymaps set it too).
   ```makefile
   RAW_ENABLE = yes   # or VIA_ENABLE = yes
   SRC += odd/adapters/qmk/odd_raw_hid.c
   ```
   `odd_raw_hid.c` defines the hook that the build's raw HID stack calls: `raw_hid_receive_kb()` with Vial, `via_command_kb()` with QMK's VIA, `raw_hid_receive()` with raw HID alone. If the keyboard or keymap already defines that hook (some keyboards define `via_command_kb()`), leave the file out and call `odd_qmk_raw_hid()` first from the existing hook, as `odd_raw_hid.c` does:
   ```c
   bool odd_qmk_raw_hid(uint8_t *data, uint8_t length); /* true: handled, reply left in data */
   ```
2. Optional, `config.h`: keep the profile across power cycles. `SAVE_FLASH` then writes it to bytes 0..27 of QMK's user datablock (EEPROM), and `odd_qmk_init()` loads it at boot. Without it `SAVE_FLASH` answers "unsupported" and the profile lives in RAM until the next reset.
   ```c
   #define EECONFIG_USER_DATA_SIZE 28 /* more if the keymap stores its own data after byte 27 */
   ```
   A profile set in `keyboard_post_init_user()` after `odd_qmk_init()` replaces the saved one at every boot, so drop those lines once the host loads and saves the profile.

What the board does:
- Frames whose byte 0 is not `0xDF` go to VIA or Vial as before. The probe that finds the adapter is harmless on boards without it: VIA and Vial answer `0xFF` to the first frame, and the host stops (spec §6.3).
- `ENTER_BOOTLOADER` answers "unsupported": QMK's VIA has no bootloader command and Vial allows one only after an unlock, so the adapter does not add one.
- `GET_CAPABILITIES` reports the sensor DPI (`pointing_device_get_cpi()`) and the clock (`timer_read32()`) that `pointing_device_task_odd()` last saw.
- QMK runs raw HID and the pointing device task in the same main loop, so no lock is needed.

Hosts:
- `integrations/openmouse` (WebHID, Chrome or Edge): open the device with the filter `QMK_RAW_HID_FILTER` (`{ usagePage: 0xff60, usage: 0x61 }`) and pass it to `OpenMouseDirectionalDpiClient`; `detectCapabilities()` sends the probe. Tested against a mock board only.
- `tools/odd_profile.py` (Linux hidraw, or hidapi on any OS; both backends speak raw HID):
  - It finds the `0xFF60`/`0x61` interface and probes it with `GET_CAPABILITIES` only when no mouse is found or `--device` names it, and sends nothing else unless the answer carries `DP01`. A VIA or Vial board without the adapter answers `0xFF` to the first frame and the probe stops.
  - A raw HID interface that does not open (no access, or held by another program) is skipped and named in the "No supported device found" message, unless `--device` names it.
  - Only checked against fakes (2026-11-13); no board has run it.
- `calibrate.html` (**Send to mouse**) does not speak raw HID yet: it uses the Feature report only.
- Close the VIA or Vial app while configuring: it reads replies from the same interface.

## Compile check without QMK

From the repo root:

```sh
make -C adapters/qmk check
```

It builds [`tests/test_qmk_raw_hid.c`](tests/test_qmk_raw_hid.c), compiles `odd_pointing_device.c` with the adapter's stand-in types three times (8-bit reports, `MOUSE_EXTENDED_REPORT`, `RAW_ENABLE`), then runs the test: the raw HID framing, the probe answer and `SAVE_FLASH` on the host. CI runs it, and also compiles the adapter against QMK 0.34.8's own `report.h`, `pointing_device.h`, `timer.h`, `eeconfig.h` and `raw_hid.h` (headers only), with and without `RAW_ENABLE`, and `odd_raw_hid.c` for raw HID alone, VIA and Vial. Not yet built in a QMK keyboard or run on a QMK device; the keymap snippet above is not compiled in CI.
