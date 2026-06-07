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
