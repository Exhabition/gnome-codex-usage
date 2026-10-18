// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppServerClient} from './appServerClient.js';

const DASHBOARD_URI = 'https://chatgpt.com/codex/cloud/settings/analytics';
const PROGRESS_WIDTH = 260;

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value) || 0, minimum), maximum);
}

function formatTokens(value) {
    if (value === null || value === undefined)
        return '—';

    return new Intl.NumberFormat(undefined, {
        notation: value >= 10000 ? 'compact' : 'standard',
        maximumFractionDigits: value >= 10000 ? 1 : 0,
    }).format(value);
}

function formatDuration(minutes) {
    if (!minutes)
        return _('Usage window');
    if (minutes < 60)
        return _('%d min window').format(minutes);
    if (minutes < 1440)
        return _('%d hour window').format(Math.round(minutes / 60));
    return _('%d day window').format(Math.round(minutes / 1440));
}

function formatReset(timestamp) {
    if (!timestamp)
        return _('reset unavailable');

    const remaining = Math.max(0, timestamp - Math.floor(Date.now() / 1000));
    if (remaining < 60)
        return _('resets in <1m');
    if (remaining < 3600)
        return _('resets in %dm').format(Math.ceil(remaining / 60));
    if (remaining < 86400)
        return _('resets in %dh %dm').format(
            Math.floor(remaining / 3600),
            Math.ceil((remaining % 3600) / 60)
        );
    return _('resets in %dd %dh').format(
        Math.floor(remaining / 86400),
        Math.ceil((remaining % 86400) / 3600)
    );
}

function formatRemaining(timestamp) {
    if (!timestamp)
        return '—';

    const remaining = Math.max(0, timestamp - Math.floor(Date.now() / 1000));
    if (remaining < 60)
        return _('<1m');
    if (remaining < 3600)
        return _('%dm').format(Math.ceil(remaining / 60));
    if (remaining < 86400)
        return _('%dh %dm').format(
            Math.floor(remaining / 3600),
            Math.ceil((remaining % 3600) / 60)
        );
    return _('%dd %dh').format(
        Math.floor(remaining / 86400),
        Math.ceil((remaining % 86400) / 3600)
    );
}

