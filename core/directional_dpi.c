/*
 * Open Directional DPI (ODD) v1 — Portable C Reference Engine Implementation
 *
 * SPDX-License-Identifier: MIT
 */

#include "directional_dpi.h"

#if defined(__STDC_HOSTED__) && (__STDC_HOSTED__ == 1)
#include <string.h>
#else
extern void *memcpy(void *dst, const void *src, size_t n);
extern void *memset(void *dst, int c, size_t n);
#endif

/* Little-endian pack/unpack helpers */
static inline uint16_t read_u16_le(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static inline uint32_t read_u32_le(const uint8_t *p) {
    return (uint32_t)p[0]
         | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16)
         | ((uint32_t)p[3] << 24);
}

static inline void write_u16_le(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
}

static inline void write_u32_le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
    p[2] = (uint8_t)((v >> 16) & 0xFFu);
    p[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static inline uint16_t clamp_q8_8(uint16_t val) {
    if (val < DDPI_Q8_8_MIN) {
        return DDPI_Q8_8_MIN;
    }
    if (val > DDPI_Q8_8_MAX) {
        return DDPI_Q8_8_MAX;
    }
    return val;
}

static inline uint16_t clamp_dpi(uint16_t dpi) {
    /* Upper bound is the full uint16 range (DDPI_DPI_MAX) */
    return (dpi < DDPI_DPI_MIN) ? (uint16_t)DDPI_DPI_MIN : dpi;
}

static inline uint32_t abs_i16_to_u32(int16_t v) {
    return (v < 0) ? (uint32_t)(-(int32_t)v) : (uint32_t)v;
}

static inline uint32_t abs_i32_to_u32(int32_t v) {
    return (v < 0) ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
}

uint16_t ddpi_crc16_ccitt(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFFu;
    for (size_t i = 0; i < len; ++i) {
        crc ^= (uint16_t)((uint16_t)data[i] << 8);
        for (uint8_t b = 0; b < 8u; ++b) {
            if ((crc & 0x8000u) != 0u) {
                crc = (uint16_t)((crc << 1) ^ 0x1021u);
            } else {
                crc = (uint16_t)(crc << 1);
            }
        }
    }
    return crc;
}

void ddpi_profile_init_default(ddpi_profile_v1_t *profile, uint16_t base_dpi) {
    if (profile == NULL) {
        return;
    }
    memset(profile, 0, sizeof(*profile));
    profile->magic            = DDPI_PROFILE_MAGIC;
    profile->version          = DDPI_PROFILE_VERSION;
    profile->flags            = 0u; /* Disabled by default; neutral 1.00x */
    profile->base_dpi         = clamp_dpi(base_dpi == 0u ? 800u : base_dpi);
    profile->global_gain_q8_8 = DDPI_Q8_8_ONE;
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        profile->multipliers_q8_8[i] = DDPI_Q8_8_ONE;
    }
    profile->reserved = 0u;
    ddpi_profile_sanitize_and_sign(profile);
}

void ddpi_profile_sanitize_and_sign(ddpi_profile_v1_t *profile) {
    if (profile == NULL) {
        return;
    }
    profile->magic            = DDPI_PROFILE_MAGIC;
    profile->version          = DDPI_PROFILE_VERSION;
    profile->base_dpi         = clamp_dpi(profile->base_dpi);
    profile->global_gain_q8_8 = clamp_q8_8(profile->global_gain_q8_8);
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        profile->multipliers_q8_8[i] = clamp_q8_8(profile->multipliers_q8_8[i]);
    }
    uint8_t win = (uint8_t)(profile->reserved & 0xFFu);
    if (win > DDPI_MAX_WINDOW_COUNTS) {
        win = DDPI_MAX_WINDOW_COUNTS;
    }
    profile->reserved = (uint16_t)((profile->reserved & 0xFF00u) | (uint16_t)win);

    uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
    write_u16_le(&raw[0], profile->magic);
    raw[2] = profile->version;
    raw[3] = profile->flags;
    write_u16_le(&raw[4], profile->base_dpi);
    write_u16_le(&raw[6], profile->global_gain_q8_8);
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        write_u16_le(&raw[8u + i * 2u], profile->multipliers_q8_8[i]);
    }
    write_u16_le(&raw[24], profile->reserved);
    profile->crc16 = ddpi_crc16_ccitt(raw, 26u);
}

