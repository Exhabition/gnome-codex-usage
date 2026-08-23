// SPDX-License-Identifier: GPL-2.0-only

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Codex Usage'),
            icon_name: 'utilities-system-monitor-symbolic',
        });

        const appearance = new Adw.PreferencesGroup({title: _('Panel')});
        const showIcon = new Adw.SwitchRow({
            title: _('Show icon'),
            subtitle: _('Display a symbolic monitor icon beside the usage value'),
        });
        settings.bind('show-icon', showIcon, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(showIcon);

        const displayModel = Gtk.StringList.new([
            _('Quota remaining'),
            _('Quota used'),
            _('Tokens today'),
        ]);
        const display = new Adw.ComboRow({
            title: _('Panel value'),
            model: displayModel,
            selected: settings.get_enum('panel-display'),
        });
        display.connect('notify::selected', row =>
            settings.set_enum('panel-display', row.selected));
        settings.connect('changed::panel-display', () => {
            const selected = settings.get_enum('panel-display');
            if (display.selected !== selected)
                display.selected = selected;
        });
        appearance.add(display);
        page.add(appearance);

        const connection = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _('The extension uses your existing Codex CLI sign-in. It never reads authentication files directly.'),
        });
        const interval = new Adw.SpinRow({
            title: _('Background refresh interval'),
            subtitle: _('The menu also refreshes whenever it opens'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 900,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_uint('update-interval'),
            }),
        });
        interval.connect('notify::value', row =>
            settings.set_uint('update-interval', Math.round(row.value)));
        settings.connect('changed::update-interval', () => {
            const value = settings.get_uint('update-interval');
            if (Math.round(interval.value) !== value)
                interval.value = value;
        });
        connection.add(interval);

        const command = new Adw.EntryRow({
            title: _('Codex executable'),
            text: settings.get_string('codex-command'),
        });
        command.add_suffix(new Gtk.Image({
            icon_name: 'system-search-symbolic',
            tooltip_text: _('Leave empty to search PATH and common installation locations'),
        }));
        command.connect('changed', row =>
            settings.set_string('codex-command', row.text.trim()));
        connection.add(command);
        page.add(connection);

        const about = new Adw.PreferencesGroup({title: _('About')});
        const dashboard = new Adw.ActionRow({
            title: _('Official Codex usage dashboard'),
            subtitle: 'chatgpt.com/codex/settings/usage',
            activatable: true,
        });
        dashboard.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        dashboard.connect('activated', () =>
            Gtk.UriLauncher.new('https://chatgpt.com/codex/settings/usage').launch(window, null, null));
        about.add(dashboard);
        page.add(about);

        window.add(page);
    }
}
