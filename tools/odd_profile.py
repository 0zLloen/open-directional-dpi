#!/usr/bin/env python3
"""
Load, save and export Open Directional DPI profiles on a mouse (Linux: standard library only; Windows, macOS: hidapi).

  info                     device, firmware, current DPI and the active profile
  load PROFILE.json [--save]  send a profile (calibrate.html / OpenMouse JSON); --save keeps it after power-off
  export PROFILE.json      write the active profile as JSON ("-" = stdout)
  reset [--save]           back to the flat default (1.00x everywhere)
  encode PROFILE.json      offline: print the 28-byte profile the JSON becomes (hex)
  decode HEX               offline: print the JSON for a 28-byte profile

Devices: a Glorious Series One Pro running the open-directional-dpi patch, by cable (258a:2018) or
through its 2.4 GHz receiver (258a:2031), detected by the DP01 stamp in its firmware-version reply
(nothing else is sent to stock firmware); or any device whose USB product string contains
"[OpenDDPIv1]"; or, only when none of these is found or --device picks it, a QMK board with the
open-directional-dpi adapter, identified on its raw HID interface (usage page 0xFF60, usage 0x61) by the
GET_CAPABILITIES probe of spec/hid-protocol-v1.md 6.3 (a VIA or Vial board without the adapter answers 0xFF to
the first frame and gets nothing else; close the VIA and Vial apps first, they read the same interface).
The cable is used when both are connected; --device picks one of these (any other node is refused).
Without --save, a loaded profile lasts until the mouse powers off. On Linux it needs read/write access to the
hidraw node: install mouse-firmware-re devices/glorious-series-one-pro/udev/70-glorious-series-one-pro.rules
(cable, receiver and bootloader), or run as root.

Backends (--backend): hidraw (Linux default, standard library: feature-report ioctls, and write()/read() for QMK
raw HID) and hidapi (Windows and macOS default; pip install hidapi). On Linux --backend hidapi loads cython-hidapi's
hidraw module, never its libusb "hid" module, which detaches the kernel driver from the interface while it is open.

Through the receiver, requests carry the Compx relay envelope: body[2] = 0x02 (target: mouse) and
body[3] = 0x3A (forward 64 bytes); the CRC still covers the canonical packet (body[2] = 1, body[3] = 0).
Only patch builds that also stamp bytes 12..15 understand it, so older builds are never sent one.
Sequence numbers are always >= 5: stock firmware rejects such a packet before running any handler.
Before each relayed request the tool asks the receiver whether it has a link to the mouse (its own command 0x89); with
no link it asks you to move or click the mouse and waits up to 15 s, and a request that ends in a final 0xA4 is sent once
more (spec/hid-protocol-v1.md 2.3, "Link state and retries").

The JSON mapping mirrors integrations/openmouse/src/directional-dpi.ts (exportProfileJson /
importProfileJson); integrations/openmouse/test checks both directions against it.
"""

import argparse
import json
import os
import select
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
GLORIOUS_WIRED, GLORIOUS_RECEIVER = (0x258A, 0x2018), (0x258A, 0x2031)
FEATURE_USAGE, QMK_USAGE = (0xFFFF, 0x0000), (0xFF60, 0x61)  # spec 1 (Glorious interface 2), spec 6.1
QMK_RDESC = bytes.fromhex("0660ff0961a101")  # QMK raw HID report descriptor start (spec 6.1)
SYSFS = Path("/sys/class/hidraw")
LINK_POLL_S, LINK_WAIT_S = 0.1, 15  # receiver link query: repeat interval, then give up (spec 2.3)
WAIT_MSG = "Waiting for the mouse: move it or click a button (the receiver has no link to it)."
UNREACHABLE_MSG = ("The receiver cannot reach the mouse (switched off, asleep or out of range). Move or click it and try "
                   "again, or use the cable.")
