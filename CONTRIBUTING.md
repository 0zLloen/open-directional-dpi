# Contributing to Open Directional Sensitivity (`open-directional-dpi`)

Thank you for contributing to an open, vendor-neutral standard and portable reference engine for directional mouse sensitivity.

## Repository Rules

1. **No Proprietary Vendor Binaries:**
   - Never commit extracted vendor `.exe`, `.dll`, or raw stock `.bin`/`.hex` firmware images. Stock images for the Glorious patch go in `adapters/stock/`, and its build output in `adapters/build/`; both are gitignored.
   - Firmware and host ports live under `adapters/<target>/` and should provide source-level patches or modules, devicetree definitions, and reproducible build scripts that operate on user-supplied official firmware.
2. **Deterministic Fixed-Point Core (`core/`):**
   - `core/directional_dpi.c` and `core/directional_dpi.h` must remain zero-dependency C11 with no floating-point operations, so firmware and host builds produce the same output.
   - If a change alters engine output, regenerate the conformance vectors (`make -C tests vectors`), commit `tests/vectors/`, and keep the TypeScript mirror (`integrations/openmouse/src/directional-dpi.ts`) bit-exact with them.
3. **Verification Before Submitting:**
   - `make -C tests test` (16/16 C unit tests).
   - `make -C tests vectors && git diff --exit-code -- tests/vectors` (vectors still match the engine).
   - `node --experimental-strip-types --test integrations/openmouse/test/directional-dpi.test.ts` (17/17 OpenMouse suites, including parity with the 2592 C vectors; Node >= 22.6).
   - `node --experimental-strip-types --test calibration/tests/calibration.test.ts` (4/4 calibration suites).
   - `make -C adapters/linux-evdev check` (evdev filter build and self-test).
   - `make -C adapters/glorious-cm2856 check` when touching `core/` or the patch (needs `arm-none-eabi-gcc`; fails on PATCH_ROM overflow, `.bss`/`.data`, libgcc helpers, or SRAM overlap with the bootloader magic word).
   - For `adapters/zephyr/`: `$ZEPHYR_BASE/scripts/twister -T adapters/zephyr/tests -p native_sim/native/64` (see `adapters/zephyr/README.md`).
   - CI runs all of the above (`.github/workflows/ci.yml`, `.github/workflows/zephyr.yml`).
