# Der Zauberer von Oz

```yaml
config:
    qlcplus:
        functionNotes:
            0: Kansas
            1: Kansas Dorothy Strophe Opera
            2: Kansas Tante Pos
            3: Kansas Tante Light
            4: Kansas Onkel Pos 1
            5: Kansas Onkel Light
            6: Kansas Dorothy Traum
            7: Kansas Feuer
            8: Kansas Dorothy Bridge Pos
            9: Kansas Dorothy Bridge Light
            10: Kansas Dorothy Regenbogen
            11: Par Hair Links
            12: Par Hair Rechs
            13: Par Links
            14: Par Rechts
            15: Par Front Links
            16: Par Front Rechts
            17: red full
            18: red half
            19: Blechmann Stein
            20: Blechmann Song Basislicht
            21: blinders
            22: blechmann flame
            23: Blechmann Song Vogelscheuche
            24: Blechmann
            25: black
            26: Kansas Feuer Aufheller
        widgetControllers:
            1: Kansas Sturm
            2: Kansas dim
            3: snowflakes
    roles:
        Erzähler:
            ch: 5
            color: red
            midi: 36
        Zauberer:
            ch: 5
            color: red
            midi: 37
        Onkel Henry:
            ch: 14
            color: darkred
            midi: 38
        Tante Em:
            ch: 12
            color: darkblue
            midi: 39
        Dorothy:
            ch: 1
            color: cyan
            midi: 40
        Munchkin 1:
            ch: 13
            color: darkgreen
            midi: 41
        Munchkin 2:
            ch: 14
            color: darkyellow
            midi: 42
        Hexe des Nordens:
            ch: 8
            color: darkpurple
            midi: 43
        Vogelscheuche:
            ch: 11
            color: yellow
            midi: 44
        Blechmann:
            ch: 3
            color: red
            midi: 45
        Löwe:
            ch: 4
            color: green
            midi: 46
        Torwächter 1:
            ch: 6
            color: darkgreen
            midi: 47
        Torwächter 2:
            ch: 7
            color: darkyellob
            midi: 48
        Hexe des Westens:
            ch: 9
            color: blue
            midi: 49
        Winkie:
            ch: 13
            color: green
            midi: 50
        König der Affen:
            ch: 8
            color: darkpurple
            midi: 51
        Hexe des Südens:
            ch: 10
            color: purple
            midi: 52
```

## Einlass

```yaml
mic: muteall
qlcplus: Erzähler Kansas
projection: black-1
music:
    file: einlass.mp3
    volume: 0.27
    start: 12.7
    end: 38.185
    fadein: 7.75
    fadeout: 9.3
    loop: true
start_tc: "01:00:00:00"
trigger_note: {ch: 1, note: 1}
```

```yaml
music:
    file: gong.mp3
    volume: 0.8
    start: 0.786
    end: 7.616
    fadein: 0.889
    fadeout: 1.235
trigger_note: {ch: 1, note: 2}
```

```yaml
music:
    file: gong.mp3
    volume: 0.8
    start: 1.546
    fadein: 1.631
trigger_note: {ch: 1, note: 3}
```

```yaml
music: gong.mp3
trigger_note: {ch: 1, note: 4}
```

```yaml
music:
    file: ansage.mp3
    volume: 0.79
    adjust:
        trigger_note: {ch: 1, note: 1}
        fadeout: true
qlcplus: ansage
trigger_note: {ch: 1, note: 5}
```

## Der Wirbelsturm

```yaml
note: AUFNAHME STARTEN!!!
trigger_note: {ch: 1, note: 6}
```

*Folgende Dinge müssen beim Einlass von Tante Em oder Onkel Henry erledigt werden:*

*Wäsche muss aufgehängt werden*

*Campingstühle müssen aufgestellt werden*

*Marshmallows müssen an der Feuerstelle bereitstehen*

*Tür darf nicht von innen verriegelt sein*

*Erzähler tritt von links auf, bleibt links stehen*

*Tante Em hängt Wäsche ab*

*Onkel Henry sitzt im Campingstuhl und schärft seine Axt*

```yaml
mic: Erzähler
music:
    file: erzaehler.mp3
    volume: 0.5
    loop: true
trigger_note: {ch: 1, note: 7}
```

**Erzähler**
Entschuldigung, bin ich zu früh? Mir wurde gesagt, die Vorstellung begänne um 15 Uhr.  Aber es scheinen noch nicht alle Zuschauer da zu sein. Ich habe mit einem größeren Publikum gerechnet. Es muss am Wetter liegen.  Da braut sich ein Sturm zusammen. Aber euch scheint das Wetter keine Angst zu machen. Ihr seid nicht von hier, kann das sein? Ihr müsst wissen, hier in Kansas ist mit Stürmen nicht zu spaßen. Wirbelstürme, und die sind hier keine Seltenheit, sind eine ernste Gefahr. Deshalb gibt es an den meisten Orten sogenannte Sturmkeller, in denen man sich in Sicherheit bringen kann, bis der Sturm vorbei ist. Wenn ich mir den Himmel so ansehe, steht uns heute noch ein heftiger Wirbelsturm bevor, darauf verwette ich meinen Zauberstab. Zauberstab, richtig! Schließlich habt ihr Euch nicht auf den weiten Weg mitten in die Prärie von Kansas gemacht, um übers Wetter zu reden. Ihr seid hier, weil ich ein großartiger Zauberer bin und ihr meine magischen Künste bestaunen wollt. Doch bevor ich beginne, muss ich euch etwas fragen: Glaubt Ihr an Zauberei?  Es ist ganz wichtig, dass Ihr daran glaubt, denn Magie funktioniert nur für diejenigen, die auch an sie glauben. Zu dem Thema kann ich Euch eine tolle Geschichte erzählen und wie der Zufall es will, beginnt diese Geschichte genau hier, in Kansas. Es geht um ein kleines Mädchen. Ihr Name ist Dorothy und sie lebt auf einer Farm bei ihrem Onkel und ihrer Tante in einem kleinen Holzhaus.

**

```yaml
mic: Vogelscheuche
note: Test
trigger_note: {ch: 1, note: 124}
```

rzähler stellt sich zum Holzhaus*

```yaml
mic:
    - Onkel Henry
    - Tante Em
qlcplus: Kansas
music:
    adjust:
        trigger_note: {ch: 1, note: 7}
        fadeout: true
trigger_note: {ch: 1, note: 8}
```

**Onkel Henry**
Das Wetter gefällt mir nicht.

**Tante Em**
Du hast auch immer irgendetwas auszusetzen.

**Onkel Henry**
Ich sage dir, da braut sich etwas zusammen.

*Erzähler geht zu Onkel Henry und Tante Em, wird von den beiden aber nicht berkt*

**Erzähler**
Seht ihr, das hier ist "Onkel Henry" und das ist seine Frau "Tante Em". Ich muss zugeben, die beiden sehen etwas mürrisch aus. Aber das dürfen wir ihnen nicht zum Vorwurf machen. Die beiden haben den ganzen Tag hart gearbeitet.

```yaml
mic:
    - Erzähler
    - Zauberer
trigger_note:
    ch: 1
    note: 9
```

*Onkel Henry steht auf, geht auf die linkes Bühnenseite und hackt dort Holz*

**Erzähler**
Das Leben als Farmer ist hart in der Prärie. In dieser grauen und staubigen Umgebung kann man das Lachen leicht verlernen.

*Dorothy tritt von der rechten Seite auf, sie trägt einen Korb mit Eiern und läuft fröhlich zu Tante Em*

**Erzähler**
Bei Dorothy jedoch ist es anders. Sie ist ein sehr glückliches Mädchen, das oft lacht. Sie hat einen Glücksbringer, er heißt Toto und ist ihr Lieblingskuscheltier.

*Tante Em und Dorothy gehen gemeinsam ins Haus*

```yaml
mic: Dorothy
trigger_note: {ch: 1, note: 127}
```

*Erzähler geht zum Lagerfeuer und nimmt sich einen Marshmallow weg*

**Erzähler**
Nach einem langen Tag sitzt Dorothy gerne mit ihrer Tante und ihrem Onkel an einem Lagerfeuer zusammen.

**

```yaml
note: foo
trigger_note: {ch: 1, note: 125}
```

rzähler geht nach links ab*

*Wenn der Erzähler abgegangen ist, kommt Tante Em mit Wäschekorb aus dem Haus und beginnt Wäsche aufzuhängen*

```yaml
music: oz-kansas.mp3
midi: kansas-2.mid
note: Anette
trigger_note: {ch: 1, note: 10}
```

```yaml
music: oz-kansas-elke.mp3
midi: kansas-2.mid
note: Elke
trigger_note: {ch: 1, note: 11}
```

## Lied 1: Kansas

*Tante Em hängt weiter die Wäsche auf*

*Onkel Henry hackt weiter Holz*

**Tante Em**
Kansas ist staubig,<br>
Kansas ist grau.<br>
In der Prärie von Amerika<br>
ist die Landschaft sehr rau.<br>
Der Boden ist rissig,<br>
von der Sonne gebrannt.<br>
So ist's in der Steppe,<br>
in unserem Land, doch

**Tante Em** **Onkel Henry**
Hier sind wir zu Hause,<br>
hier woll'n wir nicht fort.<br>
Hier sind unsere Freunde,<br>
das macht's zum guten Ort.<br>
Anderswo mag's schick sein,<br>
anderswo liegt fern.<br>
Anderswo gibt's uns nicht,<br>
in Kansas sind wir gern.

*Onkel Hery vergist beim Singen der 2. Strophe das Holzhacken und schweift ab*

*Tante Em ist mittlerweile fertig mit dem Wäsche aufhängen und geht zum Haus, um Wäschekorb wegzubringen*

```yaml
mic: Erzähler
music:
    file: oz-palast-dieter.mp3
    volume: 0.8
    start: 1.097
trigger_note: {ch: 2, note: 2}
```

*In der Mitte der Strophe kommt sie wieder raus und geht zu Onkel Henry*

*Tante Em fordert ihn mit einer Geste dazu auf, weiter Holz zu hacken*

*Onkel Henry besenftigt sie, indem er ihr einen Holzscheit in die Hand drückt*

*Tante Em geht mit dem Holzscheit zur Feuerstelle und beginnt, das Lagerfeuer aufzubauen*

**Onkel Henry**
Es wirbeln die Stürme,<br>
dunkle Wolken zieh'n auf.<br>
Doch das ist nichts neues,<br>
sowas gibt's hier zu Hauf.<br>
Uns're Sturmkeller<br>
bieten uns Schutz.<br>
Und wenn's dann vorbei ist<br>
wird alles geputzt.

*Onkel bringt Holz hinterher und geht danach wieder zurück zur Holzhackstelle*

**Tante Em** **Onkel Henry**
Refrain

*Dorothy kommt aus dem Haus und geht zur Tante*

*Tante schickt Dorothy zu Onkel*

*Dorothy bringt auch Feuerholz zur Feuerstelle*

**Dorothy**
Onkel und Tante<br>
ackern sich ab.<br>
Dabei ist ihr Lächeln<br>
manchmal sehr schlapp.<br>
Helfe ich ihnen,<br>
freu'n sie sich sehr.<br>
Und tief aus dem Herzen<br>
kommt ein Lächeln daher

*Das ganze Ensemble singt hinter der Bühne den Refrain mit*

*Onkel Tante und Dorothy setzen sich ans Lagerfeuer*

**Tante Em** **Onkel Henry** **Dorothy**
Refrain

*Dorothy stellt sich hin*

*Onkel Henry und Tante em bleiben sitzen und bekommen von Dorothys Tagtraum nichts mit*

**Dorothy**
Manchmal träume ich gebannt<br>
von einem weit entfernten Land,<br>
es liegt über'm Regenbogen<br>
und ist von Magie durchzugen.<br>
Dort ist alles bunt,<br>
ich hätte einen echten Hund.<br>
Zwar gefällt mir dieser Traum,<br>
aber wahr wird er wohl kaum.<br>
Ich bleibe, wo ich bin,<br>
denn hier gehör' ich hin.

*Das ganze Ensemble singt hinter der Bühne den Refrain mit*

*Dorothy setzt sich wieder hin*

**Tante Em** **Onkel Henry** **Dorothy**
Refrain

```yaml
music: oz-wirbelsturm.mp3
qlcplus: wirbelsturm
trigger_note: {ch: 1, note: 12}
```

*Wenn die Musik stoppt springen Tante Em, Onkel Henry und Dorothy auf*

*Onkel Henry und Tante Em klappen die Stühle zusammen und bringen sie ins Haus*

**Onkel Henry**
Da kommt ein Wirbelsturm auf uns zu. Wir bringen uns besser im Sturmkeller in Sicherheit.

**Dorothy**
Ich will noch schnell Toto suchen. Er muss uns doch im Sturmkeller Glück bringen!

*Dorothy sucht auf der Rechten Seite in den Gassen nach Toto*

**Onkel Henry**
Na gut, aber beeil dich, der Sturm ist nicht mehr weit weg. Ich lasse schnell die Hühner frei, damit sie vor dem Sturm fliehen können.

*Onkel und Tante sind schon auf dem Weg zum Sturmkeller (links richtung Publikum)*

**Dorothy**
Ich kann Toto nicht finden. Vielleicht ist er im Haus.

*Dorothy läuft in Richtung des Hauses*

*Onkel Henry versucht nochmal, ein Stück zurück zu Dorothy zu laufen, wird aber vom Wind gehindert*

**Onkel Henry**
Nein, Dorothy. Dafür bleibt keine Zeit mehr.

****

```yaml
note: bar
trigger_note: {ch: 1, note: 126}
```

nte Em**
Henry, siehst du das? Das Haus, es fliegt. Es fliegt durch die Luft, mit Dorothy!

```yaml
qlcplus: black
trigger_note: {ch: 1, note: 13}
```

```yaml
mic: muteall
qlcplus: Umbau
trigger_note: {ch: 1, note: 14}
```

## Bei den Munchkins

```yaml
mic: Erzähler
music:
    file: erzaehler.mp3
    volume: 0.5
    adjust:
        trigger_note: {ch: 1, note: 12}
        fadeout: true
trigger_note: {ch: 1, note: 15}
```

*Der Erzähler kommt mit dem Marshmallow in der Hand von links auf die Bühne und bleibt auf der linken Seite stehen*

*Der Erzähler gestikuliert wild mit dem Marshmallow*

**Erzähler**
Habe ich euch nicht vor den Wirbelstürmen gewarnt? Hier in Kansas sind sie stark genug, um ganze Häuser davon zu tragen, als seien sie aus Papier. Aber ich kann euch beruhigen. Dorothy hatte Glück - das mag daran gelegen haben, dass sie jetzt ihren Toto wieder hatte, denn sie fand ihn im Haus mitten auf ihrem Bett. Glücklicherweise ist die Luft in der Mitte eines Wirbelsturms sehr ruhig und so wurde das Haus zwar vom Wind weggetragen, aber nicht zerstört. Wenn man allerdings erst einmal mitten in einem Wirbelsturm steckt, kann es Stunden dauern, bis man da wieder rauskommt. Ihr könnt euch vorstellen, dass Dorothy zunächst große Angst hatte, doch als sie merkte, dass das Haus dem Sturm standhielt, setzte sie sich auf ihr Bett und schaute aus dem Fenster. Mit der Zeit wurde sie ganz müde und schlief schließlich ein.

