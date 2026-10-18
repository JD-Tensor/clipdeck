// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Subhadip Jana <subhadipjana@jdtensor.com>
//
// The history popup opened from the top-bar icon: a modal card listing
// clipboard history, shown right under the icon.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'get_file_info_async');

const PREVIEW_LINES = 5;
const PREVIEW_CHARS = 300;
const THUMB_WIDTH = 340;
const THUMB_HEIGHT = 150;
const MAX_FILE_ROWS = 3;
const POPUP_MARGIN = 12;

const FILE_ATTRIBUTES = 'standard::display-name,standard::content-type,standard::icon,standard::size,thumbnail::path';

function timeAgo(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);
    if (seconds < 60)
        return 'Just now';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)} h ago`;
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%b %e');
}

function formatSize(bytes) {
    if (!bytes)
        return '';
    return GLib.format_size(bytes);
}

function textPreview(text) {
    if (!text.trim())
        return '(whitespace)';
    const lines = text.slice(0, PREVIEW_CHARS * 2).replace(/\t/g, '    ').split(/\r?\n/);
    let preview = lines.slice(0, PREVIEW_LINES).map(l => l.trimEnd()).join('\n').trim();
    if (preview.length > PREVIEW_CHARS)
        preview = preview.slice(0, PREVIEW_CHARS);
    if (preview.length < text.trim().length)
        preview += '…';
    return preview;
}

function fileName(uri) {
    const file = Gio.File.new_for_uri(uri);
    return file.get_basename() ?? uri;
}

async function queryFile(uri) {
    try {
        return await Gio.File.new_for_uri(uri).query_info_async(FILE_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    } catch {
        return null;
    }
}

async function imageSize(path) {
    try {
        const [, width, height] = await GdkPixbuf.Pixbuf.get_file_info_async(path, null);
        return [width, height];
    } catch {
        return [0, 0];
    }
}

// Fits the image inside THUMB_WIDTH x THUMB_HEIGHT without enlarging small ones.
function loadThumbnail(path, width, height) {
    const fit = width && height ? Math.min(1, THUMB_WIDTH / width, THUMB_HEIGHT / height) : 1;
    const [w, h] = width && height
        ? [Math.max(1, Math.round(width * fit)), Math.max(1, Math.round(height * fit))]
        : [THUMB_WIDTH, THUMB_HEIGHT];

    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const actor = St.TextureCache.get_default().load_file_async(
        Gio.File.new_for_path(path), w, h, scale, 1);
    return new St.Bin({style_class: 'clipdeck-thumb', child: actor, x_expand: true, x_align: Clutter.ActorAlign.START});
}

export const ClipboardPopup = GObject.registerClass({
    Signals: {'closed': {}},
}, class ClipboardPopup extends St.Widget {
    _init(store, anchor, pasteOnSelect, onActivate, onOpenSettings) {
        super._init({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });

        this._store = store;
        this._anchor = anchor;
        this._onActivate = onActivate;
        this._visible = [];
        this._rows = [];
        this._selected = 0;
        this._grab = null;
        this._closed = false;

        this._card = new St.BoxLayout({
            style_class: 'clipdeck-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        // Moving the card from inside a layout pass would need a second pass;
        // do it just before the next redraw instead.
        this._card.connect('notify::height', () => {
            if (this._repositionLater)
                return;
            this._repositionLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._repositionLater = 0;
                this._reposition();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.add_child(this._card);

        const header = new St.BoxLayout({style_class: 'clipdeck-header'});
        header.add_child(new St.Label({
            style_class: 'clipdeck-title',
            text: 'Clipboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const clearButton = new St.Button({style_class: 'clipdeck-clear-button', label: 'Clear all', can_focus: false});
        clearButton.connect('clicked', () => this._store.clear());
        header.add_child(clearButton);
        const settingsButton = this._iconButton('emblem-system-symbolic', () => {
            this.close();
            onOpenSettings();
        });
        settingsButton.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(settingsButton);
        this._card.add_child(header);

        this._entry = new St.Entry({
            style_class: 'clipdeck-search',
            hint_text: 'Search clipboard history…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._rebuild();
        });
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this._card.add_child(this._entry);

        this._scroll = new St.ScrollView({
            style_class: 'clipdeck-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._list = new St.BoxLayout({style_class: 'clipdeck-list', orientation: Clutter.Orientation.VERTICAL});
        this._scroll.set_child(this._list);
        this._card.add_child(this._scroll);

        const verb = pasteOnSelect ? 'paste' : 'copy';
        this._card.add_child(new St.Label({
            style_class: 'clipdeck-footer',
            text: `↑↓ select · Enter or Alt+1…9 ${verb} · Ctrl+P pin · Del remove · Esc close`,
        }));

        // Close on clicks outside the card.
        const outsideClick = new Clutter.ClickGesture({recognize_on_press: true});
        outsideClick.connect('may-recognize', () => {
            const target = global.stage.get_event_actor(outsideClick.get_point_event(0));
            return !target || !this._card.contains(target);
        });
        outsideClick.connect('recognize', () => this.close());
        this.add_action(outsideClick);
        this.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        this._storeChangedId = this._store.connectChanged(() => this._rebuild());
        this.connect('destroy', () => this._store.disconnectChanged(this._storeChangedId));
    }

    open() {
        Main.uiGroup.add_child(this);
        this._monitor = Main.layoutManager.findMonitorForActor(this._anchor) ??
            Main.layoutManager.primaryMonitor;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._rebuild();
        this._entry.grab_key_focus();
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._repositionLater) {
            global.compositor.get_laters().remove(this._repositionLater);
            this._repositionLater = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.emit('closed');
        this.destroy();
    }

    _rebuild() {
        if (this._closed)
            return;

        const query = this._entry.get_text().trim().toLowerCase();
        this._visible = this._store.entries.filter(e => this._matches(e, query));
        this._selected = Math.min(this._selected, Math.max(0, this._visible.length - 1));

        this._buildSerial = (this._buildSerial ?? 0) + 1;
        this._list.destroy_all_children();
        this._rows = this._visible.map((entry, i) => {
            const row = this._createRow(entry, i);
            this._list.add_child(row);
            return row;
        });

        if (this._rows.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'clipdeck-empty',
                text: query
                    ? 'No matches.'
                    : 'Nothing here yet.\nCopy or cut something and it will show up here.',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        this._updateSelection(true);
    }

    _matches(entry, query) {
        if (!query)
            return true;
        switch (entry.type) {
        case 'text':
            return entry.text.toLowerCase().includes(query);
        case 'files':
            return entry.uris.some(u => fileName(u).toLowerCase().includes(query));
        case 'image':
            return ['image', 'screenshot', 'picture'].some(w => w.startsWith(query));
        default:
            return false;
        }
    }

    _createRow(entry, index) {
        const button = new St.Button({
            style_class: 'clipdeck-item',
            can_focus: false,
            x_expand: true,
            track_hover: true,
        });
        if (entry.pinned)
            button.add_style_class_name('pinned');

        const box = new St.BoxLayout({x_expand: true});
        button.set_child(box);

        const content = new St.BoxLayout({
            style_class: 'clipdeck-item-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(content);

        const caption = new St.Label({style_class: 'clipdeck-caption'});
        const setKind = kind => {
            caption.text = `${index < 9 ? `${index + 1} · ` : ''}${kind} · ${timeAgo(entry.time)}`;
        };
        this._fillContent(content, entry, setKind);
        content.add_child(caption);

        const actions = new St.BoxLayout({
            style_class: 'clipdeck-item-actions',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.START,
        });
        const pin = this._iconButton('view-pin-symbolic', () => this._store.togglePin(entry.id));
        if (entry.pinned)
            pin.add_style_pseudo_class('checked');
        actions.add_child(pin);
        actions.add_child(this._iconButton('edit-delete-symbolic', () => this._store.remove(entry.id)));
        box.add_child(actions);

        button.connect('clicked', () => this._activate(index));
        return button;
    }

    _iconButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'clipdeck-icon-button',
            can_focus: false,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        button.connect('clicked', () => callback());
        return button;
    }

    // Adds the preview widgets and reports a short description of the item
    // through setKind (later, for files, once their details are read).
    _fillContent(content, entry, setKind) {
        switch (entry.type) {
        case 'text': {
            const label = new St.Label({style_class: 'clipdeck-text', text: textPreview(entry.text), x_expand: true});
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            content.add_child(label);
            setKind(entry.text.length > 1 ? `Text · ${entry.text.length} chars` : 'Text');
            break;
        }
        case 'image': {
            content.add_child(loadThumbnail(this._store.blobPath(entry), entry.width, entry.height));
            const dims = entry.width ? ` ${entry.width}×${entry.height}` : '';
            setKind(`Image${dims} · ${formatSize(entry.size)}`);
            break;
        }
        case 'files':
            this._fillFiles(content, entry.uris, setKind);
            break;
        }
    }

    // Shows names straight away, then fills in icons, thumbnails and sizes
    // once the file details have been read.
    _fillFiles(content, uris, setKind) {
        const rows = uris.slice(0, MAX_FILE_ROWS).map(uri => {
            const row = new St.BoxLayout({style_class: 'clipdeck-file-row'});
            const icon = new St.Icon({
                gicon: Gio.ThemedIcon.new('text-x-generic'),
                icon_size: 20,
                style_class: 'clipdeck-file-icon',
            });
            row.add_child(icon);
            const label = new St.Label({text: fileName(uri), y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            row.add_child(label);
            content.add_child(row);
            return {icon, label};
        });
        if (uris.length > MAX_FILE_ROWS) {
            content.add_child(new St.Label({
                style_class: 'clipdeck-more',
                text: `+${uris.length - MAX_FILE_ROWS} more`,
            }));
        }
        setKind(uris.length > 1 ? `${uris.length} files` : 'File');

        const serial = this._buildSerial;
        const stillShown = () => !this._closed && serial === this._buildSerial;
        Promise.all(uris.slice(0, MAX_FILE_ROWS).map(queryFile)).then(async infos => {
            if (!stillShown())
                return;
            infos.forEach((info, i) => {
                if (info) {
                    rows[i].icon.gicon = info.get_icon();
                    rows[i].label.text = info.get_display_name();
                } else {
                    rows[i].label.text = `${fileName(uris[i])} (missing)`;
                }
            });

            const info = infos[0];
            if (uris.length > 1 || !info)
                return;
            const type = info.get_content_type() ?? '';
            const size = formatSize(info.get_size());
            if (type.startsWith('video/'))
                setKind(`Video · ${size}`);
            else if (type.startsWith('image/'))
                setKind(`Image file · ${size}`);
            else if (type === 'inode/directory')
                setKind('Folder');
            else
                setKind(`File · ${size}`);

            const path = Gio.File.new_for_uri(uris[0]).get_path();
            const thumb = info.get_attribute_byte_string('thumbnail::path') ||
                (type.startsWith('image/') && path && info.get_size() < 50 * 1024 * 1024 ? path : null);
            if (!thumb)
                return;
            const [width, height] = await imageSize(thumb);
            if (stillShown())
                content.insert_child_at_index(loadThumbnail(thumb, width, height), 0);
        });
    }

    _updateSelection(scroll) {
        this._rows.forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        const row = this._rows[this._selected];
        if (scroll && row) {
            // The row is only allocated after the next layout pass.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!this._closed && row.get_parent())
                    ensureActorVisibleInScrollView(this._scroll, row);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _move(delta) {
        if (!this._rows.length)
            return;
        this._selected = Math.max(0, Math.min(this._rows.length - 1, this._selected + delta));
        this._updateSelection(true);
    }

    _activate(index) {
        const entry = this._visible[index];
        if (!entry)
            return;
        this.close();
        this._onActivate(entry);
    }

    _onKeyPress(event) {
        const keyval = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;

        switch (keyval) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._move(-5);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._move(5);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate(this._selected);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
            // Plain Delete edits the search text while there is any.
            if (this._entry.get_text() && !(state & Clutter.ModifierType.SHIFT_MASK))
                return Clutter.EVENT_PROPAGATE;
            if (this._visible[this._selected])
                this._store.remove(this._visible[this._selected].id);
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (keyval === Clutter.KEY_p || keyval === Clutter.KEY_P)) {
            if (this._visible[this._selected])
                this._store.togglePin(this._visible[this._selected].id);
            return Clutter.EVENT_STOP;
        }

        if (alt && keyval >= Clutter.KEY_1 && keyval <= Clutter.KEY_9) {
            this._activate(keyval - Clutter.KEY_1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _reposition() {
        if (this._closed || !this._monitor)
            return;

        const mon = this._monitor;
        const margin = POPUP_MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [w, h] = [this._card.width, this._card.height];

        // Centered under the top-bar icon, like the panel's own menus.
        const [ax, ay] = this._anchor.get_transformed_position();
        let x = ax + this._anchor.width / 2 - w / 2;
        let y = ay + this._anchor.height + margin / 2;

        x = Math.max(mon.x + margin, Math.min(x, mon.x + mon.width - w - margin));
        y = Math.max(mon.y + margin, Math.min(y, mon.y + mon.height - h - margin));
        this._card.set_position(Math.round(x), Math.round(y));
    }
});
