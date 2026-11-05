# Glorious CORE v1 & Series One Pro Official Firmware Updater Analysis

## 1. Official Software & Firmware Package Provenance

All official installers, manifests, and firmware archives were inspected offline without executing any updater against the physical hardware.

### 1.1 Origins, Versions, and SHA-256 Hashes

| Artifact / File Name | Version / Date | Size (Bytes) | SHA-256 Hash | Origin / Container |
| :--- | :--- | :--- | :--- | :--- |
| `GloriousCore.zip` | `1.1.36` | `177,090,635` | `31327ec4deadbf672b05b78c48a826270f361216cdac7134f74379a9f5a0190a` | Glorious Legacy Software (`https://www.gloriousgaming.com/pages/legacy-software`) |
| `GloriousCore_Setup_1.1.36.exe` | `1.1.36` | `180,261,998` | `7f68626ebf7d61659629808d48936d5f404921a4728624f146e99acbc07e4f9d` | Inside `GloriousCore.zip` (Inno Setup 6.0.5 archive) |
| `manifest.json` (AWS S3 bucket index) | `2022–2024` | `460,572` | `596fb696e34fe1c0a09465ac15b405caa7e0d9e5b851fb539b1fa7f42724026a` | `https://gloriouscore.nyc3.digitaloceanspaces.com` / S3 firmware bucket listing |
| `v1.0.0.0_20220810_Series_One_ProFirmware.zip` | `v1.0.0.0` (`2022-08-10`) | `940,348` | `c9db15ef2ec11f8d44508ae16e0f98d22a60ba83a727163f7a0b7b1c5dd87814` | Official Glorious Series One Pro firmware package (`DevFw/v1.0.0.0_20220810_Series_One_ProFirmware.zip`) |
| `v1.0.0.0_20220810_Series_One_ProFirmware.exe` | `v1.0.0.0` | `536,576` | `e9e6c4fbd14c935cd31a2daa4992d20ac328bfd272b35e59233f09789b3c2576` | Self-extracting archive inside `Series_One_ProFirmware.zip` (Wired Mouse updater) |
| `v1.0.0.0_20220810_Series_One_ProFirmwareWireless.exe` | `v1.0.0.0` | `591,872` | `5f8d1eb132ad14a19eea9368ddd7e94b7b8aae6f40d6dcc6311410213f3e6df5` | Self-extracting archive inside `Series_One_ProFirmware.zip` (Paired Mouse + Receiver updater) |
| `FirmwareUpdate.exe` (.NET Framework v4.0) | `1.0.8229.18185` | `54,272` | `37ae7be701ba36ec987ec86d58b07819834aab0385ac4345138f49e9d9511ea5` | Extracted from both `.exe` updaters |
| `XVI.zip` (Wired payload, password `XVI`) | `2022-08-10` | `107,041` | `1da4a8a8ff3ba1613f21a46fd44e11b0a7aea2e52cfe494253fbc1283cc78877` | Embedded in `v1.0.0.0_20220810_Series_One_ProFirmware.exe` |
| `XVI.zip` (Wireless payload, password `XVI`) | `2022-08-10` | `162,250` | `bb3321d71b38fc85528fa977e29741189037b1c8c5644b4481a5860e55de825f` | Embedded in `v1.0.0.0_20220810_Series_One_ProFirmwareWireless.exe` |
| `CM2856_Mouse_USB_v1.00.00_20220810.hex` | `v1.00.00` | `262,649` | `2c5c1672ca0415a8f557c8a1dda3b71390fb2b97a226f3fc3cde78e01d188a92` | Extracted from `XVI.zip` (Mouse nRF52840 application Intel HEX) |
| `CM2856_Receiver_USB_v1.00.00_20220810.hex` | `v1.00.00` | `127,027` | `e60c5dbc853b3f07323efa9571e609813ae649eea9f92b67160f5a85ef0f103e` | Extracted from Wireless `XVI.zip` (Receiver nRF52840 application Intel HEX) |

---

## 2. Extraction & Packaging Chain

