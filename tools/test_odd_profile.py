#!/usr/bin/env python3
"""odd_profile.py device layer against a fake cable, a fake 2.4 GHz receiver, fake QMK raw HID boards and a fake
hidapi module (stdlib only, no hardware).

The fakes replace the I/O layer (Hidraw, or the hid module behind Hidapi), so Device and find_device run as they are.
The cable and receiver follow spec/hid-protocol-v1.md 2.3 (verified on a retail mouse, 2026-11-13): the receiver
forwards a request only when body[2] = 0x02, forwards and copies back body[3] + 6 bytes (the rest of its buffer is
stale), shows 0xA0 while the request is pending and 0xA4 while the mouse is unreachable, and answers its own link-state
query 0x89 (body[6] = 1 linked; 0 unlinked is inferred from its disassembly). The QMK boards follow spec
6.2/6.3 (inferred from the QMK and vial-qmk sources, not run on a board). Time is virtual, so nothing sleeps.
Run: python3 tools/test_odd_profile.py
"""

import contextlib
import io
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import odd_profile as op

STOCK_VERSION = bytes.fromhex("a10000030081010000002018")  # stock v1.0.0.0 reply on the cable, 2026-11-13
LINK_QUERY = bytes([0, 0, 0, 0, 0, 0x89]).ljust(64, b"\x00")  # receiver-local link-state query (spec 2.3)
CABLE, RECEIVER = op.GLORIOUS_WIRED, op.GLORIOUS_RECEIVER


class Clock:
    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    time = monotonic  # Device's first seq
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
        r[8:62] = b"DP01".ljust(54, b"\x00") if p[6] == op.GET_CAPS else p[8:62]  # else echo, like SET_PROFILE
    struct.pack_into("<H", r, 62, op.crc16(r[:62]))
    return bytes(r)


class Fake:
    """Feature-report I/O of a cable (the mouse answers at once) or of the receiver in front of it.
    stall: {body[6]: (0xA4 from, reply at)} in seconds after the request; reply at None = the link never comes back.
    A list of those applies to successive requests, the last one repeating. link(t): what the 0x89 query answers
    (None: 0xA3, as for a command the receiver does not know)."""

    def __init__(self, clock, receiver, stamp=(12, 16), stall=None, broken=False, link=lambda t: True):
        self.clock, self.receiver, self.stamp, self.stall, self.broken = clock, receiver, stamp, stall or {}, broken
        self.link = link
        self.sent, self.shown, self.buf, self.pending = [], [], bytes(64), None

    def set_feature(self, buf):
        if self.broken:
            raise OSError(32, "Broken pipe")
        assert len(buf) == 65 and buf[0] == 0, "report ID 0 + 64 bytes"
        body = bytes(buf[1:])
        self.sent.append(body)
        if not self.receiver:
            self.buf = mouse(body, self.stamp)
        elif body[2] != 0x02:  # answered by the receiver itself: only the link query may be sent to it
            assert body == LINK_QUERY, f"receiver-local command sent: {body[:8].hex()}"
            link = b"\xA3" + body[1:7] if self.link is None else b"\xA1" + body[1:6] + bytes([bool(self.link(self.clock.t))])
            self.buf, self.pending = link + body[7:], None
        else:
            s = self.stall.get(body[6], (None, 0.008))
            self.pending = body, self.clock.t, *(s if isinstance(s, tuple) else s.pop(0) if len(s) > 1 else s[0])

    def get_feature(self):
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


class FakeQmk:
    """Raw HID I/O of a QMK board (spec 6.2/6.3). stack: "ddpi" (the adapter, wired as for VIA), "via" (VIA or Vial
    without it: byte 0 -> 0xFF, frame sent back), "echo" (Vial during an unlock: frame sent back unchanged), "none"
    (raw HID without a handler: no reply). noise: another program's reports arrive before each reply."""

    def __init__(self, clock, stack="ddpi", noise=False):
        self.clock, self.stack, self.noise, self.frames, self.inbox = clock, stack, noise, [], []
        self.req, self.resp = bytearray(64), bytes(64)

    def write(self, buf):
        assert len(buf) == 33 and buf[0] == 0, "report ID 0 + 32 bytes"
        f = bytearray(buf[1:])
        self.frames.append(bytes(f))
        if self.stack == "none":
            return
        if self.stack == "via":
            f[0] = 0xFF
        elif self.stack == "ddpi":
            i, n = f[1] & 0x7F, 4 if f[1] & 0x7F == 2 else 30
            if f[1] & 0x80:
                f[2:32] = self.resp[30 * i:30 * i + n].ljust(30, b"\x00")
            else:
                self.req[30 * i:30 * i + n] = f[2:2 + n]
                if i == 2:
                    self.resp = mouse(bytes(self.req), ())
        if self.noise:
            self.inbox += [bytes([0x02]) + bytes(f[1:]), bytes([0xFF, f[1] ^ 0x01]) + bytes(30)]  # VIA app traffic
        self.inbox.append(bytes(f))

    def read(self, timeout):
        if self.inbox:
            return self.inbox.pop(0)
        self.clock.t += timeout
        return b""


