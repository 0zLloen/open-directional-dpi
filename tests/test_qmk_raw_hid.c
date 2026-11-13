/*
 * QMK raw HID transport (adapters/qmk, spec/hid-protocol-v1.md §6) on the host:
 * the adapter's stand-in QMK names, plus a RAM "EEPROM" for SAVE_FLASH.
 *
 * SPDX-License-Identifier: MIT
 */

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define RAW_ENABLE
#define EECONFIG_USER_DATA_SIZE 28
static uint8_t  g_eeprom[EECONFIG_USER_DATA_SIZE];
static uint32_t eeconfig_read_user_datablock(void *data, uint32_t offset, uint32_t length) {
    memcpy(data, &g_eeprom[offset], length);
    return length;
}
static uint32_t eeconfig_update_user_datablock(const void *data, uint32_t offset, uint32_t length) {
    memcpy(&g_eeprom[offset], data, length);
    return length;
}
#include "../adapters/qmk/odd_pointing_device.c"

/* One frame as QMK's raw_hid_receive() gets it; returns the adapter's verdict, reply in f */
static bool frame(uint8_t f[32], uint8_t chunk, const uint8_t *data, size_t n) {
    memset(f, 0, 32);
    f[0] = 0xDF;
    f[1] = chunk;
    if (data != NULL) {
        memcpy(&f[2], data, n);
    }
    uint8_t sent[32];
    memcpy(sent, f, 32);
    bool ours = odd_qmk_raw_hid(f, 32);
    if ((chunk & 0x80u) == 0u) {
        assert(memcmp(f, sent, 32) == 0); /* write frames come back unchanged */
    }
    return ours;
}

static void read_response(uint8_t ans[64]) {
    uint8_t f[32];
    for (uint8_t i = 0; i < 3; i++) {
        assert(frame(f, (uint8_t)(0x80u | i), NULL, 0));
        assert(f[0] == 0xDF && f[1] == (0x80u | i));
        memcpy(&ans[30 * i], &f[2], i == 2 ? 4 : 30);
        if (i == 2) {
            for (int k = 6; k < 32; k++) assert(f[k] == 0);
        }
    }
}

static void make_packet(uint8_t pkt[64], uint8_t seq, uint8_t op, const uint8_t *payload, size_t n) {
    memset(pkt, 0, 64);
    memcpy(pkt, (const uint8_t[]){'D', 'P', 1, 0, seq, 0xDF, op, 0}, 8);
    if (payload != NULL) {
        memcpy(&pkt[8], payload, n);
    }
    uint16_t crc = ddpi_crc16_ccitt(pkt, 62);
    pkt[62]      = (uint8_t)crc;
    pkt[63]      = (uint8_t)(crc >> 8);
}

/* Frames in the given chunk order: write chunks carry their part of pkt */
static void send_chunks(const uint8_t pkt[64], const uint8_t *chunks, size_t count) {
    uint8_t f[32];
    for (size_t k = 0; k < count; k++) {
        uint8_t i = chunks[k];
        assert(frame(f, i, i <= 2u ? &pkt[30 * i] : NULL, i == 2u ? 4u : (i < 2u ? 30u : 0u)));
    }
}

/* Six frames in lock step; returns the reassembled answer after checking §3 */
static void command(uint8_t seq, uint8_t op, const uint8_t *payload, size_t n, uint8_t ans[64]) {
    uint8_t pkt[64];
    make_packet(pkt, seq, op, payload, n);
    send_chunks(pkt, (const uint8_t[]){0x00, 0x01, 0x02}, 3);
    read_response(ans);
    uint16_t crc = ddpi_crc16_ccitt(ans, 62);
    assert(ans[0] == 'D' && ans[1] == 'P' && ans[4] == seq && ans[5] == 0xDF && ans[6] == op);
    assert(ans[62] == (uint8_t)crc && ans[63] == (uint8_t)(crc >> 8));
}

