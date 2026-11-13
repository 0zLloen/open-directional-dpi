/*
 * Open Directional DPI (ODD) v1 — QMK Pointing Device Adapter
 *
 * SPDX-License-Identifier: MIT
 *
 * Drop-in integration for QMK's pointing_device subsystem (see README.md).
 * Enable `MOUSE_EXTENDED_REPORT = yes` in rules.mk for 16-bit X/Y deltas.
 */

#include "../../core/directional_dpi.h"

#ifdef QMK_KEYBOARD_H
#include QMK_KEYBOARD_H /* report_mouse_t, CONSTRAIN_HID_XY, timer_read32 */
#else
/* Standalone compile check only: the few QMK names this file uses (tmk_core/protocol/report.h). */
#ifdef MOUSE_EXTENDED_REPORT
#define MOUSE_REPORT_XY_MIN (INT16_MIN + 1)
#define MOUSE_REPORT_XY_MAX INT16_MAX
typedef int16_t mouse_xy_report_t;
#else
#define MOUSE_REPORT_XY_MIN (INT8_MIN + 1)
#define MOUSE_REPORT_XY_MAX INT8_MAX
typedef int8_t mouse_xy_report_t;
#endif
#define CONSTRAIN_HID_XY(amt) ((amt) < MOUSE_REPORT_XY_MIN ? MOUSE_REPORT_XY_MIN : ((amt) > MOUSE_REPORT_XY_MAX ? MOUSE_REPORT_XY_MAX : (amt)))
typedef struct {
    mouse_xy_report_t x;
    mouse_xy_report_t y;
    int8_t            v;
    int8_t            h;
    uint8_t           buttons;
} report_mouse_t;
static uint32_t timer_read32(void) {
    return 0u;
}
#endif

static ddpi_engine_t g_odd_qmk_engine;
static bool          g_odd_qmk_initialized = false;

void odd_qmk_init(uint16_t base_dpi) {
    ddpi_engine_init(&g_odd_qmk_engine, base_dpi);
    ddpi_profile_set_window_counts(&g_odd_qmk_engine.profile, DDPI_DEFAULT_WINDOW_COUNTS);
    ddpi_profile_sanitize_and_sign(&g_odd_qmk_engine.profile);
    g_odd_qmk_initialized = true;
}

ddpi_engine_t *odd_qmk_get_engine(void) {
    if (!g_odd_qmk_initialized) {
        odd_qmk_init(800u);
    }
    return &g_odd_qmk_engine;
}

report_mouse_t pointing_device_task_odd(report_mouse_t mouse_report) {
    if (!g_odd_qmk_initialized) {
        odd_qmk_init(800u);
    }
    int16_t out_x = 0;
    int16_t out_y = 0;
    ddpi_process_motion(&g_odd_qmk_engine, (int16_t)mouse_report.x, (int16_t)mouse_report.y,
                        timer_read32(), &out_x, &out_y);
    /* 8-bit reports (no MOUSE_EXTENDED_REPORT) would wrap; saturate instead.
     * int32 so the clamp is not a tautology (-Wtype-limits) with 16-bit reports. */
    int32_t x = out_x;
    int32_t y = out_y;
    mouse_report.x = (mouse_xy_report_t)CONSTRAIN_HID_XY(x);
    mouse_report.y = (mouse_xy_report_t)CONSTRAIN_HID_XY(y);
    return mouse_report;
}
