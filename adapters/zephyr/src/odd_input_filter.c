/*
 * Open Directional DPI (ODD) v1 - Zephyr input filter
 *
 * SPDX-License-Identifier: MIT
 *
 * Virtual input device (same pattern as zephyr,input-longpress): listens to the
 * `input` device, applies per-direction sensitivity to each REL_X/REL_Y frame
 * and re-emits it from this device. Works in plain Zephyr and in ZMK.
 */

#define DT_DRV_COMPAT odd_directional_dpi

#include <string.h>

#include <zephyr/device.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/util.h>

#include <odd_input.h>
#include "directional_dpi.h"

LOG_MODULE_REGISTER(odd_input, CONFIG_INPUT_LOG_LEVEL);

struct odd_config {
	const struct device *input_dev;
	const char *settings_key;
	uint16_t base_dpi;
	uint16_t global_gain_q8_8;
	uint16_t multipliers_q8_8[DDPI_NUM_DIRECTIONS];
	uint8_t window_counts;
	uint8_t idle_5ms;
	bool merge_axis_syncs;
};

struct odd_data {
	/* Engine is shared with the HID path (USB/BLE thread, maybe ISR). */
	struct k_spinlock lock;
	ddpi_engine_t engine;
	/* Frame accumulator: only touched from the input callback. */
	int32_t dx;
	int32_t dy;
	bool pending;
#ifdef CONFIG_SETTINGS
	const struct device *dev;
	struct k_work_delayable save_work;
	ddpi_profile_v1_t to_save;
#endif
};

/* Callback section and signature: user_data since 4.0, renamed from input_listener
 * during 3.6.99 (ODD_HAS_INPUT_CALLBACK comes from CMakeLists.txt)
 */
#if defined(INPUT_CALLBACK_DEFINE_NAMED)
#define ODD_CB_SECTION       input_callback
#define ODD_CB_CALL(cb, evt) (cb)->callback((evt), (cb)->user_data)
#elif defined(ODD_HAS_INPUT_CALLBACK)
#define ODD_CB_SECTION       input_callback
#define ODD_CB_CALL(cb, evt) (cb)->callback(evt)
#else
#define ODD_CB_SECTION       input_listener
#define ODD_CB_CALL(cb, evt) (cb)->callback(evt)
#endif

/*
 * Deliver straight to the callbacks of this device, exactly what input_report()
 * does in CONFIG_INPUT_MODE_SYNCHRONOUS. Not input_report() itself: in
 * CONFIG_INPUT_MODE_THREAD this runs on the input thread, the only consumer of
 * the input queue, so re-queueing would deadlock when waiting and, with
 * K_NO_WAIT, drop output (key releases too) whenever a sensor blocked in
 * K_FOREVER keeps the queue full.
 */
static void odd_emit(const struct device *dev, uint8_t type, uint16_t code, int32_t value,
		     bool sync)
{
	struct input_event evt = {
		.dev = dev, .sync = sync, .type = type, .code = code, .value = value};

	STRUCT_SECTION_FOREACH(ODD_CB_SECTION, cb) {
		if (cb->dev == NULL || cb->dev == dev) {
			ODD_CB_CALL(cb, &evt);
		}
	}
}

static void odd_flush(const struct device *dev, bool sync)
{
	struct odd_data *data = dev->data;
	int16_t out_x;
	int16_t out_y;
	k_spinlock_key_t key = k_spin_lock(&data->lock);

	ddpi_process_motion(&data->engine, (int16_t)data->dx, (int16_t)data->dy,
			    k_uptime_get_32(), &out_x, &out_y);
	k_spin_unlock(&data->lock, key);
	data->dx = 0;
	data->dy = 0;
	data->pending = false;

	if (out_x != 0) {
		odd_emit(dev, INPUT_EV_REL, INPUT_REL_X, out_x, false);
	}
	/* Y always carries the frame's sync, even when 0 */
	if (out_y != 0 || sync) {
		odd_emit(dev, INPUT_EV_REL, INPUT_REL_Y, out_y, sync);
	}
}