const UsageWindow = GObject.registerClass(
class UsageWindow extends St.BoxLayout {
    _init() {
        super._init({
            vertical: true,
            style_class: 'codex-usage-window',
            x_expand: true,
        });

        const heading = new St.BoxLayout({x_expand: true});
        this._name = new St.Label({
            style_class: 'codex-usage-window-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._percent = new St.Label({
            style_class: 'codex-usage-tabular codex-usage-window-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        heading.add_child(this._name);
        heading.add_child(this._percent);
        this.add_child(heading);

        this._track = new St.BoxLayout({style_class: 'codex-usage-progress-track'});
        this._fill = new St.Widget({
            style_class: 'codex-usage-progress-fill',
            x_align: Clutter.ActorAlign.START,
        });
        this._track.add_child(this._fill);
        this.add_child(this._track);

        this._reset = new St.Label({style_class: 'codex-usage-caption'});
        this.add_child(this._reset);
    }

    update(window, name = null) {
        const used = clamp(window?.usedPercent, 0, 100);
        this._name.text = name || formatDuration(window?.windowDurationMins);
        this._percent.text = _('%d%% used').format(Math.round(used));
        this._reset.text = formatReset(window?.resetsAt);
        this._fill.set_width(Math.round(PROGRESS_WIDTH * used / 100));
        this._fill.remove_style_class_name('warning');
        this._fill.remove_style_class_name('critical');
        if (used >= 90)
            this._fill.add_style_class_name('critical');
        else if (used >= 70)
            this._fill.add_style_class_name('warning');
        this.show();
    }
});

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, _('Codex usage'), false);
        this._extensionObject = extensionObject;
        this._settings = extensionObject.getSettings();
        this._refreshTimer = 0;
        this._lastData = {rateLimits: null, usage: null};

        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._openAiIcon = Gio.FileIcon.new(Gio.File.new_for_path(
            GLib.build_filenamev([
                extensionObject.path,
                'icons',
                'OpenAI-white-monoblossom.svg',
            ])
        ));
        this._panelIcon = new St.Icon({
            gicon: this._openAiIcon,
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            text: '…',
            style_class: 'codex-usage-panel-label codex-usage-tabular',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._panelLabel);
        this.add_child(this._panelBox);

        this._buildMenu();
        this._client = new AppServerClient({
            command: this._settings.get_string('codex-command'),
            onData: data => this._updateData(data),
            onStatus: status => this._updateStatus(status),
        });

        this._settings.connectObject(
            'changed::show-icon', () => this._applyPanelPreferences(),
            'changed::panel-display', () => this._updatePanelLabel(),
            'changed::visible-fields', () => this._applyFieldPreferences(),
            'changed::field-order', () => this._applyFieldPreferences(),
            'changed::update-interval', () => this._resetTimer(),
            'changed::codex-command', () =>
                this._client.restart(this._settings.get_string('codex-command')),
            this
        );

        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._client.refresh();
        }, this);

        this._applyPanelPreferences();
        this._resetTimer();
        this._client.start();
    }

    _buildMenu() {
        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'codex-usage-header-item',
        });
        const header = new St.BoxLayout({vertical: true, x_expand: true});
        header.add_child(new St.Label({
            text: _('Codex usage'),
            style_class: 'codex-usage-title',
        }));
        this._statusLabel = new St.Label({
            text: _('Connecting to Codex…'),
            style_class: 'codex-usage-caption',
        });
        header.add_child(this._statusLabel);
        headerItem.add_child(header);
        this.menu.addMenuItem(headerItem);

        const windowsItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const windows = new St.BoxLayout({vertical: true, x_expand: true});
        this._primaryWindow = new UsageWindow();
        this._secondaryWindow = new UsageWindow();
        this._primaryWindow.hide();
        this._secondaryWindow.hide();
        windows.add_child(this._primaryWindow);
        windows.add_child(this._secondaryWindow);
        windowsItem.add_child(windows);
        this.menu.addMenuItem(windowsItem);

        this._statSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._statSeparator);
        this._statRows = {
            today: this._addStatRow(_('Today'), '—'),
            week: this._addStatRow(_('Last 7 days'), '—'),
            lifetime: this._addStatRow(_('Lifetime'), '—'),
            streak: this._addStatRow(_('Current streak'), '—'),
            credits: this._addStatRow(_('Credits remaining'), '—'),
            resets: this._addStatRow(_('Resets remaining'), '—'),
            resetExpiry: this._addStatRow(_('Reset expiring in'), '—'),
        };
        this._applyFieldPreferences();

        this._errorItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._errorLabel = new St.Label({
            style_class: 'codex-usage-error',
            x_expand: true,
        });
        this._errorItem.add_child(this._errorLabel);
        this._errorItem.actor.hide();
        this.menu.addMenuItem(this._errorItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const actionsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'codex-usage-actions-item',
        });
        const actions = new St.BoxLayout({
            style_class: 'codex-usage-actions',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        actions.add_child(this._actionButton('view-refresh-symbolic', _('Refresh'), () =>
            this._client.refresh()));
        actions.add_child(this._actionButton(this._openAiIcon, _('Open usage dashboard'), () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri(DASHBOARD_URI, null);
        }));
        actions.add_child(this._actionButton('preferences-system-symbolic', _('Preferences'), () => {
            this.menu.close();
            this._extensionObject.openPreferences();
        }));
        actionsItem.add_child(actions);
        this.menu.addMenuItem(actionsItem);
    }

    _addStatRow(label, value) {
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false});
        row.add_child(new St.Label({text: label, x_expand: true}));
        const valueLabel = new St.Label({
            text: value,
            style_class: 'codex-usage-tabular codex-usage-stat-value',
        });
        row.add_child(valueLabel);
        this.menu.addMenuItem(row);
        return {item: row, actor: row.actor, value: valueLabel};
    }

    _actionButton(icon, label, callback) {
        const button = new St.Button({
            style_class: 'button codex-usage-action-button',
            accessible_name: label,
            can_focus: true,
        });
        button.set_child(new St.Icon({
            ...(typeof icon === 'string' ? {icon_name: icon} : {gicon: icon}),
            icon_size: 16,
        }));
        button.connect('clicked', callback);
        return button;
    }

    _updateData(data) {
        this._lastData = data;
        const limits = data.rateLimits?.rateLimits ?? null;
        if (limits?.primary)
            this._primaryWindow.update(limits.primary);
        else
            this._primaryWindow.hide();

        if (limits?.secondary)
            this._secondaryWindow.update(limits.secondary);
        else
            this._secondaryWindow.hide();

        const buckets = data.usage?.dailyUsageBuckets ?? [];
        const todayKey = GLib.DateTime.new_now_local().format('%Y-%m-%d');
        const today = buckets.find(bucket => bucket.startDate === todayKey)?.tokens ?? 0;
        const lastSevenDays = buckets.slice(-7).reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0);
        const summary = data.usage?.summary ?? {};

        this._statRows.today.value.text = _('%s tokens').format(formatTokens(today));
        this._statRows.week.value.text = _('%s tokens').format(formatTokens(lastSevenDays));
        this._statRows.lifetime.value.text = _('%s tokens').format(formatTokens(summary.lifetimeTokens));
        this._statRows.streak.value.text = summary.currentStreakDays === null ||
            summary.currentStreakDays === undefined
            ? '—'
            : _('%d days').format(summary.currentStreakDays);

        const credits = limits?.credits;
        if (credits?.hasCredits || credits?.unlimited || credits?.balance !== undefined) {
            this._statRows.credits.value.text = credits.unlimited
                ? _('Unlimited')
                : String(credits.balance ?? '—');
        }

        const resetCredits = data.rateLimits?.rateLimitResetCredits;
        this._statRows.resets.value.text = resetCredits?.availableCount === undefined
            ? '—'
            : String(resetCredits.availableCount);
        const earliestExpiry = resetCredits?.credits
            ?.filter(credit => credit.status === 'available' && credit.expiresAt)
            .map(credit => credit.expiresAt)
            .sort((a, b) => a - b)[0];
        this._statRows.resetExpiry.value.text = formatRemaining(earliestExpiry);

        this._applyFieldPreferences();
        this._updatePanelLabel();
    }

    _updateStatus({state, message}) {
        this._statusLabel.text = message;
        if (state === 'error') {
            this._errorLabel.text = message;
            this._errorItem.actor.show();
            this._panelLabel.text = '!';
        } else {
            this._errorItem.actor.hide();
        }
    }

    _updatePanelLabel() {
        const limits = this._lastData.rateLimits?.rateLimits;
        const primary = limits?.primary;
        const display = this._settings.get_enum('panel-display');

        if (display === 2) {
            const buckets = this._lastData.usage?.dailyUsageBuckets ?? [];
            const todayKey = GLib.DateTime.new_now_local().format('%Y-%m-%d');
            const today = buckets.find(bucket => bucket.startDate === todayKey)?.tokens ?? 0;
            this._panelLabel.text = formatTokens(today);
        } else if (primary) {
            const used = Math.round(clamp(primary.usedPercent, 0, 100));
            this._panelLabel.text = display === 1 ? `${used}%` : `${100 - used}%`;
        } else {
            this._panelLabel.text = '…';
        }

        this.accessible_name = _('Codex usage, %s').format(this._panelLabel.text);
    }

    _applyPanelPreferences() {
        this._panelIcon.visible = this._settings.get_boolean('show-icon');
    }

    _applyFieldPreferences() {
        const order = this._settings.get_strv('field-order');
        const visible = new Set(this._settings.get_strv('visible-fields'));
        const fields = Object.keys(this._statRows);
        for (const field of fields) {
            const row = this._statRows[field];
            const limits = this._lastData.rateLimits?.rateLimits;
            const hasResetData = this._lastData.rateLimits?.rateLimitResetCredits !== undefined;
            row.actor.visible = visible.has(field) &&
                (field !== 'credits' || limits?.credits !== undefined) &&
                (!['resets', 'resetExpiry'].includes(field) || hasResetData);
        }

        const ordered = [...order.filter(field => fields.includes(field)),
            ...fields.filter(field => !order.includes(field))];
        ordered.forEach((field, index) => this.menu.moveMenuItem(this._statRows[field].item, 3 + index));
    }

    _resetTimer() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }

        this._refreshTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_uint('update-interval'),
            () => {
                this._client.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    destroy() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        this._client?.stop();
        this._settings?.disconnectObject(this);
        super.destroy();
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._indicator = new UsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
