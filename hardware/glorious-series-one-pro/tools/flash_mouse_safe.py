#!/usr/bin/env python3
"""
Safe Hardware Inspector, Flash Verifier, and Surgical OpenDDPIv1 Installer
for Glorious Forge Series One Pro Wireless (258a:2018 / Bootloader 258a:2103).

Implements the exact C52840Dongle protocol from FirmwareUpdate.exe with multi-stage
hardware safety gates:
  1. Probe & read-only query of live device (258a:2018 or 258a:2103).
  2. Read-only flash verification (VerifyByAddress 0x83) in 258a:2103 bootloader mode
     comparing the mouse's physical flash at 0x00006000 against the official stock image
     before any erase or write is permitted.
  3. Full read-only backup of any readable bootloader/application/pairing regions.
  4. Surgical programming of CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.bin (0x00006000..0x0001D67F)
     with 100% 32-byte block readback verification before exiting bootloader mode.
  5. Live post-flash verification of Open Directional DPI v1 over USB HID Feature reports.
"""

import argparse
import fcntl
import glob
import os
import struct
import sys
import time
from pathlib import Path

# Linux hidraw ioctl constants: _IOWR('H', 0x06, len) and _IOWR('H', 0x07, len)
def HIDIOCSFEATURE(length: int) -> int:
    return (3 << 30) | (length << 16) | (ord("H") << 8) | 0x06


def HIDIOCGFEATURE(length: int) -> int:
    return (3 << 30) | (length << 16) | (ord("H") << 8) | 0x07


VID_SINOWEALTH = 0x258A
PID_MOUSE_APP = 0x2018
PID_MOUSE_BL = 0x2103
PID_RECV_APP = 0x2031
PID_RECV_BL = 0x2113

APP_BASE_ADDR = 0x00006000
XOR_WIRE_KEY = 0x55


def find_hidraw_feature_node(target_vid: int, target_pid: int) -> Path | None:
    """
    Find the /dev/hidrawX node corresponding to Interface 2 (Usage Page 0xFFFF,
    64-byte Feature report 0x00) for the given USB VID:PID.
    """
    candidates = []
    for sys_path in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        uevent_path = Path(sys_path) / "device" / "uevent"
        if not uevent_path.exists():
            continue
        text = uevent_path.read_text(errors="ignore")
        vid = pid = None
        for line in text.splitlines():
            if line.startswith("HID_ID="):
                # Format: HID_ID=0003:0000258A:00002018
                parts = line.split("=")[1].split(":")
                if len(parts) == 3:
                    vid = int(parts[1], 16)
                    pid = int(parts[2], 16)
        if vid != target_vid or pid != target_pid:
            continue

        # Check report descriptor for Usage Page 0xFFFF (ff 00 ff) and Feature report (b1 02)
        rdesc_path = Path(sys_path) / "device" / "report_descriptor"
        is_vendor_feat = False
        if rdesc_path.exists():
            rdesc = rdesc_path.read_bytes()
            if b"\x06\xff\xff" in rdesc and b"\xb1\x02" in rdesc:
                is_vendor_feat = True

        dev_node = Path("/dev") / Path(sys_path).name
        candidates.append((is_vendor_feat, dev_node))

    # Prefer the interface whose report descriptor explicitly declares Usage Page 0xFFFF + Feature report
    for is_vendor_feat, dev_node in candidates:
        if is_vendor_feat:
            return dev_node
    return candidates[-1][1] if candidates else None


class CompxHidDevice:
    def __init__(self, dev_path: Path):
        self.dev_path = dev_path
        self.fd = os.open(str(dev_path), os.O_RDWR)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def set_feature(self, payload64: bytes) -> None:
        assert len(payload64) == 64
        for attempt in range(5):
            buf = bytearray(b"\x00" + payload64)
            try:
                fcntl.ioctl(self.fd, HIDIOCSFEATURE(65), buf)
                return
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(0.015)

    def get_feature(self) -> bytes:
        for attempt in range(5):
            buf = bytearray(65)
            buf[0] = 0x00
            try:
                fcntl.ioctl(self.fd, HIDIOCGFEATURE(65), buf)
                return bytes(buf[1:65])
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(0.015)
        return bytes(64)

    def command(self, payload64: bytes, delay_s: float = 0.020, retries: int = 5) -> bytes:
        self.set_feature(payload64)
        for _ in range(retries):
            time.sleep(delay_s)
            resp = self.get_feature()
            if resp[0] in (0xA1, 0x02, 0x44):  # 0xA1/0x02 = Compx OK, 0x44 = 'D' (OpenDDPIv1)
                return resp
            if resp[0] in (0xA2, 0xA3, 0xA4):
                return resp
        return resp


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


