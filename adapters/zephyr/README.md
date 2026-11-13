# Zephyr / ZMK input filter (`adapters/zephyr/`)

One Zephyr module for any Zephyr-based mouse or trackball: plain Zephyr
firmware, ZMK, and Keychron ZGM once its source is out.

`odd,directional-dpi` is a virtual input device, like upstream
`zephyr,input-longpress`. It listens to the `input` device (sensor driver, ZMK
split input, ...), runs every REL_X/REL_Y frame (the events up to `sync`)
through `core/directional_dpi.c`, and re-emits it **from itself**: X (if not 0),
then Y carrying the sync. Buttons, wheel and abs events pass through unchanged.

Bind your HID layer or listener to the **filter**, not the sensor. A callback on
all devices (`INPUT_CALLBACK_DEFINE(NULL, ...)`) would see the raw motion and
the filtered motion.

Works with Zephyr 3.5 through 4.5 (tested on 3.5.0, 3.7.2, 4.5.0 and ZMK main),
in both `CONFIG_INPUT_MODE_THREAD` and `CONFIG_INPUT_MODE_SYNCHRONOUS`. nRF
Connect SDK 2.7 (Zephyr 3.6.99) has the same input API as 3.7.2; the build
checks `input.h` for it, not the version number.

A frame normally ends at the sync on its last axis. `wch,ch9350l` (the USB HID
mouse bridge, Zephyr 4.4+) puts a sync on REL_X and another on REL_Y of each
report: set `merge-axis-syncs;` on the filter node for it, or every report is
filtered as two axis-aligned moves and the diagonal gains are lost.

## Add the module

`west.yml`:

```yaml
manifest:
  remotes:
    - name: odd
      url-base: https://github.com/0zLloen
  projects:
    - name: open-directional-dpi
      remote: odd
      revision: main
```

Or without west: `-DZEPHYR_EXTRA_MODULES=/path/to/open-directional-dpi`
(ZMK: `-DZMK_EXTRA_MODULES=/path/to/open-directional-dpi`). The module file is
`zephyr/module.yml` at the repo root.

`CONFIG_ODD_DIRECTIONAL_DPI` turns on by itself once a node with the
compatible exists and `CONFIG_INPUT=y`.

## Plain Zephyr

```dts
#include <zephyr/dt-bindings/input/input-event-codes.h>

/ {
	odd_filter: odd-filter {
		compatible = "odd,directional-dpi";
		input = <&sensor>;              /* e.g. a pixart,pmw3610 / paw32xx node */
		/* optional boot curve, Q8.8 (256 = 1.00x), E SE S SW W NW N NE, +Y = toward you */
		multipliers-q8-8 = <256 240 230 240 256 270 280 270>;
	};
};
```

```c
static void mouse_cb(struct input_event *evt, void *user_data) { /* build HID report */ }
INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_NODELABEL(odd_filter)), mouse_cb, NULL);
```

On Zephyr < 4.0 the callback has no `user_data` argument and the macro takes
two arguments.

Other properties: `global-gain-q8-8`, `base-dpi`, `window-counts` (default 16),
`idle-ms` (default 50), `merge-axis-syncs`. See `dts/bindings/odd,directional-dpi.yaml`.

The curve applies to the axes the sensor driver reports. If the sensor is
mounted rotated, fix that in the sensor node (`zephyr,axis-x/-y`,
`invert-x/-y` on PixArt drivers), not after the filter.

## ZMK

Move the listener from the sensor to the filter:

```dts
/ {
    odd_filter: odd_filter {
        compatible = "odd,directional-dpi";
        input = <&trackball>;
    };

    trackball_listener {
        compatible = "zmk,input-listener";
        device = <&odd_filter>;          /* was <&trackball> */
        /* input-processors (scalers, transforms) still go here */
    };
};
```

Add the module to `config/west.yml` as above. On a split, either filter on the
central (`input = <&split_input>`) or set the peripheral's `zmk,input-split`
`device = <&odd_filter>`.

ZMK has no vendor HID feature report, so on ZMK the curve comes from the
devicetree unless you add one (see below).

## Keychron ZGM

ZGM is plain Zephyr per Keychron's README, but its source is not public yet.
When it is: add this module, put an `odd,directional-dpi` node on the sensor
node, and point ZGM's input listener / HID layer at the filter device. Call
`odd_input_hid_feature_report()` from its vendor HID handler.

## HID feature report (profile editing from OpenMouse)

Zephyr has no generic routing for vendor feature reports, so the firmware's own
HID handler calls the filter. Report descriptor (unnumbered, 64-byte feature):
`06 ff ff 09 00 a1 01 09 00 15 00 25 01 75 08 95 40 b1 02 c0`. With the
`usbd_hid` stack:

```c
#include <odd_input.h>

static uint8_t odd_resp[64];

static int set_report(const struct device *dev, uint8_t type, uint8_t id,
		      uint16_t len, const uint8_t *buf)
{
	if (type != HID_REPORT_TYPE_FEATURE || len != 64) {
		return -ENOTSUP;
	}
	/* intercept 0x0F ENTER_BOOTLOADER here if the board supports it */
	return odd_input_hid_feature_report(DEVICE_DT_GET(DT_NODELABEL(odd_filter)),
					    buf, odd_resp) ? 0 : -ENOTSUP;
}

static int get_report(const struct device *dev, uint8_t type, uint8_t id,
		      uint16_t len, uint8_t *buf)
{
	if (type != HID_REPORT_TYPE_FEATURE) {
		return -ENOTSUP;
	}
	memcpy(buf, odd_resp, MIN(len, sizeof(odd_resp)));
	return MIN(len, sizeof(odd_resp));
}
```

OpenMouse only talks to a non-Glorious device whose USB product string contains
`[OpenDDPIv1]` (WebHID exposes no `bcdDevice`). Legacy USB stack:
`CONFIG_USB_DEVICE_PRODUCT="My Mouse [OpenDDPIv1]"` (ZMK fills it from
`CONFIG_ZMK_KEYBOARD_NAME`); `device_next`: the string given to
`USBD_DESC_PRODUCT_DEFINE()`.

`SAVE_FLASH` needs `CONFIG_SETTINGS` (and the app calling `settings_load()`,
which ZMK does). The profile is stored under `odd/<node name>`
`CONFIG_ODD_DIRECTIONAL_DPI_SAVE_DELAY_MS` (default 500) after the request and
replaces the devicetree curve at boot; invalid stored data is ignored. Without
settings, `SAVE_FLASH` answers "unsupported".

## Tests

`tests/filter` is a ztest app for `native_sim` (thread and synchronous input
modes, with and without settings, and a source that syncs both axes):

```sh
$ZEPHYR_BASE/scripts/twister -T adapters/zephyr/tests -p native_sim/native/64
```

`tests/zmk` holds the overlay CI uses to compile ZMK for `nice_nano//zmk`
(PMW3610 -> filter -> `zmk,input-listener`). See `.github/workflows/zephyr.yml`.