class FakeHid:
    """cython-hidapi module: enumerate() and device(), over the fakes above."""

    def __init__(self, entries):
        self.entries = entries  # [(enumerate() dict, I/O fake or None)]

    def enumerate(self, vendor_id=0, product_id=0):
        return [dict(e) for e, _ in self.entries]

    def device(self):
        hid = self

        class Dev:
            def open_path(self, path):
                assert isinstance(path, bytes)
                self.io = next(io for e, io in hid.entries if e["path"] == path)
                if self.io is None:  # no access, or another program holds it
                    raise OSError("open failed")

            def send_feature_report(self, data):  # cython-hidapi returns -1 instead of raising
                try:
                    self.io.set_feature(bytes(data))
                except OSError:
                    return -1
                return len(data)

            def get_feature_report(self, report_num, max_length):
                assert (report_num, max_length) == (0, 65)
                return [0] + list(self.io.get_feature())  # hidapi keeps the report ID in byte 0

            def write(self, data):
                try:
                    self.io.write(bytes(data))
                except OSError:
                    return -1
                return len(data)

            def read(self, max_length, timeout_ms=0):
                return list(self.io.read(timeout_ms / 1000))

            def error(self):
                return "fake error"

        return Dev()


def hid_entry(path, ids, usage, product="", io=None):
    return {"path": path.encode(), "vendor_id": ids[0], "product_id": ids[1], "product_string": product,
            "usage_page": usage[0], "usage": usage[1], "interface_number": 2}, io


