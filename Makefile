UUID := clipdeck@jdtensor.com
PREFIX ?= /usr
EXT_DIR = $(DESTDIR)$(PREFIX)/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(DESTDIR)$(PREFIX)/share/glib-2.0/schemas
USER_EXT_DIR ?= $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SOURCES := extension/metadata.json extension/extension.js extension/historyStore.js \
	extension/popup.js extension/prefs.js extension/stylesheet.css
SCHEMAS := extension/schemas/org.gnome.shell.extensions.clipdeck.gschema.xml

.PHONY: all install install-user uninstall-user zip deb clean

# Nothing to compile; validate the schema so a broken one fails the build.
all:
	glib-compile-schemas --strict --dry-run extension/schemas

# System-wide install, used by the Debian package (dh_auto_install).
install:
	install -d $(EXT_DIR) $(SCHEMA_DIR)
	install -m 644 $(SOURCES) $(EXT_DIR)/
	install -m 644 $(SCHEMAS) $(SCHEMA_DIR)/

# Current user only, no root. Log out and back in afterwards.
install-user:
	rm -rf $(USER_EXT_DIR)
	install -d $(USER_EXT_DIR)/schemas
	install -m 644 $(SOURCES) $(USER_EXT_DIR)/
	install -m 644 $(SCHEMAS) $(USER_EXT_DIR)/schemas/
	glib-compile-schemas $(USER_EXT_DIR)/schemas

uninstall-user:
	-gnome-extensions disable $(UUID)
	rm -rf $(USER_EXT_DIR)

# Upload bundle for extensions.gnome.org.
zip:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=historyStore.js --extra-source=popup.js extension

# Local binary package for testing; output goes to dist/.
deb:
	dpkg-buildpackage -us -uc -b
	mkdir -p dist
	mv ../gnome-shell-extension-clipdeck_* dist/

clean:
	rm -rf dist
