# Conformance vectors

`scale_vectors.json` is generated from the C reference engine (`core/directional_dpi.c`)
by `tests/gen_vectors.c`. Any other implementation of Open Directional DPI v1 (firmware in
another language, a host filter, a web preview) should reproduce every entry exactly.
The OpenMouse TypeScript client is checked against it in
`integrations/openmouse/test/directional-dpi.test.ts`.

Regenerate after a core change, and commit the result:

```sh
make -C tests vectors
git diff -- tests/vectors   # empty unless the engine's output changed
```

## Format

```json
{
  "suite": "open-directional-dpi-v1/ddpi_compute_scale_q16_16",
  "vector_fields": ["dx", "dy", "scale_q16_16", "octant"],
  "profiles": [
    { "name": "...", "bytes": "<56 hex chars>", "vectors": [[dx, dy, scale_q16_16, octant], ...] }
  ]
}
```

- `bytes`: the 28-byte serialized v1 profile, little-endian, CRC included
  (layout in `spec/directional-dpi-v1.md`). Deserialize it (it must pass your CRC and bounds
  checks) and use the result for that profile's vectors.
- `dx`, `dy`: int16 HID deltas (+X right, +Y toward the user), including -32768.
- `scale_q16_16`: the unsigned Q16.16 output of `ddpi_compute_scale_q16_16(profile, dx, dy)`.
- `octant`: its `out_octant` (0..7; 0 for zero motion and for identity profiles).

The profiles cover identity, disabled, HID-CW and sensor-CCW frames with eight distinct
multipliers, the linear octant ratio flag, a non-unity global gain, the 16/1024 multiplier
extremes with a 45000 CPI base, and the calibration bypass flag. The grid takes every
(dx, dy) pair from ±{0, 1, 99, 100, 414, 1000, 12345, 32766, 32767} and -32768: axes,
exact and near diagonals, 1-count moves, int16 extremes and mixed magnitudes.
