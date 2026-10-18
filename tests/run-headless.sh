#!/bin/sh
# Runs the extension inside a throwaway headless GNOME Shell and prints the
# test results. Uses its own D-Bus session, settings, data and runtime dirs,
# so the real desktop session is not touched.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/clipdeck-test.XXXXXX")"
RUN="$(mktemp -d /tmp/wv.XXXX)"   # short: Wayland socket paths max 108 bytes
chmod 700 "$RUN"
EXT="$T/data/gnome-shell/extensions"

mkdir -p "$EXT" "$T/config/glib-2.0/settings" "$T/out" "$T/files"
make -s -C "$ROOT" install-user USER_EXT_DIR="$EXT/clipdeck@jdtensor.com" >/dev/null
cp -r "$ROOT/tests/clipdeck-test@local" "$EXT/"
printf "[org/gnome/shell]\nenabled-extensions=['clipdeck@jdtensor.com', 'clipdeck-test@local']\n" \
    > "$T/config/glib-2.0/settings/keyfile"
# The simulated mouse can start in the top-left hot corner; keep it from
# opening the overview.
printf "\n[org/gnome/desktop/interface]\nenable-hot-corners=false\n" >> "$T/config/glib-2.0/settings/keyfile"

# Sample clipboard data: a 48x48 PNG and a large JPEG, generated so the test
# does not depend on files installed on the machine.
gjs -c "
imports.gi.versions.GdkPixbuf = '2.0';
const {Pixbuf, Colorspace} = imports.gi.GdkPixbuf;
const small = Pixbuf.new(Colorspace.RGB, false, 8, 48, 48);
small.fill(0x3388ffff);
small.savev('$T/files/sample.png', 'png', [], []);
const big = Pixbuf.new(Colorspace.RGB, false, 8, 1920, 1080);
big.fill(0x88aa44ff);
big.savev('$T/files/big.jpg', 'jpeg', [], []);
"
head -c 2000 /dev/urandom > "$T/files/clip.mp4"
echo hi > "$T/files/notes file.txt"

# Behave like an Ubuntu login (Ubuntu Dock as the dock, no overview at
# start) when Ubuntu's session mode is installed.
MODE=""
[ -f /usr/share/gnome-shell/modes/ubuntu.json ] && MODE="--mode=ubuntu"

env -u DISPLAY -u WAYLAND_DISPLAY -u GSETTINGS_SCHEMA_DIR -u GTK_PATH -u GIO_MODULE_DIR \
    -u GDK_PIXBUF_MODULE_FILE -u LD_LIBRARY_PATH \
    XDG_RUNTIME_DIR="$RUN" XDG_DATA_DIRS=/usr/share/ubuntu:/usr/share/gnome:/usr/local/share:/usr/share \
    XDG_DATA_HOME="$T/data" XDG_CONFIG_HOME="$T/config" XDG_CACHE_HOME="$T/cache" \
    XDG_STATE_HOME="$T/state" XDG_CURRENT_DESKTOP=ubuntu:GNOME GSETTINGS_BACKEND=keyfile CLIPDECK_TEST_DIR="$T" \
    timeout 90 dbus-run-session -- gnome-shell $MODE --headless --wayland --no-x11 \
    --virtual-monitor 1280x800 --wayland-display wt > "$T/shell.log" 2>&1 &
PID=$!

i=0
while [ ! -f "$T/out/result.txt" ] && [ $i -lt 80 ]; do
    sleep 1
    i=$((i + 1))
done
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
rm -rf "$RUN"

cat "$T/out/result.txt" 2>/dev/null || echo "No result; see $T/shell.log"
grep -E "JS ERROR|JS WARNING|clipdeck:" "$T/shell.log" | grep -v CLIPDECKTEST || true
echo "Artifacts: $T"
grep -q '^FAIL' "$T/out/result.txt" 2>/dev/null && exit 1
[ -f "$T/out/result.txt" ]
