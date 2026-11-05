# QMK Adapter (`adapters/qmk/`)

Integrates the portable C reference engine ([`core/directional_dpi.c`](../../core/directional_dpi.c)) into QMK's `pointing_device` pipeline.

## Setup

1. Enable 16-bit mouse reports in your `rules.mk`:
   ```makefile
   POINTING_DEVICE_ENABLE = yes
   MOUSE_EXTENDED_REPORT = yes
   SRC += ../../core/directional_dpi.c odd_pointing_device.c
   ```
2. Call `pointing_device_task_odd(mouse_report)` inside `pointing_device_task_user(report_mouse_t mouse_report)`.
