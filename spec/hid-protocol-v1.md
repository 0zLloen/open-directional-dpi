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

### 2.1 How stock Compx firmware (`CM2856_Mouse_USB`) parses Feature reports
From disassembly of `0x0001451C`–`0x00014AD0` in `CM2856_Mouse_USB_v1.00.00_20220810.hex` (65-byte buffer, `buf[0] = 0x00` Report ID, `buf[1..64]` payload):

Two packets are verified on a retail mouse (2026-11-13), in payload indices (`feat[i] = buf[i+1]`): the firmware-version query `feat[3] = 0x06, feat[4] = 0x00, feat[5] = 0x81`, and the official updater's enter-bootloader packet `feat[3] = 0x01, feat[6] = 0xB0` (rest `0`, from `FirmwareUpdate.exe` `C52840Dongle::SetBLDeviceMode`). The dispatcher reading below is from disassembly and has not been re-checked against them.
1. Stock firmware checks `buf[7] == 0xB0` (bootloader/version subcommands `0x80`, `0x81`, `0x04`).
2. Otherwise it checks `buf[1]` (`0x00` = wired mouse target) and switches on **`buf[6]`**:
   - `0x01`: Read FW Version (`buf[7..8] = 0x81, 0x00` -> returns `[0x01, 0x00, 0x00, 0x00]` = `v1.0.0.0`)
   - `0x02`: Read Battery / Charging Status
   - `0x03`: Enter Bootloader (`*(uint32_t *)0x2003FFFC = 0xA55AA55A` + reset)
   - `0x04`: Set Profile Config (`page 0x8B` / `0x8C`)
   - `0x05`: Set System Config (`page 0x88`)
   - `0x07..0x09`: Write/Erase Macro Pages (`0x90..0xDF`)
   - `0x11`: Sensor Lift-Off Calibration
   - **`default` (any other `buf[6]`)**: answers `0xA3` (`Result_UnkownCommand`) with **no flash write or state change**. The Open Directional DPI namespace byte `0xDF` lands in `buf[6]`, so by this reading stock firmware rejects every Open Directional DPI packet this way.

Not re-verified: `adapters/glorious-cm2856/stock_ddpi_patch.c` and OpenMouse use the version query at payload bytes `[3] = 0x06, [4] = 0x00, [5] = 0x81` (`buf[4..6]`), which does not agree with the opcode position above. `build_and_verify_patch.py` test 3 runs the real stock handler on that layout and expects the version answer, but it needs the user-supplied stock image and was not re-run. If the offsets above are the right ones instead, the patch never stamps the answer and OpenMouse reports a patched mouse as stock (safe, but not configurable).

### 2.2 Safe detection for hosts
A host must not send Open Directional DPI packets to a device that has not identified itself. OpenMouse (`detectCapabilities()` in `integrations/openmouse/src/directional-dpi.ts`):
1. **Any device:** a USB product string containing `[OpenDDPIv1]` (e.g. `"My Mouse [OpenDDPIv1]"`). WebHID exposes no `bcdDevice`, so in a browser this is the only marker; Zephyr / ZMK / ZGM firmware sets it in its USB configuration (`adapters/zephyr/README.md`). Any other device without it is `"unsupported"` and gets no packet.
2. **Glorious Series One Pro IDs only** (`258a:2018`, `258a:2031`): `bcdDevice >= 0x0201` also counts (stock reports `0x0101` wired / `0x0100` receiver). Otherwise the host sends the stock firmware-version query (§2.1, patch layout). The patch answers it unchanged and also writes `"DP01"` (`0x44, 0x50, 0x30, 0x31`) into payload bytes `16..19`, which stock firmware leaves `0`. No stamp: `"stock-glorious"`. Verified on a retail mouse (2026-11-13): stock v1.0.0.0 answers `a1 00 00 03 00 81 01 00 00 00 20 18` with bytes `16..19` zero; with the patch flashed the same reply carries `DP01` there, and `GET_CAPABILITIES` / `GET_PROFILE` answer with valid CRCs.
3. **`GET_CAPABILITIES`** (§4.1) then confirms with the `"DP01"` magic.

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
- A device may answer after its SET_REPORT handler returns (the Glorious patch answers from its main loop, over 2.4 GHz via the receiver), and until then GET_REPORT returns its previous answer. Hosts take only the answer whose `seq` and `opcode` match the request and poll GET_REPORT for it (OpenMouse: up to ~300 ms). `ENTER_BOOTLOADER` normally gets no answer.

---

## 4. Commands

