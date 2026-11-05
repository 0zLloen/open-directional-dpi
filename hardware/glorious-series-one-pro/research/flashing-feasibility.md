# Firmware Foundation Comparison & Safe Flashing Feasibility Report

## 1. Phase D — Evaluation of Firmware Foundations

We evaluated four candidate firmware architectures for implementing **Open Directional DPI v1** on the **Glorious Forge Series One Pro Wireless** (`CM2852-BAMF`, Nordic `nRF52840-QIAA-D0`, PixArt `PAW3370` / Glorious `BAMF` sensor):

1. **ZMK + Project UFA (Recommended Primary Open-Source Firmware Foundation)**
2. **Native Zephyr RTOS Firmware**
3. **QMK Firmware**
4. **Binary Patching of Stock Glorious (`CM2856_Mouse_USB`) Firmware**

### 1.1 Multi-Criteria Technical Matrix

| Evaluation Criterion | ZMK + Project UFA | Native Zephyr RTOS | QMK Firmware | Patched Stock Glorious FW (`CM2856`) |
| :--- | :--- | :--- | :--- | :--- |
| **1. nRF52840 Compatibility** | **Excellent.** First-class Zephyr/nRF52840 support (`nrf52840_qiaa`), mature `nrfx_usbd`, `settings/nvs`, and BLE/2.4G peripheral drivers. | **Excellent.** First-class upstream SoC support via Nordic `nrfx`. | **Poor / Experimental.** QMK's ChibiOS/nRF52 port is incomplete and lacks mature nRF52840 USB/power/radio integration. | **Native.** Built on Nordic nRF5 SDK specifically for this PCB. |
| **2. PAW3370 / BAMF Sensor Support** | **High.** Existing Zephyr/ZMK PixArt SPI sensor drivers (`paw3395`/`paw3370`) + we extracted the exact `CM2856` SPI2 (`4 Mbps`, Mode 3) & register init sequence (`0x1708C`–`0x18554`). | **High.** Uses the same Zephyr `sensor` / `input` subsystem as ZMK. | **Moderate.** QMK has a basic `paw3370` driver for AVR/RP2040, but requires porting to nRF52 SPI. | **Native.** Full stock BAMF sensor calibration, LOD, and motion burst already present. |
| **3. GPIO & PCB Porting Effort** | **Low (Solved).** We extracted 100% of the `CM2852-BAMF` GPIO pinout (`P1.15`, `P1.13`, `P1.10`, `P0.09`, `P0.10`, `P1.00`, wheel `P0.29`/`P0.02`, SPI2 `P0.04`/`P0.12`/`P0.11`/`P0.08`, IRQ `P0.06`). | **Low–Moderate.** Same devicetree pins, but requires writing custom mouse button/wheel/HID glue from scratch. | **High.** Requires new ChibiOS board definition + nRF52840 linker script at `0x6000`. | **Zero.** Already configured for `CM2852-BAMF`. |
| **4. USB HID Capabilities** | **High.** Supports multi-interface USB HID (`Mouse` + `Consumer/Keyboard` + 64-byte `Usage Page 0xFFFF` Feature report on Interface 2). | **High.** Full control over `usb_hid` descriptors and Feature report callbacks. | **Moderate.** Raw HID exists, but matching the 3-interface `glorious-classic` descriptor layout requires custom USB descriptors. | **Native.** Already exposes the exact `258a:2018` 3-interface layout expected by OpenMouse. |
| **5. 1,000 Hz Polling Feasibility** | **Verified (`1 ms` interval).** Project UFA demonstrates 1,000 Hz wired USB polling on nRF52840 mice (`CONFIG_USB_HID_POLL_INTERVAL_MS=1`). | **Verified (`1 ms` interval).** Direct `nrfx_usbd` EP1 IN interrupt transfers at 1,000 Hz. | **Unproven on nRF52840.** | **Native.** Stock firmware runs at 1,000 Hz (`1 ms` USB / 2.4 GHz tick). |
| **6. Wireless Feasibility (`258a:2031`)** | **Moderate (Milestone 2).** Supports BLE natively and Gazell / ESB 2.4 GHz if both mouse and receiver (`258a:2031`) run ZMK, or if Compx's `NRF_RADIO` packet format (`0x00006711`) is replicated. | **Moderate.** Same as ZMK (requires custom ESB/Gazell or stock RF protocol implementation). | **Very Poor.** No 2.4 GHz dongle architecture for nRF52840. | **Immediate.** Stock 2.4 GHz proprietary RF stack (`0x00006711`) works out of the box with stock `258a:2031` receiver. |
| **7. Onboard Profile Storage** | **Excellent.** Zephyr `settings` / `nvs` subsystem mapped to dedicated flash pages `0x0007E000`–`0x0007FFFF` (preserving stock `0x00088000`+). | **Excellent.** Zephyr `nvs` / `settings`. | **Limited** on nRF52840 flash alongside Compx layout. | **High.** Can use unused flash page `0x0007E000` via stock flash driver (`0x0000BD80`). |
| **8. Custom Configuration Transport** | **Clean & Extensible.** 64-byte Feature report (`Report ID 0x00`) on Interface 2 integrates directly with ZMK input processor runtime state. | **Clean.** Same USB HID Feature report hook. | **Requires custom Raw HID bridging.** | **Feasible.** Can hook unused command ID `0xDF` in `Source\usb_protocol.c` (`0x0001451C`). |
| **9. Firmware Recovery Support** | **Full Software Recovery.** Linked at `0x00006000` (`CONFIG_FLASH_LOAD_OFFSET=0x6000`), reserves `0x2003FFFC`, writes `0xA55AA55A` on boot-chord (`LMB+RMB+DPI`) or USB command `0xB0`/`0x03`. | **Full Software Recovery.** Same `0x6000` offset and `0x2003FFFC` magic hook. | **Fragile** without custom early-boot assembly hook. | **Native.** Already implements `0x14824` (`*(uint32_t *)0x2003FFFC = 0xA55AA55A`). |
| **10. Long-Term Maintainability** | **Best.** Clean modular C input processor (`zmk,input-processor-directional-dpi`), portable across any ZMK/Zephyr mouse, open-source license, reproducible CI builds. | **Good**, but duplicates mouse scaffolding that ZMK + UFA already maintain. | **Poor** for nRF52840 mice. | **Poor for cross-vendor standardization** (binary patch tied to `CM2856 v1.00.00`). |

