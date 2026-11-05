/*
 * Glorious Forge Series One Pro (CM2852-BAMF) — Compx Bootloader Safe Re-Entry
 *
 * Verified from stock CM2856_Mouse_USB_v1.00.00_20220810.hex @ 0x00014832:
 *   Writing 0xA55AA55A to *(volatile uint32_t *)0x2003FFFC and issuing
 *   NVIC_SystemReset() causes the resident 24 KB Compx Bootloader
 *   (0x00000000..0x00005FFF) to enumerate as USB HID 258a:2103.
 *
 * This module also implements an early PRE_KERNEL_1 hardware boot-chord check:
 * holding Left Click (P1.15) + Right Click (P1.13) + DPI Button (P1.00) while
 * plugging in USB immediately enters the 258a:2103 bootloader before any USB
 * or sensor initialization runs.
 *
 * SPDX-License-Identifier: MIT
 */

#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <hal/nrf_gpio.h>

#define COMPX_BOOTLOADER_MAGIC_ADDR  ((volatile uint32_t *)0x2003FFFCu)
#define COMPX_BOOTLOADER_MAGIC_VALUE 0xA55AA55Au

/* Verified button GPIOs from stock firmware 0x0000C5B8 */
#define PIN_BTN_LMB NRF_GPIO_PIN_MAP(1, 15) /* P1.15 (GPIO 47) */
#define PIN_BTN_RMB NRF_GPIO_PIN_MAP(1, 13) /* P1.13 (GPIO 45) */
#define PIN_BTN_DPI NRF_GPIO_PIN_MAP(1,  0) /* P1.00 (GPIO 32) */

void glorious_enter_compx_bootloader(void) {
    unsigned int key = irq_lock();
    *COMPX_BOOTLOADER_MAGIC_ADDR = COMPX_BOOTLOADER_MAGIC_VALUE;
    __DSB();
    __ISB();
    NVIC_SystemReset();
    irq_unlock(key);
}

static int glorious_boot_chord_recovery_check(void) {
    nrf_gpio_cfg_input(PIN_BTN_LMB, NRF_GPIO_PIN_PULLUP);
    nrf_gpio_cfg_input(PIN_BTN_RMB, NRF_GPIO_PIN_PULLUP);
    nrf_gpio_cfg_input(PIN_BTN_DPI, NRF_GPIO_PIN_PULLUP);

    /* Short settle loop (~15 us at 64 MHz) for internal pull-ups */
    for (volatile int i = 0; i < 1000; ++i) {
        __NOP();
    }

    /* Active-low switches: 0 means pressed */
    bool lmb_pressed = (nrf_gpio_pin_read(PIN_BTN_LMB) == 0u);
    bool rmb_pressed = (nrf_gpio_pin_read(PIN_BTN_RMB) == 0u);
    bool dpi_pressed = (nrf_gpio_pin_read(PIN_BTN_DPI) == 0u);

    if (lmb_pressed && rmb_pressed && dpi_pressed) {
        glorious_enter_compx_bootloader();
    }

    return 0;
}

SYS_INIT(glorious_boot_chord_recovery_check, PRE_KERNEL_1, 0);
