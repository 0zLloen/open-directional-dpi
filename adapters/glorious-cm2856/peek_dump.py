#!/usr/bin/env python3
"""
Read memory from a mouse running a --debug-peek build (stock_ddpi_patch.c, DDPI_DEBUG_PEEK, opcode 0x7E).
Read-only: the opcode only copies memory into the reply. For reverse engineering what the bootloader's
VerifyByAddress refuses (0x0..0x5FFF and 0x4D800 up). Linux hidraw, cable or receiver (odd_profile.py's lookup).

  peek_dump.py read  ADDR LEN                  hex dump to stdout (ADDR/LEN accept 0x..)
  peek_dump.py dump  ADDR END OUT.bin          raw bytes ADDR..END-1 to OUT.bin (never overwritten)
  peek_dump.py words ADDR COUNT                aligned 32-bit reads, for the NVMC / ACL registers

The output is the unit's own flash: the bootloader is vendor code and the pages above 0x4D800 hold its
pairing ID. Keep it out of every repository (CONTRIBUTING.md, Never commit).
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import odd_profile  # noqa: E402

OPCODE, MAGIC, CHUNK = 0x7E, b"PEEK", 48


def peek(dev, addr: int, n: int) -> bytes:
    r = dev.command(OPCODE, MAGIC + struct.pack("<IB", addr, n))
    got_addr, got_n = struct.unpack_from("<IB", r, 0)
    if (got_addr, got_n) != (addr, n):
        raise RuntimeError(f"reply is for 0x{got_addr:08X}+{got_n}, asked 0x{addr:08X}+{n}")
    return bytes(r[5:5 + n])


def read_range(dev, addr: int, end: int, step: int = CHUNK) -> bytes:
    out = bytearray()
    for a in range(addr, end, step):
        out += peek(dev, a, min(step, end - a))
        if (a - addr) % 0x10000 < step and a != addr:
            print(f"  0x{a:08X}", file=sys.stderr)
    return bytes(out)


def main() -> int:
    num = lambda s: int(s, 0)  # noqa: E731
    cmd, args = sys.argv[1], sys.argv[2:]
    dev = odd_profile.find_device(None)
    if cmd == "read":
        addr, n = map(num, args)
        data = read_range(dev, addr, addr + n)
        for i in range(0, len(data), 16):
            print(f"{addr + i:08X}  {data[i:i + 16].hex(' ')}")
    elif cmd == "words":
        addr, count = map(num, args)
        data = read_range(dev, addr, addr + 4 * count, 4)
        for i in range(count):
            print(f"{addr + 4 * i:08X}  {struct.unpack_from('<I', data, 4 * i)[0]:08X}")
    elif cmd == "dump":
        addr, end, out = num(args[0]), num(args[1]), Path(args[2])
        if out.exists():
            sys.exit(f"{out} exists; refusing to overwrite")
        data = read_range(dev, addr, end)
        out.write_bytes(data)
        print(f"{out}: 0x{addr:08X}..0x{end - 1:08X}, {len(data)} bytes")
    else:
        sys.exit(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
