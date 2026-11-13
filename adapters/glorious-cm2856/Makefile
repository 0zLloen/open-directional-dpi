# Compile + link check for the stock-firmware patch (no vendor binary needed).
# Fails if the core grows past PATCH_ROM, needs .bss/.data (linker ASSERTs),
# pulls in a libgcc helper such as __aeabi_uldivmod (undefined under -nostdlib),
# or lets ddpi_sram_state_t reach the bootloader magic word (_Static_assert).
#   make check                                  # arm-none-eabi-* on PATH
#   make check CROSS=/opt/arm/bin/arm-none-eabi-
CROSS ?= arm-none-eabi-
ifeq ($(origin CC),default)
CC = $(CROSS)gcc
endif
CFLAGS = -mcpu=cortex-m4 -mthumb -Os -ffreestanding -nostdlib -fno-builtin -Wall -Wextra -Werror
ELF = build/stock_ddpi_patch.elf

check: $(ELF)
	$(CROSS)size -A $(ELF)
	@test -z "$$($(CROSS)nm -u $(ELF))" || { echo "undefined symbols:"; $(CROSS)nm -u $(ELF); exit 1; }

$(ELF): stock_ddpi_patch.c stock_ddpi_patch.ld ../../core/directional_dpi.c ../../core/directional_dpi.h
	@mkdir -p build
	$(CC) $(CFLAGS) -T stock_ddpi_patch.ld -Wl,--gc-sections stock_ddpi_patch.c ../../core/directional_dpi.c -o $@

clean:
	rm -rf build

.PHONY: check clean
