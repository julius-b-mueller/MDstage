#!/bin/sh
# Writes THIRD-PARTY-LICENSES.txt: the license of every crate that ends up in the program
# (cargo about, see about.toml and about.hbs), followed by the notices of the fonts that
# typst-assets (PDF export) and epaint_default_fonts (the interface) bundle, which their
# crate licenses do not cover. The app shows the file under "About MDstage", and every
# package carries it. Run it after each change to Cargo.lock; the CI job `audit` fails
# when the file is out of date.
#
#   cargo install cargo-about@0.9.2 --locked --features cli
#   scripts/third-party-licenses.sh
set -eu

cd "$(dirname "$0")/.."
out=THIRD-PARTY-LICENSES.txt

cargo about generate --locked about.hbs -o "$out"

# Where cargo keeps the source of a crate from Cargo.lock.
crate_dir() {
    cargo metadata --format-version 1 --locked | python3 -I -c '
import json, os, sys
name = sys.argv[1]
for p in json.load(sys.stdin)["packages"]:
    if p["name"] == name and p["source"]:
        print(os.path.dirname(p["manifest_path"]))
        break
' "$1"
}

section() {
    printf '\n\n--------------------------------------------------------------------------------\n%s\n\n' "$1" >> "$out"
}

typst_assets=$(crate_dir typst-assets)
fonts=$(crate_dir epaint_default_fonts)/fonts

section "Fonts of typst-assets (PDF export) / Schriften von typst-assets (PDF-Export)"
cat "$typst_assets/NOTICE" >> "$out"

section "Hack font of epaint_default_fonts (interface) / Schrift Hack (Oberfläche)"
cat "$fonts/Hack-Regular.txt" >> "$out"

section "Emoji icon font of epaint_default_fonts (interface) / Emoji-Schrift (Oberfläche)"
cat "$fonts/emoji-icon-font-mit-license.txt" >> "$out"

# Some license texts come with Windows line endings; the file has Unix ones throughout.
tr -d '\r' < "$out" > "$out.tmp" && mv "$out.tmp" "$out"
