/*
 * Open Directional DPI (ODD) v1 — QMK Pointing Device Adapter
 *
 * SPDX-License-Identifier: MIT
 *
 * Drop-in integration for QMK's pointing_device subsystem (see README.md).
 * Enable `MOUSE_EXTENDED_REPORT = yes` in rules.mk for 16-bit X/Y deltas.
 * With RAW_ENABLE (or VIA_ENABLE), odd_qmk_raw_hid() carries the HID protocol over
 * QMK's raw HID interface (spec/hid-protocol-v1.md §6); odd_raw_hid.c wires it up.
 */

#include <string.h>

#include "../../core/directional_dpi.h"

#ifdef QMK_KEYBOARD_H
#include QMK_KEYBOARD_H /* report_mouse_t, CONSTRAIN_HID_XY, timer_read32, pointing_device_get_cpi */
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
static uint16_t pointing_device_get_cpi(void) {
    return 800u;
}
#endif

static ddpi_engine_t g_odd_qmk_engine;
static bool          g_odd_qmk_initialized = false;

/* SAVE_FLASH: bytes 0..27 of QMK's user datablock (config.h: EECONFIG_USER_DATA_SIZE >= 28) */
#if defined(EECONFIG_USER_DATA_SIZE) && (EECONFIG_USER_DATA_SIZE) >= DDPI_PROFILE_SERIALIZED_LEN
#define ODD_QMK_EEPROM 1
static bool odd_qmk_save(const ddpi_profile_v1_t *profile) {
    uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
    ddpi_profile_serialize(profile, raw);
    eeconfig_update_user_datablock(raw, 0u, DDPI_PROFILE_SERIALIZED_LEN);
    return true;
}
#endif

void odd_qmk_init(uint16_t base_dpi) {
    ddpi_engine_init(&g_odd_qmk_engine, base_dpi);
    ddpi_profile_set_window_counts(&g_odd_qmk_engine.profile, DDPI_DEFAULT_WINDOW_COUNTS);
    ddpi_profile_sanitize_and_sign(&g_odd_qmk_engine.profile);
#ifdef ODD_QMK_EEPROM
    /* The profile saved with SAVE_FLASH, if any (a fresh datablock is zeros and fails the check) */
    uint8_t           raw[DDPI_PROFILE_SERIALIZED_LEN];
    ddpi_profile_v1_t saved;
    eeconfig_read_user_datablock(raw, 0u, DDPI_PROFILE_SERIALIZED_LEN);
    if (ddpi_profile_deserialize(raw, &saved)) {
        ddpi_engine_set_profile(&g_odd_qmk_engine, &saved);
    }
#endif
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
    int16_t  out_x = 0;
    int16_t  out_y = 0;
    uint32_t now   = timer_read32();
    /* QMK owns the CPI (DPI keycodes, pointing_device_set_cpi): lets a profile with
     * DDPI_FLAG_ONLY_AT_BASE_DPI apply to one DPI stage only */
    ddpi_engine_set_sensor_dpi(&g_odd_qmk_engine, pointing_device_get_cpi());
    ddpi_engine_set_clock_ms(&g_odd_qmk_engine, now); /* GET_CAPABILITIES bytes 20..23 */
    ddpi_process_motion(&g_odd_qmk_engine, (int16_t)mouse_report.x, (int16_t)mouse_report.y, now, &out_x,
                        &out_y);
    /* 8-bit reports (no MOUSE_EXTENDED_REPORT) would wrap; saturate instead.
     * int32 so the clamp is not a tautology (-Wtype-limits) with 16-bit reports. */
    int32_t x = out_x;
    int32_t y = out_y;
    mouse_report.x = (mouse_xy_report_t)CONSTRAIN_HID_XY(x);
    mouse_report.y = (mouse_xy_report_t)CONSTRAIN_HID_XY(y);
    return mouse_report;
}

#if defined(RAW_ENABLE)
/* spec/hid-protocol-v1.md §6: the 64-byte packet in 32-byte frames [0xDF, chunk, 30 data bytes] */
static uint8_t g_odd_raw_req[DDPI_HID_PACKET_LEN];
static uint8_t g_odd_raw_resp[DDPI_HID_PACKET_LEN];
static uint8_t g_odd_raw_next; /* write chunk accepted next: 1 or 2 inside a request, else 0 */

/* Calls no QMK function. Returns false (data untouched) for frames that are not ours;
 * otherwise leaves the one reply frame in data, built in place, as Vial's via.c needs. */
bool odd_qmk_raw_hid(uint8_t *data, uint8_t length) {
    if (data == NULL || length != 32u || data[0] != DDPI_HID_NAMESPACE) {
        return false;
    }
    uint8_t chunk = data[1] & 0x7Fu;
    uint8_t n     = (chunk == 2u) ? 4u : 30u; /* chunk 2 holds packet bytes 60..63 */
    uint8_t want  = g_odd_raw_next;
    g_odd_raw_next = 0u; /* any frame but the next write chunk drops a partial request */
    if (chunk > 2u) {
        return true; /* answered unchanged */
    }
    if ((data[1] & 0x80u) != 0u) { /* read chunk of the last response */
        memset(&data[2], 0, 30u);
        memcpy(&data[2], &g_odd_raw_resp[30u * chunk], n);
        return true;
    }
    if (chunk != 0u && chunk != want) {
        return true; /* out of order: dropped, answered unchanged */
    }
    memcpy(&g_odd_raw_req[30u * chunk], &data[2], n);
    if (chunk < 2u) {
        g_odd_raw_next = (uint8_t)(chunk + 1u);
        return true;
    }
    /* No bootloader command: QMK's VIA has none and Vial allows one only after an unlock */
#ifdef ODD_QMK_EEPROM
    ddpi_hid_handle_feature_report(odd_qmk_get_engine(), g_odd_raw_req, g_odd_raw_resp, odd_qmk_save, NULL);
#else
    ddpi_hid_handle_feature_report(odd_qmk_get_engine(), g_odd_raw_req, g_odd_raw_resp, NULL, NULL);
#endif
    return true;
}
#endif
