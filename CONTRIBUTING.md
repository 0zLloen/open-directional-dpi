# Contributing to Open Directional Sensitivity (`open-directional-dpi`)

Thank you for contributing to an open, vendor-neutral standard and portable reference engine for directional mouse sensitivity.

## Repository Rules

1. **No Proprietary Vendor Binaries:**
   - Never commit extracted vendor `.exe`, `.dll`, or raw stock `.bin`/`.hex` firmware images. Stock images for the Glorious patch go in `adapters/stock/`, and its build output in `adapters/build/`; both are gitignored.
   - CI fails if a tracked file matches `.gitignore` (vendor executables, archives, firmware images, USB captures) or is binary.
   - Never publish or commit a built patched `.hex` / `.bin`, or any other vendor image: not in the repo, a release, an issue or a discussion. It contains Glorious's firmware. Each user builds it from their own stock image (`README.md`, Glorious patch notes).
   - Firmware and host ports live under `adapters/<target>/` and should provide source-level patches or modules, devicetree definitions, and reproducible build scripts that operate on user-supplied official firmware.
2. **Deterministic Fixed-Point Core (`core/`):**
   - `core/directional_dpi.c` and `core/directional_dpi.h` must remain zero-dependency C11 with no floating-point operations, so firmware and host builds produce the same output.
   - If a change alters engine output, regenerate the conformance vectors (`make -C tests vectors`), commit `tests/vectors/`, and keep the TypeScript mirror (`integrations/openmouse/src/directional-dpi.ts`) bit-exact with them.
3. **Verification Before Submitting:**
   - `make -C tests test` (17/17 C unit tests).
   - `make -C tests vectors && git diff --exit-code -- tests/vectors` (vectors still match the engine).
   - `node --experimental-strip-types --test integrations/openmouse/test/directional-dpi.test.ts` (20/20 OpenMouse suites, including parity with the 2592 C vectors and with `tools/odd_profile.py`, and the 2.4 GHz receiver; about 7.5 s; Node >= 22.6, `python3` on PATH).
   - `node --experimental-strip-types --test calibration/tests/*.test.ts` (calibration pipeline, trainer providers, CLI formats and the `calibrate.html` WebHID client; the QMK format test needs `cc`).
   - `npm ci && npx tsc -p tsconfig.json` (strict type-check of `integrations/openmouse` and `calibration`; `noUnusedLocals` and `noUnusedParameters` are on).
   - `python3 tools/test_odd_profile.py` (`odd_profile.py` device layer against a fake cable and receiver).
   - `make -C adapters/linux-evdev check` (evdev filter build and self-test).
   - `make -C adapters/glorious-cm2856 check` when touching `core/` or the patch (needs `arm-none-eabi-gcc`; fails on PATCH_ROM overflow, `.bss`/`.data`, libgcc helpers, or SRAM overlap with the bootloader magic word).
   - When changing `stock_ddpi_patch.c`, the hook addresses or the RF clamp: `python3 adapters/glorious-cm2856/build_and_verify_patch.py` with the stock image in `adapters/stock/` (or `--stock-hex <official or dumped .hex>`) and unicorn installed; all 10 tests must pass. Not in CI: the stock image is vendor firmware, so it cannot be committed, and at 93,328 B (58,712 B with `xz -9e`) it does not fit in a GitHub Actions secret (48 KB).
   - For `adapters/zephyr/`: `$ZEPHYR_BASE/scripts/twister -T adapters/zephyr/tests -p native_sim/native/64` (see `adapters/zephyr/README.md`).
   - CI runs all of the above except the full patch build (`.github/workflows/ci.yml`, `.github/workflows/zephyr.yml`).
