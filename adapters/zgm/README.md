# Keychron ZGM / Zephyr RTOS Adapter (`adapters/zgm/`)

Integrates the portable C reference engine ([`core/directional_dpi.c`](../../core/directional_dpi.c)) into Zephyr-based high-polling gaming mouse firmwares (such as Keychron ZGM).

- Processes paired `(dx, dy)` sensor burst samples directly before USB High-Speed / 2.4 GHz report framing.
- Automatically resets the travel-window direction estimator (`ddpi_engine_notify_idle`) after `>= 50 ms` of sensor inactivity so new flicks never inherit stale direction history.
