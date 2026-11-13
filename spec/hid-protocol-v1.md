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
- **QMK**: no Feature report. The same 64-byte packets travel over QMK's raw HID interface in 32-byte frames (§6). Without `RAW_ENABLE` the profile is set in `keymap.c`.
- The **Linux evdev filter** does not implement this protocol; its profile is set on the command line.

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
1. **Any device:** a USB product string containing `[OpenDDPIv1]` (e.g. `"My Mouse [OpenDDPIv1]"`). Zephyr / ZMK / ZGM firmware sets it in its USB configuration (`adapters/zephyr/README.md`). Any other device without it is `"unsupported"` and gets no packet. A QMK raw HID interface is identified by the probe of §6.3 instead.
2. **Glorious Series One Pro IDs only** (`258a:2018`, `258a:2031`): the host sends the stock firmware-version query (§2.1); through the receiver `258a:2031` it sends the relayed query of §2.3 instead. `bcdDevice` is not a marker: the patch keeps the stock descriptors (`0x0101` cable, `0x0100` receiver). The patch answers the query unchanged and also writes `"DP01"` (`0x44, 0x50, 0x30, 0x31`) into payload bytes `16..19` and, since the 2.4 GHz relay build (`505404c`), `12..15`. No stamp: `"stock-glorious"`. Verified on a retail mouse (2026-11-13): stock v1.0.0.0 answers `a1 00 00 03 00 81 01 00 00 00 20 18` with bytes `16..19` zero; with the patch flashed the same reply carries `DP01` there, and `GET_CAPABILITIES` / `GET_PROFILE` answer with valid CRCs.
3. **`GET_CAPABILITIES`** (§4.1) then confirms with the `"DP01"` magic.

