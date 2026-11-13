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

`node --experimental-strip-types calibration/cli.ts format profile.json --format qmk` prints the `keyboard_post_init_user()` lines for a calibrated profile.

## Single DPI stage

To apply the curve at one DPI stage only (like Corsair PureVector), add to the profile in `keyboard_post_init_user()`:

```c
p.flags |= DDPI_FLAG_ONLY_AT_BASE_DPI;
p.base_dpi = 1600;
```

The adapter feeds `pointing_device_get_cpi()` to the engine on every report, so the curve applies only while it returns 1600; every other DPI passes through unchanged.

## Report width

Without `MOUSE_EXTENDED_REPORT`, QMK reports are 8-bit: drivers already clamp the sensor delta to ±127 (`CONSTRAIN_HID_XY`) before `pointing_device_task_user()` runs, and the adapter saturates the scaled output to ±127 too, so fast motion with gains above 1.00x loses counts. Enable `MOUSE_EXTENDED_REPORT`, or keep all gains ≤ 1.00x and raise the sensor CPI instead (`ddpi_profile_normalize_cpi_headroom()` computes it).

## Compile check without QMK

CI compiles it against its stand-in types and against QMK 0.34.8's own `report.h`, `pointing_device.h` and `timer.h` (headers only). Not yet built in a QMK keyboard or run on a QMK device; the keymap snippet above is not compiled in CI.

```sh
gcc -std=c11 -Wall -Wextra -Werror -pedantic -c odd_pointing_device.c -o /dev/null
gcc -std=c11 -Wall -Wextra -Werror -pedantic -DMOUSE_EXTENDED_REPORT -c odd_pointing_device.c -o /dev/null
```
