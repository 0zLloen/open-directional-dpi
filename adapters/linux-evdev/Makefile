CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Werror

all: odd_evdev_filter

odd_evdev_filter: ../../core/directional_dpi.c odd_evdev_filter.c
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f odd_evdev_filter

.PHONY: all clean
