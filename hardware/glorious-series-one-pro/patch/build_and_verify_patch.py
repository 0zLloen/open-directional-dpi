#!/usr/bin/env python3
"""
Build & Unicorn ARM Cortex-M4F Hardware Emulator Verification for
Glorious Forge Series One Pro — Surgical OpenDDPIv1 Firmware Extension.

1. Compiles stock_ddpi_patch.c + core/directional_dpi.c at 0x0001CD00 using
   arm-none-eabi-gcc (-mcpu=cortex-m4 -mthumb -Os -ffreestanding -nostdlib).
2. Appends the compiled extension to the official CM2856_Mouse_USB_v1.00.00_20220810.bin
   and redirects the 4 call-sites (0x0000E874, 0x0000E8CE, 0x000131D8, 0x00013278).
3. Generates CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.bin and .hex, and verifies the image
   against Compx bootloader constraints via compx_hex_tool.py.
4. Loads the complete patched ARM Cortex-M4F firmware image into the Unicorn CPU
   emulator and executes comprehensive instruction-level hardware verification tests
   before any physical hardware interaction.
"""

import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PATCH_DIR = Path(__file__).resolve().parent
STOCK_DIR = PATCH_DIR.parent / "stock"
BUILD_DIR = PATCH_DIR.parent / "build"
TOOLS_DIR = PATCH_DIR.parent / "tools"
CORE_DIR = REPO_ROOT / "core"

ARM_GCC = shutil.which("arm-none-eabi-gcc") or "/tmp/arm-root/usr/bin/arm-none-eabi-gcc"
ARM_OBJCOPY = shutil.which("arm-none-eabi-objcopy") or "/tmp/arm-root/usr/bin/arm-none-eabi-objcopy"
ARM_NM = shutil.which("arm-none-eabi-nm") or "/tmp/arm-root/usr/bin/arm-none-eabi-nm"
ARM_OBJDUMP = shutil.which("arm-none-eabi-objdump") or "/tmp/arm-root/usr/bin/arm-none-eabi-objdump"

APP_BASE = 0x00006000
PATCH_BASE = 0x0001CD00


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


def build_patch() -> dict:
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

    stock_bin_path = STOCK_DIR / "CM2856_Mouse_USB_v1.00.00_20220810.bin"
    stock_bin = bytearray(stock_bin_path.read_bytes())
    assert len(stock_bin) == 0x0001CC90 - APP_BASE, f"Unexpected stock bin length: {len(stock_bin)}"

    # Pad from 0x0001CC90 to 0x0001CD00 with 0xFF (erased flash)
    pad_len = PATCH_BASE - (APP_BASE + len(stock_bin))
    assert pad_len == 0x70
    full_bin = bytearray(stock_bin) + bytearray(b"\xFF" * pad_len) + bytearray(patch_bytes)

    # Align total size to 32-byte Compx Program chunk boundary with 0xFF padding
    if len(full_bin) % 32 != 0:
        full_bin += bytearray(b"\xFF" * (32 - (len(full_bin) % 32)))

    # Verify and patch the 4 BL hooks
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
        print(f"        Patched {label:<20} @ 0x{call_addr:08X}: 0x{orig_target:08X} -> 0x{new_target:08X} ({encoded.hex()})")

    out_bin_path = BUILD_DIR / "CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.bin"
    out_hex_path = BUILD_DIR / "CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.hex"
    out_bin_path.write_bytes(full_bin)

    # Convert to Intel HEX and run compx_hex_tool.py verification
    sys.path.insert(0, str(TOOLS_DIR))
    import compx_hex_tool

    hex_text = compx_hex_tool.encode_compx_hex(bytes(full_bin), base_addr=APP_BASE)
    out_hex_path.write_text(hex_text, encoding="ascii")
    res = compx_hex_tool.audit_binary_safety(bytes(full_bin), base_addr=APP_BASE)
    assert res["all_passed"], f"compx_hex_tool validation failed: {res}"
    print(
        f"[BUILD] Created {out_hex_path.name} ({len(full_bin)} bytes, "
        f"0x{APP_BASE:08X}..0x{APP_BASE + len(full_bin) - 1:08X}, SHA256={res['sha256'][:16]}...)"
    )

    return {
        "full_bin": bytes(full_bin),
        "symbols": symbols,
        "out_bin_path": out_bin_path,
        "out_hex_path": out_hex_path,
    }


def run_unicorn_verification(full_bin: bytes, symbols: dict) -> None:
    try:
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
    except ImportError:
        print("[UNICORN] Unicorn module not installed; skipping emulation.")
        return

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
        "sim_motion": 0,
        "sim_dx": 0,
        "sim_dy": 0,
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
    assert usb_resp[0] == 0xA1 and usb_resp[6:12] == bytes([1, 0, 0, 0, 0x20, 0x18]) and usb_resp[16:20] == b"DP01", (
        f"Unexpected usb_resp: {usb_resp[:24].hex()}"
    )
    assert usb_get_buf == usb_resp
    assert mu.mem_read(0x200032D4, 1) == b"\x00"
    print("  [PASS] Test 3: Stock USB FW Version Query @ 0x0000E8CE (executes real stock 0x151AC -> v1.0.0.0 + VID 2018 + stamps 'DP01')")

    # -------------------------------------------------------------------------
    # TEST 4: Stock Bootloader Entry Command (feat[4]=0x00, feat[5]=0x00, feat[6]=0xB0) via 0x0000E8CE
    # -------------------------------------------------------------------------
    sim_state["reset_called"] = False
    mu.mem_write(0x2003FFFC, struct.pack("<I", 0))
    bl_req = bytearray(64)
    bl_req[3] = 0x02
    bl_req[4] = 0x00
    bl_req[5] = 0x00
    bl_req[6] = 0xB0
    mu.mem_write(0x20004F28, bytes(bl_req))
    mu.mem_write(0x200032D4, b"\x01")
    call_bl_site_at(0x0000E8CE)
    magic = struct.unpack("<I", mu.mem_read(0x2003FFFC, 4))[0]
    assert sim_state["reset_called"] and magic == 0xA55AA55A
    print("  [PASS] Test 4: Stock Bootloader Re-Entry (0x00, 0x00, 0xB0 -> executes real stock 0x1484C -> 0xA55AA55A)")

    # -------------------------------------------------------------------------
    # TEST 5: OpenDDPIv1 GET_CAPABILITIES & SET_PROFILE + SAVE_FLASH via 0x0000E8CE
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
    print("  [PASS] Test 6: OpenDDPIv1 SET_PROFILE & SAVE_FLASH @ 0x0000E8CE (persisted to Flash 0x0007E000)")

    # -------------------------------------------------------------------------
    # TEST 7: Sensor Motion Burst Hook @ 0x000131D8 & 0x00013278
    # -------------------------------------------------------------------------
    sim_state["sim_motion"] = 0x80
    sim_state["sim_dx"] = 100
    sim_state["sim_dy"] = -100  # 45 deg North-East (octant 1 = 1.0x -> Wait: octants=[256, 256, 128...])
    # Wait: let's test pure North (dx=0, dy=-100 -> octant 2 = 128 = 0.50x -> dy should become -50!)
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

    print("[UNICORN] All 7 instruction-level Cortex-M4F hardware emulation tests PASSED!")


if __name__ == "__main__":
    info = build_patch()
    run_unicorn_verification(info["full_bin"], info["symbols"])
