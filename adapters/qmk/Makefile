CC     ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -pedantic

TEST = tests/test_qmk_raw_hid

# Compile the adapter with its stand-in QMK types (8-bit and extended reports, raw HID), then run the
# raw HID transport test (spec/hid-protocol-v1.md section 6). CI also compiles it against QMK's own headers.
check: $(TEST)
	$(CC) $(CFLAGS) -c odd_pointing_device.c -o /dev/null
	$(CC) $(CFLAGS) -DMOUSE_EXTENDED_REPORT -c odd_pointing_device.c -o /dev/null
	$(CC) $(CFLAGS) -DRAW_ENABLE -c odd_pointing_device.c -o /dev/null
	./$(TEST)

$(TEST): $(TEST).c odd_pointing_device.c ../../core/directional_dpi.c ../../core/directional_dpi.h
	$(CC) $(CFLAGS) -O2 -o $@ ../../core/directional_dpi.c $(TEST).c -lm

clean:
	rm -f $(TEST)

.PHONY: check clean
