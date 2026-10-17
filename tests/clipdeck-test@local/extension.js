// Test harness extension. tests/run-headless.sh loads it next to
// Clipdeck inside a throwaway headless GNOME Shell; it drives the
// extension and writes PASS/FAIL lines to $CLIPDECK_TEST_DIR/out/result.txt.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const T = GLib.getenv('CLIPDECK_TEST_DIR');
const C = St.ClipboardType.CLIPBOARD;
const UUID = 'clipdeck@jdtensor.com';
const lines = [];
const out = s => {
    lines.push(s);
    console.log(`CLIPDECKTEST ${s}`);
};
const check = (name, cond) => out(`${cond ? 'PASS' : 'FAIL'} ${name}`);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const getText = () => new Promise(r => St.Clipboard.get_default().get_text(C, (_c, t) => r(t)));
const bytesOf = s => new GLib.Bytes(new TextEncoder().encode(s));

// Real pointer click through Clutter, so the same event path as a user's
// mouse is exercised.
let pointer = null;
async function clickActor(actor) {
    pointer ??= Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const [x, y] = actor.get_transformed_position();
    const t = () => GLib.get_monotonic_time();
    pointer.notify_absolute_motion(t(), x + actor.width / 2, y + actor.height / 2);
    await sleep(100);
    pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(50);
    pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
}

