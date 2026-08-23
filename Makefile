UUID := codex-usage@local
BUILD_DIR := build/$(UUID)
SOURCES := metadata.json extension.js appServerClient.js prefs.js stylesheet.css \
	icons/OpenAI-white-monoblossom.svg

.PHONY: all pack install clean check smoke

all: pack

check:
	glib-compile-schemas --strict schemas
	mkdir -p build
	gnome-extensions pack --force --out-dir=build \
		--extra-source=appServerClient.js \
		--extra-source=icons \
		--extra-source=README.md \
		--extra-source=LICENSE \
		.

pack: check

smoke:
	gjs -m tests/app-server-smoke.js

install: pack
	gnome-extensions install --force build/$(UUID).shell-extension.zip

clean:
	rm -f build/$(UUID).shell-extension.zip
	rm -f schemas/gschemas.compiled
