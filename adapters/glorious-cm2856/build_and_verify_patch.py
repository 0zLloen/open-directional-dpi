#!/usr/bin/env python3
"""
Build and verify the open-directional-dpi patch for the Glorious Series One Pro
(Compx CM2856, stock firmware CM2856_Mouse_USB_v1.00.00_20220810).

1. Loads the stock application image: adapters/stock/CM2856_Mouse_USB_v1.00.00_20220810.bin
   (the decoded official .hex), or --stock-hex <official .hex, or a dump .hex of your own
   stock mouse>. A .hex is decoded and trimmed to the stock length. The image must have
   SHA-256 e50510e0... (STOCK_SHA256) or the build stops.
2. Compiles stock_ddpi_patch.c + core/directional_dpi.c at 0x0001CD00 with
   $CROSS{gcc,objcopy,nm,objdump} (CROSS defaults to arm-none-eabi-, as in the Makefile).
3. Appends the patch to the stock image, redirects the 4 call sites (0x0000E874, 0x0000E8CE,
   0x000131D8, 0x00013278), replaces the two 2.4 GHz reply-length reads (0x00015D8C,
   0x00015DB4) with the 64-byte clamp and the sensor DPI writer instruction at 0x00017864
   with a call that records the DPI.
4. Runs the compx_hex_tool.py safety audit (mouse-firmware-re) on the image.
5. Runs the patched image in Unicorn (pip install unicorn; required) with 11 tests:
   1-2 boot hook (recovery chord, normal boot), 3 stock version query + "DP01" stamp,
   4 stock bootloader entry (feat[3]=0x01, feat[6]=0xB0), 5 GET_CAPABILITIES,
   6 SET_PROFILE + SAVE_FLASH (an identical second save does not erase), 7 sensor hooks,
   8 request relayed through the 2.4 GHz receiver, 9 2.4 GHz reply capped at 64 bytes,
   10 idle reset of the direction estimator after 50 burst calls (1 per ms tick),
   11 DPI-shift press and release: sensor_dpi follows the sensor, 0x20003068 does not.
6. Only then writes adapters/build/CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.bin and .hex, and
   adapters/build/OpenDDPIv1-patch.json for apply_patch.py (users without the ARM toolchain). The
   patch file holds only the bytes that differ from the stock image: the hook instructions and the
   appended patch code, never stock bytes (asserted). It is the one build output that may be published.

Exits non-zero if the toolchain, compx_hex_tool.py, unicorn or the stock image is missing,
or if any check fails. Any old OpenDDPIv1 .bin/.hex/.json is deleted first, so a failed run leaves
no image to flash. The checks are assert statements: python3 -O is refused.
"""

import argparse
import hashlib
import itertools
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PATCH_DIR = Path(__file__).resolve().parent
STOCK_DIR = PATCH_DIR.parent / "stock"
BUILD_DIR = PATCH_DIR.parent / "build"
# compx_hex_tool.py lives in https://github.com/0zLloen/mouse-firmware-re (sibling checkout by default)
TOOLS_DIR = Path(os.environ.get("COMPX_TOOLS", REPO_ROOT.parent / "mouse-firmware-re" / "platforms" / "compx-nrf52" / "tools"))
CORE_DIR = REPO_ROOT / "core"

# Same convention as the Makefile: CROSS=/opt/arm/bin/arm-none-eabi- if the tools are not on PATH
CROSS = os.environ.get("CROSS", "arm-none-eabi-")
ARM_GCC, ARM_OBJCOPY, ARM_NM, ARM_OBJDUMP = (CROSS + t for t in ("gcc", "objcopy", "nm", "objdump"))

APP_BASE = 0x00006000
PATCH_BASE = 0x0001CD00
STOCK_BIN = STOCK_DIR / "CM2856_Mouse_USB_v1.00.00_20220810.bin"
STOCK_LEN = 0x0001CC90 - APP_BASE  # 93,328 bytes
# Decoded official CM2856_Mouse_USB_v1.00.00_20220810.hex (sha256 2c5c1672...); also the first
# 93,328 bytes of a VerifyByAddress dump of a retail mouse on stock v1.0.0.0 (checked 2026-11-13).
STOCK_SHA256 = "e50510e0eb213e69d62a088d6f5b792fb88b0f3dc56d3c9c21dd0ca8b6e892be"
PATCH_FORMAT = {"format": "open-directional-dpi-patch", "version": 1}


def import_compx_hex_tool():
    if not (TOOLS_DIR / "compx_hex_tool.py").is_file():
        sys.exit(
            f"compx_hex_tool.py not found in {TOOLS_DIR}: clone "
            "https://github.com/0zLloen/mouse-firmware-re next to this repo or set COMPX_TOOLS"
        )
    sys.path.insert(0, str(TOOLS_DIR))
    import compx_hex_tool

    return compx_hex_tool


