# Open Directional DPI — USB HID Configuration Protocol v1 (`hid-protocol-v1`)

## 1. Transport Layer

Open Directional DPI v1 reuses the standard **Interface 2 Vendor Feature Report** already present on the Glorious Series One Pro (`258a:2018` wired / `258a:2031` receiver) and supported by WebHID in Chromium/OpenMouse:

- **USB Interface**: Interface 2 (`bInterfaceClass = 0x03` HID)
- **HID Usage Page**: `0xFFFF` (Vendor-Defined)
- **HID Usage**: `0x0000`
- **Report Type**: **Feature Report** (`HID_REPORT_TYPE_FEATURE`)
- **Report ID**: `0x00` (unnumbered descriptor `06 ff ff 09 00 a1 01 09 00 15 00 25 01 75 08 95 40 b1 02 c0`)
- **Payload Length**: **64 bytes** (`b0..b63`; passed as 65 bytes `[0x00, b0..b63]` in HIDAPI / `hidraw` / Windows HID, or `sendFeatureReport(0x00, Uint8Array(64))` in WebHID).

---

## 2. Stock vs. Custom Firmware Coexistence & Safe Detection

### 2.1 How Stock Compx Firmware (`CM2856_Mouse_USB`) Parses Feature Reports
Disassembly of `0x0001451C`–`0x00014AD0` in `CM2856_Mouse_USB_v1.00.00_20220810.hex` reveals how stock firmware processes the 65-byte Feature buffer (`buf[0] = 0x00` Report ID, `buf[1..64]` payload):
1. Stock firmware checks `buf[7] == 0xB0` (bootloader/version subcommands `0x80`, `0x81`, `0x04`).
2. Otherwise, stock firmware checks `buf[1]` (`0x00` = wired mouse target) and switches on **`buf[6]`**:
   - `0x01`: Read FW Version (`buf[7..8] = 0x81, 0x00` -> returns `[0x01, 0x00, 0x00, 0x00]` = `v1.0.0.0` at `resp[9..12]`)
   - `0x02`: Read Battery / Charging Status
   - `0x03`: Enter Bootloader (`*(uint32_t *)0x2003FFFC = 0xA55AA55A` + reset)
   - `0x04`: Set Profile Config (`page 0x8B` / `0x8C`)
   - `0x05`: Set System Config (`page 0x88`)
   - `0x07..0x09`: Write/Erase Macro Pages (`0x90..0xDF`)
   - `0x11`: Sensor Lift-Off Calibration
   - **`default` (any other `buf[6]`)**: Stock firmware sets `resp[1] = 0xA3` (`Result_UnkownCommand`) and performs **no flash write or state change**.

### 2.2 Passive & Safe Detection Sequence for OpenMouse
To ensure OpenMouse **never** sends experimental vendor commands to stock firmware:
1. **Passive USB Descriptor Check (Zero HID Traffic)**:
   - Custom ZMK / Open Directional DPI firmware sets:
     - `bcdDevice = 0x0201` (`2.01`, compared to stock `0x0101` wired / `0x0100` receiver), and/or
     - Appends `" [OpenDDPIv1]"` to the USB `iProduct` string (`"Series One PRO [OpenDDPIv1]"`).
   - In WebHID (`device.productName`) or Linux (`sysfs`), OpenMouse immediately identifies whether the connected mouse is running stock firmware or Open Directional DPI custom firmware **before sending a single Feature report**!
2. **Standard Version Query (`buf[6] == 0x01`)**:
   - Even if queried via the standard Glorious version command (`buf[6] = 0x01, buf[7] = 0x81`), custom firmware returns `[0x01, 0x00, 0x00, 0x00]` in `resp[9..12]` (so legacy software remains happy) **and** places the Open Directional DPI capability magic `0x44, 0x50, 0x30, 0x31` (`"DP01"`) in `resp[16..19]` (which stock firmware always leaves `0x00, 0x00, 0x00, 0x00`).

---

## 3. Open Directional DPI v1 Packet Framing (`64 Bytes`)

All Open Directional DPI v1 commands use magic prefix `'D', 'P'` (`0x44, 0x50`) in payload bytes `0..1` (`buf[1..2]` when including the leading `0x00` Report ID) and command namespace `0xDF` in payload byte `5` (`buf[6]`):

