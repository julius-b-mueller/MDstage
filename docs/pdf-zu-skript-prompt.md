# Prompt: Theaterstück-PDF in eine MDstage-Datei umschreiben

So wird er benutzt:

1. Die PDF des Stücks in ein Gespräch mit Claude hochladen.
2. Alles unterhalb der Linie in dasselbe Gespräch kopieren und abschicken.
3. Das Ergebnis als `skript.md` speichern und in MDstage öffnen. Cues, Mikrofonkanäle und Audio
   kommen danach in der App dazu. Weil die Datei keine Versionsangabe trägt, zeigt MDstage beim
   Öffnen einmal den Hinweis „Andere Version“ und fragt vor dem ersten Speichern nach; beides
   kann bestätigt werden.

Bei langen Stücken liefert Claude die Datei in mehreren Teilen. Dann mit „weiter“ antworten und
die Teile in der Reihenfolge untereinander in dieselbe Datei kopieren.

---

Im Anhang ist die PDF eines Theaterstücks. Schreibe sie bitte in eine Skriptdatei für MDstage um.

MDstage ist ein Programm für die Inspizienz: Es zeigt das Stück als Text an und löst an
markierten Stellen Ton, Licht und Mikrofone aus. Die Datei, die du schreibst, ist die
Arbeitsgrundlage einer Aufführung. Die Inspizientin liest darin während der Vorstellung live mit.
Deshalb zählt vor allem, dass der Text vollständig und wortgetreu ist und dass das Programm jeden
Absatz richtig einordnet. Eine fehlende Replik oder ein falsch zugeordneter Sprecher fällt erst in
der Probe auf.

## Was in die Datei gehört

Die Datei ist Markdown mit genau vier Arten von Absätzen. Zwischen zwei Absätzen steht immer
genau eine Leerzeile.

**Überschriften** gliedern das Stück und erscheinen im Szenenmenü:

```markdown
# Erster Akt

## Szene 1

### Im Garten
```

Die erste Zeile der Datei ist der Titel des Stücks als `#`-Überschrift. Akte, Teile oder Bilder
bekommen `#`, Szenen `##`, Unterteilungen innerhalb einer Szene `###`. Hat das Stück nur eine
Ebene, bekommen die Szenen `#`. Übernimm die Benennung der Vorlage („2. Aufzug“, „Bild 3“).

**Regieanweisungen** stehen als eigener Absatz zwischen zwei einzelnen Sternen:

```markdown
*Anna tritt von links auf. Es ist dunkel.*
```

Innerhalb einer Regieanweisung darf kein weiterer Stern vorkommen, sonst erkennt MDstage sie
nicht. Eine Regieanweisung über mehrere Sätze bleibt ein Absatz.

**Rollentext** beginnt mit dem Rollennamen zwischen doppelten Sternen in einer eigenen Zeile.
Darunter folgt ohne Leerzeile der gesprochene Text, ein Satz pro Zeile:

```markdown
**Anna**
Ich habe dich überall gesucht.
Wo warst du denn?
```

Sprechen mehrere Rollen denselben Text gleichzeitig, stehen ihre Namen mit Schrägstrich in einer
Zeile: `**Anna/Ben**`. Für alle Rollen zusammen gibt es den festen Namen `**Alle**`.

Eine kurze Anweisung mitten im Rollentext („leise“, „zu Ben“) bleibt an ihrer Stelle im Text und
steht in Klammern zwischen einzelnen Sternen:

```markdown
**Ben**
Das wusste ich nicht. *(setzt sich)* Erzähl.
```

Eine Anweisung, die zwischen zwei Repliken steht oder eine Handlung beschreibt, die nicht zu einem
einzelnen Satz gehört, wird dagegen ein eigener Regieanweisungs-Absatz.

Gesang und Verse, bei denen der Zeilenfall wichtig ist, behalten ihre Zeilen. Jede Zeile außer der
letzten endet dann mit ` <br>`:

```markdown
**Anna**
Der Mond ist aufgegangen, <br>
die goldnen Sternlein prangen <br>
am Himmel hell und klar.
```

**Der Config-Block** steht direkt unter dem Titel und nennt alle Rollen. Er ist der einzige
YAML-Block der Datei:

````markdown
```yaml
config:
    roles:
        Anna:
            color: blue
        Ben:
            color: green
    groups:
        Chor:
            color: purple
            roles: [Anna, Ben]
```
````