void ddpi_profile_normalize_cpi_headroom(ddpi_profile_v1_t *profile, uint16_t *out_sensor_cpi) {
    if (profile == NULL) {
        return;
    }
    uint32_t max_eff_q16 = 0u;
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        uint32_t eff = (uint32_t)profile->multipliers_q8_8[i] * (uint32_t)profile->global_gain_q8_8;
        if (eff > max_eff_q16) {
            max_eff_q16 = eff;
        }
    }

    /* If maximum effective gain is already <= 1.00x (65536 in Q16.16), no sensor CPI boost needed */
    if (max_eff_q16 <= 65536u || max_eff_q16 == 0u) {
        if (out_sensor_cpi != NULL) {
            *out_sensor_cpi = profile->base_dpi;
        }
        ddpi_profile_sanitize_and_sign(profile);
        return;
    }

    /* 64-bit product: base_dpi (<= 65535) * max_eff (<= 16.0x in Q16.16) overflows uint32 */
    uint64_t boosted_cpi = ((uint64_t)profile->base_dpi * max_eff_q16 + 32768u) >> 16;
    uint16_t clamped_cpi = clamp_dpi((uint16_t)(boosted_cpi > DDPI_DPI_MAX ? DDPI_DPI_MAX : boosted_cpi));
    if (out_sensor_cpi != NULL) {
        *out_sensor_cpi = clamped_cpi;
    }

    /* Normalize multipliers so max effective multiplier == 1.00x (256 in Q8.8) and global_gain == 1.00x */
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        uint32_t eff_i    = (uint32_t)profile->multipliers_q8_8[i] * (uint32_t)profile->global_gain_q8_8;
        uint32_t norm_q8  = (eff_i * 256u + (max_eff_q16 >> 1)) / max_eff_q16;
        if (norm_q8 > DDPI_Q8_8_ONE) {
            norm_q8 = DDPI_Q8_8_ONE;
        }
        profile->multipliers_q8_8[i] = clamp_q8_8((uint16_t)norm_q8);
    }
    profile->global_gain_q8_8 = DDPI_Q8_8_ONE;
    ddpi_profile_sanitize_and_sign(profile);
}

void ddpi_profile_set_ccw_frame(ddpi_profile_v1_t *profile, bool use_ccw_frame) {
    if (profile == NULL) {
        return;
    }
    bool currently_ccw = (profile->flags & DDPI_FLAG_FRAME_SENSOR_CCW) != 0u;
    if (currently_ccw == use_ccw_frame) {
        return;
    }
    /* Flip sectors 1..7: index i <-> (8 - i) & 7 */
    for (size_t i = 1u; i < 4u; ++i) {
        size_t opp = 8u - i;
        uint16_t tmp = profile->multipliers_q8_8[i];
        profile->multipliers_q8_8[i]   = profile->multipliers_q8_8[opp];
        profile->multipliers_q8_8[opp] = tmp;
    }
    if (use_ccw_frame) {
        profile->flags |= DDPI_FLAG_FRAME_SENSOR_CCW;
    } else {
        profile->flags &= (uint8_t)~DDPI_FLAG_FRAME_SENSOR_CCW;
    }
    ddpi_profile_sanitize_and_sign(profile);
}

void ddpi_profile_serialize(const ddpi_profile_v1_t *profile, uint8_t out_buf[DDPI_PROFILE_SERIALIZED_LEN]) {
    if (profile == NULL || out_buf == NULL) {
        return;
    }
    ddpi_profile_v1_t clean = *profile;
    ddpi_profile_sanitize_and_sign(&clean);

    write_u16_le(&out_buf[0], clean.magic);
    out_buf[2] = clean.version;
    out_buf[3] = clean.flags;
    write_u16_le(&out_buf[4], clean.base_dpi);
    write_u16_le(&out_buf[6], clean.global_gain_q8_8);
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        write_u16_le(&out_buf[8u + i * 2u], clean.multipliers_q8_8[i]);
    }
    write_u16_le(&out_buf[24], clean.reserved);
    write_u16_le(&out_buf[26], clean.crc16);
}