| Payload Offset (`0..63`) | HID Buffer Offset (`1..64`) | Field Name | Type | Description |
| :---: | :---: | :--- | :--- | :--- |
| `0..1` | `buf[1..2]` | `magic` | `uint8[2]` | `'D', 'P'` (`0x44, 0x50`) — Open Directional DPI framing magic |
| `2` | `buf[3]` | `proto_ver` | `uint8` | `0x01` (Protocol Version 1) |
| `3` | `buf[4]` | `status` | `uint8` | Request: `0x00`. Response: `0xA1` = OK, `0xA2` = Error/CRC Fail, `0xA3` = Unsupported, `0xA4` = Range Error |
| `4` | `buf[5]` | `seq` | `uint8` | Sequence number echoed by firmware in response |
| `5` | `buf[6]` | `namespace` | `uint8` | Always `0xDF` (Open Directional DPI command family) |
| `6` | `buf[7]` | `opcode` | `uint8` | Command Opcode (`ddpi_hid_opcode_t`, see Section 4) |
| `7` | `buf[8]` | `slot` | `uint8` | Profile slot index (`0..3`, default `0`) |
| `8..61` | `buf[9..62]` | `payload` | `uint8[54]` | Command-specific payload (e.g., 28-byte `ddpi_profile_v1_t` at `payload[0..27]`) |
| `62..63` | `buf[63..64]` | `pkt_crc16` | `uint16_le` | CRC-16-CCITT (`poly 0x1021, init 0xFFFF`) over payload bytes `0..61` |

---

## 4. Command Opcodes (`opcode` at Payload Byte 6)

| Opcode | Symbolic Name | Direction | Description & Payload Layout (`payload[0..53]`) |
| :---: | :--- | :--- | :--- |
| `0x01` | `DDPI_CMD_GET_CAPABILITIES` | Host -> Dev | Queries protocol version, firmware build type, max profile slots, min/max DPI, and supported flags.<br>**Response `payload`**:<br>`[0..3]`: Magic `"DP01"` (`0x44, 0x50, 0x30, 0x31`)<br>`[4]`: `engine_version` (`0x01`)<br>`[5]`: `max_slots` (`4`)<br>`[6]`: `active_slot` (`0..3`)<br>`[7]`: `hw_Capabilities` (`bit0=wired_1000hz`, `bit1=nvs_storage`, `bit2=paw3370_sensor`, `bit3=bootloader_reentry`)<br>`[8..9]`: `min_dpi` (`50`)<br>`[10..11]`: `max_dpi` (`19000`)<br>`[12..13]`: `min_mult_q8_8` (`0x0010`)<br>`[14..15]`: `max_mult_q8_8` (`0x0400`) |
| `0x02` | `DDPI_CMD_GET_PROFILE` | Host -> Dev | Reads the 28-byte `ddpi_profile_v1_t` for `slot` (`0..3`).<br>**Response `payload[0..27]`**: `ddpi_profile_v1_t` (including its internal `crc16`). |
| `0x03` | `DDPI_CMD_SET_PROFILE` | Host -> Dev | Applies a 28-byte `ddpi_profile_v1_t` to RAM for `slot` immediately.<br>**Request `payload[0..27]`**: `ddpi_profile_v1_t` (validated by firmware for magic, version, range, and `crc16`).<br>**Response `payload[0..27]`**: Echoes the active `ddpi_profile_v1_t` for verified readback. |
| `0x04` | `DDPI_CMD_SAVE_FLASH` | Host -> Dev | Commits active RAM profile(s) to dedicated non-volatile flash (`0x0007E000` NVS). |
| `0x05` | `DDPI_CMD_RESET_DEFAULTS` | Host -> Dev | Resets `slot` (or all slots if `slot == 0xFF`) to neutral `1.00x` (`0x0100`) defaults and clears remainders. |
| `0x06` | `DDPI_CMD_SET_ENABLED` | Host -> Dev | Fast toggle: `payload[0] = 0x00` (bypass/neutral) or `0x01` (enabled). Returns updated `flags` in `payload[0]`. |
| `0x07` | `DDPI_CMD_SIMULATE_DELTA` | Host -> Dev | Diagnostic/Test command: passes `(dx, dy)` (`int16_le` at `payload[0..3]`) through the firmware engine and returns `(out_dx, out_dy, rem_x, rem_y, octant, eff_scale_q16_16)` in `payload[0..16]`. |
| `0x0F` | `DDPI_CMD_ENTER_BOOTLOADER` | Host -> Dev | Requires confirmation magic `0x424C5253` (`"BLRS"`, little-endian) in `payload[0..3]`. Writes `0xA55AA55A` to `*(volatile uint32_t *)0x2003FFFC` and calls `NVIC_SystemReset()`, returning the mouse to `258a:2103` Compx Bootloader mode. |
