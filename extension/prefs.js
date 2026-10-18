// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Subhadip Jana <subhadipjana@jdtensor.com>

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClipdeckPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Clipboard', icon_name: 'edit-paste-symbolic'});
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'History'});
        page.add(general);

        const size = Adw.SpinRow.new_with_range(5, 500, 1);
        size.title = 'Items to keep';
        size.subtitle = 'Pinned items do not count toward this limit';
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(size);

        general.add(this._switchRow(settings, 'paste-on-select', 'Also paste after choosing an item',
            'Sends Ctrl+V to the window you were using. When off, the item is only copied.'));
        general.add(this._switchRow(settings, 'persist-history', 'Keep history after logging out',
            'When off, unpinned items are cleared at every login'));
        general.add(this._switchRow(settings, 'paused', 'Pause recording',
            'Nothing new is added while this is on'));

        const images = new Adw.PreferencesGroup({title: 'Images'});
        page.add(images);
        images.add(this._switchRow(settings, 'save-images', 'Record images and screenshots', null));

        const maxImage = Adw.SpinRow.new_with_range(1, 200, 1);
        maxImage.title = 'Largest image to record (MB)';
        settings.bind('max-image-mb', maxImage, 'value', Gio.SettingsBindFlags.DEFAULT);
        images.add(maxImage);

        const data = new Adw.PreferencesGroup({title: 'Data'});
        page.add(data);

        const clearRow = new Adw.ActionRow({
            title: 'Clear history',
            subtitle: 'Removes every item except pinned ones',
        });
        const clearButton = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearButton.connect('clicked', () =>
            settings.set_int('clear-trigger', settings.get_int('clear-trigger') + 1));
        clearRow.add_suffix(clearButton);
        data.add(clearRow);
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title});
        if (subtitle)
            row.subtitle = subtitle;
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
