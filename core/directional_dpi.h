/*
 * Open Directional DPI (ODD) v1 — Portable C Reference Engine
 *
 * SPDX-License-Identifier: MIT
 *
 * Zero-dependency, pure fixed-point directional sensitivity engine portable
 * across ZMK, Zephyr RTOS, Keychron ZGM, QMK, Linux evdev/uinput, WebAssembly,
 * and bare-metal ARM Cortex-M / RISC-V targets.
 */

#ifndef OPEN_DIRECTIONAL_DPI_H_
#define OPEN_DIRECTIONAL_DPI_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Profile & Protocol Constants */
#define DDPI_PROFILE_MAGIC          0x4450u /* "DP" (0x50, 0x44 LE) */
#define DDPI_PROFILE_VERSION        0x01u
#define DDPI_NUM_DIRECTIONS         8u
#define DDPI_PROFILE_SERIALIZED_LEN 28u
#define DDPI_HID_PACKET_LEN         64u
#define DDPI_HID_NAMESPACE          0xDFu
#define DDPI_BOOTLOADER_MAGIC_ARG   0x424C5253u /* "BLRS" */

/** Fixed-Point Q8.8 Constants (1.00x = 256 = 0x0100) */
#define DDPI_Q8_8_ONE               0x0100u /* 1.0000x (256) */
#define DDPI_Q8_8_MIN               0x0010u /* 0.0625x (16)  */
#define DDPI_Q8_8_MAX               0x0400u /* 4.0000x (1024)*/

/** Fixed-Point Q16.16 Constants (1.00x = 65536 = 0x00010000) */
#define DDPI_Q16_16_ONE             65536

/** Default Travel-Window Estimator Length in Sensor Counts (0.5 mm at 800 CPI) */
#define DDPI_DEFAULT_WINDOW_COUNTS  16u
#define DDPI_MAX_WINDOW_COUNTS      128u

/** Profile Flags (ddpi_profile_v1_t::flags) */
#define DDPI_FLAG_ENABLED                    (1u << 0)
#define DDPI_FLAG_KEEP_REMAINDER_ON_REVERSE  (1u << 1) /* Legacy alias (now default unless RESET flag set) */
#define DDPI_FLAG_LINEAR_OCTANT_RATIO        (1u << 2) /* Use tangent ratio instead of circular angle */
#define DDPI_FLAG_FRAME_SENSOR_CCW           (1u << 3) /* Multipliers ordered CCW from +X (0=E,1=NE,2=N..7=SE) */
#define DDPI_FLAG_MODEL_LINEAR_2X2           (1u << 4) /* Stateless 2x2 matrix model using E/N/NE/NW gains */
#define DDPI_FLAG_RESET_REMAINDER_ON_REVERSE (1u << 5) /* Clear axis remainder when raw delta flips sign */
#define DDPI_FLAG_BYPASS_FOR_CALIBRATION     (1u << 6) /* Temporary 1.00x bypass during calibration runs */

/** USB HID Status Codes (compatible with Compx 0xA1..0xA4 convention) */
#define DDPI_STATUS_OK              0xA1u
#define DDPI_STATUS_ERR_CRC_OR_FMT  0xA2u
#define DDPI_STATUS_ERR_UNSUPPORTED 0xA3u
#define DDPI_STATUS_ERR_RANGE       0xA4u

/**
 * Eight Compass Octant Indices in HID Coordinates (default frame: CW from +X)
 * When DDPI_FLAG_FRAME_SENSOR_CCW is set, multipliers_q8_8[] is indexed
 * counter-clockwise in tabletop coordinates (0=E, 1=NE/Away-Right, 2=N/Away,
 * 3=NW/Away-Left, 4=W/Left, 5=SW/Toward-Left, 6=S/Toward, 7=SE/Toward-Right).
 */
typedef enum {
    DDPI_DIR_E  = 0, /*   0 deg HID: +X,  0  (Right)             */
    DDPI_DIR_SE = 1, /*  45 deg HID: +X, +Y  (Toward-Right/Down) */
    DDPI_DIR_S  = 2, /*  90 deg HID:  0, +Y  (Toward/Down)       */
    DDPI_DIR_SW = 3, /* 135 deg HID: -X, +Y  (Toward-Left/Down)  */
    DDPI_DIR_W  = 4, /* 180 deg HID: -X,  0  (Left)              */
    DDPI_DIR_NW = 5, /* 225 deg HID: -X, -Y  (Away-Left/Up)      */
    DDPI_DIR_N  = 6, /* 270 deg HID:  0, -Y  (Away/Up)           */
    DDPI_DIR_NE = 7  /* 315 deg HID: +X, -Y  (Away-Right/Up)     */
} ddpi_direction_t;