def load_stock_image(stock_hex) -> bytes:
    """Stock app image from the official .hex or a dump .hex, else the decoded .bin; checked by SHA-256."""
    if stock_hex is not None:
        try:
            data = import_compx_hex_tool().load_app_hex(stock_hex, APP_BASE)[0][:STOCK_LEN]
        except (OSError, ValueError) as e:
            sys.exit(f"--stock-hex: {e}")
        src = stock_hex
    elif STOCK_BIN.is_file():
        data, src = STOCK_BIN.read_bytes(), STOCK_BIN
    else:
        sys.exit(f"Stock image not found: put the decoded official image at {STOCK_BIN}, or pass --stock-hex")
    digest = hashlib.sha256(data).hexdigest()
    if digest != STOCK_SHA256:
        sys.exit(
            f"{src}: stock image is {len(data)} bytes, sha256 {digest}; expected {STOCK_LEN} bytes, "
            f"sha256 {STOCK_SHA256} (CM2856 v1.00.00 20220810). Only that firmware can be patched."
        )
    return data


def encode_thumb2_bl(src_addr: int, dst_addr: int) -> bytes:
    """Encode a 32-bit Thumb-2 BL instruction from src_addr to dst_addr."""
    offset = dst_addr - (src_addr + 4)
    if offset % 2 != 0 or not (-16777216 <= offset <= 16777214):
        raise ValueError(f"BL offset out of range: {src_addr:#x} -> {dst_addr:#x}")
    s = 1 if offset < 0 else 0
    imm25 = offset & 0x1FFFFFF
    imm11 = (imm25 >> 1) & 0x7FF
    imm10 = (imm25 >> 12) & 0x3FF
    i1 = (imm25 >> 23) & 1
    i2 = (imm25 >> 22) & 1
    j1 = (~i1 ^ s) & 1
    j2 = (~i2 ^ s) & 1
    hw1 = 0xF000 | (s << 10) | imm10
    hw2 = 0xD000 | (j1 << 13) | (j2 << 11) | imm11
    return struct.pack("<HH", hw1, hw2)


def decode_thumb2_bl(raw4: bytes, src_addr: int) -> int:
    hw1, hw2 = struct.unpack("<HH", raw4)
    s = (hw1 >> 10) & 1
    imm10 = hw1 & 0x3FF
    j1 = (hw2 >> 13) & 1
    j2 = (hw2 >> 11) & 1
    imm11 = hw2 & 0x7FF
    i1 = (~(j1 ^ s)) & 1
    i2 = (~(j2 ^ s)) & 1
    imm25 = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1)
    if s:
        imm25 -= 1 << 25
    return (src_addr + 4 + imm25) & 0xFFFFFFFF