```yaml
music: haus-rumpeln.mp3
trigger_note: {ch: 1, note: 16}
```

*Die Munchkins knien auf der rechten Bühnenseite in Schockstarre mit Blick zur toten Hexe*

**Erzähler**
Oh, das hört sich an, als sei da gerade ein Haus vom Himmel gefallen. Schauen wir mal nach, wo Dorothy gelandet ist.

*Der Erzähler geht in Richtung der Munchkins, pflückt sich eine Blume und schenkt sie einem der Munchkins*

*Die Munchkins sind überfordert mit der Situation, gucken sich gegenseitig an und eilen nach rechts ab, um die Hexe zu holen*

```yaml
mic:
    - Munchkin 1
    - Munchkin 2
qlcplus: Munchkin Country
music:
    adjust:
        trigger_note: {ch: 1, note: 15}
        fadeout: true
trigger_note: {ch: 1, note: 17}
```

```yaml
mic:
    - Dorothy
    - Hexe des Nordens
trigger_note: {ch: 1, note: 18}
```

*Dorothy kommt aus dem Haus, blickt sich nach rechts um, sieht die tote Hexe noch nicht*

**Dorothy**
Wo bin ich denn hier gelandet? Ich glaube, ich bin nicht mehr in Kansas.

*Munchkins kommen mit Hexe von rechts*

**Hexe des Nordens**
Sei willkommen im Land der Munchkins, edle Zaubererin. Wir sind dir so dankbar, dass du die böse Hexe des Ostens getötet und ihr Volk aus der Knechtschaft befreit hast.

**Dorothy**
Das ist sehr nett, aber es muss ein Missverständnis sein. Ich habe doch niemanden getötet.

*Dorothy weicht ein paar Schritte zurück nach links*

**Hexe des Nordens**
Aber dein Haus hat es getan und das ist schließlich dasselbe. Schau!

*Dorothy bemerkt die tote Hexe und erschrickt*

**Dorothy**
Oh nein, das Haus muss auf sie gestürzt sein! Was sollen wir jetzt tun?

*Hexe unbedarft und mit Schulterzucken*

**Hexe des Nordens**
Da gibt es nichts zu tun.

*Daraufhin zucken die Munchkins auch mit den Schultern und widmen sich wieder ihrer Arbeit mit den Blumen (rechts)*

*Dorothy nähert sich wieder der bösen Hexe und begutachtet diese und ist aufgebracht darüber, dass sie die Hexe umgebracht hat*

**Dorothy**
Aber warum nicht? Wer war sie?

*Hexe tröstet Dorothy etwas*

**Hexe des Nordens**
Wie ich schon sagte, war Sie die böse Hexe des Ostens. Sie hat die Munchkins für viele Jahre in Gefangenschaft gehalten. Sie mussten Tag und Nacht für die böse Hexe arbeiten. Dank dir sind die Munchkins jetzt frei.

**Dorothy**
Wer sind die Munchkins?

*Hexe schiebt Dorothy nach rechts zu den Munchkins und stellt sie vor*

**Hexe des Nordens**
Sie sind das Volk, das im Land des Ostens lebt, wo die böse Hexe herrschte.

*Dorothy schüttelt den Munchkins die Hände*

*Hexe steht hinter den Munchkins*

**Dorothy**
Bist du auch ein Munchkin?

**Hexe des Nordens**
Nein, aber ich bin mit ihnen befreundet.

*Hexe geht hinten herum stolz in die Mitte der Bühne und spricht zum Publikum*

**Hexe des Nordens**
Obwohl ich selber im Land des Nordens lebe. Als die Munchkins sahen, dass die böse Hexe tot ist, schickten sie mir einen Boten und ich kam sofort hierher. Ich bin die Hexe des Nordens.

*Dorothy schreckt etwas zurück in Richtung der Munchkins*

**Dorothy**
Du meine Güte, bist du eine echte Hexe?

*Die Munchkins versuchen immer wieder, Dorothy abzulenken und ihr ihre Arbeit zu zeigen um sich bei der "neue Herrscherin" von sich zu beeindrucken*

**Hexe des Nordens**
Ja, in der Tat. Aber ich bin eine gute Hexe und die Leute mögen mich. Doch leider bin ich nicht so mächtig, wie es die böse Hexe des Ostens war, sonst hätte ich die Munchkins selbst befreien können.

**Dorothy**
Aber ich dachte, alle Hexen seien böse.

*Die Hexe untersucht die Böse Hexe während sie erzählt*

**Hexe des Nordens**
Oh nein, das ist ein weit verbreiteter Irrtum. Es gibt nur vier Hexen im ganzen Land von Oz. Zwei von ihnen, jene, die im Norden und Süden leben, sind gute Hexen. Das weiß ich, da ich selbst eine von ihnen bin. Jene, die im Osten und Westen wohnen, sind tatsächlich böse Hexen. Aber jetzt, da du eine von ihnen getötet hast, gibt es nur noch eine böse Hexe im ganzen Land von Oz, und zwar die Hexe des Westens.

**Dorothy**
Aber Tante Em hat mir erzählt, dass es schon seit vielen Jahren keine Hexen
mehr gibt.

**Hexe des Nordens**
Wer ist Tante Em, ist sie vielleicht selber eine Hexe?

*Die Hexe schiebt Dorothy auf die linke Seite der Bühne*

**Dorothy**
Onkel Henry sagt das manchmal, aber er zwinkert dabei immer mit einem Auge. Ich glaube, er meint das nicht ernst. Sie ist meine Tante und lebt in Kansas, wo ich auch herkomme.

*Hexe geht in die Mitte der Bühne*

**Hexe des Nordens**
Kansas? Ich habe noch nie von diesem Ort gehört. Dieses Kansas muss außerhalb von Oz liegen.

**Dorothy**
Ja, bestimmt.

**Hexe des Nordens**
Das erklärt es. Jenseits der Wüste, die das Land von Oz begrenzt, gibt es keine Hexen und Zauberer mehr.

**Dorothy**
Wer sind die Zauberer?

*Hexe geht etwas in Oz verliebt auf die rechte Bühnenseite*

*Wenn die Munchkins das sehen gehen sie auf die linke Bühnenseite und arbeiten dort an den Blumen*

**Hexe des Nordens**
Oz selbst ist der große Zauberer. Er ist mächtiger als wir alle zusammen. Er lebt in der Smaragdstadt.

**Dorothy**
Ich würde gerne zurück nach Hause. Tante und Onkel machen sich sicher schon Sorgen um mich.

*Dorothy richtet sich an die Munchkins*

**Dorothy**
Könnt ihr mir helfen, den Weg zu finden?

```yaml
mic:
    - Dorothy
    - Hexe des Nordens
    - Munchkin 1
    - Munchkin 2
trigger_note: {ch: 1, note: 19}
```

**Munchkin 1**
Im Osten, nicht weit von hier, beginnt die Wüste. Sie erstreckt sich über so viele Kilometer, dass niemand sie lebend durchqueren kann.

**Munchkin 2**
So ist es auch im Süden, da bin ich schon gewesen und habe es gesehen.

**Munchkin 1**
Und im Westen, wo die Winkies leben, herrscht die böse Hexe. Sie wird dich zu ihrer Sklavin machen, wenn du ihr Land betrittst.

```yaml
mic:
    - Dorothy
    - Hexe des Nordens
trigger_note: {ch: 1, note: 20}
```

*Hexe drängt sich wieder Dorothy auf, geht auf die linke Bühnenseite*

**Hexe des Nordens**
Ich lebe im Land des Nordens und das wird von derselben großen Wüste begrenzt, die auch den Rest des Lands von Oz umgibt. Es tut mir leid, aber du wirst wohl bei uns leben müssen.

*Dorothy beginnt zu weinen*

*Munchkins werfen sich einen genervten Blick zu, wenn die Hexe wieder kommt. Sehen dann aber Dorothy weinen und trösten sie*

*Hexe geht wieder in die Mitte der Bühne*

**Hexe des Nordens**
Aber weine doch nicht, meine Liebe. Ich werde meinen magischen Hut um Rat bitten.

**Hexe des Nordens**
Eins, zwei drei

*dann zieht sie einen Zettel daraus hervor und liest vor*

**Hexe des Nordens**
Schick Dorothy in die Smaragdstadt. Wer ist Dorothy?

**Dorothy**
Das bin ich!

*Hexe schiebt Dorothy wieder ein Stück in die Mitte der Bühne*

**Hexe des Nordens**
Dann musst du wohl in die Smaragdstadt gehen, vielleicht wird dir Oz helfen.

**Dorothy**
Wo ist diese Stadt?

*Mit jeder weiteren Frage von Dorothy schiebt die Hexe sie ein Stück weiter nach rechts, bei jeder Frage bleibt Dorothy stehen*

**Hexe des Nordens**
Sie liegt genau in der Mitte des Landes und wird von Oz regiert, dem großen Zauberer, von dem ich dir erzählt habe.

**Dorothy**
Ist er ein guter Mann?

**Hexe des Nordens**
Er ist ein guter Zauberer. Ob er auch ein guter Mann ist, kann ich dir nicht sagen, da ich ihm noch nie begegnet bin.

**Dorothy**
Wie komme ich dorthin?

**Hexe des Nordens**
Du musst laufen. Es ist eine lange und gefährliche Reise. Aber ich werde alle meine Zauberkunst einsetzen, um dich vor Schaden zu bewahren.

**Dorothy**
Wirst du nicht mitkommen?

**Hexe des Nordens**
Das kann ich leider nicht. Aber ich werde dir meinen Kuss geben. Denn niemand wird es wagen, dich zu verletzen, wenn du von der Hexe des Nordens geküsst wurdest.

*küsst Dorothy auf die Stirn*

*Die Hexe will die Schuhe holen und bekommt von einem Munchkin einen Blumenstrauß in die Hand gedrückt*

*Die Hexe ist kurz verwirrt, holt dann aber die Schuhe und dürückt diese Dorothy in die Hand*

**Hexe des Nordens**
Und ziehe die silbernen Schuhe an. Die Hexe des Ostens hat sie mit mächtigen Zaubern belegt. Ich weiß nicht genau, wie sie funktionieren, aber sie könnten nützlich sein. Die Straße nach Oz ist mit gelben Steinen gepflastert. Du kannst sie gar nicht verfehlen. Auf Wiedersehen, meine Liebe.

*Hexe schiebt Dorothy von der Bühne, Dorothy hat keine Zeit mehr, die Schuhe anzuziehen*

```yaml
mic: Erzähler
qlcplus: Umbau
music: erzaehler.mp3
trigger_note: {ch: 1, note: 21}
```

*Erzähler tritt von rechts hinter Hexe auf, bleibt rechts stehen*

*Währenddessen Umbau*

*Munchkins gehen nach links ab*

*Hexe geht nach rechts ab*

*Die Türme tauschen die Seiten und werden an den Rand geschoben, Hausseite jeweils zum Publikum zeigend, etwas angeschrägt, sodass die kleine Seite etwas zum Publikum zeigt*

**Erzähler**
Ein wunderbares Land, in dem Dorothy da gelandet ist, findet ihr nicht auch? Aber Dorothy wollte lieber wieder nach Hause. Deshalb machte sie sich auf den Weg in die Smaragdstadt, um den großen Zauberer von Oz um Hilfe zu bitten. Ein bisschen mulmig war ihr schon zumute, so ganz allein in einem so sonderbaren Land, in dem es Zauberei gab. Aber sie hatte ja ihren Toto dabei, und das gab ihr Mut.

*Erzähler nimmt den Blumenkübel, der vor ihm steht, mit und geht nach links ab*

```yaml
mic: muteall
trigger_note: {ch: 1, note: 22}
```

## Die Vogelscheuche

```yaml
mic:
    - Dorothy
    - Vogelscheuche
qlcplus: yellow road
music:
    adjust:
        trigger_note: {ch: 1, note: 21}
        fadeout: true
trigger_note: {ch: 1, note: 23}
```

```yaml
qlcplus: Vogelscheuche Shilouette
trigger_note: {ch: 1, note: 24}
```

*Die Vogelscheuche ist auf der linken Seite hinten im Schatten*

*Dorothy tritt von links auf, geht an der Bühnenkante entlang zu den Wegweisern auf der rechten Seite*

**Dorothy**
Na nu? So viele Wegweiser? Wie geht es denn jetzt weiter?

```yaml
qlcplus: Vogelscheuche erwacht
trigger_note: {ch: 1, note: 25}
```

**Vogelscheuche**
Wo willst du denn hin?

*Dorothy blickt sich suchend um*

**Dorothy**
Hast du gerade etwas gesagt?

**Vogelscheuche**
So ist es! Oder siehst du sonst noch jemanden hier? Also, wo möchtest du hin?

**Dorothy**
Ich bin auf dem Weg in die Smaragdstadt.

**Vogelscheuche**
Das klingt nach einem spannenden Abenteuer. Wie gerne würde ich auch mal etwas Spannendes tun. Es ist sehr langweilig, Tag und Nacht hier herumzuhängen, um Vögel zu verscheuchen.

**Dorothy**
Kannst du nicht herunterkommen?

**Vogelscheuche**
Nein, mir steckt diese Stange im Rücken, aber wenn du mich von der Stange losbinden könntest, wäre ich dir sehr dankbar.

*Dorothy geht zur Vogelscheuche und bindet sie los. Die Vogelscheuche taumelt einen Moment, dann kippt sie um*

**Vogelscheuche**
Ahahaha, ich Tollpatsch, aber wie soll ich denn auch wissen, wie man auf eigenen Beinen steht. Bisher hat mich ja diese Stange gehalten.

*Dorothy hilft der Vogelscheuche auf*

**Dorothy**
Die Beine gerade, Oberkörper nach oben, ja, genauso.

**Vogelscheuche**
Ach, das ist ja ganz einfach. Jetzt fühle ich mich fast wie ein richtiger Munchkin.

*Stolziert etwas unbeholfen im Kreis über die Bühne, Dorothy bleibt in der Mitte stehen*

**Vogelscheuche**
Wer bist du und wohin gehst du?

**Dorothy**
Mein Name ist Dorothy. Ich bin auf dem Weg in die Smaragdstadt und ich möchte zum großen Oz.

**Vogelscheuche**
Was ist ein großes Oz? Reicht dir nicht ein kleines Oz?

**Dorothy**
Weißt du das etwa nicht?

**Vogelscheuche**
Nein, tatsächlich weiß ich gar nichts. Ich bin mit Stroh ausgestopft und habe kein Gehirn und keinen Verstand.

**Dorothy**
Oh, das tut mir sehr leid für dich. Oz ist ein großer Zauberer. Ich möchte ihn bitten, mich nach Kansas zurückzubringen, denn dort bin ich zu Hause.

*Vogelscheuche stoppt ihre Runden und bleibt stehen, hat ihre erste Idee*

**Vogelscheuche**
Oh, ein großer Zauberer? Glaubst du, dass mir dieser Oz ein Gehirn geben würde, wenn ich dich in die Smaragdstadt begleite?

**Dorothy**
Das weiß ich nicht, aber wenn du magst, kannst du mit mir mitkommen. Und falls Oz dir kein Gehirn geben sollte, wärst du ja nicht schlechter dran als jetzt auch.

