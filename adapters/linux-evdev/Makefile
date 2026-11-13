CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Werror

all: odd_evdev_filter

odd_evdev_filter: ../../core/directional_dpi.c ../../core/directional_dpi.h odd_evdev_filter.c
	$(CC) $(CFLAGS) -o $@ ../../core/directional_dpi.c odd_evdev_filter.c

# Event handling self-check; needs no /dev/uinput or root
check: odd_evdev_filter
	./odd_evdev_filter --selftest

clean:
	rm -f odd_evdev_filter

.PHONY: all check clean
