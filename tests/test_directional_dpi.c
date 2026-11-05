/*
 * Open Directional DPI v1 — Comprehensive Unit & Reference Vector Test Suite
 *
 * SPDX-License-Identifier: MIT
 */

#include "../core/directional_dpi.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_tests_run    = 0;
static int g_tests_passed = 0;

#define RUN_TEST(fn)                                                \
    do {                                                            \
        ++g_tests_run;                                              \
        printf("  [TEST %02d] %-48s ... ", g_tests_run, #fn);       \
        fn();                                                       \
        ++g_tests_passed;                                           \
        printf("PASS\n");                                           \
    } while (0)

/* 1. Verify exact 1.00x neutral identity behavior across all quadrants */
static void test_neutral_identity_passthrough(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 800u);

    const int16_t samples[][2] = {
        {0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1},
        {15, -23}, {-120, 85}, {1024, -2048}, {-32767, 32767}
    };

    /* Test both disabled and enabled-with-all-1.00x */
    for (int mode = 0; mode < 2; ++mode) {
        if (mode == 1) {
            eng.profile.flags |= DDPI_FLAG_ENABLED;
            ddpi_profile_sanitize_and_sign(&eng.profile);
        }
        assert(ddpi_profile_is_identity(&eng.profile));

        for (size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); ++i) {
            int16_t ox = 0, oy = 0;
            ddpi_process_delta(&eng, samples[i][0], samples[i][1], &ox, &oy);
            assert(ox == samples[i][0]);
            assert(oy == samples[i][1]);
            assert(eng.rem_x_q16_16 == 0);
            assert(eng.rem_y_q16_16 == 0);
        }
    }
}

/* 2. Verify all 8 cardinal & diagonal control points at exact 45-degree angles */
static void test_eight_octant_control_points(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 1600u);
    eng.profile.flags = DDPI_FLAG_ENABLED;

    const uint16_t mults[8] = {256, 320, 384, 448, 512, 192, 128, 384};
    for (int i = 0; i < 8; ++i) {
        eng.profile.multipliers_q8_8[i] = mults[i];
    }
    ddpi_engine_set_profile(&eng, &eng.profile);

    struct {
        int16_t dx;
        int16_t dy;
        int16_t exp_dx;
        int16_t exp_dy;
    } cases[8] = {
        { 100,    0,  100,    0}, /* E:  1.00x */
        { 100,  100,  125,  125}, /* SE: 1.25x */
        {   0,  100,    0,  150}, /* S:  1.50x */
        {-100,  100, -175,  175}, /* SW: 1.75x */
        {-100,    0, -200,    0}, /* W:  2.00x */
        {-100, -100,  -75,  -75}, /* NW: 0.75x */
        {   0, -100,    0,  -50}, /* N:  0.50x */
        { 100, -100,  150, -150}  /* NE: 1.50x */
    };

    for (int i = 0; i < 8; ++i) {
        ddpi_engine_reset_remainders(&eng);
        int16_t ox = 0, oy = 0;
        ddpi_process_delta(&eng, cases[i].dx, cases[i].dy, &ox, &oy);
        assert(ox == cases[i].exp_dx);
        assert(oy == cases[i].exp_dy);
    }
}

/* 3. Verify 360-degree circular interpolation continuity & monotonicity */
static void test_circular_360_interpolation_continuity(void) {
    ddpi_profile_v1_t prof;
    ddpi_profile_init_default(&prof, 800u);
    prof.flags = DDPI_FLAG_ENABLED;
    prof.multipliers_q8_8[DDPI_DIR_E]  = 256; /* 1.00x */
    prof.multipliers_q8_8[DDPI_DIR_SE] = 320; /* 1.25x */
    prof.multipliers_q8_8[DDPI_DIR_S]  = 384; /* 1.50x */
    prof.multipliers_q8_8[DDPI_DIR_SW] = 320; /* 1.25x */
    prof.multipliers_q8_8[DDPI_DIR_W]  = 256; /* 1.00x */
    prof.multipliers_q8_8[DDPI_DIR_NW] = 224; /* 0.875x */
    prof.multipliers_q8_8[DDPI_DIR_N]  = 192; /* 0.75x */
    prof.multipliers_q8_8[DDPI_DIR_NE] = 224; /* 0.875x */
    ddpi_profile_sanitize_and_sign(&prof);

    uint32_t prev_scale = 0;
    uint32_t first_scale = 0;

    for (int deg = 0; deg <= 360; ++deg) {
        double rad = (double)deg * (3.14159265358979323846 / 180.0);
        int16_t dx = (int16_t)llround(1000.0 * cos(rad));
        int16_t dy = (int16_t)llround(1000.0 * sin(rad));
        uint8_t oct = 0;
        uint32_t sc = ddpi_compute_scale_q16_16(&prof, dx, dy, &oct);
        assert(sc >= (192u << 8) && sc <= (384u << 8));

        if (deg == 0) {
            first_scale = sc;
        } else {
            int32_t diff = (int32_t)sc - (int32_t)prev_scale;
            if (diff < 0) diff = -diff;
            assert(diff < 1600);
        }
        prev_scale = sc;
    }
    assert(prev_scale == first_scale);
}