**Vogelscheuche**
Das stimmt. Du musst wissen, es macht mir nichts aus, dass meine Arme und Beine ausgestopft sind, denn so kann ich mir nicht weh tun. Wenn mir jemand auf den Fuß tritt oder mich mit einer Nadel piekst, passiert meinem Stroh gar nichts. Aber ich möchte kein Dummkopf sein! Wenn in meinem Kopf anstatt eines Hirns nur Stroh ist, wie soll ich dann etwas wissen?

**Dorothy**
Ich verstehe, was du meinst. Wenn du mit mir kommst, werde ich Oz bitten, alles in seiner Macht Stehende für dich zu tun.

**Vogelscheuche**
Na super, dann bin ich dabei. Lass mich den Korb für dich tragen. Stroh wird nicht müde.

*Die beiden gehen zu den Wegweisern*

**Dorothy**
Aber wo geht es denn jetzt lang?

*Die beiden schauen sich die Wegweiser an, die Vogelscheuche dreht einen Wegweiser, auf dem nun Smaragdstadt zu lesen ist. Dadurch finden sie zwar den richtigen Wegweiser, wissen aber nicht mehr, in welche Richtung er ursprünglich zeigte. Beide schauen sich einen Moment unschlüssig an*

**Vogelscheuche**
Ach, ist auch egal. Schließlich führen alle Wege in die Smaragdstadt.

**Dorothy**
Woher weißt du das?

**Vogelscheuche**
Ich weiß das nicht, denn mein Kopf ist voller Stroh! Los, komm!

*Die Vogelscheuche nimmt Dorothy und geht nach Rechts von der Bühne*

```yaml
qlcplus: Umbau
mic: muteall
music: oz-umbau.mp3
trigger_note: {ch: 1, note: 26}
```

```yaml
projection: Umbau Blechmann
trigger_note: {ch: 1, note: 27}
```

## Der Blechmann

```yaml
mic:
    - Dorothy
    - Vogelscheuche
    - Blechmann
qlcplus: yellow road
music:
    adjust:
        trigger_note: {ch: 1, note: 26}
        fadeout: true
trigger_note: {ch: 1, note: 28}
```

*Dorothy und die Vogelscheuche treten links auf und gehen an der Bühnenkante entlang, bis sie auf der rechten Seite sind*

*Man hört den Blechmann stöhnen*

```yaml
qlcplus: Blechmann
projection: Blechmann 1
note: Sobald der Blechmann gestöhnt hat
trigger_note: {ch: 1, note: 29}
```

**Dorothy**
Was war das?

**Vogelscheuche**
Ich weiß es nicht, aber wir können ja mal nachsehen. Es kam aus dieser Richtung.

*Dorothy und Vogelscheuche gehen zum Blechmann, bleiben rechts von ihm stehen*

**Dorothy**
Hast du eben gestöhnt?

**Blechmann**
Ja, ich stöhne schon seit einiger Zeit, aber noch nie hat mich jemand gehört oder ist gekommen, um mir zu helfen.

**Dorothy**
Was fehlt dir denn?

**Blechmann**
Meine Gelenke sind so sehr eingerostet, dass ich sie nicht mehr bewegen kann. Sie müssen geölt werden.

**Dorothy**
Das können wir doch machen. Hast du Öl?

**Blechmann**
Da hinten steht eine Ölkanne.

*Dorothy geht nach links und holt die Ölkanne und beginnt, den Blechmann zu ölen, bleibt danach auf der linken Seite des Blechmanns stehen*

*Vogelscheuche hilft dabei, den Blechmann durchzukneten*

**Blechmann**
Das fühlt sich gut an. Ich hätte vielleicht ewig hier herumgestanden, wenn ihr nicht vorbeigekommen wärt. Ihr habt mein Leben gerettet. Warum seid ihr eigentlich hier?

**Dorothy**
Wir sind auf dem Weg in die Smaragdstadt, um den großen Oz zu treffen.

**Blechmann**
Was wollt ihr von Oz?

**Dorothy**
Ich möchte ihn bitten, mich nach Kansas zurückzubringen.

**Vogelscheuche**
Und ich möchte ihn bitten, mir ein Gehirn zu geben.

**Blechmann**
Glaubt ihr, Oz könnte mir auch ein Herz geben?

**Dorothy**
Ich denke schon, das sollte genau so leicht sein, wie der Vogelscheuche ein Gehirn zu geben.

**Blechmann**
Das stimmt. Wenn ihr es erlaubt, würde ich mich euch gerne anschließen. Ich will auch in die Smaragdstadt und Oz bitten, mir zu helfen.

**Vogelscheuche**
Dann komm mit uns.

*Die drei gehen weiter, die Vogelscheuche stolpert nach 2 Schritten*

*Dadurch kehren die drei in die vorherige Position zurück*

**Dorothy**
Was ist passiert?

**Vogelscheuche**
Ich bin in ein Loch getreten.

**Blechmann**
Warum hast du das getan?

**Vogelscheuche**
Ich weiß nicht. Mein Kopf ist voller Stroh. Deshalb will ich ja Oz um ein Gehirn bitten.

**Blechmann**
Oh, ich verstehe. Aber ein Gehirn zu haben ist nicht das beste der Welt.

**Vogelscheuche**
Hast du eins?

**Blechmann**
Nein, mein Kopf ist ziemlich leer. Aber einst hatte ich ein Gehirn und auch ein Herz. Und da ich beides hatte, weiß ich, dass ich viel lieber ein Herz haben will.

**Vogelscheuche**
Und warum das?

**Blechmann**
Ich kann euch meine Geschichte erzählen, dann werdet ihr es verstehen:

*Der Blechmann holt sein Tagebuch hervor*

## Lied 2: Blechmann

```yaml
music: oz-blechmann.mp3
midi: blechmann.mid
projection: Blechmann Song
trigger_note: {ch: 1, note: 30}
```

*Dorothy und Vogelscheuche in den Refrains ihre Charakterzüge ausleben (z. B. Vogelscheuche keine Empathie etc.)*

*In den Strophen Dorothy und Vogelscheuche aufmerksam zuhören, um nicht von der Projizierten Geschichte abzulenken*

**Blechmann**
Ich bin aus Blech und Schrauben,<br>
von innen bin ich hohl.<br>
Auf innere Werte kommt es an,<br>
was gibt's da bei mir wohl?.<br>
Als ich noch ein Mensch war,<br>
war ich voller Gefühle,<br>
doch seit mein Herz fehlt<br>
lässt mich alles kühl

**Blechmann**
Als ich noch ein Mensch war, stand mein Herz in Flammen.<br>
Eine Munchkin und ich, in Liebe wir schwammen.<br>
Ihre Mutter war böse, ließ sie Hausarbeit machen.<br>
Sie störte sich an unserem Lachen

**Blechmann**
Denn wenn ihre Tochter verliebt wegziehen würde,
hätte sie keine mehr, die ihr den Haushalt führte.<br>
So sollte ich weichen, oh jemine,<br>
und meiner Freundin sagen "Ade".

**Blechmann**
Refrain

**Blechmann**
Sie wollte mich heiraten, wenn ich ihr ein Haus baute.<br>
So hackte ich Holz für unser zu Hause.<br>
Die Mutter schloss einen Packt mit der Hexe im Osten.<br>
beim Gedanken daran meine Schrauben durchrosten.

**Blechmann**
So brachte die Hexe über meine Axt 'nen Fluch.<br>
Ich hackte mir den Arm ab beim Holzhackversuch.<br>
Die Mutter war glücklich und mir ging es schlecht.<br>
Kein Haus konnt' ich bauen, mein Arm war ja weg.

*Der Blechmann fängt an zu weinen*

*Die Vogelscheuche springt auf und geht zum Blechmann*

*Dorothy bleibt sitzen*

**Blechmann**
Ich kann das nicht, da kommen mir zu viele Gefühle hoch.

**Vogelscheuche**
Kann ich dir helfen? Gib mal her.

*Vogelscheuche nimmt das Tagebuch, blättert ein paar Seiten vor, murmelt vor sich hin*

*Der Blechmann bleibt neben der Vogelscheuche stehen*

**Vogelscheuche**
Blah blah laaangweilig... ah hier.

**Vogelscheuche**
Ich wusste nicht weiter, was ein blödes Pech.<br>
Doch fertigte der Schmied mir einen Arm aus Blech.<br>
Nach weiteren Attacken bekam ich viele Macken.<br>
Der Schmied musste ordentlich Ersatzteile machen.

**Vogelscheuche**
So ersetzte er dann an mir Teil für Teil.<br>
Und ich schwang weiter fleißig mein Beil.<br>
Als sich dann die Axt für meine Brust hat entschieden,<br>
konnt der Schmied mich zwar retten, doch kein Herz konn't er schmieden.

*Ab 'doch kein Herz konn't er schmieden' steigt der Blechmann wieder mit ein und singt zusammen mit der Vogelscheuche*

**Vogelscheuche** **Blechmann**
Refrain

```yaml
projection: Blechmann 2
mic:
    - Dorothy
    - Vogelscheuche
    - Blechmann
trigger_note: {ch: 1, note: 31}
```

*Dorothy steht auf und geht zu den anderen beiden*

**Dorothy**
Das ist ja wirklich eine traurige Geschichte.

**Blechmann**
Kann sein, ich habe ja kein Herz, daher kann ich nicht mitfühlen.

**Vogelscheuche**
Ich werde Oz dennoch lieber um ein Gehirn bitten, denn ein Dummkopf wüsste auch nichts mit einem Herz anzufangen, selbst wenn er eins hätte. Außerdem komme ich auch ohne ein Herz ganz gut aus. Wenn mich jemand als Dummkopf bezeichnet, fühlt sich das nicht gut an, deshalb weiß ich, dass ich auch ohne Herz Gefühle habe.

*Vogelscheuche geht nach rechts ab*

*Blechmann bleibt noch stehen*

*Dorothy folgt der Vogelscheuche, merkt auf halber Strecke, dass der Blechmann noch dort steht, winkt Blechmann zu sich*

**Blechmann**
Ich möchte ein Herz, denn ein Gehirn macht nicht glücklich. Und Glück ist das beste der Welt. Ich habe zwar kein Hirn, aber ich weiß alles, was ich wissen muss.

```yaml
qlcplus: black
projection: black-2
trigger_note: {ch: 1, note: 32}
```

```yaml
qlcplus: Umbau
trigger_note: {ch: 1, note: 33}
```

```yaml
projection: Umbau Löwe
trigger_note: {ch: 1, note: 34}
```

## Der feige Löwe

*Die Freunde treten von links auf, laufen an der Bühnenkante entlang und bleiben in der Mitte stehen, währenddessen unterhalten sie sich*

```yaml
projection: Löwe
trigger_note: {ch: 1, note: 35}
```

```yaml
qlcplus: Wald
mic:
    - Blechmann
    - Vogelscheuche
    - Dorothy
trigger_note: {ch: 1, note: 36}
```

**Blechmann**
Sag mal, du sagtest doch, ... wie soll ich das jetzt ausdrücken, ohne verletzend zu sein...

**Vogelscheuche**
Dass ich ein Dummkopf bin, weil ich kein Gehirn habe?

**Blechmann**
Nee, ich habe mich nur gewundert, warum du lesen kannst. Das hätte ich einer Vogelscheuche gar nicht zugetraut.

**Vogelscheuche**
Wie kommst du darauf?

**Blechmann**
Du hast doch so schön aus meinem Tagebuch vorgelesen.

**Vogelscheuche**
Naja, weißt du, als ich noch an einer Stange hing, standen mir gegenüber einige Wegweiser. Und wenn man den ganzen Tag nichts zu tun hat, dann versucht man halt mal zu entziffern, was da drauf so steht. Ach, und außerdem steht doch in diesen ganzen Liebesgeschichten sowieso fast immer das gleiche drin.

*Die Freunde gehen weiter und um den Turm herum, bleiben danach auf der linken Bühnenseite stehen*

**Dorothy**
Wie lange wird es wohl noch dauern, bis wir aus dem Wald hinaus sind?

```yaml
mic:
    - Blechmann
    - Vogelscheuche
    - Dorothy
    - Löwe
trigger_note: {ch: 1, note: 37}
```

*Der Löwe lukt hinter einem Baum hervor*

**Blechmann**
Das ist schwer zu sagen, ich war ja noch nie in der Smaragdstadt. Aber mein Vater ging einmal dorthin, als ich noch ein kleiner Junge war. Er sagte mir, es sei eine lange Reise durch gefährliche Gegenden. Aber ich habe keine Angst, solange ich meine Ölkanne dabeihabe. Es gibt nichts, was die Vogelscheuche verletzen könnte und du bist durch den Kuss der guten Hexe geschützt.

*Die Freunde laufen wieder weiter, Vogelscheuche voran, dann Blechmann, dann Dorothy*

*Der Löwe springt mit einem Brüllen hinter dem Turm hervor und wirft die Vogelscheuche um, diese setzt sich danach auf, bleibt aber sitzen*

*Der Blechmann droht dem Löwen mit der Axt*

**Löwe**
Bitte tu mir nichts!

*Der Löwe läuft einmal um den Turm herum*

*Dorothy und Blechmann gehen ein paar Schritte nach rechts und schauen ihm hinterher*

**Blechmann**
Aber du hast doch uns angegriffen!

**Dorothy**
Ja, du hast die Vogelscheuche umgeworfen.

*Der Löwe kommt hinter dem Turm hervor und geht auf die linke Bühnenseite, erst wenn er anfängt zu sprechen, drehen Dorothy und der Blechmann sich verwundert zu ihm um*

**Löwe**
Aber doch nur, weil sie mir zu nahegekommen ist. Das hat mir Angst gemacht. Ich habe mich ja selbst erschreckt, dass sie so weit weggeflogen ist. Ich habe nicht damit gerechnet, dass sie so leicht ist.

*Der Löwe Ängstlich aus der Ferne zur Vogelscheuche*

**Löwe**
Tut mir leid, mein Freund, habe ich dir weh getan?

**Vogelscheuche**
Ach, nicht der Rede wert. Ich bin weich wie auf Stroh gelandet. Nein, warte, ich bin ja auf Stroh gelandet.

*Die Vogelscheuche steht mit einem Ruck wieder auf*

*Dorothy geht ein Stück in Richtung Löwe, der Blechmann folgt ihr*

**Dorothy**
Du fürchtest dich vor Vogelscheuchen?

**Löwe**
Ich fürchte mich vor vielen Dingen.

**Dorothy**
Aber du bist doch ein großer und starker Löwe. Ich habe mich gewaltig vor dir erschrocken.

**Löwe**
Vor allem bin ich ein großer Feigling. Es tut mir leid, wenn ich euch Angst eingejagt habe.

**Dorothy**
Wie kommst du darauf, dass du ein Feigling bist?

**Löwe**
Das war ich schon immer. Vermutlich wurde ich als einer geboren. Alle anderen Tiere erwarten von mir, mutig zu sein, weil der Löwe als König der Tiere angesehen wird. Ich habe gemerkt, dass sich alle vor mir fürchten, wenn ich laut genug brülle. Wann immer ich auf etwas treffe, wovor ich mich fürchte, brülle ich es an und es geht mir aus dem Weg.

*Löwe brüllt, die anderen weichen ein Stück zurück*

*Vogelscheuche stellt sich auf die linke Seite des Löwen*

**Vogelscheuche**
Aber der König der Tiere sollte doch kein Feigling sein.

**Löwe**
Ich weiß, das ist eine große Last für mich und macht mein Leben sehr unglücklich. Aber immer, wenn Gefahr droht, fängt mein Herz an, schneller zu schlagen.

