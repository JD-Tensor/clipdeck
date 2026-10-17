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

# Sample clipboard data.
cp "$(ls /usr/share/icons/hicolor/48x48/apps/*.png | head -1)" "$T/files/sample.png"
cp "$(ls /usr/share/backgrounds/*.jpg | head -1)" "$T/files/big.jpg"
head -c 2000 /dev/urandom > "$T/files/clip.mp4"
echo hi > "$T/files/notes file.txt"

env -u DISPLAY -u WAYLAND_DISPLAY -u GSETTINGS_SCHEMA_DIR -u GTK_PATH -u GIO_MODULE_DIR \
    -u GDK_PIXBUF_MODULE_FILE -u LD_LIBRARY_PATH \
    XDG_RUNTIME_DIR="$RUN" XDG_DATA_DIRS=/usr/share/ubuntu:/usr/share/gnome:/usr/local/share:/usr/share \
    XDG_DATA_HOME="$T/data" XDG_CONFIG_HOME="$T/config" XDG_CACHE_HOME="$T/cache" \
    XDG_STATE_HOME="$T/state" GSETTINGS_BACKEND=keyfile CLIPDECK_TEST_DIR="$T" \
    timeout 90 dbus-run-session -- gnome-shell --headless --wayland --no-x11 \
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
