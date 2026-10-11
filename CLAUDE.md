# MDstage

Native Rust-App (egui). Die frühere Electron-App ist entfernt.

## Aufbau

| Crate | Inhalt |
|---|---|
| `crates/mdstage-core` | Show-Datei lesen/schreiben, Cue-Logik, Prüfungen – ohne I/O |
| `crates/mdstage-engine` | Audio, MIDI, Timecode, OSC, HTTP, Display-Server, Sitzung |
| `crates/mdstage-app` | Oberfläche (egui), Export |

```
cargo test --workspace                    # alle Tests
cargo run --release -p mdstage-app -- SHOW.md
scripts/bundle-macos.sh --dmg             # target/bundle/MDstage.app und .dmg
scripts/bundle-appimage.sh                # AppImage (nur unter Linux)
```

- Der Display-Client ist eine Webseite: `crates/mdstage-engine/display/index.html` und
  `app.js`, eingebunden von `crates/mdstage-engine/src/display.rs`.
- App-Symbol und Bilder der Oberfläche: `crates/mdstage-app/assets/`.
- Texte der Oberfläche: `crates/mdstage-app/src/lang.rs`, an Ort und Stelle als
  `t("Deutsch", "English")`. Neue Texte immer in beiden Sprachen.
- Audio wird gestreamt (`crates/mdstage-engine/src/stream.rs`), nie ganz geladen. Ob
  Streaming und vollständiges Dekodieren dasselbe liefern, prüft
  `cargo run --release -p mdstage-engine --example stream_probe -- AUDIO_ORDNER`.
- `scripts/bundle-macos.sh` signiert das ganze App-Bündel ad hoc. Ohne das meldet macOS
  eine geladene App als „beschädigt".

## Website

`website/` sind reine Dateien, nichts wird gebaut. Ein Push auf `main` veröffentlicht den
Ordner unverändert auf GitHub Pages. Eine Browser-Vorschau der App gibt es nicht mehr.

## CI und Release

`.github/workflows/build.yml`:

- Push auf `main`: Tests, dann geht `website/` auf GitHub Pages.
- Push auf `native-rewrite`: Tests und Pakete als Artefakte.
- Tag: Tests, Pakete, GitHub-Release.

Pakete und ihre Namen im Release (die Website verlinkt sie über `releases/latest`):
`MDstage-macos-arm64.dmg`, `MDstage-windows-{x64,arm64}.exe` (Installer,
`scripts/windows-installer.nsi`), `MDstage-windows-{x64,arm64}-portable.zip`,
`MDstage-linux-{x64,arm64}.{AppImage,deb,rpm,tar.gz}`. Wer einen Namen ändert, muss die
Download-Links in `website/index.html` mitändern.

## Versionsnummer pflegen

Für ein Release müssen drei Stellen dieselbe Version tragen:

| Stelle | Wie |
|---|---|
| `Cargo.toml` (`[workspace.package]` → `version`) | **manuell** — die Single Source of Truth |
| `website/index.html` (`softwareVersion` im JSON-LD) | **manuell** — leicht zu vergessen |
| Git-Tag | ohne `v`-Präfix, z. B. `2.0.0` |

Die CI (Job `versions`) bricht ein Tag ab, das nicht zu `Cargo.toml` passt, und bei einem
vollen Release auch eines, das nicht zu `softwareVersion` passt. Ein Tag mit Zusatz
(`2.0.0-beta.1`) wird als Vorabversion veröffentlicht: Die Download-Links der Website
zeigen dann weiter auf das letzte volle Release, und `softwareVersion` bleibt unberührt.

## Git Tags

Tags immer **ohne** `v`-Präfix setzen: `1.11.6`, nicht `v1.11.6`.

## Backward-Compatibility

Backward-Compatibility ist **nicht** wichtig. Alte Datei-/Settings-Formate müssen nicht
weiter gelesen werden; Migrationspfade sind nicht erforderlich. Im Zweifel das alte Modell
sauber ersetzen statt parallel zu pflegen.
