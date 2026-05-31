# Main Desk

Electron-basierte Regiebuch-App für Bühnenshows und Theaterproduktionen. Das Skript wird als Markdown-Datei gespeichert; Cues sind direkt als YAML-Blöcke eingebettet. Die App ermöglicht Audiowiedergabe, MIDI-Steuerung, Timecode-Output und Live-Ansicht — alles aus einer einzigen Datei heraus.

---

## Inhaltsverzeichnis

1. [Skript-Format](#skript-format)
2. [Inline-Editor](#inline-editor)
3. [Cue-System (Trigger)](#cue-system-trigger)
4. [Audiowiedergabe](#audiowiedergabe)
5. [S/L/F – Start / Loop / Finish](#slf--start--loop--finish)
6. [Auto-Cue](#auto-cue)
7. [Bezug (Cross-Fade / Lautstärke-Anpassung)](#bezug-cross-fade--lautstärke-anpassung)
8. [MIDI](#midi)
9. [Timecode (MTC)](#timecode-mtc)
10. [Live-Ansicht](#live-ansicht)
11. [Notfall-Steuerung](#notfall-steuerung)
12. [Cue-Navigation](#cue-navigation)
13. [Rolleneditor](#rolleneditor)
14. [Einstellungen](#einstellungen)
15. [Export (PDF / DOCX)](#export-pdf--docx)
16. [Szenen-Sidebar & Suche](#szenen-sidebar--suche)
17. [Skript-Formatierung](#skript-formatierung)
18. [Tastenkürzel](#tastenkürzel)

---

## Skript-Format

Das Skript ist eine einfache `.md`-Datei. Die App öffnet beim Start die zuletzt verwendete Datei oder fragt nach einer Datei. Mit **Datei → Neue Datei…** (`Cmd/Ctrl+N`) wird eine Vorlage angelegt.

### Markdown-Elemente

| Syntax | Bedeutung |
|---|---|
| `# Titel`, `## Szene`, `### Unterszene` | Gliederungsüberschriften, erscheinen in der Sidebar |
| `*Regieanweisung*` | Kursive Bühnenanweisung (grau dargestellt) |
| `**Rollenname**` | Name einer Rolle (farbig gem. Rolleneditor) |
| `**Rollenname**\nText` | Rolle mit Dialog (wird direkt darunter angezeigt) |
| ` ```yaml … ``` ` | Cue-Block (Trigger) |

Der erste YAML-Block ist immer der **Konfigurations-Block** (`config:`). Alle weiteren YAML-Blöcke sind Cues.

### Konfigurations-Block (Beispiel)

```yaml
config:
    roles:
        Anna:
            color: blue
            ch: 3
        Ben:
            color: green
            ch: 5
    emLightNote: {ch: 1, note: 64}
    settings:
        MacBookPro:
            mainAudioDevice: "Blackmagic Audio"
            monitorAudioDevice: "Built-in Output"
            monitorOffsetMs: 0
            midiX32Device: "X32"
            midiTriggerDevice: "IAC Driver"
            midiTCDevice: "IAC Driver"
            midiGoNote: {ch: 1, note: 36}
            midiBackNote: {ch: 1, note: 37}
            editorApp: vscode
```

---

## Inline-Editor

Das Skript kann direkt in der App bearbeitet werden — kein externer Editor nötig.

- **Shift+Klick** auf einen Textblock öffnet ihn zum Bearbeiten
- **Enter** schließt den Block und öffnet darunter einen neuen Block
- **Tab** akzeptiert den vorgeschlagenen Rollennamen (Autocomplete)
- **Shift+Enter** fügt in einem Rollenblock einen Zeilenumbruch ein
- **Pfeil oben / unten** wechselt zum vorherigen / nächsten Block
- **Escape** schließt den Editor ohne Änderung
- Schaltflächen **▲ / ▼** verschieben den Block nach oben/unten
- Schaltfläche **✕** löscht den Block

Auf Wunsch öffnet ein Rechtsklick auf einen Block die betreffende Zeile im konfigurierten Editor (VS Code, Zed oder benutzerdefiniert).

---

## Cue-System (Trigger)

Jeder YAML-Block (außer dem Konfig-Block) ist ein **Cue** (Trigger). Er wird als nummeriertes Bedienfeld im Skript angezeigt.

### Cue-Felder

| Feld | Beschreibung |
|---|---|
| `trigger_note: {ch: 1, note: 42}` | MIDI-Note, die beim Auslösen gesendet wird. Wird automatisch vergeben, wenn nicht gesetzt. |
| `mic: "Anna"` | Rollenname(n), deren Mikrofon-Kanal am X32 aufgemacht wird. Alle anderen werden gemutet. `muteall` mutet alle. |
| `music: datei.wav` | Audiodatei aus dem `audio/`-Unterordner. Kurzform oder Objekt (s. u.). |
| `light: "Szene A"` | Freitext für Lichttechniker (nur Dokumentation). |
| `note: "Hinweis"` | Interner Hinweis, der auf dem Trigger angezeigt wird. |
| `start_tc: "01:00:00:00"` | Startzeitcode (HH:MM:SS:FF, 25 fps), der beim Auslösen als MTC gesendet wird. |
| `sibling: true` | Markiert den Cue als **Variante** des vorherigen Cues (alternative Audio/Mic-Belegung). |

### Audio-Objekt (erweitertes Format)

```yaml
music:
    file: loop.wav
    volume: 0.75
    start: 2.5
    end: 120.0
    fadein: 1.0
    fadeout: 2.0
    loop: true
    monitor: loop-monitor.wav
```

### Cue bearbeiten

Jeder Trigger hat eine **✎ Bearbeiten**-Schaltfläche, die einen Dialog öffnet. Neue Cues werden über den **+**-Button zwischen zwei Blöcken hinzugefügt.

### Varianten

**⊕ Variante** dupliziert einen Cue als `sibling`. Varianten werden als Gruppe dargestellt. Im Live-Betrieb kann vor dem Go eine Variante ausgewählt werden; wird keine ausgewählt, feuert immer die erste Variante.

---

## Audiowiedergabe

Die Audiodateien (MP3 oder WAV) liegen im `audio/`-Unterordner neben der `.md`-Datei.

### Waveform-Ansicht

Jeder Cue mit Audiodatei zeigt eine interaktive Wellenform:

- **▶ / ⏸** – Wiedergabe / Pause
- **⏹** – Stopp und zurück zum Startpunkt
- **+ / −** – Zoom (10–400 px/s)
- **⟳** – Loop-Modus ein/aus
- **Lautstärke-Regler** – Volume 0–100 %

**Shift+Ziehen** auf den Wellenform-Markierungen:

| Marker | Funktion |
|---|---|
| Unterer Startmarker | Wiedergabe-Startpunkt verschieben |
| Unterer Endmarker | Wiedergabe-Endpunkt verschieben |
| Oberer Startmarker | Fade-in-Ende verschieben |
| Oberer Endmarker | Fade-out-Beginn verschieben |

Alle Änderungen (Volume, Start/Ende, Fades, Loop) werden automatisch in der YAML-Datei gespeichert.

### Dual-Output (Haupt + Monitor)

In den Einstellungen können zwei verschiedene Audioausgabegeräte konfiguriert werden:

- **Haupt-Audio** – geht an die Beschallungsanlage
- **Monitor-Audio** – geht an den Regiemonitor (z. B. Kopfhörer)

Ist kein separates Monitor-Gerät eingestellt, wird kein Monitor-Signal erzeugt. Über `monitor: datei.wav` kann pro Cue eine eigene Monitor-Mixdatei (z. B. mit Klickspur) angegeben werden. Ein konfigurierbarer **Monitor-Offset** (ms) verschiebt den Monitor zeitlich gegenüber dem Hauptsignal.

### Warnhinweis: WAV für nahtlose Übergänge

MP3- und AAC-Dateien enthalten Encoder-Padding (stille Frames am Anfang/Ende), das nahtlose Übergänge verhindert. Für alle S/L/F-Strukturen und Loop-Übergänge **WAV-Dateien verwenden**.

---

## S/L/F – Start / Loop / Finish

Nahtlose Übergänge zwischen Audioclips ohne Stille oder Klick, realisiert über `AudioBufferSourceNode` (samplegenau).

### Übergang am Ende (`chain_end`)

```yaml
# Start-Cue
music: intro.wav
chain_end: {ch: 1, note: 5}   # Note des Folge-Cues

---

# Folge-Cue (wird automatisch gestartet)
trigger_note: {ch: 1, note: 5}
music: loop.wav
loop: true
```

Der Start-Cue spielt durch und startet am Ende automatisch und nahtlos den Folge-Cue.

### Managed Loop mit Outro (`loop_outro`)

```yaml
# Loop-Cue
music: loop.wav
loop_outro: {ch: 1, note: 6}   # Note des Outro-Cues

---

# Outro-Cue
trigger_note: {ch: 1, note: 6}
music: outro.wav
```

Der Loop-Cue loopt endlos. Beim Klick auf den Outro-Cue wird dieser **gequeut** — er startet dann exakt am nächsten Schleifen-Ende nahtlos. Ein zweiter Klick cancelt die Warteschlange.

### S/L/F-Button

Die Schaltfläche **S/L/F** am Trigger öffnet ein Menü zum Einrichten von `chain_end` oder `loop_outro`. Shift+Klick entfernt eine bestehende Verbindung. Der Button zeigt den Typ (`Start`, `Loop`, `Finish`, `Bridge`) an.

---

## Auto-Cue

Ein Cue kann automatisch ausgelöst werden, wenn eine Audiowiedergabe eine bestimmte Position erreicht.

**Einrichten:**
1. Audio des Quell-Cues auf die gewünschte Position scrubben und pausieren
2. Am Ziel-Cue **⏱ Auto-Cue** klicken
3. Den Quell-Cue anklicken (Pick-Mode)

Der Auto-Cue-Marker erscheint auf der Wellenform des Quell-Cues. Mit **Shift+Ziehen** kann der Marker repositioniert werden. **Shift+Klick** auf den Auto-Cue-Button löscht den Auto-Cue.

### YAML-Repräsentation

```yaml
auto_trigger:
    trigger_note: {ch: 1, note: 3}
    at: 45.2
```

---

## Bezug (Cross-Fade / Lautstärke-Anpassung)

Ein Cue kann beim Auslösen einen anderen Cue beeinflussen (z. B. Musik ausfaden, wenn Dialog beginnt).

**Einrichten:** Schaltfläche **⇢ Bezug** am Trigger → Ziel-Trigger anklicken → Aktion wählen:

- **Fadeout (stoppen):** Faded das Ziel-Audio aus und stoppt es
- **Lautstärke auf X:** Faded das Ziel-Audio auf einen Wert (bleibt spielend)
- **Fadezeit:** Dauer des Fades in Sekunden

### YAML-Repräsentation

```yaml
music:
    file: dialog.wav
    adjust:
        trigger_note: {ch: 1, note: 3}
        fadeout: true
        fadetime: 2.0
```

---

## MIDI

Drei konfigurierbare MIDI-Ausgabegeräte:

| Gerät | Funktion |
|---|---|
| **X32** | Mikrofon-Muting: sendet CC auf Kanal 2 für jeden Rollenkanal (0 = aktiv, 127 = gemutet) |
| **Trigger** | Sendet Note On / Off beim Auslösen eines Cues (gem. `trigger_note`) |
| **TC** | MIDI Timecode Output (MTC, 25 fps) |

### MIDI-Eingang

Zwei konfigurierbare MIDI-Noten für **Go** und **Back** — empfangen auf allen MIDI-Eingängen.

---

## Timecode (MTC)

Die App erzeugt MIDI Timecode (25 fps) synchron zur Audiowiedergabe.

- Beim Auslösen eines Cues mit `start_tc` beginnt der MTC ab diesem Offset
- Bei S/L/F-Ketten wird der TC lückenlos weitergezählt
- Scrubben auf der Wellenform aktualisiert den TC per Full-Frame-Message
- Das aktuelle TC wird in der Kopfzeile der App angezeigt
- Abgeleitete Timecodes für Folge-Cues in einer S/L/F-Kette werden automatisch berechnet und angezeigt

---

## Live-Ansicht

Ein separates Fenster (`Cmd/Ctrl+L`) für den Bühnen- oder Regie-Monitor.

**Inhalt:**
- Aktueller Cue (groß hervorgehoben) mit allen Cue-Details
- Nächster Cue mit Vorschau
- **Go / Back** Schaltflächen
- Timecode-Anzeige
- Fortschrittsanzeige für laufende Audios und Auto-Cues
- Varianten-Auswahl: Der nächste Cue kann vor dem Go auf eine Variante umgestellt werden
- Stop-Schaltfläche pro Cue zum sofortigen Stoppen

Die Live-Ansicht kommuniziert bidirektional mit dem Hauptfenster. Go/Back im Live-Fenster wirken genauso wie im Hauptfenster.

---

## Notfall-Steuerung

Drei Notfall-Schaltflächen in der Kopfzeile:

| Schaltfläche | Funktion |
|---|---|
| **Notfall-Licht** | Sendet die in `emLightNote` konfigurierte MIDI-Note (z. B. Notbeleuchtung) |
| **Musik stopp** | Faded alle laufenden Audios in 500 ms aus und stoppt sie; stoppt MTC |
| **Mics aus** | Mutet alle konfigurierten Mikrofon-Kanäle am X32 |

---

## Cue-Navigation

### Hauptfenster

| Aktion | Ergebnis |
|---|---|
| Klick auf Trigger | Cue sofort auslösen |
| Klick bei offener Live-Ansicht | Cue als nächsten Cue vorauswählen (Arm) |
| **Go** (Space, wenn Live-Ansicht offen) | Nächsten Cue auslösen |
| **Back** (Backspace, wenn Live-Ansicht offen) | Letzten Cue rückgängig (Fade-out + Undo) |
| MIDI Go/Back | Konfigurierbare MIDI-Noten |
| Aktuellen Cue anzeigen | Scrollt zur aktuellen Position |

Zweifacher Klick auf einen spielenden Cue **stoppt** ihn sofort (Undo-Funktion).

### Cue-Verlauf (Back)

Back faded das zuletzt ausgelöste Audio in 500 ms aus, restoriert den vorherigen Cue-Status und macht Mic-Änderungen rückgängig.

---

## Rolleneditor

Menü **Rolleneditor…** öffnet ein eigenes Fenster zum Verwalten der Rollen.

- **Name** der Rolle
- **Farbe** (red, green, blue, purple, cyan, yellow, darkred, …) — bestimmt die Textfarbe im Skript und im Export
- **MIDI-Kanal** (ch) — der Mikrofon-Kanal am X32

Rollen können umbenannt werden; alle `**Rollenname**`-Vorkommen im Skript werden automatisch angepasst.

---

## Einstellungen

Menü **Einstellungen…** (`Cmd/Ctrl+,`) öffnet:

| Einstellung | Beschreibung |
|---|---|
| Haupt-Audiogerät | Ausgabe für Hauptsignal |
| Monitor-Audiogerät | Ausgabe für Monitor |
| Monitor-Offset (ms) | Zeitversatz Monitor gegenüber Hauptsignal |
| X32-MIDI-Gerät | MIDI-Ausgang für Mikrofon-Steuerung |
| Trigger-MIDI-Gerät | MIDI-Ausgang für Cue-Noten |
| TC-MIDI-Gerät | MIDI-Ausgang für MTC |
| Go-Note / Back-Note | MIDI-Noten für Go und Back (Pick-Mode) |
| Editor | VS Code, Zed oder benutzerdefinierter Befehl |

Einstellungen werden **pro Hostname** im Config-Block der Skript-Datei gespeichert, sodass dieselbe Datei auf mehreren Rechnern unterschiedliche Geräte verwenden kann.

---

## Export (PDF / DOCX)

`Cmd/Ctrl+E` öffnet den Export-Dialog:

- **Cues einschließen:** Ob Trigger-Blöcke (Mic, Musik, Licht usw.) im Export erscheinen
- **Rollenfarben:** Ob Rollennamen farbig dargestellt werden

**Ausgabeformate:**

- **PDF** – druckoptimiertes A4-Dokument mit Deckblatt, Inhaltsverzeichnis und Seitenzahlen
- **DOCX** – Word-Dokument mit identischer Struktur (Times New Roman, korrekte Hierarchie)

Jede S/L/F-Gruppe erhält eine Kennzeichnung (`Start`, `Loop`, `Finish`, `Bridge`).

---

## Szenen-Sidebar & Suche

### Szenen-Sidebar

- **`Cmd/Ctrl+B`** oder Sidebar-Schaltfläche öffnet/schließt die Sidebar
- Listet alle `#`-, `##`- und `###`-Überschriften
- Klick scrollt zur Szene; die aktive Szene wird beim Scrollen hervorgehoben

### Volltextsuche

- **`Cmd/Ctrl+F`** öffnet die Suchleiste
- Alle Treffer werden markiert; **Enter** / **Shift+Enter** navigiert vorwärts/rückwärts
- **Escape** schließt die Suche

---

## Skript-Formatierung

Beim Öffnen prüft die App, ob das Skript dem Formatierungsstandard entspricht:

- Leerzeile nach jeder Überschrift
- Leerzeile vor/nach jeder Bühnenanweisung
- Leerzeile vor jedem Rollennamen
- Lange Dialogzeilen werden an Satzgrenzen umgebrochen
- Mehrfache Leerzeilen werden zu einer zusammengefasst

Ist eine Formatierung nötig, wird eine Sicherungskopie (`*~unformatted.md`) angelegt und dann formatiert.

---

## Tastenkürzel

| Kürzel | Funktion |
|---|---|
| `Cmd/Ctrl+N` | Neue Datei |
| `Cmd/Ctrl+O` | Datei öffnen |
| `Cmd/Ctrl+,` | Einstellungen |
| `Cmd/Ctrl+L` | Live-Ansicht öffnen |
| `Cmd/Ctrl+E` | Exportieren |
| `Cmd/Ctrl+B` | Sidebar ein/aus |
| `Cmd/Ctrl+F` | Suche |
| `Space` | Go (wenn Live-Ansicht offen, kein Editor aktiv) |
| `Backspace` | Back (wenn Live-Ansicht offen, kein Editor aktiv) |
| `Shift+Klick` | Block bearbeiten |
| `Tab` | Rollennamen-Autocomplete akzeptieren |
| `Shift+Enter` | Zeilenumbruch im Rollenblock |
| `Escape` | Editor / Suche / Sidebar schließen |

---

## Entwicklung & Build

```bash
# Abhängigkeiten installieren
npm install

# Webpack im Watch-Modus starten
npm run develop

# Electron starten
npm start

# Produktions-Build (macOS .dmg / Windows .exe)
npm run build
```

Audiodateien liegen im `audio/`-Unterordner neben der `.md`-Datei. Für nahtlose S/L/F-Übergänge WAV-Format verwenden.
