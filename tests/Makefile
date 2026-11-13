CC      ?= gcc
CFLAGS  ?= -std=c11 -O2 -Wall -Wextra -Werror -pedantic
LDFLAGS ?= -lm

TARGET   = test_directional_dpi
SRCS     = ../core/directional_dpi.c test_directional_dpi.c
VECTORS  = vectors/scale_vectors.json

.PHONY: all test vectors clean

all: $(TARGET)

$(TARGET): $(SRCS) ../core/directional_dpi.h
	$(CC) $(CFLAGS) -o $(TARGET) $(SRCS) $(LDFLAGS)

test: $(TARGET)
	./$(TARGET)

gen_vectors: ../core/directional_dpi.c gen_vectors.c ../core/directional_dpi.h
	$(CC) $(CFLAGS) -o $@ ../core/directional_dpi.c gen_vectors.c $(LDFLAGS)

# Regenerate the checked-in conformance vectors (written via a temp file so a failed run keeps the old JSON)
vectors: gen_vectors
	./gen_vectors > $(VECTORS).tmp
	mv $(VECTORS).tmp $(VECTORS)

clean:
	rm -f $(TARGET) gen_vectors $(VECTORS).tmp