/** Counter-Clockwise Tabletop Octant Indices (odd-sensor-ccw frame) */
typedef enum {
    DDPI_CCW_RIGHT        = 0, /*   0 deg CCW: +X,  0       */
    DDPI_CCW_AWAY_RIGHT   = 1, /*  45 deg CCW: +X, -Y_HID   */
    DDPI_CCW_AWAY         = 2, /*  90 deg CCW:  0, -Y_HID   */
    DDPI_CCW_AWAY_LEFT    = 3, /* 135 deg CCW: -X, -Y_HID   */
    DDPI_CCW_LEFT         = 4, /* 180 deg CCW: -X,  0       */
    DDPI_CCW_TOWARD_LEFT  = 5, /* 225 deg CCW: -X, +Y_HID   */
    DDPI_CCW_TOWARD       = 6, /* 270 deg CCW:  0, +Y_HID   */
    DDPI_CCW_TOWARD_RIGHT = 7  /* 315 deg CCW: +X, +Y_HID   */
} ddpi_ccw_direction_t;

/** HID Protocol v1 Command Opcodes (namespace 0xDF) */
typedef enum {
    DDPI_CMD_GET_CAPABILITIES = 0x01,
    DDPI_CMD_GET_PROFILE      = 0x02,
    DDPI_CMD_SET_PROFILE      = 0x03,
    DDPI_CMD_SAVE_FLASH       = 0x04,
    DDPI_CMD_RESET_DEFAULTS   = 0x05,
    DDPI_CMD_SET_ENABLED      = 0x06,
    DDPI_CMD_SIMULATE_DELTA   = 0x07,
    DDPI_CMD_ENTER_BOOTLOADER = 0x0F
} ddpi_hid_opcode_t;

/**
 * Versioned 28-byte Directional DPI Profile Structure (v1).
 *
 * Note on bytes +0x18..+0x19 (`reserved`):
 * - Low byte  (`reserved & 0xFF`): Travel-window length L in counts (`0` = instantaneous, `1..128` = smoothed).
 * - High byte (`reserved >> 8`):   Idle reset timeout in 5 ms units (`0` = default 50 ms).
 */
typedef struct {
    uint16_t magic;                             /* +0x00: DDPI_PROFILE_MAGIC (0x4450) */
    uint8_t  version;                           /* +0x02: DDPI_PROFILE_VERSION (0x01) */
    uint8_t  flags;                             /* +0x03: DDPI_FLAG_* bitmask */
    uint16_t base_dpi;                          /* +0x04: Base sensor CPI/DPI (50..19000) */
    uint16_t global_gain_q8_8;                  /* +0x06: Scalar directional gain (Q8.8) */
    uint16_t multipliers_q8_8[DDPI_NUM_DIRECTIONS]; /* +0x08..0x17: 8 octant multipliers (Q8.8) */
    uint16_t reserved;                          /* +0x18: low8 = window_counts (L), high8 = idle_5ms */
    uint16_t crc16;                             /* +0x1A: CRC-16-CCITT over [0x00..0x19] */
} ddpi_profile_v1_t;

/**
 * Runtime Directional DPI Engine State.
 */
typedef struct {
    ddpi_profile_v1_t profile;
    int32_t           rem_x_q16_16;        /* Fractional X accumulator in Q16.16 */
    int32_t           rem_y_q16_16;        /* Fractional Y accumulator in Q16.16 */
    int32_t           dir_x_q16_16;        /* Travel-window smoothed X direction vector (Q16.16) */
    int32_t           dir_y_q16_16;        /* Travel-window smoothed Y direction vector (Q16.16) */
    uint8_t           last_octant;         /* Most recent octant index (0..7) */
    uint32_t          last_scale_q16_16;   /* Most recent effective scale (Q16.16) */
} ddpi_engine_t;

/**
 * Helper to get/set the travel-window estimator length L (in sensor counts) on a profile.
 */
static inline uint8_t ddpi_profile_get_window_counts(const ddpi_profile_v1_t *profile) {
    if (profile == NULL) {
        return 0u;
    }
    uint8_t w = (uint8_t)(profile->reserved & 0xFFu);
    return (w > DDPI_MAX_WINDOW_COUNTS) ? DDPI_MAX_WINDOW_COUNTS : w;
}

static inline void ddpi_profile_set_window_counts(ddpi_profile_v1_t *profile, uint8_t window_counts) {
    if (profile == NULL) {
        return;
    }
    if (window_counts > DDPI_MAX_WINDOW_COUNTS) {
        window_counts = DDPI_MAX_WINDOW_COUNTS;
    }
    profile->reserved = (uint16_t)((profile->reserved & 0xFF00u) | (uint16_t)window_counts);
}

