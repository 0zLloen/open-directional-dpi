/*
 * ZMK Input Processor for Open Directional DPI v1
 *
 * SPDX-License-Identifier: MIT
 */

#define DT_DRV_COMPAT zmk_input_processor_directional_dpi

#include <zephyr/device.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <drivers/input_processor.h>

#include "directional_dpi.h"

LOG_MODULE_REGISTER(zmk_input_processor_ddpi, CONFIG_ZMK_LOG_LEVEL);

struct ddpi_zmk_config {
    uint16_t base_dpi;
    uint16_t global_gain_q8_8;
    uint16_t default_multipliers_q8_8[DDPI_NUM_DIRECTIONS];
};

struct ddpi_zmk_data {
    ddpi_engine_t engine;
    int16_t       pending_dx;
    bool          has_pending_dx;
    struct k_mutex lock;
};

static const struct device *g_active_ddpi_dev = NULL;

/* Forward declaration of board bootloader re-entry hook */
__attribute__((weak)) void glorious_enter_compx_bootloader(void) {
    /* On nRF52840 CM2852-BAMF, write 0xA55AA55A to 0x2003FFFC and reset */
    *(volatile uint32_t *)0x2003FFFCu = 0xA55AA55Au;
    NVIC_SystemReset();
}

static bool ddpi_zmk_save_profile_to_nvs(const ddpi_profile_v1_t *profile) {
#if IS_ENABLED(CONFIG_SETTINGS)
    uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
    ddpi_profile_serialize(profile, raw);
    int rc = settings_save_one("ddpi/profile0", raw, sizeof(raw));
    return (rc == 0);
#else
    ARG_UNUSED(profile);
    return true;
#endif
}