function shot(name) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(`${T}/out/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (s, res) => {
            try {
                s.screenshot_finish(res);
            } catch (e) {
                out(`shot error ${e}`);
            }
            stream.close(null);
            resolve();
        });
    });
}

export default class TestExt extends Extension {
    enable() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._run().catch(e => out(`FAIL exception ${e}\n${e.stack}`)).finally(() => {
                GLib.file_set_contents(`${T}/out/result.txt`, `${lines.join('\n')}\nDONE\n`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}

    async _run() {
        const ext = Main.extensionManager.lookup(UUID);
        out(`state=${ext?.state} error=${ext?.error}`);
        const obj = ext.stateObj;
        const clip = St.Clipboard.get_default();
        const kb = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});

        check('super+v left alone', kb.get_strv('toggle-message-tray').includes('<Super>v'));
        const ind = Main.panel.statusArea[UUID];
        check('panel icon right after clock', !!ind && Main.panel._centerBox.get_child_at_index(1) === ind.container);

        clip.set_text(C, 'hello world one');
        await sleep(400);
        clip.set_text(C, 'second item\nwith two lines and a fairly long second line that should wrap inside the popup card nicely');
        await sleep(400);
        const [, png] = GLib.file_get_contents(`${T}/files/sample.png`);
        clip.set_content(C, 'image/png', new GLib.Bytes(png));
        await sleep(400);
        clip.set_content(C, 'x-special/gnome-copied-files', bytesOf(`copy\nfile://${T}/files/clip.mp4`));
        await sleep(400);
        const multi = ['clip.mp4', 'notes file.txt', 'sample.png'].map(n => Gio.File.new_for_path(`${T}/files/${n}`).get_uri());
        clip.set_content(C, 'text/uri-list', bytesOf(multi.join('\r\n')));
        await sleep(400);
        clip.set_content(C, 'text/uri-list', bytesOf('https://example.com/'));
        await sleep(400);
        const [, jpg] = GLib.file_get_contents(`${T}/files/big.jpg`);
        clip.set_content(C, 'image/jpeg', new GLib.Bytes(jpg));
        await sleep(600);

        const e = obj._store.entries;
        check('7 entries captured', e.length === 7);
        check('image captured with size', e.some(x => x.type === 'image' && x.width === 48));
        check('single file entry', e.some(x => x.type === 'files' && x.uris.length === 1));
        check('three file entry', e.some(x => x.type === 'files' && x.uris.length === 3));
        check('web link stored as text', e.some(x => x.text === 'https://example.com/'));

        clip.set_text(C, 'hello world one');
        await sleep(400);
        check('dedupe moves to top', obj._store.entries.length === 7 && obj._store.entries[0].text === 'hello world one');

        // Click the top-bar icon.
        await clickActor(ind);
        await sleep(1000);
        check('popup open', !!obj._popup);
        check('icon highlighted while open', ind.has_style_pseudo_class('active'));
        const [ix, iy] = ind.get_transformed_position();
        const card = obj._popup._card;
        out(`icon=${ix},${iy} ${ind.width}x${ind.height} card=${card.x},${card.y} ${card.width}x${card.height}`);
        check('card just under icon', card.y >= iy + ind.height && card.y - (iy + ind.height) < 20);
        check('card horizontally around icon', card.x <= ix && card.x + card.width >= ix + ind.width);
        await shot('popup');

        obj._popup._entry.set_text('wrap');
        await sleep(300);
        check('search filters', obj._popup._rows.length === 1);
        obj._popup._entry.set_text('');
        await sleep(300);

        // Pin and delete buttons sit inside the clickable row; a click on
        // them must not also paste the row.
        const actions = r => r.get_child().get_last_child();
        const before = obj._store.entries.length;
        const firstId = obj._popup._visible[0].id;
        await clickActor(actions(obj._popup._rows[0]).get_first_child());
        await sleep(400);
        check('pin click keeps popup open', !!obj._popup);
        check('pin click pins', obj._store.entries.find(x => x.id === firstId)?.pinned === true);
        await clickActor(actions(obj._popup._rows[0]).get_first_child());
        await sleep(400);
        check('second pin click unpins', obj._store.entries.find(x => x.id === firstId)?.pinned === false);
        await clickActor(actions(obj._popup._rows[0]).get_last_child());
        await sleep(400);
        check('delete click keeps popup open', !!obj._popup);
        check('delete click removes', obj._store.entries.length === before - 1 && !obj._store.entries.some(x => x.id === firstId));
        clip.set_text(C, 'hello world one');
        await sleep(400);
        check('copy while open shows up', obj._popup?._visible[0]?.text === 'hello world one');

        // First image row is near the top, so it is on screen to click.
        const imgIndex = obj._popup._visible.findIndex(x => x.type === 'image');
        const imgMime = obj._popup._visible[imgIndex].mime;
        await clickActor(obj._popup._rows[imgIndex]);
        await sleep(600);
        check('popup closed after choosing', !obj._popup);
        check('icon not highlighted after close', !ind.has_style_pseudo_class('active'));
        check('clicked image is on clipboard', clip.get_mimetypes(C).includes(imgMime));
        check('image moved to top, no dup', obj._store.entries[0].type === 'image' && obj._store.entries.length === 7);

        const fileEntry = obj._store.entries.find(x => x.type === 'files' && x.uris.length === 3);
        obj._activate(fileEntry);
        await sleep(600);
        check('clipboard holds files', clip.get_mimetypes(C).includes('x-special/gnome-copied-files'));
        check('files entry deduped', obj._store.entries.length === 7 && obj._store.entries[0].id === fileEntry.id);

        const textEntry = obj._store.entries.find(x => x.text?.startsWith('second'));
        obj._activate(textEntry);
        await sleep(600);
        check('clipboard holds text', (await getText()) === textEntry.text);

        obj._store.togglePin(textEntry.id);
        obj._settings.set_int('clear-trigger', obj._settings.get_int('clear-trigger') + 1);
        await sleep(200);
        check('clear keeps pinned only', obj._store.entries.length === 1 && obj._store.entries[0].pinned);

        obj._settings.set_boolean('paused', true);
        clip.set_text(C, 'while paused');
        await sleep(400);
        check('paused ignores copies', obj._store.entries.length === 1);
        obj._settings.set_boolean('paused', false);

        obj._settings.set_int('history-size', 5);
        for (let i = 0; i < 8; i++) {
            clip.set_text(C, `bulk ${i}`);
            await sleep(250);
        }
        check('limit 5 unpinned + 1 pinned', obj._store.entries.length === 6);

        // Clicking the icon again closes the popup.
        await clickActor(ind);
        await sleep(500);
        obj._popup._move(2);
        check('selection moves', obj._popup._selected === 2);
        await clickActor(ind);
        await sleep(400);
        check('second click closes', !obj._popup);

        await sleep(800);
        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipdeck']);
        const [ok, json] = GLib.file_get_contents(`${dataDir}/history.json`);
        check('history.json saved', ok && JSON.parse(new TextDecoder().decode(json)).entries.length === 6);

        Main.extensionManager.disableExtension(UUID);
        await sleep(500);
        check('disable removes icon', !Main.panel.statusArea[UUID]);
        Main.extensionManager.enableExtension(UUID);
        await sleep(800);
        check('re-enable reloads history', Main.extensionManager.lookup(UUID).stateObj._store.entries.length === 6);
        check('re-enable adds icon', !!Main.panel.statusArea[UUID]);
    }
}
