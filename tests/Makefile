CC      ?= gcc
CFLAGS  ?= -std=c11 -O2 -Wall -Wextra -Werror -pedantic
LDFLAGS ?= -lm

TARGET   = test_directional_dpi
SRCS     = ../core/directional_dpi.c test_directional_dpi.c

.PHONY: all test clean

all: $(TARGET)

$(TARGET): $(SRCS) ../core/directional_dpi.h
	$(CC) $(CFLAGS) -o $(TARGET) $(SRCS) $(LDFLAGS)

test: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET)