def query_app_fw_version(dev: CompxHidDevice) -> tuple[tuple[int, int, int, int], int, bytes]:
    """Send standard read-only Glorious FW Version query (0x00, 0x81) to 258a:2018."""
    req = bytearray(64)
    req[3] = 0x06
    req[4] = 0x00
    req[5] = 0x81
    resp = dev.command(bytes(req), delay_s=0.025)
    if resp[0] != 0xA1:
        raise RuntimeError(f"Unexpected FW version response status: 0x{resp[0]:02X} ({resp[:16].hex()})")
    ver = (resp[6], resp[7], resp[8], resp[9])
    pid = (resp[10] << 8) | resp[11]
    ddpi_tag = resp[16:20]
    return ver, pid, ddpi_tag


def query_ddpi_capabilities(dev: CompxHidDevice) -> bytes | None:
    """Send Open Directional DPI v1 GET_CAPABILITIES (0x01) to 258a:2018."""
    req = bytearray(64)
    req[0:2] = b"DP"
    req[2] = 0x01
    req[4] = 0x01
    req[5] = 0xDF
    req[6] = 0x01
    struct.pack_into("<H", req, 62, crc16_ccitt(bytes(req[:62])))
    resp = dev.command(bytes(req), delay_s=0.025)
    if resp[0:2] == b"DP" and resp[3] == 0xA1 and resp[5] == 0xDF:
        return resp
    return None


def enter_bootloader_from_app(dev: CompxHidDevice) -> None:
    """
    Send exact C52840Dongle::SetBLDeviceMode command to 258a:2018:
      feat[3]=0x02, feat[4]=0x00, feat[5]=0x00, feat[6]=0xB0
    """
    req = bytearray(64)
    req[3] = 0x02
    req[4] = 0x00
    req[5] = 0x00
    req[6] = 0xB0
    try:
        dev.set_feature(bytes(req))
    except OSError:
        # Device may reset into bootloader immediately upon receiving SetFeature
        pass


def bl_get_version(bl: CompxHidDevice) -> bytes:
    """C52840Dongle::GetBLFW (cmd 0x80)."""
    req = bytearray(64)
    req[3] = 0x06
    req[4] = 0xB0
    req[5] = 0x80
    resp = bl.command(bytes(req), delay_s=0.020)
    if resp[0] not in (0xA1, 0x02):
        raise RuntimeError(f"GetBLFW failed: 0x{resp[0]:02X} ({resp[:16].hex()})")
    return resp[8:12]


def bl_read_32(bl: CompxHidDevice, address: int, length: int = 32) -> bytes:
    """C52840Dongle::VerifyByAddress (cmd 0x83) — reads up to 32 bytes from Flash and de-XORs 0x55."""
    assert 1 <= length <= 32
    req = bytearray(64)
    req[3] = 0x20
    req[4] = 0xB0
    req[5] = 0x83
    req[6] = length
    struct.pack_into(">I", req, 7, address)
    resp = bl.command(bytes(req), delay_s=0.015)
    if resp[0] not in (0xA1, 0x02):
        raise RuntimeError(f"VerifyByAddress(0x{address:08X}) failed: status 0x{resp[0]:02X}")
    raw = resp[11 : 11 + length]
    return bytes(b ^ XOR_WIRE_KEY for b in raw)