UDEV_HINT = ("install mouse-firmware-re devices/glorious-series-one-pro/udev/70-glorious-series-one-pro.rules "
             "(cable, receiver and bootloader), or run as root.")


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


class Hidraw:
    """Linux hidraw node, standard library. Buffers carry report ID 0 in byte 0, except read(), which returns the
    unnumbered report alone."""

    def __init__(self, path: str):
        import fcntl  # Linux only

        self.ioctl, self.fd = fcntl.ioctl, os.open(path, os.O_RDWR)

    def set_feature(self, buf: bytes):
        self.ioctl(self.fd, _ioc(0x06), bytearray(buf))

    def get_feature(self) -> bytes:
        buf = bytearray(65)
        self.ioctl(self.fd, _ioc(0x07), buf)
        return bytes(buf[1:])

    def write(self, buf: bytes):
        os.write(self.fd, buf)

    def read(self, timeout: float) -> bytes:
        return os.read(self.fd, 64) if select.select([self.fd], [], [], timeout)[0] else b""


class Hidapi:
    """cython-hidapi device (pip install hidapi). hidapi keeps the report ID in byte 0 of feature reports both ways:
    65 bytes go out, and get_feature_report(0, 65) returns 65 with byte 0 = 0x00, which is dropped. Windows needs
    those full 65-byte buffers (report length + 1, even for an unnumbered report; hidapi documentation, not yet tried
    on Windows), so the same sizes are used on every platform. read() returns the input report without that byte."""

    def __init__(self, hid, path: str):
        self.dev = hid.device()
        try:
            self.dev.open_path(path.encode())
        except OSError:  # cython-hidapi raises "open failed"; the reason (access denied, ...) is in error()
            raise OSError(self.dev.error() or "open failed") from None

    def _check(self, n: int):
        if n < 0:  # cython-hidapi returns -1 from write() and send_feature_report() instead of raising
            raise OSError(self.dev.error() or "write failed")

    def set_feature(self, buf: bytes):
        self._check(self.dev.send_feature_report(buf))

    def get_feature(self) -> bytes:
        return bytes(self.dev.get_feature_report(0, 65)[1:]).ljust(64, b"\x00")  # 64 bytes, as hidraw

    def write(self, buf: bytes):
        self._check(self.dev.write(buf))

    def read(self, timeout: float) -> bytes:
        return bytes(self.dev.read(64, max(1, int(timeout * 1000))))


def load_hidapi():
    try:
        if sys.platform.startswith("linux"):
            import hidraw as hid  # cython-hidapi's hidraw backend; its "hid" module is libusb (see module docstring)
        else:
            import hid
    except ImportError:
        sys.exit("--backend hidapi needs cython-hidapi: pip install hidapi")
    if not hasattr(hid, "device"):
        sys.exit(f"{hid.__file__}: this hid module is not cython-hidapi. pip uninstall hid, then pip install hidapi.")
    return hid


