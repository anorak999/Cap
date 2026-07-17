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
import Cairo from 'gi://cairo';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
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
        this._usedBytes = 0;

        // Telemetry baseline; first tick seeds these without adding a delta.
        this._haveBaseline = false;
        this._prevRx = 0;
        this._prevTx = 0;

        // Cached values to avoid repeated GSettings IPC every tick.
        this._cachedLimitMb = this._settings.get_int('daily-limit-mb');
        this._cachedToday = '';
        this._isWarning = false;

        this._timeoutId = null;

        this._buildTopbar();
        this._buildPopup();

        // React to limit changes so a raised limit re-enables Wi-Fi if usage
        // now fits under it.
        this._settings.connectObject(
            'changed::daily-limit-mb', this._onLimitChanged.bind(this), this);

        // React to style changes for live switching.
        this._settings.connectObject(
            'changed::popup-style', () => this._buildPopupContent(), this);

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
        this._section = new PopupMenu.PopupMenuSection();
        this._popupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'cap-popup-container',
        });
        this._section.box.add_child(this._popupBox);
        this.menu.addMenuItem(this._section);

        this._buildPopupContent();
    }

    _buildPopupContent() {
        const style = this._settings.get_string('popup-style');
        this._popupBox.destroy_all_children();

        switch (style) {
            case 'orbit':
                this._buildOrbitStyle(this._popupBox);
                break;
            case 'strata':
                this._buildStrataStyle(this._popupBox);
                break;
            default:
                this._buildDefaultStyle(this._popupBox);
        }

        // Sync button visibility so the freshly-built buttons reflect the
        // current exhaustion state without waiting for the next tick.
        this._syncReenableButtons();
    }

    /* ── Default style ─────────────────────────────────────────── */

    _buildDefaultStyle(container) {
        this._statusLabel = new St.Label({
            text: _('DAILY DATA STATUS'),
            style_class: 'cap-status-label',
        });
        container.add_child(this._statusLabel);

        this._usageValue = new St.Label({
            text: '0',
            style_class: 'cap-usage-value',
        });
        this._usageLimit = new St.Label({
            text: '/ 0 MB',
            style_class: 'cap-usage-limit',
        });
        const usageRow = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.END,
            style_class: 'cap-usage-row',
        });
        usageRow.add_child(this._usageValue);
        usageRow.add_child(this._usageLimit);
        container.add_child(usageRow);

        this._progressTrack = new St.Widget({
            style_class: 'cap-progress-track',
            x_expand: true,
            reactive: true,
        });
        this._progressFill = new St.Widget({
            style_class: 'cap-progress-fill',
        });
        this._progressTrack.add_child(this._progressFill);
        this._progressTrack.connect('notify::allocation',
            this._onProgressTrackAllocated.bind(this));
        container.add_child(this._progressTrack);

        const divider = new St.Widget({style_class: 'cap-divider'});
        container.add_child(divider);

        this._limitLabel = new St.Label({
            text: _('LIMIT'),
            style_class: 'cap-limit-label',
        });
        container.add_child(this._limitLabel);

        const sliderBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'cap-slider-container',
        });
        this._slider = new Slider.Slider(this._limitToFraction(
            this._settings.get_int('daily-limit-mb')));
        this._slider.x_expand = true;
        this._slider.connect('notify::value', this._onSliderDragged.bind(this));
        this._slider.connect('drag-end', this._onSliderCommitted.bind(this));
        sliderBox.add_child(this._slider);
        container.add_child(sliderBox);

        const minmaxRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'cap-slider-minmax',
        });
        const minLabel = new St.Label({
            text: _('100'),
            style_class: 'cap-slider-minmax-label',
        });
        const maxLabel = new St.Label({
            text: _('50,000'),
            style_class: 'cap-slider-minmax-label',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        minmaxRow.add_child(minLabel);
        minmaxRow.add_child(maxLabel);
        container.add_child(minmaxRow);

        const valueRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'cap-value-row',
        });
        this._entry = new St.Entry({
            text: String(this._settings.get_int('daily-limit-mb')),
            x_expand: true,
            style_class: 'cap-value-entry',
        });
        this._entry.clutter_text.set_input_hints(Clutter.InputContentHintFlags.NUMBER);
        this._entry.clutter_text.connect('activate', this._onEntryCommitted.bind(this));
        const mbUnit = new St.Label({
            text: _('MB'),
            style_class: 'cap-value-unit',
            y_align: Clutter.ActorAlign.CENTER,
        });
        valueRow.add_child(this._entry);
        valueRow.add_child(mbUnit);
        container.add_child(valueRow);

        this._reenableBtn = new St.Button({
            label: _('Re-enable Wi-Fi'),
            style_class: 'button cap-reenable-btn',
            visible: false,
            x_expand: true,
            can_focus: true,
        });
        this._reenableBtn.connect('clicked', this._onReenableClicked.bind(this));
        container.add_child(this._reenableBtn);

        this._refreshUi(0, 0);
    }

    /* ── Orbit style (ring gauge) ──────────────────────────────── */

    _buildOrbitStyle(container) {
        const header = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-orbit-header',
        });
        const iconBadge = new St.Bin({style_class: 'cap-orbit-icon-badge'});
        iconBadge.set_child(new St.Icon({
            icon_name: 'network-wireless-symbolic',
            style_class: 'cap-orbit-icon',
        }));
        const titleBox = new St.BoxLayout({vertical: true});
        titleBox.add_child(new St.Label({
            text: _('Wi-Fi data cap'),
            style_class: 'cap-orbit-title',
        }));
        titleBox.add_child(new St.Label({
            text: _('Resets at midnight'),
            style_class: 'cap-orbit-subtitle',
        }));
        header.add_child(iconBadge);
        header.add_child(titleBox);
        container.add_child(header);

        const statsRow = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-orbit-stats-row',
        });
        this._orbitRing = new St.DrawingArea({
            style_class: 'cap-orbit-ring',
        });
        this._orbitRing.connect('repaint', this._drawOrbitRing.bind(this));
        this._orbitRing.connect('notify::allocation', () => {
            // First layout gives us real dimensions — repaint so the ring
            // doesn't stay blank from the initial 0x0 paint.
            if (this._orbitRing.get_surface_size()[0] > 0)
                this._orbitRing.queue_repaint();
        });
        statsRow.add_child(this._orbitRing);

        const numbers = new St.BoxLayout({vertical: true});
        this._orbitUsedLabel = new St.Label({style_class: 'cap-orbit-used'});
        this._orbitLimitLabel = new St.Label({style_class: 'cap-orbit-limit'});
        numbers.add_child(this._orbitUsedLabel);
        numbers.add_child(this._orbitLimitLabel);
        statsRow.add_child(numbers);
        container.add_child(statsRow);

        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'cap-orbit-card',
        });
        const cardTop = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-orbit-card-top',
        });
        cardTop.add_child(new St.Label({
            text: _('Daily limit'),
            style_class: 'cap-orbit-card-label',
            x_expand: true,
        }));
        this._orbitLimitValue = new St.Label({style_class: 'cap-orbit-card-value'});
        cardTop.add_child(this._orbitLimitValue);
        card.add_child(cardTop);

        this._orbitSlider = new Slider.Slider(this._limitToFraction(
            this._settings.get_int('daily-limit-mb')));
        this._orbitSlider.add_style_class_name('cap-orbit-slider');
        this._orbitSlider.connect('notify::value', () => this._onOrbitSliderChanged());
        this._orbitSlider.connect('drag-end', this._onOrbitSliderCommitted.bind(this));
        card.add_child(this._orbitSlider);
        container.add_child(card);

        this._orbitReenableBtn = new St.Button({
            label: _('Re-enable Wi-Fi'),
            style_class: 'button cap-orbit-reenable',
            visible: false,
            x_expand: true,
            can_focus: true,
        });
        this._orbitReenableBtn.connect('clicked', () => this._onReenableClicked());
        container.add_child(this._orbitReenableBtn);

        this._refreshUi(0, 0);
    }

    _drawOrbitRing(area) {
        const [width, height] = area.get_surface_size();

        // Bail if the surface hasn't been laid out yet (0x0).
        if (width === 0 || height === 0)
            return;

        const cr = area.get_context();
        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(width, height) / 2 - 5;
        const limitBytes = this._cachedLimitMb * BYTES_PER_MB;
        const ratio = limitBytes > 0 ? Math.min(this._usedBytes / limitBytes, 1) : 0;

        // Background track.
        cr.setLineWidth(7);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.setSourceRGBA(0.18, 0.18, 0.21, 1);
        cr.stroke();

        // Filled arc.
        const color = ratio >= 1 ? [0.886, 0.294, 0.290]
            : ratio >= 0.9 ? [0.937, 0.624, 0.153]
            : [0.365, 0.792, 0.647];
        cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + ratio * 2 * Math.PI);
        cr.setSourceRGBA(...color, 1);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.stroke();
        cr.$dispose();
    }

    _onOrbitSliderChanged() {
        // Live preview; commit on drag-end.
    }

    _onOrbitSliderCommitted() {
        const mb = this._fractionToLimit(this._orbitSlider.value);
        this._settings.set_int('daily-limit-mb', mb);
    }

    /* ── Strata style (flat row-list) ──────────────────────────── */

    _buildStrataStyle(container) {
        const header = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-strata-header',
        });
        header.add_child(new St.Label({
            text: _('Cap'),
            style_class: 'cap-strata-title',
            x_expand: true,
        }));
        this._strataStatusPill = new St.Label({style_class: 'cap-strata-pill'});
        header.add_child(this._strataStatusPill);
        container.add_child(header);

        const body = new St.BoxLayout({
            vertical: true,
            style_class: 'cap-strata-body',
        });

        const usageRow = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-strata-usage-row',
        });
        this._strataUsedLabel = new St.Label({
            style_class: 'cap-strata-used',
            x_expand: true,
        });
        this._strataPercentLabel = new St.Label({style_class: 'cap-strata-percent'});
        usageRow.add_child(this._strataUsedLabel);
        usageRow.add_child(this._strataPercentLabel);
        body.add_child(usageRow);

        this._strataBarTrack = new St.Widget({style_class: 'cap-strata-bar-track'});
        this._strataBarFill = new St.Widget({style_class: 'cap-strata-bar-fill'});
        this._strataBarTrack.add_child(this._strataBarFill);
        this._strataBarTrack.connect('notify::allocation',
            this._onStrataBarAllocated.bind(this));
        body.add_child(this._strataBarTrack);

        body.add_child(this._buildStrataRow(_('Daily limit'),
            () => this._buildStrataSliderControl()));
        body.add_child(this._buildStrataRow(_('Resets'), _('Midnight')));
        body.add_child(this._buildStrataRow(_('Interface'), _('wlan0')));

        this._strataReenableBtn = new St.Button({
            label: _('Re-enable Wi-Fi'),
            style_class: 'button cap-strata-reenable',
            visible: false,
            x_expand: true,
            can_focus: true,
        });
        this._strataReenableBtn.connect('clicked', () => this._onReenableClicked());
        body.add_child(this._strataReenableBtn);

        container.add_child(body);
        this._refreshUi(0, 0);
    }

    _buildStrataRow(label, valueOrBuilder) {
        const row = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-strata-row',
        });
        row.add_child(new St.Label({
            text: label,
            style_class: 'cap-strata-row-label',
            x_expand: true,
        }));
        if (typeof valueOrBuilder === 'function')
            row.add_child(valueOrBuilder());
        else
            row.add_child(new St.Label({
                text: valueOrBuilder,
                style_class: 'cap-strata-row-value',
            }));
        return row;
    }

    _buildStrataSliderControl() {
        const wrap = new St.BoxLayout({
            vertical: false,
            style_class: 'cap-strata-slider-wrap',
        });
        this._strataSlider = new Slider.Slider(this._limitToFraction(
            this._settings.get_int('daily-limit-mb')));
        this._strataSlider.add_style_class_name('cap-strata-slider');
        this._strataSlider.connect('notify::value', () => this._onStrataSliderChanged());
        this._strataSlider.connect('drag-end', this._onStrataSliderCommitted.bind(this));
        this._strataLimitValue = new St.Label({style_class: 'cap-strata-row-value'});
        wrap.add_child(this._strataSlider);
        wrap.add_child(this._strataLimitValue);
        return wrap;
    }

    _onStrataSliderChanged() {
        // Live preview; commit on drag-end.
    }

    _onStrataSliderCommitted() {
        const mb = this._fractionToLimit(this._strataSlider.value);
        this._settings.set_int('daily-limit-mb', mb);
    }

    _onStrataBarAllocated() {
        if (this._lastStrataFrac !== undefined) {
            const trackWidth = this._strataBarTrack.get_width();
            if (trackWidth > 0)
                this._strataBarFill.width = Math.round(trackWidth * this._lastStrataFrac);
        }
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
        this._settings?.disconnectObject(this);
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

        this._usedBytes = this._settings.get_int64('used-bytes');
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

        if (this._slider) {
            this._slider.value = this._limitToFraction(this._cachedLimitMb);
            this._entry.set_text(String(this._cachedLimitMb));
        }
        if (this._orbitSlider) {
            this._orbitSlider.value = Math.min(this._cachedLimitMb / MAX_LIMIT_MB, 1);
        }
        if (this._strataSlider) {
            this._strataSlider.value = Math.min(this._cachedLimitMb / MAX_LIMIT_MB, 1);
        }

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
            this._syncReenableButtons();
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
        this._syncReenableButtons();
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
     * UI refresh — dispatches to the active style
     * ------------------------------------------------------------------ */

    _refreshUi(dRx, dTx) {
        const limitMb = this._cachedLimitMb;
        const usedBytes = this._usedBytes;
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

        const style = this._settings.get_string('popup-style');
        switch (style) {
            case 'orbit':
                this._refreshOrbit(usedBytes, limitMb, frac);
                break;
            case 'strata':
                this._refreshStrata(usedBytes, limitMb, frac);
                break;
            default:
                this._refreshDefault(usedBytes, limitMb, frac);
                break;
        }
    }

    _refreshDefault(usedBytes, limitMb, frac) {
        if (!this._usageValue)
            return;

        const usedMb = usedBytes / BYTES_PER_MB;
        this._usageValue.text = `${usedMb.toFixed(2)}`;
        this._usageLimit.text = `/ ${limitMb} MB`;

        this._updateProgressFill(frac);
        this._refreshReenable(this._reenableBtn);
    }

    _refreshOrbit(usedBytes, limitMb, frac) {
        if (!this._orbitUsedLabel)
            return;

        this._orbitUsedLabel.text = `${(usedBytes / BYTES_PER_MB).toFixed(2)} MB used`;
        this._orbitLimitLabel.text = `of ${limitMb} MB daily limit`;
        this._orbitLimitValue.text = `${limitMb} MB`;
        this._orbitSlider.value = Math.min(limitMb / MAX_LIMIT_MB, 1);
        this._orbitRing.queue_repaint();
        this._refreshReenable(this._orbitReenableBtn);
    }

    _refreshStrata(usedBytes, limitMb, frac) {
        if (!this._strataUsedLabel)
            return;

        this._strataUsedLabel.text = `${(usedBytes / BYTES_PER_MB).toFixed(2)} MB`;
        this._strataPercentLabel.text = `${(frac * 100).toFixed(2)}%`;
        this._strataLimitValue.text = `${limitMb}`;
        this._strataSlider.value = Math.min(limitMb / MAX_LIMIT_MB, 1);

        this._strataStatusPill.text = this._exhausted ? _('Exhausted') : _('Active');
        this._strataStatusPill.remove_style_class_name('exhausted');
        if (this._exhausted)
            this._strataStatusPill.add_style_class_name('exhausted');

        const clamped = Math.min(frac, 1);
        this._lastStrataFrac = clamped;
        const trackWidth = this._strataBarTrack.get_width();
        if (trackWidth > 0)
            this._strataBarFill.width = Math.round(trackWidth * clamped);

        this._refreshReenable(this._strataReenableBtn);
    }

    _updateProgressFill(frac) {
        const clamped = Math.min(frac, 1);
        this._lastProgressFrac = clamped;

        const trackWidth = this._progressTrack.get_width();
        if (trackWidth > 0)
            this._progressFill.width = Math.round(trackWidth * clamped);

        this._progressFill.remove_style_class_name('warning');
        this._progressFill.remove_style_class_name('exhausted');

        if (frac >= 1)
            this._progressFill.add_style_class_name('exhausted');
        else if (frac >= WARN_FRACTION)
            this._progressFill.add_style_class_name('warning');
    }

    _onProgressTrackAllocated() {
        if (this._lastProgressFrac !== undefined)
            this._updateProgressFill(this._lastProgressFrac);
    }

    _refreshReenable(btn) {
        // Drive button visibility from the authoritative exhaustion state.
        // _wifiDisabledByCap tracks whether Cap is actively holding Wi-Fi off;
        // this is the correct signal for all three style paths.
        if (btn)
            btn.visible = this._wifiDisabledByCap;
    }

    _syncReenableButtons() {
        // After a popup rebuild or style switch, force all known buttons to
        // reflect the current state so there's no stale `visible: false` gap.
        if (this._reenableBtn)
            this._reenableBtn.visible = this._wifiDisabledByCap;
        if (this._orbitReenableBtn)
            this._orbitReenableBtn.visible = this._wifiDisabledByCap;
        if (this._strataReenableBtn)
            this._strataReenableBtn.visible = this._wifiDisabledByCap;
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