### 2.3 Through the Glorious 2.4 GHz receiver (`258a:2031`)
Verified by disassembly of both stock firmwares and on hardware (2026-11-13):
- The receiver forwards a request to the mouse only when `body[2] = 0x02`, and forwards `body[3] + 6` bytes in 8-byte radio chunks. Anything else it answers itself (see the next bullet). It overwrites `body[0]` with `0xA0` while the request is pending and `0xA4` when the mouse is unreachable; GET_REPORT returns the mouse's reply once `body[0] != 0xA0` (about 8 ms for the version query). It copies back as many reply bytes as the **request** asked for (`body[3] + 6`), not as many as the mouse sent; the rest of the 64 bytes is stale. `0xA4` can be transient: `SAVE_FLASH` erases a flash page, which stalls the mouse's radio, so the receiver shows `0xA4` after about 270 ms and the real reply still arrives (about 770 ms on a retail mouse, 2026-11-13). Hosts keep polling for a deadline (2 s) and treat only a final `0xA4` as an unreachable mouse (then they retry once, see *Link state and retries*).
- **Receiver-local commands.** They run only when `body[2] != 0x02` and `body[4] = 0x00`, with the command in `body[5]`; any other `body[4]` answers `0xA3` with no handler. `0x81` version and `0x89` link state (Verified), `0x8A` RF ID read (disassembly). Two are dangerous (disassembly): `0x00` sets the receiver's mode (`body[6] = 0xB0` stores `0xA55AA55A` at `0x20007FFC` and reboots it into its bootloader `258a:2113`), and `0x0A` rewrites the stored RF ID, which unpairs the mouse. Hosts must not send `258a:2031` a request with `body[2] != 0x02`, `body[4] = 0` and `body[5]` = `0x00` or `0x0A`; this includes the cable's bootloader-entry packet (§2.1), which the receiver does not relay. Unknown commands answer `0xA3` and an echo. Open Directional DPI requests carry `seq >= 5` in `body[4]`, which also keeps them away from these handlers. Notes: mouse-firmware-re `devices/glorious-series-one-pro/receiver.md`; scripts: `devices/glorious-series-one-pro/re-scripts/`.
- **Relay envelope.** Hosts send requests to the receiver with `body[2] = 0x02` and `body[3] = 0x3A` (exactly 64 bytes forwarded). Both are transport bytes: the CRC is computed over the canonical packet (`body[0] = 'D'`, `body[2] = 0x01`, `body[3] = 0x00`), and the patch restores those before checking it. Replies are unchanged.
- The mouse sends `reply[3] + 6` bytes back over the radio; the patch caps that at 64 (stock `0x15D74`), because a reply keeps its status (`0xA1..0xA4`) in byte 3 and would otherwise overrun the receiver's 64-byte buffer. Hosts must therefore only use the envelope after detecting a patch build that has this cap.
- **Detection.** Only the first 16 bytes of the stock version reply travel over the radio, so the patch also stamps `"DP01"` at bytes `12..15`. A host asks the receiver with the version query, target `body[2] = 0x02` and `body[3] = 0x0A` (16 bytes copied back; with the stock `0x06` only 12 return and the stamp is cut off); a stamp at `12..15` means a patched mouse that understands the envelope. Builds without it are never sent an envelope request.
- **Sequence numbers.** Hosts use `seq` 5..255 on every route: stock Glorious firmware rejects `body[4] >= 5` (its command-group byte) before running any handler, so an Open Directional DPI request can never trigger a stock command.
- **Link state and retries.** Hosts check the link before every relayed request: the version query of §2.2 and every envelope request. The check is the receiver-local link-state query, 64 bytes `00 00 00 00 00 89` and the rest `0` (`body[2] = 0x00`, `body[4] = 0x00`, `body[5] = 0x89`). The host polls GET_REPORT until `body[0] = 0xA1` and `body[5] = 0x89`. Then `body[6] = 0x01` means linked, and any other value means no link. With no such answer within 2 s the link state is unknown, and the host sends the request anyway.
  - No link: the host tells the user to move or click the mouse, and repeats the query every 100 ms. With still no link after 15 s it does not send the request and reports that the receiver cannot reach the mouse.
  - A request that ends in a final `0xA4` (still `0xA4` at the 2 s deadline) is sent once more, with a new `seq`, after the same link check. `SIMULATE_DELTA` is not sent again: it changes the live engine, so the effect of a lost request is unknown. `ENTER_BOOTLOADER` is never relayed (cable only). A second final `0xA4` is reported as an unreachable mouse. The host link wait and retry are checked against fakes only; not yet run on hardware (2026-11-13).
  - So a session through the receiver alternates: link query, request, link query, request. The hosts here (`integrations/openmouse`, `calibrate.html`, `tools/odd_profile.py`) send the same bytes in the same order.
  - Why: the receiver answers `0xA4` at once when its link flag (`0x20000056`, the byte `0x89` returns) is `0`. Otherwise it answers `0xA4` only after about 256 ms without a packet from the mouse. It neither retries a request nor keeps one across a link loss. (Inferred: receiver disassembly `@ 0x0000C9C8`, `0x0000C7E6`, `0x0000DA48`, and Unicorn emulation, 2026-11-13. `0x89` answering `01` with the mouse on is Verified; `00` without a link is Inferred.) On a retail mouse, relayed requests ended in `0xA4` while the mouse was still or only scrolling, and went through while it moved (Verified, 2026-11-13). The cause is Unknown: in emulation an awake stock mouse sends a keep-alive every 1 ms while still, and the link stays up. A sleeping mouse wakes only on a button, the wheel or motion, never on a host request (Inferred: mouse disassembly). This needs no firmware change: `0x89` is the stock receiver's own command, so it works with every relay build (`505404c` or later).

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