bool ddpi_profile_deserialize(const uint8_t in_buf[DDPI_PROFILE_SERIALIZED_LEN], ddpi_profile_v1_t *out_profile) {
    if (in_buf == NULL || out_profile == NULL) {
        return false;
    }
    uint16_t magic   = read_u16_le(&in_buf[0]);
    uint8_t  version = in_buf[2];
    if (magic != DDPI_PROFILE_MAGIC || version != DDPI_PROFILE_VERSION) {
        return false;
    }

    uint16_t expected_crc = ddpi_crc16_ccitt(in_buf, 26u);
    uint16_t actual_crc   = read_u16_le(&in_buf[26]);
    if (expected_crc != actual_crc) {
        return false;
    }

    uint16_t base_dpi = read_u16_le(&in_buf[4]);
    uint16_t gain     = read_u16_le(&in_buf[6]);
    if (base_dpi < DDPI_DPI_MIN || gain < DDPI_Q8_8_MIN || gain > DDPI_Q8_8_MAX) {
        return false;
    }

    ddpi_profile_v1_t p;
    p.magic            = magic;
    p.version          = version;
    p.flags            = in_buf[3];
    p.base_dpi         = base_dpi;
    p.global_gain_q8_8 = gain;
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        uint16_t m = read_u16_le(&in_buf[8u + i * 2u]);
        if (m < DDPI_Q8_8_MIN || m > DDPI_Q8_8_MAX) {
            return false;
        }
        p.multipliers_q8_8[i] = m;
    }
    p.reserved = read_u16_le(&in_buf[24]);
    p.crc16    = actual_crc;
    *out_profile = p;
    return true;
}

bool ddpi_profile_is_identity(const ddpi_profile_v1_t *profile) {
    if (profile == NULL) {
        return true;
    }
    if ((profile->flags & DDPI_FLAG_ENABLED) == 0u ||
        (profile->flags & DDPI_FLAG_BYPASS_FOR_CALIBRATION) != 0u) {
        return true;
    }
    if (profile->global_gain_q8_8 != DDPI_Q8_8_ONE) {
        return false;
    }
    for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
        if (profile->multipliers_q8_8[i] != DDPI_Q8_8_ONE) {
            return false;
        }
    }
    return true;
}

void ddpi_engine_init(ddpi_engine_t *engine, uint16_t base_dpi) {
    if (engine == NULL) {
        return;
    }
    ddpi_profile_init_default(&engine->profile, base_dpi);
    engine->rem_x_q16_16      = 0;
    engine->rem_y_q16_16      = 0;
    engine->dir_x_q16_16      = 0;
    engine->dir_y_q16_16      = 0;
    engine->last_octant       = 0u;
    engine->last_scale_q16_16 = DDPI_Q16_16_ONE;
    engine->last_motion_ms    = 0u;
}

void ddpi_engine_reset_remainders(ddpi_engine_t *engine) {
    if (engine == NULL) {
        return;
    }
    engine->rem_x_q16_16 = 0;
    engine->rem_y_q16_16 = 0;
    engine->dir_x_q16_16 = 0;
    engine->dir_y_q16_16 = 0;
}

void ddpi_engine_notify_idle(ddpi_engine_t *engine) {
    if (engine == NULL) {
        return;
    }
    engine->dir_x_q16_16 = 0;
    engine->dir_y_q16_16 = 0;
}

void ddpi_engine_set_profile(ddpi_engine_t *engine, const ddpi_profile_v1_t *profile) {
    if (engine == NULL || profile == NULL) {
        return;
    }
    engine->profile = *profile;
    ddpi_profile_sanitize_and_sign(&engine->profile);
    if (ddpi_profile_is_identity(&engine->profile)) {
        ddpi_engine_reset_remainders(engine);
    }
}