static void odd_input_cb(struct input_event *evt, void *user_data)
{
	const struct device *dev = user_data;
	const struct odd_config *cfg = dev->config;
	struct odd_data *data = dev->data;

	if (evt->type == INPUT_EV_REL && (evt->code == INPUT_REL_X || evt->code == INPUT_REL_Y)) {
		int32_t *acc = (evt->code == INPUT_REL_X) ? &data->dx : &data->dy;

		*acc = CLAMP(*acc + CLAMP(evt->value, -INT16_MAX, INT16_MAX), -INT16_MAX, INT16_MAX);
		data->pending = true;
		if (evt->sync && !(evt->code == INPUT_REL_X && cfg->merge_axis_syncs)) {
			odd_flush(dev, true);
		}
		return;
	}

	/* Keys, wheel, abs: forward as-is; motion goes out first in the same frame */
	if (evt->sync && data->pending) {
		odd_flush(dev, false);
	}
	odd_emit(dev, evt->type, evt->code, evt->value, evt->sync);
}

#ifdef CONFIG_SETTINGS
static const struct device *const odd_devs[] = {
#define ODD_DEV_PTR(inst) DEVICE_DT_INST_GET(inst),
	DT_INST_FOREACH_STATUS_OKAY(ODD_DEV_PTR)
};

static void odd_save_work(struct k_work *work)
{
	struct k_work_delayable *dwork = k_work_delayable_from_work(work);
	struct odd_data *data = CONTAINER_OF(dwork, struct odd_data, save_work);
	const struct odd_config *cfg = data->dev->config;
	uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
	k_spinlock_key_t key = k_spin_lock(&data->lock);

	ddpi_profile_serialize(&data->to_save, raw);
	k_spin_unlock(&data->lock, key);

	int rc = settings_save_one(cfg->settings_key, raw, sizeof(raw));

	if (rc != 0) {
		LOG_ERR("%s: profile not saved (%d)", data->dev->name, rc);
	}
}

static int odd_settings_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	for (size_t i = 0; i < ARRAY_SIZE(odd_devs); i++) {
		const struct device *dev = odd_devs[i];
		const struct odd_config *cfg = dev->config;
		struct odd_data *data = dev->data;
		uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
		ddpi_profile_v1_t profile;

		if (!settings_name_steq(name, cfg->settings_key + sizeof("odd/") - 1, NULL)) {
			continue;
		}
		if (len != sizeof(raw) || read_cb(cb_arg, raw, sizeof(raw)) != sizeof(raw) ||
		    !ddpi_profile_deserialize(raw, &profile)) {
			LOG_WRN("%s: ignoring invalid stored profile", dev->name);
			return 0;
		}
		k_spinlock_key_t key = k_spin_lock(&data->lock);

		ddpi_engine_set_profile(&data->engine, &profile);
		k_spin_unlock(&data->lock, key);
		return 0;
	}
	return -ENOENT;
}

SETTINGS_STATIC_HANDLER_DEFINE(odd_input, "odd", NULL, odd_settings_set, NULL, NULL);

/* Core callbacks carry no instance pointer: accept here, capture the profile
 * after the call (see odd_input_hid_feature_report) so every instance works.
 */
static bool odd_accept_save(const ddpi_profile_v1_t *profile)
{
	ARG_UNUSED(profile);
	return true;
}
#define ODD_SAVE_CB odd_accept_save
#else
#define ODD_SAVE_CB NULL
#endif /* CONFIG_SETTINGS */

bool odd_input_hid_feature_report(const struct device *dev, const uint8_t req[64], uint8_t resp[64])
{
	struct odd_data *data = dev->data;
	k_spinlock_key_t key = k_spin_lock(&data->lock);
	/* No bootloader callback: boards that support 0x0F intercept it before calling */
	bool handled = ddpi_hid_handle_feature_report(&data->engine, req, resp, ODD_SAVE_CB, NULL);

#ifdef CONFIG_SETTINGS
	bool save = handled && req[6] == DDPI_CMD_SAVE_FLASH && resp[3] == DDPI_STATUS_OK;

	if (save) {
		data->to_save = data->engine.profile;
	}
	k_spin_unlock(&data->lock, key);
	/* Flash I/O off this context; schedule (not reschedule) bounds the delay */
	if (save) {
		k_work_schedule(&data->save_work, K_MSEC(CONFIG_ODD_DIRECTIONAL_DPI_SAVE_DELAY_MS));
	}
#else
	k_spin_unlock(&data->lock, key);
#endif
	return handled;
}