*Blechmann stellt sich auf die rechte Seite des Löwen*

**Blechmann**
Vielleicht leidest du an einer Herzkrankheit. Wenn ja, kannst du dich glücklich schätzen, denn das beweist, dass du ein Herz hast. Ich für meinen Teil habe gar kein Herz, das erkranken könnte.

**Löwe**
Wenn ich kein Herz hätte, wäre ich vielleicht kein Feigling.

**Vogelscheuche**
Hast du ein Gehirn?

**Löwe**
Ich glaube schon, aber ich habe noch nie nachgesehen.

**Vogelscheuche**
Ich gehe zum großen Oz, um ihn zu bitten, mir ein Gehirn zu schenken, denn mein Kopf ist nur mit Stroh gefüllt.

**Blechmann**
Und ich gehe zu ihm, um ihn um ein Herz zu bitten.

*Dorothy stellt sich mit zu den anderen*

**Dorothy**
Und ich werde ihn bitten, mich nach Kansas zurückzubringen.

**Löwe**
Glaubt ihr, Oz könnte mir auch Mut geben?

**Vogelscheuche**
Genauso leicht, wie er mir ein Gehirn geben kann.

**Blechmann**
...oder mir ein Herz.

**Dorothy**
...oder mich nach Kansas zurückbringen kann.

**Löwe**
Dann würde ich gerne mit euch mitkommen. Denn mein Leben ist einfach unerträglich, ohne etwas Mut.

**Dorothy**
Du bist herzlich eingeladen. Auf diese Weise werden uns die anderen wilden Tiere vom Hals bleiben. Es scheint mir so, als seien die noch feiger als du, wenn du sie so einfach erschrecken kannst.

**Löwe**
Das sind sie wirklich, aber das macht mich kein bisschen mutiger und solange ich weiß, dass ich ein Feigling bin, werde ich unglücklich sein.

**Dorothy**
Dann lasst uns aufbrechen. Es ist bestimmt noch ein weiter Weg nach Oz.

*Die Gruppe geht durchs Publikum, vorne Dorothy, dann Löwe, dann Blechmann, dann Vogelscheuche*

*Der Umbau beginnt*

```yaml
qlcplus: black
projection: black-3
trigger_note: {ch: 1, note: 38}
```

```yaml
qlcplus: Umbau
trigger_note: {ch: 1, note: 39}
```

```yaml
projection: Umbau Torwächter 1
trigger_note: {ch: 1, note: 40}
```

*Der Blechmann bleibt plötzlich stehen, die Vogelscheuche läuft ihm auf*

*Der Blechmann beginnt zu weinen*

**Blechmann**
Oh nein!

**Dorothy**
Was ist los?

*Der Blechmann antwortet nicht und bleibt nur regungslos stehen.*

**Vogelscheuche**
Ich glaube, die Tränen haben ihn wieder rosten lassen. Wo haben wir die Ölkanne?

*Die Vogelscheuche merkt, dass sie die Ölkanne selbst im Korb hat und ölt den Blechmann*

**Blechmann**
Ich bin auf einen Käfer getreten und habe ihn zerquetscht. Das wird mir eine Lehre sein. Ich werde besser aufpassen, wo ich hintrete. Ihr Leute mit Herz habt es gut, ihr habt etwas, das euch leitet und müsst nie etwas Falsches tun, aber da ich kein Herz habe, muss ich immer sehr vorsichtig sein.

**Vogelscheuche**
Na dann musst du ja einfach mehr Acht geben, und dann passiert schon nichts. Aber ein Hirn lässt sich nicht so leicht durch etwas anderes ersetzen. Naja, vielleicht gibt mir dieser Oz ja eins...

*kurze Pause*

**Vogelscheuche**
Ach, bin ich froh, dass ich jetzt nicht mehr an dieser Stange auf dem Feld hänge und selbst durch die Welt laufen kann. Ich glaube, ich geh' ein bisschen die Welt erkunden.

**Dorothy**
Mach das, aber lauf nicht zu weit vor! Nicht, dass du uns noch davonläufst.

**Vogelscheuche**
Ach, mach dir da mal keine Sorgen.

## Die Hüter der Tore

*Die Torwächter stehen in ihren Wachhäusschen, bei ihrem jeweiligen Musikeinsatz öffnen sie ihr Fenster*

```yaml
music: gate-build-audio.mov
projection: Torwächter Aufbau
trigger_note: {ch: 1, note: 41}
```

```yaml
qlcplus: Torwächter
projection: Torwächter 1 Maske
trigger_note: {ch: 1, note: 42}
```

```yaml
mic:
    - Torwächter 1
    - Torwächter 2
music: torwaechter.mp3
trigger_note: {ch: 1, note: 43}
```

## Lied 3: Torwächter

**Torwächter 1**
Hallihallo, wer kommt denn da?<br>
Handelt es sich um Gefahr?

**Torwächter 2**
Gefahr? Gefahr?<br>
Ist das denn wahr?

**Torwächter 1**
Ich glaub', wir schauen einfach mal.

*holt ein Fernglas heraus*

**Torwächter 1**
Ein kleines Mödchen ist zu seh'n.<br>
Daneben noch zwei Menschen steh'n.

**Torwächter 2**
Nun gib' schon her,<br>
ich seh' so schwer!

**Torwächter 1**
Ja, ganz ruhig, hier, bittesehr.

**Torwächter 2**
Die Menschen sind nicht ganz normal.<br>
Sowohl aus Stroh, als auch aus Stahl.<gr>
Und dieses Tier? Ein Löwe, hier?

**Torwächter 2**
Schluss mit der blöden Musik, das wird mir jetzt doch zu unheimlich.

*Torwächter 1 geht aus dem Häuschen raus*

**Torwächter 1**
Jetzt beruhig dich doch mal

```yaml
mic:
    - Torwächter 1
    - Torwächter 2
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
projection: Torwächter 1 OM
trigger_note: {ch: 1, note: 44}
```

*Inzwischen sind die vier Freunde zum Tor gekommen*

**Löwe**
Guten Tag, geht es hier zur Smaragdstadt?

**Torwächter 1**
Da liegst du gold... äh smaragdrichtig

**Löwe**
Das ist ja wunderbar! Ist es hier so schön, wie man sich im ganzen Land
erzählt?

**Torwächter 1**
Ob es hier schön ist?

*Torwächter tanzen*

## Lied 4: Smaragthymne

```yaml
music: oz-smaragthymne.mp3
trigger_note: {ch: 1, note: 45}
```

**Torwächter 1**
Die Smaragtstadt, die Smaragtstadt,<br>
sie ist edel, sie ist toll.<br>
Ja wir sind hier alle gerrne. Alle sind hier liebevoll.<br>
Und uns geht es allen gut, denn uns regiert der große Oz.<br>
Er ist gütig und gerecht und wohnt in einem grünen Schloss.

**Torwächter 1**
Los, sint mit!

**Torwächter 1** **Torwächter 2** **Dorothy** **Löwe** **Blechmann**
Refrain

*Sobald das Lied endet, wollen die vier Freunde ihre Reise fortsetzen, werden dann jedoch vom Torwächter zurückgehalten.*

**Torwächter 1**
Halt! Nicht so schnell. Wir können hier nicht jeden einfach so hereinlassen. Wer seid ihr und was wollt ihr in der Smaragdstadt?

**Dorothy**
Mein Name ist Dorothy und wir sind hier, um den großen Zauberer von Oz zu treffen.

**Torwächter 2**
Oh, es ist schon lange her, dass jemand darum gebeten hat, Oz zu treffen.

**Torwächter 1**
Bedenkt, dass er ein mächtiger Zauberer ist und falls ihr ihn mit einer unnützen oder törichten Angelegenheit belästigt, könnte er wütend werden.

**Vogelscheuche**
Aber es ist weder eine unnütze noch eine törichte Angelegenheit. Es ist sehr wichtig. Uns wurde gesagt, Oz sei ein guter Zauberer.

**Torwächter 1**
Das ist er. Er regiert die Smaragdstadt weise und gut.

**Blechmann**
Dann wird er uns bestimmt gerne helfen.

**Torwächter 1**
Was wollt ihr denn von Oz?

**Vogelscheuche**
Ich möchte ihn bitten, dass er mir ein Gehirn gibt. Ich möchte nämlich kein Strohkopf mehr sein.

*Die Torwächter schauen sich etwas unsicher an und weisen die Vogelscheuche auf die linke Bühnenseite*

*Vogelscheuche wechselt die Seite nach links*

**Blechmann**
Und mir soll er ein Herz geben, damit ich glücklich sein kann.

*Blechmann wechselt die Seite nach links*

**Löwe**
Und mir Mut, damit ich nicht länger ein Feigling bin.

*Löwe wechselt die Seite nach links*

**Torwächter 2**
Das wird ihm bestimmt nicht schwerfallen.

*zu Dorothy*

**Torwächter 2**
Und was möchtest du?

**Dorothy**
Ich möchte zurück nach Kansas zu meiner Tante und meinem Onkel.

*Dorothy wechselt die Seite nach links*

*zu Toto*

**Torwächter 2**
Und was ist dein Wunsch?

**Dorothy**
Oh, Toto ist mein Glücksbringer, aber er kann sich nichts wünschen, er ist nur ein ausgestopftes Kuscheltier.

**Vogelscheuche**
Nur ausgestopft?!

*zu Toto*

**Vogelscheuche**
Mach dir nichts draus, Kumpel, sie meint es bestimmt nicht so.

**Torwächter 1**
Ich werde Oz von eurer Ankunft berichten, aber macht euch keine große Hoffnung, dass er euch empfangen wird.

*geht ab*

```yaml
mic:
    - Torwächter 2
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
trigger_note: {ch: 1, note: 46}
```

**Dorothy**
Warum sollen wir uns keine große Hoffnung machen?

**Torwächter 2**
Nun, es ist so, Oz lässt für gewöhnlich niemanden in seine Nähe. Ich arbeite bereits seit vielen Jahren für ihn und habe ihn noch nie zu Gesicht bekommen und ich kenne auch niemanden, der ihn jemals gesehen hat.

**Vogelscheuche**
Geht er denn nicht nach draußen?

**Torwächter 2**
Niemals. Er sitzt Tag für Tag im großen Thronsaal seines Palastes.

**Dorothy**
Also weiß niemand, wie Oz aussieht?

**Torwächter 2**
Nun, da Oz ein großartiger Zauberer ist, kann er jede Form annehmen, die ihm beliebt. Daher sagen manche, er sähe aus wie ein Vogel, andere behaupten, er sei ein Elefant und wieder anderen ist er als Katze erschienen. Aber wie der echte Oz aussieht, weiß niemand.

**Vogelscheuche**
Das ist aber seltsam. Ich kann es jedenfalls kaum erwarten, den großen Oz endlich zu sehen. Ich warte schließlich schon einen großen Teil meines Lebens darauf.

**Dorothy**
Aber du wusstest doch noch gar nicht von ihm, bevor wir uns begegnet sind und ich dir von ihm erzählt habe.

**Vogelscheuche**
Ja, das stimmt. Aber ich wurde erst vor drei Tagen gebaut. Daher nimmt alles, seit meiner Bergung mit dir, einen großen Teil meines Lebens ein.

**Blechmann**
Na, das ist erstaunlich. Als ich drei Tage alt war, konnte ich nicht mal sprechen.

**Vogelscheuche**
Na sag mal, mein Freund, ich bin ja auch nicht von gestern. Der andere Torwächter kommt zurück.

**Löwe**
Und? Haben Sie Oz gesagt, dass wir ihn treffen wollen?

```yaml
mic:
    - Torwächter 1
    - Torwächter 2
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
trigger_note: {ch: 1, note: 47}
```

**Torwächter 1**
Ich habe Oz über eure Ankunft informiert und er wird euch empfangen.

**Torwächter 2**
Seltsam, normalerweise mag er es doch nicht, wenn Leute ihn zu sehen verlangen.

**Torwächter 1**
Oh, tatsächlich war er zunächst sehr verärgert und sagte, ich solle euch wegschicken. Doch dann fragte er mich nach eurem Aussehen. Deine silbernen Schuhe schienen ihn sehr zu interessieren und als ich den Abdruck auf deiner Stirn erwähnte, entschied er, euch eine Audienz zu gewähren.

**Löwe**
Das ist ja wunderbar. Dann lasst uns keine Zeit verlieren.

*Die Freunde versuchen, durch das Tor in die Smaragtstadt zu gehen*

**Torwächter 1**
Halt, bevor ihr die Stadt betreten dürft, müsst ihr diese Brillen aufsetzen.

**Dorothy**
Warum?

*Die Torwächter geben den Freunden Brillen, die Freunde setzten diese selbstständig auf, die Torwächter schließen sie ab*

**Torwächter 1**
Weil euch sonst der Glanz der Smaragdstadt erblinden lassen würde. Alle Bewohner der Stadt müssen Tag und Nacht eine Brille tragen, so hat es Oz befohlen, als die Stadt erbaut wurde.

**Torwächter 2**
Die Brillen werden am Kopf abgeschlossen und wir haben den einzigen Schlüssel, der sie wieder öffnen kann.

*Die Freunde laufen durch das Tor in die Smaragtstadt*

*zum Publikum*

**Torwächter 1**
Dasselbe gilt natürlich auch für euch! Setzt jetzt alle eure Brillen auf!

```yaml
mic: muteall
qlcplus: Umbau
projection: black-4
music: oz-umbau.mp3
trigger_note: {ch: 1, note: 48}
```

```yaml
projection: Umbau Palast 1
trigger_note: {ch: 1, note: 49}
```

## Der Palast von Oz

```yaml
qlcplus: Zauberer 1
music:
    file: oz-palast-dieter.mp3
    adjust:
        trigger_note: {ch: 1, note: 48}
        fadeout: true
projection: Palast 1
note: Dieter
trigger_note: {ch: 1, note: 50}
```

```yaml
qlcplus: Zauberer 1
music:
    file: oz-palast-meusi.mp3
    adjust:
        trigger_note: {ch: 1, note: 48}
        fadeout: true
projection: Palast 1
note: Meusi
trigger_note: {ch: 1, note: 51}
```

*Im Palast von Oz. Die vier Freunde jeweils wenn sie ihren Wunsch singen auf und treten danach wieder ab. In der Mitte steht ein riesiger Kopf, auf den Oz in verschiedenen Gestalten projiziert wird. Bei jedem Wunsch wechselt er die Gestalt.*

## Lied 5: Der große Oz

**Zauberer**
Ich bin der große Oz.<br>
Was wollt ihr in meinem Schloss?<br>
Niemand ist mächtig wie ich,<br>
verneigt euch darum für mich!<br>
Warum stört ihr meine Ruh'?<br>
Woher hat das Mädchen diese Schuh'?<br>
Wer mich ohne Grund besucht,<br>
wird durch meine Zauberkraft verflucht!

```yaml
mic: Dorothy
trigger_note: {ch: 1, note: 52}
```

**Dorothy**
Ich bin Dorothy, die kleine,<br>
kam aus Kansas ganz alleine.<br>
Ein Wirbelsturm, der trug mich fort<br>
an diesen schönen Ort.<br>
Mein Haus machte die Hexe platt,<br>
die Schuhe trugen mich zur Stadt.<br>
Schön ist es in diesem Land,<br>
doch ich will zurück zu Onkel und Tante!