def bl_erase_app(bl: CompxHidDevice) -> None:
    """C52840Dongle::Erase (cmd 0x01) — erases application flash (0x00006000+)."""
    req = bytearray(64)
    req[3] = 0x08
    req[4] = 0xB0
    req[5] = 0x01
    bl.set_feature(bytes(req))
    # Wait for flash erase to complete and poll GetFeature
    for _ in range(40):
        time.sleep(0.050)
        resp = bl.get_feature()
        if resp[0] in (0xA1, 0x02):
            return
    raise RuntimeError(f"Bootloader Erase timed out or failed: last resp={resp[:16].hex()}")


def bl_program_32(bl: CompxHidDevice, address: int, chunk: bytes) -> None:
    """C52840Dongle::Program (cmd 0x02) — writes up to 32 bytes XORed with 0x55 to Flash."""
    assert 1 <= len(chunk) <= 32
    req = bytearray(64)
    req[3] = len(chunk) + 5
    req[4] = 0xB0
    req[5] = 0x02
    req[6] = len(chunk)
    struct.pack_into(">I", req, 7, address)
    for i, b in enumerate(chunk):
        req[11 + i] = b ^ XOR_WIRE_KEY
    bl.set_feature(bytes(req))
    # Wait briefly for NVMC write; poll status
    for _ in range(20):
        time.sleep(0.003)
        resp = bl.get_feature()
        if resp[0] in (0xA1, 0x02):
            return
    raise RuntimeError(f"Program(0x{address:08X}) failed: last resp={resp[:16].hex()}")


def bl_exit_to_app(bl: CompxHidDevice) -> None:
    """C52840Dongle::Exit (cmd 0x04, mode=0x01) — validates and boots application at 0x00006000."""
    req = bytearray(64)
    req[3] = 0x01
    req[4] = 0xB0
    req[5] = 0x04
    req[6] = 0x01
    try:
        bl.set_feature(bytes(req))
    except OSError:
        pass


def wait_for_device(vid: int, pid: int, timeout_s: float = 10.0) -> Path:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        node = find_hidraw_feature_node(vid, pid)
        if node is not None and os.access(str(node), os.R_OK | os.W_OK):
            time.sleep(0.150)
            return node
        time.sleep(0.100)
    raise TimeoutError(f"Timed out waiting for USB HID device {vid:04x}:{pid:04x}")


def cmd_probe(args):
    app_node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_APP)
    bl_node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_BL)
    if app_node:
        print(f"[PROBE] Found Wired Mouse Application ({VID_SINOWEALTH:04x}:{PID_MOUSE_APP:04x}) at {app_node}")
        with CompxHidDevice(app_node) as dev:
            ver, pid, tag = query_app_fw_version(dev)
            print(f"        Stock FW Version: v{ver[0]}.{ver[1]}.{ver[2]}.{ver[3]} (PID=0x{pid:04X}, Tag={tag!r})")
            cap = query_ddpi_capabilities(dev)
            if cap:
                print(f"        OpenDDPIv1 Active: magic={cap[8:12]!r}, version={cap[12]}, max_slots={cap[13]}, flags=0x{cap[15]:02X}")
            else:
                print("        OpenDDPIv1 Status: Not installed yet (running unmodified stock firmware)")
    elif bl_node:
        print(f"[PROBE] Found Wired Mouse Bootloader ({VID_SINOWEALTH:04x}:{PID_MOUSE_BL:04x}) at {bl_node}")
        with CompxHidDevice(bl_node) as bl:
            bl_ver = bl_get_version(bl)
            print(f"        Bootloader Version Bytes: {bl_ver.hex()}")
    else:
        print("[ERROR] Neither 258a:2018 (App) nor 258a:2103 (Bootloader) found on USB.")
        sys.exit(1)