static inline uint16_t get_sector_multiplier_q8_8(const ddpi_profile_v1_t *profile, uint8_t hid_cw_idx) {
    uint8_t idx = (uint8_t)(hid_cw_idx & 7u);
    if ((profile->flags & DDPI_FLAG_FRAME_SENSOR_CCW) != 0u) {
        /* Map HID CW index (0=E,1=SE,2=S..7=NE) to Tabletop CCW index (0=E,1=NE,2=N..7=SE) */
        idx = (uint8_t)((8u - idx) & 7u);
    }
    return profile->multipliers_q8_8[idx];
}

uint32_t ddpi_compute_scale_q16_16(
    const ddpi_profile_v1_t *profile,
    int16_t dx,
    int16_t dy,
    uint8_t *out_octant
) {
    if (profile == NULL || (dx == 0 && dy == 0) || ddpi_profile_is_identity(profile)) {
        if (out_octant != NULL) {
            *out_octant = 0u;
        }
        return (uint32_t)DDPI_Q16_16_ONE;
    }

    uint32_t ax = abs_i16_to_u32(dx);
    uint32_t ay = abs_i16_to_u32(dy);

    uint8_t  card_idx = DDPI_DIR_E;
    uint8_t  diag_idx = DDPI_DIR_SE;
    uint8_t  octant   = 0u;
    uint32_t u        = ax;
    uint32_t v        = ay;

    if (dx >= 0 && dy >= 0) {
        if (ax >= ay) {
            card_idx = DDPI_DIR_E;
            diag_idx = DDPI_DIR_SE;
            octant   = 0u;
            u        = ax;
            v        = ay;
        } else {
            card_idx = DDPI_DIR_S;
            diag_idx = DDPI_DIR_SE;
            octant   = 1u;
            u        = ay;
            v        = ax;
        }
    } else if (dx < 0 && dy >= 0) {
        if (ay >= ax) {
            card_idx = DDPI_DIR_S;
            diag_idx = DDPI_DIR_SW;
            octant   = 2u;
            u        = ay;
            v        = ax;
        } else {
            card_idx = DDPI_DIR_W;
            diag_idx = DDPI_DIR_SW;
            octant   = 3u;
            u        = ax;
            v        = ay;
        }
    } else if (dx < 0 && dy < 0) {
        if (ax >= ay) {
            card_idx = DDPI_DIR_W;
            diag_idx = DDPI_DIR_NW;
            octant   = 4u;
            u        = ax;
            v        = ay;
        } else {
            card_idx = DDPI_DIR_N;
            diag_idx = DDPI_DIR_NW;
            octant   = 5u;
            u        = ay;
            v        = ax;
        }
    } else { /* dx >= 0 && dy < 0 */
        if (ay >= ax) {
            card_idx = DDPI_DIR_N;
            diag_idx = DDPI_DIR_NE;
            octant   = 6u;
            u        = ay;
            v        = ax;
        } else {
            card_idx = DDPI_DIR_E;
            diag_idx = DDPI_DIR_NE;
            octant   = 7u;
            u        = ax;
            v        = ay;
        }
    }

    if (out_octant != NULL) {
        *out_octant = octant;
    }

    /* Compute tangent ratio r = (v << 16) / u in [0, 65536] using 32-bit hardware udiv */
    uint32_t r = 0u;
    if (v >= u && u > 0u) {
        r = 65536u;
    } else if (v > 0u) {
        r = (v << 16) / u;
    }
    uint32_t t = r;

    if ((profile->flags & DDPI_FLAG_LINEAR_OCTANT_RATIO) == 0u && r > 0u && r < 65536u) {
        /*
         * True circular angular interpolation:
         * (4/pi)*atan(x) ~= x + 0.3477 * x * (1 - x)   (max error 0.21 deg over 0..45 deg)
         * In Q16.16: 0.3477 * 65536 = 22787
         */
        uint64_t one_minus_r = (uint64_t)(65536u - r);
        uint64_t corr        = (22787ULL * (uint64_t)r * one_minus_r) >> 32;
        t = r + (uint32_t)corr;
        if (t > 65536u) {
            t = 65536u;
        }
    }

    int32_t m_card_q16 = (int32_t)((uint32_t)get_sector_multiplier_q8_8(profile, card_idx) << 8);
    int32_t m_diag_q16 = (int32_t)((uint32_t)get_sector_multiplier_q8_8(profile, diag_idx) << 8);
    int32_t diff_q16   = m_diag_q16 - m_card_q16;
    int32_t m_dir_q16  = m_card_q16 + (int32_t)(((int64_t)diff_q16 * (int64_t)t) >> 16);

    uint32_t scaled_q16 = (uint32_t)(((uint64_t)(uint32_t)m_dir_q16 * (uint64_t)profile->global_gain_q8_8) >> 8);
    return scaled_q16;
}

