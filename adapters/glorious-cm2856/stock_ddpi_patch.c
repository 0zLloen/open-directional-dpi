/*
 * Glorious Forge Series One Pro (CM2856_Mouse_USB_v1.00.00) — Surgical OpenDDPIv1 Extension
 *
 * Linked at 0x0001CD00 (immediately following the 93,328-byte stock application image
 * 0x00006000..0x0001CC8F). Preserves 100% of stock USB, 2.4 GHz wireless, sensor,
 * button/wheel, LED, and Compx bootloader re-entry functionality.
 *
 * SPDX-License-Identifier: MIT
 */

#include "../../core/directional_dpi.h"

/* Minimal freestanding memcpy / memset / memcmp for -nostdlib builds */
void *memcpy(void *dst, const void *src, size_t n) {
    uint8_t *d = (uint8_t *)dst;
    const uint8_t *s = (const uint8_t *)src;
    for (size_t i = 0; i < n; ++i) {
        d[i] = s[i];
    }
    return dst;
}

void *memset(void *dst, int c, size_t n) {
    uint8_t *d = (uint8_t *)dst;
    for (size_t i = 0; i < n; ++i) {
        d[i] = (uint8_t)c;
    }
    return dst;
}

/* Fixed hardware & stock firmware addresses (verified from CM2856 disassembly) */
#define NRF_P1_IN_REG                (*(volatile uint32_t *)0x50000810u)
#define BOOT_CHORD_MASK_P1           ((1u << 15) | (1u << 13) | (1u << 0)) /* LMB + RMB + DPI */

#define COMPX_BL_MAGIC_SRAM_ADDR     (*(volatile uint32_t *)0x2003FFFCu)
#define COMPX_BL_MAGIC_VALUE         0xA55AA55Au

#define STOCK_SENSOR_STATE_MOTION    (*(volatile uint8_t  *)0x20003020u)
#define STOCK_SENSOR_STATE_DX        (*(volatile int16_t  *)0x2000302Eu)
#define STOCK_SENSOR_STATE_DY        (*(volatile int16_t  *)0x20003030u)

#define STOCK_USB_FEAT_FLAG          (*(volatile uint8_t  *)0x200032D4u)
#define STOCK_USB_GETFEAT_PTR        (*(uint8_t * volatile *)0x200032D8u)
#define STOCK_USB_FEAT_BUF           ((uint8_t *)0x20004F28u)

#define DDPI_FLASH_STORAGE_ADDR      0x0007E000u
#define DDPI_SRAM_STATE_ADDR         0x2003F000u
#define DDPI_SRAM_INIT_MAGIC         0x44445049u /* "DDPI" */

/* Stock firmware function pointers (Thumb bit +1 set) */
typedef void    (*stock_void_fn_t)(void);
typedef uint8_t (*stock_flash_erase_fn_t)(uint32_t flash_addr);
typedef uint8_t (*stock_flash_write_fn_t)(uint32_t flash_addr, const void *src, uint32_t len);

#define STOCK_FN_NVIC_RESET          ((stock_void_fn_t)0x000071B9u)
#define STOCK_FN_LOAD_FLASH_CFG      ((stock_void_fn_t)0x0000D4A1u)
#define STOCK_FN_USB_PROTOCOL        ((stock_void_fn_t)0x000151ADu)
#define STOCK_FN_PAW3370_BURST       ((stock_void_fn_t)0x0001708Du)
#define STOCK_FN_FLASH_ERASE_PAGE    ((stock_flash_erase_fn_t)0x0000BE79u)
#define STOCK_FN_FLASH_WRITE         ((stock_flash_write_fn_t)0x0000BED9u)

typedef struct {
    uint32_t      init_magic;
    ddpi_engine_t engine;
} ddpi_sram_state_t;

static inline ddpi_sram_state_t *get_ddpi_state(void) {
    return (ddpi_sram_state_t *)DDPI_SRAM_STATE_ADDR;
}

static void ddpi_enter_compx_bootloader(void) {
    COMPX_BL_MAGIC_SRAM_ADDR = COMPX_BL_MAGIC_VALUE;
    __asm__ volatile("dsb sy\n\tisb sy" ::: "memory");
    STOCK_FN_NVIC_RESET();
}

static bool ddpi_save_flash_page_0x7E000(const ddpi_profile_v1_t *profile) {
    uint8_t aligned_buf[32] __attribute__((aligned(4)));
    memset(aligned_buf, 0xFF, sizeof(aligned_buf));
    ddpi_profile_serialize(profile, aligned_buf);

    uint8_t erase_rc = STOCK_FN_FLASH_ERASE_PAGE(DDPI_FLASH_STORAGE_ADDR);
    if (erase_rc != 0u) {
        return false;
    }
    uint8_t write_rc = STOCK_FN_FLASH_WRITE(DDPI_FLASH_STORAGE_ADDR, aligned_buf, sizeof(aligned_buf));
    return (write_rc == 0u);
}

