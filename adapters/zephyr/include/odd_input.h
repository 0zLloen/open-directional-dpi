/*
 * Open Directional DPI (ODD) v1 - Zephyr input filter public API
 *
 * SPDX-License-Identifier: MIT
 */

#ifndef ODD_INPUT_H_
#define ODD_INPUT_H_

#include <stdbool.h>
#include <stdint.h>

#include <zephyr/device.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Handle one 64-byte Open Directional DPI v1 HID feature report for the
 * `odd,directional-dpi` filter @p dev (payload only, without a report ID).
 *
 * Call it from the firmware's own HID SET_REPORT(Feature) handler and answer the
 * following GET_REPORT(Feature) with @p resp. Safe from thread or ISR context.
 * ENTER_BOOTLOADER (0x0F) answers "unsupported": intercept it before calling if
 * the board can do it.
 *
 * @return true if @p req was an ODD v1 packet and @p resp was filled.
 */
bool odd_input_hid_feature_report(const struct device *dev, const uint8_t req[64], uint8_t resp[64]);

#ifdef __cplusplus
}
#endif

#endif /* ODD_INPUT_H_ */