static inline int64_t div_i64_by_65536_trunc(int64_t val) {
    if (val >= 0) {
        return (int64_t)((uint64_t)val >> 16);
    } else {
        uint64_t mag = (uint64_t)(-val);
        return -(int64_t)(mag >> 16);
    }
}

static inline int32_t clamp_rem_i32(int64_t rem) {
    if (rem > 2147418112LL) {
        return 2147418112;
    }
    if (rem < -2147418112LL) {
        return -2147418112;
    }
    return (int32_t)rem;
}

static inline int16_t emit_from_q16_with_remainder(
    int64_t scaled_delta_q16,
    int16_t raw_delta,
    int32_t *rem_q16_16,
    bool reset_rem_on_reverse
) {
    if (scaled_delta_q16 == 0 && raw_delta == 0) {
        return 0;
    }

    if (reset_rem_on_reverse) {
        if ((raw_delta > 0 && *rem_q16_16 < 0) || (raw_delta < 0 && *rem_q16_16 > 0)) {
            *rem_q16_16 = 0;
        }
    }

    int64_t total_q16 = scaled_delta_q16 + (int64_t)(*rem_q16_16);
    int64_t out_int   = div_i64_by_65536_trunc(total_q16);

    if (out_int > 32767LL) {
        out_int = 32767LL;
    } else if (out_int < -32767LL) {
        out_int = -32767LL;
    }

    /* Carry any excess beyond report clamp in remainder instead of dropping it */
    int64_t new_rem = total_q16 - (out_int * 65536LL);
    *rem_q16_16 = clamp_rem_i32(new_rem);
    return (int16_t)out_int;
}

/*
 * Update travel-window smoothed direction vector d_k and return normalized int16
 * components (est_dx, est_dy) suitable for ddpi_compute_scale_q16_16().
 */
static void update_direction_estimator(
    ddpi_engine_t *engine,
    int16_t in_dx,
    int16_t in_dy,
    int16_t *est_dx,
    int16_t *est_dy
) {
    uint8_t L = ddpi_profile_get_window_counts(&engine->profile);
    if (L == 0u) {
        *est_dx = in_dx;
        *est_dy = in_dy;
        return;
    }

    uint32_t step_l1 = abs_i16_to_u32(in_dx) + abs_i16_to_u32(in_dy);
    if (step_l1 == 0u) {
        *est_dx = 0;
        *est_dy = 0;
        return;
    }

    int64_t next_x = (int64_t)in_dx * 256LL;
    int64_t next_y = (int64_t)in_dy * 256LL;

    if (engine->dir_x_q16_16 != 0 || engine->dir_y_q16_16 != 0) {
        /*
         * Second-order rational Padé decay for exp(-step_l1 / L):
         *   alpha = (2*L) / (2*L + step_l1) in Q16.16
         */
        uint32_t two_L     = (uint32_t)L * 2u;
        uint32_t denom     = two_L + step_l1;
        uint32_t alpha_q16 = (two_L << 16) / denom;

        next_x += ((int64_t)engine->dir_x_q16_16 * (int64_t)alpha_q16) >> 16;
        next_y += ((int64_t)engine->dir_y_q16_16 * (int64_t)alpha_q16) >> 16;
    }

    /*
     * Keep |d| <= 16383 so the int16 estimate below never wraps. This must also run
     * for the first sample after idle: |in| >= 128 counts would otherwise wrap and
     * pick the opposite octant's multiplier. Halving both axes preserves the angle.
     */
    uint32_t mag_x = abs_i32_to_u32((int32_t)next_x);
    uint32_t mag_y = abs_i32_to_u32((int32_t)next_y);
    while (mag_x > 16383u || mag_y > 16383u) {
        next_x >>= 1;
        next_y >>= 1;
        mag_x  >>= 1;
        mag_y  >>= 1;
    }
    engine->dir_x_q16_16 = (int32_t)next_x;
    engine->dir_y_q16_16 = (int32_t)next_y;

    *est_dx = (int16_t)engine->dir_x_q16_16;
    *est_dy = (int16_t)engine->dir_y_q16_16;
}

