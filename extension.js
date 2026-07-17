/*
 * Cap — a minimal, raw data-limiting GNOME Shell extension.
 *
 * Runs in the top bar, tracks daily Wi-Fi telemetry via /proc/net/dev on a
 * 1-second loop, visualizes state in a dropdown, and terminates the Wi-Fi
 * interface through nmcli immediately upon threshold exhaustion.
 *
 * Target: GNOME Shell 45+ (ESM imports).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const BYTES_PER_MB = 1048576;
const MIN_LIMIT_MB = 100;
const MAX_LIMIT_MB = 50000;
const WARN_FRACTION = 0.90;

/* /proc/net/dev column indices (0-based, within the post-colon fields).
 * Layout: "iface: rx_bytes rx_packets errs drop fifo frame compressed
 *          multicast | tx_bytes tx_packets errs drop fifo colls carrier
 *          compressed" — 16 fields total. rx_bytes is field 0, tx_bytes is
 * field 8. */
const TX_BYTE_COLUMN = 8;

// Reused across ticks — TextDecoder is stateless and safe to share.
const decoder = new TextDecoder();

/**
 * Top-bar indicator + dropdown for Cap.
 *
 * Two transient flags govern the cutoff state machine:
 *   _exhausted          — while set, the loop skips delta accumulation and
 *                         threshold re-checking (prevents notify/nmcli spam).
 *                         Cleared on midnight reset or on re-enable.
 *   _wifiDisabledByCap  — true while Cap is holding Wi-Fi off. Cleared only
 *                         when Cap turns it back on.
 */
