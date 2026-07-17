/*
 * Cap — preferences window.
 *
 * Built with libadwaita (Adw.SpinRow). Mirrors the daily-limit control that
 * lives in the dropdown and adds a one-click "reset today's usage" action.
 *
 * Target: GNOME Shell 46+ (fillPreferencesWindow API).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

const MIN_LIMIT_MB = 100;
const MAX_LIMIT_MB = 50000;
const BYTES_PER_MB = 1048576;

function _(str) {
    return str;
}

export default class CapPreferences {
    constructor(metadata) {
        this.metadata = metadata;
        this._dir = metadata.dir;
        this._path = metadata.path;
        this._uuid = metadata.uuid;
    }

    getSettings() {
        const schema = this.metadata['settings-schema'] || 'org.gnome.shell.extensions.cap';

        const schemaDir = this._dir.get_child('schemas');
        const defaultSource = Gio.SettingsSchemaSource.get_default();
        let schemaSource;
        if (schemaDir.query_exists(null)) {
            schemaSource = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir.get_path(), defaultSource, false);
        } else {
            schemaSource = defaultSource;
        }

        const schemaObj = schemaSource.lookup(schema, true);
        if (!schemaObj)
            throw new Error(`Schema ${schema} not found for extension ${this._uuid}`);
        return new Gio.Settings({settings_schema: schemaObj});
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Cap'),
            icon_name: 'network-wireless-symbolic',
        });
        window.add(page);

        const limitGroup = new Adw.PreferencesGroup({
            title: _('Daily Limit'),
            description: _('Cumulative Wi-Fi usage at which Cap terminates the interface'),
        });
        page.add(limitGroup);

        const limitRow = new Adw.ActionRow({
            title: _('Daily data limit'),
            subtitle: _('Between 100 MB and 50,000 MB'),
        });
        limitGroup.add(limitRow);

        // Adw.SpinRow carries its value on its Gtk.Adjustment; bind GSettings
        // to the adjustment's `value`, not the row.
        const adjustment = new Gtk.Adjustment({
            lower: MIN_LIMIT_MB,
            upper: MAX_LIMIT_MB,
            step_increment: 100,
            page_increment: 1024,
            value: settings.get_int('daily-limit-mb'),
        });
        settings.bind('daily-limit-mb', adjustment, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        const spinRow = new Adw.SpinRow({
            title: _('Limit (MB)'),
            adjustment,
            digits: 0,
        });
        limitGroup.add(spinRow);

        const usageGroup = new Adw.PreferencesGroup({
            title: _('Today\'s Usage'),
            description: _('Accumulated Wi-Fi bytes for the current calendar day'),
        });
        page.add(usageGroup);

        this._usageRow = new Adw.ActionRow({
            title: _('Bytes consumed'),
            subtitle: this._formatUsage(settings.get_int64('used-bytes')),
        });
        usageGroup.add(this._usageRow);

        this._usageSettings = settings;
        this._usageHandler = settings.connect('changed::used-bytes', () => {
            this._usageRow.subtitle = this._formatUsage(settings.get_int64('used-bytes'));
        });

        const resetRow = new Adw.ActionRow({
            title: _('Reset today\'s usage'),
            subtitle: _('Set the consumed-bytes counter back to 0'),
        });
        usageGroup.add(resetRow);

        const resetBtn = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            settings.set_int64('used-bytes', 0);
        });
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);

        window.connect('close-request', () => {
            if (this._usageHandler) {
                settings.disconnect(this._usageHandler);
                this._usageHandler = null;
            }
        });
    }

    _formatUsage(bytes) {
        if (bytes < 1024)
            return `${bytes} B`;
        if (bytes < BYTES_PER_MB)
            return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
    }
}