void ddpi_process_delta(
    ddpi_engine_t *engine,
    int16_t in_dx,
    int16_t in_dy,
    int16_t *out_dx,
    int16_t *out_dy
) {
    int16_t dummy_x = 0;
    int16_t dummy_y = 0;
    if (out_dx == NULL) {
        out_dx = &dummy_x;
    }
    if (out_dy == NULL) {
        out_dy = &dummy_y;
    }

    if (engine == NULL) {
        *out_dx = in_dx;
        *out_dy = in_dy;
        return;
    }

    /* Exact 1.00x bypass when disabled, in calibration bypass, or all multipliers == 1.00x */
    if (ddpi_profile_is_identity(&engine->profile)) {
        engine->last_scale_q16_16 = DDPI_Q16_16_ONE;
        *out_dx = (in_dx < -32767) ? -32767 : in_dx;
        *out_dy = (in_dy < -32767) ? -32767 : in_dy;
        return;
    }

    if (in_dx == 0 && in_dy == 0) {
        *out_dx = 0;
        *out_dy = 0;
        return;
    }

    bool reset_rem = (engine->profile.flags & DDPI_FLAG_RESET_REMAINDER_ON_REVERSE) != 0u;

    /* Optional stateless linear 2x2 matrix model (polling-rate invariant symmetric anisotropy + shear) */
    if ((engine->profile.flags & DDPI_FLAG_MODEL_LINEAR_2X2) != 0u) {
        int32_t gx_q16  = (int32_t)(((uint32_t)get_sector_multiplier_q8_8(&engine->profile, DDPI_DIR_E) *
                                     (uint32_t)engine->profile.global_gain_q8_8));
        int32_t gy_q16  = (int32_t)(((uint32_t)get_sector_multiplier_q8_8(&engine->profile, DDPI_DIR_N) *
                                     (uint32_t)engine->profile.global_gain_q8_8));
        int32_t gne_q16 = (int32_t)(((uint32_t)get_sector_multiplier_q8_8(&engine->profile, DDPI_DIR_NE) *
                                     (uint32_t)engine->profile.global_gain_q8_8));
        int32_t gnw_q16 = (int32_t)(((uint32_t)get_sector_multiplier_q8_8(&engine->profile, DDPI_DIR_NW) *
                                     (uint32_t)engine->profile.global_gain_q8_8));
        int32_t shear_q16 = (gne_q16 - gnw_q16) / 2;

        int64_t scaled_x = (int64_t)in_dx * (int64_t)gx_q16 - (int64_t)in_dy * (int64_t)shear_q16;
        int64_t scaled_y = (int64_t)in_dy * (int64_t)gy_q16 - (int64_t)in_dx * (int64_t)shear_q16;

        engine->last_scale_q16_16 = (uint32_t)((gx_q16 + gy_q16) / 2);
        *out_dx = emit_from_q16_with_remainder(scaled_x, in_dx, &engine->rem_x_q16_16, reset_rem);
        *out_dy = emit_from_q16_with_remainder(scaled_y, in_dy, &engine->rem_y_q16_16, reset_rem);
        return;
    }

    int16_t est_dx = in_dx;
    int16_t est_dy = in_dy;
    update_direction_estimator(engine, in_dx, in_dy, &est_dx, &est_dy);

    uint8_t  octant = 0u;
    uint32_t scale_q16_16 = ddpi_compute_scale_q16_16(&engine->profile, est_dx, est_dy, &octant);
    engine->last_octant       = octant;
    engine->last_scale_q16_16 = scale_q16_16;

    int64_t scaled_x = (int64_t)in_dx * (int64_t)scale_q16_16;
    int64_t scaled_y = (int64_t)in_dy * (int64_t)scale_q16_16;
    *out_dx = emit_from_q16_with_remainder(scaled_x, in_dx, &engine->rem_x_q16_16, reset_rem);
    *out_dy = emit_from_q16_with_remainder(scaled_y, in_dy, &engine->rem_y_q16_16, reset_rem);
}