const CapIndicator = GObject.registerClass(
class CapIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Cap'), false);

        this._extension = extension;
        this._settings = extension.getSettings();

        this._exhausted = false;
        this._wifiDisabledByCap = false;

        // Telemetry baseline; first tick seeds these without adding a delta.
        this._haveBaseline = false;
        this._prevRx = 0;
        this._prevTx = 0;

        // Cached values to avoid repeated GSettings IPC every tick.
        this._cachedLimitMb = this._settings.get_int('daily-limit-mb');
        this._cachedToday = '';
        this._isWarning = false;

        this._timeoutId = null;
        this._settingsHandlerId = null;

        this._buildTopbar();
        this._buildPopup();

        // React to limit changes so a raised limit re-enables Wi-Fi if usage
        // now fits under it.
        this._settingsHandlerId = this._settings.connect(
            'changed::daily-limit-mb', this._onLimitChanged.bind(this));

        // Seed the day boundary so the very first tick doesn't falsely trip
        // a "new day" reset and wipe prior usage.
        this._ensureToday();
    }

    /* ------------------------------------------------------------------ *
     * UI construction
     * ------------------------------------------------------------------ */

    _buildTopbar() {
        this._panelLabel = new St.Label({
            text: '↓ 0 B/s  ↑ 0 B/s',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cap-panel-label',
        });
        this.add_child(this._panelLabel);
    }

    _buildPopup() {
        const section = new PopupMenu.PopupMenuSection();

        // Title.
        this._titleLabel = new St.Label({
            text: _('Cap: Daily Data Status'),
            style_class: 'cap-readout',
        });
        const titleBox = new St.BoxLayout({
            vertical: true,
            style_class: 'cap-usage-line',
        });
        titleBox.add_child(this._titleLabel);
        section.add(titleBox);

        // Usage line: "742 MB / 1024 MB Used".
        this._usageLabel = new St.Label({text: '0 MB / 0 MB Used'});
        section.add(this._usageLabel);

        // Inline usage bar (0..1) bound to used/limit.
        this._bar = new BarLevel.BarLevel({
            value: 0,
            maximumValue: 1.0,
            style_class: 'cap-bar barlevel',
        });
        section.add(this._bar);

        section.addSpacer(12);

        // Limit slider (0..1 normalized to MIN..MAX).
        const sliderBox = new St.BoxLayout({style_class: 'cap-limit-row'});
        const sliderCaption = new St.Label({
            text: _('Limit:'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new Slider.Slider(this._limitToFraction(
            this._settings.get_int('daily-limit-mb')));
        this._slider.x_expand = true;
        this._slider.connect('notify::value', this._onSliderDragged.bind(this));
        this._slider.connect('drag-end', this._onSliderCommitted.bind(this));
        sliderBox.add_child(sliderCaption);
        sliderBox.add_child(this._slider);
        section.add(sliderBox);

        // Direct integer entry.
        const entryBox = new St.BoxLayout({style_class: 'cap-limit-row'});
        const entryCaption = new St.Label({
            text: _('Value:'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry = new St.Entry({
            text: String(this._settings.get_int('daily-limit-mb')),
            input_hint: 'number',
            x_expand: true,
            style_class: 'cap-value-entry',
        });
        this._entry.clutter_text.connect('activate', this._onEntryCommitted.bind(this));
        const mbCaption = new St.Label({
            text: _('MB'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        entryBox.add_child(entryCaption);
        entryBox.add_child(this._entry);
        entryBox.add_child(mbCaption);
        section.add(entryBox);

        // Re-enable Wi-Fi button — only visible while Cap holds Wi-Fi off.
        this._reenableBtn = new St.Button({
            label: _('Re-enable Wi-Fi'),
            style_class: 'button cap-reenable-btn',
            visible: false,
            x_expand: true,
            can_focus: true,
        });
        this._reenableBtn.connect('clicked', this._onReenableClicked.bind(this));
        section.add(this._reenableBtn);

        this.menu.addMenuItem(section);
    }

    /* ------------------------------------------------------------------ *
     * Lifecycle
     * ------------------------------------------------------------------ */

    start() {
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, this._tick.bind(this));
        // Run once immediately so the panel shows real state without delay.
        this._tick();
    }

    stop() {
        if (this._settingsHandlerId) {
            this._settings.disconnect(this._settingsHandlerId);
            this._settingsHandlerId = null;
        }
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    /* ------------------------------------------------------------------ *
     * Telemetry loop — one tick per second
     * ------------------------------------------------------------------ */

    _tick() {
        const {rx, tx} = this._readWifiBytes();

        let dRx = 0;
        let dTx = 0;

        if (this._haveBaseline) {
            // Clamp negatives to 0: counters may reset across suspend/off.
            dRx = Math.max(0, rx - this._prevRx);
            dTx = Math.max(0, tx - this._prevTx);
        } else {
            this._haveBaseline = true;
        }
        this._prevRx = rx;
        this._prevTx = tx;

        // Day rollover is evaluated every tick regardless of exhaustion.
        this._checkDayRollover();

        if (!this._exhausted) {
            const delta = dRx + dTx;
            if (delta > 0) {
                const used = this._settings.get_int64('used-bytes') + delta;
                this._settings.set_int64('used-bytes', used);
                this._evaluateThreshold(used);
            }
        }

        this._refreshUi(dRx, dTx);
        return GLib.SOURCE_CONTINUE;
    }

    _readWifiBytes() {
        let rx = 0;
        let tx = 0;

        let contents;
        try {
            [, contents] = GLib.file_get_contents('/proc/net/dev');
        } catch (e) {
            return {rx, tx};
        }

        const text = decoder.decode(contents);

        // First two lines are headers; data lines look like:
        //   "  wlan0: 1234 56 ... 7890 ..."
        for (const line of text.split('\n').slice(2)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('wl'))
                continue;

            const colon = trimmed.indexOf(':');
            if (colon === -1)
                continue;

            const iface = trimmed.slice(0, colon).trim();
            if (!/^wl/.test(iface))
                continue;

            const fields = trimmed.slice(colon + 1).trim().split(/\s+/);
            // rx_bytes is fields[0], tx_bytes is fields[TX_BYTE_COLUMN] but
            // we must allow for shorter rows; fall back to 0 on parse error.
            rx += Number.parseInt(fields[0], 10) || 0;
            tx += Number.parseInt(fields[TX_BYTE_COLUMN], 10) || 0;
        }

        return {rx, tx};
    }

    /* ------------------------------------------------------------------ *
     * Threshold enforcement (the cutoff)
     * ------------------------------------------------------------------ */

    _evaluateThreshold(used) {
        const limitBytes = this._cachedLimitMb * BYTES_PER_MB;
        if (used >= limitBytes)
            this._cutoff();
    }

    _cutoff() {
        this._exhausted = true;
        this._wifiDisabledByCap = true;
        Main.notify(_('Cap'), _('Limit exceeded. Interface terminated.'));
        this._runNmcli(['radio', 'wifi', 'off']);
        this._refreshReenable();
    }

    /* ------------------------------------------------------------------ *
     * Day boundary
     * ------------------------------------------------------------------ */

    _ensureToday() {
        const stored = this._settings.get_string('current-date');
        this._cachedToday = this._todayString();
        if (stored === '')
            this._settings.set_string('current-date', this._cachedToday);
    }

    _checkDayRollover() {
        const stored = this._settings.get_string('current-date');
        const today = this._cachedToday;
        if (stored !== today) {
            // Day changed or first run — recompute and persist.
            this._cachedToday = this._todayString();
            if (stored !== this._cachedToday) {
                this._settings.set_string('current-date', this._cachedToday);
                this._settings.set_int64('used-bytes', 0);
                this._exhausted = false;
            }
        }
    }

    _todayString() {
        // Local date as YYYY-MM-DD. GLib.DateTime is timezone-aware.
        const now = GLib.DateTime.new_now_local();
        return `${now.format('%Y')}-${now.format('%m')}-${now.format('%d')}`;
    }

    /* ------------------------------------------------------------------ *
     * nmcli subprocess wrapper (non-blocking)
     * ------------------------------------------------------------------ */

    _runNmcli(args) {
        try {
            const proc = new Gio.Subprocess({
                argv: ['nmcli', ...args],
                flags: Gio.SubprocessFlags.NONE,
            });
            proc.init(null);
            proc.wait_check_async(null, (p, res) => {
                try {
                    p.wait_check_finish(res);
                } catch (e) {
                    logError(e, `Cap: nmcli ${args.join(' ')} failed`);
                }
            });
        } catch (e) {
            logError(e, `Cap: failed to spawn nmcli ${args.join(' ')}`);
        }
    }

    /* ------------------------------------------------------------------ *
     * Limit control handlers
     * ------------------------------------------------------------------ */

    _onLimitChanged() {
        this._cachedLimitMb = this._settings.get_int('daily-limit-mb');
        this._slider.value = this._limitToFraction(this._cachedLimitMb);
        this._entry.set_text(String(this._cachedLimitMb));

        if (this._wifiDisabledByCap)
            this._maybeReenable();
    }

    _maybeReenable() {
        const usedBytes = this._settings.get_int64('used-bytes');
        const limitBytes = this._cachedLimitMb * BYTES_PER_MB;
        if (limitBytes > usedBytes) {
            this._runNmcli(['radio', 'wifi', 'on']);
            this._wifiDisabledByCap = false;
            this._exhausted = false;
            this._refreshReenable();
        }
    }

    _onSliderDragged() {
        // Live preview only; commit happens on drag-end.
    }

    _onSliderCommitted() {
        const mb = this._fractionToLimit(this._slider.value);
        this._settings.set_int('daily-limit-mb', mb);
        this._entry.set_text(String(mb));
    }

    _onEntryCommitted(clutterText) {
        const raw = clutterText.get_text().trim();
        const mb = Number.parseInt(raw, 10);
        if (Number.isNaN(mb))
            return; // ignore non-numeric without clobbering the field
        const clamped = Math.min(MAX_LIMIT_MB, Math.max(MIN_LIMIT_MB, mb));
        this._settings.set_int('daily-limit-mb', clamped);
        this._slider.value = this._limitToFraction(clamped);
        this._entry.set_text(String(clamped));
    }

    _onReenableClicked() {
        // Explicit re-enable, regardless of usage headroom.
        this._runNmcli(['radio', 'wifi', 'on']);
        this._wifiDisabledByCap = false;
        this._exhausted = false;
        this._refreshReenable();
    }

    _limitToFraction(mb) {
        const f = (mb - MIN_LIMIT_MB) / (MAX_LIMIT_MB - MIN_LIMIT_MB);
        return Math.min(1, Math.max(0, f));
    }

    _fractionToLimit(f) {
        const mb = Math.round(MIN_LIMIT_MB + (MAX_LIMIT_MB - MIN_LIMIT_MB) * f);
        return Math.min(MAX_LIMIT_MB, Math.max(MIN_LIMIT_MB, mb));
    }

    /* ------------------------------------------------------------------ *
     * UI refresh
     * ------------------------------------------------------------------ */

    _refreshUi(dRx, dTx) {
        const limitMb = this._cachedLimitMb;
        const usedBytes = this._settings.get_int64('used-bytes');
        const limitBytes = limitMb * BYTES_PER_MB;

        this._panelLabel.set_text(
            `↓ ${formatRate(dRx)}  ↑ ${formatRate(dTx)}`);

        const frac = limitBytes > 0 ? usedBytes / limitBytes : 0;
        const shouldWarn = frac >= WARN_FRACTION;
        if (shouldWarn !== this._isWarning) {
            this._isWarning = shouldWarn;
            if (shouldWarn)
                this._panelLabel.add_style_class_name('warning');
            else
                this._panelLabel.remove_style_class_name('warning');
        }

        const usedMb = usedBytes / BYTES_PER_MB;
        this._usageLabel.set_text(
            `${formatMb(usedMb)} / ${formatMb(limitMb)} Used`);

        this._bar.value = Math.min(1, frac);

        this._refreshReenable();
    }

    _refreshReenable() {
        this._reenableBtn.visible = this._wifiDisabledByCap;
    }
});

/**
 * Format a per-second byte rate as a human-readable string.
 * e.g. 4.2 MB/s, 120 KB/s, 512 B/s.
 */
function formatRate(bytesPerSec) {
    if (bytesPerSec < 1024)
        return `${bytesPerSec} B/s`;
    if (bytesPerSec < BYTES_PER_MB)
        return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / BYTES_PER_MB).toFixed(1)} MB/s`;
}

/**
 * Format a megabyte value compactly: integers shown as-is, fractional MB
 * rounded to a tenth until it crosses an integer threshold.
 */
function formatMb(mb) {
    if (mb < 1)
        return `${(mb).toFixed(2)} MB`;
    if (mb < 10)
        return `${(mb).toFixed(1)} MB`;
    return `${Math.round(mb)} MB`;
}

export default class CapExtension extends Extension {
    enable() {
        this._indicator = new CapIndicator(this);
        this._indicator.start();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.stop();
        this._indicator?.destroy();
        this._indicator = null;
    }
}
