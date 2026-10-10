# Build-Struktur

## Quelldateien vs. generierte Dateien

`website/app/` ist ein **Build-Artefakt** und darf nicht direkt bearbeitet werden.
Der Ordner wird bei jedem Build-Schritt vollständig gelöscht und aus `dist/` neu generiert:

```
scripts/copy-preview.js: dist/ → website/app/  (rmSync + cpSync)
```

### Wo editieren?

| Datei | Richtige Quelle |
|---|---|
| `website/app/live.js` | `dist/live.js` |
| `website/app/live.html` | `dist/live.html` |
| `website/app/styles.css` | `dist/styles.css` |
| `website/app/settings.js` | `dist/settings.js` |
| `website/app/bundle.js` | wird von webpack aus `src/main.js` gebaut |

`dist/version.json` ist ebenfalls generiert — Versionsnummer nur in `package.json` ändern.

## Versionsnummer pflegen

Bei jedem Version-Bump müssen folgende Stellen angepasst werden:

| Stelle | Wie |
|---|---|
| `package.json` (`version`) | **manuell** — die Single Source of Truth |
| `dist/version.json` | **generiert** aus `package.json` via `scripts/build-version.js` (nicht von Hand) |
| `website/index.html` (`softwareVersion` im JSON-LD) | **manuell** — wird **nicht** vom Build aktualisiert, leicht zu vergessen |

Also: `package.json` und das JSON-LD in `website/index.html` immer **beide** von Hand auf dieselbe Version setzen.

## Nativer Rewrite (Zweig `native-rewrite`)

Die Electron-App wird durch eine native Rust-App ersetzt. Bis zur Ablösung existieren
beide nebeneinander; der Electron-Code (`electron/`, `src/`, `dist/`) bleibt lauffähig.

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

- Die Version der nativen App steht in `Cargo.toml` (`[workspace.package]`), unabhängig von
  `package.json`, solange beide Apps existieren.
- `crates/mdstage-engine/src/display.rs` bindet `dist/display/index.html` und
  `dist/display/app.js` ein – der Display-Client bleibt eine Webseite.
- CI für die native App: `.github/workflows/native.yml` (nur Artefakte, kein Release):
  dmg, AppImage, deb, rpm, Windows-Installer (`scripts/windows-installer.nsi`) und zip.
- Texte der Oberfläche: `crates/mdstage-app/src/lang.rs`, an Ort und Stelle als
  `t("Deutsch", "English")`. Neue Texte immer in beiden Sprachen.
- Audio wird gestreamt (`crates/mdstage-engine/src/stream.rs`), nie ganz geladen. Ob
  Streaming und vollständiges Dekodieren dasselbe liefern, prüft
  `cargo run --release -p mdstage-engine --example stream_probe -- AUDIO_ORDNER`.

## Git Tags

Tags immer **ohne** `v`-Präfix setzen: `1.11.6`, nicht `v1.11.6`.

## Backward-Compatibility

Backward-Compatibility ist **nicht** wichtig. Alte Datei-/Settings-Formate müssen nicht
weiter gelesen werden; Migrationspfade sind nicht erforderlich. Im Zweifel das alte Modell
sauber ersetzen statt parallel zu pflegen.