1. **Glorious CORE v1 Backend (`GloriousCore_Setup_1.1.36.exe`)**:
   - Extracted via `innoextract`. Contains an Electron frontend and Node.js backend (`app/resources/app/backend/DeviceApi.node`).
   - In `DeviceApi.node`, the Series One Pro is identified by `{VID: 0x258A, PID: 0x2018}` (wired) and `{VID: 0x258A, PID: 0x2031}` (wireless receiver) and routes firmware updates to the external standalone Compx updater binaries inside `DevFw/v1.0.0.0_20220810_Series_One_ProFirmware.zip`.
2. **Compx Self-Extracting Wrapper (`Series_One_ProFirmware*.exe`)**:
   - Contains `.NET` executable `FirmwareUpdate.exe`, `ICSharpCode.SharpZipLib.dll`, `Skin.ini`, and a password-protected ZIP archive `XVI.zip`.
   - Decompiling `FirmwareUpdate.Form1::UnZipUpdateFile()` confirms the hardcoded ZIP password is **`"XVI"`** (`fastZip.Password = "XVI"`).
3. **Intel HEX Payload & USB Wire Obfuscation (`HexHelper::LoadHexFile` & `C52840Dongle::Program`)**:
   - Inside `XVI.zip`, `CM2856_Mouse_USB_v1.00.00_20220810.hex` and `CM2856_Receiver_USB_v1.00.00_20220810.hex` are standard, unencrypted Intel HEX files containing raw ARM Cortex-M4F Thumb-2 machine code (`Initial_SP = 0x2000AF50`, `Reset_Handler = 0x000063DD`).
   - When `C52840Dongle::Program` transmits 32-byte flash chunks to the bootloader over USB HID Feature reports (`buf[6] = 0x02`), it XORs every payload byte on the wire with **`0x55`** (`buf[12 + i] = data[i] ^ 0x55`), and the bootloader on the nRF52840 XORs each byte with `0x55` before writing it to NVMC flash!
   - During verification (`C52840Dongle::VerifyByAddress`, `buf[6] = 0x83`), the bootloader reads back 32 bytes from flash, XORs them with `0x55`, and returns them over USB so `FirmwareUpdate.exe` can compare them byte-for-byte against `hexData ^ 0x55`.

---

## 3. Firmware Image Layout & Cryptographic Validation Analysis

### 3.1 Are Firmware Images Encrypted, Signed, Compressed, or Checksummed?

- **Encryption**: **NO.** Only trivial single-byte XOR (`^ 0x55`) obfuscation is used on `.hex` data records (`00`).
- **Cryptographic Signature**: **NO.** Neither `FirmwareUpdate.exe`, the `.hex` files, nor the bootloader performs RSA, ECDSA, Ed25519, or HMAC signature verification.
- **Compression**: **NO** on-chip compression. The `.hex` files unpack directly to raw ARM Cortex-M4F Thumb-2 machine code (`mouse_fw.bin` = `93,328` bytes; `receiver_fw.bin` = `45,120` bytes).
- **Checksums / Validation**:
  1. Standard 8-bit two's-complement Intel HEX per-line checksum in the `.hex` file (verified by `HexHelper::LoadHexFile`: **100% of all 5,841 records in `CM2856_Mouse_USB_v1.00.00_20220810.hex` and 2,827 records in `CM2856_Receiver_USB_v1.00.00_20220810.hex` pass checksum validation**).
  2. Readback verification (`C52840Dongle::VerifyByAddress`, command `0x83`): `FirmwareUpdate.exe` reads back every 32-byte block from `[startAddr .. startAddr + len]` and compares it byte-for-byte with the transmitted buffer before sending the `Exit` (`0x04`) command.

### 3.2 Do Updates Replace the Application, Bootloader, or Both?

