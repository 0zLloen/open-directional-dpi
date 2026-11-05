# Contributing to Open Directional Sensitivity (`open-directional-dpi`)

Thank you for contributing to an open, vendor-neutral standard and portable reference engine for directional mouse sensitivity.

## Repository Rules

1. **No Proprietary Vendor Binaries:**
   - Never commit extracted vendor `.exe`, `.dll`, or raw stock `.bin`/`.hex` firmware images.
   - Hardware ports under `hardware/<device>/` should provide source-level patches, devicetree definitions, and reproducible build scripts that operate on user-supplied official update archives.
2. **Deterministic Fixed-Point Core (`core/`):**
   - `core/directional_dpi.c` and `core/directional_dpi.h` must remain zero-dependency C11 with no floating-point instructions so they compile identically on ARM Cortex-M0+/M4, RISC-V, Linux `evdev`/`uinput`, and WebAssembly.
3. **Verification Before Submitting:**
   - Run `make -C tests test` (`12/12` C unit & golden vector tests).
   - Run `make -C adapters/linux-evdev` (Linux host filter build check).
   - Run `node --experimental-strip-types --test integrations/openmouse/test/directional-dpi.test.ts` (`6/6` TypeScript bit-exact parity & protocol suites).
