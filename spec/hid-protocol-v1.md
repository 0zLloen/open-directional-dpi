# Open Directional DPI — USB HID Configuration Protocol v1 (`hid-protocol-v1`)

Reference handler: `ddpi_hid_handle_feature_report()` in `core/directional_dpi.c`. The device passes each 64-byte Feature report it receives (SET_REPORT) to the handler and returns the 64-byte response on the next GET_REPORT. The handler returns `false` for packets that are not Open Directional DPI framed (§3), so the firmware can hand those to its own code.

The device supplies two optional callbacks: `on_save_flash` (persist the profile) and `on_enter_bootloader`. A device that passes `NULL` for one answers that command with `0xA3` (unsupported) and does not advertise it in `GET_CAPABILITIES`.

---

## 1. Transport

- One unnumbered (Report ID `0x00`), vendor-defined **Feature** report of **64 bytes**, descriptor `06 ff ff 09 00 a1 01 09 00 15 00 25 01 75 08 95 40 b1 02 c0` (Usage Page `0xFFFF`, Usage `0x0000`).
- Host side: 65 bytes `[0x00, b0..b63]` with HIDAPI / `hidraw` / Windows HID, or `sendFeatureReport(0x00, Uint8Array(64))` in WebHID.

Where each route gets it:
- **Glorious Series One Pro** (stock-firmware patch): the stock firmware already has this report on USB interface 2 of `258a:2018` (wired) and `258a:2031` (receiver); the patch adds the protocol to it.
- **Zephyr / ZMK / ZGM**: the firmware's own HID handler calls `odd_input_hid_feature_report()` and its USB product string carries `[OpenDDPIv1]` (see `adapters/zephyr/README.md`). ZMK has no vendor feature report by default, so there the profile comes from devicetree.
- **QMK** and the **Linux evdev filter** do not implement this protocol; their profile is set in `keymap.c` or on the command line.

---

## 2. Glorious-Specific: Stock vs. Patched Firmware Detection

This section applies only to the Glorious Series One Pro (Compx CM2856).

### 2.1 Stock Compx firmware (`CM2856_Mouse_USB` v1.0.0.0) Feature reports
Payload indices (`feat[i] = buf[i+1]`, `buf[0]` = Report ID `0x00`), verified on a retail mouse (2026-11-13):
- `feat[0]` status in replies (`0xA1` OK), `feat[2]` target (`0x00` cable, `0x02` forwarded by the receiver, §2.3), `feat[3]` length, `feat[4]` command group, `feat[5]` command, `feat[6..]` data.
- Firmware version: `feat[3] = 0x06, feat[4] = 0x00, feat[5] = 0x81` -> `a1 00 00 03 00 81 01 00 00 00 20 18` (v1.0.0.0, PID `0x2018`; the official updater sends `feat[3] = 0x03`).
- Battery (wired): command `0x83` -> `a1 00 <target> 02 00 83 00 64` (charging flag, percent).
- Enter bootloader: `feat[3] = 0x01, feat[6] = 0xB0`, rest `0` (command `0x00`, mode `0xB0`; `FirmwareUpdate.exe` `C52840Dongle::SetBLDeviceMode`) -> `258a:2103`. In the stock image `0x14824` compares the mode with `0xB0`, `0x1484C` stores `0xA55AA55A` at `0x2003FFFC` and `0x71B8` resets. The bootloader commands are in mouse-firmware-re `platforms/compx-nrf52/bootloader-protocol.md`.
- Stock firmware rejects `feat[4] >= 5` before any handler runs. Open Directional DPI requests carry `seq` 5..255 in `feat[4]`, so stock firmware never runs a handler for them (§2.3).

