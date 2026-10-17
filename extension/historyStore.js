// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Subhadip Jana <subhadipjana@jdtensor.com>
//
// Clipboard history storage.
//
// History lives in ~/.local/share/clipdeck/history.json and image data in
// ~/.local/share/clipdeck/images/. Both are created private (0700/0600)
// because clipboard contents are often sensitive.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

const MAX_TEXT_CHARS = 4 * 1024 * 1024;

const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class HistoryStore {
    constructor(settings) {
        this._settings = settings;
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipdeck']);
        this._blobDir = GLib.build_filenamev([this._dir, 'images']);
        this._file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'history.json']));
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._saveId = 0;
        this.entries = [];

        GLib.mkdir_with_parents(this._blobDir, 0o700);
    }

    load({clearUnpinned = false} = {}) {
        try {
            const [, contents] = this._file.load_contents(null);
            const data = JSON.parse(decoder.decode(contents));
            if (Array.isArray(data.entries))
                this.entries = data.entries.filter(e => this._isValid(e));
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                console.error(`clipdeck: could not load history: ${e}`);
        }

        if (clearUnpinned)
            this.entries = this.entries.filter(e => e.pinned);

        this._trim();
        this._removeOrphanBlobs();
        this._changed();
    }

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
        this._listeners.clear();
    }

    connectChanged(callback) {
        const id = this._nextListenerId++;
        this._listeners.set(id, callback);
        return id;
    }

    disconnectChanged(id) {
        this._listeners.delete(id);
    }

    blobPath(entry) {
        return GLib.build_filenamev([this._blobDir, entry.blob]);
    }

    addText(text) {
        if (!text || text.length > MAX_TEXT_CHARS)
            return null;
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `text\n${text}`, -1);
        return this._add({type: 'text', text, hash});
    }

    addImage(bytes, mime) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        if (this.entries.some(e => e.hash === hash))
            return this._add({hash});

        const blob = `${hash}.${IMAGE_EXTENSIONS[mime] ?? 'img'}`;
        const path = GLib.build_filenamev([this._blobDir, blob]);
        try {
            Gio.File.new_for_path(path).replace_contents(bytes.toArray(), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`clipdeck: could not save image: ${e}`);
            return null;
        }

        let width = 0, height = 0;
        try {
            [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
        } catch {
            // Unknown format; the preview simply omits the size.
        }

        return this._add({type: 'image', mime, blob, width, height, size: bytes.get_size(), hash});
    }

    addFiles(uris) {
        if (!uris.length)
            return null;
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `files\n${uris.join('\n')}`, -1);
        return this._add({type: 'files', uris, hash});
    }

    remove(id) {
        const idx = this.entries.findIndex(e => e.id === id);
        if (idx < 0)
            return;
        const [entry] = this.entries.splice(idx, 1);
        this._deleteBlobIfUnused(entry);
        this._changed();
    }

    togglePin(id) {
        const entry = this.entries.find(e => e.id === id);
        if (!entry)
            return;
        entry.pinned = !entry.pinned;
        this._trim();
        this._changed();
    }

    // Like Windows, "Clear all" keeps pinned items.
    clear() {
        const removed = this.entries.filter(e => !e.pinned);
        this.entries = this.entries.filter(e => e.pinned);
        removed.forEach(e => this._deleteBlobIfUnused(e));
        this._changed();
    }

    trim() {
        this._trim();
        this._changed();
    }

    // Moves an existing entry (matched by hash) to the top, or inserts a new one.
    _add(partial) {
        const idx = this.entries.findIndex(e => e.hash === partial.hash);
        let entry;
        if (idx >= 0) {
            [entry] = this.entries.splice(idx, 1);
            entry.time = Date.now();
        } else {
            entry = {id: GLib.uuid_string_random(), time: Date.now(), pinned: false, ...partial};
        }
        this.entries.unshift(entry);
        this._trim();
        this._changed();
        return entry;
    }

    _trim() {
        const max = this._settings.get_int('history-size');
        let unpinned = 0;
        const removed = [];
        this.entries = this.entries.filter(e => {
            if (e.pinned || ++unpinned <= max)
                return true;
            removed.push(e);
            return false;
        });
        removed.forEach(e => this._deleteBlobIfUnused(e));
    }

    _isValid(e) {
        if (!e || typeof e.id !== 'string' || typeof e.hash !== 'string')
            return false;
        switch (e.type) {
        case 'text':
            return typeof e.text === 'string';
        case 'files':
            return Array.isArray(e.uris) && e.uris.length > 0;
        case 'image':
            return typeof e.blob === 'string' &&
                GLib.file_test(this.blobPath(e), GLib.FileTest.EXISTS);
        default:
            return false;
        }
    }

    _deleteBlobIfUnused(entry) {
        if (!entry.blob || this.entries.some(e => e.blob === entry.blob))
            return;
        try {
            Gio.File.new_for_path(this.blobPath(entry)).delete(null);
        } catch {
            // Already gone.
        }
    }

    _removeOrphanBlobs() {
        const used = new Set(this.entries.map(e => e.blob).filter(Boolean));
        try {
            const dir = Gio.File.new_for_path(this._blobDir);
            const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                if (!used.has(info.get_name()))
                    dir.get_child(info.get_name()).delete(null);
            }
            enumerator.close(null);
        } catch (e) {
            console.error(`clipdeck: could not clean image folder: ${e}`);
        }
    }

    _changed() {
        for (const callback of this._listeners.values())
            callback();

        if (!this._saveId) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 500, () => {
                this._saveId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _save() {
        try {
            const json = JSON.stringify({version: 1, entries: this.entries});
            this._file.replace_contents(encoder.encode(json), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`clipdeck: could not save history: ${e}`);
        }
    }
}
