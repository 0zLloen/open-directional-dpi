/*
 * Open Directional DPI (ODD) v1 — Linux evdev-to-uinput Host Prototype Filter
 *
 * SPDX-License-Identifier: MIT
 *
 * Reads raw relative motion events (REL_X, REL_Y) paired per SYN_REPORT from a
 * physical mouse `/dev/input/eventX`, transforms them through the exact fixed-point
 * C reference engine (`core/directional_dpi.c`) with travel-window direction
 * estimation, and emits them through a virtual `/dev/uinput` mouse device.
 */

#include "../../core/directional_dpi.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static volatile sig_atomic_t g_keep_running = 1;

static void handle_sigint(int sig) {
    (void)sig;
    g_keep_running = 0;
}

static uint64_t timeval_to_ms(const struct timeval *tv) {
    return (uint64_t)tv->tv_sec * 1000ULL + (uint64_t)(tv->tv_usec / 1000);
}

static void emit_ev(int ufd, uint16_t type, uint16_t code, int32_t val) {
    struct input_event ie;
    memset(&ie, 0, sizeof(ie));
    ie.type  = type;
    ie.code  = code;
    ie.value = val;
    if (write(ufd, &ie, sizeof(ie)) < 0) {
        /* Ignore transient write errors on teardown */
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
                "Usage: %s </dev/input/eventX> [E SE S SW W NW N NE] [window_counts]\n"
                "Example (South=0.50x, L=16 counts):\n"
                "  sudo %s /dev/input/event5 1.0 0.75 0.50 0.75 1.0 1.0 1.0 1.0 16\n",
                argv[0], argv[0]);
        return 1;
    }

    ddpi_engine_t engine;
    ddpi_engine_init(&engine, 800u);
    engine.profile.flags = DDPI_FLAG_ENABLED;
    ddpi_profile_set_window_counts(&engine.profile, DDPI_DEFAULT_WINDOW_COUNTS);

    if (argc >= 10) {
        for (int i = 0; i < 8; ++i) {
            double mult = strtod(argv[2 + i], NULL);
            int32_t q8  = (int32_t)(mult * 256.0 + 0.5);
            if (q8 < (int32_t)DDPI_Q8_8_MIN) q8 = (int32_t)DDPI_Q8_8_MIN;
            if (q8 > (int32_t)DDPI_Q8_8_MAX) q8 = (int32_t)DDPI_Q8_8_MAX;
            engine.profile.multipliers_q8_8[i] = (uint16_t)q8;
        }
    }
    if (argc >= 11) {
        int win = atoi(argv[10]);
        if (win < 0) win = 0;
        if (win > (int)DDPI_MAX_WINDOW_COUNTS) win = (int)DDPI_MAX_WINDOW_COUNTS;
        ddpi_profile_set_window_counts(&engine.profile, (uint8_t)win);
    }
    ddpi_engine_set_profile(&engine, &engine.profile);

    int evfd = open(argv[1], O_RDONLY);
    if (evfd < 0) {
        perror("open(evdev)");
        return 1;
    }

    int ufd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (ufd < 0) {
        perror("open(/dev/uinput)");
        close(evfd);
        return 1;
    }

    ioctl(ufd, UI_SET_EVBIT, EV_KEY);
    ioctl(ufd, UI_SET_KEYBIT, BTN_LEFT);
    ioctl(ufd, UI_SET_KEYBIT, BTN_RIGHT);
    ioctl(ufd, UI_SET_KEYBIT, BTN_MIDDLE);
    ioctl(ufd, UI_SET_KEYBIT, BTN_SIDE);
    ioctl(ufd, UI_SET_KEYBIT, BTN_EXTRA);

    ioctl(ufd, UI_SET_EVBIT, EV_REL);
    ioctl(ufd, UI_SET_RELBIT, REL_X);
    ioctl(ufd, UI_SET_RELBIT, REL_Y);
    ioctl(ufd, UI_SET_RELBIT, REL_WHEEL);
    ioctl(ufd, UI_SET_RELBIT, REL_HWHEEL);

    struct uinput_setup usetup;
    memset(&usetup, 0, sizeof(usetup));
    usetup.id.bustype = BUS_USB;
    usetup.id.vendor  = 0x1209;
    usetup.id.product = 0x4450;
    snprintf(usetup.name, UINPUT_MAX_NAME_SIZE, "Open Directional Sensitivity Virtual Mouse");

    if (ioctl(ufd, UI_DEV_SETUP, &usetup) < 0 || ioctl(ufd, UI_DEV_CREATE) < 0) {
        perror("ioctl(UI_DEV_CREATE)");
        close(ufd);
        close(evfd);
        return 1;
    }

    if (ioctl(evfd, EVIOCGRAB, 1) < 0) {
        perror("ioctl(EVIOCGRAB)");
    }

    signal(SIGINT, handle_sigint);
    signal(SIGTERM, handle_sigint);

    int32_t  acc_dx         = 0;
    int32_t  acc_dy         = 0;
    uint64_t last_motion_ms = 0;

    while (g_keep_running) {
        struct input_event ev;
        ssize_t n = read(evfd, &ev, sizeof(ev));
        if (n != (ssize_t)sizeof(ev)) {
            if (errno == EINTR) continue;
            break;
        }

        if (ev.type == EV_REL) {
            if (ev.code == REL_X) {
                acc_dx += ev.value;
            } else if (ev.code == REL_Y) {
                acc_dy += ev.value;
            } else {
                emit_ev(ufd, ev.type, ev.code, ev.value);
            }
        } else if (ev.type == EV_SYN && ev.code == SYN_REPORT) {
            if (acc_dx != 0 || acc_dy != 0) {
                uint64_t now_ms = timeval_to_ms(&ev.time);
                if (last_motion_ms != 0 && (now_ms - last_motion_ms) >= 50ULL) {
                    ddpi_engine_notify_idle(&engine);
                }
                last_motion_ms = now_ms;

                int16_t in_dx  = (acc_dx > 32767) ? 32767 : ((acc_dx < -32767) ? -32767 : (int16_t)acc_dx);
                int16_t in_dy  = (acc_dy > 32767) ? 32767 : ((acc_dy < -32767) ? -32767 : (int16_t)acc_dy);
                int16_t out_dx = 0;
                int16_t out_dy = 0;
                ddpi_process_delta(&engine, in_dx, in_dy, &out_dx, &out_dy);
                if (out_dx != 0) emit_ev(ufd, EV_REL, REL_X, out_dx);
                if (out_dy != 0) emit_ev(ufd, EV_REL, REL_Y, out_dy);
                acc_dx = 0;
                acc_dy = 0;
            }
            emit_ev(ufd, EV_SYN, SYN_REPORT, 0);
        } else {
            emit_ev(ufd, ev.type, ev.code, ev.value);
        }
    }

    ioctl(evfd, EVIOCGRAB, 0);
    ioctl(ufd, UI_DEV_DESTROY);
    close(ufd);
    close(evfd);
    return 0;
}
