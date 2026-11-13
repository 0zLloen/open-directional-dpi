#!/usr/bin/env python3
"""
Load, save and export Open Directional DPI profiles on a mouse (Linux hidraw, standard library only).

  info                     device, firmware, current DPI and the active profile
  load PROFILE.json [--save]  send a profile (calibrate.html / OpenMouse JSON); --save keeps it after power-off
  export PROFILE.json      write the active profile as JSON ("-" = stdout)
  reset [--save]           back to the flat default (1.00x everywhere)
  encode PROFILE.json      offline: print the 28-byte profile the JSON becomes (hex)
  decode HEX               offline: print the JSON for a 28-byte profile

Devices: a Glorious Series One Pro running the open-directional-dpi patch (wired, 258a:2018; detected by
the DP01 stamp in its firmware-version reply, nothing else is sent to stock firmware), or any device
whose USB product string contains "[OpenDDPIv1]". Use --device /dev/hidrawN to pick one explicitly.
Without --save, a loaded profile lasts until the mouse powers off.

The JSON mapping mirrors integrations/openmouse/src/directional-dpi.ts (exportProfileJson /
importProfileJson); integrations/openmouse/test checks both directions against it.
"""

import argparse
import fcntl
import json
import os
import struct
import sys
import time
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

MAGIC, VERSION, NAMESPACE = 0x4450, 1, 0xDF
Q_MIN, Q_MAX, DPI_MIN, DPI_MAX, WINDOW_MAX = 0x0010, 0x0400, 50, 65535, 128
F_ENABLED, F_KEEP_REM, F_LINEAR, F_CCW, F_2X2, F_RESET_REM, F_BYPASS, F_ONLY_BASE = (1 << i for i in range(8))
KEYS = ["E_0", "SE_45", "S_90", "SW_135", "W_180", "NW_225", "N_270", "NE_315"]  # HID clockwise
GET_CAPS, GET_PROFILE, SET_PROFILE, SAVE_FLASH, RESET_DEFAULTS = 0x01, 0x02, 0x03, 0x04, 0x05
STATUS = {0xA1: "ok", 0xA2: "CRC or format error", 0xA3: "unsupported", 0xA4: "out of range"}
GLORIOUS_WIRED = (0x258A, 0x2018)


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


# --- profile <-> JSON (same rules as importProfileJson / exportProfileJson) -------------------

def index_for(flags: int, direction: int) -> int:
    return (8 - direction) & 7 if flags & F_CCW else direction & 7


