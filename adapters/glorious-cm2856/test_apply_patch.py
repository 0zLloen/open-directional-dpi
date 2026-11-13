#!/usr/bin/env python3
"""Patch file (build_and_verify_patch.make_patch_file) and apply_patch.py on a synthetic stock image: no vendor
bytes, no ARM toolchain, no mouse-firmware-re (a stub compx_hex_tool.py stores the image as plain hex text).
Run: python3 adapters/glorious-cm2856/test_apply_patch.py
"""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from apply_patch import apply_patch
from build_and_verify_patch import APP_BASE, make_patch_file

HERE = Path(__file__).resolve().parent
STUB = """from pathlib import Path
def load_app_hex(path, app_base):
    return bytes.fromhex(Path(path).read_text()), None, 1
def encode_compx_hex(data, base_addr):
    return data.hex()
"""
SITE = (APP_BASE + 0x100, 4)  # a synthetic hook site


def synthetic():
    stock = random.Random(1).randbytes(0x400)
    image = bytearray(stock) + b"\xFF" * 0x10 + bytes.fromhex("0102ff04ffff07") + b"\xFF" * 9  # pad, code, pad
    image[0x100:0x104] = bytes([stock[0x100] ^ 0x5A, stock[0x101], 0x12, 0x34])  # byte 0x101 unchanged
    return stock, bytes(image)


class PatchFile(unittest.TestCase):
    def test_only_changed_bytes_and_round_trip(self):
        stock, image = synthetic()
        patch = make_patch_file(stock, image, [SITE])
        padded = stock.ljust(len(image), b"\xFF")
        for r in patch["ranges"]:
            off, data = int(r["addr"], 16) - APP_BASE, bytes.fromhex(r["hex"])
            self.assertTrue(all(b != padded[off + i] for i, b in enumerate(data)), r)  # no stock byte, no pad byte
        self.assertEqual([r["addr"] for r in patch["ranges"]], ["0x00006100", "0x00006102", "0x00006410", "0x00006413", "0x00006416"])
        self.assertEqual(apply_patch(stock, json.loads(json.dumps(patch))), image)

    def test_change_outside_the_hook_sites_is_refused(self):
        stock, image = synthetic()
        image = image[:0x200] + bytes([image[0x200] ^ 1]) + image[0x201:]
        with self.assertRaises(AssertionError):
            make_patch_file(stock, image, [SITE])

    def test_wrong_stock_or_damaged_patch_is_refused(self):
        stock, image = synthetic()
        patch = make_patch_file(stock, image, [SITE])
        with self.assertRaisesRegex(ValueError, "this patch needs"):
            apply_patch(bytes([stock[0] ^ 1]) + stock[1:], patch)
        with self.assertRaisesRegex(ValueError, "this patch needs"):
            apply_patch(stock[:-1], patch)
        patch["ranges"][-1]["hex"] = "00" + patch["ranges"][-1]["hex"][2:]
        with self.assertRaisesRegex(ValueError, "damaged"):
            apply_patch(stock, patch)
        with self.assertRaisesRegex(ValueError, "not an OpenDDPIv1 patch file"):
            apply_patch(stock, {**patch, "version": 2})

    def test_command_line(self):
        stock, image = synthetic()
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "compx_hex_tool.py").write_text(STUB)
            (tmp / "stock.hex").write_text(stock.hex())
            (tmp / "bad.hex").write_text(stock[:-1].hex())
            (tmp / "patch.json").write_text(json.dumps(make_patch_file(stock, image, [SITE])))
            env = {**os.environ, "COMPX_TOOLS": str(tmp)}

            def run(stock_hex):
                return subprocess.run([sys.executable, str(HERE / "apply_patch.py"), "--stock-hex", str(tmp / stock_hex),
                                       "--patch", str(tmp / "patch.json"), "-o", str(tmp / "out.hex")],
                                      env=env, capture_output=True, text=True)

            p = run("bad.hex")
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("Refused, nothing written", p.stderr)
            self.assertFalse((tmp / "out.hex").exists())
            p = run("stock.hex")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(bytes.fromhex((tmp / "out.hex").read_text()), image)


if __name__ == "__main__":
    unittest.main()