void ddpi_process_motion(
    ddpi_engine_t *engine,
    int16_t in_dx,
    int16_t in_dy,
    uint32_t now_ms,
    int16_t *out_dx,
    int16_t *out_dy
) {
    if (engine != NULL && (in_dx != 0 || in_dy != 0)) {
        if ((uint32_t)(now_ms - engine->last_motion_ms) >= ddpi_profile_get_idle_ms(&engine->profile)) {
            ddpi_engine_notify_idle(engine);
        }
        engine->last_motion_ms = now_ms;
    }
    ddpi_process_delta(engine, in_dx, in_dy, out_dx, out_dy);
}

bool ddpi_hid_handle_feature_report(
    ddpi_engine_t *engine,
    const uint8_t req[DDPI_HID_PACKET_LEN],
    uint8_t resp[DDPI_HID_PACKET_LEN],
    bool (*on_save_flash)(const ddpi_profile_v1_t *profile),
    void (*on_enter_bootloader)(void)
) {
    if (engine == NULL || req == NULL || resp == NULL) {
        return false;
    }

    /* Check Open Directional DPI v1 framing magic ('D', 'P' and namespace 0xDF) */
    if (req[0] != 0x44u || req[1] != 0x50u || req[5] != DDPI_HID_NAMESPACE) {
        return false;
    }

    memset(resp, 0, DDPI_HID_PACKET_LEN);
    resp[0] = 0x44u; /* 'D' */
    resp[1] = 0x50u; /* 'P' */
    resp[2] = DDPI_PROFILE_VERSION;
    resp[4] = req[4]; /* Echo sequence number */
    resp[5] = DDPI_HID_NAMESPACE;
    resp[6] = req[6]; /* Opcode */
    resp[7] = req[7]; /* Slot */

    /* Verify request packet CRC-16 over bytes 0..61 */
    uint16_t req_crc_expected = ddpi_crc16_ccitt(req, 62u);
    uint16_t req_crc_actual   = read_u16_le(&req[62]);
    if (req[2] != DDPI_PROFILE_VERSION || req_crc_expected != req_crc_actual) {
        resp[3] = DDPI_STATUS_ERR_CRC_OR_FMT;
        uint16_t crc = ddpi_crc16_ccitt(resp, 62u);
        write_u16_le(&resp[62], crc);
        return true;
    }

    uint8_t opcode = req[6];
    uint8_t *payload = &resp[8];
    const uint8_t *req_payload = &req[8];
    resp[3] = DDPI_STATUS_OK;

    switch (opcode) {
        case DDPI_CMD_GET_CAPABILITIES: {
            payload[0] = 0x44u; /* 'D' */
            payload[1] = 0x50u; /* 'P' */
            payload[2] = 0x30u; /* '0' */
            payload[3] = 0x31u; /* '1' */
            payload[4] = DDPI_PROFILE_VERSION;
            payload[5] = 1u;    /* max_slots: the reference engine holds one profile (slot is ignored) */
            payload[6] = 0u;    /* active_slot */
            /* Only claim what this engine/adapter can actually do; hardware facts
             * (bit0 wired_1000hz, bit2 paw3370_sensor) are not known to the generic core. */
            payload[7] = (uint8_t)((on_save_flash != NULL ? 0x02u : 0u) |       /* nvs_storage */
                                   (on_enter_bootloader != NULL ? 0x08u : 0u) | /* bootloader_reentry */
                                   0x10u |                                      /* travel_window */
                                   0x20u);                                      /* linear_2x2 */
            write_u16_le(&payload[8], 50u);
            write_u16_le(&payload[10], DDPI_DPI_MAX);
            write_u16_le(&payload[12], DDPI_Q8_8_MIN);
            write_u16_le(&payload[14], DDPI_Q8_8_MAX);
            payload[16] = DDPI_DEFAULT_WINDOW_COUNTS;
            payload[17] = DDPI_MAX_WINDOW_COUNTS;
            break;
        }

        case DDPI_CMD_GET_PROFILE: {
            ddpi_profile_serialize(&engine->profile, payload);
            break;
        }

        case DDPI_CMD_SET_PROFILE: {
            ddpi_profile_v1_t incoming;
            if (!ddpi_profile_deserialize(req_payload, &incoming)) {
                resp[3] = DDPI_STATUS_ERR_CRC_OR_FMT;
            } else {
                ddpi_engine_set_profile(engine, &incoming);
                ddpi_profile_serialize(&engine->profile, payload);
            }
            break;
        }

        case DDPI_CMD_SAVE_FLASH: {
            if (on_save_flash == NULL) {
                resp[3] = DDPI_STATUS_ERR_UNSUPPORTED;
            } else if (!on_save_flash(&engine->profile)) {
                resp[3] = DDPI_STATUS_ERR_CRC_OR_FMT;
            }
            ddpi_profile_serialize(&engine->profile, payload);
            break;
        }

        case DDPI_CMD_RESET_DEFAULTS: {
            /* Keep the device's own base CPI; only the curve returns to neutral */
            ddpi_engine_init(engine, engine->profile.base_dpi);
            ddpi_profile_serialize(&engine->profile, payload);
            break;
        }

        case DDPI_CMD_SET_ENABLED: {
            uint8_t mode = req_payload[0];
            if (mode == 2u) {
                /* Mode 2: Calibration bypass (enabled in profile, but temporarily bypassed) */
                engine->profile.flags |= DDPI_FLAG_BYPASS_FOR_CALIBRATION;
                ddpi_engine_reset_remainders(engine);
            } else if (mode != 0u) {
                engine->profile.flags |= DDPI_FLAG_ENABLED;
                engine->profile.flags &= (uint8_t)~DDPI_FLAG_BYPASS_FOR_CALIBRATION;
            } else {
                engine->profile.flags &= (uint8_t)~(DDPI_FLAG_ENABLED | DDPI_FLAG_BYPASS_FOR_CALIBRATION);
                ddpi_engine_reset_remainders(engine);
            }
            ddpi_profile_sanitize_and_sign(&engine->profile);
            payload[0] = engine->profile.flags;
            break;
        }

        case DDPI_CMD_SIMULATE_DELTA: {
            int16_t in_dx  = (int16_t)read_u16_le(&req_payload[0]);
            int16_t in_dy  = (int16_t)read_u16_le(&req_payload[2]);
            int16_t out_dx = 0;
            int16_t out_dy = 0;
            ddpi_process_delta(engine, in_dx, in_dy, &out_dx, &out_dy);
            write_u16_le(&payload[0], (uint16_t)out_dx);
            write_u16_le(&payload[2], (uint16_t)out_dy);
            write_u32_le(&payload[4], (uint32_t)engine->rem_x_q16_16);
            write_u32_le(&payload[8], (uint32_t)engine->rem_y_q16_16);
            payload[12] = engine->last_octant;
            write_u32_le(&payload[13], engine->last_scale_q16_16);
            break;
        }

        case DDPI_CMD_ENTER_BOOTLOADER: {
            uint32_t magic_arg = read_u32_le(&req_payload[0]);
            if (magic_arg != DDPI_BOOTLOADER_MAGIC_ARG) {
                resp[3] = DDPI_STATUS_ERR_RANGE;
            } else if (on_enter_bootloader == NULL) {
                resp[3] = DDPI_STATUS_ERR_UNSUPPORTED;
            } else {
                on_enter_bootloader();
            }
            break;
        }

        default: {
            resp[3] = DDPI_STATUS_ERR_UNSUPPORTED;
            break;
        }
    }

    uint16_t resp_crc = ddpi_crc16_ccitt(resp, 62u);
    write_u16_le(&resp[62], resp_crc);
    return true;
}
