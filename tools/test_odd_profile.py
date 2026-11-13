#!/usr/bin/env python3
"""odd_profile.py device layer against a fake cable and a fake 2.4 GHz receiver (stdlib only, no hardware).

The fakes follow spec/hid-protocol-v1.md 2.3 (verified on a retail mouse, 2026-11-13): the receiver forwards a
request only when body[2] = 0x02, forwards and copies back body[3] + 6 bytes (the rest of its buffer is stale), shows
0xA0 while the request is pending and 0xA4 while the mouse is unreachable. Time is virtual, so nothing sleeps.
Run: python3 tools/test_odd_profile.py
"""

import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import odd_profile as op

STOCK_VERSION = bytes.fromhex("a10000030081010000002018")  # stock v1.0.0.0 reply on the cable, 2026-11-13
CABLE, RECEIVER = op.GLORIOUS_WIRED, op.GLORIOUS_RECEIVER


class Clock:
    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    def sleep(self, s):
        self.t += s


def mouse(req: bytes, stamp, relayed=False) -> bytes:
    """Mouse firmware. stamp: where the version reply carries DP01 (() = stock, (16,) = patch without 2.4 GHz)."""
    r = bytearray(64)
    if req[4:6] == b"\x00\x81":  # stock firmware-version query
        r[:12] = STOCK_VERSION
        for i in stamp:
            r[i:i + 4] = b"DP01"
        return bytes(r)
    p = bytearray(req)
    if relayed:
        p[0], p[2], p[3] = 0x44, 0x01, 0x00  # the patch restores the canonical packet before checking the CRC
    ok = p[:3] == b"DP\x01" and p[5] == op.NAMESPACE and struct.unpack_from("<H", p, 62)[0] == op.crc16(p[:62])
    r[:8] = b"DP\x01" + bytes([0xA1 if ok else 0xA2]) + p[4:8]
    if ok:
        r[8:62] = p[8:62]  # echo the payload, like SET_PROFILE
    struct.pack_into("<H", r, 62, op.crc16(r[:62]))
    return bytes(r)


class Fake(op.Device):
    """Device with its two ioctls replaced: a cable (the mouse answers at once) or the receiver in front of it.
    stall: {body[6]: (0xA4 from, reply at)} in seconds after the request; reply at None = the link never comes back."""

    def __init__(self, clock, receiver, stamp=(12, 16), stall=None, broken=False):
        self.clock, self.receiver, self.stamp, self.stall, self.broken = clock, receiver, stamp, stall or {}, broken
        self.seq, self.sent, self.shown, self.buf, self.pending = 0, [], [], bytes(64), None

    def set(self, body):
        if self.broken:
            raise OSError(32, "Broken pipe")
        body = bytes(body).ljust(64, b"\x00")
        self.sent.append(body)
        if not self.receiver:
            self.buf = mouse(body, self.stamp)
        elif body[2] != 0x02:  # answered by the receiver itself: its own version (no stamp), else 0xA3 + echo
            self.buf = bytes([0xA1 if body[4:6] == b"\x00\x81" else 0xA3]) + body[1:]
        else:
            self.pending = body, self.clock.t, *self.stall.get(body[6], (None, 0.008))

    def get(self):
        if self.pending:
            body, t0, down_from, reply_at = self.pending
            dt = self.clock.t - t0
            if reply_at is None or dt < reply_at:
                self.shown.append(0xA4 if down_from is not None and dt >= down_from else 0xA0)
                return bytes(self.shown[-1:]) + body[1:]
            n = body[3] + 6
            self.buf = mouse(body[:n].ljust(64, b"\x00"), self.stamp, relayed=True)[:n] + body[n:]
            self.pending = None
        return self.buf


