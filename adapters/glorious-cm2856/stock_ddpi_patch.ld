/*
 * Linker script for Glorious Series One Pro surgical OpenDDPIv1 binary extension.
 * Appended at 0x0001CD00 immediately after the 93,328-byte stock firmware
 * (0x00006000..0x0001CC8F).
 */

MEMORY
{
    PATCH_ROM (rx) : ORIGIN = 0x0001CD00, LENGTH = 0x00003300
}

SECTIONS
{
    .text 0x0001CD00 :
    {
        KEEP(*(.text.entry_boot_init))
        KEEP(*(.text.entry_usb_proto))
        KEEP(*(.text.entry_sensor_burst))
        KEEP(*(.text.entry_rf_len_clamp))
        *(.text*)
        *(.rodata*)
        . = ALIGN(4);
    } > PATCH_ROM

    /DISCARD/ :
    {
        *(.ARM.exidx*)
        *(.ARM.extab*)
        *(.comment*)
        *(.note*)
    }

    .bss (NOLOAD) :
    {
        *(.bss*)
        *(COMMON)
    }
    .data :
    {
        *(.data*)
    }

    ASSERT(SIZEOF(.bss) == 0, "ERROR: Patch must have zero .bss (use DDPI_SRAM_STATE_ADDR 0x2003F000)")
    ASSERT(SIZEOF(.data) == 0, "ERROR: Patch must have zero .data (use DDPI_SRAM_STATE_ADDR 0x2003F000)")
}