def encode(doc: dict) -> bytes:
    """open-directional-dpi-v1 JSON -> 28-byte profile. Raises ValueError with a readable reason."""
    if not isinstance(doc, dict) or doc.get("schema") != "open-directional-dpi-v1" or doc.get("version") != 1:
        raise ValueError("not an open-directional-dpi-v1 profile (schema/version)")

    def boolean(key):
        v = doc.get(key, False)
        if not isinstance(v, bool):
            raise ValueError(f'"{key}" must be true or false')
        return v

    def integer(key, lo, hi, default=None):
        v = doc.get(key, default)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or not lo <= v <= hi:
            raise ValueError(f'"{key}" must be an integer in {lo}..{hi}')
        return int(v)

    def one_of(key, allowed):
        v = doc.get(key, allowed[0])
        if v not in allowed:
            raise ValueError(f'"{key}" must be one of: {", ".join(allowed)}')
        return v

    def q8_8(v, what):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{what} must be a number in {Q_MIN / 256}..{Q_MAX / 256}")
        q = int(Decimal(float(v) * 256).to_integral_value(ROUND_HALF_UP))  # JS Math.round (v >= 0)
        if not Q_MIN <= q <= Q_MAX:
            raise ValueError(f"{what} must be a number in {Q_MIN / 256}..{Q_MAX / 256}")
        return q

    flags = ((F_ENABLED if boolean("enabled") else 0) | (F_KEEP_REM if boolean("keepRemainderOnReverse") else 0)
             | (F_LINEAR if boolean("linearOctantRatio") else 0)
             | (F_RESET_REM if boolean("resetRemainderOnReverse") else 0)
             | (F_CCW if one_of("frame", ["hid-cw", "odd-sensor-ccw"]) == "odd-sensor-ccw" else 0)
             | (F_2X2 if one_of("model", ["angular-gain", "linear-2x2"]) == "linear-2x2" else 0)
             | (F_ONLY_BASE if boolean("onlyAtBaseDpi") else 0))
    window = integer("windowCounts", 0, WINDOW_MAX, 0)
    idle = integer("idleResetMs", 0, 255 * 5, 0)
    if idle % 5:
        raise ValueError('"idleResetMs" must be a multiple of 5')
    dm = doc.get("directionalMultipliers")
    if not isinstance(dm, dict):
        raise ValueError('"directionalMultipliers" must be an object')
    mult = [0] * 8
    for d, key in enumerate(KEYS):
        mult[index_for(flags, d)] = q8_8(dm.get(key), f'"directionalMultipliers.{key}"')
    body = struct.pack("<HBBHH8HH", MAGIC, VERSION, flags, integer("baseDpi", DPI_MIN, DPI_MAX),
                       q8_8(doc.get("globalGain"), '"globalGain"'), *mult, ((idle // 5) << 8) | window)
    return body + struct.pack("<H", crc16(body))


def decode(raw: bytes) -> dict:
    """28-byte profile -> JSON document (raises ValueError on a bad header or CRC)."""
    if len(raw) < 28:
        raise ValueError(f"profile is {len(raw)} bytes, expected 28")
    magic, version, flags, base, gain, *rest = struct.unpack_from("<HBBHH8HHH", raw)
    mult, reserved, crc = rest[:8], rest[8], rest[9]
    if magic != MAGIC or version != VERSION:
        raise ValueError(f"unsupported profile header: magic=0x{magic:x} version={version}")
    if crc != crc16(raw[:26]):
        raise ValueError("profile CRC mismatch")

    def f(q):  # JS Number((q / 256).toFixed(4)): exact halves round up
        return float((Decimal(q) / 256).quantize(Decimal("0.0001"), ROUND_HALF_UP))

    return {
        "schema": "open-directional-dpi-v1",
        "version": 1,
        "enabled": bool(flags & F_ENABLED),
        "keepRemainderOnReverse": bool(flags & F_KEEP_REM),
        "linearOctantRatio": bool(flags & F_LINEAR),
        "resetRemainderOnReverse": bool(flags & F_RESET_REM),
        "frame": "odd-sensor-ccw" if flags & F_CCW else "hid-cw",
        "model": "linear-2x2" if flags & F_2X2 else "angular-gain",
        "windowCounts": min(WINDOW_MAX, reserved & 0xFF),
        "idleResetMs": ((reserved >> 8) & 0xFF) * 5,
        "onlyAtBaseDpi": bool(flags & F_ONLY_BASE),
        "baseDpi": base,
        "globalGain": f(gain),
        "directionalMultipliers": {key: f(mult[index_for(flags, d)]) for d, key in enumerate(KEYS)},
    }


# --- device -----------------------------------------------------------------------------------

def _ioc(nr: int) -> int:
    return (3 << 30) | (65 << 16) | (ord("H") << 8) | nr  # HIDIOCSFEATURE(65) / HIDIOCGFEATURE(65)


class Device:
    def __init__(self, path: str):
        self.path, self.fd, self.seq = path, os.open(path, os.O_RDWR), int(time.time()) & 0xFF

    def set(self, body: bytes):
        fcntl.ioctl(self.fd, _ioc(0x06), bytearray(b"\x00" + body.ljust(64, b"\x00")))

    def get(self) -> bytes:
        buf = bytearray(65)
        fcntl.ioctl(self.fd, _ioc(0x07), buf)
        return bytes(buf[1:])

    def has_dp01_stamp(self) -> bool:
        """Stock Glorious firmware-version query; the open-directional-dpi patch adds 'DP01' at bytes 16..19."""
        self.set(bytes([0, 0, 0, 0x06, 0x00, 0x81]))
        for _ in range(10):
            time.sleep(0.025)
            r = self.get()
            if r[0] == 0xA1 and r[5] == 0x81:
                return r[16:20] == b"DP01"
        return False

    def command(self, opcode: int, payload: bytes = b"") -> bytes:
        self.seq = (self.seq + 1) & 0xFF
        req = bytearray(64)
        req[0:3], req[4], req[5], req[6] = b"DP\x01", self.seq, NAMESPACE, opcode
        req[8:8 + len(payload)] = payload
        struct.pack_into("<H", req, 62, crc16(req[:62]))
        self.set(bytes(req))
        for _ in range(30):  # slow devices answer late; accept only our own answer
            time.sleep(0.010)
            r = self.get()
            if r[0:2] == b"DP" and r[4] == self.seq and r[6] == opcode and struct.unpack_from("<H", r, 62)[0] == crc16(r[:62]):
                if r[3] != 0xA1:
                    raise RuntimeError(f"opcode 0x{opcode:02X} failed: {STATUS.get(r[3], hex(r[3]))}")
                return r[8:]
        raise RuntimeError(f"no answer to opcode 0x{opcode:02X}")


def find_device(explicit: str | None) -> Device:
    if explicit:
        return Device(explicit)
    found = []
    for h in sorted(Path("/sys/class/hidraw").glob("hidraw*")):
        uevent = dict(l.split("=", 1) for l in (h / "device/uevent").read_text().splitlines() if "=" in l)
        _bus, vid, pid = (int(x, 16) for x in uevent.get("HID_ID", "0:0:0").split(":"))
        rdesc = (h / "device/report_descriptor").read_bytes()
        vendor_page = len(rdesc) >= 3 and rdesc[0] == 0x06 and rdesc[2] == 0xFF  # usage page 0xFFxx
        if vendor_page and ((vid, pid) == GLORIOUS_WIRED or "[OpenDDPIv1]" in uevent.get("HID_NAME", "")):
            found.append((f"/dev/{h.name}", (vid, pid) == GLORIOUS_WIRED))
    if not found:
        sys.exit("No supported device found. Connect the mouse by cable (configuration over the 2.4 GHz receiver "
                 "is not supported yet), check permissions on /dev/hidraw*, or pass --device.")
    if len(found) > 1:
        sys.exit("Several devices found, pick one with --device: " + ", ".join(p for p, _ in found))
    path, glorious = found[0]
    dev = Device(path)
    if glorious and not dev.has_dp01_stamp():
        sys.exit(f"{path}: Glorious Series One Pro on stock firmware (no DP01 stamp). Flash the "
                 "open-directional-dpi patch first (adapters/glorious-cm2856).")
    return dev


# --- commands ---------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--device", help="hidraw node, e.g. /dev/hidraw9")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    p = sub.add_parser("load"); p.add_argument("file"); p.add_argument("--save", action="store_true")
    p = sub.add_parser("export"); p.add_argument("file")
    p = sub.add_parser("reset"); p.add_argument("--save", action="store_true")
    p = sub.add_parser("encode"); p.add_argument("file")
    p = sub.add_parser("decode"); p.add_argument("hex")
    a = ap.parse_args()

    try:
        if a.cmd == "encode":
            print(encode(json.loads(Path(a.file).read_text() if a.file != "-" else sys.stdin.read())).hex())
            return 0
        if a.cmd == "decode":
            print(json.dumps(decode(bytes.fromhex(a.hex)), indent=2))
            return 0
        profile = encode(json.loads(Path(a.file).read_text())) if a.cmd == "load" else None
    except (ValueError, OSError) as e:
        sys.exit(f"Invalid profile: {e}")

    dev = find_device(a.device)
    if a.cmd == "info":
        caps = dev.command(GET_CAPS)
        dpi_min, dpi_max, _, _, _, _, sensor_dpi = struct.unpack_from("<HHHHBBH", caps, 8)
        print(f"device      : {dev.path} (protocol {caps[4]}, DPI {dpi_min}..{dpi_max})")
        print(f"current DPI : {sensor_dpi if sensor_dpi else 'not reported by this firmware'}")
        print(f"save to flash: {'yes' if caps[7] & 0x02 else 'no'}")
        print("profile     :", json.dumps(decode(dev.command(GET_PROFILE)), indent=2))
    elif a.cmd == "export":
        text = json.dumps(decode(dev.command(GET_PROFILE)), indent=2) + "\n"
        sys.stdout.write(text) if a.file == "-" else Path(a.file).write_text(text)
    elif a.cmd == "load":
        back = dev.command(SET_PROFILE, profile)[:28]
        if back != profile:
            print("note: the device adjusted the profile to its limits:", json.dumps(decode(back)), file=sys.stderr)
        print("loaded" + (", saving..." if a.save else " (until power-off; add --save to keep it)"))
    elif a.cmd == "reset":
        dev.command(RESET_DEFAULTS)
        print("reset to the flat default" + ("" if a.save else " (until power-off; add --save to keep it)"))
    if a.cmd in ("load", "reset") and a.save:
        dev.command(SAVE_FLASH)
        print("saved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
