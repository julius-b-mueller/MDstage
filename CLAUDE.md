# Build-Struktur

Ausgeliefert wird die native Rust-App (siehe „Nativer Rewrite"). Die Abschnitte zu
`website/app/`, `dist/` und `package.json` betreffen nur noch die alte Electron-App, die im
Repository liegt, aber von der CI nicht mehr gebaut oder veröffentlicht wird.

## Quelldateien vs. generierte Dateien (Electron, nur lokal)

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

Für ein Release der nativen App müssen drei Stellen dieselbe Version tragen:

| Stelle | Wie |
|---|---|
| `Cargo.toml` (`[workspace.package]` → `version`) | **manuell** — die Single Source of Truth |
| `website/index.html` (`softwareVersion` im JSON-LD) | **manuell** — leicht zu vergessen |
| Git-Tag | ohne `v`-Präfix, z. B. `2.0.0` |

Die CI (Job `versions`) bricht ein Tag ab, das nicht zu `Cargo.toml` passt, und bei einem
vollen Release auch eines, das nicht zu `softwareVersion` passt. Ein Tag mit Zusatz
(`2.0.0-beta.1`) wird als Vorabversion veröffentlicht: Die Download-Links der Website
(`releases/latest`) zeigen dann weiter auf das letzte volle Release, und `softwareVersion`
bleibt unberührt.

### Electron-App (alt)

Bei einem Version-Bump der Electron-App müssen folgende Stellen angepasst werden:

| Stelle | Wie |
|---|---|
| `package.json` (`version`) | **manuell** — die Single Source of Truth |
| `dist/version.json` | **generiert** aus `package.json` via `scripts/build-version.js` (nicht von Hand) |

Das JSON-LD der Website folgt nicht mehr `package.json`, sondern der nativen App.

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
- CI: `.github/workflows/build.yml`. Push auf `main`: Tests, dann geht `website/` auf
  GitHub Pages (reine Dateien, nichts wird gebaut). Push auf `native-rewrite`: Tests und
  Pakete als Artefakte. Tag: Tests, Pakete, GitHub-Release.
- Pakete und ihre Namen im Release (die Website verlinkt sie über `releases/latest`):
  `MDstage-macos-arm64.dmg`, `MDstage-windows-{x64,arm64}.exe` (Installer,
  `scripts/windows-installer.nsi`), `MDstage-windows-{x64,arm64}-portable.zip`,
  `MDstage-linux-{x64,arm64}.{AppImage,deb,rpm,tar.gz}`. Wer einen Namen ändert, muss die
  Download-Links in `website/index.html` mitändern.
- Die Website hat keine Browser-Vorschau mehr (`website/preview/` ist entfernt).
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
