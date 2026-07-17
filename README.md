# Cap

A minimal GNOME Shell extension that caps your daily Wi-Fi data usage. Cap
tracks traffic via `/proc/net/dev`, shows live rates in the top bar, and
terminates the Wi-Fi interface with `nmcli` the moment the daily limit is
reached.

GNOME Shell 45+ (ESM imports). Tested on GNOME 48.

## Install

### From extensions.gnome.org

Install from the [GNOME Extensions website](https://extensions.gnome.org/extension/7299/cap/).

### From source

```sh
git clone https://github.com/anorak999/Cap.git
cd Cap
./install.sh      # compiles schemas, symlinks, and enables
```

Restart GNOME Shell to load:

- **Wayland** — log out and back in.
- **X11** — `Alt+F2` → `r` → `Enter`.

To remove:

```sh
./uninstall.sh
```

## How it works

- **Telemetry** — `/proc/net/dev` is read once per second. Receive and
  transmit deltas are summed (`rx + tx`) and accumulated per wireless
  interface matching `/^wl/`.
- **Cutoff** — when usage exceeds the daily limit, Cap emits a notification
  and runs `nmcli radio wifi off`.
- **Midnight rollover** — usage resets to 0. Wi-Fi stays off; re-enable it
  from the dropdown or GNOME quick settings.
- **Re-enable** — raise the limit above current usage, or press the
  *Re-enable Wi-Fi* button.

## Top bar

Shows `↓ {rx} ↑ {tx}` live rates. Turns amber at 90% of the daily limit.

## Dropdown styles

Three switchable panel styles in `gnome-extensions prefs cap@anorak`:

| Style | Description |
|-------|-------------|
| **Default** | Progress bar, slider, numeric entry. |
| **Orbit** | Ring gauge with card-style limit control. |
| **Strata** | Flat row-list with inline bar and status pill. |

## Settings

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `daily-limit-mb` | `i` | `1024` | 100 – 50,000 MB |
| `used-bytes` | `x` | `0` | Resets at midnight |
| `current-date` | `s` | `""` | Tracked day (`YYYY-MM-DD`) |
| `popup-style` | `s` | `"default"` | `default`, `orbit`, or `strata` |

## Requirements

- GNOME Shell 45+
- `nmcli` on `$PATH` (ships with NetworkManager)

## License

GPL-3.0-or-later.