def build_patch(stock_bin: bytes) -> dict:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    elf_path = BUILD_DIR / "stock_ddpi_patch.elf"
    bin_path = BUILD_DIR / "stock_ddpi_patch.bin"
    lst_path = BUILD_DIR / "stock_ddpi_patch.lst"

    cmd = [
        ARM_GCC,
        "-mcpu=cortex-m4",
        "-mthumb",
        "-Os",
        "-ffreestanding",
        "-nostdlib",
        "-fno-builtin",
        "-Wall",
        "-Wextra",
        "-Werror",
        f"-I{CORE_DIR}",
        f"-T{PATCH_DIR / 'stock_ddpi_patch.ld'}",
        "-Wl,--gc-sections",
        str(PATCH_DIR / "stock_ddpi_patch.c"),
        str(CORE_DIR / "directional_dpi.c"),
        "-o",
        str(elf_path),
    ]
    subprocess.run(cmd, check=True)
    subprocess.run([ARM_OBJCOPY, "-O", "binary", str(elf_path), str(bin_path)], check=True)
    with open(lst_path, "w") as f:
        subprocess.run([ARM_OBJDUMP, "-d", "-S", str(elf_path)], stdout=f, check=True)

    nm_out = subprocess.check_output([ARM_NM, "-n", str(elf_path)], text=True)
    symbols = {}
    for line in nm_out.splitlines():
        parts = line.strip().split()
        if len(parts) >= 3:
            symbols[parts[2]] = int(parts[0], 16)

    patch_bytes = bin_path.read_bytes()
    print(f"[BUILD] Compiled OpenDDPIv1 patch payload: {len(patch_bytes)} bytes at 0x{PATCH_BASE:08X}..0x{PATCH_BASE + len(patch_bytes):08X}")
    for sym in ("ddpi_boot_init_wrapper", "ddpi_usb_protocol_wrapper", "ddpi_paw3370_burst_wrapper"):
        print(f"        Symbol {sym:<28} = 0x{symbols[sym]:08X}")

    # Pad from 0x0001CC90 to 0x0001CD00 with 0xFF (erased flash)
    pad_len = PATCH_BASE - (APP_BASE + len(stock_bin))
    assert pad_len == 0x70
    full_bin = bytearray(stock_bin) + bytearray(b"\xFF" * pad_len) + bytearray(patch_bytes)

    # Align total size to 32-byte Compx Program chunk boundary with 0xFF padding
    if len(full_bin) % 32 != 0:
        full_bin += bytearray(b"\xFF" * (32 - (len(full_bin) % 32)))

    # Verify and patch the 4 BL hooks
    sites = []  # (address, length) of every stock byte replaced; the patch file may hold only these
    hooks = [
        (0x0000E874, 0x0000D4A0, symbols["ddpi_boot_init_wrapper"], "boot_init_hook"),
        (0x0000E8CE, 0x000151AC, symbols["ddpi_usb_protocol_wrapper"], "usb_proto_hook"),
        (0x000131D8, 0x0001708C, symbols["ddpi_paw3370_burst_wrapper"], "sensor_burst_hook_1"),
        (0x00013278, 0x0001708C, symbols["ddpi_paw3370_burst_wrapper"], "sensor_burst_hook_2"),
    ]
    for call_addr, expected_orig_target, new_target, label in hooks:
        file_off = call_addr - APP_BASE
        orig_target = decode_thumb2_bl(full_bin[file_off : file_off + 4], call_addr)
        assert orig_target == expected_orig_target, (
            f"Hook {label} at 0x{call_addr:08X} expected orig target 0x{expected_orig_target:08X}, "
            f"got 0x{orig_target:08X}"
        )
        encoded = encode_thumb2_bl(call_addr, new_target)
        assert decode_thumb2_bl(encoded, call_addr) == new_target
        full_bin[file_off : file_off + 4] = encoded
        sites.append((call_addr, 4))
        print(f"        Patched {label:<20} @ 0x{call_addr:08X}: 0x{orig_target:08X} -> 0x{new_target:08X} ({encoded.hex()})")

    # Cap the stock 2.4 GHz reply length at 64 bytes (see ddpi_rf_reply_len_clamp): replace the two
    # "ldrb r1,[r6,#3]; adds r1,#6" length reads in 0x15D74 with a BL to the clamp helper.
    clamp = symbols["ddpi_rf_reply_len_clamp"]
    code_patches = [
        # ldrb r1,[r6,#3]; add.w r2,r0,#8; adds r1,#6  ->  bl clamp; add.w r2,r0,#8
        (0x00015D8C, "f17800f10802891d", lambda a: encode_thumb2_bl(a, clamp) + bytes.fromhex("00f10802"), "rf_len_clamp_1"),
        # ldrb r1,[r6,#3]; adds r1,#6  ->  bl clamp
        (0x00015DB4, "f178891d", lambda a: encode_thumb2_bl(a, clamp), "rf_len_clamp_2"),
        # sub.w r0,r0,#0x2700 -> bl note (does the sub)
        (0x00017864, "a0f51c50", lambda a: encode_thumb2_bl(a, symbols["ddpi_cpi_write_note"]), "cpi_write_note"),
    ]
    for addr, expected_hex, new_bytes, label in code_patches:
        file_off = addr - APP_BASE
        expected = bytes.fromhex(expected_hex)
        assert bytes(full_bin[file_off : file_off + len(expected)]) == expected, (
            f"Code patch {label} at 0x{addr:08X} expected {expected_hex}, got "
            f"{bytes(full_bin[file_off : file_off + len(expected)]).hex()}"
        )
        replacement = new_bytes(addr)
        assert len(replacement) == len(expected)
        full_bin[file_off : file_off + len(expected)] = replacement
        sites.append((addr, len(expected)))
        print(f"        Patched {label:<20} @ 0x{addr:08X}: {expected_hex} -> {replacement.hex()}")

    # Convert to Intel HEX and run compx_hex_tool.py verification (nothing is written yet)
    compx_hex_tool = import_compx_hex_tool()
    hex_text = compx_hex_tool.encode_compx_hex(bytes(full_bin), base_addr=APP_BASE)
    res = compx_hex_tool.audit_binary_safety(bytes(full_bin), base_addr=APP_BASE)
    assert res["all_passed"], f"compx_hex_tool validation failed: {res}"
    print(
        f"[BUILD] Image passes the compx_hex_tool audit ({len(full_bin)} bytes, "
        f"0x{APP_BASE:08X}..0x{APP_BASE + len(full_bin) - 1:08X}, SHA256={res['sha256'][:16]}...)"
    )

    return {"full_bin": bytes(full_bin), "hex_text": hex_text, "symbols": symbols, "sites": sites}


def make_patch_file(stock: bytes, image: bytes, sites: list) -> dict:
    """apply_patch.py input: the bytes where image differs from stock padded with 0xFF to its size, as
    {addr, hex} runs. Each run must lie inside a hook site or the appended region, so the file carries
    no stock bytes (a hook site's runs are the project's instruction encodings)."""
    padded = stock.ljust(len(image), b"\xFF")
    ranges = []
    for changed, run in itertools.groupby(range(len(image)), lambda i: image[i] != padded[i]):
        if changed:
            run = list(run)
            start, end = APP_BASE + run[0], APP_BASE + run[-1] + 1
            assert run[0] >= len(stock) or any(a <= start and end <= a + n for a, n in sites), (
                f"changed bytes 0x{start:08X}..0x{end:08X} outside the hook sites and the appended region"
            )
            ranges.append({"addr": f"0x{start:08X}", "hex": image[run[0] : run[-1] + 1].hex()})
    return {
        **PATCH_FORMAT,
        "stock": {"sha256": hashlib.sha256(stock).hexdigest(), "size": len(stock)},
        "ranges": ranges,
        "result": {"sha256": hashlib.sha256(image).hexdigest(), "size": len(image)},
    }