```yaml
mic: Vogelscheuche
trigger_note: {ch: 1, note: 53}
```

**Zauberer**
Ich kann deinen Wonsch versteh'n,<br>
doch ohne Bezahlung wird das nicht geh'n.<br>
Es wird sich für dich lohnen,<br>
die Hexe zu entthronen.

**Vogelscheuche**
Die Vögel kann ich scheuchen<br>
mit Hampeln und Geräuschen.<br>
Doch sonst hänge ich faul rum,<br>
da bleibt man wohl bei dumm.<br>
Kannst du mir Scharfsinn geben,<br>
hätt' ich ein bess'res Leben.<br>
Ich wünsch' mir ein Gehirn,<br>
dann hätt ich...<br>
Dann hätt ich ein Gehirn!

```yaml
mic: Blechmann
trigger_note: {ch: 1, note: 54}
```

**Zauberer**
Ich kann deinen Wunsch versteh'n,<br>
doch ohne Bezahlung wird das nicht geh'n.<br>
Lässt du die Hexe verschwinden,<br>
wirst du die Weisheit finden.

**Blechmann**
Ich bin ein Blechmann ohne Herz.<br>
Mein Leben ist voller Schmerz.<br>
Ich schwitze nicht, ich schweiße,<br>
begleite Dorothy auf der Reise.<br>
Zwar hilft Öl dem Getriebe,<br>
doch ohne Herz keine Liebe.<br>
Erfülle mich mit Glück<br>
und gib mir mein Herz zurück!

```yaml
mic: Löwe
trigger_note: {ch: 1, note: 55}
```

**Zauberer**
Ich kann deinen Wunsch versteh'n,<br>
doch ohne Bezahlung wird das nicht geh'n.<br>
Schon bald wirst du lieben,<br>
musst nur die Hexe besiegen.

**Löwe**
Ich bin ein starker Löwe.
Doch wenn ich ein Knacken höre,
bin ich vor Angst gelähmt,
statt wilder Bestie gezähmt.
Drum wünsche ich mir Mut.
Ganz viel davon wär' gut.
Du musst mir jetzt Mut geben,
sonst kannst du was erleben!

```yaml
mic: muteall
trigger_note: {ch: 1, note: 56}
```

**Zauberer**
Ich kann deinen Wunsch versteh'n,<br>
doch ohne Bezahlung wird das nicht geh'n.<br>
Es wird sich für dich rentieren,<br>
die Hexe zu eliminieren.

**Zauberer**
Ich kann eu're Wünsche versteh'n,<br>
doch ohne Bezahlung könnt ihr wieder geh'n!<br>
Solange die Hexe Macht hat,<br>
Kommt nicht zurück zur Smaragtstadt!

```yaml
qlcplus: Umbau
music: oz-umbau.mp3
projection: black-5
trigger_note: {ch: 1, note: 57}
```

```yaml
projection: Umbau Torwächter 2
trigger_note: {ch: 1, note: 58}
```

## Aufbruch gen Westen

```yaml
qlcplus: Torwächter
mic:
    - Torwächter 1
    - Torwächter 2
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
projection: Torwächter 2
music:
    adjust:
        trigger_note: {ch: 1, note: 48}
        fadeout: true
trigger_note: {ch: 1, note: 59}
```

*Die Torwächter stehen links und rechts neben dem Tor, die Freunde kommen aus dem Tor und geben die Brillen genervt zurück, stellen sich dann auf die linke Seite*

**Torwächter 2**
Da seid ihr ja wieder. Hat der große und mächtige Oz eure Bitten erfüllt?

**Dorothy**
Von wegen! Oz wird mich nur nach Hause bringen, wenn ich die böse Hexe besiege, und das werde ich niemals schaffen, es gibt keine Hoffnung für mich.

**Vogelscheuche**
Naja, immerhin hast du bereits die böse Hexe des Ostens platt gemacht.

**Dorothy**
Aber das war ein Unfall! Ich habe noch nie willentlich jemanden oder etwas getötet. Und selbst wenn ich wollte, wie könnte ich die böse Hexe besiegen, wenn sogar der große und schreckliche Oz es nicht kann?

**Torwächter 1**
Oz, hat schlechte Erfahrungen mit der bösen Hexe des Westens gemacht.

**Torwächter 2**
Oh ja, sehr schlechte Erfahrungen. Erinnerst du dich noch an diese verrückten Affen, die fliegen können? Sie haben Oz böse mitgespielt und ihn aus dem Land der Winkies vertrieben.

**Dorothy**
Was sind Winkies?

**Torwächter 1**
Das sind die Leute, die im Westen des Landes von Oz leben. Sie werden jetzt von der bösen Hexe regiert.

**Torwächter 2**
Sie ist die mächtigste der vier Hexen. Daher wagt es keiner sich mit anzulegen.

**Vogelscheuche**
Wenn wir die Hexe nicht besiegen können, bleibe ich wohl dumm. Ist vielleicht auch besser so. Vom Denken soll ja der Kopf rauchen und das ist bei einem Körper aus Stroh ohnehin viel zu gefährlich.

**Löwe**
Nichts da! Wir können doch jetzt nicht aufgeben, wo wir so weit gekommen sind. Wir müssen ins Land der Winkies reisen und die böse Hexe besiegen.

**Dorothy**
Aber was, wenn wir das nicht schaffen?

**Löwe**
Darüber denken wir nach, wenn es so weit ist.

*Dorothy beginnt zu weinen*

**Dorothy**
Aber dann würde ich Tante Em und Onkel Henry niemals wieder sehen.

*Der Blechmann kämpft mit den Tränen*

**Blechmann**
Bitte... Bitte nicht weinen...sonst muss ich auch weinen und dann beginne ich wieder zu rosten.

**Dorothy**
Wir haben wohl keine andere Wahl, als es zu versuchen. Aber ich bin mir nicht sicher, ob ich jemanden töten kann, selbst wenn es für Tante Em ist.

**Löwe**
Ich werde mit dir gehen. Aber ich bin viel zu feige, um gegen die Hexe zu kämpfen.

**Vogelscheuche**
Ich werde auch mitkommen. Aber ich werde euch keine große Hilfe sein, denn ich bin ein solcher Dummkopf.

**Blechmann**
Ich habe nicht das Herz dazu, selbst einer Hexe etwas anzutun. Aber wenn ihr geht, werde ich euch begleiten.

*Dorothy zum Wächter*

**Dorothy**
Welche Straße führt zur bösen Hexe des Westens?

**Torwächter 1**
Es gibt keine Straße, weil niemand jemals zur bösen Hexe gehen will.

**Dorothy**
Aber wie sollen wir sie dann finden?

**Torwächter 2**
Das wird leicht sein. Sie wird euch finden! Sobald ihr das Land der Winkies betreten habt, wird sie euch fangen und zu ihren Sklaven machen.

**Vogelscheuche**
Vielleicht nicht, denn wir wollen sie ja besiegen.

**Torwächter 1**
Oh, das ist natürlich etwas Anderes. Niemand hat sie je zuvor besiegt.

**Torwächter 2**
Aber seid vorsichtig. Sie ist böse und gnadenlos und wird es vielleicht nicht erlauben, dass ihr sie besiegt.

*Die Freunde gehen rechts ab*

**Torwächter 1**
Haltet euch gen Westen, wo die Sonne untergeht, dann könnt ihr sie nicht verfehlen. Ach, und viel Erfolg.

```yaml
mic:
    - Torwächter 1
    - Torwächter 2
trigger_note: {ch: 1, note: 60}
```

*Torwächter sagen Pause an*

```yaml
mic: muteall
qlcplus: black
projection: black-6
trigger_note: {ch: 1, note: 61}
```

## Pause

```yaml
qlcplus: Erzähler Kansas
music:
    file: einlass.mp3
    volume: 0.3
    loop: true
trigger_note: {ch: 1, note: 62}
```

```yaml
music: gong.mp3
trigger_note: {ch: 1, note: 63}
```

```yaml
music: gong.mp3
trigger_note: {ch: 1, note: 64}
```

```yaml
music: gong.mp3
trigger_note: {ch: 1, note: 65}
```

```yaml
qlcplus: black
music:
    adjust:
        file: einlass.mp3
        fadeout: true
trigger_note: {ch: 1, note: 66}
```

```yaml
projection: Umbau Hexe
trigger_note: {ch: 1, note: 67}
```

## Die böse Hexe des Westens

```yaml
note: AUFNAHME STARTEN!!!
trigger_note: {ch: 1, note: 68}
```

*Die Hexe geht auf und ab und singt ihr Lied*

## Lied 6: Hexe des Westens

```yaml
mic:
    - Hexe des Westens
    - Winkie
music: oz-hexe.mp3
qlcplus: Hexe Song
trigger_note: {ch: 1, note: 69}
```

**Hexe des Westens**
Ich bin böse, ich bin böse,<br>
böse sein ist toll!<br>
Ich bin böse, ich bin böse,<br>
ich mach' aus dir 'nen Troll.

**Hexe des Westens**
Denn Trolle, die sind niedlich,<br>
so winzig klein und grün.<br>
Und wenn du sagst: "Ich will nicht",<br>
dann bringst du mich zum glüh'n.

**Hexe des Westens**
Dann werde ich ganz böse<br>
und tobe voller Wut.<br>
Dann kommst du in die Fritöse.<br>
Na hoffentlich schmeckst du gut!

**Hexe des Westens**
Ich bin böse, ich bin böse,<br>
das ist allen klar.<br>
Böse, böse, böse!<br>
Hahahahaha!

*Hexe bleibt auf der Linken Bühnenseite stehen und schaut ins Fenster*

```yaml
qlcplus: Hexe Schattenspiel
projection: Schattenspiel 0
trigger_note: {ch: 1, note: 70}
```

**Hexe des Westens**
Eindringlinge. Winkie.

```yaml
mic:
    - Hexe des Westens
    - Winkie
qlcplus: Hexe und Winkie
trigger_note: {ch: 1, note: 71}
```

*Winkie tritt von rechts auf, bleibt auf der rechten Bühnenseite stehen und verneigt sich*

**Hexe des Westens**
Es befinden sich Eindringlinge in meinem Land. Schick die Krähen zu ihnen. Sie sollen sie auseinanderrupfen.

*Der Winkie eilt davon*

```yaml
qlcplus: Hexe Schattenspiel
projection: Schattenspiel 1
music: 09_ShadowPlay_Part1_Audio_1218.mov
mic: Hexe des Westens
trigger_note: {ch: 1, note: 72}
```

**Blechmann**
Da kommt ein Schwarm Vögel auf uns zu.

**Löwe**
Es sieht so aus, als wollten die uns angreifen.

**Vogelscheuche**
Euer Glück, dass ihr eine Vogelscheuche dabeihabt. Lasst mich nur machen.

```yaml
mic:
    - Hexe des Westens
    - Winkie
qlcplus: Hexe und Winkie
trigger_note: {ch: 1, note: 73}
```

**Hexe des Westens**
Diese dummen Vögel, lassen sich von einer einfachen Vogelscheuche verscheuchen. Winkie!

*Der Winkie tritt wieder auf und verneigt sich vor der Hexe*

**Hexe des Westens**
Schick die schwarzen Bienen los. Sie sollen die Eindringe solange stechen, bis sie wieder umkehren.

```yaml
qlcplus: Hexe Schattenspiel
projection: Schattenspiel 2
music: 09_ShadowPlay_Part2_Audio_1218.mov
mic: Hexe des Westens
trigger_note: {ch: 1, note: 74}
```

*Der Winkie eilt wieder davon*

**Vogelscheuche**
Das sind Bienen. Blechmann, nimm mein Stroh und wirf es über Dorothy und den Löwen. Dir können die Bienen nichts anhaben.

**Blechmann**
Ihr könnt wieder aufstehen und mir helfen, das Stroh zurück in die Vogelscheuche zu stopfen. Das war eine gute Idee von dir, Vogelscheuche. Weil Dorothy und der Löwe unter deinem Stroh geschützt waren, haben die Bienen nur mich gestochen. Mir konnten die Stiche nichts anhaben, aber da Bienen nach ihrem Stich sterben, haben sie sich auf diese Weise selbst vernichtet.

```yaml
qlcplus: Hexe und Winkie
mic:
    - Hexe des Westens
    - Winkie
trigger_note: {ch: 1, note: 75}
```

*Der Winkie tritt wieder auf und verneigt sich vor der Hexe*

**Hexe des Westens**
Winkie! Nimm ein paar deiner Landsleute mit und kämpft selbst gegen die Eindringe.

*Der Winkie eilt davon*

```yaml
qlcplus: Hexe Schattenspiel
projection: Schattenspiel 3
music: 09_ShadowPlay_Part3_Audio_12182.mov
mic: Hexe des Westens
trigger_note: {ch: 1, note: 76}
```

**Dorothy**
Da kommt schon wieder etwas auf uns zu.

**Löwe**
Keine Sorge, das übernehme ich.

```yaml
qlcplus: Hexe und Winkie
mic:
    - Hexe des Westens
    - König der Affen
trigger_note: {ch: 1, note: 77}
```

**Hexe des Westens**
Mir bleibt wohl keine andere Wahl. Ich muss die geflügelten Affen um Hilfe bitten. Das wollte ich eigentlich vermeiden, schließlich kann ich ihre Dienste nur dreimal in Anspruch nehmen und zweimal habe ich es bereits getan. Wo habe ich doch gleich den goldenen Hut?

*Die Hexe holt den goldenen Hut vom Hutständer*

**Hexe des Westens**
Servi pennae apparent

*Die geflügelten Affen treten von rechts auf, bleiben auf der linken Bühnenseite*

*Der König der Affen verbeugt sich gezwungenermaßen vor der Hexe*

**König der Affen**
Du rufst uns zum dritten und letzten Mal. Wie lautet dein Befehl?

**Hexe des Westens**
Fliegt zu den Fremden, die in mein Land eingedrungen sind und zerstört sie. Mit Ausnahme des Löwen. Bringt die Bestie zu mir. Ich werde ihn dazu bringen, meine Kutsche zu ziehen.

**König der Affen**
Dein Befehl wird befolgt werden.

*Die Affen gehen gemächlich ab*

```yaml
qlcplus: Hexe Schattenspiel
projection: Schattenspiel 4
music: 09_ShadowPlay_Part4_Audio_1218.mov
mic: Hexe des Westens
trigger_note: {ch: 1, note: 78}
```

*Die Hexe tut den goldenen Hut zurück auf den Hutständer*

**König der Affen**
Ich wage es nicht, dem Mädchen etwas anzutun, denn sie wird von guten Mächten geschützt. Alles, was wir tun können, ist, sie zur bösen Hexe zu bringen.

## Im Palast der bösen Hexe

```yaml
mic:
    - König der Affen
    - Hexe des Westens
    - Dorothy
qlcplus: Hexe Thron
trigger_note: {ch: 1, note: 79}
```

*Das Fenster Fällt*

*Die Hexe setzt sich auf ihren Thron*

*Die Affen treten mit Dorothy von der rechten Seite auf und schubsen sie zur Hexe, Dorothy stolpert an der Hexe vorbei und kommt links von ihr zum Stehen*

**König der Affen**
Wir haben deinen Befehl so gut ausgeführt, wie wir konnten.

**Hexe des Westens**
Tatsächlich? Warum schleppt ihr mir dann dieses Kind an?