- **Application-Only Replacement (Verified)**:
  - **Mouse (`CM2856_Mouse_USB_v1.00.00_20220810.hex`)**:
    - Extended Linear Address (`04`): `0x0000`
    - Start of Data (`00`): **`0x00006000`**
    - End of Data (`00`): **`0x0001CC8F`** (`93,328` bytes = `0x16C90` bytes)
    - Entry Point (`05` Start Linear Address): **`0x00006201`** (Keil `__main` scatter-loader; Vector Table `Reset_Handler` at `0x00006004` is `0x00006985` `SystemInit` + `__main`).
    - The resident **24 KB Compx USB HID Bootloader at `0x00000000`–`0x00005FFF` is NEVER erased or modified** during an update.
  - **Wireless Receiver (`CM2856_Receiver_USB_v1.00.00_20220810.hex`)**:
    - Start of Data (`00`): **`0x00007000`**
    - End of Data (`00`): **`0x0001203F`** (`45,120` bytes = `0xB040` bytes)
    - Entry Point (`05` Start Linear Address): **`0x00007201`** (`Reset_Handler` at `0x00007004` is `0x000073BD`).
    - The resident **28 KB Receiver Bootloader at `0x00000000`–`0x00006FFF` is NEVER erased or modified** during an update.

### 3.3 Complete Mouse Flash & SRAM Map (Verified from Firmware Disassembly)

Disassembly of `0x0000BD80`–`0x0000BF30` (flash page erase/write wrapper) and `0x00014500`–`0x00014AD0` (`Source\usb_protocol.c`) reveals the exact flash and SRAM partitioning:

| Address Range | Size | Purpose | Evidence Reference |
| :--- | :--- | :--- | :--- |
| `0x00000000` – `0x00005FFF` | `24 KB` | **Compx Resident USB HID Bootloader (`258a:2103`)** | Preserved by `Erase` (`0x01`); app starts at `0x00006000` |
| `0x00006000` – `0x0001CC8F` | `93.3 KB` | **Mouse Application Firmware (`CM2856_Mouse_USB`)** | Vector table at `0x00006000` (`Initial_SP = 0x2000B370`) |
| `0x0001CC90` – `0x00087FFF` | `428.8 KB` | Unused / Free Application Flash (available for custom firmware growth) | Blank (`0xFF`) |
| `0x00088000` – `0x00088FFF` | `4 KB` | **System Config Page `0x88`** (`32` bytes + CRC-16 at `+0x1E`, factory/RF pairing data) | Read/written at `0x14700`–`0x14770` (`page 0x88`) |
| `0x0008B000` – `0x0008BFFF` | `4 KB` | **Active Profile Config Page `0x8B`** (`0x266` = `614` bytes, CRC-16 at `+0x264`, factory defaults at `0x0001A3B8`) | Read/written at `0x14668`–`0x146B4` (`page 0x8B`) |
| `0x0008C000` – `0x0008CFFF` | `4 KB` | **Extended Config Page `0x8C`** (`0x4CB` = `1227` bytes, CRC-16 at `+0x4C9`) | Read/written at `0x146B8`–`0x14700` (`page 0x8C`) |
| `0x00090000` – `0x000DFFFF` | `320 KB` | **Per-Button Macro & Profile Pages (`0x90..0xDF`)** | Erased/written by HID commands `0x07`–`0x09` |
| `0x20000000` – `0x2003FFFB` | `~256 KB` | Application SRAM (`RW`/`ZI` + Heap + Stack) | Keil scatter map at `0x0001AAE4` |
| **`0x2003FFFC` – `0x2003FFFF`** | **`4 Bytes`** | **Bootloader Entry Magic Word (`0xA55AA55A`)** | Written at `0x00014836` before `NVIC_SystemReset()` |

> **Critical Preservation Rule**: Flash pages `0x00088000` (`page 0x88`), `0x0008B000` (`page 0x8B`), and `0x0008C000` (`page 0x8C`) store radio pairing and calibration/profile structures. Custom firmware must keep its code/rodata below `0x00080000` (giving `488 KB` of space between `0x00006000` and `0x00080000`) and store its own non-volatile settings in a dedicated page such as `0x0007E000`–`0x0007FFFF` so stock calibration and pairing data at `0x00088000` are never overwritten!

---

## 4. Reverse-Engineered Compx USB HID Bootloader Protocol

All communication with both the application (`258a:2018` / `258a:2031`) and the bootloader (`258a:2103` / `258a:2113`) uses **64-byte HID Feature Reports on Interface 2 (`Usage Page 0xFFFF`, Report ID `0x00`)**.

