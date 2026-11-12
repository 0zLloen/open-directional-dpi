/*
 * Open Directional DPI (ODD) v1 — Linux evdev-to-uinput Host Prototype Filter
 *
 * SPDX-License-Identifier: MIT
 *
 * Reads raw relative motion events (REL_X, REL_Y) paired per SYN_REPORT from a
 * physical mouse `/dev/input/eventX`, transforms them through the exact fixed-point
 * C reference engine (`core/directional_dpi.c`) with travel-window direction
 * estimation, and emits them through a virtual `/dev/uinput` mouse device that
 * mirrors every button and axis of the source mouse (extra buttons, hi-res wheels)
 * and its identity (bus/VID/PID, name, input properties), so libinput quirks and
 * per-device desktop settings keep applying. Its phys is ODD_PHYS.
 *
 * Self-check of the event handling (no /dev/uinput needed): ./odd_evdev_filter --selftest
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
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define ODD_PHYS     "odd-evdev-filter" /* marks the virtual mouse; never filtered again */
#define LONG_BITS    (8u * sizeof(unsigned long))
#define NLONGS(bits) (((bits) + LONG_BITS - 1u) / LONG_BITS)

static volatile sig_atomic_t g_keep_running = 1;

static void handle_sigint(int sig) {
    (void)sig;
    g_keep_running = 0;
}

static bool test_bit(const unsigned long *bits, unsigned bit) {
    return ((bits[bit / LONG_BITS] >> (bit % LONG_BITS)) & 1ul) != 0u;
}

static int16_t clamp_i16(int32_t v) {
    return (int16_t)(v > 32767 ? 32767 : (v < -32767 ? -32767 : v));
}

typedef struct {
    ddpi_engine_t engine;
    int32_t       dx, dy;   /* REL_X / REL_Y accumulated since the last SYN_REPORT */
    bool          dropping; /* after SYN_DROPPED: discard events up to the next SYN_REPORT */
} odd_filter_t;

/* Feed one source event; fills out[] with the events to forward and returns their count (<= 3). */
static int odd_filter_event(odd_filter_t *f, const struct input_event *in, struct input_event out[3]) {
    bool report = in->type == EV_SYN && in->code == SYN_REPORT;
    if (in->type == EV_SYN && in->code == SYN_DROPPED) {
        f->dx = f->dy = 0; /* this frame lost its tail */
        f->dropping = true;
        return 0;
    }
    if (f->dropping) {
        f->dropping = !report; /* the next frame lost its head */
        return 0;
    }
    if (in->type == EV_REL && in->code == REL_X) {
        f->dx += in->value;
        return 0;
    }
    if (in->type == EV_REL && in->code == REL_Y) {
        f->dy += in->value;
        return 0;
    }
    int n = 0;
    if (report && (f->dx != 0 || f->dy != 0)) {
        uint32_t now_ms = (uint32_t)((uint64_t)in->input_event_sec * 1000u + (uint64_t)in->input_event_usec / 1000u);
        int16_t  out_dx = 0;
        int16_t  out_dy = 0;
        ddpi_process_motion(&f->engine, clamp_i16(f->dx), clamp_i16(f->dy), now_ms, &out_dx, &out_dy);
        f->dx = f->dy = 0;
        if (out_dx != 0) out[n++] = (struct input_event){.type = EV_REL, .code = REL_X, .value = out_dx};
        if (out_dy != 0) out[n++] = (struct input_event){.type = EV_REL, .code = REL_Y, .value = out_dy};
    }
    out[n++] = *in; /* buttons, wheels and the SYN_REPORT itself pass through */
    return n;
}

/*
 * udev imports a mouse's hwdb entry (MOUSE_DPI, which libinput's adaptive speed
 * divides by, wheel click angles, trackball tag) only for devices with a USB or
 * PS/2 parent, which the virtual mouse lacks. Turns those properties from the
 * source's udev database entry into rule assignments; returns their count.
 */
