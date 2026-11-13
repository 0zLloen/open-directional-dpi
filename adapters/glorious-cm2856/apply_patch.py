#!/usr/bin/env python3
"""
Apply OpenDDPIv1-patch.json to your own stock Glorious Series One Pro image, without the ARM toolchain
(e.g. on Windows or macOS). Standard library plus compx_hex_tool.py from mouse-firmware-re (sibling
checkout, or COMPX_TOOLS), like build_and_verify_patch.py.

  python3 apply_patch.py --stock-hex CM2856_Mouse_USB_v1.00.00_20220810.hex --patch OpenDDPIv1-patch.json -o OpenDDPIv1.hex

--stock-hex is the official .hex or a dump of a mouse on stock v1.0.0.0 (compx_usb_flasher.py dump). It is
decoded at 0x6000 and cut to the patch file's stock size, and its SHA-256 must match the patch file. The
image is then padded with 0xFF to the result size and the patch bytes are written. The result must match the
patch file's SHA-256, the image build_and_verify_patch.py built and checked in Unicorn. Nothing is written
unless both hashes match. The output is the build's .hex format, for compx_usb_flasher.py flash --firmware-hex.

The patch file holds only bytes this project wrote (hook instructions and the appended patch code), never
stock bytes: build_and_verify_patch.py writes it and asserts that.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from build_and_verify_patch import APP_BASE, PATCH_FORMAT, import_compx_hex_tool


def apply_patch(stock: bytes, patch: dict) -> bytes:
    """Patched image, or ValueError with a readable reason."""
    if {k: patch.get(k) for k in PATCH_FORMAT} != PATCH_FORMAT:
        raise ValueError(f"not an OpenDDPIv1 patch file (want {PATCH_FORMAT})")
    want, digest = patch["stock"], hashlib.sha256(stock).hexdigest()
    if (len(stock), digest) != (want["size"], want["sha256"]):
        raise ValueError(f"stock image is {len(stock)} bytes, sha256 {digest}; this patch needs {want['size']} "
                         f"bytes, sha256 {want['sha256']} (CM2856_Mouse_USB v1.00.00 20220810)")
    image = bytearray(stock.ljust(patch["result"]["size"], b"\xFF"))
    for r in patch["ranges"]:
        off, data = int(r["addr"], 16) - APP_BASE, bytes.fromhex(r["hex"])
        image[off : off + len(data)] = data
    want, digest = patch["result"], hashlib.sha256(image).hexdigest()
    if (len(image), digest) != (want["size"], want["sha256"]):
        raise ValueError(f"patched image is {len(image)} bytes, sha256 {digest}; the patch file expects "
                         f"{want['size']} bytes, sha256 {want['sha256']}. The patch file is damaged.")
    return bytes(image)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stock-hex", type=Path, required=True, help="official .hex or a dump .hex of a stock v1.0.0.0 mouse")
    ap.add_argument("--patch", type=Path, required=True, help="OpenDDPIv1-patch.json")
    ap.add_argument("-o", "--output", type=Path, required=True, help="patched .hex to write")
    a = ap.parse_args()
    hex_tool = import_compx_hex_tool()
    try:
        patch = json.loads(a.patch.read_text())
        stock = hex_tool.load_app_hex(a.stock_hex, APP_BASE)[0][: patch["stock"]["size"]]
        image = apply_patch(stock, patch)
    except (KeyError, TypeError, AttributeError) as e:
        sys.exit(f"Refused, nothing written: {a.patch} is not an OpenDDPIv1 patch file ({e!r})")
    except (OSError, ValueError) as e:
        sys.exit(f"Refused, nothing written: {e}")
    tmp = a.output.with_name(a.output.name + ".tmp")
    tmp.write_bytes(hex_tool.encode_compx_hex(image, base_addr=APP_BASE).encode("ascii"))
    os.replace(tmp, a.output)  # never a half-written .hex under the final name
    print(f"Wrote {a.output}: {len(image)} bytes at 0x{APP_BASE:08X}, sha256 {hashlib.sha256(image).hexdigest()}")


if __name__ == "__main__":
    main()
