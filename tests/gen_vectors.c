/*
 * Open Directional DPI (ODD) v1 — Conformance Vector Generator
 *
 * Writes ddpi_compute_scale_q16_16() results for a fixed set of profiles and a
 * deterministic (dx, dy) grid as JSON on stdout. `make -C tests vectors` stores
 * them in tests/vectors/scale_vectors.json (format: tests/vectors/README.md).
 *
 * SPDX-License-Identifier: MIT
 */

#include <inttypes.h>
#include <stdio.h>

#include "../core/directional_dpi.h"

typedef struct {
    const char *name;
    uint8_t     flags;
    uint16_t    base_dpi;
    uint16_t    gain_q8_8;
    uint16_t    mult_q8_8[DDPI_NUM_DIRECTIONS];
    uint16_t    reserved;
} vector_profile_t;

/* Eight distinct multipliers so any index mix-up (e.g. a mirrored frame) changes results */
#define ASYMMETRIC { 256, 300, 384, 340, 230, 200, 170, 210 }

static const vector_profile_t PROFILES[] = {
    { "identity-enabled", DDPI_FLAG_ENABLED, 800, 256,
      { 256, 256, 256, 256, 256, 256, 256, 256 }, 0 },
    { "disabled-asymmetric", 0, 800, 256, ASYMMETRIC, 0 },
    { "asymmetric-hid-cw", DDPI_FLAG_ENABLED, 1600, 256, ASYMMETRIC, 16 },
    { "asymmetric-sensor-ccw", DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW, 1600, 256,
      ASYMMETRIC, (10u << 8) | 16u },
    { "linear-octant-ratio", DDPI_FLAG_ENABLED | DDPI_FLAG_LINEAR_OCTANT_RATIO, 800, 256,
      ASYMMETRIC, 0 },
    { "global-gain-451", DDPI_FLAG_ENABLED, 800, 451, ASYMMETRIC, 0 },
    { "extreme-16-1024-ccw-45000dpi", DDPI_FLAG_ENABLED | DDPI_FLAG_FRAME_SENSOR_CCW, 45000, 1024,
      { 1024, 16, 16, 1024, 16, 1024, 1024, 16 }, 0 },
    { "bypass-for-calibration", DDPI_FLAG_ENABLED | DDPI_FLAG_BYPASS_FOR_CALIBRATION, 800, 256,
      ASYMMETRIC, 0 },
};

/*
 * Each magnitude is used with both signs (0 once, 32768 only as -32768), for dx and dy
 * independently: axes, exact diagonals, near-diagonals (99/100, 32766/32767/32768),
 * 1-count moves, int16 extremes and mixed magnitudes (~22.5 deg via 414/1000).
 */
static const int32_t MAGNITUDES[] = { 0, 1, 99, 100, 414, 1000, 12345, 32766, 32767, 32768 };

int main(void) {
    int16_t values[2u * sizeof(MAGNITUDES) / sizeof(MAGNITUDES[0])];
    size_t  n_values = 0u;
    for (size_t i = 0; i < sizeof(MAGNITUDES) / sizeof(MAGNITUDES[0]); ++i) {
        int32_t m = MAGNITUDES[i];
        if (m != 32768) {
            values[n_values++] = (int16_t)m;
        }
        if (m != 0) {
            values[n_values++] = (int16_t)-m;
        }
    }

    const size_t n_profiles = sizeof(PROFILES) / sizeof(PROFILES[0]);
    printf("{\n");
    printf("  \"suite\": \"open-directional-dpi-v1/ddpi_compute_scale_q16_16\",\n");
    printf("  \"generator\": \"tests/gen_vectors.c\",\n");
    printf("  \"vector_fields\": [\"dx\", \"dy\", \"scale_q16_16\", \"octant\"],\n");
    printf("  \"profiles\": [\n");
    for (size_t p = 0; p < n_profiles; ++p) {
        const vector_profile_t *src = &PROFILES[p];
        ddpi_profile_v1_t prof;
        ddpi_profile_init_default(&prof, src->base_dpi);
        prof.flags            = src->flags;
        prof.global_gain_q8_8 = src->gain_q8_8;
        for (size_t i = 0; i < DDPI_NUM_DIRECTIONS; ++i) {
            prof.multipliers_q8_8[i] = src->mult_q8_8[i];
        }
        prof.reserved = src->reserved;

        /* Results come from the profile as a device would load it from its 28 bytes */
        uint8_t bytes[DDPI_PROFILE_SERIALIZED_LEN];
        ddpi_profile_serialize(&prof, bytes);
        if (!ddpi_profile_deserialize(bytes, &prof)) {
            fprintf(stderr, "gen_vectors: profile %s does not deserialize\n", src->name);
            return 1;
        }

        printf("    {\n      \"name\": \"%s\",\n      \"bytes\": \"", src->name);
        for (size_t i = 0; i < DDPI_PROFILE_SERIALIZED_LEN; ++i) {
            printf("%02x", bytes[i]);
        }
        printf("\",\n      \"vectors\": [\n");
        for (size_t ix = 0; ix < n_values; ++ix) {
            for (size_t iy = 0; iy < n_values; ++iy) {
                uint8_t  octant = 0u;
                uint32_t scale  = ddpi_compute_scale_q16_16(&prof, values[ix], values[iy], &octant);
                int      last   = (ix + 1u == n_values) && (iy + 1u == n_values);
                printf("        [%d, %d, %" PRIu32 ", %u]%s\n", values[ix], values[iy], scale,
                       (unsigned)octant, last ? "" : ",");
            }
        }
        printf("      ]\n    }%s\n", (p + 1u == n_profiles) ? "" : ",");
    }
    printf("  ]\n}\n");
    return (fflush(stdout) == 0 && !ferror(stdout)) ? 0 : 1;
}
