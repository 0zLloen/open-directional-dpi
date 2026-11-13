/*
 * Open Directional DPI - Zephyr input filter test (native_sim)
 *
 * SPDX-License-Identifier: MIT
 */

#include <string.h>

#include <zephyr/device.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/ztest.h>

#include <odd_input.h>
#include "directional_dpi.h"

DEVICE_DT_DEFINE(DT_NODELABEL(src0), NULL, NULL, NULL, NULL, PRE_KERNEL_1,
		 CONFIG_KERNEL_INIT_PRIORITY_DEVICE, NULL);
DEVICE_DT_DEFINE(DT_NODELABEL(src1), NULL, NULL, NULL, NULL, PRE_KERNEL_1,
		 CONFIG_KERNEL_INIT_PRIORITY_DEVICE, NULL);
DEVICE_DT_DEFINE(DT_NODELABEL(src2), NULL, NULL, NULL, NULL, PRE_KERNEL_1,
		 CONFIG_KERNEL_INIT_PRIORITY_DEVICE, NULL);

static const struct device *const src[3] = {DEVICE_DT_GET(DT_NODELABEL(src0)),
					    DEVICE_DT_GET(DT_NODELABEL(src1)),
					    DEVICE_DT_GET(DT_NODELABEL(src2))};
static const struct device *const filt[3] = {DEVICE_DT_GET(DT_NODELABEL(filter0)),
					     DEVICE_DT_GET(DT_NODELABEL(filter1)),
					     DEVICE_DT_GET(DT_NODELABEL(filter2))};

/* What listeners bound to each filter device received */
static struct input_event recs[3][64];
static size_t nrec[3];

static void record(int n, const struct input_event *evt)
{
	if (nrec[n] < ARRAY_SIZE(recs[n])) {
		recs[n][nrec[n]] = *evt;
	}
	nrec[n]++;
}

