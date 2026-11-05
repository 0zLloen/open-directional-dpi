#!/usr/bin/env python3
"""
Compx nRF52840 Firmware Image Tool (Offline Decoder / Encoder / Safety Validator)
For Glorious Forge Series One Pro Wireless (CM2852-BAMF / CM2856)

Features:
  - Decodes official Compx XOR-0x55 obfuscated Intel HEX (.hex) to raw ARM binary (.bin)
  - Encodes raw ARM binary (.bin) at 0x00006000 into Compx XOR-0x55 Intel HEX (.hex)
  - Audits firmware safety constraints before any hardware installation:
      1. Flash range strictly within [0x00006000 .. 0x0007DFFF] (never touches
         Compx Bootloader at 0x00000000..0x00005FFF or stock RF pairing at 0x00088000+)
      2. Valid ARM Cortex-M4F Vector Table (Initial SP in 0x20000000..0x2003FFF0,
         Thumb-2 Reset_Handler inside image bounds)
      3. Presence of Compx Bootloader re-entry magic (0xA55AA55A and 0x2003FFFC)
"""

import argparse
import hashlib
import struct
import sys
from pathlib import Path

USB_WIRE_XOR_KEY = 0x55
HEX_FILE_XOR_KEY = 0x00
MOUSE_APP_BASE = 0x00006000
MOUSE_SAFE_LIMIT = 0x0007E000
BOOTLOADER_MAGIC_RAM = 0x2003FFFC
BOOTLOADER_MAGIC_VAL = 0xA55AA55A


def parse_compx_hex(hex_path: Path, xor_key: int = HEX_FILE_XOR_KEY):
    """Parse an Intel HEX file where type-00 data bytes are XORed with xor_key."""
    ext_addr = 0
    min_addr = None
    max_addr = 0
    sla_entry = None
    mem = {}
    line_count = 0

    with hex_path.open("r", encoding="ascii", errors="ignore") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or not line.startswith(":"):
                continue
            line_count += 1
            raw = bytes.fromhex(line[1:])
            byte_count = raw[0]
            addr16 = (raw[1] << 8) | raw[2]
            rec_type = raw[3]
            data = raw[4 : 4 + byte_count]
            checksum = raw[4 + byte_count]

            if (sum(raw[:-1]) + checksum) & 0xFF != 0:
                raise ValueError(f"Intel HEX checksum mismatch on line {line_count}")

            if rec_type == 0x00:  # Data
                abs_addr = ext_addr + addr16
                if min_addr is None or abs_addr < min_addr:
                    min_addr = abs_addr
                if abs_addr + byte_count > max_addr:
                    max_addr = abs_addr + byte_count
                for i, b in enumerate(data):
                    mem[abs_addr + i] = b ^ xor_key
            elif rec_type == 0x01:  # EOF
                break
            elif rec_type == 0x04:  # Extended Linear Address
                ext_addr = ((data[0] << 8) | data[1]) << 16
            elif rec_type == 0x05:  # Start Linear Address
                sla_entry = struct.unpack(">I", data)[0]

    if min_addr is None:
        raise ValueError("No data records found in Intel HEX file")

    size = max_addr - min_addr
    out = bytearray(b"\xFF" * size)
    for addr, val in mem.items():
        out[addr - min_addr] = val

    return bytes(out), min_addr, max_addr, sla_entry, line_count


def encode_compx_hex(
    bin_data: bytes,
    base_addr: int = MOUSE_APP_BASE,
    sla_entry: int = None,
    xor_key: int = HEX_FILE_XOR_KEY,
) -> str:
    """Encode a raw ARM binary into standard Intel HEX format for FirmwareUpdate.exe."""
    lines = []

    def make_record(addr16: int, rec_type: int, payload: bytes) -> str:
        header = bytes([len(payload), (addr16 >> 8) & 0xFF, addr16 & 0xFF, rec_type])
        body = header + payload
        csum = (-sum(body)) & 0xFF
        return ":" + body.hex().upper() + f"{csum:02X}"

    current_upper = None
    for offset in range(0, len(bin_data), 16):
        abs_addr = base_addr + offset
        upper = (abs_addr >> 16) & 0xFFFF
        if upper != current_upper:
            current_upper = upper
            lines.append(make_record(0x0000, 0x04, struct.pack(">H", upper)))
        chunk = bytes(b ^ xor_key for b in bin_data[offset : offset + 16])
        lines.append(make_record(abs_addr & 0xFFFF, 0x00, chunk))

    if sla_entry is None and len(bin_data) >= 8:
        sla_entry = struct.unpack_from("<I", bin_data, 4)[0]
    if sla_entry is not None:
        lines.append(make_record(0x0000, 0x05, struct.pack(">I", sla_entry)))

    lines.append(":00000001FF")
    return "\r\n".join(lines) + "\r\n"


