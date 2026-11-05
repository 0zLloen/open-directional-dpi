/*
 * Open Directional DPI (ODD) v1 — QMK Pointing Device Adapter
 *
 * SPDX-License-Identifier: MIT
 *
 * Drop-in integration for QMK's pointing_device subsystem.
 * Enable `MOUSE_EXTENDED_REPORT = yes` in rules.mk for 16-bit X/Y deltas.
 */

#include "../../core/directional_dpi.h"

#ifdef QMK_KEYBOARD_H
#include QMK_KEYBOARD_H
#else
#include <stdint.h>
typedef int16_t mouse_xy_report_t;
typedef struct {
    mouse_xy_report_t x;
    mouse_xy_report_t y;
    int8_t            v;
    int8_t            h;
    uint8_t           buttons;
} report_mouse_t;
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
    ddpi_process_delta(&g_odd_qmk_engine, (int16_t)mouse_report.x, (int16_t)mouse_report.y, &out_x, &out_y);
    mouse_report.x = (mouse_xy_report_t)out_x;
    mouse_report.y = (mouse_xy_report_t)out_y;
    return mouse_report;
}