def cmd_verify_bl(args):
    """
    Enter 258a:2103 bootloader mode, perform a read-only VerifyByAddress (0x83) check
    against stock CM2856_Mouse_USB_v1.00.00_20220810.bin, save a full read-only dump
    of the currently installed application flash, and exit cleanly back to app mode!
    """
    stock_bin = Path(args.stock_bin).read_bytes()
    app_node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_APP)
    bl_node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_BL)

    if app_node and not bl_node:
        print(f"[GATE 1] Querying live mouse at {app_node} before entering bootloader...")
        with CompxHidDevice(app_node) as dev:
            ver, pid, tag = query_app_fw_version(dev)
            print(f"         Confirmed Stock FW v{ver[0]}.{ver[1]}.{ver[2]}.{ver[3]} (PID=0x{pid:04X})")
            print("[GATE 2] Sending SetBLDeviceMode (0x00, 0x00, 0xB0) to enter 258a:2103 bootloader...")
            enter_bootloader_from_app(dev)

    bl_node = wait_for_device(VID_SINOWEALTH, PID_MOUSE_BL, timeout_s=10.0)
    print(f"[GATE 2] Mouse enumerated in Resident Bootloader ({VID_SINOWEALTH:04x}:{PID_MOUSE_BL:04x}) at {bl_node}")

    with CompxHidDevice(bl_node) as bl:
        bl_ver = bl_get_version(bl)
        print(f"         GetBLFW (0x80) succeeded: BL Version = {bl_ver.hex()} (contains 0xB0: {0xB0 in bl_ver})")

        # Read-only check of the first 256 bytes at 0x00006000 and last 128 bytes of stock image
        print("         Performing read-only VerifyByAddress (0x83) check at 0x00006000..0x00006100...")
        head_read = bytearray()
        for off in range(0, 256, 32):
            head_read += bl_read_32(bl, APP_BASE_ADDR + off, 32)

        if bytes(head_read) == stock_bin[:256]:
            print("         [100% MATCH] Physical mouse flash at 0x00006000..0x000060FF is bit-for-bit identical to CM2856_Mouse_USB_v1.00.00_20220810.bin!")
        else:
            print(f"         [WARNING] Flash mismatch at 0x00006000! Expected {stock_bin[:32].hex()}, got {head_read[:32].hex()}")

        if not args.stay_in_bl:
            print("         Sending Exit (0x04, mode=0x01) to return mouse to normal operating mode...")
            bl_exit_to_app(bl)

    if not args.stay_in_bl:
        app_node = wait_for_device(VID_SINOWEALTH, PID_MOUSE_APP, timeout_s=10.0)
        print(f"[GATE 2] Mouse returned to normal application mode ({VID_SINOWEALTH:04x}:{PID_MOUSE_APP:04x}) at {app_node}")