static int odd_init(const struct device *dev)
{
	const struct odd_config *cfg = dev->config;
	struct odd_data *data = dev->data;
	ddpi_profile_v1_t profile;

	ddpi_profile_init_default(&profile, cfg->base_dpi);
	profile.global_gain_q8_8 = cfg->global_gain_q8_8;
	memcpy(profile.multipliers_q8_8, cfg->multipliers_q8_8, sizeof(profile.multipliers_q8_8));
	profile.reserved = (uint16_t)((cfg->idle_5ms << 8) | cfg->window_counts);
	/* Enabled iff the DT curve is not flat (a flat curve is exact passthrough anyway) */
	profile.flags = DDPI_FLAG_ENABLED;
	if (ddpi_profile_is_identity(&profile)) {
		profile.flags = 0;
	}
	ddpi_engine_init(&data->engine, cfg->base_dpi);
	ddpi_engine_set_profile(&data->engine, &profile); /* clamps + signs */

#ifdef CONFIG_SETTINGS
	data->dev = dev;
	k_work_init_delayable(&data->save_work, odd_save_work);
#endif

	if (!device_is_ready(cfg->input_dev)) {
		LOG_ERR("%s: input device not ready", dev->name);
		return -ENODEV;
	}
	return 0;
}

/* Added together with the callback user_data argument (Zephyr 4.0) */
#ifdef INPUT_CALLBACK_DEFINE_NAMED
#define ODD_CALLBACK_DEFINE(inst)                                                                  \
	INPUT_CALLBACK_DEFINE_NAMED(DEVICE_DT_GET(DT_INST_PHANDLE(inst, input)), odd_input_cb,     \
				    (void *)DEVICE_DT_INST_GET(inst), odd_input_cb_##inst)
#else
/* Zephyr < 4.0 (e.g. ZMK v0.3 on 3.5): callbacks have no user_data argument */
#define ODD_CALLBACK_DEFINE(inst)                                                                  \
	static void odd_input_cb_##inst(struct input_event *evt)                                  \
	{                                                                                          \
		odd_input_cb(evt, (void *)DEVICE_DT_INST_GET(inst));                               \
	}                                                                                          \
	INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_INST_PHANDLE(inst, input)), odd_input_cb_##inst)
#endif

#define ODD_DEFINE(inst)                                                                           \
	BUILD_ASSERT(DT_INST_PROP_LEN(inst, multipliers_q8_8) == DDPI_NUM_DIRECTIONS,              \
		     "multipliers-q8-8 needs 8 entries");                                          \
	BUILD_ASSERT(DT_INST_PROP(inst, idle_ms) >= 5 && DT_INST_PROP(inst, idle_ms) <= 1275,      \
		     "idle-ms must be 5..1275");                                                   \
	BUILD_ASSERT(DT_INST_PROP(inst, window_counts) <= DDPI_MAX_WINDOW_COUNTS,                  \
		     "window-counts must be 0..128");                                              \
	ODD_CALLBACK_DEFINE(inst);                                                              \
	static const struct odd_config odd_config_##inst = {                                       \
		.input_dev = DEVICE_DT_GET(DT_INST_PHANDLE(inst, input)),                          \
		.settings_key = "odd/" DEVICE_DT_NAME(DT_DRV_INST(inst)),                          \
		.base_dpi = DT_INST_PROP(inst, base_dpi),                                          \
		.global_gain_q8_8 = DT_INST_PROP(inst, global_gain_q8_8),                          \
		.multipliers_q8_8 = DT_INST_PROP(inst, multipliers_q8_8),                          \
		.window_counts = DT_INST_PROP(inst, window_counts),                                \
		.idle_5ms = DT_INST_PROP(inst, idle_ms) / 5,                                       \
		.merge_axis_syncs = DT_INST_PROP(inst, merge_axis_syncs),                          \
	};                                                                                         \
	static struct odd_data odd_data_##inst;                                                    \
	DEVICE_DT_INST_DEFINE(inst, odd_init, NULL, &odd_data_##inst, &odd_config_##inst,         \
			      POST_KERNEL, CONFIG_INPUT_INIT_PRIORITY, NULL);

DT_INST_FOREACH_STATUS_OKAY(ODD_DEFINE)
