# Glorious Forge Series One Pro Wireless — Hardware & Firmware Architecture

## 1. Executive Summary

This document records the hardware and firmware architecture of the **Glorious Forge Series One Pro Wireless** gaming mouse (`FCC ID: 2AXP2-SP22`), combining passive Linux USB/HID enumeration, FCC internal teardown photographs, and static ARM Cortex-M4F Thumb-2 disassembly of the official stock firmware image (`CM2856_Mouse_USB_v1.00.00_20220810.hex`).

Every finding is classified as **Verified** (confirmed directly from hardware descriptors, official binaries, or PCB markings), **Inferred** (high-confidence deduction from SDK structure or standard Nordic reference layout), or **Unknown** (requires physical Continuity/Multimeter probing).

---

## 2. Device Identification & USB/HID Architecture

### 2.1 USB Device Identifiers

| Mode / Component | USB VID:PID | USB Revision (`bcdDevice`) | Product String | Evidence Status |
| :--- | :--- | :--- | :--- | :--- |
| **Wired Mouse (Application)** | `258a:2018` | `0x0101` (`1.01`) | `Series One PRO` | **Verified** (Linux USB + `FirmwareUpdate.exe` + `mouse_fw.bin` @ `0x00018E3C`) |
| **Wireless 2.4 GHz Receiver (Application)** | `258a:2031` | `0x0100` (`1.00`) | `Series One PRO Wireless` | **Verified** (Live Linux `lsusb` Bus 001 Dev 036 + `receiver_fw.bin` @ `0x0000D0DC`) |
| **Wired Mouse (Bootloader)** | `258a:2103` | `0x0100` | Compx USB HID Bootloader | **Verified** (`FirmwareUpdate.exe` CIL `Form1::InitDevice` & `OnTimer_ConnectDevice`) |
| **Wireless Receiver (Bootloader)** | `258a:2113` | `0x0100` | Compx USB HID Dongle Bootloader | **Verified** (`FirmwareUpdate.exe` CIL `Form1::InitDevice`) |

- **USB Vendor ID `0x258a`**: Sino Wealth / Compx Technology OEM ID used across Glorious Classic (`glorious-classic`) mice.
- **Manufacturer String**: `"Glorious"` (UTF-16LE / ASCII in `CM2856_Mouse_USB_v1.00.00_20220810.hex` at `0x00019BA0` and `CM2856_Receiver_USB_v1.00.00_20220810.hex` at `0x0000D790`).

### 2.2 USB HID Interfaces & Report Descriptors (Verified via `/sys/class/hidraw`)

Passive inspection of `/sys/class/hidraw/hidraw4..6/device/report_descriptor` on the live system confirms three USB HID interfaces:

1. **Interface 0 (`input0` / `hidraw4`) — Boot/High-Speed Mouse (`bInterfaceProtocol = 0x02`)**
   - **Raw Descriptor (94 bytes)**:
     `05010902a1010901a10005091901290515002501750195058102750195038103050109381581257f7508950181060930093116008026ff7f751095028106050c0a38021581257f750895018106090015002501750895018106c0c0`
   - **Report Structure (8 bytes, no Report ID)**:
     - Byte `0`: Buttons 1–5 (`bits 0..4`), 3-bit padding (`bits 5..7`)
     - Byte `1`: Vertical Wheel (`int8`, `-127..127`)
     - Bytes `2..3`: X Delta (`int16` little-endian, `-32768..32767`)
     - Bytes `4..5`: Y Delta (`int16` little-endian, `-32768..32767`)
     - Byte `6`: Horizontal Tilt / AC Pan (`int8`, `-127..127`)
     - Byte `7`: Vendor padding byte (`uint8`)