def run_unicorn_verification(full_bin: bytes, symbols: dict) -> None:
    from unicorn import (
        UC_ARCH_ARM,
        UC_HOOK_CODE,
        UC_MODE_THUMB,
        UC_PROT_ALL,
        Uc,
    )
    from unicorn.arm_const import (
        UC_ARM_REG_LR,
        UC_ARM_REG_PC,
        UC_ARM_REG_R0,
        UC_ARM_REG_R1,
        UC_ARM_REG_R2,
        UC_ARM_REG_SP,
    )

    print("\n[UNICORN] Starting ARM Cortex-M4F instruction-level hardware emulation...")

    mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

    # Map nRF52840 Flash (1 MB at 0x00000000), SRAM (256 KB at 0x20000000), Peripherals (0x50000000), and Halt Trap (0xFFFFFF00)
    mu.mem_map(0x00000000, 0x00100000, UC_PROT_ALL)
    mu.mem_map(0x20000000, 0x00040000, UC_PROT_ALL)
    mu.mem_map(0x50000000, 0x00010000, UC_PROT_ALL)
    mu.mem_map(0xFFFFF000, 0x00001000, UC_PROT_ALL)

    # Initialize Flash to 0xFF and load patched firmware at 0x00006000
    mu.mem_write(0x00000000, b"\xFF" * 0x00100000)
    mu.mem_write(APP_BASE, full_bin)

    HALT_ADDR = 0xFFFFFE00
    sim_state = {
        "reset_called": False,
        "load_cfg_called": False,
        "paw3370_burst_called": False,
        "erase_calls": 0,
        "sim_motion": 0,
        "sim_dx": 0,
        "sim_dy": 0,
        "spi": [],
    }

    def hook_code(uc, address, size, user_data):
        # Intercept hardware peripheral/stock stubs that touch unmapped nRF52840 SPI/NVMC/NVIC hardware registers
        if address == 0x000071B8:
            # STOCK_FN_NVIC_RESET
            sim_state["reset_called"] = True
            uc.emu_stop()
        elif address == 0x0000D4A0:
            # STOCK_FN_LOAD_FLASH_CFG: simulate returning cleanly (bx lr)
            sim_state["load_cfg_called"] = True
            lr = uc.reg_read(UC_ARM_REG_LR)
            uc.reg_write(UC_ARM_REG_PC, lr)
        elif address == 0x0001708C:
            # STOCK_FN_PAW3370_BURST: populate 0x20003020 (motion), 0x2000302E (dx), 0x20003030 (dy) and return
            sim_state["paw3370_burst_called"] = True
            uc.mem_write(0x20003020, struct.pack("<B", sim_state["sim_motion"]))
            uc.mem_write(0x2000302E, struct.pack("<hh", sim_state["sim_dx"], sim_state["sim_dy"]))
            lr = uc.reg_read(UC_ARM_REG_LR)
            uc.reg_write(UC_ARM_REG_PC, lr)
        elif address == 0x0000BE78:
            # STOCK_FN_FLASH_ERASE_PAGE(r0 = page_addr)
            page_addr = uc.reg_read(UC_ARM_REG_R0)
            assert page_addr == 0x0007E000, f"Unexpected flash erase address: 0x{page_addr:08X}"
            sim_state["erase_calls"] += 1
            uc.mem_write(page_addr, b"\xFF" * 4096)
            uc.reg_write(UC_ARM_REG_R0, 0)
            lr = uc.reg_read(UC_ARM_REG_LR)
            uc.reg_write(UC_ARM_REG_PC, lr)
        elif address == 0x0000BED8:
            # STOCK_FN_FLASH_WRITE(r0 = dst_addr, r1 = src_ptr, r2 = len)
            dst_addr = uc.reg_read(UC_ARM_REG_R0)
            src_ptr = uc.reg_read(UC_ARM_REG_R1)
            length = uc.reg_read(UC_ARM_REG_R2)
            assert dst_addr == 0x0007E000, f"Unexpected flash write address: 0x{dst_addr:08X}"
            data = bytes(uc.mem_read(src_ptr, length))
            uc.mem_write(dst_addr, data)
            uc.reg_write(UC_ARM_REG_R0, 0)
            lr = uc.reg_read(UC_ARM_REG_LR)
            uc.reg_write(UC_ARM_REG_PC, lr)
        elif address == 0x000184B4:
            # Stock PAW3370 register write (r0 = register, r1 = value): record it and return
            sim_state["spi"].append((uc.reg_read(UC_ARM_REG_R0) & 0xFF, uc.reg_read(UC_ARM_REG_R1) & 0xFF))
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif address == 0x000120B4:
            # Stock delay: return at once
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    mu.hook_add(UC_HOOK_CODE, hook_code)

    def call_thumb_at(addr: int):
        mu.reg_write(UC_ARM_REG_SP, 0x2000AF50)
        mu.reg_write(UC_ARM_REG_LR, HALT_ADDR | 1)
        mu.emu_start(addr | 1, HALT_ADDR, count=200000)

    def call_bl_site_at(call_addr: int):
        mu.reg_write(UC_ARM_REG_SP, 0x2000AF50)
        mu.reg_write(UC_ARM_REG_LR, HALT_ADDR | 1)
        mu.emu_start(call_addr | 1, call_addr + 4, count=200000)

    # -------------------------------------------------------------------------
    # TEST 1: Boot Init Hook @ 0x0000E874 — Emergency Boot Recovery Chord Held
    # -------------------------------------------------------------------------
    sim_state["reset_called"] = False
    mu.mem_write(0x2003FFFC, struct.pack("<I", 0))
    # All buttons on P1 held low (0x00000000)
    mu.mem_write(0x50000810, struct.pack("<I", 0x00000000))
    call_bl_site_at(0x0000E874)
    magic = struct.unpack("<I", mu.mem_read(0x2003FFFC, 4))[0]
    assert sim_state["reset_called"] and magic == 0xA55AA55A, "Emergency boot chord failed to trigger Compx bootloader!"
    print("  [PASS] Test 1: Boot Init Hook @ 0x0000E874 (LMB+RMB+DPI chord -> 0x2003FFFC=0xA55AA55A + NVIC Reset)")

    # -------------------------------------------------------------------------
    # TEST 2: Boot Init Hook @ 0x0000E874 — Normal Boot (Buttons Released)
    # -------------------------------------------------------------------------
    sim_state["reset_called"] = False
    sim_state["load_cfg_called"] = False
    mu.mem_write(0x2003FFFC, struct.pack("<I", 0))
    mu.mem_write(0x50000810, struct.pack("<I", 0xFFFFFFFF))  # Buttons released (active low -> 1)
    call_bl_site_at(0x0000E874)
    init_magic = struct.unpack("<I", mu.mem_read(0x2003F000, 4))[0]
    assert not sim_state["reset_called"] and sim_state["load_cfg_called"] and init_magic == 0x44445049
    print("  [PASS] Test 2: Boot Init Hook @ 0x0000E874 (Normal boot -> stock 0x0D4A0 + DDPI init @ 0x2003F000)")

    # -------------------------------------------------------------------------
    # TEST 3: Stock USB Firmware Version Query via Hook @ 0x0000E8CE
    # -------------------------------------------------------------------------
    # Point *0x200032D8 to a 64-byte USB GetFeature buffer at 0x20006000
    # In stock firmware, 0x200035DE == 0 (no RF error) and 0x20003003 == 2 (Wired USB mode)
    mu.mem_write(0x200032D8, struct.pack("<I", 0x20006000))
    mu.mem_write(0x20006000, b"\x00" * 64)
    mu.mem_write(0x200035DE, b"\x00")
    mu.mem_write(0x20003003, b"\x02")
    # Prepare standard Glorious FW version query in 0x20004F28: feat[3]=6, feat[4]=0x00, feat[5]=0x81
    ver_req = bytearray(64)
    ver_req[3] = 0x06
    ver_req[4] = 0x00
    ver_req[5] = 0x81
    mu.mem_write(0x20004F28, bytes(ver_req))
    mu.mem_write(0x200032D4, b"\x01")  # Wired USB Feature pending
    call_bl_site_at(0x0000E8CE)
    usb_resp = bytes(mu.mem_read(0x20004F28, 64))
    usb_get_buf = bytes(mu.mem_read(0x20006000, 64))
    assert usb_resp[0] == 0xA1 and usb_resp[6:12] == bytes([1, 0, 0, 0, 0x20, 0x18]) and usb_resp[16:20] == b"DP01" and usb_resp[12:16] == b"DP01", (
        f"Unexpected usb_resp: {usb_resp[:24].hex()}"
    )
    assert usb_get_buf == usb_resp
    assert mu.mem_read(0x200032D4, 1) == b"\x00"
    print("  [PASS] Test 3: Stock USB FW Version Query @ 0x0000E8CE (executes real stock 0x151AC -> v1.0.0.0 + VID 2018 + stamps 'DP01')")

    # -------------------------------------------------------------------------
    # TEST 4: Stock Bootloader Entry Command (feat[3]=0x01, feat[6]=0xB0) via 0x0000E8CE
    # -------------------------------------------------------------------------
    sim_state["reset_called"] = False
    mu.mem_write(0x2003FFFC, struct.pack("<I", 0))
    bl_req = bytearray(64)  # official updater packet (SetBLDeviceMode): command 0x00, mode 0xB0
    bl_req[3] = 0x01
    bl_req[4] = 0x00
    bl_req[5] = 0x00
    bl_req[6] = 0xB0
    mu.mem_write(0x20004F28, bytes(bl_req))
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    magic = struct.unpack("<I", mu.mem_read(0x2003FFFC, 4))[0]
    assert sim_state["reset_called"] and magic == 0xA55AA55A
    print("  [PASS] Test 4: Stock Bootloader Re-Entry (feat[3]=0x01, feat[6]=0xB0 -> executes real stock 0x1484C -> 0xA55AA55A)")

    # -------------------------------------------------------------------------
    # TEST 5: OpenDDPIv1 GET_CAPABILITIES via 0x0000E8CE
    # -------------------------------------------------------------------------
    def crc16_ccitt(data: bytes) -> int:
        crc = 0xFFFF
        for b in data:
            crc ^= b << 8
            for _ in range(8):
                if crc & 0x8000:
                    crc = ((crc << 1) ^ 0x1021) & 0xFFFF
                else:
                    crc = (crc << 1) & 0xFFFF
        return crc

    def make_ddpi_req(opcode: int, payload: bytes = b"") -> bytes:
        pkt = bytearray(64)
        pkt[0:2] = b"DP"
        pkt[2] = 0x01  # DDPI_PROFILE_VERSION
        pkt[4] = 0x42  # seq
        pkt[5] = 0xDF  # DDPI_HID_NAMESPACE
        pkt[6] = opcode
        pkt[8 : 8 + len(payload)] = payload
        struct.pack_into("<H", pkt, 62, crc16_ccitt(bytes(pkt[:62])))
        return bytes(pkt)

    cap_req = make_ddpi_req(0x01)  # DDPI_CMD_GET_CAPABILITIES
    mu.mem_write(0x20004F28, cap_req)
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    cap_resp = bytes(mu.mem_read(0x20006000, 64))
    assert cap_resp[0:2] == b"DP" and cap_resp[3] == 0xA1 and cap_resp[5] == 0xDF and cap_resp[6] == 0x01
    assert cap_resp[8:12] == b"DP01"
    assert struct.unpack_from("<H", cap_resp, 62)[0] == crc16_ccitt(cap_resp[:62])
    print("  [PASS] Test 5: OpenDDPIv1 GET_CAPABILITIES @ 0x0000E8CE (returns 'DP', status=0xA1, magic='DP01', valid CRC16)")

    # -------------------------------------------------------------------------
    # TEST 6: OpenDDPIv1 SET_PROFILE + SAVE_FLASH via 0x0000E8CE
    # -------------------------------------------------------------------------
    # Configure asymmetric profile: East=1.00x (256), South=1.00x (256), West=1.00x (256), North=0.50x (128)
    # Note: In HID screen coords (+Y Down), North is -Y = 270 deg = octant 6!
    octants = [256, 256, 256, 256, 256, 256, 128, 256]
    prof_body = struct.pack(
        "<HBBHH8HH",
        0x4450,  # DDPI_PROFILE_MAGIC ('P','D' LE)
        1,       # version
        0x01,    # flags = ENABLED
        800,     # base_dpi
        256,     # global_gain = 1.0x
        *octants,
        0,       # reserved
    )
    prof_bytes = prof_body + struct.pack("<H", crc16_ccitt(prof_body))
    set_req = make_ddpi_req(0x03, prof_bytes)  # DDPI_CMD_SET_PROFILE
    mu.mem_write(0x20004F28, set_req)
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    set_resp = bytes(mu.mem_read(0x20006000, 64))
    assert set_resp[0:2] == b"DP" and set_resp[3] == 0xA1, f"SET_PROFILE failed with status 0x{set_resp[3]:02X}"

    # Save profile to Flash 0x0007E000 via DDPI_CMD_SAVE_FLASH (0x04)
    save_req = make_ddpi_req(0x04)  # DDPI_CMD_SAVE_FLASH
    mu.mem_write(0x20004F28, save_req)
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    save_resp = bytes(mu.mem_read(0x20006000, 64))
    assert save_resp[0:2] == b"DP" and save_resp[3] == 0xA1
    flash_stored = bytes(mu.mem_read(0x0007E000, 28))
    assert flash_stored == prof_bytes
    assert sim_state["erase_calls"] == 1

    # An identical second save must not erase the page again (flash wear)
    mu.mem_write(0x20004F28, save_req)
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    save_resp = bytes(mu.mem_read(0x20006000, 64))
    assert save_resp[0:2] == b"DP" and save_resp[3] == 0xA1
    assert sim_state["erase_calls"] == 1, "identical SAVE_FLASH erased 0x7E000 again"
    print("  [PASS] Test 6: OpenDDPIv1 SET_PROFILE & SAVE_FLASH @ 0x0000E8CE (persisted to Flash 0x0007E000; identical save skips the erase)")

    # -------------------------------------------------------------------------
    # TEST 7: Sensor Motion Burst Hook @ 0x000131D8 & 0x00013278
    # -------------------------------------------------------------------------
    # Pure North (dx=0, dy=-100 -> octant 6 = 128 = 0.50x -> dy becomes -50)
    sim_state["sim_motion"] = 0x80
    sim_state["sim_dx"] = 0
    sim_state["sim_dy"] = -100
    call_bl_site_at(0x000131D8)
    out_dx, out_dy = struct.unpack("<hh", mu.mem_read(0x2000302E, 4))
    assert out_dx == 0 and out_dy == -50, f"Expected (0, -50), got ({out_dx}, {out_dy})"

    # Test pure East (dx=100, dy=0 -> octant 0 = 256 = 1.00x -> dx=100, dy=0) via second call site 0x00013278
    sim_state["sim_dx"] = 100
    sim_state["sim_dy"] = 0
    call_bl_site_at(0x00013278)
    out_dx, out_dy = struct.unpack("<hh", mu.mem_read(0x2000302E, 4))
    assert out_dx == 100 and out_dy == 0, f"Expected (100, 0), got ({out_dx}, {out_dy})"
    print("  [PASS] Test 7: PAW3370 Motion Burst Hooks @ 0x000131D8 & 0x00013278 (East 100->100, North -100->-50)")

    # -------------------------------------------------------------------------
    # TEST 8: Request relayed through the 2.4 GHz receiver (wireless mode)
    # -------------------------------------------------------------------------
    # Receiver envelope: feat[0] = 0xA0 (receiver "busy"), feat[2] = 0x02 (target: mouse),
    # feat[3] = 0x3A (forward 64 bytes); the CRC covers the canonical packet.
    RF_CTRL = 0x2000361C
    mu.mem_write(0x20003003, b"\x01")  # wireless mode
    mu.mem_write(0x200035DE, b"\x00")  # USB not configured
    relayed = bytearray(make_ddpi_req(0x01))
    relayed[0], relayed[2], relayed[3] = 0xA0, 0x02, 0x3A
    mu.mem_write(0x20004F28, bytes(relayed))
    mu.mem_write(0x200032D4, b"\x01")
    mu.mem_write(RF_CTRL + 0x0F, b"\x00")
    call_bl_site_at(0x0000E8CE)
    rf_resp = bytes(mu.mem_read(0x20004F28, 64))
    assert rf_resp[0:2] == b"DP" and rf_resp[3] == 0xA1 and rf_resp[6] == 0x01 and rf_resp[8:12] == b"DP01", rf_resp[:16].hex()
    assert struct.unpack_from("<H", rf_resp, 62)[0] == crc16_ccitt(rf_resp[:62])
    assert mu.mem_read(RF_CTRL + 0x0F, 1) == b"\x01", "reply not queued for the radio"
    print("  [PASS] Test 8: Relayed request (feat[0]=0xA0, feat[2]=0x02, feat[3]=0x3A) answered and queued for 2.4 GHz")

    # -------------------------------------------------------------------------
    # TEST 9: 2.4 GHz reply length capped at 64 bytes in stock 0x15D74
    # -------------------------------------------------------------------------
    TXAGG = 0x20007744

    def drain_rf_reply(max_polls: int = 64) -> list:
        chunks = []
        for _ in range(max_polls):
            if mu.mem_read(RF_CTRL + 0x0F, 1) == b"\x00":
                break
            mu.mem_write(RF_CTRL + 0x10, b"\x00")  # tick delay elapsed
            mu.mem_write(RF_CTRL + 0x13, b"\x01")  # a downlink packet arrived
            call_thumb_at(0x00015D74)
            n = mu.mem_read(TXAGG, 1)[0]
            if n:
                chunks.append(bytes(mu.mem_read(TXAGG + 1, n)))
                mu.mem_write(TXAGG, b"\x00" * 65)
                mu.mem_write(RF_CTRL + 0x0B, b"\x00")
        return chunks

    for status, expected_chunks in ((0xA1, 8), (0xA4, 8), (0x03, 2)):
        resp = bytearray(range(0x80, 0xC0))
        resp[3] = status
        mu.mem_write(0x20004F28, bytes(resp))
        mu.mem_write(RF_CTRL + 0x0F, b"\x01")
        mu.mem_write(RF_CTRL + 0x12, b"\x00")
        chunks = drain_rf_reply()
        assert len(chunks) == expected_chunks, f"feat[3]=0x{status:02X}: {len(chunks)} chunks"
        assert b"".join(c[1:] for c in chunks) == bytes(resp[: 8 * expected_chunks])
        assert [c[0] >> 7 for c in chunks] == [1] * (expected_chunks - 1) + [0], "last chunk must end the reply"
    print("  [PASS] Test 9: 2.4 GHz reply capped at 64 bytes (status 0xA1/0xA4 -> 8 chunks; stock version reply -> 2)")

    # -------------------------------------------------------------------------
    # TEST 10: Idle reset of the direction estimator, clocked by burst calls (1 per ms tick)
    # -------------------------------------------------------------------------
    # Travel window L = 16, idle 50 ms (default). East flick, k motion-free calls at the
    # 0x13278 tick site, then one small North sample. Motion 50 calls after the last East
    # sample (k = 49) starts fresh: pure North, 0.50x. At k = 48 the East window still wins: 1.00x.
    mu.mem_write(0x20003003, b"\x02")  # back to wired mode
    mu.mem_write(0x200035DE, b"\x00")
    prof_body = struct.pack("<HBBHH8HH", 0x4450, 1, 0x01, 800, 256, *octants, 16)
    mu.mem_write(0x20004F28, make_ddpi_req(0x03, prof_body + struct.pack("<H", crc16_ccitt(prof_body))))
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    assert mu.mem_read(0x20006000, 4)[3] == 0xA1, "SET_PROFILE (L=16) failed"

    def burst(motion: int, dx: int = 0, dy: int = 0) -> tuple:
        sim_state["sim_motion"], sim_state["sim_dx"], sim_state["sim_dy"] = motion, dx, dy
        call_bl_site_at(0x00013278)
        return struct.unpack("<hh", mu.mem_read(0x2000302E, 4))

    for idle_calls, expected_dy in ((49, -4), (48, -8)):
        for _ in range(4):
            burst(0x80, 20, 0)
        for _ in range(idle_calls):
            burst(0x00)
        out = burst(0x80, 0, -8)
        assert out == (0, expected_dy), f"{idle_calls} idle calls: North -8 -> {out}, expected (0, {expected_dy})"

    def caps() -> bytes:
        mu.mem_write(0x20004F28, make_ddpi_req(0x01))
        mu.mem_write(0x200032D4, b"\x01")
        call_bl_site_at(0x0000E8CE)
        r = bytes(mu.mem_read(0x20006000, 64))
        assert r[3] == 0xA1, "GET_CAPABILITIES failed"
        return r

    def caps_clock() -> int:
        r = caps()
        assert r[15] & 0x80, "GET_CAPABILITIES must report the clock (flag bit 7)"
        return struct.unpack_from("<I", r, 28)[0]

    c0 = caps_clock()
    for _ in range(25):
        burst(0x00)
    assert caps_clock() - c0 == 25, "the reported clock must count burst calls"
    print("  [PASS] Test 10: Idle reset after 50 burst calls (North -8 -> -4 after 49 idle calls; -8 after 48, still East; GET_CAPABILITIES clock = burst calls)")

    # -------------------------------------------------------------------------
    # TEST 11: DPI shift held: the sensor DPI writer hook at 0x00017864 records it
    # -------------------------------------------------------------------------
    # Factory config (flash 0x1A3B8) in RAM, active DPI 1200, button 3 (layer 0) = DPI shift to 400.
    # The real stock button path 0x14244 -> 0xA450 -> 0x17860 programs the sensor; 0x20003068 stays 1200.
    mu.mem_write(0x20003003, b"\x02")  # wired mode
    cfg = bytes(mu.mem_read(0x0001A3B8, 0x266))
    mu.mem_write(0x200038C8, cfg)
    mu.mem_write(0x20004CE4, cfg[0x2F : 0x2F + 27])
    mu.mem_write(0x20004B30, cfg[0x5C:0xD4])
    mu.mem_write(0x20003068, struct.pack("<H", 1200))
    mu.mem_write(0x20004B30 + 15 * 3 + 1, bytes.fromhex("07010501900190"))
    prof_body = struct.pack("<HBBHH8HH", 0x4450, 1, 0x81, 1200, 256, *octants, 0)  # ENABLED | ONLY_AT_BASE_DPI
    mu.mem_write(0x20004F28, make_ddpi_req(0x03, prof_body + struct.pack("<H", crc16_ccitt(prof_body))))
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    assert mu.mem_read(0x20006000, 4)[3] == 0xA1, "SET_PROFILE (ONLY_AT_BASE_DPI, 1200) failed"

    for pressed, dpi_reg, dpi, expected in ((1, 0x07, 400, (0, -100)), (0, 0x17, 1200, (0, -50))):
        sim_state["spi"] = []
        mu.reg_write(UC_ARM_REG_R0, pressed)
        mu.reg_write(UC_ARM_REG_R1, 3)
        call_thumb_at(0x00014244)
        assert sim_state["spi"] == [(0x4D, 0x50), (0x4E, dpi_reg), (0x56, 0x04), (0x5A, 0x10)], sim_state["spi"]
        assert struct.unpack("<H", mu.mem_read(0x20003068, 2))[0] == 1200, "DPI shift must not change 0x20003068"
        out = burst(0x80, 0, -100)  # before caps(): the burst wrapper must pick up the new DPI by itself
        assert out == expected, f"pressed={pressed}: North -100 -> {out}, expected {expected}"
        assert struct.unpack_from("<H", caps(), 26)[0] == dpi, "GET_CAPABILITIES sensor_dpi"
    print("  [PASS] Test 11: DPI shift via stock 0x14244 (press: sensor 400, curve off; release: 1200, North -100 -> -50; 0x20003068 stays 1200)")

    print("[UNICORN] All 11 instruction-level Cortex-M4F hardware emulation tests PASSED!")