/**
 * Compute CRC-16-CCITT (polynomial 0x1021, initial value 0xFFFF).
 */
uint16_t ddpi_crc16_ccitt(const uint8_t *data, size_t len);

/**
 * Initialize a profile structure to neutral 1.00x defaults (800 DPI, enabled=false).
 */
void ddpi_profile_init_default(ddpi_profile_v1_t *profile, uint16_t base_dpi);

/**
 * Clamp all profile multipliers and gains to valid v1 bounds and recompute CRC-16.
 */
void ddpi_profile_sanitize_and_sign(ddpi_profile_v1_t *profile);

/**
 * Normalize profile gains so the maximum effective multiplier is <= 1.00x (Q8.8 = 256)
 * and output the elevated hardware sensor CPI (`base_dpi * max_gain`) so firmware
 * only scales down and never emits 2-count quantization steps.
 */
void ddpi_profile_normalize_cpi_headroom(ddpi_profile_v1_t *profile, uint16_t *out_sensor_cpi);

/**
 * Convert a profile's multiplier array in-place between HID clockwise order
 * (`0=E, 1=SE, 2=S ... 7=NE`) and `odd-sensor-ccw` order (`0=E, 1=NE, 2=N ... 7=SE`),
 * toggling `DDPI_FLAG_FRAME_SENSOR_CCW` and re-signing the profile.
 */
void ddpi_profile_set_ccw_frame(ddpi_profile_v1_t *profile, bool use_ccw_frame);

/**
 * Serialize a ddpi_profile_v1_t into a 28-byte little-endian buffer (computing CRC-16).
 */
void ddpi_profile_serialize(const ddpi_profile_v1_t *profile, uint8_t out_buf[DDPI_PROFILE_SERIALIZED_LEN]);

/**
 * Deserialize and validate a 28-byte little-endian buffer into a ddpi_profile_v1_t.
 * Returns true if magic, version, bounds, and CRC-16 are all valid.
 */
bool ddpi_profile_deserialize(const uint8_t in_buf[DDPI_PROFILE_SERIALIZED_LEN], ddpi_profile_v1_t *out_profile);

/**
 * Check whether a profile is in exact 1.00x neutral identity state.
 */
bool ddpi_profile_is_identity(const ddpi_profile_v1_t *profile);

/**
 * Initialize the runtime engine with neutral defaults.
 */
void ddpi_engine_init(ddpi_engine_t *engine, uint16_t base_dpi);

/**
 * Reset accumulated fractional remainders and smoothed direction state to zero.
 */
void ddpi_engine_reset_remainders(ddpi_engine_t *engine);

/**
 * Notify the engine that the sensor has been idle (e.g. >= 50 ms without motion)
 * so the travel-window direction estimator resets cleanly before the next flick.
 */
void ddpi_engine_notify_idle(ddpi_engine_t *engine);

/**
 * Load a validated profile into the runtime engine (clamping parameters to safe bounds).
 */
void ddpi_engine_set_profile(ddpi_engine_t *engine, const ddpi_profile_v1_t *profile);

/**
 * Compute the interpolated directional scale in Q16.16 for a direction vector (dx, dy).
 * Also outputs the primary octant sector index (0..7) if out_octant != NULL.
 */
uint32_t ddpi_compute_scale_q16_16(
    const ddpi_profile_v1_t *profile,
    int16_t dx,
    int16_t dy,
    uint8_t *out_octant
);

/**
 * Process a single sensor motion sample (dx, dy) and produce scaled USB HID deltas
 * (*out_dx, *out_dy) with travel-window direction estimation, sub-pixel remainder
 * accumulation, and int16 saturation carry.
 */
void ddpi_process_delta(
    ddpi_engine_t *engine,
    int16_t in_dx,
    int16_t in_dy,
    int16_t *out_dx,
    int16_t *out_dy
);

/**
 * Process a 64-byte Open Directional DPI v1 HID Feature report request and
 * populate the 64-byte response buffer.
 * Returns true if the packet matched the Open Directional DPI v1 framing ('D','P' & 0xDF).
 */
bool ddpi_hid_handle_feature_report(
    ddpi_engine_t *engine,
    const uint8_t req[DDPI_HID_PACKET_LEN],
    uint8_t resp[DDPI_HID_PACKET_LEN],
    bool (*on_save_flash)(const ddpi_profile_v1_t *profile),
    void (*on_enter_bootloader)(void)
);

#ifdef __cplusplus
}
#endif

#endif /* OPEN_DIRECTIONAL_DPI_H_ */