### 2.2 Safe detection for hosts
A host must not send Open Directional DPI packets to a device that has not identified itself. The hosts here (`detectCapabilities()` in `integrations/openmouse/src/directional-dpi.ts`, `calibrate.html`, `tools/odd_profile.py`) do this:
1. **Any device:** a USB product string containing `[OpenDDPIv1]` (e.g. `"My Mouse [OpenDDPIv1]"`). Zephyr / ZMK / ZGM firmware sets it in its USB configuration (`adapters/zephyr/README.md`). Any other device without it is `"unsupported"` and gets no packet.
2. **Glorious Series One Pro IDs only** (`258a:2018`, `258a:2031`): the host sends the stock firmware-version query (§2.1); through the receiver `258a:2031` it sends the relayed query of §2.3 instead. `bcdDevice` is not a marker: the patch keeps the stock descriptors (`0x0101` cable, `0x0100` receiver). The patch answers the query unchanged and also writes `"DP01"` (`0x44, 0x50, 0x30, 0x31`) into payload bytes `16..19` and, since the 2.4 GHz relay build (`505404c`), `12..15`. No stamp: `"stock-glorious"`. Verified on a retail mouse (2026-11-13): stock v1.0.0.0 answers `a1 00 00 03 00 81 01 00 00 00 20 18` with bytes `16..19` zero; with the patch flashed the same reply carries `DP01` there, and `GET_CAPABILITIES` / `GET_PROFILE` answer with valid CRCs.
3. **`GET_CAPABILITIES`** (§4.1) then confirms with the `"DP01"` magic.

### 2.3 Through the Glorious 2.4 GHz receiver (`258a:2031`)
Verified by disassembly of both stock firmwares and on hardware (2026-11-13):
- The receiver forwards a request to the mouse only when `body[2] = 0x02`, and forwards `body[3] + 6` bytes in 8-byte radio chunks. Anything else it answers itself (see the next bullet). It overwrites `body[0]` with `0xA0` while the request is pending and `0xA4` when the mouse is unreachable; GET_REPORT returns the mouse's reply once `body[0] != 0xA0` (about 8 ms for the version query). It copies back as many reply bytes as the **request** asked for (`body[3] + 6`), not as many as the mouse sent; the rest of the 64 bytes is stale. `0xA4` can be transient: `SAVE_FLASH` erases a flash page, which stalls the mouse's radio, so the receiver shows `0xA4` after about 270 ms and the real reply still arrives (about 770 ms on a retail mouse, 2026-11-13). Hosts keep polling for a deadline (2 s) and treat only a final `0xA4` as an unreachable mouse.
- **Receiver-local commands.** They run only when `body[2] != 0x02` and `body[4] = 0x00`, with the command in `body[5]`; any other `body[4]` answers `0xA3` with no handler. `0x81` version and `0x89` link state (Verified), `0x8A` RF ID read (disassembly). Two are dangerous (disassembly): `0x00` sets the receiver's mode (`body[6] = 0xB0` stores `0xA55AA55A` at `0x20007FFC` and reboots it into its bootloader `258a:2113`), and `0x0A` rewrites the stored RF ID, which unpairs the mouse. Hosts must not send `258a:2031` a request with `body[2] != 0x02`, `body[4] = 0` and `body[5]` = `0x00` or `0x0A`; this includes the cable's bootloader-entry packet (§2.1), which the receiver does not relay. Unknown commands answer `0xA3` and an echo. Open Directional DPI requests carry `seq >= 5` in `body[4]`, which also keeps them away from these handlers. Notes: mouse-firmware-re `devices/glorious-series-one-pro/receiver.md`; scripts: `devices/glorious-series-one-pro/re-scripts/`.
- **Relay envelope.** Hosts send requests to the receiver with `body[2] = 0x02` and `body[3] = 0x3A` (exactly 64 bytes forwarded). Both are transport bytes: the CRC is computed over the canonical packet (`body[0] = 'D'`, `body[2] = 0x01`, `body[3] = 0x00`), and the patch restores those before checking it. Replies are unchanged.
- The mouse sends `reply[3] + 6` bytes back over the radio; the patch caps that at 64 (stock `0x15D74`), because a reply keeps its status (`0xA1..0xA4`) in byte 3 and would otherwise overrun the receiver's 64-byte buffer. Hosts must therefore only use the envelope after detecting a patch build that has this cap.
- **Detection.** Only the first 16 bytes of the stock version reply travel over the radio, so the patch also stamps `"DP01"` at bytes `12..15`. A host asks the receiver with the version query, target `body[2] = 0x02` and `body[3] = 0x0A` (16 bytes copied back; with the stock `0x06` only 12 return and the stamp is cut off); a stamp at `12..15` means a patched mouse that understands the envelope. Builds without it are never sent an envelope request.
- **Sequence numbers.** Hosts use `seq` 5..255 on every route: stock Glorious firmware rejects `body[4] >= 5` (its command-group byte) before running any handler, so an Open Directional DPI request can never trigger a stock command.

---

## 3. Packet Framing (`64 Bytes`)

