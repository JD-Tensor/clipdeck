// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Subhadip Jana <subhadipjana@jdtensor.com>
//
// Clipboard history storage.
//
// History lives in ~/.local/share/clipdeck/history.json and image data in
// ~/.local/share/clipdeck/images/. Both are created private (0700/0600)
// because clipboard contents are often sensitive. All file access is
// asynchronous so the shell never waits on the disk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'get_file_info_async');

const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const WRITE_FLAGS = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;

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

function isError(e, code) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, code);
}

async function ensurePrivateDir(file, cancellable) {
    try {
        await file.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (isError(e, Gio.IOErrorEnum.EXISTS))
            return;
        throw e;
    }
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', 0o700);
    await file.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
}

export class HistoryStore {
    constructor(settings) {
        this._settings = settings;
        this._dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'clipdeck']));
        this._blobDir = this._dir.get_child('images');
        this._file = this._dir.get_child('history.json');
        this._cancellable = new Gio.Cancellable();
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._saveId = 0;
        this._saving = false;
        this._saveAgain = false;
        // Nothing is written until the saved history has been read, so an
        // early save can never replace it with a partial list.
        this._loaded = false;
        this.entries = [];
    }

    async load({clearUnpinned = false} = {}) {
        await ensurePrivateDir(this._dir, this._cancellable);
        await ensurePrivateDir(this._blobDir, this._cancellable);

        let entries = [];
        try {
            const [contents] = await this._file.load_contents_async(this._cancellable);
            const data = JSON.parse(decoder.decode(contents));
            if (Array.isArray(data.entries))
                entries = data.entries.filter(e => this._isWellFormed(e));
        } catch (e) {
            if (isError(e, Gio.IOErrorEnum.CANCELLED))
                throw e;
            if (!isError(e, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`clipdeck: could not load history: ${e}`);
        }

        // Drop image entries whose file has gone missing.
        const present = await Promise.all(entries.map(async e => {
            if (e.type !== 'image')
                return true;
            try {
                await this._blobDir.get_child(e.blob).query_info_async('standard::type',
                    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
                return true;
            } catch {
                return false;
            }
        }));
        entries = entries.filter((_e, i) => present[i]);

        // Items copied before loading finished come first.
        const hashes = new Set(this.entries.map(e => e.hash));
        this.entries = [...this.entries, ...entries.filter(e => !hashes.has(e.hash))];
        if (clearUnpinned)
            this.entries = this.entries.filter(e => e.pinned);

        this._loaded = true;
        this._trim();
        this._changed();
        this._removeOrphanBlobs();
    }

    // Writes any pending change and stops all work. Safe to call from
    // disable(): the final write is started here and finishes on its own.
    destroy() {
        this._cancellable.cancel();
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._writeFile(null).catch(e => console.error(`clipdeck: could not save history: ${e}`));
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
        return this._blobDir.get_child(entry.blob).get_path();
    }

    addText(text) {
        if (!text || text.length > MAX_TEXT_CHARS)
            return null;
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `text\n${text}`, -1);
        return this._add({type: 'text', text, hash});
    }

    async addImage(bytes, mime) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        if (this.entries.some(e => e.hash === hash))
            return this._add({hash});

        const blob = `${hash}.${IMAGE_EXTENSIONS[mime] ?? 'img'}`;
        const file = this._blobDir.get_child(blob);
        try {
            await file.replace_contents_bytes_async(bytes, null, false, WRITE_FLAGS, this._cancellable);
        } catch (e) {
            if (!isError(e, Gio.IOErrorEnum.CANCELLED))
                console.error(`clipdeck: could not save image: ${e}`);
            return null;
        }

        let width = 0, height = 0;
        try {
            [, width, height] = await GdkPixbuf.Pixbuf.get_file_info_async(file.get_path(), this._cancellable);
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
        } else if (partial.type) {
            entry = {id: GLib.uuid_string_random(), time: Date.now(), pinned: false, ...partial};
        } else {
            return null;
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

    _isWellFormed(e) {
        if (!e || typeof e.id !== 'string' || typeof e.hash !== 'string')
            return false;
        switch (e.type) {
        case 'text':
            return typeof e.text === 'string';
        case 'files':
            return Array.isArray(e.uris) && e.uris.length > 0;
        case 'image':
            return typeof e.blob === 'string' && !e.blob.includes('/');
        default:
            return false;
        }
    }

    _deleteBlobIfUnused(entry) {
        if (!entry.blob || this.entries.some(e => e.blob === entry.blob))
            return;
        this._blobDir.get_child(entry.blob).delete_async(GLib.PRIORITY_DEFAULT, null)
            .catch(() => {});  // Already gone.
    }

    async _removeOrphanBlobs() {
        const used = new Set(this.entries.map(e => e.blob).filter(Boolean));
        try {
            const enumerator = await this._blobDir.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
            let infos;
            while ((infos = await enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, this._cancellable)).length) {
                for (const info of infos) {
                    if (!used.has(info.get_name()))
                        this._blobDir.get_child(info.get_name()).delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
                }
            }
        } catch (e) {
            if (!isError(e, Gio.IOErrorEnum.CANCELLED))
                console.error(`clipdeck: could not clean image folder: ${e}`);
        }
    }

    _changed() {
        for (const callback of this._listeners.values())
            callback();

        if (this._loaded && !this._saveId) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 500, () => {
                this._saveId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // One write at a time; changes made during a write trigger another one.
    async _save() {
        if (this._saving) {
            this._saveAgain = true;
            return;
        }
        this._saving = true;
        try {
            do {
                this._saveAgain = false;
                await this._writeFile(this._cancellable);
            } while (this._saveAgain);
        } catch (e) {
            if (!isError(e, Gio.IOErrorEnum.CANCELLED))
                console.error(`clipdeck: could not save history: ${e}`);
        } finally {
            this._saving = false;
        }
    }

    _writeFile(cancellable) {
        const json = JSON.stringify({version: 1, entries: this.entries});
        return this._file.replace_contents_bytes_async(new GLib.Bytes(encoder.encode(json)),
            null, false, WRITE_FLAGS, cancellable);
    }
}