static void ddpi_ensure_initialized(void) {
    ddpi_sram_state_t *st = get_ddpi_state();
    if (st->init_magic == DDPI_SRAM_INIT_MAGIC) {
        return;
    }
    ddpi_engine_init(&st->engine, 800u);

    /* Attempt to load saved profile from dedicated flash page 0x0007E000 */
    const uint8_t *flash_ptr = (const uint8_t *)DDPI_FLASH_STORAGE_ADDR;
    ddpi_profile_v1_t stored;
    if (ddpi_profile_deserialize(flash_ptr, &stored)) {
        ddpi_engine_set_profile(&st->engine, &stored);
    }
    st->init_magic = DDPI_SRAM_INIT_MAGIC;
}

/*
 * Stock USB Feature report epilogue helper: jumps into 0x000151F8 with
 * r4 = 0x20004F28 and r5 = 0x200032D4 so both Wired USB (memcpy to *0x200032D8)
 * and Wireless 2.4 GHz response flags are updated identically to stock.
 */
__attribute__((naked)) static void stock_usb_finish_response(void) {
    __asm__ volatile(
        "push {r4, r5, r6, lr}\n\t"
        "ldr  r4, =0x20004F28\n\t"
        "ldr  r5, =0x200032D4\n\t"
        "ldr  r3, =0x000151F9\n\t"
        "bx   r3\n\t"
    );
}

/*
 * Hook 1: Called from 0x0000E874 in main() right after GPIO init (0x0C5B8).
 *   1. Checks hardware boot recovery chord (LMB + RMB + DPI held low on P1).
 *   2. Calls stock flash config loader (0x0D4A0).
 *   3. Initializes Open Directional DPI v1 engine and loads profile from 0x0007E000.
 */
__attribute__((used, section(".text.entry_boot_init")))
void ddpi_boot_init_wrapper(void) {
    if ((NRF_P1_IN_REG & BOOT_CHORD_MASK_P1) == 0u) {
        ddpi_enter_compx_bootloader();
    }
    STOCK_FN_LOAD_FLASH_CFG();
    ddpi_sram_state_t *st = get_ddpi_state();
    st->init_magic = 0u;
    ddpi_ensure_initialized();
}

/*
 * Hook 2: Called from 0x0000E8CE in main() instead of 0x151AC (usb_protocol_process).
 */
__attribute__((used, section(".text.entry_usb_proto")))
void ddpi_usb_protocol_wrapper(void) {
    if (STOCK_USB_FEAT_FLAG == 0u) {
        return;
    }

    uint8_t *feat = STOCK_USB_FEAT_BUF;

    /* Check for Open Directional DPI v1 packet (namespace 0xDF at feat[5], 'P' at feat[1]) */
    if (feat[1] == 0x50u && feat[5] == DDPI_HID_NAMESPACE) {
        ddpi_ensure_initialized();
        ddpi_sram_state_t *st = get_ddpi_state();

        uint8_t req_copy[DDPI_HID_PACKET_LEN];
        memcpy(req_copy, feat, DDPI_HID_PACKET_LEN);
        req_copy[0] = 0x44u; /* Restore 'D' in case USBD ISR set feat[0] = 0xA0 */
        ddpi_hid_handle_feature_report(
            &st->engine,
            req_copy,
            feat,
            ddpi_save_flash_page_0x7E000,
            ddpi_enter_compx_bootloader
        );
        stock_usb_finish_response();
        return;
    }

    /* Check if this is the standard Glorious Firmware Version query (0x00, 0x81) */
    bool is_ver_query = (feat[4] == 0x00u && feat[5] == 0x81u);

    /* Execute 100% unmodified stock USB protocol handler */
    STOCK_FN_USB_PROTOCOL();

    /* Stamp "DP01" into unused bytes [16..19] of the FW version response */
    if (is_ver_query && feat[0] == 0xA1u) {
        feat[16] = 0x44u; /* 'D' */
        feat[17] = 0x50u; /* 'P' */
        feat[18] = 0x30u; /* '0' */
        feat[19] = 0x31u; /* '1' */
        uint8_t *usb_get_buf = STOCK_USB_GETFEAT_PTR;
        if (usb_get_buf != NULL) {
            usb_get_buf[16] = 0x44u;
            usb_get_buf[17] = 0x50u;
            usb_get_buf[18] = 0x30u;
            usb_get_buf[19] = 0x31u;
        }
    }
}

/*
 * Hook 3: Called from 0x000131D8 & 0x00013278 instead of 0x1708C (paw3370_read_motion_burst).
 */
__attribute__((used, section(".text.entry_sensor_burst")))
void ddpi_paw3370_burst_wrapper(void) {
    STOCK_FN_PAW3370_BURST();

    if ((STOCK_SENSOR_STATE_MOTION & 0x80u) != 0u) {
        ddpi_ensure_initialized();
        ddpi_sram_state_t *st = get_ddpi_state();

        int16_t raw_dx = STOCK_SENSOR_STATE_DX;
        int16_t raw_dy = STOCK_SENSOR_STATE_DY;
        int16_t out_dx = raw_dx;
        int16_t out_dy = raw_dy;

        ddpi_process_delta(&st->engine, raw_dx, raw_dy, &out_dx, &out_dy);

        STOCK_SENSOR_STATE_DX = out_dx;
        STOCK_SENSOR_STATE_DY = out_dy;
    }
}