class DeviceLayer(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root, self.clock, self.nodes, self.opened = Path(tmp.name), Clock(), {}, []
        for name, value in (("SYSFS", self.root), ("time", self.clock), ("Device", self.open)):
            patch = mock.patch.object(op, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def node(self, name, ids, hid_name="", vendor=True, deny=False, **fake):
        d = self.root / name / "device"
        d.mkdir(parents=True)
        (d / "uevent").write_text(f"HID_ID=0003:0000{ids[0]:04X}:0000{ids[1]:04X}\nHID_NAME={hid_name}\n")
        (d / "report_descriptor").write_bytes(b"\x06\x00\xff" if vendor else b"\x05\x01\x09\x02")
        self.nodes[f"/dev/{name}"] = ids, deny, fake

    def open(self, path, relay=False):
        ids, deny, fake = self.nodes[path]
        if deny:
            raise PermissionError(13, "Permission denied", path)
        dev = Fake(self.clock, ids == RECEIVER, **fake)
        dev.path, dev.relay = path, relay
        self.opened.append(dev)
        return dev

    def exits(self, fn, text):
        with self.assertRaises(SystemExit) as cm:
            fn()
        self.assertIn(text, cm.exception.code)

    def test_envelope_through_receiver_and_canonical_crc(self):
        self.node("hidraw3", RECEIVER)
        dev = op.find_device(None)
        payload = bytes(range(28))
        self.assertEqual(dev.command(op.SET_PROFILE, payload)[:28], payload)
        req = dev.sent[-1]
        self.assertEqual(req[:4], b"DP\x02\x3a")  # relay envelope: target mouse, forward 64 bytes
        canonical = req[:2] + b"\x01\x00" + req[4:62]
        self.assertEqual(struct.unpack_from("<H", req, 62)[0], op.crc16(canonical))
        self.assertGreaterEqual(req[4], 5)  # seq: stock firmware runs no handler for these

    def test_cable_sends_canonical_packet(self):
        self.node("hidraw3", CABLE)
        dev = op.find_device(None)
        dev.command(op.GET_PROFILE)
        self.assertEqual(dev.sent[-1][:4], b"DP\x01\x00")

    def test_relayed_detection_asks_for_16_bytes(self):
        self.node("hidraw3", RECEIVER)
        dev = op.find_device(None)
        self.assertTrue(dev.relay)
        self.assertEqual(dev.sent[0][:6], bytes([0, 0, 0x02, 0x0A, 0x00, 0x81]))

    def test_receiver_never_sends_envelope_to_old_patch_or_stock(self):
        self.node("hidraw1", RECEIVER, stamp=(16,))  # older patch build: bytes 12..15 not stamped
        self.node("hidraw2", RECEIVER, stamp=())  # stock firmware
        self.node("hidraw3", CABLE, stamp=(16,))
        for path in ("/dev/hidraw1", "/dev/hidraw2"):
            self.exits(lambda: op.find_device(path), "no DP01 stamp through the receiver")
            self.assertEqual(len(self.opened[-1].sent), 1)  # only the version query
        self.assertFalse(op.find_device("/dev/hidraw3").relay)  # the older build is fine on the cable

    def test_transient_a4_then_reply(self):
        self.node("hidraw3", RECEIVER, stall={op.SAVE_FLASH: (0.27, 0.77)})  # SAVE_FLASH on a retail mouse
        dev = op.find_device(None)
        dev.command(op.SAVE_FLASH)
        self.assertIn(0xA4, dev.shown)
        self.assertGreaterEqual(self.clock.t, 0.77)

    def test_final_a4_is_unreachable(self):
        self.node("hidraw3", RECEIVER, stall={op.GET_PROFILE: (0.27, None)})
        dev = op.find_device(None)
        self.exits(lambda: dev.command(op.GET_PROFILE), "cannot reach the mouse")

    def test_cable_wins_over_receiver(self):
        self.node("hidraw2", RECEIVER)
        self.node("hidraw5", CABLE)
        dev = op.find_device(None)
        self.assertEqual((dev.path, dev.relay), ("/dev/hidraw5", False))
        self.assertEqual(len(self.opened), 1)
        self.assertEqual(op.find_device("/dev/hidraw2").path, "/dev/hidraw2")  # --device picks the receiver

    def test_device_rejects_unidentified_node(self):
        self.node("hidraw0", (0x046D, 0xC08B))  # vendor page, but no Glorious IDs and no [OpenDDPIv1]
        self.node("hidraw1", CABLE, vendor=False)  # the mouse's own pointer interface
        self.node("hidraw2", (0x1209, 0x0001), hid_name="My Mouse [OpenDDPIv1]")
        for path in ("/dev/hidraw0", "hidraw1", "/dev/hidraw9"):
            self.exits(lambda: op.find_device(path), "not a supported device")
        self.assertEqual(self.opened, [])  # nothing opened, nothing sent
        dev = op.find_device("/dev/hidraw2")
        self.assertEqual(dev.sent, [])  # identified by its product string, no stock query

    def test_permission_and_ioctl_errors_end_in_a_message(self):
        self.node("hidraw3", CABLE, deny=True)
        self.node("hidraw4", CABLE, broken=True)
        self.exits(lambda: op.find_device("/dev/hidraw3"), "70-glorious-series-one-pro.rules")
        self.exits(lambda: op.find_device("/dev/hidraw4"), "/dev/hidraw4: cannot query it (Broken pipe)")

    def test_command_errors_end_in_a_message(self):
        self.node("hidraw3", RECEIVER, stall={op.GET_CAPS: (None, None)})  # pending forever, never 0xA4
        self.node("hidraw4", (0x1209, 0x0001), hid_name="My Mouse [OpenDDPIv1]", broken=True)  # unplugged
        for path, text in (("/dev/hidraw3", "/dev/hidraw3: no answer to opcode 0x01"),
                           ("/dev/hidraw4", "/dev/hidraw4: [Errno 32] Broken pipe")):
            with mock.patch.object(sys, "argv", ["odd_profile.py", "--device", path, "info"]):
                self.exits(op.main, text)


if __name__ == "__main__":
    unittest.main()