- **Glorious stock patch**: flags `0xFA` (save, bootloader, travel window, 2×2, sensor DPI, clock). `SAVE_FLASH` writes the profile to flash page `0x0007E000`, which is loaded at boot (otherwise the neutral 800-CPI default). An unchanged profile is not written again (no erase; added after the `505404c` build). Through the receiver a save that erases answers late: about 770 ms in an earlier test (§2.3). Verified on `21ea252` through the receiver (2026-11-13): a changed profile answered after 402 ms, an identical second save after 24 ms (no erase, no `0xA4`), and the saved profile survived switching the mouse off and on. `ENTER_BOOTLOADER` writes `0xA55AA55A` to `0x2003FFFC` and resets into the Compx bootloader (`258a:2103`); holding LMB + RMB + DPI (P1.15, P1.13, P1.00, low when pressed) at power-up does the same (emulated by `build_and_verify_patch.py` test 1). Both verified on the cable (2026-11-13, `21ea252`): `ENTER_BOOTLOADER` gave `258a:2103` after 1.0 s, and without the magic the patch answers `0xA4` and stays in the application. It resets the direction estimator after the profile's idle gap (default 50 ms). The clock is the count of stock sensor-read calls, one per 1 ms TIMER1 tick while the mouse is still (from the stock disassembly; the reset is checked in Unicorn); capabilities bytes `20..23` report it, so its rate can be checked against wall time. Verified on the cable (2026-11-13, `21ea252`): 1000.0 ticks/s with the mouse still, read once a second for 12 s. Over 2.4 GHz the rate was not measured: relayed requests failed while the mouse was still (§2.3). Inferred to be the same: `TIMER1` runs in every awake radio state (linked, retrying, searching) and stops only on the way into System OFF (stock disassembly and Unicorn emulation, 2026-11-13). `505404c` has no idle reset. `sensor_dpi` (capabilities bytes `18..19`): up to main `56afbb4` the patch reads the stock active-DPI variable at `0x20003068`, so `ONLY_AT_BASE_DPI` profiles follow the DPI button; verified on a retail mouse cycling 400/800/1600/3200 (2026-11-13). That variable misses a held DPI-shift ("sniper") key, and stock DPI commands aimed at an inactive onboard profile change it without programming the sensor. Builds after `56afbb4` instead record the DPI inside the stock sensor DPI writer (`0x17860`, hooked at `0x17864`), which every DPI path calls: DPI button, DPI shift press and release, DPI-adjust wheel, host DPI commands, profile switch, sensor init and its periodic re-init. So `sensor_dpi` is the DPI last written to the sensor, and an `ONLY_AT_BASE_DPI` curve is off while DPI shift is held. Inferred: Unicorn emulation of the stock image (`build_and_verify_patch.py` test 11); not yet run on hardware. Known limit (Inferred): the stock DPI-adjust wheel can pass DPI `0`, which the sensor runs as 12,800 and the patch reports as `0` (unknown). The patch keeps one Open Directional DPI profile for all three stock onboard profiles; a stock profile switch changes the DPI, which `sensor_dpi` follows (Inferred: emulation).
- **QMK raw HID** (§6): flags `0xF0` (travel window, 2×2, sensor DPI from `pointing_device_get_cpi()`, clock from `timer_read32()`, both as the pointing device task last saw them), plus `0x02` with `EECONFIG_USER_DATA_SIZE >= 28`. `SAVE_FLASH` writes the user datablock (EEPROM) at once. `ENTER_BOOTLOADER` answers `0xA3`. Not yet run on a device.
- **Zephyr filter**: flags `0x30`, plus `0x02` with `CONFIG_SETTINGS`. `SAVE_FLASH` answers OK at once and writes the profile to settings key `odd/<devicetree node name>` `CONFIG_ODD_DIRECTIONAL_DPI_SAVE_DELAY_MS` (default 500 ms) later. `ENTER_BOOTLOADER` answers `0xA3` unless the board intercepts opcode `0x0F` before calling the filter.

---

## 6. QMK Raw HID Transport