**König der Affen**
Wir haben den Blechmann und die Vogelscheuche zerstört und den Löwen eingefangen. Dem Mädchen wagen wir jedoch nichts anzutun, sie ist durch einen Kuss der Hexe des Nordens geschützt. Das war dein dritter und letzter Wunsch. Deine Macht über uns ist nun erloschen und du wirst uns nie wieder sehen.

*Die geflügelten Affen gehen ab*

*Die Hexe steht wütend auf*

*Im nachfolgenden Dialog geht die Hexe immer wieder auf Dorothy zu und nimmt wieder Abstand, weil sie sich vor Dorothys Mal auf der Stirn fürchtet, immer wenn sie auf Dorothy zugeht, weicht diese etwas zurück*

*Die Phrasen, die die Hexen zu sich selbst sagt, sagt sie ins Publikum*

```yaml
mic:
    - Hexe des Westens
    - Dorothy
trigger_note: {ch: 1, note: 80}
```

**Hexe des Westens**
Das hat man davon, wenn man sich auf eine Horde verrückter Affen verlässt.

**Hexe des Westens**
Was soll ich mit dem Mädchen anfangen? Sie trägt tatsächlich das Zeichen der guten Hexe auf der Stirn, daher wage ich es nicht, sie zu verhexen. Aber was ist denn das?

**Hexe des Westens**
Warum trägst du diese Schuhe?

**Dorothy**
Ich habe sie bei meiner Ankunft in Oz gefunden und ich brauchte Schuhe für den weiten Weg in die Smaragdstadt.

**Hexe des Westens**
Sie brauchte Schuhe, dummes Kind. Scheinbar hat sie keine Ahnung, welche
Macht diese Schuhe besitzen. Glück für mich.

**Hexe des Westens**
Ich werde dich zu meiner Sklavin machen! Du wirst für mich arbeiten. Na los, was stehst du noch herum? Mach dich nützlich! Schrubb den Fußboden, ich will, dass er glänzt, wenn ich wiederkomme.

```yaml
mic: Dorothy
trigger_note: {ch: 1, note: 81}
```

*Die Hexe klopft an den Turm hinter sich, darin öffnet sich ein Klappe, dahinter steht ein Winkie und streckt den Putzeimer entgegen*

*Dorothy ist etwas verwirrt, deshalb weist die Hexe sie mit Gesten an, den Eimer zu nehmen*

*Die Hexe zaubert einen Putzlappen hervor und wirft ihn Dorothy in den Eimer*

*Die Hexe des Westens geht nach rechts ab*

*Der Eimer ist voll mit verschiedensten Putzutensilien, Dorothy weiß nicht, was sie damit genau machen soll, deshalb nimmt sie einen Staubwedel aus dem Eimer und fängt etwas unbeholfen an, Gegenstände abzustauben, zuletzt den Hutständer*

**Dorothy**
Ein hübscher Hut ist das. Warum die böse Hexe ihn wohl weggeworfen hat? Nanu, da steht ja etwas drin.

```yaml
mic:
    - König der Affen
    - Dorothy
trigger_note: {ch: 1, note: 82}
```

*liest die Zauberformel vor*

**Dorothy**
Servi pennae apparent

*Die geflügelten Affen treten von rechts auf und bleiben auf der rechten Bühnenseite stehen, der König der Affen verbeugt sich vor Dorothy*

*Dorothy erschrickt und tut den Hut schnell wieder zurück auf den Hutständer*

**König der Affen**
Wie lautet dein Befehl?

**Dorothy**
Mein Befehl?

**König der Affen**
Na, du hast uns doch herbeigerufen.

**Dorothy**
Nein, ich habe nur den Spruch vorgelesen, der im Inneren des Hutes steht.

**König der Affen**
Und damit hast du uns herbeigerufen. Wer diesen Hut besitzt, kann die Dienste der geflügelten Affen dreimal in Anspruch nehmen. Dazu braucht man bloß die Zauberformel zu sprechen und wir Affen müssen dem Zauber des goldenen Hutes gehorchen, ob wir wollen oder nicht.

**Dorothy**
Was ist das für ein Zauber, der euch dazu zwingt zu gehorchen?

**König der Affen**
Genau genommen ist es die goldene Feder. Wer diese Feder berührt, wird von ihr verhext. Ich zupfte die Feder ihrem damaligen Besitzer vom Hut, um ihm einen Streich zu spielen. Ich wusste nichts von dem Zauber und hielt die Feder für einen lustigen Hutschmuck. Doch sobald ich die Feder berührte, brannte sie mir ihren Abdruck auf die Haut. Seit jenem Tag bin ich dazu verdammt ihrem Zauber zu gehorchen bis jemand anderes die Feder berührt.

**Dorothy**
Und ihr müsst allen Befehlen gehorchen? Dann könnte ich euch bitten, mich zurück nach Kansas zu bringen?

**König der Affen**
Das ist leider nicht möglich. Wir gehören in dieses Land und können es nicht verlassen. Es ist noch nie ein geflügelter Affe in Kansas gewesen und das wird auch so bleiben, weil wir dort nicht hingehören. Wir tun alles in unserer Macht Stehende, um dir zu dienen. Aber wir können die Wüste nicht überqueren.

**Dorothy**
Schade. Und wenn ich mir wünsche, dass ihr die böse Hexe für mich besiegt, würdet ihr das tun?

**König der Affen**
Nein, wir können nur Befehle befolgen, die wir auch tatsächlich erfüllen können. Wir Affen haben nicht die Macht, eine böse Hexe zu besiegen. Dazu bedarf es großer Zauberei.

**Dorothy**
Große Zauberei? Funktioniert dieser Zauber mit der Feder auch bei Hexen?

**König der Affen**
Vermutlich, es ist ein sehr alter und mächtiger Zauber.

**Dorothy**
Dann habe ich vielleicht eine Idee.

*Dorothy setzt sich selbstbewusst auf den Thron und zieht sich während des Sprechens ihre Schuhe aus*

**Dorothy**
Die Hexe schien sehr an meinen Schuhen interessiert zu sein. Sie gehörten einst der Hexe des Ostens und haben angeblich magische Kräfte. Ich weiß leider nicht, wie man sie benutzt. Aber ich kann die Schuhe als Köder verwenden und die Feder darin verstecken. Wenn die böse Hexe die Schuhe findet und anzieht, wird sie die Feder berühren und steht dann unter ihrem Zauber. Wenn mein Plan aufgeht, seid ihr bald wieder freie Affen.

*Der König der Affen nimmt den Hut vom Ständer und geht damit zu Dorothy*

**König der Affen**
Das klingt zu schön, um wahr zu sein.

*Der König der Affen nimmt die goldene Feder vom Hut und tut sie in die Schuhe, die Dorothy vor sich hält*

*Der König der Affen nimmt die Schuhe und gibt Dorothy dafür den Hut, Dorothy setzt sich diesen auf*

*Der König der Affen stellt die Schuhe an der rechten Bühnenkante auf ein kleines Podest*

*Die Affen verstecken sich auf der linken Bühnenseite*

*Die Hexe tritt von rechts auf, sieht Dorothy noch nicht*

```yaml
mic:
    - Dorothy
    - Hexe des Westens
trigger_note: {ch: 1, note: 83}
```

**Hexe des Westens**
Kind, wo steckst du? Habe ich dir nicht eine klare Arbeitsanweisung gegeben?

*entdeckt die Schuhe*

**Hexe des Westens**
Aber da sind ja die Schuhe meiner lieben Schwester. Jetzt gehören sie mir.

*zieht sich die Schuhe an*

**Dorothy**
Mein erster Befehl an dich lautet: Gib mir meine Schuhe zurück!

*Erst hier bemerkt die Hexe Dorothy*

**Hexe des Westens**
Ich denke ja gar nicht daran. Das sind Hexen Schuhe und du bist keine Hexe!

*zieht sich die Schuhe aus und überreicht sie Dorothy*

**Hexe des Westens**
Wie hast du das gemacht?

*Dorothy steht auf und geht an die linke Bühnenkante*

**Dorothy**
Vielleicht bin ich ja doch eine Hexe.

*Dorothy dreht die Schuhe um. Die goldene Feder fällt zu Boden, die Schuhe lässt sie nicht fallen, sondern stellt sie ab, sobald die Feder auf dem Boden liegt*

*Die Hexe des Westens schaut auf ihren Fuß entdeckt den Abdruck der goldenen Feder, geht wütend zur rechten Bühnenkante*

**Hexe des Westens**
Du hast mir eine Falle gestellt! Na warte, das wirst du noch bereuen!

**Dorothy**
Mein zweiter Befehl an dich lautet: Von heute an bist du eine gute Hexe. Du wirst niemandem mehr etwas zuleide tun und setzt deine Magie nur noch für gute Dinge ein.

*Dorothy und die Hexe laufen langsam aufeinander zu richtung Bühnenmitte*

**Hexe des Westens**
Ich denke ja gar nicht daran!

*Die beiden bleiben voreinander stehen, plötzlich wirkt der Zauber wirkt und die beiden schütteln sich höflich die Hände*

**Hexe des Westens**
Hallo meine Liebe, ich habe mich dir noch gar nicht richtig vorgestellt. Das war sehr unhöflich von mir. Ich bin die gute Hexe des Westens.

**Dorothy**
Und mein dritter und letzter Befehl für dich: Befreie meinen Freund den Löwen aus dem Käfig, in den du ihn hast sperren lassen.

**Hexe des Westens**
Aber selbstverständlich. Und weißt du was: Von heute an möchte ich nicht mehr über die Winkies herrschen! Ich werde sie auch befreien. Sie sollen von jetzt an meine Freunde sein.

*Der Winki schaut einmal lächelnd aus dem Turm heraus*

```yaml
mic:
    - Dorothy
    - König der Affen
trigger_note: {ch: 1, note: 84}
```

*Die Hexe des Westens geht rechts ab. Die geflügelten Affen treten von links auf*

*Der König der Affen verbeugt sich vor Dorothy*

*Dorothy setzt sich auf die linke Bühnenseite, um sich die Schuhe wieder anzuziehen*

**König der Affen**
Ich kann es kaum glauben. Aber dein Plan scheint wirklich funktioniert zu haben. Siehst du? Der Abdruck der goldenen Feder ist von meiner Haut verschwunden. Ich bin endlich wieder ein freier Affe.

*Dorothy nebenbei, während sie ihre Schuhe anzieht*

**Dorothy**
Ja, ich weiß. Die Hexe des Westens steht jetzt unter dem Zauber der Feder und von heute an ist sie eine gute Hexe.

**König der Affen**
Ich weiß gar nicht, wie ich dir danken soll! Aber eines kann ich dir versprechen: Wann immer du im Land von Oz Hilfe benötigst, kannst du dich auf die geflügelten Affen verlassen.

*Dorothy steht wieder auf*

**Dorothy**
Ich könnte tatsächlich eure Hilfe gebrauchen. Ihr könnt mich und meine Freunde zurück in die Smaragdstadt bringen.

**König der Affen**
Es wäre uns eine Ehre.

**Dorothy**
Aber dafür müssen wir sie zuerst wiederfinden.

**König der Affen**
Das wird für meine Affen kein Problem sein.

**König der Affen**
Los, sucht den Blechmann und die Vogelscheuche.

*Alle gehen nach rechts ab, die Affen laufen vor, der König der Affen folgt zusammen mit Dorothy*

```yaml
qlcplus: Umbau
projection: black-7
mic: muteall
music: oz-umbau.mp3
trigger_note: {ch: 1, note: 85}
```

```yaml
projection: Umbau Palast 2
trigger_note: {ch: 1, note: 86}
```

## Die magische Kunst des großen Schwindels

```yaml
qlcplus: Zauberer 2.1
mic:
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
projection: black-8
music:
    adjust:
        file: oz-umbau.mp3
        fadeout: true
trigger_note: {ch: 1, note: 87}
```

```yaml
music: 11_MagicalVoiceD_Part1_Audio.mov
note: Dieter
trigger_note: {ch: 1, note: 88}
```

```yaml
music: 11_MagicalVoiceM_Part1_Audio.mov
note: Meusi
trigger_note: {ch: 1, note: 89}
```

**Zauberer**
Tretet ein.

*Die Freunde treten von rechts auf und stellen sich in die Mitte der Bühne, Dorothy vorne, links dahinter die Vogelscheuche, rechts dahinter der Blechmann, mittig hinter allen der Löwe*

*Alle sprechen geradeaus ins Publikum*

```yaml
music: 11_MagicalVoiceD_Part2_Audio.mov
note: Dieter
trigger_note: {ch: 1, note: 90}
```

```yaml
music: 11_MagicalVoiceM_Part2_Audio.mov
note: Meusi
trigger_note: {ch: 1, note: 91}
```

**Zauberer**
Ich bin Oz, der große und schreckliche. Warum sucht ihr mich auf?

**Dorothy**
Wo bist du?

```yaml
music: 11_MagicalVoiceD_Part3_Audio.mov
note: Dieter
trigger_note: {ch: 1, note: 92}
```

```yaml
music: 11_MagicalVoiceM_Part3_Audio.mov
note: Meusi
trigger_note: {ch: 1, note: 93}
```

**Zauberer**
Ich bin überall. Aber für die Augen von Normalsterblichen bin ich unsichtbar.

**Löwe**
Wir sind gekommen, um unser Versprechen einzufordern.

```yaml
music: 11_MagicalVoiceD_Part4_Audio.mov
note: Dieter
trigger_note: {ch: 1, note: 94}
```

```yaml
music: 11_MagicalVoiceM_Part4_Audio.mov
note: Meusi
trigger_note: {ch: 1, note: 95}
```

**Zauberer**
Welches Versprechen?

*Die Vogelscheuche singt*

**Vogelscheuche**
"Ich kann deinen Wunsch verstehn, doch ohne Bezahlung wird das nicht gehn." Schon vergessen?

**Dorothy**
Du hast versprochen, mich nach Kansas zurückzubringen, wenn ich die böse Hexe besiege.

*Die Vogelscheuche stellt sich links neben Dorothy*

**Vogelscheuche**
Und du hast mir ein Gehirn versprochen

*Der Blechmann stellt sich rechts neben Dorothy*

**Blechmann**
...und mir ein Herz

*Der Löwe drängt sich zwischen Dorothy und den Blechmann*

**Löwe**
...und mir Mut.

```yaml
music: 11_MagicalVoiceD_Part5_Audio.mov
note: Dieter
trigger_note: {ch: 1, note: 96}
```

```yaml
music: 11_MagicalVoiceM_Part5_Audio.mov
note: Meusi
trigger_note: {ch: 1, note: 97}
```

**Zauberer**
Habt ihr die böse Hexe wirklich besiegt?

**Dorothy**
Ja, ich habe sie mithilfe der goldenen Feder in eine gute Hexe verwandelt. Sie wird von jetzt an nur noch gute Dinge tun.

```yaml
music: 11_MagicalVoiceD_Part6_Audio.mov
note: Dieter
trigger_note: {ch: 1, note: 98}
```

```yaml
music: 11_MagicalVoiceM_Part6_Audio.mov
note: Meusi
trigger_note: {ch: 1, note: 99}
```

**Zauberer**
Du meine Güte, so plötzlich. Nun, kommt morgen wieder. Ich brauche etwas Zeit, um darüber nachzudenken.