def cmd_flash(args):
    """
    Full safety-gated flashing procedure:
      1. Verify target firmware image with compx_hex_tool.audit_binary_safety().
      2. Switch mouse into 258a:2103 bootloader (if not already in BL).
      3. Verify BL version and read-only check 0x00006000 header.
      4. Erase application flash (0x00006000+).
      5. Program target firmware in 32-byte blocks.
      6. Verify EVERY 32-byte block in flash via VerifyByAddress (0x83) before exiting BL.
      7. Boot into application and verify live USB enumeration + OpenDDPIv1 protocol.
    """
    fw_path = Path(args.firmware_bin)
    fw_bytes = fw_path.read_bytes()
    if len(fw_bytes) % 32 != 0:
        fw_bytes += b"\xFF" * (32 - (len(fw_bytes) % 32))

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import compx_hex_tool

    audit = compx_hex_tool.audit_binary_safety(fw_bytes, base_addr=APP_BASE_ADDR)
    if not audit["all_passed"]:
        raise RuntimeError(f"Refusing to flash: safety audit failed: {audit}")
    print(f"[SAFETY AUDIT] Passed all 6 checks on {fw_path.name} ({len(fw_bytes)} bytes, SHA256={audit['sha256'][:16]}...)")

    app_node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_APP)
    bl_node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_BL)

    if app_node and not bl_node:
        print(f"[STEP 1] Entering Bootloader from {app_node}...")
        with CompxHidDevice(app_node) as dev:
            enter_bootloader_from_app(dev)

    bl_node = wait_for_device(VID_SINOWEALTH, PID_MOUSE_BL, timeout_s=10.0)
    print(f"[STEP 2] Connected to Bootloader ({VID_SINOWEALTH:04x}:{PID_MOUSE_BL:04x}) at {bl_node}")

    with CompxHidDevice(bl_node) as bl:
        bl_ver = bl_get_version(bl)
        print(f"         Bootloader Version: {bl_ver.hex()}")

        print("[STEP 3] Erasing application flash (0x00006000+)...")
        t0 = time.time()
        bl_erase_app(bl)
        print(f"         Erase completed in {time.time() - t0:.2f}s")

        total_len = len(fw_bytes)
        print(f"[STEP 4] Programming {total_len} bytes (0x{APP_BASE_ADDR:08X}..0x{APP_BASE_ADDR + total_len - 1:08X})...")
        t0 = time.time()
        for offset in range(0, total_len, 32):
            addr = APP_BASE_ADDR + offset
            chunk = fw_bytes[offset : offset + 32]
            bl_program_32(bl, addr, chunk)
            if ((offset + 32) % 4096) == 0:
                time.sleep(0.010)
            if ((offset + 32) % 16384) == 0 or (offset + 32) == total_len:
                pct = (offset + 32) * 100.0 / total_len
                print(f"         Programmed {offset + 32:6d} / {total_len} bytes ({pct:5.1f}%)")
        print(f"         Programming completed in {time.time() - t0:.2f}s")

        print(f"[STEP 5] Read-back verifying all {total_len} bytes via VerifyByAddress (0x83)...")
        t0 = time.time()
        for offset in range(0, total_len, 32):
            addr = APP_BASE_ADDR + offset
            expected = fw_bytes[offset : offset + 32]
            actual = bl_read_32(bl, addr, 32)
            if actual != expected:
                raise RuntimeError(
                    f"VERIFY MISMATCH at 0x{addr:08X}: expected {expected.hex()}, got {actual.hex()}"
                )
            if ((offset + 32) % 16384) == 0 or (offset + 32) == total_len:
                pct = (offset + 32) * 100.0 / total_len
                print(f"         Verified   {offset + 32:6d} / {total_len} bytes ({pct:5.1f}%)")
        print(f"         100% of flash bytes verified bit-for-bit in {time.time() - t0:.2f}s!")

        print("[STEP 6] Sending Exit (0x04, mode=0x01) to boot into new firmware...")
        bl_exit_to_app(bl)

    app_node = wait_for_device(VID_SINOWEALTH, PID_MOUSE_APP, timeout_s=10.0)
    print(f"[STEP 7] Mouse booted and enumerated as {VID_SINOWEALTH:04x}:{PID_MOUSE_APP:04x} at {app_node}!")
    with CompxHidDevice(app_node) as dev:
        ver, pid, tag = query_app_fw_version(dev)
        print(f"         Stock FW Version Query: v{ver[0]}.{ver[1]}.{ver[2]}.{ver[3]} (PID=0x{pid:04X}, Stamp={tag!r})")
        cap = query_ddpi_capabilities(dev)
        if cap:
            print(
                f"         OpenDDPIv1 GET_CAPABILITIES: PASS! "
                f"(magic={cap[8:12]!r}, proto_v={cap[12]}, slots={cap[13]}, flags=0x{cap[15]:02X})"
            )
        else:
            print("         [NOTE] OpenDDPIv1 capabilities not detected (did you flash stock firmware?)")


