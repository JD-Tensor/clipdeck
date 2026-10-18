// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Subhadip Jana <subhadipjana@jdtensor.com>
//
// Clipdeck: clipboard history for GNOME Shell.
//
// Watches the CLIPBOARD selection, records text, images (including
// screenshots) and copied/cut files (any type, including videos). A clipboard
// icon in the top bar opens the history; choosing an item puts it back on the
// clipboard. Pasting it into the focused window as well is optional and off
// by default, because it works by sending a simulated Ctrl+V.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {HistoryStore} from './historyStore.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
import {ClipboardPopup} from './popup.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const CAPTURE_DELAY_MS = 150;
const PASTE_DELAY_MS = 120;

// Password managers (KeePassXC, KDE apps) mark secrets with this type.
const SECRET_MIMES = ['x-kde-passwordManagerHint'];
const FILE_MIMES = ['x-special/gnome-copied-files', 'text/uri-list'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];

// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINAL_CLASSES = [
    'gnome-terminal', 'gnome-terminal-server', 'org.gnome.terminal', 'org.gnome.ptyxis', 'ptyxis',
    'org.gnome.console', 'kgx', 'kitty', 'alacritty', 'org.wezfurlong.wezterm', 'wezterm', 'tilix',
    'com.gexperts.tilix', 'terminator', 'xterm', 'uxterm', 'konsole', 'org.kde.konsole',
    'xfce4-terminal', 'foot', 'com.mitchellh.ghostty', 'ghostty', 'blackbox', 'com.raggesilver.blackbox',
];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// The extension is disabled while the screen is locked and enabled again on
// unlock, but this module stays loaded for the whole login session. This
// flag makes "don't keep history after logging out" clear the history once
// per login rather than on every unlock.
let clearedThisLogin = false;

function parseUris(bytes, mime) {
    const lines = decoder.decode(bytes.toArray()).split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    // x-special/gnome-copied-files starts with "copy" or "cut".
    if (mime === 'x-special/gnome-copied-files' && (lines[0] === 'copy' || lines[0] === 'cut'))
        lines.shift();
    return lines;
}

const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
    _init(onClick) {
        // No menu: the history popup is a separate modal widget.
        super._init(0.5, 'Clipboard History', true);
        this.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'}));
        this._onClick = onClick;

        const click = new Clutter.ClickGesture({recognize_on_press: true});
        click.connect('recognize', () => this._onClick());
        this.add_action(click);

        // Space or Enter when the icon has keyboard focus (Ctrl+Alt+Tab).
        this.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_space && key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;
            this._onClick();
            return Clutter.EVENT_STOP;
        });
    }
});