#if IS_ENABLED(CONFIG_SETTINGS)
static int ddpi_settings_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg) {
    if (strcmp(name, "profile0") != 0 || g_active_ddpi_dev == NULL) {
        return -ENOENT;
    }
    if (len != DDPI_PROFILE_SERIALIZED_LEN) {
        return -EINVAL;
    }
    uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
    ssize_t rc = read_cb(cb_arg, raw, sizeof(raw));
    if (rc != (ssize_t)sizeof(raw)) {
        return -EIO;
    }

    ddpi_profile_v1_t loaded;
    if (!ddpi_profile_deserialize(raw, &loaded)) {
        LOG_WRN("Stored ddpi/profile0 failed CRC-16 check; keeping defaults");
        return -EINVAL;
    }

    struct ddpi_zmk_data *data = g_active_ddpi_dev->data;
    k_mutex_lock(&data->lock, K_FOREVER);
    ddpi_engine_set_profile(&data->engine, &loaded);
    k_mutex_unlock(&data->lock);
    return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(ddpi, "ddpi", NULL, ddpi_settings_set, NULL, NULL);
#endif /* CONFIG_SETTINGS */

/**
 * ZMK Input Processor event handler.
 * Buffers INPUT_REL_X until the paired sync INPUT_REL_Y arrives so 2D angle
 * calculation uses the true simultaneous (dx, dy) motion vector.
 */
static int ddpi_zmk_handle_event(
    const struct device *dev,
    struct input_event *event,
    uint32_t param1,
    uint32_t param2,
    struct zmk_input_processor_state *state
) {
    ARG_UNUSED(param1);
    ARG_UNUSED(param2);
    ARG_UNUSED(state);

    if (event->type != INPUT_EV_REL) {
        return ZMK_INPUT_PROC_CONTINUE;
    }

    struct ddpi_zmk_data *data = dev->data;
    k_mutex_lock(&data->lock, K_FOREVER);

    if (ddpi_profile_is_identity(&data->engine.profile)) {
        data->has_pending_dx = false;
        k_mutex_unlock(&data->lock);
        return ZMK_INPUT_PROC_CONTINUE;
    }

    if (event->code == INPUT_REL_X && !event->sync) {
        data->pending_dx     = (int16_t)CLAMP(event->value, -32768, 32767);
        data->has_pending_dx = true;
        /* Consume unsynced X event and emit paired (X, Y) when Y arrives */
        k_mutex_unlock(&data->lock);
        return ZMK_INPUT_PROC_STOP;
    }

    if (event->code == INPUT_REL_Y) {
        int16_t raw_dx = data->has_pending_dx ? data->pending_dx : 0;
        int16_t raw_dy = (int16_t)CLAMP(event->value, -32768, 32767);
        data->has_pending_dx = false;

        int16_t out_dx = 0;
        int16_t out_dy = 0;
        ddpi_process_delta(&data->engine, raw_dx, raw_dy, &out_dx, &out_dy);
        k_mutex_unlock(&data->lock);

        if (out_dx != 0) {
            input_report_rel(event->dev, INPUT_REL_X, out_dx, false, K_NO_WAIT);
        }
        event->value = out_dy;
        return ZMK_INPUT_PROC_CONTINUE;
    }

    /* Single-axis synced X event without Y */
    if (event->code == INPUT_REL_X && event->sync) {
        int16_t raw_dx = (int16_t)CLAMP(event->value, -32768, 32767);
        int16_t out_dx = 0;
        int16_t out_dy = 0;
        ddpi_process_delta(&data->engine, raw_dx, 0, &out_dx, &out_dy);
        k_mutex_unlock(&data->lock);
        event->value = out_dx;
        return ZMK_INPUT_PROC_CONTINUE;
    }

    k_mutex_unlock(&data->lock);
    return ZMK_INPUT_PROC_CONTINUE;
}

/**
 * Public hook for USB HID Interface 2 Feature Report (64-byte payload, Report ID 0x00).
 * Supports both Open Directional DPI v1 ('D','P' & 0xDF) and stock Compx bootloader
 * re-entry commands (buf[6] == 0xB0 or buf[5] == 0x03).
 */
bool zmk_ddpi_usb_hid_feature_report(const uint8_t req[64], uint8_t resp[64]) {
    if (g_active_ddpi_dev == NULL) {
        return false;
    }

    /* Stock Compx updater bootloader entry command compatibility:
     * In 64-byte payload (without leading 0x00 Report ID), buf[6] == 0xB0 && buf[7] == 0x04
     * or buf[5] == 0x03 triggers bootloader mode (0x2003FFFC = 0xA55AA55A).
     */
    if ((req[6] == 0xB0u && req[7] == 0x04u) || (req[0] == 0x00u && req[5] == 0x03u)) {
        glorious_enter_compx_bootloader();
        return true;
    }

    struct ddpi_zmk_data *data = g_active_ddpi_dev->data;
    k_mutex_lock(&data->lock, K_FOREVER);
    bool handled = ddpi_hid_handle_feature_report(
        &data->engine,
        req,
        resp,
        ddpi_zmk_save_profile_to_nvs,
        glorious_enter_compx_bootloader
    );
    k_mutex_unlock(&data->lock);
    return handled;
}

static int ddpi_zmk_init(const struct device *dev) {
    const struct ddpi_zmk_config *cfg = dev->config;
    struct ddpi_zmk_data *data        = dev->data;

    k_mutex_init(&data->lock);
    ddpi_engine_init(&data->engine, cfg->base_dpi);
    data->engine.profile.global_gain_q8_8 = cfg->global_gain_q8_8;
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        data->engine.profile.multipliers_q8_8[i] = cfg->default_multipliers_q8_8[i];
    }
    ddpi_profile_sanitize_and_sign(&data->engine.profile);
    data->has_pending_dx = false;
    g_active_ddpi_dev    = dev;
    return 0;
}

static const struct zmk_input_processor_driver_api ddpi_zmk_driver_api = {
    .handle_event = ddpi_zmk_handle_event,
};

#define DDPI_ZMK_INST(n)                                                              \
    static const struct ddpi_zmk_config ddpi_zmk_config_##n = {                       \
        .base_dpi                 = DT_INST_PROP_OR(n, base_dpi, 800),                \
        .global_gain_q8_8         = DT_INST_PROP_OR(n, global_gain_q8_8, 256),        \
        .default_multipliers_q8_8 = DT_INST_PROP_OR(                                  \
            n, multipliers_q8_8, {256, 256, 256, 256, 256, 256, 256, 256}             \
        ),                                                                            \
    };                                                                                \
    static struct ddpi_zmk_data ddpi_zmk_data_##n;                                    \
    DEVICE_DT_INST_DEFINE(                                                            \
        n,                                                                            \
        ddpi_zmk_init,                                                                \
        NULL,                                                                         \
        &ddpi_zmk_data_##n,                                                           \
        &ddpi_zmk_config_##n,                                                         \
        POST_KERNEL,                                                                  \
        CONFIG_KERNEL_INIT_PRIORITY_DEFAULT,                                          \
        &ddpi_zmk_driver_api                                                          \
    );

DT_INST_FOREACH_STATUS_OKAY(DDPI_ZMK_INST)