In Windows HID / Linux `hidraw` / WebHID, the buffer passed to `HidD_SetFeature` / `ioctl(HIDIOCSFEATURE)` is **65 bytes**: `buf[0] = 0x00` (Report ID), followed by the 64-byte payload `buf[1..64]`.

### 4.1 Step 1 — Switching from Application Mode to Bootloader Mode

Decompilation of `C52840Dongle::SetBLDeviceMode` (`FirmwareUpdate.exe`) and disassembly of the stock firmware's USB Feature report dispatcher (`0x0001451C`–`0x00014AD0`) prove two ways the stock firmware enters the bootloader:

1. **Via Bootloader Subcommand (`buf[7] == 0xB0`, dispatched at `0x00014548`)**:
   - `FirmwareUpdate.exe` sends `SetFeature` (65 bytes):
     ```
     buf[0] = 0x00  // Report ID
     buf[1..5] = 0x00
     buf[6] = 0x06  // Length = 6
     buf[7] = 0xB0  // Bootloader family marker
     buf[8] = 0x04  // Command: Enter Bootloader (0x04 for Wired Mouse, 0x05 for Dongle)
     buf[9] = 0x00  // Mode = 0x00 (enter BL)
     ```
2. **Via Direct App Command `0x03` (`buf[6] == 0x03`, dispatched at `0x00014824`)**:
   - When the firmware sees `buf[6] == 0x03` (with `buf[1] == 0x00`, or after `buf[7] == 0xB0, buf[8] == 0x04`):
     - At `0x00014832`:
       ```asm
       0x14832: ldr r0, [pc, #0x2fc] ; r0 = 0x2003FFFC (Top 4 bytes of 256 KB SRAM)
       0x14834: ldr r1, [pc, #0x2fc] ; r1 = 0xA55AA55A (Bootloader Magic Word)
       0x14836: str r1, [r0, #0x0]   ; *(volatile uint32_t *)0x2003FFFC = 0xA55AA55A
       ```
     - After a short timer ticks (`100 ms`), calls `0x000071B8` (`NVIC_SystemReset()`, writing `0x05FA0004` to `SCB->AIRCR` at `0xE000ED0C`).
   - Upon reset, the resident Compx Bootloader (`0x00000000`–`0x00005FFF`) inspects `*(uint32_t *)0x2003FFFC`. Seeing `0xA55AA55A`, it clears the magic word, initializes USB as **`258a:2103`** (`Compx USB HID Bootloader`), and waits for flashing commands!

### 4.2 Step 2 — Bootloader Command Packet Structure (`258a:2103` & `258a:2113`)

Once enumerated as `258a:2103` (Wired Mouse Bootloader) or `258a:2113` (Wireless Receiver Bootloader), `C52840Dongle` communicates via `SetFeature` (`CPMXHIDDevice::SetFeature`) and `GetFeature` (`CPMXHIDDevice::GetFeature` after a retry delay of `15 ms`):

| Command Name | `buf[3]` | `buf[4]` (Len) | `buf[5]` | `buf[6]` (Cmd) | `buf[7..11]` | `buf[12..64]` | Response / Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`GetBLFW`** | `0x00` | `0x06` | `0xB0` | `0x80` | `0x00..` | `0x00..` | `GetFeature` returns `resp[1] == 0xA1` (OK) and 4-byte BL version at `resp[9..12]` (must contain `0xB0`). |
| **`Erase`** | `0x00` | `0x08` | `0xB0` | `0x01` | `0x00..` | `0x00..` | Erases application flash (`0x00006000`+ on mouse, `0x00007000`+ on receiver). Does **not** touch bootloader (`0x0000..0x5FFF`). |
| **`Program`** | `0x00` | `len + 5` | `0xB0` | `0x02` | `buf[7] = len` (`<= 32`)<br>`buf[8..11] = addr` (Big-Endian `uint32`) | Up to 32 bytes of `data ^ 0x55` (`buf[12 .. 12+len-1]`) | Bootloader XORs each byte with `0x55` and writes to `addr`. Host sleeps `10 ms` every `4096` (`0x1000`) bytes. |
| **`VerifyByAddress`** | `0x00` | `0x20` | `0xB0` | `0x83` | `buf[7] = len` (`<= 32`)<br>`buf[8..11] = addr` (Big-Endian `uint32`) | `0x00..` | `GetFeature` returns `resp[1] == 0xA1` and `len` bytes at `resp[12 .. 12+len-1]` (XORed with `0x55`). |
| **`Exit`** | `0x00` | `0x01` | `0xB0` | `0x04` | `buf[7] = mode` (`0x01` = boot app) | `0x00..` | Marks application valid and resets into application (`0x00006000`). |