class Device:
    def __init__(self, path: str, io, relay: bool = False, raw: bool = False):
        self.path, self.io, self.relay, self.raw, self.seq = path, io, relay, raw, int(time.time()) % 251

    def set(self, body: bytes):
        self.io.set_feature(b"\x00" + body.ljust(64, b"\x00"))

    def get(self) -> bytes:
        return self.io.get_feature()

    def has_dp01_stamp(self, resend: bool = True) -> bool:
        """Stock Glorious firmware-version query. The patch stamps 'DP01' at bytes 16..19 and, since it can
        relay over 2.4 GHz, also at 12..15 (only the first 16 bytes of this reply travel over the radio). The
        receiver copies back request body[3] + 6 bytes, so the relayed query asks for 16 (body[3] = 0x0A)."""
        if self.relay:
            self.wait_for_link()
        self.set(bytes([0, 0, 0x02, 0x0A, 0x00, 0x81] if self.relay else [0, 0, 0x00, 0x06, 0x00, 0x81]))
        r = self.poll(lambda r: r[0] == 0xA1 and r[5] == 0x81)
        if r[0] == 0xA1 and r[5] == 0x81:
            return r[12:16] == b"DP01" or (not self.relay and r[16:20] == b"DP01")
        return self.lost(r, resend) and self.has_dp01_stamp(False)

    def poll(self, ok, seconds: float = 2.0) -> bytes:
        """GET_REPORT until ok(reply) or the deadline; returns the last reply either way. Through the receiver,
        0xA4 (link down) can be transient: SAVE_FLASH's page erase stalls the mouse's radio, the receiver shows
        0xA4 after ~270 ms and the real reply still arrives (~770 ms on a retail mouse). So only a final 0xA4
        counts (see lost())."""
        deadline, r = time.monotonic() + seconds, b""
        while time.monotonic() < deadline:
            time.sleep(0.005)
            r = self.get()
            if ok(r):
                break
        return r

    def lost(self, r: bytes, resend: bool) -> bool:
        """r is the last reply to a request that got no answer. A final 0xA4 through the receiver: True = send it
        once more (spec 2.3); the second time the mouse counts as unreachable."""
        if not (self.relay and r[:1] == b"\xA4"):
            return False
        if not resend:
            sys.exit(f"{self.path}: {UNREACHABLE_MSG}")
        return True

    def link_up(self) -> bool:
        """The receiver's own link-state query 0x89 (spec 2.3): body[6] = 0x01 is linked, anything else no link.
        No answer within 2 s: unknown, taken as linked."""
        self.set(bytes([0, 0, 0, 0, 0, 0x89]))
        r = self.poll(lambda r: r[0] == 0xA1 and r[5] == 0x89)
        return r[0] != 0xA1 or r[5] != 0x89 or r[6] == 0x01

    def wait_for_link(self):
        """Without a link: ask once for the mouse to be moved or clicked, query again every LINK_POLL_S, and give up
        after LINK_WAIT_S without sending the request."""
        if self.link_up():
            return
        print(WAIT_MSG, file=sys.stderr)
        deadline = time.monotonic() + LINK_WAIT_S
        while time.monotonic() < deadline:
            time.sleep(LINK_POLL_S)
            if self.link_up():
                return
        sys.exit(f"{self.path}: {UNREACHABLE_MSG}")

    def frame(self, chunk: int, data: bytes, deadline: float) -> bytes:
        """QMK raw HID (spec 6.2): send one 32-byte frame and return the board's reply to it, the next input report
        with the same byte 1 and byte 0 = 0xDF. Byte 0 = 0xFF means the board does not know the command."""
        self.io.write(b"\x00" + bytes([NAMESPACE, chunk]) + bytes(data).ljust(30, b"\x00"))
        while (left := deadline - time.monotonic()) > 0:
            r = self.io.read(left)
            if r[1:2] == bytes([chunk]) and r[0] in (NAMESPACE, 0xFF):  # other reports belong to another program
                if r[0] == 0xFF:
                    raise RuntimeError("unsupported (raw HID answered 0xFF: no open-directional-dpi adapter)")
                return r
        raise RuntimeError(f"no reply to raw HID frame 0x{chunk:02X}")

    def command(self, opcode: int, payload: bytes = b"", resend: bool = True) -> bytes:
        self.seq = 5 + (self.seq - 4) % 251  # 5..255: stock firmware never runs a handler for these
        req = bytearray(64)
        req[0:3], req[4], req[5], req[6] = b"DP\x01", self.seq, NAMESPACE, opcode
        req[8:8 + len(payload)] = payload
        struct.pack_into("<H", req, 62, crc16(req[:62]))

        def ok(r):  # only our own answer (spec 3)
            return (len(r) == 64 and r[0:2] == b"DP" and 0xA1 <= r[3] <= 0xA4 and r[4] == self.seq and r[6] == opcode
                    and struct.unpack_from("<H", r, 62)[0] == crc16(r[:62]))

        if self.raw:  # write chunks 0..2, then read chunks 0..2, one reply each (spec 6.2)
            deadline = time.monotonic() + 2.0
            for i in range(3):
                self.frame(i, req[30 * i:30 * i + 30], deadline)
            r = b"".join(self.frame(0x80 | i, b"", deadline)[2:32] for i in range(3))[:64]
        else:
            if self.relay:
                self.wait_for_link()
                req[2], req[3] = 0x02, 0x3A  # relay envelope, outside the CRC (see module docstring)
            self.set(bytes(req))
            r = self.poll(ok)
        if not ok(r):
            if self.lost(r, resend):  # new seq and CRC; this tool sends neither SIMULATE_DELTA nor ENTER_BOOTLOADER
                return self.command(opcode, payload, False)
            raise RuntimeError(f"no answer to opcode 0x{opcode:02X}")
        if r[3] != 0xA1:
            raise RuntimeError(f"opcode 0x{opcode:02X} failed: {STATUS.get(r[3], hex(r[3]))}")
        return r[8:]

    def answers_probe(self) -> bool:
        """QMK raw HID identification (spec 6.3): GET_CAPABILITIES answered with status 0xA1 and "DP01"."""
        try:
            return self.command(GET_CAPS)[:4] == b"DP01"
        except RuntimeError:
            return False