/* 4. Verify configurable global scalar gain */
static void test_global_scalar_gain(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 800u);
    eng.profile.flags = DDPI_FLAG_ENABLED;
    eng.profile.global_gain_q8_8 = 384; /* 1.50x global gain */
    eng.profile.multipliers_q8_8[DDPI_DIR_E] = 320; /* 1.25x East -> total 1.875x */
    ddpi_engine_set_profile(&eng, &eng.profile);

    int16_t ox = 0, oy = 0;
    ddpi_process_delta(&eng, 80, 0, &ox, &oy);
    assert(ox == 150);
    assert(oy == 0);
}

/* 5. Verify fractional sub-pixel remainder accumulation across slow movements */
static void test_fractional_remainder_accumulation(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 800u);
    eng.profile.flags = DDPI_FLAG_ENABLED;
    eng.profile.multipliers_q8_8[DDPI_DIR_E] = 192; /* 0.75x */
    ddpi_engine_set_profile(&eng, &eng.profile);

    int32_t sum_x = 0;
    int32_t sum_y = 0;
    for (int i = 0; i < 400; ++i) {
        int16_t ox = 0, oy = 0;
        ddpi_process_delta(&eng, 1, 0, &ox, &oy);
        sum_x += ox;
        sum_y += oy;
    }
    assert(sum_x == 300);
    assert(sum_y == 0);
    assert(eng.rem_x_q16_16 == 0);

    eng.profile.multipliers_q8_8[DDPI_DIR_W] = 160; /* 0.625x */
    ddpi_engine_set_profile(&eng, &eng.profile);
    sum_x = 0;
    for (int i = 0; i < 80; ++i) {
        int16_t ox = 0, oy = 0;
        ddpi_process_delta(&eng, -1, 0, &ox, &oy);
        sum_x += ox;
    }
    assert(sum_x == -50);
    assert(eng.rem_x_q16_16 == 0);
}

/* 6. Verify saturation clamping and excess remainder carry */
static void test_saturation_and_overflow(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 1600u);
    eng.profile.flags = DDPI_FLAG_ENABLED;
    eng.profile.global_gain_q8_8 = 512; /* 2.00x */
    for (int i = 0; i < 8; ++i) {
        eng.profile.multipliers_q8_8[i] = 256; /* 1.00x -> combined 2.0x */
    }
    ddpi_engine_set_profile(&eng, &eng.profile);

    int16_t ox = 0, oy = 0;
    /* 20000 * 2.0 = 40000 -> clamps to 32767 and carries 7233 in remainder */
    ddpi_process_delta(&eng, 20000, -20000, &ox, &oy);
    assert(ox == 32767);
    assert(oy == -32767);
    assert(eng.rem_x_q16_16 == (7233 * 65536));
    assert(eng.rem_y_q16_16 == -(7233 * 65536));

    /* Next report with (+1, -1) emits (7233 + 2 = 7235, -7235) */
    ddpi_process_delta(&eng, 1, -1, &ox, &oy);
    assert(ox == 7235);
    assert(oy == -7235);
    assert(eng.rem_x_q16_16 == 0);
    assert(eng.rem_y_q16_16 == 0);
}

/* 7. Verify profile binary serialization, CRC-16-CCITT, and corruption rejection */
static void test_profile_serialization_and_crc(void) {
    ddpi_profile_v1_t p_in;
    ddpi_profile_init_default(&p_in, 1200u);
    p_in.flags = DDPI_FLAG_ENABLED;
    p_in.global_gain_q8_8 = 280;
    for (int i = 0; i < 8; ++i) {
        p_in.multipliers_q8_8[i] = (uint16_t)(200 + i * 20);
    }

    uint8_t buf[DDPI_PROFILE_SERIALIZED_LEN];
    ddpi_profile_serialize(&p_in, buf);

    ddpi_profile_v1_t p_out;
    assert(ddpi_profile_deserialize(buf, &p_out));
    assert(p_out.magic == DDPI_PROFILE_MAGIC);
    assert(p_out.version == DDPI_PROFILE_VERSION);
    assert(p_out.flags == DDPI_FLAG_ENABLED);
    assert(p_out.base_dpi == 1200u);
    assert(p_out.global_gain_q8_8 == 280u);
    for (int i = 0; i < 8; ++i) {
        assert(p_out.multipliers_q8_8[i] == (uint16_t)(200 + i * 20));
    }

    buf[10] ^= 0x01u;
    assert(!ddpi_profile_deserialize(buf, &p_out));
}