class DeviceLayer(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root, self.clock, self.nodes, self.opened = Path(tmp.name), Clock(), {}, []
        for name, value in (("SYSFS", self.root), ("time", self.clock), ("Hidraw", self.open)):
            patch = mock.patch.object(op, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def node(self, name, ids, hid_name="", vendor=True, qmk=False, deny=False, **fake):
        d = self.root / name / "device"
        d.mkdir(parents=True)
        (d / "uevent").write_text(f"HID_ID=0003:0000{ids[0]:04X}:0000{ids[1]:04X}\nHID_NAME={hid_name}\n")
        rdesc = op.QMK_RDESC + b"\x09\x62\x15\x00" if qmk else b"\x06\x00\xff" if vendor else b"\x05\x01\x09\x02"
        (d / "report_descriptor").write_bytes(rdesc)
        self.nodes[f"/dev/{name}"] = ids, deny, qmk, fake

    def open(self, path):
        ids, deny, qmk, fake = self.nodes[path]
        if deny:
            raise PermissionError(13, "Permission denied", path)
        io = FakeQmk(self.clock, **fake) if qmk else Fake(self.clock, ids == RECEIVER, **fake)
        self.opened.append(io)
        return io

    def exits(self, fn, text):
        with self.assertRaises(SystemExit) as cm:
            fn()
        self.assertIn(text, cm.exception.code)
        return cm.exception.code

    def test_envelope_through_receiver_and_canonical_crc(self):
        self.node("hidraw3", RECEIVER)
        dev = op.find_device(None)
        payload = bytes(range(28))
        self.assertEqual(dev.command(op.SET_PROFILE, payload)[:28], payload)
        req = dev.io.sent[-1]
        self.assertEqual(req[:4], b"DP\x02\x3a")  # relay envelope: target mouse, forward 64 bytes
        canonical = req[:2] + b"\x01\x00" + req[4:62]
        self.assertEqual(struct.unpack_from("<H", req, 62)[0], op.crc16(canonical))
        self.assertGreaterEqual(req[4], 5)  # seq: stock firmware runs no handler for these

    def test_cable_sends_canonical_packet(self):
        self.node("hidraw3", CABLE)
        dev = op.find_device(None)
        dev.command(op.GET_PROFILE)
        self.assertEqual(dev.io.sent[-1][:4], b"DP\x01\x00")

    def test_relayed_detection_asks_for_16_bytes(self):
        self.node("hidraw3", RECEIVER)
        dev = op.find_device(None)
        self.assertTrue(dev.relay)
        self.assertEqual(dev.io.sent[0], LINK_QUERY)  # link check first (spec 2.3)
        self.assertEqual(dev.io.sent[1][:6], bytes([0, 0, 0x02, 0x0A, 0x00, 0x81]))

    def test_receiver_never_sends_envelope_to_old_patch_or_stock(self):
        self.node("hidraw1", RECEIVER, stamp=(16,))  # older patch build: bytes 12..15 not stamped
        self.node("hidraw2", RECEIVER, stamp=())  # stock firmware
        self.node("hidraw3", CABLE, stamp=(16,))
        for path in ("/dev/hidraw1", "/dev/hidraw2"):
            self.exits(lambda: op.find_device(path), "no DP01 stamp through the receiver")
            self.assertEqual([p[:6] for p in self.opened[-1].sent], [LINK_QUERY[:6], bytes([0, 0, 2, 0x0A, 0, 0x81])])
        self.assertFalse(op.find_device("/dev/hidraw3").relay)  # the older build is fine on the cable

    def test_transient_a4_then_reply(self):
        self.node("hidraw3", RECEIVER, stall={op.SAVE_FLASH: (0.27, 0.77)})  # SAVE_FLASH on a retail mouse
        dev = op.find_device(None)
        dev.command(op.SAVE_FLASH)
        self.assertIn(0xA4, dev.io.shown)
        self.assertGreaterEqual(self.clock.t, 0.77)

    def test_final_a4_is_unreachable(self):
        self.node("hidraw3", RECEIVER, stall={op.GET_PROFILE: (0.27, None)})
        dev = op.find_device(None)
        before = len(dev.io.sent)
        self.exits(lambda: dev.command(op.GET_PROFILE), "cannot reach the mouse")
        sent = dev.io.sent[before:]
        self.assertEqual([p == LINK_QUERY for p in sent], [True, False, True, False])  # sent twice, link check first
        self.assertEqual(sent[3][4], sent[1][4] + 1)  # new seq, and so a new CRC

    def test_final_a4_waits_for_the_link_then_sends_again(self):
        # The receiver clears its link flag before a final 0xA4 (disassembly 0xDA86 / 0xDAB0), so 0x89 answers 00
        # until the mouse links again: here from 2 s (the first final 0xA4) to 3 s
        self.node("hidraw3", RECEIVER, stall={op.GET_PROFILE: [(0.27, None), (None, 0.008)]},
                  link=lambda t: not 2.0 <= t < 3.0)
        dev = op.find_device(None)
        before, err = len(dev.io.sent), io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(dev.command(op.GET_PROFILE)[:4], bytes(4))
        self.assertEqual(err.getvalue(), op.WAIT_MSG + "\n")  # shown once
        self.assertGreaterEqual(self.clock.t, 3.0)
        sent = dev.io.sent[before:]
        waited = len(sent) - 3
        self.assertGreater(waited, 1)  # link queries until the link is back, then the resend
        self.assertEqual([p == LINK_QUERY for p in sent], [True, False] + [True] * waited + [False])
        self.assertEqual([(p[4], p[6]) for p in (sent[1], sent[-1])],
                         [(sent[1][4], op.GET_PROFILE), (sent[1][4] + 1, op.GET_PROFILE)])  # new seq

    def test_waits_for_the_link(self):
        self.node("hidraw3", RECEIVER, link=lambda t: t >= 1.0)  # no link for the first second
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            dev = op.find_device(None)
            dev.command(op.GET_CAPS)
        self.assertEqual(err.getvalue(), op.WAIT_MSG + "\n")  # shown once
        self.assertGreaterEqual(self.clock.t, 1.0)
        self.assertGreater(sum(p == LINK_QUERY for p in dev.io.sent), 10)  # every ~0.1 s until the link is up
        self.assertEqual(dev.io.sent[-2], LINK_QUERY)  # and once more before GET_CAPS

    def test_unknown_link_state_sends_the_request(self):
        self.node("hidraw3", RECEIVER, link=None)  # no 0x89 answer within 2 s: unknown, taken as linked
        dev = op.find_device(None)
        self.assertEqual(dev.command(op.GET_CAPS)[:4], b"DP01")
        self.assertGreaterEqual(self.clock.t, 4.0)

    def test_no_link_sends_no_request(self):
        self.node("hidraw3", RECEIVER, link=lambda t: False)
        with contextlib.redirect_stderr(io.StringIO()):
            self.exits(lambda: op.find_device(None), "/dev/hidraw3: The receiver cannot reach the mouse")
        self.assertGreaterEqual(self.clock.t, op.LINK_WAIT_S)
        self.assertTrue(all(p == LINK_QUERY for p in self.opened[0].sent))  # not even the version query

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
        self.assertEqual(dev.io.sent, [])  # identified by its product string, no stock query

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

    # --- QMK raw HID (spec 6) -------------------------------------------------------------------

    def test_qmk_probe_frames_and_commands(self):
        self.node("hidraw7", (0xFEED, 0x0001), qmk=True)
        dev = op.find_device(None)
        self.assertTrue(dev.raw)
        frames = dev.io.frames
        self.assertEqual([f[:2] for f in frames], [b"\xdf\x00", b"\xdf\x01", b"\xdf\x02", b"\xdf\x80", b"\xdf\x81", b"\xdf\x82"])
        probe = frames[0][2:] + frames[1][2:] + frames[2][2:6]
        self.assertEqual(frames[2][6:], bytes(26))  # chunk 2: packet bytes 60..63, then zeros
        self.assertTrue(all(f[2:] == bytes(30) for f in frames[3:]))  # read frames carry no data
        self.assertEqual((probe[:3], probe[5], probe[6]), (b"DP\x01", op.NAMESPACE, op.GET_CAPS))
        self.assertGreaterEqual(probe[4], 5)
        self.assertEqual(struct.unpack_from("<H", probe, 62)[0], op.crc16(probe[:62]))
        payload = bytes(range(1, 29))  # spans write chunks 0 and 1, and read chunks 0 and 1
        self.assertEqual(dev.command(op.SET_PROFILE, payload)[:28], payload)
        self.assertEqual(len(frames), 12)
        dev.io.read = lambda timeout: dev.io.inbox.pop(0)[:20] if dev.io.inbox else b""  # short reports
        with self.assertRaisesRegex(RuntimeError, "no answer"):
            dev.command(op.GET_PROFILE)

    def test_qmk_board_without_adapter_gets_only_the_probe(self):
        self.node("hidraw7", (0xFEED, 0x0001), qmk=True, stack="via")  # VIA or Vial: answers 0xFF
        self.node("hidraw8", (0xFEED, 0x0002), qmk=True, stack="echo")  # Vial unlocking: echoes every frame
        self.node("hidraw9", (0xFEED, 0x0003), qmk=True, stack="none")  # raw HID without a handler
        self.exits(lambda: op.find_device(None), "No supported device found")
        via, echo, none = self.opened
        self.assertEqual(len(via.frames), 1)  # stops at the 0xFF reply to write chunk 0
        self.assertEqual(len(echo.frames), 6)  # echoed reads reassemble to zeros: not an answer
        self.assertEqual(len(none.frames), 1)  # no reply within 2 s
        self.assertGreaterEqual(self.clock.t, 2.0)
        self.exits(lambda: op.find_device("/dev/hidraw7"), "no Open Directional DPI answer")

    def test_qmk_skips_other_programs_reports(self):
        self.node("hidraw7", (0xFEED, 0x0001), qmk=True, noise=True)
        dev = op.find_device("hidraw7")
        self.assertEqual(dev.command(op.GET_PROFILE)[:4], bytes(4))

    def test_unopenable_keyboard_does_not_stop_the_search(self):
        self.node("hidraw6", (0xFEED, 0x0001), qmk=True, deny=True)  # root-only, or held by the VIA app
        self.assertIn("/dev/hidraw6", self.exits(lambda: op.find_device(None), "No supported device found"))
        self.node("hidraw7", (0xFEED, 0x0002), qmk=True)
        self.assertEqual(op.find_device(None).path, "/dev/hidraw7")
        self.exits(lambda: op.find_device("/dev/hidraw6"), "/dev/hidraw6: cannot query it (Permission denied)")

    def test_mouse_wins_without_probing_qmk(self):
        self.node("hidraw3", CABLE)
        self.node("hidraw7", (0xFEED, 0x0001), qmk=True)
        self.assertEqual(op.find_device(None).path, "/dev/hidraw3")
        self.assertEqual(len(self.opened), 1)  # the keyboard was never opened
        self.assertTrue(op.find_device("/dev/hidraw7").raw)  # --device picks it


class HidapiBackend(unittest.TestCase):
    """--backend hidapi with a fake cython-hidapi module: same selection, same packets."""

    def setUp(self):
        self.clock = Clock()
        patch = mock.patch.object(op, "time", self.clock)
        patch.start()
        self.addCleanup(patch.stop)

    def run_with(self, entries, platform="linux", module="hidraw", explicit=None):
        fake = FakeHid(entries)
        mods = {"hidraw": None, "hid": None, module: fake}  # None: import fails
        with mock.patch.dict(sys.modules, mods), mock.patch.object(sys, "platform", platform):
            return op.find_device(explicit, "hidapi")

    def glorious(self, ids, io):
        """The mouse's collections as Windows lists them: only interface 2 is usage page 0xFFFF, usage 0."""
        return [hid_entry(f"{ids[1]:x}-if0", ids, (0x0001, 0x02)), hid_entry(f"{ids[1]:x}-if1a", ids, (0x000C, 0x01)),
                hid_entry(f"{ids[1]:x}-if1b", ids, (0xFFA0, 0x01)), hid_entry(f"{ids[1]:x}-if1c", ids, (0xFFFF, 0x01)),
                hid_entry(f"{ids[1]:x}-if2", ids, (0xFFFF, 0x0000), io=io)]

    def test_linux_uses_the_hidraw_module_never_libusb(self):
        cable = Fake(self.clock, False)
        dev = self.run_with(self.glorious(CABLE, cable))  # "hid" (libusb) is not importable here
        self.assertEqual((dev.path, dev.relay), ("2018-if2", False))
        self.assertEqual(dev.command(op.GET_CAPS)[:4], b"DP01")
        self.assertEqual(cable.sent[-1][:4], b"DP\x01\x00")

    def test_windows_receiver_and_cable(self):
        rx, cable = Fake(self.clock, True), Fake(self.clock, False)
        entries = self.glorious(RECEIVER, rx) + self.glorious(CABLE, cable)
        self.assertEqual(self.run_with(entries, "win32", "hid").path, "2018-if2")  # the cable wins
        dev = self.run_with(entries, "darwin", "hid", explicit="2031-if2")
        self.assertTrue(dev.relay)
        payload = bytes(range(28))
        self.assertEqual(dev.command(op.SET_PROFILE, payload)[:28], payload)
        self.assertEqual(rx.sent[-1][:4], b"DP\x02\x3a")

    def test_qmk_and_openddpi_by_usage(self):
        board = FakeQmk(self.clock)
        entries = [hid_entry("kbd-if0", (0xFEED, 1), (0x0001, 0x06)), hid_entry("kbd-if1", (0xFEED, 1), op.QMK_USAGE, io=board)]
        self.assertTrue(self.run_with(entries, "win32", "hid").raw)
        self.assertEqual(len(board.frames), 6)
        zephyr = Fake(self.clock, False)
        dev = self.run_with([hid_entry("z", (0x1209, 1), (0xFFFF, 0), "My Mouse [OpenDDPIv1]", zephyr)], "darwin", "hid")
        self.assertEqual(zephyr.sent, [])  # identified by its product string, no stock query

    def test_errors_carry_hidapi_reason(self):
        with self.assertRaises(SystemExit) as cm:  # send_feature_report returns -1
            self.run_with(self.glorious(CABLE, Fake(self.clock, False, broken=True)), "win32", "hid")
        self.assertIn("2018-if2: cannot query it (fake error)", cm.exception.code)
        board = FakeQmk(self.clock)
        entries = [hid_entry("held", (0xFEED, 1), op.QMK_USAGE), hid_entry("kbd", (0xFEED, 2), op.QMK_USAGE, io=board)]
        self.assertEqual(self.run_with(entries, "darwin", "hid").path, "kbd")  # the one that does not open is skipped
        with self.assertRaises(SystemExit) as cm:  # open_path fails
            self.run_with(entries, "darwin", "hid", explicit="held")
        self.assertIn("held: cannot query it (fake error)", cm.exception.code)

    def test_missing_or_wrong_module(self):
        with self.assertRaises(SystemExit) as cm, mock.patch.dict(sys.modules, {"hidraw": None}):
            op.find_device(None, "hidapi")
        self.assertIn("pip install hidapi", cm.exception.code)
        other = mock.Mock(spec=["Device", "enumerate"], __file__="hid.py")  # the unrelated "hid" package
        with self.assertRaises(SystemExit) as cm, mock.patch.dict(sys.modules, {"hid": other}), \
                mock.patch.object(sys, "platform", "win32"):
            op.find_device(None, "hidapi")
        self.assertIn("not cython-hidapi", cm.exception.code)


if __name__ == "__main__":
    unittest.main()