def audit_binary_safety(bin_data: bytes, base_addr: int = MOUSE_APP_BASE) -> dict:
    """Verify all safety invariants on an nRF52840 application image."""
    end_addr = base_addr + len(bin_data)
    sp_init, reset_handler = struct.unpack_from("<II", bin_data, 0)

    has_magic_val = struct.pack("<I", BOOTLOADER_MAGIC_VAL) in bin_data
    has_magic_ram = struct.pack("<I", BOOTLOADER_MAGIC_RAM) in bin_data

    checks = {
        "preserves_bootloader_0x0000_0x5FFF": base_addr >= MOUSE_APP_BASE,
        "preserves_pairing_and_profiles_0x88000": end_addr <= MOUSE_SAFE_LIMIT,
        "valid_initial_sp_in_sram": 0x20000000 <= sp_init <= 0x2003FFF0,
        "valid_thumb2_reset_handler": (
            (reset_handler & 1) == 1 and base_addr <= (reset_handler & ~1) < end_addr
        ),
        "contains_bootloader_reentry_magic_0xA55AA55A": has_magic_val,
        "contains_bootloader_reentry_sram_0x2003FFFC": has_magic_ram,
    }
    return {
        "base_addr": f"0x{base_addr:08X}",
        "end_addr": f"0x{end_addr:08X}",
        "size_bytes": len(bin_data),
        "initial_sp": f"0x{sp_init:08X}",
        "reset_handler": f"0x{reset_handler:08X}",
        "sha256": hashlib.sha256(bin_data).hexdigest(),
        "checks": checks,
        "all_passed": all(checks.values()),
    }


def main():
    parser = argparse.ArgumentParser(description="Compx XOR-0x55 Intel HEX Tool")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_audit = sub.add_parser("audit", help="Decode and safety-audit a Compx .hex file")
    p_audit.add_argument("hex_file", type=Path)

    p_roundtrip = sub.add_parser("selftest", help="Run roundtrip & safety audit on stock .hex")
    p_roundtrip.add_argument("hex_file", type=Path)

    args = parser.parse_args()

    if args.cmd in ("audit", "selftest"):
        bin_data, min_addr, max_addr, sla, lines = parse_compx_hex(args.hex_file)
        report = audit_binary_safety(bin_data, min_addr)
        print(f"File:          {args.hex_file}")
        print(f"HEX Records:   {lines}")
        print(f"Address Range: {report['base_addr']} .. {report['end_addr']} ({report['size_bytes']} bytes)")
        print(f"SLA Entry:     0x{sla:08X}" if sla else "SLA Entry:     None")
        print(f"Initial SP:    {report['initial_sp']}")
        print(f"Reset Handler: {report['reset_handler']}")
        print(f"Decoded SHA256:{report['sha256']}")
        print("Safety Checks:")
        for k, v in report["checks"].items():
            print(f"  [{'PASS' if v else 'FAIL'}] {k}")

        if args.cmd == "selftest":
            reencoded = encode_compx_hex(bin_data, min_addr, sla)
            tmp_path = Path("/tmp/compx_roundtrip_test.hex")
            tmp_path.write_text(reencoded, encoding="ascii")
            rt_bin, rt_min, rt_max, rt_sla, _ = parse_compx_hex(tmp_path)
            assert rt_bin == bin_data, "Roundtrip binary mismatch!"
            assert rt_min == min_addr and rt_max == max_addr and rt_sla == sla
            print("  [PASS] roundtrip_encode_decode_bit_exact")

        sys.exit(0 if report["all_passed"] else 1)


if __name__ == "__main__":
    main()