static int hwdb_props_as_rule(FILE *db, char *out, size_t size) {
    char line[256];
    int  n = 0;
    out[0] = '\0';
    while (fgets(line, sizeof(line), db) != NULL) {
        char *eq = strchr(line, '=');
        if (eq == NULL || (strncmp(line, "E:MOUSE_", 8) != 0 && strncmp(line, "E:ID_INPUT_TRACKBALL=", 21) != 0)) {
            continue;
        }
        line[strcspn(line, "\n")] = '\0';
        *eq        = '\0';
        size_t len = strlen(out);
        snprintf(out + len, size - len, ", ENV{%s}=\"%s\"", line + 2, eq + 1);
        n++;
    }
    return n;
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

static int feed(odd_filter_t *f, uint16_t type, uint16_t code, int32_t value, uint32_t ms, struct input_event out[3]) {
    struct input_event in = {.type = type, .code = code, .value = value};
    in.input_event_sec  = ms / 1000u;
    in.input_event_usec = (ms % 1000u) * 1000u;
    return odd_filter_event(f, &in, out);
}

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            fprintf(stderr, "selftest failed (line %d): %s\n", __LINE__, #cond); \
            return 1;                                                          \
        }                                                                      \
    } while (0)

static int selftest(void) {
    odd_filter_t f = {0};
    ddpi_engine_init(&f.engine, 800u);
    ddpi_profile_v1_t p = f.engine.profile;
    p.flags = DDPI_FLAG_ENABLED;
    p.multipliers_q8_8[DDPI_DIR_S] = 128; /* 0.50x toward the user, 1.00x elsewhere */
    ddpi_profile_set_window_counts(&p, DDPI_DEFAULT_WINDOW_COUNTS);
    ddpi_engine_set_profile(&f.engine, &p);
    struct input_event out[3];

    /* Non-motion events pass through untouched */
    CHECK(feed(&f, EV_KEY, BTN_EXTRA, 1, 0, out) == 1 && out[0].code == BTN_EXTRA && out[0].value == 1);
    CHECK(feed(&f, EV_REL, REL_WHEEL_HI_RES, -60, 0, out) == 1 && out[0].code == REL_WHEEL_HI_RES);

    /* Event timestamps drive the idle reset: a South flick 200 ms after an East one is pure South */
    feed(&f, EV_REL, REL_X, 100, 1000, out);
    CHECK(feed(&f, EV_SYN, SYN_REPORT, 0, 1000, out) == 2 && out[0].code == REL_X && out[0].value == 100);
    feed(&f, EV_REL, REL_Y, 100, 1200, out);
    CHECK(feed(&f, EV_SYN, SYN_REPORT, 0, 1200, out) == 2 && out[0].code == REL_Y && out[0].value == 50);
    /* ... while 10 ms later it still leans toward the previous direction */
    feed(&f, EV_REL, REL_X, 100, 1300, out);
    feed(&f, EV_SYN, SYN_REPORT, 0, 1300, out);
    feed(&f, EV_REL, REL_Y, 100, 1310, out);
    CHECK(feed(&f, EV_SYN, SYN_REPORT, 0, 1310, out) == 2 && out[0].code == REL_Y && out[0].value > 50);

    /* SYN_DROPPED: the partial frame before it and the one after it are discarded */
    feed(&f, EV_REL, REL_X, 50, 2000, out);
    CHECK(feed(&f, EV_SYN, SYN_DROPPED, 0, 2000, out) == 0);
    CHECK(feed(&f, EV_REL, REL_Y, 30, 2000, out) == 0);
    CHECK(feed(&f, EV_KEY, BTN_LEFT, 1, 2000, out) == 0);
    CHECK(feed(&f, EV_SYN, SYN_REPORT, 0, 2000, out) == 0);
    feed(&f, EV_REL, REL_X, 100, 2001, out);
    CHECK(feed(&f, EV_SYN, SYN_REPORT, 0, 2001, out) == 2 && out[0].code == REL_X && out[0].value == 100);

    /* A frame larger than int16 saturates instead of wrapping */
    feed(&f, EV_REL, REL_X, 40000, 3000, out);
    CHECK(feed(&f, EV_SYN, SYN_REPORT, 0, 3000, out) == 2 && out[0].value == 32767);

    /* hwdb properties of the source become udev rule assignments */
    FILE *db = tmpfile();
    CHECK(db != NULL);
    fputs("I:123\nE:ID_INPUT_MOUSE=1\nE:MOUSE_DPI=3500@1000\nE:ID_INPUT_TRACKBALL=1\n", db);
    rewind(db);
    char rule[256];
    int  nprops = hwdb_props_as_rule(db, rule, sizeof(rule));
    fclose(db);
    CHECK(nprops == 2 && strcmp(rule, ", ENV{MOUSE_DPI}=\"3500@1000\", ENV{ID_INPUT_TRACKBALL}=\"1\"") == 0);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--selftest") == 0) {
        int rc = selftest();
        if (rc == 0) {
            puts("odd_evdev_filter selftest: OK");
        }
        return rc;
    }
    if (argc < 2) {
        fprintf(stderr,
                "Usage: %s </dev/input/eventX> [E SE S SW W NW N NE] [window_counts]\n"
                "       %s --selftest\n"
                "Example (South=0.50x, L=16 counts):\n"
                "  sudo %s /dev/input/event5 1.0 0.75 0.50 0.75 1.0 1.0 1.0 1.0 16\n",
                argv[0], argv[0], argv[0]);
        return 1;
    }

    odd_filter_t f;
    memset(&f, 0, sizeof(f));
    ddpi_engine_init(&f.engine, 800u);
    f.engine.profile.flags = DDPI_FLAG_ENABLED;
    ddpi_profile_set_window_counts(&f.engine.profile, DDPI_DEFAULT_WINDOW_COUNTS);

    if (argc >= 10) {
        for (int i = 0; i < 8; ++i) {
            double mult = strtod(argv[2 + i], NULL);
            int32_t q8  = (int32_t)(mult * 256.0 + 0.5);
            if (q8 < (int32_t)DDPI_Q8_8_MIN) q8 = (int32_t)DDPI_Q8_8_MIN;
            if (q8 > (int32_t)DDPI_Q8_8_MAX) q8 = (int32_t)DDPI_Q8_8_MAX;
            f.engine.profile.multipliers_q8_8[i] = (uint16_t)q8;
        }
    }
    if (argc >= 11) {
        int win = atoi(argv[10]);
        if (win < 0) win = 0;
        if (win > (int)DDPI_MAX_WINDOW_COUNTS) win = (int)DDPI_MAX_WINDOW_COUNTS;
        ddpi_profile_set_window_counts(&f.engine.profile, (uint8_t)win);
    }
    ddpi_engine_set_profile(&f.engine, &f.engine.profile);

    int evfd = open(argv[1], O_RDONLY);
    if (evfd < 0) {
        perror("open(evdev)");
        return 1;
    }

    unsigned long keys[NLONGS(KEY_CNT)];
    unsigned long rels[NLONGS(REL_CNT)];
    unsigned long props[NLONGS(INPUT_PROP_CNT)];
    char          phys[64] = {0};
    memset(keys, 0, sizeof(keys));
    memset(rels, 0, sizeof(rels));
    memset(props, 0, sizeof(props));
    if (ioctl(evfd, EVIOCGBIT(EV_KEY, sizeof(keys)), keys) < 0 ||
        ioctl(evfd, EVIOCGBIT(EV_REL, sizeof(rels)), rels) < 0 ||
        !test_bit(rels, REL_X) || !test_bit(rels, REL_Y)) {
        fprintf(stderr, "%s: not a relative pointer (no REL_X/REL_Y)\n", argv[1]);
        close(evfd);
        return 1;
    }
    ioctl(evfd, EVIOCGPHYS(sizeof(phys) - 1), phys);
    if (strcmp(phys, ODD_PHYS) == 0) {
        fprintf(stderr, "%s: is the virtual mouse of another odd_evdev_filter\n", argv[1]);
        close(evfd);
        return 1;
    }
    ioctl(evfd, EVIOCGPROP(sizeof(props)), props); /* fails on pre-2.6.38 kernels: no properties */

    struct uinput_setup usetup;
    memset(&usetup, 0, sizeof(usetup));
    if (ioctl(evfd, EVIOCGID, &usetup.id) < 0 ||
        ioctl(evfd, EVIOCGNAME(UINPUT_MAX_NAME_SIZE - 1), usetup.name) < 0) {
        perror("ioctl(EVIOCGID/EVIOCGNAME)");
        close(evfd);
        return 1;
    }

    /* Bluetooth clones still get the hwdb entry: udev keys ID_BUS on the bustype there */
    struct stat st;
    if (usetup.id.bustype != BUS_BLUETOOTH && fstat(evfd, &st) == 0) {
        char path[64];
        char assign[512];
        snprintf(path, sizeof(path), "/run/udev/data/c%u:%u", major(st.st_rdev), minor(st.st_rdev));
        FILE *db = fopen(path, "r");
        if (db != NULL && hwdb_props_as_rule(db, assign, sizeof(assign)) > 0) {
            fprintf(stderr,
                    "note: udev does not give the virtual mouse this mouse's hwdb settings; desktop pointer\n"
                    "speed changes without them. Keep them with this line in\n"
                    "/etc/udev/rules.d/71-odd-evdev-filter.rules (then restart the filter):\n"
                    "SUBSYSTEM==\"input\", KERNEL==\"event*\", ATTRS{phys}==\"" ODD_PHYS
                    "\", ATTRS{name}==\"%s\"%s\n",
                    usetup.name, assign);
        }
        if (db != NULL) fclose(db);
    }

    /* Without the grab both the real and the virtual mouse would move the cursor */
    if (ioctl(evfd, EVIOCGRAB, 1) < 0) {
        perror("ioctl(EVIOCGRAB)");
        close(evfd);
        return 1;
    }

    int ufd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (ufd < 0) {
        perror("open(/dev/uinput)");
        close(evfd);
        return 1;
    }

    /* Mirror the source's buttons, axes and properties, or uinput silently drops their events */
    ioctl(ufd, UI_SET_EVBIT, EV_KEY);
    for (unsigned k = 0; k < KEY_CNT; ++k) {
        if (test_bit(keys, k)) ioctl(ufd, UI_SET_KEYBIT, k);
    }
    ioctl(ufd, UI_SET_EVBIT, EV_REL);
    for (unsigned r = 0; r < REL_CNT; ++r) {
        if (test_bit(rels, r)) ioctl(ufd, UI_SET_RELBIT, r);
    }
    for (unsigned p = 0; p < INPUT_PROP_CNT; ++p) {
        if (test_bit(props, p)) ioctl(ufd, UI_SET_PROPBIT, p);
    }

    if (ioctl(ufd, UI_SET_PHYS, ODD_PHYS) < 0 || ioctl(ufd, UI_DEV_SETUP, &usetup) < 0 ||
        ioctl(ufd, UI_DEV_CREATE) < 0) {
        perror("ioctl(UI_DEV_CREATE)");
        close(ufd);
        close(evfd);
        return 1;
    }

    signal(SIGINT, handle_sigint);
    signal(SIGTERM, handle_sigint);

    while (g_keep_running) {
        struct input_event ev;
        struct input_event out[3];
        ssize_t n = read(evfd, &ev, sizeof(ev));
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n != (ssize_t)sizeof(ev)) {
            if (n < 0) perror("read(evdev)");
            break; /* EOF or device unplugged */
        }

        bool was_dropping = f.dropping;
        int  count        = odd_filter_event(&f, &ev, out);
        for (int i = 0; i < count; ++i) {
            emit_ev(ufd, out[i].type, out[i].code, out[i].value);
        }
        if (was_dropping && !f.dropping) {
            /* A dropped button release would stick: replay the current button state
             * (the input core ignores keys whose state did not change). */
            unsigned long state[NLONGS(KEY_CNT)];
            memset(state, 0, sizeof(state));
            if (ioctl(evfd, EVIOCGKEY(sizeof(state)), state) >= 0) {
                for (unsigned k = 0; k < KEY_CNT; ++k) {
                    if (test_bit(keys, k)) emit_ev(ufd, EV_KEY, (uint16_t)k, test_bit(state, k) ? 1 : 0);
                }
                emit_ev(ufd, EV_SYN, SYN_REPORT, 0);
            }
        }
    }

    ioctl(evfd, EVIOCGRAB, 0);
    ioctl(ufd, UI_DEV_DESTROY);
    close(ufd);
    close(evfd);
    return 0;
}
