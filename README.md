# Cap

A minimal, raw data-limiting GNOME Shell extension. Cap lives in the top bar,
tracks daily Wi-Fi telemetry via `/proc/net/dev`, visualizes state in a
dropdown, and terminates the Wi-Fi interface with `nmcli` the moment the daily
limit is exhausted.

Targeted at GNOME Shell 45+ using modern ESM imports. Developed and tested on
GNOME Shell 48.

## Behavior

- **Telemetry**: `/proc/net/dev` is read once per second; receive and transmit
  byte deltas are summed (`Δ_total = Δ_rx + Δ_tx`) and accumulated into
  `used-bytes` for every wireless interface matching `/^wl/`.
- **Cutoff**: when `used-bytes ≥ daily-limit-mb × 1048576`, Cap
  1. stops accumulating deltas,
  2. emits a desktop notification (`Limit exceeded. Interface terminated.`),
  3. runs `nmcli radio wifi off` asynchronously.
- **Day rollover** (midnight): `used-bytes` resets to 0 and the exhaustion flag
  clears, but **Wi-Fi is intentionally left off**. Re-enable it from the
  dropdown, the preferences window, or GNOME quick settings.
- **Re-enabling**: raising the limit above current usage (slider or entry)
  automatically runs `nmcli radio wifi on` and resumes counting. There is also
  a dedicated *Re-enable Wi-Fi* button in the dropdown that appears only while
  Cap is holding the interface off.

## Top bar

- Standard state: `↓ {rx rate} ↑ {tx rate}` (e.g. `↓ 4.2 MB/s ↑ 120 KB/s`).
- Warning state: the label shifts to the system warning color once usage
  crosses 90% of the daily limit.

## Dropdown panel

```
+----------------------------------------+
| Cap: Daily Data Status                 |
| 742 MB / 1024 MB Used                  |
| [██████████████████████░░░░░░░░] (72%) |
| Limit:  [---------o----------]         |
| Value:  [ 1024 ] MB                    |
| [ Re-enable Wi-Fi ]   (after cutoff)   |
+----------------------------------------+
```

The slider maps 100 MB – 50,000 MB; the integer entry accepts the same range.
Both write through to GSettings instantly.

## Settings

GSettings schema `org.gnome.shell.extensions.cap`:

| Key              | Type | Default | Notes                                            |
|------------------|------|---------|--------------------------------------------------|
| `daily-limit-mb` | `i`  | `1024`  | Range 100 – 50,000.                              |
| `used-bytes`     | `x`  | `0`     | Auto-resets to 0 at midnight.                    |
| `current-date`   | `s`  | `""`    | Tracked day (`YYYY-MM-DD`) for rollover detection.|

## Install

```sh
# 1. Compile the GSettings schema.
glib-compile-schemas /home/anorak/Cap/schemas

# 2. Symlink (or copy) into the per-user extensions directory.
ln -sf /home/anorak/Cap ~/.local/share/gnome-shell/extensions/cap@anorak

# 3. Enable, then restart the shell.
gnome-extensions enable cap@anorak
# X11:  Alt+F2 → r → Enter
# Wayland: log out and back in
```

`nmcli` must be on `$PATH` (shipped with NetworkManager).

## Files

- `extension.js` — indicator, telemetry loop, state machine, dropdown UI.
- `prefs.js` — libadwaita preferences window (limit + usage reset).
- `schemas/org.gnome.shell.extensions.cap.gschema.xml` — settings keys.
- `stylesheet.css` — popup widget styling.

## License

GPL-3.0-or-later.