2. **Interface 1 (`input1` / `hidraw5`) — Consumer, System Control, 6KRO Keyboard & Vendor Notifications (144 bytes)**
   - **Raw Descriptor**:
     `050c0901a101850119002a3c021500263c02950175108100c005010980a1018502198129831500250175019503810295058101c005010906a1018503050719e029e71500250175019508810295017508810195067508150026ff00050719002aff008100c006a0ff0901a10185040901150026ff00750895088100c006ffff0901a10185050902150026ff00750895088102c0`
   - **Report IDs**:
     - `0x01`: Consumer Control (16-bit usage `0x0000..0x023C`)
     - `0x02`: System Control (Power/Sleep/Wake)
     - `0x03`: Standard 8-byte modifier + 6KRO Keyboard report (for macro/keybind playback)
     - `0x04`: Vendor Usage Page `0xFFA0` (8-byte Input report)
     - `0x05`: Vendor Usage Page `0xFFFF` (8-byte Input report for asynchronous battery/DPI notifications)

3. **Interface 2 (`input2` / `hidraw6`) — Vendor Configuration Feature Channel (20 bytes)**
   - **Raw Descriptor**:
     `06ffff0900a10109001500250175089540b102c0`
   - **Decoded Structure**:
     - Usage Page `0xFFFF` (Vendor Defined), Usage `0x00`
     - **64-byte Feature Report (`b1 02`)**, no Report ID declared in descriptor (uses Report ID `0x00`, so HIDAPI / WebHID / Windows HID pass a 65-byte buffer `[0x00, b0..b63]`).

---

## 3. Physical Hardware & PCB Teardown Verification

### 3.1 FCC Filing (`2AXP2-SP22`) & OEM Platform

| Attribute | Value | Evidence Status |
| :--- | :--- | :--- |
| **FCC ID** | `2AXP2-SP22` (`https://fccid.io/2AXP2SP22`) | **Verified** (FCC ID filing & internal photos) |
| **OEM Designer / Manufacturer** | Compx Technology (Shenzhen) | **Verified** (PCB silkscreen `CM2852-BAMF` + firmware project strings `CM2856_Mouse_USB`) |
| **Main PCB Silkscreen** | `CM2852-BAMF 20220516` (`V1.0`) | **Verified** (FCC internal photos) |
| **Side-Button Daughterboard** | `CM2852-MINI-BL 20220516` | **Verified** (FCC internal photos) |
| **Main MCU** | **Nordic nRF52840-QIAA-D0** (`N52840 QIAAD0 2144MX`, 73-pin aQFN, 1 MB Flash, 256 KB RAM) | **Verified** (FCC internal macro photo of U1 package markings + firmware memory map) |
| **Optical Sensor** | **Glorious BAMF** (`BAMF 2152`, PixArt **PAW3370** derivative, 50–19,000 DPI, 400 IPS, 50G) | **Verified** (FCC photo of 8-pin dual-inline staggered optical package + firmware register driver) |
| **MCU Clocks** | 32 MHz HFXO (`Y2`) + 32.768 kHz LFXO (`Y1`) | **Verified** (FCC internal photos + clock init in firmware) |
| **RF Matching / Antenna** | 2.4 GHz PCB trace antenna (`ANT1`) matching network on `ANT` pin | **Verified** (FCC internal photos) |
| **Battery** | 3.7 V Li-Po 300 mAh (`1.11 Wh`), 3-wire JST connector (Red `+`, Black `-`, Yellow `NTC`) | **Verified** (FCC internal photos) |
| **SDK / Toolchain** | Nordic nRF5 SDK + Keil MDK-ARM (`__main` scatter-loader at `0x00006201`) | **Verified** (Embedded debug strings `..\..\..\..\..\components\libraries\usbd\app_usbd.c`, `Source\usb_protocol.c`) |

### 3.2 Complete GPIO Pin Mapping (100% Verified from Stock Firmware Disassembly)

By disassembling the GPIO initialization routine (`0x0000C5B8`–`0x0000C648`), GPIO port table (`0x0001AC04`: `[0x50000000, 0x50000300]`), button/wheel scanner (`0x00016B30`–`0x00016CE0`, `0x00009614`–`0x00009690`), low-power wake config (`0x0000ABF8`–`0x0000AC58`), LED driver (`0x00018FA0`–`0x00018FF0`), battery monitor (`0x0000E1B0`–`0x0000E1F0`), and SPI2 sensor driver (`0x000184C8`–`0x0001855C`), every functional GPIO pin on the `CM2852-BAMF` PCB is verified:

| Peripheral / Function | nRF52840 Pin | GPIO Number | Direction / Config | Firmware Disassembly Reference | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PAW3370 SPI2 CSN** | **`P0.04`** | `4` | Output, Active Low (idle High) | `0x184EC` (`gpio_cfg`), `0x18522` (`gpio_pin_set`), `0x17540` (`gpio_pin_clear`) | **Verified** |
| **PAW3370 SPI2 SCK** | **`P0.12`** | `12` | Output (`NRF_SPI2->PSEL.SCK = 12`) | `0x184FC` (`gpio_cfg`), `0x1852A` (`str r0, [0x40023508]`) | **Verified** |
| **PAW3370 SPI2 MISO** | **`P0.11`** | `11` | Input, Pull-Up (`NRF_SPI2->PSEL.MISO = 11`) | `0x1850C` (`gpio_cfg`), `0x18530` (`str r0, [0x40023510]`) | **Verified** |
| **PAW3370 SPI2 MOSI** | **`P0.08`** | `8` | Output (`NRF_SPI2->PSEL.MOSI = 8`) | `0x1851C` (`gpio_cfg`), `0x18536` (`str r0, [0x4002350C]`) | **Verified** |
| **PAW3370 MOTION IRQ** | **`P0.06`** | `6` | Input, Active Low sense/wake | `0x0AC38` (`gpio_cfg_sense r0=6`) | **Verified** |
| **Button 0 (Left Click / LMB)** | **`P1.15`** | `47` (`0x2F`) | Input, Pull-Up, Active Low | `0x0C5BE`, `0x09618`, `0x16B3C`, `0x0ABFC` | **Verified** |
| **Button 1 (Right Click / RMB)** | **`P1.13`** | `45` (`0x2D`) | Input, Pull-Up, Active Low | `0x0C5C8`, `0x09620`, `0x16B44`, `0x0AC06` | **Verified** |
| **Button 2 (Middle Click / MMB)** | **`P1.10`** | `42` (`0x2A`) | Input, Pull-Up, Active Low | `0x0C5D2`, `0x0962A`, `0x16B4E`, `0x0AC10` | **Verified** |
| **Button 3 (Back / Side Btn 4)** | **`P0.09`** | `9` (`0x09`) | Input, Pull-Up, Active Low (NFC1 as GPIO) | `0x0C5DC`, `0x09634`, `0x16B58`, `0x0AC1A` | **Verified** |
| **Button 4 (Forward / Side Btn 5)** | **`P0.10`** | `10` (`0x0A`) | Input, Pull-Up, Active Low (NFC2 as GPIO) | `0x0C5E6`, `0x0963E`, `0x16B62`, `0x0AC24` | **Verified** |
| **Button 5 (DPI Cycle Button)** | **`P1.00`** | `32` (`0x20`) | Input, Pull-Up, Active Low | `0x0C5F0`, `0x09648`, `0x16B6C`, `0x0AC2E` | **Verified** |
| **Scroll Wheel Encoder A** | **`P0.29`** | `29` (`0x1D`) | Input, Pull-Up | `0x0C600`, `0x0AC54`, `0x16CB2` | **Verified** |
| **Scroll Wheel Encoder B** | **`P0.02`** | `2` (`0x02`) | Input, Pull-Up | `0x0C5F8`, `0x0AC3E`, `0x16CBA` | **Verified** |
| **Charger / Power Status 1** | **`P1.06`** | `38` (`0x26`) | Input, Pull-Up | `0x0C614`, `0x0E1C4` (`Source\battery.c`) | **Verified** |
| **Power / Mode Switch Input** | **`P1.04`** | `36` (`0x24`) | Input, Pull-Up | `0x0C60A` | **Verified** |
| **Peripheral / Sensor Power En 1** | **`P0.26`** | `26` (`0x1A`) | Output | `0x0C61A` | **Verified** |
| **Peripheral / LED Power En 2** | **`P0.14`** | `14` (`0x0E`) | Output | `0x0C636` | **Verified** |
| **LED / Matrix Outputs** | **`P0.13`, `P0.15`, `P0.17`, `P0.20`, `P0.22`, `P0.24`** | `13, 15, 17, 20, 22, 24` | Output (PWM / GPIO indicator & RGB LEDs) | `0x18FA6`–`0x18FE8`, `0x16B8C`–`0x16BC6` | **Verified** |