---

## 2. Evidence-Based Recommendation

We recommend a **two-track engineering strategy** centered on our portable C engine (`core/directional_dpi.c`):

1. **Primary Open-Source Architecture: ZMK + Project UFA (`firmware/zmk/` & `firmware/glorious-series-one-pro/`)**
   - **Why**: ZMK's modern `input_processor` architecture (`drivers/input/input_processor.h`) is purpose-built for transforming `(INPUT_REL_X, INPUT_REL_Y)` events in-flight between the PAW3370 sensor driver and the USB HID mouse report generator.
   - By implementing **Open Directional DPI v1** as a standalone, zero-dependency C library (`core/directional_dpi.c`) wrapped by a ZMK input processor (`firmware/zmk/src/input_processor_directional_dpi.c`) and a Glorious Series One Pro board definition (`firmware/glorious-series-one-pro/`), the exact same firmware module works on the Glorious Series One Pro **and** every other ZMK/UFA mouse (Razer Viper V2 Pro, Logitech G Pro X Superlight, Finalmouse Starlight-12, PixArt PAW3395/PAW3370 custom mice).
2. **Bonus Minimal-Risk Verification Option: Stock Firmware Hook (`0x000170B8` / `0x0001451C`)**
   - Because we also disassembled the exact motion-burst read (`0x0001708C`–`0x00017118`) and USB Feature report handler (`0x0001451C`–`0x00014AD0`) in `CM2856_Mouse_USB_v1.00.00_20220810.hex`, our `compx_hex_tool.py` utility in `firmware/glorious-series-one-pro/tools/compx_hex_tool.py` can package **either** a full ZMK build linked at `0x00006000` **or** a binary-patched stock image, while keeping the stock `CM2856_Mouse_USB_v1.00.00_20220810.hex` ready for instant rollback.

