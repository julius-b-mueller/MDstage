# Changelog

Was sich von Version zu Version ändert: neue Funktionen, Änderungen am Verhalten und
alles, was die Show-Datei betrifft (YAML-Schlüssel, die neu sind, sich ändern oder
wegfallen).

**Abwärtskompatibilität:** Show-Dateien, die mit einer älteren Version ab 2.0.0 erstellt
wurden, lassen sich mit jeder neueren Version ohne Fehler öffnen und spielen. Fällt ein
Schlüssel weg oder ändert er sich, steht hier, wie ältere Dateien behandelt werden. Seit
2.0.0 sind nur Schlüssel dazugekommen; keiner ist weggefallen. Ein Test öffnet bei jedem
Build eine Datei mit allen Schlüsseln von 2.0.0.

Nichts über den Stand einer Vorstellung steht in der Show-Datei: Welcher Cue der nächste
ist und wann ein Cue ausgelöst wurde, liegt nur im Programm bzw. in den Einstellungen
des Rechners. Die Show-Datei wird nur geschrieben, wenn das Skript bearbeitet wird.

## Unveröffentlicht

### Neu

- **Skript ändern, während die Show läuft.** Cues hinzufügen, löschen, verschieben oder
  bearbeiten stoppt nichts mehr: Laufendes Audio, der Verlauf (ausgelöste Cues) und der
  vorgemerkte nächste Cue bleiben erhalten. Die Liveansicht zeigt jede Änderung sofort.
- **Änderungen wirken sofort auf laufendes Audio.** Loop ein- oder ausschalten, Start,
  Ende, Fades, Crossfade oder Lautstärke ändern gilt für das Audio, das gerade spielt.
- **Suche überarbeitet.** Groß-/Kleinschreibung und Satzzeichen spielen keine Rolle,
  Wörter dürfen fehlen oder anders stehen, und ein Wort wird am Wortanfang erkannt
  („Du sollst nach Hause gehen" findet „Geh nach Hause"). Der beste Treffer kommt zuerst;
  gleich gute Treffer folgen ab dem zuletzt ausgelösten Cue und springen erst am Ende
  des Skripts an den Anfang. Strg/Cmd+F leert das Suchfeld, auch wenn es schon offen ist.
- **Arm-Knopf an jedem Cue** der Hauptansicht: merkt den Cue als nächsten vor, ohne ihn
  auszulösen.
- **Verschiebe-Knöpfe (▲ ▼) an jedem Cue.**
- **Löschen-Knopf** an der Textzeile, die gerade bearbeitet wird, und im Cue-Dialog.
- **Knopf „Zum zuletzt ausgelösten Cue springen"** neben dem Fadenkreuz. Das Fadenkreuz
  springt zum nächsten Cue.
- **Pfeiltasten ↑/↓** blättern in der Hauptansicht von der aktuellen Scrollposition zum
  vorherigen oder nächsten Cue. In der Liveansicht gibt es dafür zwei Knöpfe (▲ ▼) neben
  Back; sie merken den angesprungenen Cue zugleich als nächsten vor.
- **Position bleibt erhalten:** Der nächste Cue wird je Show-Datei gemerkt und nach einem
  Neustart wieder vorgemerkt.
- **Auslösezeit am Cue:** Statt „erledigt" steht „ausgelöst – hh:mm:ss".
- **Back am MIDI-Controller gedrückt halten** (1 Sekunde) stoppt alle Wiedergaben, wie
  der rote Noten-Knopf – ohne dabei ein Back auszulösen.
- **Nur Szenen und Cues zeigen:** Ein Knopf in der Werkzeugleiste blendet im Hauptfenster
  allen Text aus; es bleiben Überschriften und Cues.
- **Miniplayer im Hauptfenster:** Wie in der Liveansicht steht unten für jedes laufende
  Audio eine Zeile mit Fortschritt und einem Knopf, der genau dieses Audio stoppt.

### Geändert

- **Back per MIDI löst beim Loslassen der Taste aus**, nicht mehr beim Drücken (damit
  Halten etwas anderes bedeuten kann). Ein Controller muss dafür beim Loslassen ein
  Note-Off senden (oder ein Note-On mit Velocity 0).
- **Szenennummern:** Hat in einem Skript mindestens eine Szene eine eigene Nummer in der
  Überschrift, bekommen Szenen ohne Nummer keine mehr. Skripte ganz ohne eigene Nummern
  werden wie bisher durchgezählt.
- **MIDI-Geräte** werden laufend neu gesucht. Ein Gerät, das nach dem Programmstart
  angesteckt wird, erscheint in den Einstellungen und wird für Go/Back, „Alle" und
  „Learn" gehört.

### Show-Datei (YAML)

- Keine Änderungen.

## 2.2.0

### Neu

- **Nahtloser Loop mit Crossfade** für Hintergrundgeräusche: Das Ende blendet aus,
  während der Anfang schon wieder einblendet. Beim Einschalten des Loops wird die Art
  gewählt. Kein Timecode an einem solchen Loop.
- Die Knöpfe der Cue-Karte sind immer sichtbar; der Loop-Knopf sitzt in dieser Zeile und
  lässt sich nur mit Shift+Klick ausschalten.
- Fades sind auf der Wellenform grün hinterlegt und mit ihrer Länge beschriftet.

### Show-Datei (YAML)

- **Neu:** `music.crossfade` (Sekunden) – nur zusammen mit `music.loop: true` und ohne
  `music_seq`. Ersetzt an diesem Cue `fadein`, `fadeout` und `fading_point`.
- **Geändert:** `start_tc` wird an einem Cue mit `music.crossfade` ignoriert und als
  Problem gemeldet.

## 2.1.0 und 2.1.1

Nachgetragen, soweit es die Show-Datei betrifft (2.1.1 brachte nur das Paket für macOS
Intel).

### Show-Datei (YAML)

- **Neu:** `music.markers` – Liste benannter Stellen im Audio, je `{at: Sekunden, name: Text}`.
- **Neu:** `auto_trigger.group: true` – ein Auto-Cue mit `delay` hängt an der ganzen
  Variantengruppe statt an einer Variante.
- **Neu:** `group_volume` am ersten Cue einer Variantengruppe – Lautstärke der Gruppe.
- **Neu im Text:** `<br>` für einen Zeilenumbruch in einem Textblock. Einfache
  Zeilenumbrüche in der Datei fließen zusammen, wie in Markdown üblich.

### Verhalten bei Dateien aus 2.0.0

- Varianten (`sibling: true`) sind eigenständige Cues: Der Operator muss vor Go eine
  wählen, und eine Variante wird nie von selbst ausgelöst.
- Auto-Cues einer Quelle sollen in der Reihenfolge stehen, in der sie auslösen. Ältere
  Dateien, die das nicht tun, spielen weiter; die betroffenen Cues tragen den Hinweis
  „⚠ Reihenfolge".
- Cues heißen nach ihrer Trigger-Note („Cue 1.47") statt nach ihrer laufenden Nummer.