QMK has no vendor Feature report, but most QMK boards already have raw HID for VIA or Vial. This transport carries the unchanged 64-byte packet (§3) over it in 32-byte frames, so `ddpi_hid_handle_feature_report()` runs on the reassembled packet byte for byte. Inferred from the QMK 0.34.8 (`ec8a1b6`) and vial-qmk (`vial` branch, `dd43959`) sources (2026-11-13); not yet built in QMK or run on a device.

### 6.1 Interface
- QMK's raw HID interface: Usage Page `0xFF60`, Usage `0x61` (QMK's default `RAW_USAGE_PAGE` / `RAW_USAGE_ID`; a board that changes them is not found). Its report descriptor starts `06 60 ff 09 61 a1 01`. One unnumbered 32-byte Input report and one 32-byte Output report (fixed at 32 bytes; V-USB sends them over an 8-byte endpoint).
- Host side: write 33 bytes `[0x00, f0..f31]` (`hidraw` `write()`, HIDAPI `hid_write()`) or `sendReport(0x00, Uint8Array(32))` in WebHID. Replies are 32-byte Input reports (`hidraw` `read()`, `hid_read()`, WebHID `inputreport`).
- QMK passes each Output report to `raw_hid_receive(data, 32)` from its main loop (`quantum/main.c`), the loop that also runs the pointing device task, so the engine needs no lock.
- VIA and Vial read replies from the same interface. Close them while configuring.

### 6.2 Framing

| Frame offset | Field | Value |
| :---: | :--- | :--- |
| `0` | `marker` | `0xDF` (the namespace byte, §3) |
| `1` | `chunk` | `0x00`, `0x01`, `0x02`: write chunk `i` of the request. `0x80`, `0x81`, `0x82`: read chunk `i` of the response |
| `2..31` | `data` | Chunk `i` holds packet bytes `30*i .. 30*i+29`. Chunk 2 holds bytes `60..63` in frame bytes `2..5`; frame bytes `6..31` are `0` |

- One command is six frames in lock step (send a frame, take its reply, then send the next): write chunks `0x00, 0x01, 0x02`, then read chunks `0x80, 0x81, 0x82`. Read frames carry zero data. Lock step keeps at most one reply queued: QMK queues 4 raw HID reports on ChibiOS, and LUFA drops a report the host has not collected within about 10 ms.
- The device answers every frame whose byte 0 is `0xDF` with exactly one frame: the received frame, changed in place. A write frame comes back unchanged. A read frame comes back with chunk `i` of the device's last response in `data` (zeros before the first response). One reply per frame, built in place, is what Vial needs: its `via.c` sends the received buffer back after the hook, and that hook must not call `raw_hid_send()`.
- Reassembly: write chunk `0x00` starts a new request and drops any partial one. Chunk `0x01` is taken only right after `0x00`, and `0x02` only right after `0x01`. Any other order or `chunk` value drops the partial request (the frame is still answered). Chunk `0x02` completes the packet: the device runs `ddpi_hid_handle_feature_report()` on the 64 bytes and keeps the response for the read frames. There is no timer: a host that gives up mid-request starts again with chunk `0x00`.
- The reply to a frame is the next Input report with the same byte 1 and byte 0 `0xDF`, or `0xFF` (§6.3). Other Input reports belong to another program and are skipped.
- The reassembled read is the answer of §3: hosts check `'D','P'`, the CRC, `seq`, `opcode` and a status `0xA1..0xA4`. As with GET_REPORT, a host may read again until the 2 s deadline, but QMK answers before it replies to write chunk `0x02`, so the first read has the answer.

### 6.3 Identification
A raw HID interface carries no `[OpenDDPIv1]` product string and no `DP01` stamp, so hosts identify it with one probe:
1. Only an interface with Usage Page `0xFF60`, Usage `0x61` is probed.
2. The probe is `GET_CAPABILITIES` (`seq` 5..255) in the framing of §6.2. The host stops at the first reply whose byte 0 is not `0xDF`, or at the 2 s deadline: `"unsupported"`.
3. The device is identified only if the reassembled answer is a valid response to the probe (§3) with status `0xA1` and `"DP01"` at payload `0..3` (§4.1). Anything else, including frames echoed unchanged, is `"unsupported"`, and the device gets no other packet.

