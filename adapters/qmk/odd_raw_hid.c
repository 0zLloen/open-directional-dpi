/*
 * Open Directional DPI (ODD) v1 — QMK raw HID hook
 *
 * SPDX-License-Identifier: MIT
 *
 * Passes raw HID frames to odd_qmk_raw_hid() (odd_pointing_device.c) from the hook
 * that the build's raw HID stack has (spec/hid-protocol-v1.md §6.4). A keyboard that
 * already defines this hook leaves this file out and calls odd_qmk_raw_hid() first
 * from its own hook.
 */

#if !defined(RAW_ENABLE)
#error "odd_raw_hid.c needs RAW_ENABLE = yes or VIA_ENABLE = yes in rules.mk"
#endif

#include <stdbool.h>
#include <stdint.h>

#include "raw_hid.h"

bool odd_qmk_raw_hid(uint8_t *data, uint8_t length);

#if defined(VIAL_ENABLE)
/* vial-qmk: no via_command_kb(); via.c sends data back after this hook */
void raw_hid_receive_kb(uint8_t *data, uint8_t length) {
    if (!odd_qmk_raw_hid(data, length)) {
        data[0] = 0xFF; /* id_unhandled, as the weak default */
    }
}
#elif defined(VIA_ENABLE)
/* QMK VIA: true means handled and sent */
bool via_command_kb(uint8_t *data, uint8_t length) {
    if (!odd_qmk_raw_hid(data, length)) {
        return false;
    }
    raw_hid_send(data, length);
    return true;
}
#else
void raw_hid_receive(uint8_t *data, uint8_t length) {
    if (odd_qmk_raw_hid(data, length)) {
        raw_hid_send(data, length);
    }
}
#endif
