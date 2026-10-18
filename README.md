# Clipdeck

Clipboard history in the GNOME Shell top bar.

Click the clipboard icon next to the clock to see everything you copied or cut, then choose an item to copy it again.

Clipdeck records:

- **Text** from any app
- **Links**
- **Images and screenshots** (PrintScreen copies the screenshot to the clipboard)
- **Files and folders** you copy or cut in Files, including videos. Image and video files show a thumbnail when GNOME has made one.

It never records items that password managers mark as secret (KeePassXC, for example).

Requires GNOME Shell 50 or 51 (Ubuntu 26.04 LTS or 26.10).

## Install

From [extensions.gnome.org](https://extensions.gnome.org/) (search for **Clipdeck**), or from source for the current user only:

```sh
make install-user
```

Then log out and back in (GNOME on Wayland only loads new extensions at login), and turn on **Clipdeck** in the **Extensions** app, or run:

```sh
gnome-extensions enable clipdeck@jdtensor.com
```

## Use

| Action | Result |
|---|---|
| Click the top-bar icon | Open or close the history |
| Click an item, or select it and press Enter | Copy it back to the clipboard |
| ↑ / ↓, Page Up / Page Down | Select an item |
| Alt+1 … Alt+9 | Copy item 1–9 |
| Type | Search |
| Ctrl+P, or the pin button | Pin or unpin (pinned items are never removed automatically) |
| Delete, or the bin button | Remove the item (Shift+Delete while searching) |
| Esc, or click outside | Close |

### Paste straight away (optional)

By default, choosing an item only puts it back on the clipboard, and you paste it yourself with Ctrl+V. If you turn on **Also paste after choosing an item** in the settings, Clipdeck pastes it for you by sending a simulated Ctrl+V to the window you were using (Ctrl+Shift+V in terminals). GNOME has no proper way for an extension to paste into another app, so this is off unless you ask for it.

## Settings

Click the gear in the popup, or open the **Extensions** app, to change:

- how many items to keep (default 25; pinned items do not count)
- whether choosing an item also pastes it (off by default)
- whether history is kept after logging out
- pausing recording
- whether images are recorded, and the largest size

You can also clear the history there.

## Privacy

History is stored in `~/.local/share/clipdeck/` (`history.json` plus an `images/` folder), readable only by your user. Nothing leaves your computer. Delete the folder to erase everything.

Clipdeck is turned off while the screen is locked, so nothing copied on the lock screen is recorded.

## Limits

- A file entry is pasted in the format that Files and GTK apps use (`x-special/gnome-copied-files`). Some non-GNOME apps only accept `text/uri-list` and may ignore it.
- Files are recorded as references, not copies. If you move or delete a file, its entry shows "(missing)".

## Development

| Command | What it does |
|---|---|
| `make install-user` | Install for the current user |
| `make deb` | Build a local `.deb` into `dist/` (needs `debhelper`) |
| `make zip` | Build the upload bundle for extensions.gnome.org into `dist/` |
| `sh tests/run-headless.sh` | Run the extension in a throwaway headless GNOME Shell and print PASS/FAIL lines; your desktop is not touched |

The tests drive the real extension with a simulated mouse inside GNOME Shell. They pass on GNOME Shell 50 (Ubuntu 26.04) and 51 (Ubuntu 26.10).

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