| Payload offset (`0..63`) | HID buffer offset (`1..64`) | Field | Type | Description |
| :---: | :---: | :--- | :--- | :--- |
| `0..1` | `buf[1..2]` | `magic` | `uint8[2]` | `'D', 'P'` (`0x44, 0x50`) |
| `2` | `buf[3]` | `proto_ver` | `uint8` | `0x01` |
| `3` | `buf[4]` | `status` | `uint8` | Request: `0x00`. Response: `0xA1` OK, `0xA2` CRC/format error or save failed, `0xA3` unsupported, `0xA4` range error |
| `4` | `buf[5]` | `seq` | `uint8` | Sequence number, echoed in the response |
| `5` | `buf[6]` | `namespace` | `uint8` | Always `0xDF` |
| `6` | `buf[7]` | `opcode` | `uint8` | Command (§4), echoed |
| `7` | `buf[8]` | `slot` | `uint8` | Echoed but ignored: the reference handler holds one profile (`max_slots = 1`) |
| `8..61` | `buf[9..62]` | `payload` | `uint8[54]` | Command-specific |
| `62..63` | `buf[63..64]` | `pkt_crc16` | `uint16_le` | CRC-16-CCITT (poly `0x1021`, init `0xFFFF`) over bytes `0..61` |

- A packet is handled only if bytes `0..1` are `'D','P'` and byte `5` is `0xDF`; otherwise the handler returns `false` and writes nothing.
- If `proto_ver != 0x01` or the CRC does not match, the response has status `0xA2` and an empty payload.
- Every response carries `'D','P'`, `proto_ver = 0x01`, the echoed `seq`/`opcode`/`slot`, namespace `0xDF`, and its own CRC. Unused payload bytes are `0`.
- A device may answer after its SET_REPORT handler returns (the Glorious patch answers from its main loop, over 2.4 GHz via the receiver), and until then GET_REPORT returns its previous answer. Hosts take only the answer whose `seq` and `opcode` match the request and poll GET_REPORT for it (the client in `integrations/openmouse`, `calibrate.html` and `tools/odd_profile.py`: up to 2 s, §2.3). `ENTER_BOOTLOADER` normally gets no answer.

---

## 4. Commands

Unless stated otherwise, commands act on the live engine in RAM, and an unknown opcode answers `0xA3`.

| Opcode | Name | Request `payload` | Response `payload` / behaviour |
| :---: | :--- | :--- | :--- |
| `0x01` | `GET_CAPABILITIES` | — | See §4.1. |
| `0x02` | `GET_PROFILE` | — | `[0..27]`: active 28-byte profile (`spec/directional-dpi-v1.md` §7). |
| `0x03` | `SET_PROFILE` | `[0..27]`: profile | Rejected with `0xA2` (empty payload) unless magic, version, CRC, `base_dpi >= 50` and gains `0x0010..0x0400` are valid. Otherwise loaded (window byte clamped to 128, CRC recomputed) and echoed in `[0..27]`. Loading an identity profile clears remainders and direction state. |
| `0x04` | `SAVE_FLASH` | — | Calls `on_save_flash` with the active profile. `0xA3` without a callback, `0xA2` if it returns false. `[0..27]`: active profile in all cases. Hosts save only on an explicit user action, never on every edit (on the Glorious every save that changes the profile is a flash page erase). |
| `0x05` | `RESET_DEFAULTS` | — | Neutral profile (disabled, all `1.00x`, `reserved = 0`) that **keeps the current `base_dpi`**; clears remainders and direction state; echoed in `[0..27]`. RAM only until `SAVE_FLASH`. |
| `0x06` | `SET_ENABLED` | `[0]`: mode | `0`: clear `ENABLED` and `BYPASS_FOR_CALIBRATION`, clear remainders. `2`: set `BYPASS_FOR_CALIBRATION` (exact 1.00x passthrough while calibrating; `ENABLED` unchanged), clear remainders. Any other value: set `ENABLED`, clear the bypass. `[0]`: resulting `flags`. |
| `0x07` | `SIMULATE_DELTA` | `[0..1]` dx, `[2..3]` dy (`int16_le`) | Runs `ddpi_process_delta` on the **live** engine (it updates remainders and direction state; no idle reset). `[0..1]` out_dx, `[2..3]` out_dy (`int16_le`), `[4..7]` rem_x, `[8..11]` rem_y (`int32_le`, Q16.16), `[12]` last octant, `[13..16]` last scale (`uint32_le`, Q16.16). The 2×2 model does not update the octant. Real sensor motion between requests goes through the same engine, so keep the device still (sensor lifted) when comparing results against the conformance vectors; on a retail Glorious Series One Pro with the sensor idle, `RESET_DEFAULTS` + `SET_PROFILE` + a `SIMULATE_DELTA` sequence matched the C reference bit for bit (2026-11-13). |
| `0x0F` | `ENTER_BOOTLOADER` | `[0..3]`: `0x424C5253` (`uint32_le`, bytes `53 52 4C 42`) | Wrong magic: `0xA4`. No callback: `0xA3`. Otherwise calls `on_enter_bootloader` (normally does not return). |