Why the probe is harmless (from the sources above):
- Raw HID without a handler: the weak `raw_hid_receive()` (`quantum/raw_hid.c`) ignores the frame. Nothing answers.
- VIA (QMK `quantum/via.c`): `raw_hid_receive()` calls `via_command_kb()` (weak, returns `false`) and then switches on byte 0. VIA command ids are `0x01..0x15`. Byte `0xDF` takes the `default` branch, which only sets byte 0 to `0xFF` (`id_unhandled`) and sends the frame back. A VIA board therefore sees one frame (`df 00 44 50 01 00 <seq> df 01 00`, then zeros), answers `0xFF`, and the host stops: no EEPROM write, keymap change or bootloader jump.
- Vial (vial-qmk `quantum/via.c`): ids `0x01..0x13` and the prefix `0xFE`. Byte `0xDF` takes `default`, whose weak `raw_hid_receive_kb()` sets `0xFF`, and the frame goes back as with VIA. While a Vial unlock is in progress every non-Vial frame is echoed unchanged with no handler run; the reads then reassemble to zeros, so the probe fails without effect.
- On a device with this transport, `GET_CAPABILITIES` only reads.
- Inferred, not checked: a board with its own raw HID handler could use `0xDF` as a command. None is known. Such a board receives only write chunk 0 unless it echoes `0xDF` back.

### 6.4 QMK device side
The adapter (`adapters/qmk`) provides `bool odd_qmk_raw_hid(uint8_t *data, uint8_t length)` under `#if defined(RAW_ENABLE)` (QMK defines it for `RAW_ENABLE = yes` and for `VIA_ENABLE = yes`). It returns `false` and leaves `data` alone unless `length` is 32 and byte 0 is `0xDF`; otherwise it handles the frame (§6.2), leaves the reply in `data` and returns `true`. It calls no QMK function. `adapters/qmk/odd_raw_hid.c` calls it from the hook the build's raw HID stack has:

```c
#include "raw_hid.h"
#if defined(VIAL_ENABLE) /* vial-qmk: no via_command_kb(); via.c sends data after this hook */
void raw_hid_receive_kb(uint8_t *data, uint8_t length) {
    if (!odd_qmk_raw_hid(data, length)) data[0] = 0xFF; /* id_unhandled, as the weak default */
}
#elif defined(VIA_ENABLE) /* QMK VIA: true means handled and sent */
bool via_command_kb(uint8_t *data, uint8_t length) {
    if (!odd_qmk_raw_hid(data, length)) return false;
    raw_hid_send(data, length);
    return true;
}
#else /* RAW_ENABLE only */
void raw_hid_receive(uint8_t *data, uint8_t length) {
    if (odd_qmk_raw_hid(data, length)) raw_hid_send(data, length);
}
#endif
```

- Vial is tested first because Vial builds also set `VIA_ENABLE`; vial-qmk has no `via_command_kb()` and QMK has no `raw_hid_receive_kb()`.
- A keyboard that already defines one of these hooks leaves `odd_raw_hid.c` out and calls `odd_qmk_raw_hid()` first from its own hook.
- `on_enter_bootloader` is `NULL` (`ENTER_BOOTLOADER` answers `0xA3`): QMK's VIA has no bootloader command and Vial allows one only after an unlock, so this transport must not add one. `on_save_flash` stores the 28-byte profile in bytes `0..27` of QMK's user datablock (`eeconfig_update_user_datablock()`) when `config.h` sets `EECONFIG_USER_DATA_SIZE >= 28`, and `odd_qmk_init()` loads it at boot; otherwise it is `NULL`.
