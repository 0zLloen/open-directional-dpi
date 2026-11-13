# Calibration from aim trainers

The calibration turns flicks into 8 directional gains. For each flick it needs the direction of the target from where the flick started, and the trajectory in sensor counts, so it can find where the first (ballistic) movement stopped: past the target (overshoot, ratio > 1) or short of it (undershoot, ratio < 1). The gain for a direction is the inverse of its median ratio, smoothed across neighbours, with MAD outlier rejection (`core/`).

No aim trainer exports that per flick (see [What the trainers export](#what-the-trainers-export)), so the providers take the trajectory from a **raw mouse log** recorded while you play, and use the trainer only to set up the task and, for KovaaK's, to say which clicks were kills.

| Provider | Input | Use with |
| :--- | :--- | :--- |
| `mouse-log` | Mouse log | Aimlabs SpiderShot (the task Corsair PureVector calibrates with), or any task with static targets and one click per target |
| `kovaaks` | Mouse log + the run's `Stats.csv` | KovaaK's static clicking scenarios (one click per kill, e.g. 1wall 6targets). Keeps only kill-to-kill flicks with no missed click in between |
| `builtin` | Nothing to install | `providers/builtin/calibrate.html`, a center-out task in the browser that exports the profile itself |

## 1. Turn the current curve off

The log sees motion after the mouse (or host filter) applied its curve, and the output is absolute, so calibrate with the curve off. Glorious: `python3 tools/odd_profile.py reset` (RAM only, without `--save`). evdev: stop the filter.

## 2. Record a mouse log while you play

The log is MouseTester's CSV (counts per raw input event, ms timestamps, button flags).

- **Windows:** [MouseTester](https://github.com/microe1/MouseTester) (MIT). Press **Start (F1)**, switch to the trainer and play, switch back, **Stop (F2)**, **Save**. It keeps logging while the game has focus (raw input with `RIDEV_INPUTSINK`).
- **Linux** (native or Proton): `record-evdev.ts` writes the same format. It reads the mouse's event node without grabbing it, so it needs read access (root or the `input` group):

  ```bash
  node --experimental-strip-types calibration/providers/mouse-log/record-evdev.ts /dev/input/by-id/usb-<your mouse>-event-mouse > mouse-log.csv
  ```

  Stop it with Ctrl+C after the run.

Start the log just before the task and stop it right after. Clicks in menus become a few odd flicks that the outlier rejection drops; gaps over 1.5 s are ignored.

## 3. Play

- **Aimlabs:** SpiderShot. PureVector uses five rounds of it; aim for at least 10 flicks per direction (the CLI warns about directions with fewer than 5). Use `mouse-log`.
- **KovaaK's:** a static clicking scenario with a one-click weapon and no reload pauses (1wall 6targets small or similar). Play several runs in one log. Use `kovaaks` with each run's file from `steamapps/common/FPSAimTrainer/FPSAimTrainer/stats/` (`<Scenario> - Challenge - <date> Stats.csv`). A scenario with hold-to-fire or several hits per kill fails with "kills don't line up with clicks".
- **Anything else:** any task where each target is static and taken with one click. A miss splits a flick in two; enough misses make the result noisy.

Play at the DPI stage you want the profile for.

## 4. Make the profile

```bash
node --experimental-strip-types calibration/cli.ts mouse-log mouse-log.csv --dpi 800 > profile.json
node --experimental-strip-types calibration/cli.ts kovaaks mouse-log.csv "Run 1 Stats.csv" "Run 2 Stats.csv" --dpi 800 > profile.json
```

The profile JSON goes to stdout and a table to stderr: flicks per direction, median ratio, gain, and the DPI to run the sensor at.

| Option | |
| :--- | :--- |
| `--dpi N` | DPI you played at (required) |
| `--only-at-dpi` | Apply the curve only at that DPI stage, like PureVector (`onlyAtBaseDpi`; needs firmware that reports its DPI, e.g. the Glorious patch) |
| `--normalization mean-preserving` | Default. Average gain 1.00x: corrects direction differences without changing overall sensitivity |
| `--normalization cpi-headroom` | Gains scaled to ≤ 1.00x and `baseDpi` raised to match: set the sensor to the printed DPI. No direction gets 2-count steps |
| `--normalization none` | Absolute gains (a general over- or undershoot also changes overall sensitivity), like `calibrate.html` |

`baseDpi` in the JSON is the DPI to run the sensor at, and `windowCounts` follows it (DPI / 50.8, about 0.5 mm).

## 5. Load it onto the mouse

```bash
python3 tools/odd_profile.py load profile.json --save
```

Or import the file in OpenMouse (`importProfileJson`). For `--only-at-dpi`, the curve is active only while the mouse is on the `baseDpi` stage.

## What the trainers export

Checked 2026-11-13 against vendor docs, real files and community tools.

**KovaaK's.** `stats/<Scenario> - Challenge - <date> Stats.csv`: a kill list (`Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots`, wall-clock timestamps with milliseconds), a weapon line and summary key/value rows (sensitivity, DPI, FOV, resolution). No positions or crosshair path. `OverShots` counts full-auto bullets fired after a kill, not crosshair overshoot. Since 2026 a protobuf `.perf` file holds 1 Hz counters, also without positions ([wiki](https://wiki.kovaaks.com/home/KovaaK's/PerformanceFiles)). No replay or telemetry API. The terms forbid modifying the game, so in-game hooks (UE4SS mods) are out; reading the stats files is common practice (RefleK's, statsViewer, KovaaK-Visualizer).

**Aimlabs.** The local SQLite database (`klutch.bytes`) has `TaskData.performance` with aggregates only (shots, hits, kills, time per kill, accuracy). It also has 8-bin tables (`SpiderShotData` accuracy and reaction time per bin, `MyErrorData` gain/error/angle per bin) whose meaning is undocumented. Replays (`Replay/<playId>.avro`, crosshair path and target data) need a schema taken from the unofficial GraphQL API or from decompiling the game, which the [terms](https://aimlabs.com/terms-of-service) (§12, §15) forbid. Corsair PureVector runs inside Aimlabs for Corsair SABRE v3 PRO PureVector mice only and writes its result to `ASFSettings.json` (`directionalScalars`, 8 values); the only public reader of that file is a few days old and has no real sample. So `mouse-log` with SpiderShot is the route that needs nothing from Aimlabs' internals.

**AimFroge.** Does not exist: the name appeared only in this repo. Its old provider parsed an invented format and was removed, as were the old KovaaK's (`TargetDX,...` columns) and Aimlabs (`trials` JSON) parsers, whose formats no trainer writes.

**Others.** osu! replays (`.osr`, LZMA-compressed cursor frames) with beatmap hit-object positions would work for mouse players, but frames are at most 60 Hz in lazer and jumps are rhythmic rather than reactive. Aiming.Pro, 3D Aim Trainer, Aimbeast, aimtrainer.io and Human Benchmark export no per-shot data.