> **Important Note on `P0.09` and `P0.10` (NFC Pins)**:
> Because Side Buttons 4 and 5 are routed to `P0.09` (`NFC1`) and `P0.10` (`NFC2`), any Zephyr or ZMK board definition **must** enable `CONFIG_NFCT_PINS_AS_GPIOS=y` (in Zephyr `<4.0`) or `nfcpins-as-gpios` in the `uicr` devicetree node so `NRF_UICR->NFCPINS` is configured for GPIO operation.

---

## 4. PAW3370 / Glorious BAMF Optical Sensor Driver Details (Verified)

Disassembly of `0x0001708C`–`0x00018558` in `CM2856_Mouse_USB_v1.00.00_20220810.hex` reveals the exact hardware interface and register protocol used by the Glorious BAMF (PixArt PAW3370) sensor:

1. **SPI Bus Configuration (`0x00018528`–`0x00018552`)**:
   - Peripheral: `NRF_SPI2` (`0x40023000`)
   - Frequency: `0x40000000` (**4 Mbps**, created via `movs r0, #8; lsls r0, r0, #27` at `0x1853E` written to `0x40023524` `FREQUENCY`)
   - Mode: `CONFIG = 0x06` (`CPOL = 1` Active Low, `CPHA = 1` Trailing, MSB first = **SPI Mode 3**) written to `0x40023554`
   - Enable: `ENABLE = 0x01` written to `0x40023500`

2. **SPI Register Read / Write Timing (`0x0001752C`–`0x00017690`, `0x00018490`–`0x000184C4`)**:
   - **Single Register Read (`0x18490`)**:
     - Assert CSN (`P0.04` low), transmit `reg & 0x7F`, wait `t_SRAD = 20 us` (inside `0x1752C` at `0x17572`), read 1 byte, deassert CSN (`P0.04` high), wait `20 us` (`0x1849A`).
   - **Single Register Write (`0x184B4`)**:
     - Assert CSN (`P0.04` low), transmit `reg | 0x80` and `val`, deassert CSN (`P0.04` high), wait `180 us` (`0xB4` at `0x184BE`).
   - **Motion Burst Read (`0x1708C` -> `0x184A6` -> `0x175B8`)**:
     - Assert CSN (`P0.04` low), transmit `0x16` (`MOTION_BURST` register), wait `t_SRAD_MOTBR = 5 us` (`0x175FC`), clock out **12 bytes (`0x0C`)**, deassert CSN (`P0.04` high).
     - Burst packet layout parsed at `0x170B8`–`0x17118`:
       - `burst[0]`: `MOTION` status byte (bit 7 `0x80` = motion occurred)
       - `burst[1]`: `OBSERVATION` byte
       - `burst[2..3]`: `DELTA_X` (`int16_t` little-endian: `ldrh r0, [sp, #2]`)
       - `burst[4..5]`: `DELTA_Y` (`int16_t` little-endian: `ldrh r0, [sp, #4]`)
       - `burst[6]`: `SQUAL`
       - `burst[7]`: `RAW_DATA_SUM`
       - `burst[8..9]`: `MAX_RAW_DATA` / `MIN_RAW_DATA`
       - `burst[10..11]`: `SHUTTER_UPPER` / `SHUTTER_LOWER`

