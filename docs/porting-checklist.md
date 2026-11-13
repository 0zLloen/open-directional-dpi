# Porting the stock-firmware patch to another mouse

The Glorious patch (`adapters/glorious-cm2856/`) is pinned to one stock image: `stock_ddpi_patch.c` and `build_and_verify_patch.py` hard-code its flash and SRAM addresses, and the build refuses any other image. A port to another stock firmware needs each item below, found in that firmware and checked the same way. The Glorious value is given for reference. No second mouse has been picked yet (2026-11-13).

Do the reverse engineering in [mouse-firmware-re](https://github.com/0zLloen/mouse-firmware-re) (its `CONTRIBUTING.md` safety ladder), with a `devices/<vendor>-<model>/` folder, and keep this repo to the patch.

| Needed | Glorious Series One Pro (CM2856 v1.0.0.0) |
| :--- | :--- |
| A stock image with a published hash, and a read-back dump from a retail mouse that matches it | Official `.hex` (SHA-256 in mouse-firmware-re `device.yaml`); decoded image `e50510e0...`, equal to the first 93,328 B of a `VerifyByAddress` dump (2026-11-13) |
| A USB bootloader with verified write and read-back, and a verified rollback to the stock image | Compx ISP bootloader `258a:2103`, `compx_usb_flasher.py` (Linux). `VerifyByAddress` reads `0x6000..0x4D7FF` |
| Free flash for the patch inside the range the bootloader's erase keeps, so an interruption between `Erase` and the `0xFF` write to the vector table leaves the old image intact (after that write, whether the bootloader stays resident is Unknown) | `0x1CD00..0x1DFFF`: after the stock image, below `0x1E000` (`Erase` keeps `0x6000..0x1DFFF`) |
| Free SRAM that the stock firmware never touches, away from any bootloader magic word | `0x2003F000` (engine state), below the magic word at `0x2003FFFC` |
| A hook at boot for one-time setup | `0xE874` (also checks the recovery chord) |
| The sensor burst-read call sites, and where the stock code keeps dx, dy and the motion flag | `0x131D8`, `0x13278` -> `0x1708C`; `0x20003020` / `0x2000302E` / `0x20003030` |
| A clock for the idle reset (a millisecond counter, or a call made at a fixed rate) | Burst-read calls, one per 1 ms TIMER1 tick while still (inferred, 2026-11-13) |
| A vendor Feature-report handler, a stock reply that can carry the `DP01` stamp, and a way to keep stock commands away from Open Directional DPI packets | `0xE8CE` -> `0x151AC`; version reply bytes `12..19`; stock rejects `feat[4] >= 5`, and DDPI `seq` is 5..255 |
| Stock flash erase and write functions, and a free flash page for the saved profile that the bootloader's erase does not reach | `0xBE78` / `0xBED8`; page `0x7E000` |
| The variable that holds the active DPI, if `ONLY_AT_BASE_DPI` should work | `0x20003068` (u16) |
| For a wireless mouse: how the receiver relays requests and how long a reply may be | Relay on `body[2] = 0x02`; reply length clamp at `0x15D8C`, `0x15DB4` (`spec/hid-protocol-v1.md` §2.3) |

Before any flash: emulate the patched image in Unicorn against the real stock code, as `build_and_verify_patch.py` does (boot hook, stock commands unchanged, DDPI commands, sensor hooks, save, relay). Then, on hardware: back up, flash, check the stamp and the commands, and roll back to stock once, before anything else is claimed. Record each result with its date and a Verified or Inferred label.