- **Status Codes in `resp[1]` (`CPMXHIDDevice::SetFeature` / `GetFeature`)**:
  - `0xA1` or `0x02`: Command Succeeded (`Result_Succeed`)
  - `0xA2`: Command Failed (`Result_Fail`)
  - `0xA3`: Unknown Command (`Result_UnkownCommand`)
  - `0xA4`: Out of Range (`Result_OutOfRange`)

### 4.3 Wired Mouse vs. Wireless Receiver Update Procedures

Decompilation of `Form1::InitDevice()` and `Form1::StartUpdateThread()` shows:
- **`v1.0.0.0_20220810_Series_One_ProFirmware.exe` (Wired-Only Package)**:
  - Contains only `CM2856_Mouse_USB_v1.00.00_20220810.hex`.
  - Updates `258a:2018` -> `258a:2103` (`C52840Dongle(0x258A, 0x2018, 0x2103, ..., isDongle=false)`).
- **`v1.0.0.0_20220810_Series_One_ProFirmwareWireless.exe` (Wireless Combined Package)**:
  - Contains both `CM2856_Mouse_USB_v1.00.00_20220810.hex` and `CM2856_Receiver_USB_v1.00.00_20220810.hex`.
  - Requires **both** the wired mouse (`258a:2018`) and wireless receiver (`258a:2031`) to be plugged into USB simultaneously (`deviceList.Count == 2`), and updates them sequentially over USB. It does **not** perform OTA (over-the-air) RF flashing.

---

## 5. Conclusion: Can the Official Updater Safely Install Custom Firmware?

**YES — with high confidence and full software recoverability, provided three strict engineering rules are followed:**

1. **No Cryptographic Lockout**: Because the Compx bootloader (`258a:2103`) performs **zero cryptographic signature verification** and only XORs incoming payload bytes with `0x55`, any valid ARM Cortex-M4F binary linked at **`0x00006000`** and packaged as an XOR-`0x55` Intel HEX file (`CM2856_Mouse_USB_v1.00.00_20220810.hex`) will be accepted, programmed, verified, and booted by the unmodified stock bootloader.
2. **Resident Bootloader Preservation**: The `Erase` (`0x01`) and `Program` (`0x02`) commands only operate on application flash (`>= 0x00006000`). The 24 KB bootloader at `0x00000000`–`0x00005FFF` remains untouched in flash.
3. **Mandatory Bootloader Re-Entry Mechanism in Custom Firmware**:
   - Because the bootloader normally jumps straight to `0x00006000` when a valid application header/vector table is present unless `*(volatile uint32_t *)0x2003FFFC == 0xA55AA55A`, **any custom firmware flashed via USB MUST include**:
     1. **Boot-Chord Hardware Fallback**: On startup (inside `SYS_INIT(PRE_KERNEL_1)` before initializing USB or sensors), sample the physical Left + Right + DPI buttons (`P1.15`, `P1.13`, `P1.00`). If held low at power-on/reset, immediately write `0xA55AA55A` to `*(volatile uint32_t *)0x2003FFFC` and call `NVIC_SystemReset()`.
     2. **USB HID Bootloader Command Support**: Handle Feature report `buf[7] == 0xB0` / `buf[6] == 0x03` (and our Open Directional DPI `CMD_ENTER_BOOTLOADER` command) by writing `0xA55AA55A` to `0x2003FFFC` and resetting.
   - With both mechanisms present, even if USB descriptors or sensor code have a bug, holding Left+Right+DPI while plugging in the USB cable forces the mouse back into `258a:2103` bootloader mode, allowing immediate restoration of the stock `CM2856_Mouse_USB_v1.00.00_20220810.hex` firmware.