export default class ClipdeckExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._clipboard = St.Clipboard.get_default();
        this._captureSerial = 0;
        this._captureId = 0;
        this._pasteId = 0;
        this._popup = null;

        this._store = new HistoryStore(this._settings);
        const clearUnpinned = !this._settings.get_boolean('persist-history') && !clearedThisLogin;
        clearedThisLogin = true;
        this._store.load({clearUnpinned}).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`clipdeck: could not open history: ${e}`);
        });

        this._indicator = new ClipboardIndicator(() => this._togglePopup());
        // Right after the clock in the middle of the top bar.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'center');

        this._settingsIds = [
            this._settings.connect('changed::history-size', () => this._store.trim()),
            this._settings.connect('changed::clear-trigger', () => this._store.clear()),
        ];

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._scheduleCapture();
        });

        this._scheduleCapture();
    }

    disable() {
        this._closePopup();

        this._indicator.destroy();
        this._indicator = null;

        this._selection.disconnect(this._ownerChangedId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));

        for (const id of [this._captureId, this._pasteId]) {
            if (id)
                GLib.source_remove(id);
        }

        this._virtualKeyboard?.run_dispose();
        this._virtualKeyboard = null;

        this._store.destroy();
        this._store = null;
        this._selection = null;
        this._clipboard = null;
        this._settings = null;
    }

    // Apps often replace the clipboard several times in a row; only read the
    // final owner.
    _scheduleCapture() {
        if (this._captureId)
            GLib.source_remove(this._captureId);
        this._captureId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAPTURE_DELAY_MS, () => {
            this._captureId = 0;
            this._capture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _capture() {
        if (this._settings.get_boolean('paused'))
            return;

        const mimes = this._clipboard.get_mimetypes(CLIPBOARD) ?? [];
        if (mimes.length === 0 || mimes.some(m => SECRET_MIMES.includes(m)))
            return;

        const serial = ++this._captureSerial;
        const isCurrent = () => this._store && serial === this._captureSerial;

        const fileMime = FILE_MIMES.find(m => mimes.includes(m));
        const textMime = TEXT_MIMES.find(m => mimes.includes(m));
        const imageMime = IMAGE_MIMES.find(m => mimes.includes(m)) ??
            mimes.find(m => m.startsWith('image/') && m !== 'image/svg+xml');

        const captureText = () => {
            this._clipboard.get_text(CLIPBOARD, (_clip, text) => {
                if (isCurrent() && text)
                    this._store.addText(text);
            });
        };

        const captureImage = () => {
            if (!this._settings.get_boolean('save-images'))
                return;
            this._clipboard.get_content(CLIPBOARD, imageMime, (_clip, bytes) => {
                if (!isCurrent() || !bytes || bytes.get_size() === 0)
                    return;
                if (bytes.get_size() > this._settings.get_int('max-image-mb') * 1024 * 1024)
                    return;
                this._store.addImage(bytes, imageMime).catch(e =>
                    console.error(`clipdeck: could not record image: ${e}`));
            });
        };

        // Prefer text over an image when both are offered: office apps put a
        // rendered picture next to the copied text.
        const captureFallback = () => {
            if (textMime)
                captureText();
            else if (imageMime)
                captureImage();
        };

        if (fileMime) {
            this._clipboard.get_content(CLIPBOARD, fileMime, (_clip, bytes) => {
                if (!isCurrent())
                    return;
                const uris = bytes ? parseUris(bytes, fileMime) : [];
                // Browsers also use text/uri-list for web links; only local
                // files count as a file copy.
                if (uris.length > 0 && uris.every(u => u.startsWith('file://')))
                    this._store.addFiles(uris);
                else if (textMime || imageMime || uris.length === 0)
                    captureFallback();
                else
                    this._store.addText(uris.join('\n'));
            });
        } else {
            captureFallback();
        }
    }

    _togglePopup() {
        if (this._popup) {
            this._closePopup();
            return;
        }
        this._popup = new ClipboardPopup(this._store, this._indicator,
            this._settings.get_boolean('paste-on-select'),
            entry => this._activate(entry), () => this.openPreferences());
        this._popup.connect('closed', () => {
            this._popup = null;
            this._indicator?.remove_style_pseudo_class('active');
        });
        this._indicator.add_style_pseudo_class('active');
        this._popup.open();
    }

    _closePopup() {
        this._popup?.close();
        this._popup = null;
    }

    async _activate(entry) {
        try {
            await this._setClipboard(entry);
        } catch (e) {
            console.error(`clipdeck: could not restore item: ${e}`);
            Main.notify('Clipboard', 'This item is no longer available.');
            return;
        }

        if (!this._settings || !this._settings.get_boolean('paste-on-select'))
            return;

        // Give the focused window time to get keyboard focus back after the
        // popup's grab is released.
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            this._sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _setClipboard(entry) {
        switch (entry.type) {
        case 'text':
            this._clipboard.set_text(CLIPBOARD, entry.text);
            break;
        case 'image': {
            const [contents] = await Gio.File.new_for_path(this._store.blobPath(entry)).load_contents_async(null);
            this._clipboard?.set_content(CLIPBOARD, entry.mime, new GLib.Bytes(contents));
            break;
        }
        case 'files': {
            // The shell clipboard can only offer one type; this is the one
            // Nautilus, the desktop and GTK file choosers paste from.
            const data = `copy\n${entry.uris.join('\n')}`;
            this._clipboard.set_content(CLIPBOARD, 'x-special/gnome-copied-files',
                new GLib.Bytes(encoder.encode(data)));
            break;
        }
        }
    }

    _sendPasteKeys() {
        if (!this._virtualKeyboard) {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }

        const wmClass = global.display.focus_window?.get_wm_class()?.toLowerCase() ?? '';
        const keys = TERMINAL_CLASSES.includes(wmClass)
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];

        const time = GLib.get_monotonic_time();
        for (const key of keys)
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }
}
