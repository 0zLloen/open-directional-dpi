CC      ?= gcc
CFLAGS  ?= -std=c11 -O2 -Wall -Wextra -Werror -pedantic
LDFLAGS ?= -lm

TARGET   = test_directional_dpi
SRCS     = ../core/directional_dpi.c test_directional_dpi.c
QMK_RAW  = test_qmk_raw_hid
VECTORS  = vectors/scale_vectors.json

.PHONY: all test vectors clean

all: $(TARGET)

$(TARGET): $(SRCS) ../core/directional_dpi.h
	$(CC) $(CFLAGS) -o $(TARGET) $(SRCS) $(LDFLAGS)

# QMK raw HID transport (adapters/qmk, spec/hid-protocol-v1.md section 6) with the adapter's stand-ins
$(QMK_RAW): ../core/directional_dpi.c test_qmk_raw_hid.c ../adapters/qmk/odd_pointing_device.c ../core/directional_dpi.h
	$(CC) $(CFLAGS) -o $@ ../core/directional_dpi.c test_qmk_raw_hid.c $(LDFLAGS)

test: $(TARGET) $(QMK_RAW)
	./$(TARGET)
	./$(QMK_RAW)

gen_vectors: ../core/directional_dpi.c gen_vectors.c ../core/directional_dpi.h
	$(CC) $(CFLAGS) -o $@ ../core/directional_dpi.c gen_vectors.c $(LDFLAGS)

# Regenerate the checked-in conformance vectors (written via a temp file so a failed run keeps the old JSON)
vectors: gen_vectors
	./gen_vectors > $(VECTORS).tmp
	mv $(VECTORS).tmp $(VECTORS)

clean:
	rm -f $(TARGET) $(QMK_RAW) gen_vectors $(VECTORS).tmp