### 4.1 `GET_CAPABILITIES` response payload

| Offset | Field | Value |
| :---: | :--- | :--- |
| `0..3` | magic | `"DP01"` (`0x44, 0x50, 0x30, 0x31`) |
| `4` | `engine_version` | `0x01` |
| `5` | `max_slots` | `1` |
| `6` | `active_slot` | `0` |
| `7` | capability flags | bit1 `nvs_storage` (save callback present), bit3 `bootloader_reentry` (bootloader callback present), bit4 `travel_window` (always), bit5 `linear_2x2` (always), bit6 `sensor_dpi` (the adapter reports the current sensor DPI, so profile flag bit 7 `ONLY_AT_BASE_DPI` works), bit7 `clock` (bytes `20..23` are valid). Bits 0 (`wired_1000hz`) and 2 (`paw3370_sensor`) are legacy and never set by the reference handler. |
| `8..9` | `min_dpi` | `50` |
| `10..11` | `max_dpi` | `65535` |
| `12..13` | `min_mult_q8_8` | `0x0010` |
| `14..15` | `max_mult_q8_8` | `0x0400` |
| `16` | `window_default` | `16` (recommended travel window; the neutral default profile itself has `L = 0`) |
| `17` | `window_max` | `128` |
| `18..19` | `sensor_dpi` | Current sensor DPI as reported by the adapter (`uint16_le`), `0` = unknown |
| `20..23` | `clock_ms` | The adapter's millisecond clock, the one it passes to `ddpi_process_motion` (`uint32_le`), valid when flag bit 7 is set. Read it twice to check the clock rate against wall time. |

---

## 5. Per-Route Behaviour

- **Glorious stock patch**: flags `0xFA` (save, bootloader, travel window, 2×2, sensor DPI, clock). `SAVE_FLASH` writes the profile to flash page `0x0007E000`, which is loaded at boot (otherwise the neutral 800-CPI default). An unchanged profile is not written again (no erase; added after the `505404c` build, checked in Unicorn only). Through the receiver the answer takes about 770 ms (§2.3). `ENTER_BOOTLOADER` writes `0xA55AA55A` to `0x2003FFFC` and resets into the Compx bootloader (`258a:2103`; not yet tried on hardware); holding LMB + RMB + DPI at power-up should do the same (emulated by `build_and_verify_patch.py` test 1; untested on hardware). It resets the direction estimator after the profile's idle gap (default 50 ms). The clock is the count of stock sensor-read calls, one per 1 ms TIMER1 tick while the mouse is still (inferred from the stock disassembly and checked in Unicorn, 2026-11-13; not yet verified on hardware)); capabilities bytes `20..23` report it, so its rate can be checked against wall time. The build flashed on 2026-11-13 (`505404c`) has no idle reset. It reports the active DPI (`sensor_dpi`, capabilities bytes `18..19`) from the stock firmware's own variable at `0x20003068`, so `ONLY_AT_BASE_DPI` profiles follow the DPI button; verified on a retail mouse cycling 400/800/1600/3200 (2026-11-13). A held DPI-shift key changes the sensor without updating that variable.
- **Zephyr filter**: flags `0x30`, plus `0x02` with `CONFIG_SETTINGS`. `SAVE_FLASH` answers OK at once and writes the profile to settings key `odd/<devicetree node name>` `CONFIG_ODD_DIRECTIONAL_DPI_SAVE_DELAY_MS` (default 500 ms) later. `ENTER_BOOTLOADER` answers `0xA3` unless the board intercepts opcode `0x0F` before calling the filter.