def hidraw_nodes():
    """(path, (vid, pid), product string, kind) per hidraw node. kind: "qmk" for QMK's raw HID descriptor, "feature"
    for any other descriptor that starts with a vendor usage page 0xFFxx, else None."""
    for h in sorted(SYSFS.glob("hidraw*")):
        uevent = dict(l.split("=", 1) for l in (h / "device/uevent").read_text().splitlines() if "=" in l)
        _bus, vid, pid = (int(x, 16) for x in uevent.get("HID_ID", "0:0:0").split(":"))
        rdesc = (h / "device/report_descriptor").read_bytes()
        vendor_page = len(rdesc) >= 3 and rdesc[0] == 0x06 and rdesc[2] == 0xFF
        kind = "qmk" if rdesc.startswith(QMK_RDESC) else "feature" if vendor_page else None
        yield f"/dev/{h.name}", (vid, pid), uevent.get("HID_NAME", ""), kind


def hidapi_nodes(hid):
    """The same from hidapi, which lists each top-level collection. "feature" is usage page 0xFFFF, usage 0 (spec 1):
    on the Glorious mouse that is interface 2, the node hidraw picks. Its interface 1 also has vendor collections
    (0xFFA0 and 0xFFFF, usage 1), which Windows lists as devices of their own."""
    for d in hid.enumerate():
        usage = (d["usage_page"], d["usage"])
        kind = "qmk" if usage == QMK_USAGE else "feature" if usage == FEATURE_USAGE else None
        yield d["path"].decode(), (d["vendor_id"], d["product_id"]), d["product_string"] or "", kind


