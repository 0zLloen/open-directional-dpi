# Glorious Series One Pro stock-firmware patch (`adapters/glorious-cm2856/`)

Adds Open Directional DPI to the Glorious Series One Pro (Compx CM2856: nRF52840 + PAW3370) running stock firmware `CM2856_Mouse_USB v1.00.00`. The build appends the patch code to the stock image, redirects four stock call sites to it (boot, the vendor Feature-report handler, two sensor reads) and replaces the sensor DPI writer instruction and the two 2.4 GHz reply-length reads; it asserts that every other byte equals the stock image. Profiles arrive as an HID feature report, over the cable or through the 2.4 GHz receiver, and can be saved to flash.

Status (2026-11-13): build `21ea252` is verified on a retail mouse, by cable and through the receiver ([Verified on hardware](#verified-on-hardware)). No build after `21ea252` has run on hardware, and nothing has been run on Windows or macOS ([Not yet tested on hardware](#not-yet-tested-on-hardware)).

| File | |
| :--- | :--- |
| `stock_ddpi_patch.c`, `stock_ddpi_patch.ld` | The patch and its linker script (`make check` compiles and links them) |
| `build_and_verify_patch.py` | Builds the `.hex` and the patch file and runs the 11 Unicorn tests; needs your stock image |
| `apply_patch.py` | Patch file + your stock `.hex` -> flashable `.hex`, without the ARM toolchain |
| `test_apply_patch.py` | The patch file and `apply_patch.py` on a synthetic image (no vendor bytes; runs in CI) |

The Compx USB flasher (`compx_usb_flasher.py`), `compx_hex_tool.py` and the reverse-engineering notes for this mouse are in [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re). Clone it next to this repo, or point `COMPX_TOOLS` at its `platforms/compx-nrf52/tools`.

Porting the patch to another stock firmware: [`docs/porting-checklist.md`](../../docs/porting-checklist.md).

## Never publish the built image

- Never publish or commit the built `.hex` / `.bin`, or any other vendor image (repo, release, issue or discussion): it contains Glorious's firmware. Everyone builds it from their own stock image.
- The one build output that may go on a release is `adapters/build/OpenDDPIv1-patch.json`. It holds only the bytes this project wrote (hook instructions and patch code; the build asserts that every other byte equals the stock image).
- `apply_patch.py` turns it plus your own stock image into the flashable `.hex` (see [Windows and macOS](#windows-and-macos-untested)).

## Get your stock image

Decode the official package into `adapters/stock/`:

```bash
compx_hex_tool.py decode --target mouse -o adapters/stock/CM2856_Mouse_USB_v1.00.00_20220810.bin <official CM2856_Mouse_USB_v1.00.00_20220810.hex>
```

- The official package is no longer downloadable from Glorious. Its SHA-256 is in mouse-firmware-re (`devices/glorious-series-one-pro/device.yaml`).
- No package? On a mouse still on stock v1.0.0.0, dump it and build from the dump (the official `.hex` works the same way):

  ```bash
  compx_usb_flasher.py dump --out mine.hex
  python3 adapters/glorious-cm2856/build_and_verify_patch.py --stock-hex mine.hex
  ```

- The build refuses any stock image whose decoded SHA-256 is not `e50510e0eb213e69d62a088d6f5b792fb88b0f3dc56d3c9c21dd0ca8b6e892be`.

## Build

- `make -C adapters/glorious-cm2856 check` only compiles and links the patch.
- `python3 adapters/glorious-cm2856/build_and_verify_patch.py` writes the flashable `adapters/build/CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex` and the patch file `OpenDDPIv1-patch.json`.
- It needs the stock image, `compx_hex_tool.py`, `arm-none-eabi-gcc` (or `CROSS=<prefix>`, as for make) and unicorn (`pip install unicorn`), and exits non-zero if any of them is missing.

Checked against the real stock image (2026-11-13): all four hook sites, the sensor DPI writer instruction at `0x17864` and both 2.4 GHz length reads match the expected stock code, and the 11 Unicorn emulation tests pass. They include the 2.4 GHz relay, the 64-byte reply cap, a second identical `SAVE_FLASH` that skips the page erase, the idle reset of the direction estimator after 50 sensor-read ticks, and a DPI-shift press and release (test 11).

## Flash and go back to stock

Verified on Linux with hidraw. Windows and macOS: see [Windows and macOS (untested)](#windows-and-macos-untested).

```bash
compx_usb_flasher.py dump --out backup.hex
compx_usb_flasher.py flash --firmware-hex adapters/build/CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex
```

To go back to stock, flash the official `.hex` the same way (verified, see [Retail mouse](#retail-mouse)). Stuck in the bootloader: see [Recovery](#recovery).

What the backup and the bootloader's `Erase` cover:

- The backup covers `0x6000..0x4D7FF` only (the bootloader refuses reads from `0x4D800` up), so it holds neither the saved profile (`0x7E000`) nor the pairing pages (`0x88000`+).
- `Erase` clears `0x1E000` up to at least `0x4D7FF`, keeps `0x6000..0x1DFFF` and does not reach `0x7E000` (verified 2026-11-13); whether it reaches `0x88000`+ is unknown.
- The patch's linker region ends at `0x1E000`, so the whole image stays in the range `Erase` keeps.

## Load a profile (`tools/odd_profile.py`)

```bash
python3 tools/odd_profile.py load profile.json --save
```

- `profile.json` is the JSON from `calibrate.html` or `calibration/cli.ts`. `info` shows the current DPI and profile; `export` and `reset` do what they say.
- Calibrating? Turn the curve off first: `python3 tools/odd_profile.py reset` (RAM only), or **Turn curve off for calibration** in `calibrate.html`.
- It needs access to the mouse's hidraw node: install mouse-firmware-re `devices/glorious-series-one-pro/udev/70-glorious-series-one-pro.rules` (cable, receiver and bootloader), or run it as root.
- `--device /dev/hidrawN` only picks among supported nodes; any other node is refused.
- It works over the cable and through the 2.4 GHz receiver ([below](#through-the-24-ghz-receiver)).
- From the browser: **Send to mouse** in `calibrate.html` (WebHID, Chrome or Edge) sends the profile calibrated in that page, and **Save on mouse** keeps it ([Windows and macOS](#windows-and-macos-untested); not yet tested on hardware).

### Backends

- `hidraw` (Linux default, standard library) and `hidapi` (Windows and macOS default; `pip install hidapi`).
- On Linux, `--backend hidapi` loads cython-hidapi's `hidraw` module, never its libusb `hid` module, which detaches the kernel driver from the interface while it is open.
- With hidapi it picks the collection with usage page `0xFFFF`, usage `0` (interface 2, the node the hidraw backend picks; interface 1 also has vendor collections, which Windows lists as devices of their own).
- Feature reports go out as 65 bytes (report ID `0` + 64), and the report-ID byte hidapi puts first in replies is dropped. Windows needs exactly these full-length buffers.
- Only checked against fakes (`tools/test_odd_profile.py`, 2026-11-13).

`odd_profile.py` also loads profiles onto QMK boards over raw HID: see [`adapters/qmk/README.md`](../qmk/README.md#hid-protocol-over-raw-hid-via-vial).

## Through the 2.4 GHz receiver

- `odd_profile.py` works through the receiver (`258a:2031`, verified 2026-11-13: info, load, save, export, reset; the receiver's own queries still answer normally afterwards).
- A profile saved through the receiver survived switching the mouse off and on (2026-11-13, build `21ea252`).
- The receiver path needs a patch build with the 2.4 GHz relay (commit `505404c` / PR #6 or later). Older builds get "no DP01 stamp through the receiver" from `odd_profile.py`.
- **Send to mouse** in `calibrate.html` ([above](#load-a-profile-toolsodd_profilepy)) goes through the receiver with the same envelope (not yet tested on hardware).

### Link wait and retry

- Through the receiver, requests failed with `0xA4` while the mouse was still or only scrolling, and worked while it moved (retail mouse, 2026-11-13; cause unknown).
- So `odd_profile.py`, `calibrate.html` and the `integrations/openmouse` client ask the receiver before every relayed request whether it can reach the mouse (the receiver's own link-state query `0x89`).
- With no link they ask you to move or click the mouse and wait up to 15 s. A request that still ends in `0xA4` is sent once more, except `SIMULATE_DELTA` ([`spec/hid-protocol-v1.md`](../../spec/hid-protocol-v1.md) §2.3).
- Nothing changes on the cable.
- Only checked against fakes; not yet run on hardware (2026-11-13).

The radio link itself stays as stock. Changing it would need new receiver firmware (the receiver has never been flashed and its bootloader is untested) or a reimplementation of Compx's undocumented radio format.

## Windows and macOS (untested)

Nothing in this section has been run on Windows or macOS yet (2026-11-13). The prebuilt patch file and `apply_patch.py` were checked on Linux, `odd_profile.py` with hidapi only against fakes.

There are two ways in: `apply_patch.py`, the flasher and `odd_profile.py` through hidapi (the steps below), or **Send to mouse** in [`calibrate.html`](https://0zlloen.github.io/open-directional-dpi/) (WebHID, Chrome or Edge; see [Load a profile](#load-a-profile-toolsodd_profilepy)). The OpenMouse app does not include the client in `integrations/openmouse` yet.

1. Install Python 3.10 or later (python.org; on Windows tick "Add python.exe to PATH"), then the PyPI package `hidapi`: `python -m pip install hidapi` (Windows: `py -m pip install hidapi`). Not the package named `hid`, a different library; `odd_profile.py` refuses it. No udev rules or root access are needed on these systems.
2. Get this repo and [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re) side by side (`git clone` both into the same folder), or set `COMPX_TOOLS` to mouse-firmware-re's `platforms/compx-nrf52/tools`. Its `compx_usb_flasher.py` needs a version with `--backend hidapi`, the default there off Linux.
3. **Do not run `compx_usb_flasher.py` (steps 3 and 5) on Windows or macOS until the bootloader's report descriptor is recorded; dump and flash from Linux until then.** Both commands switch the mouse into its bootloader (`258a:2103`), where the flasher's hidapi backend looks for the collection with usage page `0xFFFF`, usage `0`, a pair verified for the application only. If the bootloader uses another one, the mouse stays in it and only the flasher on Linux can send `Exit` ([Recovery](#recovery)).

   Back up the mouse (from the repo root; `py` instead of `python` on Windows):

   ```text
   python ../mouse-firmware-re/platforms/compx-nrf52/tools/compx_usb_flasher.py dump --out backup.hex
   ```

   The dump is your backup and, without the official `.hex`, your stock image.
4. Apply the patch. `apply_patch.py` is safe to run anywhere. Download `OpenDDPIv1-patch.json` from this repo's GitHub release. It has no stock bytes, so you also need your own stock image: the official `CM2856_Mouse_USB_v1.00.00_20220810.hex`, or the step 3 dump of a mouse still on stock v1.0.0.0 (pass the official `.hex` to `--stock-hex` instead if you have it):

   ```text
   python adapters/glorious-cm2856/apply_patch.py --stock-hex backup.hex --patch OpenDDPIv1-patch.json -o OpenDDPIv1.hex
   ```

   `apply_patch.py` refuses a stock image whose decoded SHA-256 is not the patch file's (`e50510e0...`), and writes nothing unless the patched image matches the patch file's SHA-256, the image the Linux build checked in Unicorn. Checked on Linux (2026-11-13): from the official `.hex` and from a retail dump it wrote the build's `.hex` byte for byte (image SHA-256 `34d827d5...`, the hardware-verified build `21ea252`), and it refused a stock image with one changed byte and a patch file with one changed digit.
5. Flash (from Linux for now, see step 3):

   ```text
   python ../mouse-firmware-re/platforms/compx-nrf52/tools/compx_usb_flasher.py flash --firmware-hex OpenDDPIv1.hex
   ```

   To go back to stock, flash the official `.hex` (verified on Linux, see [Flash and go back to stock](#flash-and-go-back-to-stock)).
6. Profiles: `python tools/odd_profile.py info`, `load profile.json --save`, `export`, `reset`, as on Linux; hidapi is the default backend there. `--device` takes the path it lists when several devices are found.

## How the patch follows the mouse

### Idle-reset clock

- The patch resets the direction estimator after the profile's idle gap (default 50 ms). It counts stock sensor-read calls as milliseconds: one per 1 ms TIMER1 tick while the mouse is still (from the stock disassembly).
- Verified on the cable (2026-11-13, `21ea252`): with the mouse still, the clock in `GET_CAPABILITIES` bytes `20..23`, read once a second for 12 s, ran at 1000.0 ticks/s. The reset itself is checked in Unicorn (test 10).
- Over 2.4 GHz the rate was not measured: relayed requests failed while the mouse was still ([Link wait and retry](#link-wait-and-retry)). Inferred to be the same: TIMER1 runs in every awake radio state (linked, retrying, searching) and stops only on the way into System OFF (stock disassembly and Unicorn emulation, 2026-11-13).
- `505404c` has no idle reset.

### DPI tracking and DPI shift

- A profile with `onlyAtBaseDpi` applies only while the sensor runs at its `baseDpi`. The patch records the DPI the stock firmware writes to the sensor (a hook on the stock sensor DPI writer instruction at `0x17864`, which every DPI path calls), so a held DPI-shift key turns the curve off.
- Emulation only (Unicorn test 11, 2026-11-13), builds after `56afbb4`. Up to `56afbb4` the patch used the stock active DPI at `0x20003068`, which misses a held DPI-shift key ([porting checklist](../../docs/porting-checklist.md)).
- In `calibrate.html`, tick "Only at this DPI" and enter that stage's DPI as the base CPI.

### Stock onboard profiles

- The stock firmware keeps three, and the patch uses one curve for all three.
- In the factory configuration nothing on the mouse switches profiles: no button is mapped to it and no button combination does it (Inferred: Unicorn emulation of the stock image, 2026-11-13). Only vendor software can.
- A profile switch changes the DPI, so for a curve that applies only at one profile's DPI, tick "Only at this DPI" (`onlyAtBaseDpi`).

## Recovery

Verified on the cable (2026-11-13, `21ea252`):

- DDPI `ENTER_BOOTLOADER` with the magic `"BLRS"` (`0x424C5253`) gives the bootloader `258a:2103` after 1.0 s. Without it the patch answers `0xA4` (range error) and stays in the application.
- Holding LMB + RMB + DPI while the mouse powers up on the cable also gives `258a:2103` "Glorious bootloader". This confirms that the three pins the patch samples (P1.15, P1.13, P1.00) read low with the chord held. Which pin is which button (Left, Right, DPI) comes from the stock disassembly; this test does not tell them apart.
- To leave the bootloader without writing anything: `compx_usb_flasher.py dump --out <new file> --end 0x6020` (reads 32 bytes, then sends Exit). It returned the mouse to `258a:2018` three times.

## Verified on hardware

### Retail mouse

Verified on a retail mouse (2026-11-13), flashed with the read-back-verified flasher from mouse-firmware-re:

- It boots, the version reply carries `DP01`, and `GET_CAPABILITIES` / `GET_PROFILE` answer.
- With a RAM-only profile (up at 0.50x, window 0), up-and-down hand motion went from an up/down count ratio of 0.913 to 0.618 on the cable.
- Through the 2.4 GHz receiver the curve applies the same way: 0.938 flat vs 0.570 with up at 0.50x.
- `SIMULATE_DELTA` with the sensor idle matched the C engine bit for bit.
- `SAVE_FLASH` writes the profile to `0x7E000`: it survived a reboot and two full USB flashes (stock image restored, then the patch flashed again).
- Rolling back with the official `.hex` was verified the same way.
- Polling with the patch: 1000 Hz on the cable, about 963 Hz through the receiver while moving. Browser polling testers (OpenMouse showed 565 Hz) count coalesced `pointermove` events, not USB reports.

### Hardware-verified build

- Commit `21ea252` (branch `fix/audit-followups`, after PR #7 was merged): decoded image SHA-256 `34d827d537816fff3e5595bbe4c7b736e6af428a724f4732307385911f422c34`, 96,992 B, `0x6000..0x1DADF`, flashed and read back with the mouse-firmware-re flasher (2026-11-13).
- It adds the unchanged-save compare, the idle reset and the clock in `GET_CAPABILITIES` to `505404c`, the first build with the 2.4 GHz relay (SHA-256 `0ed3cb4b74d0ab5192f3708c40b25be52912c91876b973d0d8d3b821c17b794a`, 96,864 B, `0x6000..0x1DA5F`; a rebuild with Zephyr SDK 0.16.9 (gcc 12.2.0) gave the same code).
- Verified on `21ea252` through the receiver (2026-11-13): the curve applies (up/down ratio 0.681 with up at 0.50x, against 0.938 flat in the earlier test), and a second identical `SAVE_FLASH` answers in 24 ms instead of 402 ms (no page erase, no `0xA4`).
- No build after `21ea252` has run on hardware.

## Compilers

- The hardware-verified image `34d827d5...` was built with gcc 12.2.0 (Zephyr SDK 0.16.9).
- The same patch code at main `56afbb4` (only comments changed since `21ea252`) built with arm-none-eabi-gcc 13.2.1 (`13.2.rel1-2`, 20231009) gives SHA-256 `066e55e88bdeb697cd677e9b28fb257d7567bc98baedc14115ae28ef1899e67a`, 96,896 B.
- Both pass the 10 Unicorn tests of their commit, but only the gcc 12.2.0 image has run on a mouse.

## Not yet tested on hardware

- `calibrate.html` with the mouse in a real browser (**Send to mouse**, **Save on mouse**, **Turn curve off for calibration**).
- The idle-clock rate over 2.4 GHz (inferred, see [Idle-reset clock](#idle-reset-clock)).
- The link wait and retry through the receiver.
- `sensor_dpi` with a held DPI-shift key (Unicorn test 11 only).
- The ZMK board for this mouse in mouse-firmware-re (`devices/glorious-series-one-pro/zmk-board/`, never flashed), whose boot chord is separate code from the patch's.
- Any build after `21ea252`, and anything on Windows or macOS.
