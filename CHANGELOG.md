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

- HTTP-Ausgaben über `https://` nutzen eine TLS-Bibliothek (rustls 0.23.46) ohne die im
  Oktober 2026 gemeldeten Lücken; die mitgelieferten Stammzertifikate sind aktualisiert.
- Jeder Build prüft die Abhängigkeiten auf bekannte Sicherheitslücken und baut nur mit den
  in `Cargo.lock` festgeschriebenen Versionen.
- „Über MDstage" zeigt die Lizenzen der eingebauten Bibliotheken und Schriften; jedes
  Paket enthält sie als `THIRD-PARTY-LICENSES.txt`, dazu MDstages eigene `LICENSE`.

### Show-Datei (YAML)

- Keine Änderungen.

## 2.5.0

- Tracking beim Springen (wie am Lichtpult): Wird ein Cue außer der Reihe ausgelöst,
  stellt MDstage her, was der Weg durchs Skript bis dorthin hinterlassen hätte – Loops
  starten oder enden, einmaliges Audio von weiter unten endet, Weiterlaufendes bekommt
  die Lautstärke, die die Cues darüber ihm lassen, Geräte mit Tracking bekommen ihren
  Stand (ein Display, das kein Cue darüber angesprochen hat, wird leer), Mikrofone
  (immer) ihre Lage. Ein Finish als Ziel kommt nach einem
  Durchgang seines Loops. Vor dem Go zeigt die Karte, was Tracking tun wird; bei Varianten
  ohne bisherige Wahl fragt MDstage. Back nimmt Sprung und Tracking zusammen zurück.
  Tracking ist je Show und je Gerät abschaltbar.
- Back sendet Geräten mit abgeschaltetem Tracking nichts mehr erneut.
- Remote-Liveansicht: die Liveansicht im Browser eines anderen Geräts im lokalen Netz,
  mit Go, Back, ▲ ▼ und Variantenwahl. Standardmäßig aus; Schnittstelle, Port und PIN in
  den Einstellungen, die Knöpfe im Menü „Geräte“ abschaltbar (sie werden dann grau). Nur
  in vertrauenswürdigen Netzen: unverschlüsselt.
- Sicherheit: Display-Server und Remote-Liveansicht senden jedem Browser über eine eigene
  Warteschlange. Ein Gerät im Netz, das eine Verbindung öffnet und nicht liest, konnte
  bisher den Show-Ablauf (Go, Back, Timecode) anhalten – beim Display-Server auch ohne
  jeden Zugang. Die Remote-Seite lässt sich nicht in fremde Seiten einbetten; falsche PINs
  sind auch über alle Adressen zusammen begrenzt.
- Liveansicht: Der nächste Cue hat einen weißen Rahmen statt eines Leuchtens.
- Liveansicht: Die Kurzbeschreibung eines Cues zeigt kein `<br>` aus der Datei mehr.

### Show-Datei (YAML)

- Neu: `config.tracking: false` – Tracking für die Show aus (fehlt: an; Mikrofone folgen
  immer). Neu: `config.outputDevices[].tracking: false` – Tracking für dieses Gerät aus
  (fehlt: an). Ältere Versionen tracken nicht; `config.tracking` zeigen sie als unbekannte
  Eigenschaft an (mit Knopf zum Löschen), lassen sie aber stehen, solange man ihn nicht drückt.

## 2.4.0

- Back: alles wie vor dem Go. Was vor dem Go gearmt war (z. B. ein Sprungziel), ist wieder
  gearmt; ein zweites Back hebt das auf. Eine gewählte Variante wird wie ein Arm zuerst
  zurückgenommen. Ein zweiter Druck, der Audio gestoppt hat, wird zurückgenommen (das Audio
  läuft dort weiter, wo es jetzt wäre). Audio, das der Cue ausgeblendet oder per Timecode
  übernommen hat, kommt zurück – Loops im Takt, anderes an der Stelle, an der es jetzt
  wäre. Mikrofone, die nur der zurückgenommene Cue geöffnet hat, gehen aus. Die Anzeige
  „ausgelöst – hh:mm:ss" zeigt nach Back wieder die frühere Zeit.
- Auto-Cues: neu „Mit dem Cue" und „Nach dem Ende seines Audios" (Pfeil vom unteren Ende
  des Cue-Rands). Beim Anlegen werden immer alle Möglichkeiten angeboten, dazu „Bei der
  Abspielposition", wenn die Wiedergabe nicht am Anfang oder Ende steht.
- Bezüge (Ausblenden, Auto-Cue, S/L/F) zeigen den Anfang des Dateinamens: „Cue 1.3 (Regen…)".
- Nur-Cues-Ansicht: Beim Umschalten bleibt die Ansicht an derselben Stelle.
- Ein Cue, der während der Show eingefügt wird, lässt die Ansicht nicht mehr wegspringen.
- Mit offener Liveansicht ist die Hauptansicht gesperrt (von Hand entsperrbar); beim
  Schließen gilt wieder der vorige Zustand.
- Leer gelassene Textzeilen werden entfernt.
- Timecode: Jede Show hat eine Framerate (24, 25, 29,97 drop oder 30 fps), eingestellt
  in den Einstellungen und auf dem Rechner gespeichert, nicht in der Show-Datei (ohne
  Angabe 25 fps wie bisher). Nach ihr zählen die Frames von `start_tc`, die Anzeige und
  alle Geräte auf „wie die Show“; ein Gerät kann eine eigene Rate haben. Neu ist
  Art-Net-Timecode (Geräteart „Art-Net“, Adresse und Port 6454, einmal pro Frame).
- Fernsteuerung: Go, Back, ▲ und ▼ (Cue davor/danach vormerken) per OSC, mit eigenem
  UDP-Port und frei wählbaren Adressen; ▲ und ▼ auch per MIDI-Note.
- Sicherheit: Teilen sich OSC-Cue-Trigger und OSC-Steuerung einen Port, nimmt jede
  Funktion nur dann Nachrichten aus dem Netzwerk an, wenn sie selbst dafür freigegeben
  ist. Art-Net-Adressen werden einmal aufgelöst, nicht bei jedem Frame.
- Cues: Cmd/Strg+C auf einem Cue kopiert ihn (auch als Text), Cmd/Strg+V fügt ihn danach
  ein. Nachrichten (MIDI, OSC, HTTP, Display) lassen sich einzeln oder alle kopieren und in
  einen anderen Cue einfügen – im Cue-Dialog und per Rechtsklick.

### Show-Datei (YAML)

- Geändert: `start_tc` darf bis zu 29 Frames haben und `;` vor den Frames (drop-frame);
  wie viele Frames gültig sind, richtet sich nach der Framerate der Show. Bestehende
  Dateien gelten weiter (25 fps, wenn keine Rate eingestellt ist).
- Framerate, Timecode-Geräte und Fernsteuerung liegen in den Einstellungen des
  Rechners, nicht in der Show-Datei; Art-Net-Geräte werden nicht in die Show-Datei
  geschrieben.
- Neu: `auto_trigger.at: end` – nach dem Ende des Audios der Quelle. „Mit dem Cue" wird als
  `delay: 0` gespeichert (kein neuer Schlüssel). Ältere Versionen ignorieren `at: end`.

## 2.3.0

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
- Ein an- oder abgestecktes MIDI-Gerät unterbricht den Empfang von Cue-Triggern per OSC
  nicht.
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