int main(void) {
    uint8_t f[32];
    uint8_t ans[64];
    uint8_t zero[64] = {0};

    /* Not ours: VIA/Vial ids, wrong length; data untouched */
    memset(f, 0, 32);
    f[0] = 0x01;
    assert(!odd_qmk_raw_hid(f, 32) && f[0] == 0x01);
    f[0] = 0xDF;
    assert(!odd_qmk_raw_hid(f, 31) && f[0] == 0xDF && f[1] == 0);

    /* Reads before any request: zeros */
    read_response(ans);
    assert(memcmp(ans, zero, 64) == 0);

    /* Probe (§6.3): GET_CAPABILITIES with sensor DPI and clock from the pointing task */
    report_mouse_t m = {0};
    pointing_device_task_odd(m);
    command(5, DDPI_CMD_GET_CAPABILITIES, NULL, 0, ans);
    assert(ans[3] == DDPI_STATUS_OK && memcmp(&ans[8], "DP01", 4) == 0);
    assert(ans[15] == 0xF2); /* nvs, travel window, 2x2, sensor DPI, clock; no bootloader */
    assert(ans[26] == (800 & 0xFF) && ans[27] == (800 >> 8));

    /* Out of order: a valid request (seq 99) sent as W0 W2, W0 R0 W1 W2, W0 <0x7F> W1 W2
     * or W1 W2 is dropped; the reads still return the last answer (seq 5) */
    uint8_t              pkt[64];
    static const uint8_t bad[][4]  = {{0x00, 0x02}, {0x00, 0x80, 0x01, 0x02}, {0x00, 0x7F, 0x01, 0x02}, {0x01, 0x02}};
    static const size_t  bad_len[] = {2, 4, 4, 2};
    make_packet(pkt, 99, DDPI_CMD_GET_CAPABILITIES, NULL, 0);
    for (size_t k = 0; k < sizeof(bad_len) / sizeof(bad_len[0]); k++) {
        send_chunks(pkt, bad[k], bad_len[k]);
        read_response(ans);
        assert(ans[4] == 5);
    }
    send_chunks(pkt, (const uint8_t[]){0x00, 0x01, 0x02}, 3); /* in order it is taken */
    read_response(ans);
    assert(ans[4] == 99);

    /* A read frame's data is replaced: chunk 2 is packet bytes 60..63, then zeros */
    memset(f, 0xAA, 32);
    f[0] = 0xDF;
    f[1] = 0x82;
    assert(odd_qmk_raw_hid(f, 32) && f[2] == ans[60] && f[5] == ans[63] && f[6] == 0 && f[31] == 0);
    memset(f, 0xAA, 32); /* no chunk 3: answered unchanged */
    f[0] = 0xDF;
    f[1] = 0x83;
    assert(odd_qmk_raw_hid(f, 32) && f[1] == 0x83 && f[2] == 0xAA && f[31] == 0xAA);

    /* SET_PROFILE: the 28-byte payload spans chunks 0 and 1 */
    ddpi_profile_v1_t p = odd_qmk_get_engine()->profile;
    p.flags |= DDPI_FLAG_ENABLED;
    p.multipliers_q8_8[DDPI_DIR_S] = 0x00C0;
    uint8_t raw[DDPI_PROFILE_SERIALIZED_LEN];
    ddpi_profile_serialize(&p, raw);
    command(6, DDPI_CMD_SET_PROFILE, raw, sizeof(raw), ans);
    assert(ans[3] == DDPI_STATUS_OK && memcmp(&ans[8], raw, sizeof(raw)) == 0);
    assert(odd_qmk_get_engine()->profile.multipliers_q8_8[DDPI_DIR_S] == 0x00C0);
    command(7, DDPI_CMD_GET_PROFILE, NULL, 0, ans);
    assert(ans[3] == DDPI_STATUS_OK && memcmp(&ans[8], raw, sizeof(raw)) == 0);

    /* No bootloader command over raw HID */
    const uint8_t blrs[4] = {0x53, 0x52, 0x4C, 0x42};
    command(8, DDPI_CMD_ENTER_BOOTLOADER, blrs, 4, ans);
    assert(ans[3] == DDPI_STATUS_ERR_UNSUPPORTED);

    /* SAVE_FLASH writes the user datablock; odd_qmk_init() loads it at boot */
    command(9, DDPI_CMD_SAVE_FLASH, NULL, 0, ans);
    assert(ans[3] == DDPI_STATUS_OK && memcmp(g_eeprom, raw, sizeof(raw)) == 0);
    command(10, DDPI_CMD_RESET_DEFAULTS, NULL, 0, ans);
    assert(odd_qmk_get_engine()->profile.multipliers_q8_8[DDPI_DIR_S] == 0x0100);
    odd_qmk_init(800);
    assert(odd_qmk_get_engine()->profile.multipliers_q8_8[DDPI_DIR_S] == 0x00C0);
    memset(g_eeprom, 0, sizeof(g_eeprom)); /* fresh datablock: not a profile, ignored */
    odd_qmk_init(800);
    assert(odd_qmk_get_engine()->profile.multipliers_q8_8[DDPI_DIR_S] == 0x0100);

    puts("QMK raw HID transport: all checks passed");
    return 0;
}
