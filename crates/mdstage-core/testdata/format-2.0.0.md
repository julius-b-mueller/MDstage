# Stück

```yaml
config:
    roles:
        Anna: {ch: 1}
        Ben: {ch: 2}
```

# Erste Szene

```yaml
trigger_note: {ch: 1, note: 1}
mic: Anna
note: Auftritt
start_tc: "01:00:00:00"
music:
    file: start.wav
    volume: 0.7
    start: 1.5
    end: 60
    fadein: 1.5
    fadeout: 2
chain_end: {ch: 1, note: 2}
cue_midi:
    - {device: Licht, type: cc, ch: 2, cc: 7, value: 64}
    - {type: sysex, bytes: F0 41 F7}
cue_osc:
    - {device: QLab, path: /go, arg: 0.8, arg_type: float}
cue_http:
    - {device: Pult, method: POST, path: /api, body: "{}"}
cue_display:
    - {device: Foyer, markdown: "# Eins", announce: Achtung}
osc: /alt/{ch}
osc_arg: 3
osc_arg_type: int
qlcplus: Tag
projection: Wald
```

**Anna**

Hallo, mein Schatz!
(sie winkt)

```yaml
trigger_note: {ch: 1, note: 2}
music:
    loop: true
    volume: 0.7
    fading_point: 12
    audios:
        - file: band.wav
          patch: [L, [R, L]]
        - file: click.wav
          mono: true
          volume: 0.5
          patch: [R]
music_seq:
    - file: b.wav
      fading_point: 28
    - audios:
          - file: c.wav
loop_outro: {ch: 1, note: 3}
```

```yaml
trigger_note: {ch: 1, note: 3}
auto_mic: true
music: out.wav
```

```yaml
sibling: true
trigger_note: {ch: 1, note: 3}
music: out-kurz.wav
```

```yaml
trigger_note: {ch: 1, note: 4}
auto_trigger:
    trigger_note: {ch: 1, note: 3}
    delay: 3
music:
    file: sting.wav
    adjust:
        trigger_note: {ch: 1, note: 3}
        fadeout: true
        fadetime: 2
```

```yaml
trigger_note: {ch: 1, note: 5}
auto_trigger:
    trigger_note: {ch: 1, note: 4}
    at: 1.5
music:
    file: leise.wav
    adjust:
        trigger_note: {ch: 1, note: 4}
        volume: 0.3
```