**Löwe**
Du hattest bereits jede Menge Zeit zum Nachdenken. Wir werden nicht länger warten.

**Dorothy**
Du musst dein Versprechen halten.

*Der Löwe brüllt*

*Der Blechmann haut vor Schreck gegen den seitlichen Turm*

```yaml
mic:
    - Zauberer
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
qlcplus: Zauberer 2.2
trigger_note: {ch: 1, note: 100}
```

*Der Turm öffnet sich und der Zauberer purzelt heraus*

*Der Blechmann bedroht den Zauberer mit seiner Axt*

**Blechmann**
Wer bist du?

**Zauberer**
Ich bin Oz, der große und schreckliche. Bitte schlag mich nicht. Ich tue alles, was ihr wollt.

**Löwe**
Ich dachte, Oz wäre ein großer sprechender Kopf.

**Zauberer**
Da liegst du falsch. Ich habe euch etwas vorgemacht.

**Dorothy**
Etwas vorgemacht? Bist du kein großer Zauberer?

*Zauberer nimmt Dorothy mit auf die linke Bühnenseite*

**Zauberer**
Ruhig meine Liebe, sprich nicht so laut, sonst wird man dich noch hören. Ich werde für einen großen Zauberer gehalten.

*Blechmann, Vogelscheuche und Löwe rücken etwas an Dorothy und den Zauberer heran um zu lauschen, halten aber Abstand*

**Dorothy**
Und bist du das nicht?

**Zauberer**
Leider nicht mal ein kleines bisschen. Ich bin ein ganz gewöhnlicher Mann.

**Vogelscheuche**
Du bist mehr als das, du bist ein Schwindler.

**Zauberer**
Genau das! Ich bin ein Schwindler.

*Der Blechmann richtet sich an die Vogelscheuche und den Löwen und kämpft mit den Tränen*

**Blechmann**
Aber das ist ja schrecklich. Wie soll ich denn jetzt mein Herz bekommen?

<!-- Reaktion von den anderen? -->

**Dorothy**
Weiß denn sonst niemand, dass du ein Schwindler bist?

**Zauberer**
Keiner weiß es, außer euch vier und mir selbst. Ich habe allen so lange etwas vorgemacht, dass ich dachte, niemand würde es jemals herausfinden. Es war ein großer Fehler von mir, euch in meinen Palast zu lassen.

**Dorothy**
Aber ich verstehe das nicht. Wie kommt es, dass du uns als großer Kopf erschienen bist?

**Zauberer**
Das war einer meiner Tricks. Warte, ich zeige es euch.

*geht zu einem Schaltpult und legt einen Hebel um*

*Vogelscheuche, Löwe und Blechmann rücken etwas nach rechts, um wieder zu lauschen, halten aber wieder Abstand*

*Lichtwechsel: Der projizierte Kopf erscheint und bewegt lautlos seinen Mund*

```yaml
qlcplus: Zauberer 2.1
projection: Palast 2
music: schalter.mp3
trigger_note: {ch: 1, note: 101}
```

**Dorothy**
Aber was ist mit der Stimme?

**Zauberer**
Ich bin Bauchredner. Ich kann den Klang meiner Stimme von überall herkommen lassen.

**Vogelscheuche**
Sie sollten sich wirklich dafür schämen, ein solcher Schwindler zu sein.

**Zauberer**
Das tue ich.

```yaml
qlcplus: Zauberer 2.2
projection: black-9
music: schalter.mp3
trigger_note: {ch: 1, note: 102}
```

*Der Zauberer schaltet den projizierten Kopf wieder aus*

*Dorothy geht zu ihren Freunden, die vier stehen in einer Reihe in der Mitte der Bühne*

**Zauberer**
Aber lasst mich euch erklären, wie es dazu gekommen ist: Ich wurde in Omaha geboren...

**Dorothy**
Hey, das ist nicht weit weg von Kansas!

*Der Zauberer bewegt sich beim Reden über die Bühne*

*Blechmann, Löwe und Vogelscheuche tuscheln etwas und tauschen sich zur Geschichte vom Zauberer aus*

**Zauberer**
Das stimmt, aber es ist sehr weit weg von hier. Jedenfalls erlernte ich, als ich älter war, bei einem großen Meister die Kunst des Bauchredens. Ich wurde sehr gut und kann jedes Tier und jede Bestie nachahmen.
Später wurde ich auch Ballonfahrer. Eines Tages, als ich mit meinem Ballon aufstieg, geriet ich in einen Luftstrom, der mich viele Kilometer weit fort trug. Als mein Ballon irgendwann endlich zu sinken begann, landete ich in diesem seltsamen und zugleich wunderschönen Land. Die Bewohner, die mich landen sahen, dachten, ich müsse ein großer Zauberer sein, weil ich aus dem Himmel kam. Ich ließ sie in dem Glauben, weil sie versprachen alles für mich zu tun. Ich befahl ihnen, diese Stadt und meinen Palast zu bauen und sie taten es mit großer Freude. Als die Stadt fertig war, beschloss ich sie "Die Smaragdstadt" zu nennen, und damit der Name besser passte, gab ich den Leuten grüne Brillen, damit alles, was sie sehen grün ist.

**Dorothy**
Aber ist denn nicht alles grün hier?

**Zauberer**
Nicht mehr als in jeder anderen Stadt. Die Menschen hier tragen die Brillen schon seit so langer Zeit, dass sie wirklich glauben, es sei eine Smaragdstadt.

*Alle setzen ihre Brillen ab*

*Die Vogelscheuche reicht die Handtasche heum, alle tun ihre Brillen hinein, schließlich behält Dorothy die Handtasche*

*Dorothy schaut sich etwas in der Gegend um und läuft auf die rechte Seite zum Zauberer*

**Dorothy**
Ich glaube, sie sind ein schlechter Mensch.

**Zauberer**
Oh nicht doch, meine Liebe. Ich bin eigentlich ein guter Mensch, nur eben ein ziemlich schlechter Zauberer, das muss ich zugeben.

**Vogelscheuche**
Also kannst du mir kein Gehirn schenken?

*Der Zauberer nimmt die Vogelscheuche mit auf die linke Bühnenseite*

**Zauberer**
Aber das brauchst du doch gar nicht! Du lernst doch auch so jeden Tag etwas Neues. Ein Baby hat ein Gehirn und es weiß trotzdem nichts. Erfahrung ist das Einzige, was Wissen bringt und je länger du lebst, desto mehr Erfahrung sammelst du.

**Vogelscheuche**
Das mag ja alles stimmen, aber ich werde so lange unglücklich sein, bis ich ein Gehirn bekomme.

**Zauberer**
Also gut. Zwar bin ich kein großer Zauberer, wie ich es behauptet habe, aber ich werde dir ein Gehirn geben. Ich kann dir allerdings nicht sagen, wie man es benutzt, das musst du selbst herausfinden.

*Die Vogelscheuche bleibt links stehen, der Zauberer geht zum Schrank, nimmt ein Bild eines Gehirns heraus und gibt dieses der Vogelscheuche*

**Zauberer**
Von nun an sollst du ein großartiger Mann sein, denn ich habe dir ein Gehirn gegeben.

*Die Vogelscheuche stolziert stolz an der Bühnenkante entlang und stellt sich dann links neben den Schrank*

**Dorothy**
Wie fühlst du dich?

**Vogelscheuche**
Ich fühle mich tatsächlich weise. Wenn ich mich an mein Gehirn gewöhnt habe, werde ich alles wissen.

**Löwe**
Und was ist mit meinem Mut?

*Der Zauberer nimmt den Blechmann mit auf die linke Bühnenseite*

**Zauberer**
Du bist sehr mutig, da bin ich mir sicher. Alles, was du brauchst, ist etwas Selbstvertrauen. Es gibt kein Lebewesen, das keine Angst hat, wenn es sich in Gefahren begibt. Wahrer Mut ist es, sich Gefahren zu stellen, obwohl man Angst hat. Und von dieser Art Mut besitzt du reichlich.

**Löwe**
Vielleicht tue ich das, aber ich fürchte mich noch immer. Ich werde so lange unglücklich sein, bis ich die Art Mut bekomme, die mich vergessen lässt, dass ich Angst habe.

**Zauberer**
Also gut, ich werde dir Mut geben.

*Der Löwe bleibt links stehen, der Zauberer geht zum Schrank, nimmt einen Krug heraus und gibt diesen dem Löwen*

**Zauberer**
Trink das.

**Löwe**
Was ist das?

**Zauberer**
Nun, wenn es in dir wäre, würde man es Mut nennen. Aber da Mut immer nur einem Körper innewohnen kann, ist es kein Mut, bevor du es getrunken hast.

*Der Löwe leert das Fläschchen in einem Zug, stolziert dann an der Bühnenkante entlang und stellt sich zur Vogelscheuche links neben den Schrank*

**Dorothy**
Wie fühlst du dich?

**Löwe**
Voller Mut!

**Blechmann**
Was ist mit meinem Herz?

*Der Zauberer nimmt den Blechmann mit zur linken Bühnenseite*

**Zauberer**
Nun, was das betrifft, ich denke du liegst falsch ein Herz zu wollen. Tatsächlich macht es die meisten Leute unglücklich. Wenn du wüsstest, wie sich das anfühlt, würdest du verstehen, dass du Glück hast, kein Herz zu haben.

**Blechmann**
Das ist wohl Ansichtssache. Ich werde liebend gern alles Unglück ertragen, wenn du mir ein Herz gibst.

**Zauberer**
Also gut.

*Der Blechmann bleibt links stehen, der Zauberer nimmt aus dem Schrank ein Herz und geht damit zum Blechmann*

**Zauberer**
Hier habe ich ein Herz für dich. Ist es nicht schön?

**Blechmann**
Das ist es. Aber ist es auch ein gütiges Herz?

**Zauberer**
Ja, sehr.

*steckt dem Blechmann das Herz in die Brust*

**Zauberer**
So, jetzt hast du ein Herz, auf das jeder Mann stolz wäre.

*Der Blechmann geht an der Bühnenkante entlang zu der Vogelscheuche und stellt sich vor den Schrank*

**Blechmann**
Vielen Dank, ich fühle mich tatsächlich wie ein besserer Mann.

*Zauberer zu sich selbst, lässt seinen Blick durch den Raum schweifen und bleibt mit dem Blick letztendlich bei Dorothy stehen*

**Zauberer**
Vielleicht bin ich am Ende doch kein so schlechter Zauberer.

*Dorothy tritt auf den Zauberer zu*

**Dorothy**
Dann kannst du mich vielleicht auch nach Kansas zurückbringen?

*Lichtwechsel zu Erzähler, alle Figuren außer Dorothy und Oz frieren ein*

```yaml
qlcplus: Zauberer 2.3
music:
    file: erzaehler.mp3
    volume: 0.5
    loop: true
trigger_note: {ch: 1, note: 103}
```

**Zauberer**
Ich fürchte das kann ich tatsächlich nicht. Weißt du, warum meine Zauber bei deinen Freunden funktioniert haben?

*Dorothy zuckt mit den Schultern*

**Zauberer**
Die Vogelscheuche, der Löwe und der Blechmann waren bereit zu glauben, ich könne Dinge tun, die eigentlich unmöglich sind. Ihre eigene Vorstellungskraft hat sie glauben lassen, ich könne ihnen Eigenschaften verleihen, die sie in Wirklichkeit schon längst besaßen. Ihr Glaube an mich hat ihnen den Glauben an sich selbst geschenkt.

**Dorothy**
So wie mit meinem Toto. Weil ich daran glaube, dass er mir Glück bringt, fühle ich mich stark und weiß, dass ich alles schaffen kann, wenn er bei mir ist.

**Zauberer**
Ganz genau. Aber um dich nach Kansas zurückzubringen, bedarf es mehr als bloßer Fantasie. Dazu braucht man echte magische Kräfte. Die ich nicht habe.

*hält einen Moment ratlose inne*

**Zauberer**
Es gibt allerdings eine Hexe im Land von Oz, die du noch nicht kennengelernt hast. Sie heißt Glinda und ist die Hexe des Südens. Soweit ich weiß, ist sie eine echte Hexe. Vielleicht könnte sie dir helfen. Es ist jedoch eine weite und gefährliche Reise.

**Dorothy**
Das ist kein Problem. Meine Freunde, die geflügelten Affen, können mich problemlos an jeden Ort innerhalb von Oz bringen.

*Lichtwechsel. Löwe, Blechmann und Vogelscheuche tauen wieder auf*

```yaml
qlcplus: Zauberer 2.2
music:
    adjust:
        file: erzaehler.mp3
        fadeout: true
trigger_note: {ch: 1, note: 104}
```

*Die Vogelscheuche stellt sich in die Bühnenmitte*

**Vogelscheuche**
Nur dich?

*Der Löwe stellt sich zur Vogelscheuche*

**Löwe**
Wir werden dich selbstverständlich begleiten.

*Dorothy stellt sich zu Voglesheuche und Löwe*

**Dorothy**
Wollt ihr wirklich?

*Blechmann stellt sich zu Vogelscheuche, Löwe und Blechmann*

**Blechmann**
Natürlich, wir sind doch Freunde.

*Zauberer geht zurück in den Turm und schließt die Tür*

*Licht aus*

**Zauberer**
Dann wünsche ich euch eine gute Reise. Ich hoffe wirklich, die gute Hexe des Südens kann dich nach Hause bringen.

```yaml
qlcplus: Umbau
mic: muteall
music: oz-umbau.mp3
trigger_note: {ch: 1, note: 105}
```

```yaml
projection: Umbau Glinda
trigger_note: {ch: 1, note: 106}
```

## Glinda, die gute Hexe des Südens

```yaml
qlcplus: Glinda
mic:
    - Dorothy
    - Vogelscheuche
    - Blechmann
    - Löwe
    - Hexe des Südens
projection: Glinda
music:
    adjust:
        file: oz-umbau.mp3
        fadeout: true
trigger_note: {ch: 1, note: 107}
```

*Die Hexe sitzt in ihrem Thron*

*Die Vogelscheuche tritt von rechts auf, die Freunde folgen ihr*

*Der Blechmann bleibt rechts stehen*

**Vogelscheuche**
Hallo, bist du die Hexe des Südens?

**Hexe des Südens**
Aber natürlich. Kann ich dir helfen?

*Die Vogelscheuche stolziert an der Hexe vorbei und lehnt sich an die linke Bühnenkante*

**Vogelscheuche**
Mir nicht. Ich habe mein Gehirn schon von dem großen Zauberer von Oz bekommen.

**Hexe des Südens**
Vom Zauberer? Sehr interessant...

*Der Löwe schiebt Dorothy richtung Bühnenmitte und stellt sich dann an die rechte Bühnenkante*

**Löwe**
Dorothy braucht deine Hilfe. Sie wurde mit einem Wirbelsturm von Kansas hierher geweht.

*Die Hexe steuert Dorothy mit ihrem Zauberstab zu sich*

*Dorothy bewegt sich etwas steif wie unter einem Zauber stehend zur Hexe*

**Hexe des Südens**
Bist du Dorothy?

**Dorothy**
Ja, das bin ich. Bist du eine echte Hexe?

**Hexe des Südens**
Ja, das bin ich. Außerdem bin ich eine gute Hexe.

**Vogelscheuche**
Na, das ist doch klar. Es gibt ja in Oz nur noch gute Hexen.