---

## 3. Safe Flashing & Recovery Architecture

### 3.1 Five-Layer Safety Design for Custom Firmware (`0x00006000`)

To guarantee that flashing custom firmware over the Compx USB HID Bootloader (`258a:2103`) can **never** brick the mouse or lose bootloader entry:

1. **Layer 1 — Bootloader Preservation (`0x00000000`–`0x00005FFF`)**:
   - The ZMK/Zephyr build is configured with `CONFIG_FLASH_LOAD_OFFSET=0x6000` and `CONFIG_FLASH_LOAD_SIZE=0x78000` (`480 KB`, ending at `0x0007E000`).
   - It never touches `0x00000000`–`0x00005FFF` (Compx USB HID Bootloader) or `0x00088000`–`0x000DFFFF` (factory RF pairing, calibration, and stock profiles).
2. **Layer 2 — Reserved Bootloader Magic RAM (`0x2003FFFC`–`0x2003FFFF`)**:
   - The top 16 bytes of SRAM (`0x2003FFF0`–`0x2003FFFF`) are excluded from the Zephyr SRAM region in the board devicetree (`sram0: memory@20000000 { reg = <0x20000000 0x0003FFF0>; };`).
   - This prevents the application stack or heap from ever corrupting `0x2003FFFC`.
3. **Layer 3 — Early Hardware Boot-Chord Recovery (`PRE_KERNEL_1` at Boot)**:
   - Before initializing clocks, SPI, or USB, `glorious_boot_recovery_check()` configures `P1.15` (Left Click), `P1.13` (Right Click), and `P1.00` (DPI Button) as inputs with pull-ups, waits `10 us`, and reads `NRF_P1->IN`.
   - If **Left + Right + DPI** are held simultaneously while plugging in the USB cable (or switching power on), the firmware writes `0xA55AA55A` to `*(volatile uint32_t *)0x2003FFFC`, executes `__DSB()`, and calls `NVIC_SystemReset()`.
   - The mouse immediately enumerates as `258a:2103` (Compx Bootloader) even if the rest of the application firmware were broken!
4. **Layer 4 — Stock + OpenMouse USB Bootloader Re-Entry Commands**:
   - The USB HID Feature report handler on Interface 2 (`Report ID 0x00`) responds to **both**:
     - The stock Compx updater bootloader entry packets (`buf[7] == 0xB0 && buf[8] == 0x04` and `buf[6] == 0x03`), so the unmodified official `v1.0.0.0_20220810_Series_One_ProFirmware.exe` updater can re-flash stock firmware at any time!
     - The Open Directional DPI v1 `CMD_ENTER_BOOTLOADER` (`0x0F` with confirmation magic `0x424C5253` `"BLRS"`) command from OpenMouse.
5. **Layer 5 — Offline Image Validator (`compx_hex_tool.py`)**:
   - Before any image is ever considered for flashing, `firmware/glorious-series-one-pro/tools/compx_hex_tool.py` validates:
     - Load address is strictly `>= 0x00006000` and `< 0x0007E000`.
     - ARM Cortex-M4F Initial Stack Pointer (`word[0]` at `0x00006000`) is within valid nRF52840 SRAM (`0x20000000`–`0x2003FFF0`).
     - `Reset_Handler` (`word[1]` at `0x00006004`) is a valid odd Thumb-2 code address inside `[0x00006001 .. end_addr]`.
     - The binary contains the bootloader magic constant `0xA55AA55A` and SRAM target `0x2003FFFC`.