Trage jede Rolle ein, die im Stück spricht, in der Reihenfolge ihres ersten Auftritts. Gib den
wichtigsten Rollen gut unterscheidbare Farben. Erlaubt sind `red`, `green`, `yellow`, `blue`,
`purple`, `cyan` und dieselben mit `dark` davor (`darkred`, `darkgreen`, …). Bei mehr Rollen als
Farben wiederholen sich die Farben; achte dann darauf, dass Rollen, die oft miteinander sprechen,
verschiedene haben. `groups` brauchst du nur, wenn eine feste Gruppe unter eigenem Namen spricht
(„Chor“, „Die Schwestern“); sonst lass den Abschnitt weg. Eingerückt wird mit vier Leerzeichen.

## Rollennamen

MDstage erkennt eine Rolle nur, wenn ihr Name im Text Buchstabe für Buchstabe so geschrieben ist
wie im Config-Block. Lege deshalb für jede Rolle einen Namen fest und verwende ihn durchgehend,
auch wenn die Vorlage wechselt („FRAU MÜLLER“, „Müller“, „Die Wirtin“ für dieselbe Figur). Nimm
die Form, die in der Vorlage überwiegt, in normaler Groß- und Kleinschreibung: `Frau Müller`,
nicht `FRAU MÜLLER`. Ein Name darf weder `/` noch `*` enthalten.

Nummerierte Nebenrollen bleiben getrennte Rollen (`Wache 1`, `Wache 2`). Wechselt eine Figur im
Lauf des Stücks den Namen (eine Unbekannte wird als „Clara“ erkannt), behalte den ersten Namen
bei und erwähne den Wechsel in deiner Rückmeldung.

## Was mit der Vorlage geschieht

Übernimm den Text wörtlich: Wortlaut, Rechtschreibung und Zeichensetzung der Vorlage bleiben, auch
wenn sie veraltet oder ungewöhnlich sind. Nichts wird gekürzt, zusammengefasst, geglättet oder
ergänzt. Wo der Text in der PDF unleserlich oder beschädigt ist, schreibe an die Stelle `[?]` und
nenne sie in der Rückmeldung, statt zu raten.

Was nur vom Buchsatz kommt, gehört nicht in die Datei:

- Seitenzahlen, Kopf- und Fußzeilen, Zeilenzähler am Rand
- Trennstriche am Zeilenende: getrennte Wörter werden wieder zusammengesetzt
- Zeilenumbrüche innerhalb eines Satzes
- Titelei, Verlags- und Rechtehinweise, Vor- und Nachwort, Besetzungslisten früherer
  Aufführungen

Das Personenverzeichnis wird nicht als Text übernommen; aus ihm entsteht der Config-Block.
Orts- und Zeitangaben am Beginn eines Akts oder einer Szene („Ein Wirtshaus. Abend.“) werden
Regieanweisungen direkt unter der Überschrift.

Schreibe keine Cues, also keine weiteren YAML-Blöcke. Wo Ton, Licht und Mikrofone einsetzen,
entscheidet das Produktionsteam später in MDstage. Auch wenn die Vorlage Musik oder Geräusche
erwähnt, bleibt das eine Regieanweisung.

## Ein kurzes Beispiel

So sieht der Anfang einer fertigen Datei aus:

````markdown
# Der Besuch

```yaml
config:
    roles:
        Anna:
            color: blue
        Ben:
            color: green
        Frau Müller:
            color: yellow
```

# Erster Akt

## Szene 1

*Eine Küche am frühen Morgen. Ben sitzt am Tisch und liest.*

**Anna**
Du bist schon wach?

**Ben**
Seit vier. *(legt die Zeitung weg)* Ich konnte nicht schlafen.
Hast du es gehört?

*Es klopft. Beide sehen zur Tür.*

**Anna/Ben**
Herein!

**Frau Müller**
Entschuldigen Sie die Störung.
````

## Umfang und Abgabe

Gib das ganze Stück aus, vom Titel bis zum letzten Satz. Wenn du Dateien anlegen kannst, lege
`skript.md` als Datei an. Sonst gib den Inhalt in einem einzigen Codeblock aus, ohne Text
dazwischen.

Passt das Stück nicht in eine Antwort, höre am Ende einer Szene auf und schreibe darunter, bei
welcher Szene es weitergeht. Auf „weiter“ setzt du genau dort fort, ohne etwas zu wiederholen und
ohne den Config-Block noch einmal auszugeben. Kürze nicht, um mit einer Antwort auszukommen.

Schreibe nach dem letzten Teil eine kurze Rückmeldung außerhalb der Datei:

- welche Rollennamen du vereinheitlicht hast und aus welchen Schreibweisen
- Stellen, an denen die Zuordnung zu einer Rolle oder die Einordnung als Regieanweisung unsicher
  war, mit Akt und Szene
- unleserliche Stellen (`[?]`)
- was du aus der Vorlage weggelassen hast (Vorwort, Besetzungsliste …)