def main() -> None:
    if sys.flags.optimize:
        sys.exit("run without -O / PYTHONOPTIMIZE: the checks are assert statements")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stock-hex", type=Path, help="official CM2856_Mouse_USB_v1.00.00_20220810.hex or a dump .hex "
                    "of a mouse on stock v1.0.0.0 (compx_usb_flasher.py dump), instead of adapters/stock/*.bin")
    args = ap.parse_args()

    missing = [t for t in (ARM_GCC, ARM_OBJCOPY, ARM_NM, ARM_OBJDUMP) if shutil.which(t) is None]
    if missing:
        sys.exit(f"ARM toolchain not found: {', '.join(missing)}. Install arm-none-eabi-gcc "
                 "(e.g. apt install gcc-arm-none-eabi) or set CROSS=/path/to/bin/arm-none-eabi-")
    try:
        import unicorn  # noqa: F401
    except ImportError:
        sys.exit("unicorn not installed (pip install unicorn): the emulation tests are required")

    # A failed run must not leave a flashable image, old or new: write only after every check passed
    out_bin_path = BUILD_DIR / "CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.bin"
    out_hex_path = BUILD_DIR / "CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex"
    out_json_path = BUILD_DIR / "OpenDDPIv1-patch.json"
    for path in (out_bin_path, out_hex_path, out_json_path):
        path.unlink(missing_ok=True)
    stock = load_stock_image(args.stock_hex)
    info = build_patch(stock)
    run_unicorn_verification(info["full_bin"], info["symbols"])
    patch_json = json.dumps(make_patch_file(stock, info["full_bin"], info["sites"]), indent=1) + "\n"
    for path, data in ((out_bin_path, info["full_bin"]), (out_hex_path, info["hex_text"].encode("ascii")),
                       (out_json_path, patch_json.encode("ascii"))):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)  # never a half-written .hex under the final name
    print(f"[BUILD] Wrote {out_bin_path}, {out_hex_path.name} and {out_json_path.name} (patch bytes only, for apply_patch.py)")


if __name__ == "__main__":
    main()