Unless stated otherwise, commands act on the live engine in RAM, and an unknown opcode answers `0xA3`.

| Opcode | Name | Request `payload` | Response `payload` / behaviour |
| :---: | :--- | :--- | :--- |
| `0x01` | `GET_CAPABILITIES` | — | See §4.1. |
| `0x02` | `GET_PROFILE` | — | `[0..27]`: active 28-byte profile (`spec/directional-dpi-v1.md` §7). |
| `0x03` | `SET_PROFILE` | `[0..27]`: profile | Rejected with `0xA2` (empty payload) unless magic, version, CRC, `base_dpi >= 50` and gains `0x0010..0x0400` are valid. Otherwise loaded (window byte clamped to 128, CRC recomputed) and echoed in `[0..27]`. Loading an identity profile clears remainders and direction state. |
| `0x04` | `SAVE_FLASH` | — | Calls `on_save_flash` with the active profile. `0xA3` without a callback, `0xA2` if it returns false. `[0..27]`: active profile in all cases. |
| `0x05` | `RESET_DEFAULTS` | — | Neutral profile (disabled, all `1.00x`, `reserved = 0`) that **keeps the current `base_dpi`**; clears remainders and direction state; echoed in `[0..27]`. RAM only until `SAVE_FLASH`. |
| `0x06` | `SET_ENABLED` | `[0]`: mode | `0`: clear `ENABLED` and `BYPASS_FOR_CALIBRATION`, clear remainders. `2`: set `BYPASS_FOR_CALIBRATION` (exact 1.00x passthrough while calibrating; `ENABLED` unchanged), clear remainders. Any other value: set `ENABLED`, clear the bypass. `[0]`: resulting `flags`. |
| `0x07` | `SIMULATE_DELTA` | `[0..1]` dx, `[2..3]` dy (`int16_le`) | Runs `ddpi_process_delta` on the **live** engine (it updates remainders and direction state; no idle reset). `[0..1]` out_dx, `[2..3]` out_dy (`int16_le`), `[4..7]` rem_x, `[8..11]` rem_y (`int32_le`, Q16.16), `[12]` last octant, `[13..16]` last scale (`uint32_le`, Q16.16). The 2×2 model does not update the octant. |
| `0x0F` | `ENTER_BOOTLOADER` | `[0..3]`: `0x424C5253` (`uint32_le`, bytes `53 52 4C 42`) | Wrong magic: `0xA4`. No callback: `0xA3`. Otherwise calls `on_enter_bootloader` (normally does not return). |

### 4.1 `GET_CAPABILITIES` response payload

| Offset | Field | Value |
| :---: | :--- | :--- |
| `0..3` | magic | `"DP01"` (`0x44, 0x50, 0x30, 0x31`) |
| `4` | `engine_version` | `0x01` |
| `5` | `max_slots` | `1` |
| `6` | `active_slot` | `0` |
| `7` | capability flags | bit1 `nvs_storage` (save callback present), bit3 `bootloader_reentry` (bootloader callback present), bit4 `travel_window` (always), bit5 `linear_2x2` (always). Bits 0 (`wired_1000hz`) and 2 (`paw3370_sensor`) are legacy and never set by the reference handler. |
| `8..9` | `min_dpi` | `50` |
| `10..11` | `max_dpi` | `65535` |
| `12..13` | `min_mult_q8_8` | `0x0010` |
| `14..15` | `max_mult_q8_8` | `0x0400` |
| `16` | `window_default` | `16` (recommended travel window; the neutral default profile itself has `L = 0`) |
| `17` | `window_max` | `128` |

---

## 5. Per-Route Behaviour

- **Glorious stock patch**: flags `0x3A` (save, bootloader, travel window, 2×2). `SAVE_FLASH` writes the profile to flash page `0x0007E000`, which is loaded at boot (otherwise the neutral 800-CPI default). `ENTER_BOOTLOADER` writes `0xA55AA55A` to `0x2003FFFC` and resets into the Compx bootloader (`258a:2103`); holding LMB + RMB + DPI at power-up does the same. No idle reset of the direction estimator (no verified stock millisecond tick).
- **Zephyr filter**: flags `0x30`, plus `0x02` with `CONFIG_SETTINGS`. `SAVE_FLASH` answers OK at once and writes the profile to settings key `odd/<devicetree node name>` `CONFIG_ODD_DIRECTIONAL_DPI_SAVE_DELAY_MS` (default 500 ms) later. `ENTER_BOOTLOADER` answers `0xA3` unless the board intercepts opcode `0x0F` before calling the filter.