**Hexe des Südens**
Nur gute Hexen. Im Gegenteil. Es gibt nur zwei gute Hexen: Eine im Süden, das bin ich.

*Die Hexe steuert Dorothy mit ihrem Zauberstab an die mittlere Bühnenkante*

*Dorothy bewegt sich etwas steif wie unter einem Zauber stehend nach vorne, sie bliebt dort steif stehen*

**Hexe des Südens**
Und eine im Norden meine Schwester.

*Die Hexe steuert die Vogelscheuche mit ihrem Zauberstab zur linken Schachfigur*

*Die Vogelscheuche bewegt sich etwas steif wie unter einem Zauber stehend zur linken Schachfigur, sie bleibt dort steif stehen*

**Hexe des Südens**
Aber im Osten

*Die Hexe steuert den Löwen mit ihrem Zauberstab zur rechten Schachfigur*

*Die Löwe bewegt sich etwas steif wie unter einem Zauber stehend zur rechten Schachfigur, er bleibt dort steif stehen*

**Hexe des Südens**
und im Westen leben zwei böse Hexen.

*Die Hexe lässt ihren Zauberstab sinken, dadurch löst sich der Zauber und Dorothy, Löwe und Vogelscheuche sacken etwas zusammen, wie wenn der Zauber plötzlich von ihnen abfällt*

**Löwe**
Nicht mehr. Als Dorothy hierher geweht wurde, ist ihr Haus versehentlich auf der bösen Hexe des Ostens gelandet.

*Der Löwe stupst die rechte Schachfigur an, diese kippt um*

```yaml
projection: Glinda Schach 1
trigger_note: {ch: 1, note: 108}
```

*Die Vogelscheuche lehnt sich an der linken Schachfigur an*

**Vogelscheuche**
Und die böse Hexe des Westens hat Dorothy in eine gute Hexe verwandelt.

*Die Schachfigur hinter der Vogelscheuche kippt um*

```yaml
projection: Glinda Schach 2
trigger_note: {ch: 1, note: 109}
```

*Die Hexe steht auf und schwingt ihren Zauberstab einmal im Kreis, daraufhin frieren die anderen Rollen (außer Dorothy) wieder ein, teilweise in witzigen Posen*

*Die Hexe geht zu Dorothy*

**Hexe des Südens**
Du scheinst ja ein mächtiges kleines Mädchen zu sein. Wie ich sehe, trägst du sogar die Schuhe der bösen Hexe des Ostens. Wieso brauchst du dann meine Hilfe?

**Dorothy**
Ich möchte dich bitten, mich nach Kansas zurückzubringen.

**Hexe des Südens**
Gefällt es dir etwa nicht bei uns? Es ist doch so schön hier, vor allem jetzt, wo sich keiner mehr vor den bösen Hexen fürchten muss.

**Dorothy**
Doch schon, es gefällt mir hier sehr gut und ich habe ja sogar drei tolle Freunde gefunden. Aber ich vermisse meinen Onkel und meine Tante. Bei ihnen fühle ich mich zu Hause.

**Hexe des Südens**
Ich glaube ich weiß, wie du zurück nach Kansas kommen kannst.

**Dorothy**
Wirklich?

*Die Hexe zeigt mit ihrem Zauberstab auf die Schuhe, dadurch durchbricht der Zauber und die anderen Rollen tauen wieder auf*

**Hexe des Südens**
Die silbernen Schuhe werden dich über die Wüste tragen.

**Vogelscheuche**
Das ist ja witzig. Wenn du das gleich gewusst hättest, hättest du dir diesen riesigen Umweg sparen können.

**Dorothy**
Aber dann hätte ich euch niemals kennengelernt. Und dieses Land würde immer noch in Furcht vor der bösen Hexe leben. Und was wäre dann bloß aus dir geworden.

**Vogelscheuche**
Ach ich... Ich würde dann noch faul am Feld rumbaumeln und den lieben langen Tag vor mich hin grübeln. Ahhh... wie konnte ich das vergessen. Ich hätte ja gar nicht grübeln können. Nur durch deine Hilfe hat mir der Zauberer von Oz ein Gehirn gegeben. Oh, Danke, Dorothy.

**Blechmann**
Und ich hätte nie mein geliebtes Herz wiederbekommen. Ich wäre vielleicht bis in alle Ewigkeit in diesem Wald vor mich hin gerostet.

**Löwe**
Und ich wäre für immer ein Feigling geblieben.

**Dorothy**
Ich bin froh, dass ich euch, meinen Freunden, helfen konnte. Aber jetzt, da ihr alle habt, was ihr euch gewünscht habt, würde ich gerne nach Kansas zurückkehren.

*Die Hexe schwingt wieder ihren Zauberstab, die anderen Rollen frieren wieder ein*

**Hexe des Südens**
Und was werdet ihr tun, wenn Dorothy zurück in Kansas ist?

*Die Hexe geht zum Löwen, dieser taut auf*

**Löwe**
Jetzt, wo ich mutig bin, möchte ich zurück in den Wald gehen und ein Leben wie ein richtiger Löwe leben.

*Der Löwe friert wieder ein*

*Die Hexe geht zum Blechmann, dieser taut auf*

**Blechmann**
Ich möchte zu dem Mädchen zurückkehren, das ich einst heiraten wollte. Nun, da ich wieder ein Herz habe und die bösen Hexen Tod sind, gibt es nichts mehr, das unserer Liebe im Wege stehen könnte.

*Der Blechmann friert wieder ein*

*Die Hexe geht zur Vogelscheuche, diese taut auf*

**Vogelscheuche**
Ich möchte zurück in die Smaragdstadt gehen und dort Erfinder werden. Mein Kopf ist voll mit guten Ideen. Die müssen endlich raus. Euch brauche ich damit ja nicht zu langweilen, ihr würdet sie sowieso nicht verstehen. Nichts für ungut.

*Die Hexe ist etwas verdutzt, lässt den Zauberstab dabei sinken, daraufhin tauen alle wieder auf*

**Hexe des Südens**
Ihr habt alle große Träume und ich glaube, dass ihr eure Träume erreichen könnt, wenn ihr nur selbst an euch glaubt.

**Dorothy**
Da bin ich mir ganz sicher. Ihr habt alle so viel Mut, Verstand und Nächstenliebe bewiesen.

**Hexe des Südens**
Die silbernen Schuhe haben magische Kräfte. Eine ihrer besten Eigenschaften ist es, dass sie dich in nur drei Schritten an jeden Ort der Welt bringen können. Du musst nur die Fersen dreimal zusammenschlagen und sagen, wohin dich die Schuhe bringen sollen.

*Die Hexe setzt sich wieder auf den Thron*

**Dorothy**
Wenn das so ist, dann werde ich sie bitten mich nach Kansas zu bringen.

*Der Blechmann kämpft mit den Tränen*

**Blechmann**
Dann ist es jetzt wohl Zeit, Abschied zu nehmen. Aber bitte lasst uns schnell machen, sonst roste ich ein, bevor Dorothy weg ist.

*Die Freunde kommen in der Mitte zusammen und machen eine Gruppenumarmung*

**Dorothy**
Vielleicht werde ich ja mal wieder von einem Wirbelsturm hierher geweht.

**Vogelscheuche**
Na, du bist mir ja eine Witzige...

*Die Vogelscheuche beendet die Umarmung und weicht zur Seite, Blechmann und Löwe weichen daraufhin auch zur Seite*

*Dorothy geht etwas nach hinten*

**Dorothy**
Vielen Dank, gute Hexe.

*Dorothy schlägt die Fersen dreimal zusammen*

**Dorothy**
Na los, liebe Schuhe. bringt mich zurück nach Hause zu Tante Em und Onkel Henry!

```yaml
qlcplus: Umbau
music: oz-umbau.mp3
projection: black-10
mic: muteall
trigger_note: {ch: 1, note: 110}
```

```yaml
projection: Umbau Ballon
trigger_note: {ch: 1, note: 111}
```

## Zurück in Kansas

```yaml
projection: black-11
qlcplus: Kansas
mic:
    - Dorothy
    - Tante Em
    - Onkel Henry
music:
    adjust:
        file: oz-umbau.mp3
        fadeout: true
trigger_note: {ch: 1, note: 112}
```

*Dorothy hat unterwegs ihre Schuhe verloren*

**Dorothy**
Tante Em, Onkel Henry? Ich bin wieder da.
Die Tür des Hauses öffnet sich und Tante Em und Onkel Henry kommen heraus.

*Tante Em und Onkel Henry kommen aus dem halben Haus*

**Tante Em**
Dorothy? Wo um alles in der Welt kommst du plötzlich her?

**Dorothy**
Aus dem Land von Oz. Oh Tante Em, ich bin so froh wieder zuhause zu

**Onkel Henry**
Land von Oz? Davon habe ich ja noch nie gehört!

*Lichtwechsel, der Erzähler tritt auf, währenddessen begrüßt Dorothy stumm Tante und Onkel, danach gehen alle drei ins Haus*

```yaml
qlcplus: black
music:
    file: erzaehler.mp3
    volume: 0.5
    loop: true
mic: Erzähler
trigger_note: {ch: 1, note: 113}
```

**Erzähler**
Und an dieser Stelle endet meine Geschichte. Fast jedenfalls.

*wirft einen Blick auf seine Uhr*

**Erzähler**
Ich muss zugeben, ich war in meinen Erzählungen mal wieder etwas zu ausführlich. Die Zeit meiner Zaubervorstellung ist fast vorbei und ich habe noch gar nicht wirklich gezaubert. Und dabei habe ich euch noch gar nicht erzählt, wie ich nach Kansas gekommen bin. Was im Übrigen auch eine sehr spannende Geschichte ist. Es kommt sogar ein Heißluftballon darin vor. Aber keine Sorge, diesmal fasse ich mich kurz. Es sind inzwischen ein paar Wochen vergangen, seitdem Dorothy aus dem Land von Oz zurückgekehrt ist. Sie ist froh, wieder zuhause bei ihrer Familie zu sein. Aber manchmal, wenn ihr der graue Alltag in Kansas zu langweilig wird, denkt sie zurück an die Abenteuer, die sie in Oz erlebt hat und fragt sich, was wohl aus ihren Freunden geworden ist. Bis eines Tages etwas Unerwartetes geschieht.

```yaml
projection: Ballon Meusi
note: Meusi
trigger_note: {ch: 1, note: 114}
```

```yaml
projection: Ballon Dieter
note: Dieter
trigger_note: {ch: 1, note: 115}
```

*Lichtwechsel, der Erzähler schiebt den Heißluftballon auf die Bühne, bleibt daneben stehen und schaut dabei zu, wie der Heißluftballon landet*

*Wenn der Heißluftballon gelandet ist, öffnet der Erzähler die obere Klappe und steigt ein*

```yaml
qlcplus: Kansas 2
mic:
    - Zauberer
    - Dorothy
music:
    adjust:
        file: erzaehler.mp3
        fadeout: true
trigger_note: {ch: 1, note: 116}
```

**Zauberer**
Dorothy, Dorothy, bist du es?

**Dorothy**
Was... Ist das wirklich...?

**Zauberer**
Der Zauberer von Oz, ganz recht!

**Dorothy**
Aber wie...?

**Zauberer**
Nun lass mich doch erst einmal landen

*Der Zauberer steigt aus dem Heißluftballon aus*

**Zauberer**
Da staunst du, was? Die Vogelscheuche hat mir diesen Heißluftballon gebaut.

**Dorothy**
Die Vogelscheuche? Dann ist sie tatsächlich Erfinder geworden.

**Zauberer**
Und ein sehr erfolgreicher noch dazu. Ganz Oz liebt seine Erfindungen.

**Dorothy**
Und der Blechmann? Ist er zu seiner Geliebten zurückgegangen?

**Zauberer**
Na was glaubst du? Sie hat sich so sehr gefreut, dass er zurückgekommen ist. Und die beiden haben sich auf der Stelle verlobt. Schon bald findet eine große Hochzeit statt.

**Dorothy**
Und was ist aus dem Löwen geworden?

**Zauberer**
Der Löwe ist, wie er es vorgehabt hatte, zurück in den Wald gegangen. Dort hat er heldenhaft die kleineren Tiere beschützt, so dass die Tiere des Waldes ihn zum König gemacht haben.

**Dorothy**
Und was machst du hier?

**Zauberer**
Wo ich jetzt diesen tollen Heißluftballon habe, wollte ich mir mal dieses Kansas anschauen, in das du immer zurückwolltest. So wie du davon geschwärmt hattest, muss es ja ganz wunderbar sein. Aber wenn ich mich hier so umsehe, hatte ich eigentlich etwas ganz anderes erwartet. Hier ist doch alles grau in grau.

**Dorothy**
Aber darauf kommt es doch gar nicht an.

*Tante Em und Onkel Henry treten auf*

## Lied 7: Kansas Reprise

```yaml
mic:
    - Dorothy
    - Tante Em
    - Onkel Henry
qlcplus: Kansas
music: oz-kansas-reprise.mp3
note: Anette
trigger_note: {ch: 1, note: 117}
```

```yaml
mic:
    - Dorothy
    - Onkel Henry
qlcplus: Kansas
music: oz-kansas-reprise-elke.mp3
note: Elke
trigger_note: {ch: 1, note: 118}
```

**Dorothy**
Kansas ist staubig,<br>
Kansas ist grau.

**Tante Em**
In der Prärie von Amerika<br>
ist die Landschafrt sehr rau.

**Onkel Henry**
Der Boden ist rissig,<br>
von der Sonne gebrannt.

**Onkel Henry** **Tante Em** **Dorothy**
So ist's in der Steppe,<br>
in unserem Land.

**Onkel Henry** **Tante Em** **Dorothy**
Hier sind wir zu Hause,<br>
hier woll'n wir nicht fort.<br>
Hier sind unsere Freunde,<br>
das macht's zum guten Ort.<br>
Anderswo mag's schick sein,<br>
anderswo liegt fern.<br>
Anderswo gibt's uns nicht,<br>
in Kansas sind wir gern.

```yaml
mic:
    - Erzähler
    - Zauberer
    - Onkel Henry
    - Tante Em
    - Dorothy
    - Munchkin 1
    - Munchkin 2
    - Hexe des Nordens
    - Vogelscheuche
    - Blechmann
    - Löwe
    - Torwächter 1
    - Torwächter 2
    - Hexe des Westens
    - Winkie
    - König der Affen
    - Hexe des Südens
trigger_note: {ch: 1, note: 119}
```

*Das restliche Ensemble tritt auf und stimmt mit ein.*

**Onkel Henry** **Tante Em** **Dorothy**
Schau nicht auf das Schlechte,<br>
sieh' doch, was du hast.<br>
Dorothy ist froh hier,<br>
der Löwe hat Mut gefasst.<br>
Der Blechmann liebt die Liebe,<br>
der Sthrohmann lernt sehr viel.<br>
Mach das Beste aus dem Leben,<br>
dann erreichst du bald dein Ziel.

```yaml
mic: muteall
qlcplus: black
projection: black-12
trigger_note: {ch: 1, note: 120}
```

```yaml
qlcplus: Kansas
projection: plaxite
trigger_note: {ch: 1, note: 121}
```

```yaml
qlcplus: black
trigger_note: {ch: 1, note: 122}
```

## Ende

```yaml
qlcplus: Erzähler Kansas
music:
    file: einlass.mp3
    loop: true
    volume: 0.3
trigger_note: {ch: 1, note: 123}
```