/* 8. Verify 64-byte HID Feature report protocol handler */
static void test_hid_protocol_handler(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 800u);

    uint8_t req[DDPI_HID_PACKET_LEN];
    uint8_t resp[DDPI_HID_PACKET_LEN];
    memset(req, 0, sizeof(req));

    req[0] = 0x44u; /* 'D' */
    req[1] = 0x50u; /* 'P' */
    req[2] = DDPI_PROFILE_VERSION;
    req[4] = 0x2Au; /* seq */
    req[5] = DDPI_HID_NAMESPACE;
    req[6] = DDPI_CMD_GET_CAPABILITIES;
    uint16_t crc = ddpi_crc16_ccitt(req, 62u);
    req[62] = (uint8_t)(crc & 0xFFu);
    req[63] = (uint8_t)(crc >> 8);

    assert(ddpi_hid_handle_feature_report(&eng, req, resp, NULL, NULL));
    assert(resp[3] == DDPI_STATUS_OK);
    assert(resp[4] == 0x2Au);
    assert(memcmp(&resp[8], "DP01", 4) == 0);
    assert(ddpi_crc16_ccitt(resp, 62u) == (uint16_t)(resp[62] | (resp[63] << 8)));
}

/* 9. Verify Travel-Window Direction Estimator & Polling-Rate Chunking Invariance */
static void test_travel_window_chunking_invariance(void) {
    ddpi_engine_t eng_1khz;
    ddpi_engine_t eng_8khz;
    ddpi_engine_init(&eng_1khz, 800u);

    /* Profile where East = 1.00x (256), North = 1.00x (256), but NE (45 deg) = 0.50x (128).
     * Without travel-window smoothing, alternating (1,0) and (0,-1) reports at 8 kHz
     * would snap to E (1.00x) and N (1.00x), completely missing the NE (0.50x) diagonal!
     */
    eng_1khz.profile.flags = DDPI_FLAG_ENABLED;
    eng_1khz.profile.multipliers_q8_8[DDPI_DIR_E]  = 256; /* 1.00x */
    eng_1khz.profile.multipliers_q8_8[DDPI_DIR_N]  = 256; /* 1.00x */
    eng_1khz.profile.multipliers_q8_8[DDPI_DIR_NE] = 128; /* 0.50x */
    ddpi_profile_set_window_counts(&eng_1khz.profile, 16u);
    ddpi_engine_set_profile(&eng_1khz, &eng_1khz.profile);

    ddpi_engine_init(&eng_8khz, 800u);
    ddpi_engine_set_profile(&eng_8khz, &eng_1khz.profile);

    /* 1 kHz: 40 diagonal steps of (2, -2) = (80, -80) raw -> (40, -40) scaled */
    int32_t sum_1k_x = 0, sum_1k_y = 0;
    for (int i = 0; i < 40; ++i) {
        int16_t ox = 0, oy = 0;
        ddpi_process_delta(&eng_1khz, 2, -2, &ox, &oy);
        sum_1k_x += ox;
        sum_1k_y += oy;
    }
    assert(sum_1k_x == 40 && sum_1k_y == -40);

    /* 8 kHz: 80 alternating steps of (1, 0) and (0, -1) = (80, -80) raw.
     * With L=16 travel window, the direction estimator tracks ~45 deg (NE) so
     * both X and Y are scaled near 0.50x (within 3 counts of 40) instead of 80!
     */
    int32_t sum_8k_x = 0, sum_8k_y = 0;
    for (int i = 0; i < 80; ++i) {
        int16_t ox = 0, oy = 0;
        ddpi_process_delta(&eng_8khz, 1, 0, &ox, &oy);
        sum_8k_x += ox;
        sum_8k_y += oy;
        ddpi_process_delta(&eng_8khz, 0, -1, &ox, &oy);
        sum_8k_x += ox;
        sum_8k_y += oy;
    }
    assert(abs(sum_8k_x - sum_1k_x) <= 3);
    assert(abs(sum_8k_y - sum_1k_y) <= 3);
}

