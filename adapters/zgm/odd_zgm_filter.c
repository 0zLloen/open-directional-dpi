/*
 * Open Directional DPI (ODD) v1 — Keychron ZGM (Zephyr Gaming Mouse) Adapter
 *
 * SPDX-License-Identifier: MIT
 *
 * Paired X/Y motion frame processor for Zephyr RTOS / Keychron ZGM high-polling
 * (1 kHz - 8 kHz) gaming mouse pipelines with idle-gap reset tracking.
 */

#include "../../core/directional_dpi.h"

static ddpi_engine_t g_zgm_engine;
static uint32_t      g_last_motion_ms = 0u;
static bool          g_zgm_ready      = false;

void odd_zgm_init(uint16_t base_cpi) {
    ddpi_engine_init(&g_zgm_engine, base_cpi);
    ddpi_profile_set_window_counts(&g_zgm_engine.profile, DDPI_DEFAULT_WINDOW_COUNTS);
    ddpi_profile_sanitize_and_sign(&g_zgm_engine.profile);
    g_zgm_ready = true;
}

void odd_zgm_process_sensor_frame(
    int16_t raw_dx,
    int16_t raw_dy,
    uint32_t now_ms,
    int16_t *out_dx,
    int16_t *out_dy
) {
    if (!g_zgm_ready) {
        odd_zgm_init(800u);
    }
    if ((now_ms - g_last_motion_ms) >= 50u) {
        ddpi_engine_notify_idle(&g_zgm_engine);
    }
    g_last_motion_ms = now_ms;
    ddpi_process_delta(&g_zgm_engine, raw_dx, raw_dy, out_dx, out_dy);
}