3. **DPI Resolution & Register Programming (`0x00017860`–`0x00017960`)**:
   - For **`50 <= DPI <= 10,000`**:
     - Writes `0x50` to register `0x4D` (sets 50 CPI step mode).
     - Computes `step = (DPI / 50) - 1` and writes `step` to register `0x4E` (`RESOLUTION_X`) and `0x4F` (`RESOLUTION_Y` when independent X/Y is enabled by setting bit 2 of `0x4D`).
   - For **`10,100 <= DPI <= 19,000`**:
     - Writes `0xD0` to register `0x4D` (sets 100 CPI step mode).
     - Computes `step = (DPI / 100) - 1` and writes `step` to register `0x4E` / `0x4F`.
   - **High-DPI Gain Adjustment (`0x178EC`)**:
     - Writes `0x90` to register `0x5A` when `DPI >= 5,000`, or `0x10` when `DPI < 5,000`.
   - **Angle Snapping (`0x17924`)**:
     - Writes `0x84` (enabled) or `0x04` (disabled) to register `0x56`.
   - **Lift-Off Distance (LOD, `0x17964`–`0x1799C`)**:
     - Writes `0x0C` (1 mm) or `0x0D` (2 mm) to register `0x42`, and updates threshold in register `0x2B` (`0x0A` for 1 mm, `0x18` for 2 mm).

---

## 5. Survey of Existing Open-Source Research (Phase A Questions 1–7)

| Question | Finding | Classification | Sources |
| :--- | :--- | :--- | :--- |
| **1. Existing ZMK/Zephyr/QMK port to Series One Pro?** | **None published prior to this work.** Project UFA (`aroum/ufa`) ports ZMK to Razer Viper V2 Pro, Logitech GPX, and Finalmouse Starlight-12, but had no Glorious Series One Pro (`CM2852-BAMF`) target. | **Verified** | `https://github.com/aroum/ufa` |
| **2. PCB GPIO connections or SWD pads mapped?** | Prior public repos did not map the `CM2852-BAMF` GPIOs. **We extracted and verified 100% of the GPIO pinout directly from the stock firmware disassembly** (Section 3.2 above). SWD pads are visible on the PCB in FCC photos (see `swd-and-recovery.md`). | **Verified** | Stock FW `CM2856_Mouse_USB_v1.00.00_20220810.hex` + `https://fccid.io/2AXP2SP22` |
| **3. Extracted original firmware?** | **Yes.** Extracted both `CM2856_Mouse_USB_v1.00.00_20220810.hex` (93,328 B app) and `CM2856_Receiver_USB_v1.00.00_20220810.hex` (45,120 B app) from the official Glorious updater archive. | **Verified** | `v1.0.0.0_20220810_Series_One_ProFirmware.zip` |
| **4. Published firmware dump, updater image, or bootloader analysis?** | No prior public bootloader analysis existed for Compx `258a:2103`/`258a:2113`. We decompiled `FirmwareUpdate.exe` and disassembled the ARM firmware to produce a complete specification (`firmware-updater.md`). | **Verified** | `FirmwareUpdate.exe` + `mouse_fw.bin` |
| **5. Reverse-engineered firmware update protocol?** | **Completed in Phase B.** Fully documented the 65-byte Feature report protocol (`0xB0` bootloader commands, `0x55` XOR obfuscation, `0x2003FFFC = 0xA55AA55A` bootloader entry magic). | **Verified** | See `research/firmware-updater.md` |
| **6. Compatible PAW3370/BAMF sensor driver?** | **Yes.** Stock register init/burst sequence extracted at `0x1708C`–`0x18554`, and Zephyr/ZMK PAW3370 SPI drivers exist in the ZMK ecosystem. | **Verified** | Stock FW `0x1708C`–`0x18554` |
| **7. Documented recovery or unbricking procedure?** | **Completed in Phases B & C.** Software recovery via the preserved 24 KB Compx USB HID bootloader (`0x00000000`–`0x00005FFF`, `258a:2103`) and hardware SWD recovery are documented in `swd-and-recovery.md` and `flashing-feasibility.md`. | **Verified** | See `research/swd-and-recovery.md` |