/* Added together with the callback user_data argument (Zephyr 4.0) */
#ifdef INPUT_CALLBACK_DEFINE_NAMED
#define RECORDER(n)                                                                                \
	static void rec_cb_##n(struct input_event *evt, void *user_data)                          \
	{                                                                                          \
		ARG_UNUSED(user_data);                                                             \
		record(n, evt);                                                                    \
	}                                                                                          \
	INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_NODELABEL(filter##n)), rec_cb_##n, NULL)
#else
#define RECORDER(n)                                                                                \
	static void rec_cb_##n(struct input_event *evt)                                           \
	{                                                                                          \
		record(n, evt);                                                                    \
	}                                                                                          \
	INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_NODELABEL(filter##n)), rec_cb_##n)
#endif
RECORDER(0);
RECORDER(1);
RECORDER(2);

/* Lets the input thread drain (thread mode); 2 ms of uptime per frame */
static void settle(void)
{
	k_sleep(K_MSEC(2));
}

/* One sensor report: X, then Y carrying the sync. Returns the report time. */
static uint32_t frame(int n, int16_t dx, int16_t dy)
{
	uint32_t now = k_uptime_get_32();

	input_report_rel(src[n], INPUT_REL_X, dx, false, K_FOREVER);
	input_report_rel(src[n], INPUT_REL_Y, dy, true, K_FOREVER);
	settle();
	return now;
}

static void expect_event(int n, size_t i, uint8_t type, uint16_t code, int32_t value, bool sync)
{
	zassert_true(i < MIN(nrec[n], ARRAY_SIZE(recs[n])), "filter%d: no event %zu", n, i);
	const struct input_event *e = &recs[n][i];

	zassert_equal_ptr(e->dev, filt[n], "event %zu not from the filter", i);
	zassert_equal(e->type, type, "event %zu: type %u != %u", i, e->type, type);
	zassert_equal(e->code, code, "event %zu: code %u != %u", i, e->code, code);
	zassert_equal(e->value, value, "event %zu: value %d != %d", i, e->value, value);
	zassert_equal(e->sync, sync, "event %zu: sync %d != %d", i, e->sync, sync);
}

/* A motion frame from the filter: X only if non-zero, then Y with sync */
static void expect_frame(int n, size_t *i, int16_t ox, int16_t oy)
{
	if (ox != 0) {
		expect_event(n, (*i)++, INPUT_EV_REL, INPUT_REL_X, ox, false);
	}
	expect_event(n, (*i)++, INPUT_EV_REL, INPUT_REL_Y, oy, true);
}

static uint8_t hid(int n, uint8_t op, const void *payload, size_t len, uint8_t resp[64])
{
	uint8_t req[64] = {'D', 'P', DDPI_PROFILE_VERSION, 0, 0x5A, DDPI_HID_NAMESPACE, op, 0};

	if (len != 0) {
		memcpy(&req[8], payload, len);
	}
	sys_put_le16(ddpi_crc16_ccitt(req, 62), &req[62]);
	zassert_true(odd_input_hid_feature_report(filt[n], req, resp));
	zassert_equal(resp[6], op);
	return resp[3];
}

static void set_profile(int n, const ddpi_profile_v1_t *p)
{
	uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
	uint8_t resp[64];

	ddpi_profile_serialize(p, raw);
	zassert_equal(hid(n, DDPI_CMD_SET_PROFILE, raw, sizeof(raw), resp), DDPI_STATUS_OK);
}

static void expect_profile(int n, const ddpi_profile_v1_t *p)
{
	uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
	uint8_t resp[64];

	ddpi_profile_serialize(p, raw);
	zassert_equal(hid(n, DDPI_CMD_GET_PROFILE, NULL, 0, resp), DDPI_STATUS_OK);
	zassert_mem_equal(&resp[8], raw, sizeof(raw));
}

static ddpi_profile_v1_t curve(uint8_t window)
{
	static const uint16_t m[DDPI_NUM_DIRECTIONS] = {512, 300, 128, 200, 384, 256, 160, 420};
	ddpi_profile_v1_t p;

	ddpi_profile_init_default(&p, 800);
	p.flags = DDPI_FLAG_ENABLED;
	memcpy(p.multipliers_q8_8, m, sizeof(m));
	ddpi_profile_set_window_counts(&p, window);
	ddpi_profile_sanitize_and_sign(&p);
	return p;
}

/* Same state as the filter after RESET_DEFAULTS + SET_PROFILE */
static void ref_init(ddpi_engine_t *ref, const ddpi_profile_v1_t *p)
{
	ddpi_engine_init(ref, p->base_dpi);
	ddpi_engine_set_profile(ref, p);
}

static void before(void *fixture)
{
	uint8_t resp[64];

	ARG_UNUSED(fixture);
	settle();
	zassert_equal(hid(0, DDPI_CMD_RESET_DEFAULTS, NULL, 0, resp), DDPI_STATUS_OK);
	memset(nrec, 0, sizeof(nrec));
}

ZTEST(odd_filter, test_identity_is_exact_passthrough)
{
	static const int16_t v[][2] = {{0, 5},     {7, 0},  {1, -1},         {-127, 128},
				       {0, 0},     {-3, 300}, {32767, -32767}};
	size_t i = 0;

	for (size_t k = 0; k < ARRAY_SIZE(v); k++) {
		frame(0, v[k][0], v[k][1]);
		expect_frame(0, &i, v[k][0], v[k][1]);
	}
	zassert_equal(nrec[0], i, "extra events");
}

ZTEST(odd_filter, test_no_double_scaling)
{
	ddpi_profile_v1_t p = curve(0); /* E = 2.00x */
	size_t i = 0;

	set_profile(0, &p);
	for (int k = 0; k < 5; k++) {
		frame(0, 10, 0);
		expect_frame(0, &i, 20, 0);
	}
	zassert_equal(nrec[0], i, "extra events");
}

ZTEST(odd_filter, test_frames_match_engine_once_each)
{
	ddpi_profile_v1_t p = curve(DDPI_DEFAULT_WINDOW_COUNTS);
	ddpi_engine_t ref;
	uint32_t seed = 12345u;
	size_t i = 0;

	set_profile(0, &p);
	ref_init(&ref, &p);
	for (int k = 0; k < 24; k++) {
		int16_t ox;
		int16_t oy;

		seed = seed * 1103515245u + 12345u;
		int16_t dx = (int16_t)((seed >> 16) % 61u) - 30;
		int16_t dy = (int16_t)((seed >> 4) % 61u) - 30;
		uint32_t t = frame(0, dx, dy);

		ddpi_process_motion(&ref, dx, dy, t, &ox, &oy);
		expect_frame(0, &i, ox, oy);
	}
	zassert_equal(nrec[0], i, "extra events");
}

ZTEST(odd_filter, test_idle_gap_restarts_direction)
{
	ddpi_profile_v1_t p = curve(DDPI_MAX_WINDOW_COUNTS);
	ddpi_engine_t ref;
	ddpi_engine_t no_gap;
	int16_t ox;
	int16_t oy;
	size_t i = 0;

	set_profile(0, &p);
	ref_init(&ref, &p);
	for (int k = 0; k < 10; k++) {
		uint32_t t = frame(0, 20, 0);

		ddpi_process_motion(&ref, 20, 0, t, &ox, &oy);
		expect_frame(0, &i, ox, oy);
	}
	no_gap = ref;

	k_sleep(K_MSEC(100));
	uint32_t t = frame(0, 0, -3);

	ddpi_process_motion(&ref, 0, -3, t, &ox, &oy);
	expect_frame(0, &i, ox, oy);

	/* Without the gap the old E direction would still dominate */
	int16_t gx;
	int16_t gy;

	ddpi_process_delta(&no_gap, 0, -3, &gx, &gy);
	zassert_not_equal(gy, oy, "test does not exercise the idle reset");
}

ZTEST(odd_filter, test_other_events_forwarded)
{
	size_t i = 0;

	input_report_key(src[0], INPUT_BTN_LEFT, 1, true, K_FOREVER);
	input_report_rel(src[0], INPUT_REL_WHEEL, -1, true, K_FOREVER);
	input_report_abs(src[0], INPUT_ABS_X, 1234, true, K_FOREVER);
	/* Frame whose sync rides on a button: motion goes out first, same frame */
	input_report_rel(src[0], INPUT_REL_X, 5, false, K_FOREVER);
	input_report_key(src[0], INPUT_BTN_RIGHT, 1, false, K_FOREVER);
	input_report_key(src[0], INPUT_BTN_LEFT, 0, true, K_FOREVER);
	settle();

	expect_event(0, i++, INPUT_EV_KEY, INPUT_BTN_LEFT, 1, true);
	expect_event(0, i++, INPUT_EV_REL, INPUT_REL_WHEEL, -1, true);
	expect_event(0, i++, INPUT_EV_ABS, INPUT_ABS_X, 1234, true);
	expect_event(0, i++, INPUT_EV_KEY, INPUT_BTN_RIGHT, 1, false);
	expect_event(0, i++, INPUT_EV_REL, INPUT_REL_X, 5, false);
	expect_event(0, i++, INPUT_EV_KEY, INPUT_BTN_LEFT, 0, true);
	zassert_equal(nrec[0], i, "extra events");
}

/* wch,ch9350l reports X and Y each with sync: with merge-axis-syncs that is one frame */
ZTEST(odd_filter, test_merge_axis_syncs)
{
	ddpi_profile_v1_t p = curve(0); /* per-report direction: split frames would only see E and S */
	ddpi_engine_t ref;
	uint8_t resp[64];
	size_t i = 0;

	zassert_equal(hid(2, DDPI_CMD_RESET_DEFAULTS, NULL, 0, resp), DDPI_STATUS_OK);
	set_profile(2, &p);
	ref_init(&ref, &p);
	for (int k = 0; k < 4; k++) {
		int16_t ox;
		int16_t oy;
		uint32_t t = k_uptime_get_32();

		input_report_rel(src[2], INPUT_REL_X, 10, true, K_FOREVER);
		input_report_rel(src[2], INPUT_REL_Y, 10, true, K_FOREVER);
		settle();
		ddpi_process_motion(&ref, 10, 10, t, &ox, &oy);
		expect_frame(2, &i, ox, oy);
	}
	zassert_equal(nrec[2], i, "extra events");
}

ZTEST(odd_filter, test_hid_capabilities_and_profile)
{
	ddpi_profile_v1_t p = curve(DDPI_DEFAULT_WINDOW_COUNTS);
	uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
	uint8_t resp[64];
	uint8_t magic[4];
	uint8_t junk[64] = {0};

	zassert_equal(hid(0, DDPI_CMD_GET_CAPABILITIES, NULL, 0, resp), DDPI_STATUS_OK);
	zassert_mem_equal(&resp[8], "DP01", 4);
	zassert_equal(resp[8 + 5], 1, "max_slots");
	zassert_equal(resp[8 + 7], 0x30 | (IS_ENABLED(CONFIG_SETTINGS) ? 0x02 : 0), "hw flags");
	zassert_equal(sys_get_le16(&resp[8 + 10]), DDPI_DPI_MAX);

	set_profile(0, &p);
	expect_profile(0, &p);

	/* A profile with a broken CRC is refused and changes nothing */
	ddpi_profile_v1_t q = curve(0);

	ddpi_profile_serialize(&q, raw);
	raw[10] ^= 1;
	zassert_equal(hid(0, DDPI_CMD_SET_PROFILE, raw, sizeof(raw), resp),
		      DDPI_STATUS_ERR_CRC_OR_FMT);
	expect_profile(0, &p);

	sys_put_le32(DDPI_BOOTLOADER_MAGIC_ARG, magic);
	zassert_equal(hid(0, DDPI_CMD_ENTER_BOOTLOADER, magic, sizeof(magic), resp),
		      DDPI_STATUS_ERR_UNSUPPORTED);

	zassert_false(odd_input_hid_feature_report(filt[0], junk, resp));
}

ZTEST(odd_filter, test_instances_are_independent)
{
	static const uint16_t m[DDPI_NUM_DIRECTIONS] = {512, 256, 128, 256, 384, 256, 200, 256};
	ddpi_profile_v1_t dt;
	ddpi_engine_t ref;
	size_t i = 0;
	size_t j = 0;

	/* filter1 boots with its devicetree curve (see app.overlay) */
	ddpi_profile_init_default(&dt, 1600);
	dt.flags = DDPI_FLAG_ENABLED;
	memcpy(dt.multipliers_q8_8, m, sizeof(m));
	dt.reserved = (uint16_t)(((100 / 5) << 8) | 8);
	ddpi_profile_sanitize_and_sign(&dt);
	expect_profile(1, &dt);

	ref_init(&ref, &dt);
	for (int k = 0; k < 3; k++) {
		int16_t ox;
		int16_t oy;
		uint32_t t = frame(1, 9, 4);

		ddpi_process_motion(&ref, 9, 4, t, &ox, &oy);
		expect_frame(1, &i, ox, oy);
	}
	zassert_equal(nrec[1], i, "extra events");
	zassert_equal(nrec[0], 0, "filter0 saw src1");

	frame(0, 9, 4);
	expect_frame(0, &j, 9, 4);
	zassert_equal(nrec[0], j, "extra events");
	zassert_equal(nrec[1], i, "filter1 saw src0");
}

ZTEST(odd_filter, test_save_flash)
{
	uint8_t resp[64];

#ifdef CONFIG_SETTINGS
	ddpi_profile_v1_t p = curve(DDPI_DEFAULT_WINDOW_COUNTS);
	ddpi_profile_v1_t q = curve(0);
	uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
	char key[SETTINGS_MAX_NAME_LEN + 1];

	snprintk(key, sizeof(key), "odd/%s", filt[0]->name);
	zassert_ok(settings_subsys_init());

	set_profile(0, &p);
	zassert_equal(hid(0, DDPI_CMD_SAVE_FLASH, NULL, 0, resp), DDPI_STATUS_OK);
	k_sleep(K_MSEC(CONFIG_ODD_DIRECTIONAL_DPI_SAVE_DELAY_MS + 50));
	set_profile(0, &q);
	zassert_ok(settings_load_subtree("odd"));
	expect_profile(0, &p);

	/* Corrupt or truncated stored data is ignored */
	set_profile(0, &q);
	ddpi_profile_serialize(&p, raw);
	raw[27] ^= 0xFF;
	zassert_ok(settings_save_one(key, raw, sizeof(raw)));
	zassert_ok(settings_load_subtree("odd"));
	expect_profile(0, &q);
	ddpi_profile_serialize(&p, raw);
	zassert_ok(settings_save_one(key, raw, sizeof(raw) - 1));
	zassert_ok(settings_load_subtree("odd"));
	expect_profile(0, &q);
#else
	zassert_equal(hid(0, DDPI_CMD_SAVE_FLASH, NULL, 0, resp), DDPI_STATUS_ERR_UNSUPPORTED);
#endif
}

/*
 * A sensor reporting with K_FOREVER faster than the input thread drains keeps the
 * input queue full (this cooperative test thread outranks the input thread, and
 * each freed slot goes straight to it). The filter must still pass every event.
 */
ZTEST(odd_filter, test_full_input_queue_loses_nothing)
{
	const int frames = 64; /* 128 events, well over CONFIG_INPUT_QUEUE_MAX_MSGS */

	for (int k = 0; k < frames; k++) {
		input_report_rel(src[0], INPUT_REL_X, 10, false, K_FOREVER);
		input_report_rel(src[0], INPUT_REL_Y, 0, true, K_FOREVER);
	}
	settle();
	zassert_equal(nrec[0], 2 * frames, "filter passed %zu of %d events", nrec[0], 2 * frames);
}

ZTEST_SUITE(odd_filter, NULL, NULL, before, NULL, NULL);