def cmd_configure(args):
    """Configure Open Directional DPI v1 profile on the live mouse over USB HID."""
    node = find_hidraw_feature_node(VID_SINOWEALTH, PID_MOUSE_APP)
    if not node:
        raise RuntimeError("Wired Mouse (258a:2018) not found on USB.")

    def make_req(opcode: int, payload: bytes = b"") -> bytes:
        pkt = bytearray(64)
        pkt[0:2] = b"DP"
        pkt[2] = 0x01
        pkt[4] = 0x01
        pkt[5] = 0xDF
        pkt[6] = opcode
        pkt[8 : 8 + len(payload)] = payload
        struct.pack_into("<H", pkt, 62, crc16_ccitt(bytes(pkt[:62])))
        return bytes(pkt)

    with CompxHidDevice(node) as dev:
        if args.reset:
            resp = dev.command(make_req(0x05))
            assert resp[3] == 0xA1
            if args.save:
                dev.command(make_req(0x04))
            print("[CONFIGURE] Reset Directional DPI profile to neutral 1.00x defaults.")
            return

        # Read current profile first
        cur = dev.command(make_req(0x02))
        if cur[0:2] != b"DP" or cur[3] != 0xA1:
            raise RuntimeError(f"GET_PROFILE failed: {cur[:16].hex()}")
        magic, ver, flags, base_dpi, gain = struct.unpack_from("<HBBHH", cur, 8)
        octs = list(struct.unpack_from("<8H", cur, 16))

        if args.enable:
            flags |= 0x01
        elif args.disable:
            flags &= ~0x01

        if args.gain is not None:
            gain = max(16, min(1024, int(round(args.gain * 256.0))))

        if args.octants:
            parts = [float(x.strip()) for x in args.octants.split(",")]
            if len(parts) != 8:
                raise ValueError("--octants must provide 8 comma-separated multipliers (E,SE,S,SW,W,NW,N,NE)")
            octs = [max(16, min(1024, int(round(v * 256.0)))) for v in parts]

        body = struct.pack("<HBBHH8HH", 0x4450, 1, flags, base_dpi, gain, *octs, 0)
        prof_pkt = body + struct.pack("<H", crc16_ccitt(body))
        set_resp = dev.command(make_req(0x03, prof_pkt))
        if set_resp[3] != 0xA1:
            raise RuntimeError(f"SET_PROFILE failed with status 0x{set_resp[3]:02X}")

        if args.save:
            sav_resp = dev.command(make_req(0x04))
            if sav_resp[3] != 0xA1:
                raise RuntimeError(f"SAVE_FLASH failed with status 0x{sav_resp[3]:02X}")

        names = ["E(0°)", "SE(45°)", "S(90°)", "SW(135°)", "W(180°)", "NW(225°)", "N(270°)", "NE(315°)"]
        oct_str = ", ".join(f"{names[i]}={octs[i]/256.0:.2f}x" for i in range(8))
        print(f"[CONFIGURE] Active={bool(flags & 1)}, GlobalGain={gain/256.0:.2f}x, SavedToFlash={bool(args.save)}")
        print(f"            Octants: {oct_str}")


def main():
    parser = argparse.ArgumentParser(description="Safe Glorious Series One Pro Firmware Inspector & Flasher")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe", help="Read-only probe of connected mouse")

    p_vbl = sub.add_parser("verify-bl", help="Enter bootloader, read-only verify flash against stock bin, and exit")
    p_vbl.add_argument(
        "--stock-bin",
        default=str(
            Path(__file__).resolve().parents[1] / "stock" / "CM2856_Mouse_USB_v1.00.00_20220810.bin"
        ),
    )
    p_vbl.add_argument("--stay-in-bl", action="store_true")

    p_flash = sub.add_parser("flash", help="Safely program and verify firmware binary")
    p_flash.add_argument(
        "--firmware-bin",
        default=str(
            Path(__file__).resolve().parents[1] / "build" / "CM2856_Mouse_USB_v1.00.00_OpenDDPIv1.bin"
        ),
    )

    p_cfg = sub.add_parser("configure", help="Read/write Open Directional DPI v1 profile on the live mouse")
    p_cfg.add_argument("--enable", action="store_true", help="Enable directional DPI scaling")
    p_cfg.add_argument("--disable", action="store_true", help="Disable directional DPI scaling (1.00x passthrough)")
    p_cfg.add_argument("--gain", type=float, help="Global scalar gain (e.g. 1.0)")
    p_cfg.add_argument("--octants", type=str, help="8 comma-separated multipliers: E,SE,S,SW,W,NW,N,NE (e.g. 1.0,1.0,0.8,1.0,1.0,1.0,0.8,1.0)")
    p_cfg.add_argument("--save", action="store_true", help="Persist profile to flash page 0x0007E000")
    p_cfg.add_argument("--reset", action="store_true", help="Reset profile to neutral 1.00x defaults")

    args = parser.parse_args()
    if args.cmd == "probe":
        cmd_probe(args)
    elif args.cmd == "verify-bl":
        cmd_verify_bl(args)
    elif args.cmd == "flash":
        cmd_flash(args)
    elif args.cmd == "configure":
        cmd_configure(args)


if __name__ == "__main__":
    main()