def find_device(explicit: str | None, backend: str = "hidraw") -> Device:
    """Only nodes that identify themselves (spec/hid-protocol-v1.md 2.2): a vendor usage page plus the Glorious IDs
    (then the DP01 stamp) or "[OpenDDPIv1]" in the product string; QMK raw HID interfaces only by the probe of 6.3,
    and only when there is no such node. --device only picks among them."""
    if backend == "hidapi":
        hid = load_hidapi()
        nodes, open_io = hidapi_nodes(hid), lambda path: Hidapi(hid, path)
    elif sys.platform.startswith("linux"):
        nodes, open_io = hidraw_nodes(), Hidraw
    else:
        sys.exit("hidraw is Linux only: use --backend hidapi (pip install hidapi).")
    nodes = [n for n in nodes if not explicit or n[0] in (explicit, "/dev/" + explicit)]
    found = [n for n in nodes if n[3] == "feature" and (n[1] in (GLORIOUS_WIRED, GLORIOUS_RECEIVER) or "[OpenDDPIv1]" in n[2])]
    qmk = [n[0] for n in nodes if n[3] == "qmk"]  # probed only if found is empty
    wired = [n for n in found if n[1] != GLORIOUS_RECEIVER]
    if not found and not qmk and explicit:
        sys.exit(f"{explicit}: not a supported device. It needs a vendor usage page and either the Glorious Series One "
                 "Pro IDs (258a:2018 cable, 258a:2031 receiver) or [OpenDDPIv1] in its USB product string, or QMK's "
                 "raw HID interface (usage page 0xFF60) with the open-directional-dpi adapter.")
    if len(wired) > 1 or (not wired and len(found) > 1):
        sys.exit("Several devices found, pick one with --device: " + ", ".join(n[0] for n in found))
    if found:
        path, ids = (wired or found)[0][:2]  # the cable wins over the receiver
        try:
            dev = Device(path, open_io(path), relay=ids == GLORIOUS_RECEIVER)
            if ids not in (GLORIOUS_WIRED, GLORIOUS_RECEIVER) or dev.has_dp01_stamp():
                return dev
        except PermissionError:
            sys.exit(f"{path}: permission denied. Needs read/write access to the hidraw node: " + UDEV_HINT)
        except OSError as e:
            sys.exit(f"{path}: cannot query it ({e.strerror or e}).")
        sys.exit(f"{path}: no DP01 stamp" + (" through the receiver" if dev.relay else "") + ": the mouse runs "
                 "stock firmware" + (" or a patch build without 2.4 GHz support" if dev.relay else "") +
                 ". Flash the current open-directional-dpi patch (adapters/glorious-cm2856).")
    probed, skipped = [], []
    for path in qmk:
        try:
            dev = Device(path, open_io(path), raw=True)
            if dev.answers_probe():
                probed.append(dev)
        except OSError as e:  # any keyboard: root-only without a udev rule, or held open by the VIA app
            if explicit:
                sys.exit(f"{path}: cannot query it ({e.strerror or e}).")
            skipped.append(path)
    if len(probed) > 1:
        sys.exit("Several devices found, pick one with --device: " + ", ".join(d.path for d in probed))
    if not probed and explicit:
        sys.exit(f"{explicit}: no Open Directional DPI answer on this raw HID interface (a QMK, VIA or Vial board "
                 "without the open-directional-dpi adapter).")
    if not probed:
        sys.exit("No supported device found. Connect the mouse by cable or plug in its receiver."
                 + (f" Raw HID interfaces that did not open: {', '.join(skipped)}." if skipped else ""))
    return probed[0]


# --- commands ---------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--device", help="hidraw node (e.g. /dev/hidraw9) or hidapi path, as listed when several are found")
    ap.add_argument("--backend", choices=["hidraw", "hidapi"], default="hidraw" if sys.platform.startswith("linux") else "hidapi",
                    help="hidraw: Linux, standard library (default there); hidapi: pip install hidapi (default elsewhere)")
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

    dev = find_device(a.device, a.backend)
    try:  # a failed command or an unplugged mouse ends in a message, not a traceback
        if a.cmd == "info":
            caps = dev.command(GET_CAPS)
            dpi_min, dpi_max, _, _, _, _, sensor_dpi = struct.unpack_from("<HHHHBBH", caps, 8)
            print(f"device      : {dev.path} ({'2.4 GHz receiver' if dev.relay else 'QMK raw HID' if dev.raw else 'direct'}, protocol {caps[4]}, DPI {dpi_min}..{dpi_max})")
            print(f"current DPI : {sensor_dpi if sensor_dpi else 'not reported by this firmware'}")
            if caps[7] & 0x80:
                print(f"clock       : {struct.unpack_from('<I', caps, 20)[0]} ms (the firmware's idle-reset clock)")
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
    except (RuntimeError, ValueError, OSError) as e:
        sys.exit(f"{dev.path}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