/* 10. Verify Counter-Clockwise Frame (odd-sensor-ccw) conversion & indexing */
static void test_ccw_frame_conversion(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 800u);
    eng.profile.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW;
    /* In odd-sensor-ccw: index 2 = Away (North, -Y_HID), index 6 = Toward (South, +Y_HID) */
    eng.profile.multipliers_q8_8[DDPI_CCW_AWAY]   = 384; /* 1.50x Away (-Y_HID) */
    eng.profile.multipliers_q8_8[DDPI_CCW_TOWARD] = 128; /* 0.50x Toward (+Y_HID) */
    ddpi_engine_set_profile(&eng, &eng.profile);

    int16_t ox = 0, oy = 0;
    ddpi_process_delta(&eng, 0, -100, &ox, &oy); /* Move Away (-Y_HID) */
    assert(ox == 0 && oy == -150);

    ddpi_engine_reset_remainders(&eng);
    ddpi_process_delta(&eng, 0, 100, &ox, &oy);  /* Move Toward (+Y_HID) */
    assert(ox == 0 && oy == 50);

    /* Convert in-place back to CW frame and verify behavior is identical */
    ddpi_profile_set_ccw_frame(&eng.profile, false);
    assert((eng.profile.flags & DDPI_FLAG_FRAME_SENSOR_CCW) == 0u);
    assert(eng.profile.multipliers_q8_8[DDPI_DIR_N] == 384);
    assert(eng.profile.multipliers_q8_8[DDPI_DIR_S] == 128);
}

/* 11. Verify CPI Headroom Normalization (max internal firmware gain <= 1.00x) */
static void test_cpi_headroom_normalization(void) {
    ddpi_profile_v1_t prof;
    ddpi_profile_init_default(&prof, 800u);
    prof.flags = DDPI_FLAG_ENABLED;
    /* Gains 0.90x .. 1.10x at 800 CPI -> sensor CPI = 880, max internal gain = 1.00x (256) */
    prof.multipliers_q8_8[DDPI_DIR_E] = 282; /* ~1.1015x */
    prof.multipliers_q8_8[DDPI_DIR_S] = 230; /* ~0.8984x */

    uint16_t sensor_cpi = 0;
    ddpi_profile_normalize_cpi_headroom(&prof, &sensor_cpi);
    assert(sensor_cpi >= 880u && sensor_cpi <= 882u);
    for (int i = 0; i < 8; ++i) {
        assert(prof.multipliers_q8_8[i] <= DDPI_Q8_8_ONE);
    }
    assert(prof.multipliers_q8_8[DDPI_DIR_E] == DDPI_Q8_8_ONE);
}

/* 12. Verify Linear 2x2 Matrix Model and Calibration Bypass Mode */
static void test_linear_2x2_and_calibration_bypass(void) {
    ddpi_engine_t eng;
    ddpi_engine_init(&eng, 800u);
    eng.profile.flags = DDPI_FLAG_ENABLED | DDPI_FLAG_MODEL_LINEAR_2X2;
    eng.profile.multipliers_q8_8[DDPI_DIR_E] = 256; /* X gain = 1.00x */
    eng.profile.multipliers_q8_8[DDPI_DIR_N] = 192; /* Y gain = 0.75x */
    ddpi_engine_set_profile(&eng, &eng.profile);

    int16_t ox = 0, oy = 0;
    ddpi_process_delta(&eng, 100, -100, &ox, &oy);
    assert(ox == 100 && oy == -75);

    /* Enable calibration bypass flag -> must become exact 1.00x identity */
    eng.profile.flags |= DDPI_FLAG_BYPASS_FOR_CALIBRATION;
    ddpi_engine_set_profile(&eng, &eng.profile);
    ddpi_process_delta(&eng, 100, -100, &ox, &oy);
    assert(ox == 100 && oy == -100);
}

int main(void) {
    printf("=== Open Directional DPI v1 — Portable C Reference Engine Tests ===\n");
    RUN_TEST(test_neutral_identity_passthrough);
    RUN_TEST(test_eight_octant_control_points);
    RUN_TEST(test_circular_360_interpolation_continuity);
    RUN_TEST(test_global_scalar_gain);
    RUN_TEST(test_fractional_remainder_accumulation);
    RUN_TEST(test_saturation_and_overflow);
    RUN_TEST(test_profile_serialization_and_crc);
    RUN_TEST(test_hid_protocol_handler);
    RUN_TEST(test_travel_window_chunking_invariance);
    RUN_TEST(test_ccw_frame_conversion);
    RUN_TEST(test_cpi_headroom_normalization);
    RUN_TEST(test_linear_2x2_and_calibration_bypass);

    printf("\nAll %d/%d tests passed.\n", g_tests_passed, g_tests_run);
    return (g_tests_passed == g_tests_run) ? 0 : 1;
}
