<img src="crates/mdstage-app/assets/icon.png" width="120" alt="MDstage Icon">

# MDstage

Stage manager app for live shows and theatre productions — a native app written in Rust, for macOS (Apple Silicon), Windows and Linux (x64 and ARM64 each). The script is stored as a Markdown file; cues are embedded directly as YAML blocks. The app provides audio playback, MIDI control, timecode output, OSC output, and a live view — all from a single file.

However, there is no need to open a text editor. Roletext, stage directions, cues and everything else can be added and edited via the graphical user interface.

---

## Table of Contents

1. [Script Format](#script-format)
2. [Inline Editor](#inline-editor)
3. [Cue System (Triggers)](#cue-system-triggers)
4. [Auto-Mic](#auto-mic)
5. [Audio Playback](#audio-playback)
6. [S/L/F – Start / Loop / Finish](#slf--start--loop--finish)
7. [Auto-Cue](#auto-cue)
8. [Adjust (Cross-Fade / Volume)](#adjust-cross-fade--volume)
9. [MIDI](#midi)
10. [OSC Output](#osc-output)
11. [Timecode (MTC)](#timecode-mtc)
12. [Live View](#live-view)
13. [Emergency Controls](#emergency-controls)
14. [Cue Navigation](#cue-navigation)
15. [Role Editor](#role-editor)
16. [Role Groups](#role-groups)
17. [Settings](#settings)
18. [Export (PDF / DOCX)](#export-pdf--docx)
19. [Scene Sidebar & Search](#scene-sidebar--search)
20. [Script Formatting](#script-formatting)
21. [Keyboard Shortcuts](#keyboard-shortcuts)
22. [Development & Build](#development--build)

To turn the PDF of a play into a show file, see [docs/pdf-zu-skript-prompt.md](docs/pdf-zu-skript-prompt.md) (a prompt for Claude, in German).

---

## Script Format

The script is a plain `.md` file. On startup the app reopens the last used file, or prompts for one. **File → New File…** (`Cmd/Ctrl+N`) creates a template.

### Markdown Elements

| Syntax | Meaning |
|---|---|
| `# Scene`, `## Subscene` | Section headings, appear in the sidebar |
| `*Stage direction*` | Italic stage direction (shown in grey) |
| `**Role name**` | A role name (coloured according to the role editor) |
| `**Role name**\nText` | Role with dialogue (displayed directly below) |
| `**Role1/Role2**\nText` | Multiple roles speaking the same line (slash-separated) |
| ` ```yaml … ``` ` | Cue block (trigger) |

The first YAML block is always the **config block** (`config:`). All subsequent YAML blocks are cues.

### Config Block (Example)

```yaml
config:
    roles:
        Anna:
            color: blue
            ch: 3
        Ben:
            color: green
            ch: 5
    groups:
        Ensemble:
            color: purple
            roles: [Anna, Ben]
    emLightNote: {ch: 1, note: 64}
    # Virtual-channel NAMES are show-level (shared, config top-level). Cue audio patches
    # reference them by name; the name→physical-output routing is machine-local.
    virtualChannels:
        - {name: L}
        - {name: R}
    settings:
        MacBookPro:
            # Output-device DECLARATIONS only — name/type/colour. Addresses (MIDI port /
            # OSC host:port / HTTP url), the mixer connection, audio device and vChannel
            # routing are NOT stored here; they live in each machine's local prefs.
            outputDevices:
                - {name: "Licht", type: midi, color: yellow}
                - {name: "QLab",  type: osc}
            midiGoNote: {ch: 1, note: 36}
            midiBackNote: {ch: 1, note: 37}
```

---

## Inline Editor

The script can be edited directly inside the app — no external editor required.

- **Shift+Click** on a text block opens it for editing
- **Enter** closes the block and opens a new one below
- **Tab** accepts the suggested role name (autocomplete)
- **Shift+Enter** begins a new line inside the block. In the file a line break is written as `<br>`, so that any Markdown reader breaks there too; the app itself never shows the `<br>`. Line ends without `<br>` (the formatter puts one after every sentence) flow on as in any Markdown reader.
- A stage direction inside dialogue is typed in brackets: `(quietly)`. It is saved as `*(quietly)*` and shown in grey italics.
- **Arrow up / down** moves to the previous / next block
- **Escape** closes the editor without saving (with Vim keys: back to normal mode)
- **▲ / ▼** buttons move the block up or down
- **✕** button deletes the block
- **+** at the left edge between two blocks (shown when the pointer is there): a click adds a text block, **Shift+Click** adds an empty cue without opening its dialog. With a cue on the clipboard there is a paste button beside it.

**What you type is sorted for you:** text without any marking becomes a stage direction (the asterisks around it belong to the file and are not shown), text under a line of role names becomes that role's dialogue. A block that is left empty — or whose text is deleted — is removed.

**Role names** complete as you type, in the first line and in the lines below it (to add further roles). A role's name can only be removed or replaced as a whole, so that no stray `**` is left behind.

**Vim keys** (Settings → *Vim keys in the text editor*): normal and insert mode in the inline editor. Movements (`h j k l w b e 0 ^ $ f F t T gg G`, with counts), operators with movements (`dfx`, `ct,`, `ye` …), lines (`dd`, `yy`, `p`, `o`, `O`, `J`, `u`), new blocks (`go`, `gO`, Enter) and whole blocks (`gK`/`gJ` move, `yab`/`dab` copy/cut, `gp`/`gP` paste). `j`/`k` leave a block at its last/first line into the next/previous one. Escape only returns to normal mode; the editor is left with `:w`, `:q` or a click outside. The **Info** button beside the setting lists every supported key.

Right-clicking a block (if an editor command is set in the settings) offers to open the corresponding line of the show file in that editor.

### Multiple Roles per Line (Chor / Ensemble)

Several roles can share the same line of dialogue. In the script file this is stored as `**Role1/Role2/Role3**` followed by the dialogue text.

**Creating a multi-role block:**

1. Start a new block as usual (e.g. by pressing **Enter** below an existing block).
2. Type the first few letters of a role name — the autocomplete ghost appears.
3. Press **Tab** to confirm the first role. The chip is shown; the placeholder now reads *"Weitere Rolle oder Text…"*.
4. Without typing any dialogue, start typing the next role name and press **Tab** again. Repeat for as many roles as needed.
5. Once all roles are added, type the dialogue text and press **Enter** to commit.

**Backspace** at the start (no typed text) removes the last confirmed role chip.

**Editing confirmed role chips (Shift+hover):**

While the new-block editor is open, hold **Shift** and hover over a role chip to reveal two buttons:

| Button | Action |
|--------|--------|
| **×** | Remove this role from the group |
| **+** | Place the cursor at the end of the chip row so you can type and confirm an additional role |

### Editing Role Names in Existing Blocks

When an existing block is open for editing (via **Shift+Click**), clicking on any role name opens a dropdown:

- The **first row** is split into two halves by a vertical line:
  - **−** (left): removes this role from the block. Disabled if it is the only role.
  - **+** (right): adds another role. A `?` placeholder appears, and a sub-dropdown opens immediately to choose the new role. Only roles not already in the block are listed. Clicking outside without selecting cancels the addition.
- The rows below list all roles not already assigned to the block. Clicking one replaces the current role name with the selection.

The dialogue text always keeps the colour of the **first** role in the block, regardless of which role is changed or added.

---

## Cue System (Triggers)

Every YAML block (except the config block) is a **cue** (trigger). It is displayed as a control panel in the script, named after its trigger note.

### Cue Names

A cue is called after its trigger note: `trigger_note: {ch: 1, note: 47}` is **Cue 1.47** (channel.note). The name appears on the cue's card, in references from other cues, on auto-cue markers in a waveform (just `1.47`), in the live view and in exports. It does not change when cues are added, removed or moved.

Every cue needs a trigger note of its own; only the variants of a cue share its note. A show file in which two separate cues carry the same note is reported as an error when it is opened, and the cue dialog does not save a note another cue already has. Changing a cue's note updates every reference to it (`chain_end`, `loop_outro`, `auto_trigger`, `music.adjust`) and the notes of its variants.

### Cue Fields

| Field | Description |
|---|---|
| `trigger_note: {ch: 1, note: 42}` | MIDI note sent when the cue fires. Assigned automatically if not set. |
| `mic: "Anna"` | Role name(s) or group name(s) whose microphone channels are opened. All others are muted. `muteall` mutes everyone. Group names expand to all member roles. Not used when Auto-Mic is active. |
| `auto_mic: true` | Enables Auto-Mic for this cue (see [Auto-Mic](#auto-mic)). |
| `music: file.wav` | Audio file from the `audio/` subfolder. Short form or object (see below). |
| `note: "Note"` | Internal note displayed on the trigger panel. |
| `start_tc: "01:00:00:00"` | Start timecode (HH:MM:SS:FF, 25 fps) sent as MTC when the cue fires. |
| `osc: "/path/{ch}"` | OSC message path sent when the cue fires (legacy — see [OSC Output](#osc-output)). |
| `cue_midi: [...]` | List of MIDI messages sent when the cue fires (see [MIDI](#midi)). |
| `cue_osc: [...]` | List of OSC messages sent when the cue fires (see [OSC Output](#osc-output)). |
| `cue_http: [...]` | List of HTTP requests sent when the cue fires (see [HTTP Output](#http-output)). |
| `cue_display: [...]` | List of `{device, markdown}` entries shown on Display web interfaces when the cue fires (see [Per-Cue Display Markdown](#per-cue-display-markdown-cue_display)). |
| `sibling: true` | Marks the cue as a **variant** of the preceding cue (alternative audio/mic assignment). |

### Audio Object (Extended Format)

```yaml
music:
    file: loop.wav
    volume: 0.75
    start: 2.5
    end: 120.0
    fadein: 1.0
    fadeout: 2.0
    fading_point: 96.0
    loop: true
```

`start`, `end`, `fadein`, `fadeout`, `fading_point` and `loop` define the shared transport
for the whole cue.

#### Multiple audios + channel patching

A cue can contain **several audios** that play together as one multichannel audio. Each
audio's channel count is detected automatically; every channel is patched **by name** to one
or more **virtual channels** (defined in settings). Use the `audios` list instead of `file`:

```yaml
music:
    loop: true
    audios:
        - file: band.wav            # 4-channel file
          patch: [Saal L, Saal R, Sub L, Sub R]
        - file: click.wav
          mono: true                # downmix to mono (e.g. stereo click track)
          volume: 0.7               # per-audio level
          patch: [Click]            # an entry may be a list of names for fan-out
```

- `patch` has one entry per source channel (one entry when `mono: true`). An entry is a
  virtual-channel name or a list of names (fan-out to several vChannels).
- A virtual channel may be driven by only one audio per cue. With only the default two
  vChannels (L/R), a cue uses a single audio patched implicitly to L/R and the patch UI is
  hidden.

### Editing a Cue

Every cue's card has an edit button (a pencil) in its bottom right corner that opens the cue dialog. Everything a cue can do is set there — the YAML never has to be touched. The other buttons of a card (Auto-Cue, Adjust, S/L/F, Auto-Mic, variant, Live) appear while the pointer is on it.

**New cues:** **Shift+Click** on the **+** between two blocks adds an empty cue at once; *Insert cue before/after…* in a block's context menu opens the dialog first. **Dragging audio files from the file manager** into the script copies them into `audio/` and makes a cue for each at the place where they are dropped; while dragging, a green line shows where that is (macOS and Windows).

**What a card shows:** microphones as labels, the note, audio files, timecode, what the cue sends — one line per device with the message itself (MIDI in words such as `Ch 1 · CC 7 = 100`, OSC address and values, HTTP method and path, announcement text, the first line of display content) — and its connections to other cues.

**The bar at a card's left edge** says where the cue stands in the show, in the colour of the word beside its name:

| Colour | Meaning |
|---|---|
| Green | the current cue, or a cue that has just fired by itself ("fired") |
| Yellow | the next Go, or an outro waiting for its loop to end |
| Blue | its audio is playing |
| Faint | done in this pass through the script |
| Grey | still to come |

**Connections between cues** are drawn as lines in the left margin, from the cue that acts (a dot) to the cue it leads to or changes (an arrow): purple for Start/Loop/Finish, orange for auto-cues, green for Adjust. An auto-cue at an audio position starts at its marker on the source's waveform. The lines are faint until the pointer is on one of their two cues. In a card, every reference to another cue ("Cue 1.47") is underlined; a click goes there.

**Copy / paste:** *Copy* in a cue's context menu puts the whole cue (all of its fields) on an in-app clipboard. A paste button then appears next to every **+** insert zone, so the cue can be dropped in anywhere; the pasted copy is standalone (it gets a fresh trigger note and is never a variant). The clipboard is session-only.

**Live (arm in live view):** Opens the live view with this cue armed as the next Go — handy for jumping straight to a specific point during a rehearsal or top-of-scene. While the show is locked the button is hidden.

**Show lock:** With the lock on, the script takes one interaction only: a click on a cue. With the live view closed it fires the cue, with the live view open it arms it as the next Go. Waveforms cannot be scrolled, zoomed or dragged, the transport row and the cue buttons are off, and nothing can be edited.

### Variants

**⊕** duplicates a cue as a `sibling`. Variants are shown as a group. In live operation, a variant can be selected before Go; if none is selected, the first variant always fires.

---

## Auto-Mic

The **Auto-Mic** button in the cue's button row enables automatic microphone assignment. Instead of selecting microphone channels manually, the app scans the script text and opens exactly the microphones whose roles have dialogue in the section that follows.

### How it works

- Click **Auto-Mic** on a cue to make it an Auto-Mic cue (`auto_mic: true` is saved in the YAML block).
- Clicking it again removes the Auto-Mic flag.
- When an Auto-Mic cue fires, the app looks at all role blocks with dialogue between that cue and the **next** Auto-Mic cue in the script. All matching microphone channels are opened; everything else is muted.
- The **last** Auto-Mic cue (no further Auto-Mic cue after it) mutes all channels.
- The computed microphone list is shown in the cue header.
- **Delayed switch-off:** an Auto-Mic cue opens the microphones it needs at once, but closes those it no longer needs only after a delay (Settings → *Auto mic: switch microphones off after*, default 7 s; 0 switches off at once). Whoever comes on stage is heard immediately, whoever leaves can finish speaking. While the delay runs, the leaving microphones are shown as labels that run out – in the live view's microphone bar and on the cue's card. The next cue that sets microphones, Back, or "Mics Off" ends the delay at once.
- **Labels:** groups come first, as outlined labels with coloured type; single roles follow as filled labels with dark type. A role that is open as part of a group is not listed again.

### Manual selection is disabled when Auto-Mic is in use

Once any Auto-Mic cue exists in the script, manual microphone selection is disabled on **all** cues (the edit dialog shows an informational note instead of checkboxes). This prevents conflicts between auto and manual assignments.

### Live updates

The computed microphone list is derived at runtime from the script text — editing role dialogue updates the mic list automatically. The `auto_mic: true` flag itself is stored in the YAML block, but the resulting channel list is not. Existing manual `mic` entries are preserved in their YAML blocks even while Auto-Mic is active.

---

## Audio Playback

Audio files (WAV, AIFF, FLAC, MP3, AAC/M4A, OGG) are located in the `audio/` subfolder next to the `.md` file.

Audio is streamed from disk, never loaded whole: a show with hours of audio needs only a few megabytes of memory, and opening it is immediate. If the audio device disappears (unplugged interface), the show carries on and the device is taken up again by itself when it is back.

### Renaming an Audio File

The audio picker in the cue dialog has a **✏** button next to the selected file. It renames the
file inside `audio/` **and rewrites every reference to it in the whole script** — other cues using
the same file follow along automatically. The new name must be a plain file name (no path) with an
audio extension; renaming to an existing name is rejected.

### Moving Unused Audio Files

**Move unused audio files…** (same menu as *Clean up YAML*) collects every file in `audio/` that no
cue references and moves it into the fixed subfolder **`audio/_unused/`**, which is created if
needed. The folder name is not configurable, so the same files are recognised again on the next
run. Nothing is deleted — files can be moved back at any time. If the script contains
YAML blocks that cannot be parsed, the action aborts, because unreadable blocks may hold
references.

### Waveform View

Every cue with an audio file shows an interactive waveform:

- **▶ / ⏸** – Play / Pause
- **⏹** – Stop and return to start point
- **+ / −** – Zoom (10–400 px/s)
- **⟳** – Toggle loop mode
- **Volume slider** – Volume 0–100 %

**Drag** along the waveform (press and move) to move the playhead; the audio follows when the
button is released. A plain click does nothing, so the audio is not moved by accident.

**Named markers:** a **right click** on the waveform sets a marker at that place and asks for its name (optional). A right click on a marker renames or deletes it; **Shift+Drag** moves it. Markers are saved with the cue (`music.markers`, each with `at` in seconds and `name`). In the live view they cut the audio's progress bar into pieces, the way the show's bar is cut into scenes; where an auto-cue fires at a place in that audio, the bar carries an orange dot.

**Shift+Drag** on the waveform markers:

| Marker | Function |
|---|---|
| Lower start marker | Move playback start point |
| Lower end marker | Move playback end point |
| Upper start marker | Move fade-in end point |
| Upper end marker | Move fade-out start point |

All changes (volume, start/end, fades, loop) are saved automatically to the YAML file.

### Virtual Channels & Routing

Audio routing uses a **virtual channel** abstraction between cue audio and the soundcard:

1. In **Settings → Audio Output** you define how many virtual channels you want and name them
   (e.g. `Saal L`, `Saal R`, `Sub`, `Click`) — independent of how many channels the selected
   device actually has. The default is two channels, `L` and `R`.
2. Each virtual channel is routed **1:1** to a physical output of the device. No physical
   output can be shared by two virtual channels.
3. In a cue, every channel of every audio is patched **by name** to one or more virtual
   channels (see [Multiple audios + channel patching](#multiple-audios--channel-patching)).

This decouples the production design (named buses) from the venue's soundcard: re-routing for
a different interface only touches the virtual-channel routing, not the cues.

**Names are shared, routing is local.** The virtual-channel **names** are stored in the show file
(so cue patches resolve everywhere); the **name→physical-output mapping** is stored locally on
each machine (unrouted channels default positionally: 1st→output 1, 2nd→output 2, …). The audio
output device and the mixer-remote connection are likewise machine-local — the same show file
runs at different venues without editing.

To test a virtual channel's physical output directly from the settings window, use the **▶**
button in its row.

If a cue references a virtual channel that no longer exists (e.g. it was removed in settings),
a warning is shown in the red banner when the file is opened. **Clean up YAML** removes audios
that are routed to non-existent virtual channels.

### Note: Use WAV for Seamless Transitions

MP3 and AAC files contain encoder padding (silent frames at the beginning/end) that prevents seamless transitions. **Use WAV files** for all S/L/F structures and loop transitions.

---

## S/L/F – Start / Loop / Finish

Seamless, sample-accurate transitions between audio clips without silence or clicks.

In musical theatre terms: the **Loop** is the **Vamp**, and the **Finish** (Outro) is the **Devamp**.

### Transition at End (`chain_end`)

```yaml
# Start cue
music: intro.wav
chain_end: {ch: 1, note: 5}   # note of the follow-on cue

---

# Follow-on cue (started automatically)
trigger_note: {ch: 1, note: 5}
music: loop.wav
loop: true
```

The start cue plays through and at the end automatically and seamlessly starts the follow-on cue.

### Managed Loop with Outro / Vamp & Devamp (`loop_outro`)

```yaml
# Loop cue (Vamp)
music: loop.wav
loop_outro: {ch: 1, note: 6}   # note of the outro cue

---

# Outro cue (Devamp)
trigger_note: {ch: 1, note: 6}
music: outro.wav
```

The loop cue (Vamp) loops indefinitely. Clicking the outro cue (Devamp) **queues** it — it then starts exactly at the next loop end, seamlessly. A second click cancels the queue.

### Outro Point / Smooth Devamp Tail (`fading_point`)

`fading_point` (seconds) defines where a loop (Vamp) stops cycling. Without it, the transition happens at `end` (or the file boundary). With it:

- The loop iterates from `start` to `fading_point`.
- Audio from `fading_point` to `end` plays as a tail. It rings out over whatever comes next: over the loop's own next pass every time it wraps, and over the next cue (Devamp) once that starts. On the waveform a ghost cursor runs through the tail while the main cursor is back at the start.
- When a Finish or Bridge is queued (Go pressed), the app waits for the current iteration to reach `fading_point` before starting the transition.

This allows the Vamp or Devamp to ring out naturally — for example, if a cymbal is struck just before the loop boundary, the tail carries it through into the Devamp without cutting it off.

```yaml
music:
    file: loop.wav
    end: 64.0
    fading_point: 32.0   # loop cycles 0→32 s; tail 32→64 s plays on outro
loop_outro: {ch: 1, note: 7}
```

The waveform editor shows an orange marker at `fading_point`. The progress bar in the live view cycles between `start` and `fading_point`.

### Multi-File Loop / Multi-Part Vamp (`music_seq`)

A loop (Vamp) can span multiple audio files that play in sequence. The primary file is defined in `music:`, additional files in `music_seq:`. Each file transitions seamlessly to the next at its `fading_point` (or `end`), and the sequence loops back to the first file. This allows a long, varied Vamp that still devamps quickly — the Devamp fires at the next `fading_point` in the currently active file, not at the end of the full sequence.

```yaml
music:
    file: loop-a.wav
    fading_point: 32.0
loop_outro: {ch: 1, note: 7}
music_seq:
    - file: loop-b.wav
      fading_point: 28.0
    - file: loop-c.wav
      fading_point: 30.0
```

Each `music_seq` entry supports `file`, `volume`, `start`, `end`, `fadein`, `fadeout`, `fading_point`. With more than 2 virtual channels, a slot can also hold its own `audios` list (multiple files patched to virtual channels), exactly like the primary `music` block:

```yaml
music_seq:
    - audios:
        - file: loop-b-band.wav
          patch: [Saal L, Saal R, Sub L, Sub R]
        - file: loop-b-click.wav
          mono: true
          patch: [Click]
      fading_point: 28.0
```

**Behavior:**
- Files play in order: A → B → C → A → B → …
- Each transition fires at the `fading_point` of the current file (sample-accurate; audio between `fading_point` and `end` plays as an overlap tail into the next file).
- When a Finish or Bridge is queued, it waits for the next `fading_point` in the currently active file.
- The live view progress bar shows the active file's progress (`start` → `fading_point`) and resets on each transition.
- All files are pre-decoded in the background as soon as the cue becomes visible.

Use WAV files for all files in the sequence to avoid encoder padding artefacts at transition points.

### S/L/F Button

The **S/L/F** button on a trigger opens a menu to configure `chain_end` or `loop_outro`. Shift+Click removes an existing connection. The button shows the type (`Start`, `Loop`, `Finish`, `Bridge`).

---

## Auto-Cue

A cue can be triggered automatically by another cue (the *source*), either when the source's
audio reaches a position, or after a delay once the source fires.

**Setup:**
1. Click **Auto-Cue** on the target cue
2. Click the source cue (pick mode — any cue with a trigger note can be picked)
3. **If the source audio is paused at a position**, that position is used (audio-position
   auto-cue). **Otherwise** a dialog asks for a time in seconds. If that time lies within the
   source's audio, you choose:
   - **At that place in the source's audio:** the auto-cue gets its marker on the waveform,
     exactly as if it had been set from the playhead. It fires whenever the audio reaches the
     place — on every pass of a loop, and after a jump on the waveform too.
   - **Once, with a delay:** it counts from the firing of the source and fires exactly once.

   If the source has no audio, or the time lies past its end, it is always a delay auto-cue.
   A delay auto-cue's line starts at the left edge of the source's card, with its seconds
   written where it leaves. Several of them leave in the order of their delays.

**Auto-cues stand in the order they fire in.** The auto-cues of one source have to fire in the order they stand in the script, so that what is read along is what happens:

- A marker on the waveform can only be dragged between its neighbours: not before the auto-cue that stands before it in the script, not after the one that stands after it.
- The dialog only takes a time in that range and says what the range is; a place taken from the playhead that lies outside it is refused.
- Moving a block (▲ / ▼) is refused if it would break the order. To swap two auto-cues, change the time first, then move the cue.
- A show file that breaks the rule (edited by hand) is not rearranged: it is reported as an error when it is opened, and the cards concerned are marked "⚠ order".

Compared are places with places and delays with delays; a place with a delay only where the source's audio plays once (in a loop the place comes round on every pass, the delay only once). Auto-cues of different sources are not compared.

Seconds are shown with two decimals at most.

For audio-position auto-cues the marker appears on the source cue's waveform, with the
auto-cue's name (`1.47`) above it; **Shift+Drag** repositions it. A line runs from the marker
to the auto-cue's card. When an auto-cue fires, the view goes to it and its card is marked
"fired"; the operator's own cue stays the current one, and Go carries on from there. For delay auto-cues, a progress bar fills on the target's Auto-Cue button while
counting down. **Shift+Click** on the Auto-Cue button deletes the auto-cue.

A delay auto-cue fires its target the configured number of seconds after the source cue is
triggered. Stopping the source or pressing Back before it fires cancels the pending auto-cue.

### YAML Representation

```yaml
auto_trigger:                     # audio-position form
    trigger_note: {ch: 1, note: 3}
    at: 45.2
```

```yaml
auto_trigger:                     # delay form (fires 8 s after the source cue)
    trigger_note: {ch: 1, note: 3}
    delay: 8.0
```

---

## Adjust (Cross-Fade / Volume)

A cue can affect another cue when it fires (e.g. fade out music when dialogue starts).

**Setup:** **⇢ Adjust** button on the trigger → click the target trigger → choose action:

- **Fade out (stop):** Fades the target audio out and stops it
- **Volume to X:** Fades the target audio to a value (keeps playing)
- **Fade time:** Duration of the fade in seconds

### YAML Representation

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

### Output Devices

MIDI (and OSC) output devices are configured in **Settings** as a unified list of named **output devices**. Each device has a name, type (`midi` or `osc`), an optional colour (shown as a badge on the trigger panel), and a `sendTriggerNote` flag.

Every MIDI device with `sendTriggerNote: true` sends the cue's `trigger_note` (Note On/Off) when a cue fires. Additional per-cue MIDI messages are defined via `cue_midi` (see below).

### Per-Cue MIDI Messages (`cue_midi`)

A cue can send arbitrary MIDI messages to any configured MIDI device when it fires. Supported message types: **Note**, **CC**, **Program Change**, **SysEx**.

```yaml
cue_midi:
    - device: "Licht"
      type: note
      ch: 1
      note: 42
      vel: 100
    - device: "Licht"
      type: cc
      ch: 2
      cc: 7
      value: 64
    - device: "Licht"
      type: pc
      ch: 1
      program: 5
    - device: "Licht"
      type: sysex
      bytes: "F0 41 F7"
```

If `device` is omitted, the first MIDI device is used. The **Back** function restores device states — see [Cue History (Back)](#cue-history-back).

### Mic Control (X32 / Custom)

Microphone muting is configured separately under **Mixer Remote Control** in Settings (not part of the output device list). See [Settings](#settings).

### Timecode (MTC)

Each MIDI output device has a **Send MIDI Timecode** checkbox in Settings; MTC is sent to every device with it enabled. See [Timecode (MTC)](#timecode-mtc).

### MIDI Input

Two configurable MIDI notes for **Go** and **Back** — received on all MIDI inputs. Notes can be assigned using **MIDI Learn** mode in the settings window.

---

## Remote Cue Triggering (MIDI / OSC Input)

External software (lighting desks, QLab, Companion, …) can fire individual cues by their own note. Configure the input under **Settings → Live → Remote Cue Trigger**:

- **MIDI** — choose a dedicated input device. An incoming **Note On** whose channel/note equals a cue's `trigger_note` fires that cue (independent of the current position).
- **OSC** — listens on a UDP port for the path **`/cue/<ch>/<note>`** (no arguments). For example `/cue/1/42` fires the cue with `trigger_note: {ch: 1, note: 42}`.

In both cases the cue is triggered exactly as if it were the next Go on that cue. Because every cue has a `trigger_note` (assigned automatically if not set), no extra per-cue configuration is needed.

---

## OSC Output

OSC (Open Sound Control) output devices are part of the same unified device list as MIDI devices (see [MIDI](#midi)). Each OSC device has a name, host, port, and optional colour.

### Per-Cue OSC Messages (`cue_osc`)

A cue can send OSC messages to any configured OSC device when it fires:

```yaml
cue_osc:
    - device: "QLab"
      path: /cue/42/start
    - device: "QLab"
      path: /volume/set
      arg: 0.8
      arg_type: float   # int | float | string
```

If `device` is omitted, the first OSC device is used. The **Back** function restores device states — see [Cue History (Back)](#cue-history-back).

### Legacy: `osc` field

The older single-path format is still supported:

```yaml
osc: /show/cue/go
osc_arg: 0.8
osc_arg_type: float
```

The `{ch}` placeholder in the path is replaced with the role's channel number (two digits, 1-based). The OSC badge `⌁ /path …` is shown on the trigger panel. This field does **not** participate in Back's device state restoration.

---

## HTTP Output

HTTP output devices are part of the same unified device list as MIDI and OSC devices (see [MIDI](#midi)). Each HTTP device has a name, a **base URL** (e.g. `http://192.168.1.50:8080`), and an optional colour. HTTP is available for per-cue messages only (not for the mixer remote control).

### Per-Cue HTTP Messages (`cue_http`)

A cue can send HTTP requests to any configured HTTP device when it fires:

```yaml
cue_http:
    - device: "Lichtpult"
      method: POST            # GET | POST | PUT | DELETE | PATCH
      path: /api/scene/3
      body: '{"fade": 2.0}'
      content_type: application/json
```

The request is sent to `<device base URL>` + `path`. `body` and `content_type` are optional (a body is only sent for non-GET/HEAD methods). If `device` is omitted, the first HTTP device is used. Like `cue_midi`/`cue_osc`, HTTP messages participate in Back's device state restoration (see [Cue History (Back)](#cue-history-back)).

### Per-Cue Display Markdown (`cue_display`)

A **Display device** exposes a web interface that shows per-cue markdown, reachable at `http://<address>:<port>/<slug>` — the slug is derived from the device name (lowercased, umlauts → `ae/oe/ue/ss`, everything else → hyphens; e.g. `Bühne Links` → `buehne-links`). The settings screen shows the exact URL. The bind interface (all networks / localhost / a specific adapter) and the port are single machine-local settings shared by all displays (default port `7590`); the settings screen shows the resulting address. A cue sets what a display shows:

```yaml
cue_display:
    - device: "Stage Left"
      markdown: |
        # Scene 3
        Cue in 4 bars
      announce: "Scene three, standby"   # optional text-to-speech, spoken on Go
```

The markdown is rendered (headings, lists, emphasis, links, images) and pushed live to any connected browser via Server-Sent Events. Browser zoom (pinch / Ctrl-scroll) works, and if the content is taller than the viewport the page auto-scrolls page-by-page and back to the top every *N* seconds (configurable per device, `0` = off).

**What a display shows per cue** — each `cue_display` message controls one display device:

| Message content | Effect on that display |
|---|---|
| `markdown` set | Show the new markdown (replaces the previous content). |
| only `announce` (no markdown) | **Keep** the current content and speak the announcement (a "hold"). |
| neither `markdown` nor `announce` (an empty message) | **Clear** the display. |
| *no message for the device* | Leave the display untouched — its content **persists** across cues, like MIDI/OSC device state. |

On **Back**, the effective content is recomputed from the remaining cue history, so the previous state (including holds and clears) is restored exactly. Back never re-speaks announcements.

Each display device chooses a stylesheet: a built-in **dark** (default), **light**, or **subtitle** (white text on black, centered), or a custom `.css` file dropped into a `css/` folder next to the show `.md`.

**Announcements (`announce`):** When a cue fires (Go / auto), every browser client of that display device plays a theatrical front-of-house chime and reads the `announce` text aloud via the browser's text-to-speech. Back does **not** re-announce. The announcement is fired only on the trigger, independent of the markdown restoration. Per display device you can enable **repeat**, which speaks the announcement, then "I repeat" (translated to the device's language), then the announcement again.

**Client presence & naming:** Each browser tab that opens a display URL is remembered and shown in the app's live view as a coloured dot — **green** while connected, **red** when the connection drops (the client retries automatically and turns green again on reconnect). Several clients can share one configured device. Each client has a small settings panel (⚙) to set a **name**, a **TTS voice** and a **zoom** level; the voice list only offers voices matching the device's configured language (set in MDstage's display-device settings). name and voice are also read from URL query params (`?name=Foyer&voice=Anna&zoom=1.5`) for direct kiosk setup and are stored as cookies (query param wins over cookie). Renaming a client updates its label in the live view live. The name, voice and zoom appear back in the URL so a configured client's URL can be reused as-is.

**Landing page:** Opening the server root (`http://<address>:<port>/` with no slug) shows an index that lists every configured display device with a link to its page. Point a backstage browser at the bare address and pick the screen you need — no URL typing. The list updates as devices are added or removed.

**Kiosk-friendly client:** On a display page the settings gear (⚙) stays hidden and only fades in while the mouse moves, then fades out again after a couple of seconds — so a permanent stage/foyer screen shows nothing but content. Because browsers block audio until the user interacts, the client probes on load whether audio is already permitted; if it is not (a normal browser), a one-tap **“🔊 Ton aktivieren / Enable audio”** button appears so announcements can play. On a kiosk configured to allow autoplay the audio starts unlocked and the button never appears.

**Network binding & security:** The display server binds to **`127.0.0.1` (this computer only) by default**; to reach it from tablets or stage monitors over the LAN, switch the bind interface to *All networks (0.0.0.0)* or a specific adapter in the settings. The server is read-only for clients (they only receive content) and serves no files outside the built-in assets and the show's `css/` folder.

---

## Timecode (MTC)

The app generates MIDI Timecode (25 fps) synchronised to audio playback.

- When a cue with `start_tc` fires, MTC starts from that offset
- In S/L/F chains, timecode counts on without gaps
- Scrubbing on the waveform updates the TC via a Full Frame message
- The current TC is shown in the app header
- Derived timecodes for follow-on cues in an S/L/F chain are calculated and displayed automatically
- A cue further down a chain that is fired on its own (the loop without its start having run) counts from its derived timecode
- Timecode is held back like every other output while outputs are blocked or the show file is not trusted

---

## Live View

A separate window (`Cmd/Ctrl+L`) for the stage or operator monitor.

**Contents:**
- Current cue (prominently highlighted) with all cue details
- Next cue with preview
- **Go / Back** buttons
- Timecode display
- Progress indicator for running audio and auto-cues
- Variant selection: the next cue can be switched to a variant before Go
- Per-cue Stop button: fades that cue's audio out over 0.5 s
- The open microphones as labels, and those an Auto-Mic cue is about to switch off, running out
- The three emergency buttons

Go/Back in the live view works exactly like in the main window. The script scrolls smoothly so that the next cue always sits a little below the middle.

---

## Emergency Controls

Three emergency buttons in the header:

| Button | Function |
|---|---|
| **Emergency Light** | Sends the MIDI note configured in `emLightNote` (e.g. emergency lighting) |
| **Music Stop** | Fades all running audio out over 500 ms and stops it; stops MTC |
| **Mics Off** | Mutes all configured microphone channels on the mixer |

---

## Cue Navigation

### Main Window

| Action | Result |
|---|---|
| Click on trigger | Fire cue immediately |
| Click with live view open | Pre-select cue as next (arm) |
| **Go** (Space in the live view; in the main window only while the show is locked) | Fire next cue |
| **Back** (Backspace, when live view is open) | Undo last cue (fade-out + undo) |
| MIDI Go/Back | Configurable MIDI notes |
| Show current cue | Scrolls to current position |

Double-clicking a playing cue **stops** it immediately (undo function).

The view glides to where it is sent (a fired cue, a scene, a search hit, a referenced cue) instead of jumping; scrolling by hand takes over at once.

**Go waits for cues that come by themselves:** while a cue is on its way without the operator — a delay auto-cue counting down, an auto-cue at a place in audio that plays once, an outro waiting for its loop's end, a cue its predecessor chains into — Go does nothing: the button is greyed out, and the space bar and a remote Go (MIDI/OSC) are ignored too. A cue can still be fired by clicking it, and Back works. (An auto-cue in a loop comes round on every pass and does not hold Go back.) The waiting cue shows a bar — in the live view on its card, in the main window along the bottom edge of its card — that always starts empty when the wait begins and is full when the cue fires, wherever the audio stood at that moment.

**Go after jumping back:** Go fires the next cue after the operator's position that has not fired *in the current pass*. After clicking an earlier cue, every cue from there on is due again — nothing is skipped because it had fired before the jump. Cues that fired by themselves in the current pass (a loop its start chained into, an auto-cue) are still stepped over.

### Cue History (Back)

Back fades the last-fired audio out over 500 ms, restores the previous cue state, and undoes mic changes.

**Beat-accurate loop/vamp resume:** If the undone Go had ended a loop (Vamp) by handing it off to a Finish/outro (Devamp), Back doesn't just restart the loop from its beginning — it resumes it **exactly where it would be now had the Go never happened**. The app continuously captures the loop's playback position against the AudioContext clock (sample-accurate, free of timer jitter) and, on Back, computes how far the loop would have advanced in the meantime, wraps that into the loop region, and restarts the source on the audio clock at that precise sample. For a multi-part Vamp (`music_seq`) the elapsed time is wrapped across the full sequence length, so playback resumes in the correct part *and* at the correct phase within it. The result is in-beat: the Vamp comes back as if Go had never been pressed, with no audible jump in the groove.

To avoid a comb-filter/phaser artefact when the Devamp shares material with the loop (e.g. same drums plus an added melody), the handover is coordinated on the audio clock: the outgoing Devamp is faded out over a short window (~50 ms) while the resumed loop snaps in with a ~12 ms anti-click ramp, so the two similar signals never overlap at full level. Single-file loops, `loop_outro` (managed) loops, and multi-part `music_seq` Vamps are all resumed beat-accurately; the timecode (`start_tc`) follows the resumed position.

**Behavior after a jump:** Back always follows the actual trigger history, not the script order. If a cue was reached by jumping (clicking it directly), Back returns to the cue that was active before the jump — not to the cue that precedes it in the script.

**Device state restoration (MIDI/OSC/HTTP):** When Back pops a cue, the app checks which output devices that cue addressed via `cue_midi` / `cue_osc` / `cue_http`. For each such device, it scans backwards through the remaining cue history and resends the message set from the most recent earlier cue that addressed the same device. If no earlier cue addressed that device, nothing is sent — the device is left in its current state.

The old `osc:` field and `trigger_note` are **not** part of this restoration mechanism. Only `cue_midi`, `cue_osc`, `cue_http` and `cue_display` messages participate in device state tracking.

---

## Role Editor

The **Role Editor…** menu opens a dedicated window for managing roles.

- **Name** of the role
- **Color** (red, green, blue, purple, cyan, yellow, darkred, …) — determines the text colour in the script and in exports
- **MIDI channel** (ch) — the microphone channel on the mixer

Roles can be renamed; all `**Role name**` occurrences in the script are updated automatically.

---

## Role Groups

Groups bundle multiple roles into a named set. They are managed in the **Role Editor** window, below the individual roles.

### Creating and editing groups

- Click **+ Add group** to add a new group row.
- Each group has a **name**, a **colour**, and a list of **member roles** (selected via chips below the group header).
- Groups can be reordered by dragging the handle on the left.
- Click **×** on a group row to remove it.
- Save applies all group changes together with any role changes.

Group names must not conflict with existing role names; the editor highlights duplicates before saving.

### Config block syntax

```yaml
config:
    groups:
        Ensemble:
            color: purple
            roles: [Anna, Ben]
        Chor:
            color: cyan
            roles: [Anna, Ben, Clara]
```

### Using groups as mic assignments

A group name can be used anywhere a role name is accepted for `mic:`:

```yaml
mic: Ensemble          # opens all channels of the group
mic: [Ensemble, Clara] # group + additional individual role
```

When a cue fires, the group is expanded to all its member roles for MIDI/OSC routing. In the cue panel and live view, the group is shown as one outlined label with its name in the group's colour; roles that are open on their own follow as filled labels. A role that is open as part of a group is not listed again.

The built-in group **Alle** (German) / **All** (English) always refers to all defined roles and cannot be created manually.

### Group display in the cue panel and live view

Mic assignments are shown as grouped chips by default. The display can be switched to individual chips (flat list) via **Settings → Mic group display**.

---

## Settings

**Settings…** (`Cmd/Ctrl+,`) opens:

### Audio

| Setting | Description |
|---|---|
| Audio device | Output device for all virtual channels |
| Virtual channels | Define and name the virtual channels; route each 1:1 to a physical output of the device |

### Output Devices (MIDI + OSC + HTTP)

The unified device list manages all MIDI, OSC, HTTP and Display output devices. Each device has:

| Property | Description |
|---|---|
| Name | Display name — used in `cue_midi` / `cue_osc` / `cue_http` / `cue_display` to target the device |
| Type | `midi`, `osc`, `http` or `display` |
| Colour | Optional colour shown as a badge on trigger panels |
| Send trigger note | MIDI/OSC only: if enabled, receives the cue's `trigger_note` when a cue fires |
| Device (MIDI) | System MIDI port name |
| Host / Port (OSC) | UDP target address |
| Base URL (HTTP) | Base URL for `cue_http` requests, e.g. `http://192.168.1.50:8080` |
| Scroll / Style / Language (Display) | Auto-scroll interval in seconds (`0` = off), stylesheet (dark/light/subtitle or a custom `css/…css` file), and the TTS **language** (the client then only offers voices for that language). The URL path is a **slug** derived from the device name (lowercase, umlauts → `ae/oe/ue/ss`, other characters → hyphens): `http://<address>:<port>/<slug>`. The bind **interface** (`0.0.0.0` / `127.0.0.1` / a specific adapter) and **port** are single machine-local settings shared by all displays; the settings screen lists **all addresses** the display is reachable from (every network adapter's IP for `0.0.0.0`). |

**Addresses are machine-local.** Only the device **name, type and colour** are stored in the
shared `script.md`. The actual endpoint (MIDI port / OSC host:port / HTTP base URL) and the
enabled / send-trigger-note / send-timecode flags are stored **locally on each machine**
(`editor-prefs.json` in the app's user-data folder), keyed by device name. This keeps addresses
(incl. internal IPs) out of shared show files and lets the same show run at different venues —
each operator configures the local addresses once. When you open a show whose device is not
configured on this machine, a banner notes it and its cues stay silent until you set the address
in settings. A cue message whose device name isn't configured locally sends **nothing** (no
fallback to a default device).

### MIDI Input

| Setting | Description |
|---|---|
| MIDI Timecode device | MIDI output for MTC (separate from output devices) |
| Input device (Go / Back) | Filter MIDI input to a specific device, or receive from all |
| Go note / Back note | MIDI notes for Go and Back — can be assigned via **MIDI Learn** |

### Switching single devices off

The **Devices** menu lists every MIDI, OSC and HTTP output device with a tick. Without the tick nothing is sent to that device — so that, say, the lighting desk is left alone while its operator is programming during a rehearsal. A line above the script names the devices that are switched off. *Microphone control* in the same menu does the same for the mixers: without the tick no microphone is switched, not by "Mics Off" either. *Block all outputs* holds everything back, timecode included. (The tick is the same one as in the device list of the settings.)

### Mixer Remote Control

The microphone muting method can be configured independently of the MIDI trigger output:

| Method | Description |
|---|---|
| **X32 MIDI (CC channel 2)** | Default: sends CC on MIDI channel 2; value 0 = active, 127 = muted |
| **Custom MIDI** | Freely configurable MIDI messages (Note On/Off, CC, Program Change, or SysEx/hex bytes). `{ch}` is replaced by the role's channel index (0-based). |
| **Custom OSC** | Sends separate OSC paths for mute (OFF) and unmute (ON). `{ch}` is replaced by the role's channel number (1-based, two digits). |

### Other

| Setting | Description |
|---|---|
| Emergency Light note | MIDI note for the emergency light button (channel + note number) |
| Language | App interface language (German / English) |
| Open in editor (right-click) | A command that opens a line of the show file in a text editor (`{file}` and `{line}` are filled in); empty: off |
| Markdown line numbers | Shows, left of every block, the line of the show file it begins on |
| Vim keys in the text editor | Normal and insert mode in the inline editor (see [Inline Editor](#inline-editor)) |
| Auto mic: switch microphones off after | Seconds an Auto-Mic cue leaves a microphone on that it switches off (default 7; 0 = at once) |
| Block output to devices | Nothing is sent to MIDI, OSC, HTTP, displays or timecode |
| Mic group display | When enabled, groups are shown as one outlined label each (groups first, then single roles). Disable for a flat list of roles. |
| Open locked | When enabled, the script editing lock is activated automatically on startup. |

Settings belong to the machine, not to the show: they are stored in `settings.json` in the app's settings folder (macOS: `~/Library/Application Support/MDstage`), so the same show file can use different devices on different computers. The show file only declares which devices and virtual channels the show needs.

---

## Export (PDF / DOCX)

`Cmd/Ctrl+E` opens the export dialog:

- **Include cues:** Whether trigger blocks (mic, music, etc.) appear in the export
- **Role colours:** Whether role names are shown in colour
- **Grouped mics:** Whether mic assignments in cue tables are rendered as labelled group boxes (enabled) or as a flat list of role names (disabled)
- **Include timestamps:** Whether the recorded trigger time (`HH:MM:SS`) of each cue is written into the cue tables. Timestamps are captured live whenever a cue is triggered (overwritten on each re-trigger) and are **session-only** — they are never saved to the show `.md`; this option is the only way they leave the app.

**Output formats:**

- **PDF** – print-optimised A4 document with title page, table of contents, and page numbers
- **DOCX** – Word document with identical structure (Times New Roman, correct heading hierarchy)

Each S/L/F group receives a label (`Start`, `Loop`, `Finish`, `Bridge`).

---

## Scene Sidebar & Search

### Scene Sidebar

- **`Cmd/Ctrl+B`** or the sidebar button opens/closes the sidebar
- Lists all `#`, `##`, and `###` headings
- Clicking scrolls to the scene; the active scene is highlighted while scrolling
- First-level headings are numbered as scenes (a title heading that opens the file is not counted). A heading that begins with a number of its own (`# 7 In the garden`, `# 12. Finale`) has that number, and the count goes on from it. **Typing a number** outside any text field goes to that scene: `2` for scene 2, `1` then `7` for scene 17.
- The current scene is also shown in a line above the script.

### Full-Text Search

- **`Cmd/Ctrl+F`** opens the search bar
- All matches are highlighted; **Enter** / **Shift+Enter** navigates forwards/backwards
- **Escape** closes the search

---

## Script Formatting

When a file is opened, the app checks whether the script meets the formatting standard:

- Blank line after every heading
- Blank line before/after every stage direction
- Blank line before every role name
- Long dialogue lines are wrapped at sentence boundaries
- Multiple consecutive blank lines are collapsed to one

If formatting is needed, a backup copy (`*~unformatted.md`) is created before the file is reformatted.

A file that was last saved on another machine is not touched by opening it: it is shown formatted, but nothing is written into its folder until you change something. MDstage never writes through symbolic links in a show folder.

---

## Keyboard Shortcuts

| Shortcut | Function |
|---|---|
| `Cmd/Ctrl+N` | New file |
| `Cmd/Ctrl+O` | Open file |
| `Cmd/Ctrl+,` | Settings |
| `Cmd/Ctrl+L` | Open live view |
| `Cmd/Ctrl+E` | Export |
| `Cmd/Ctrl+B` | Toggle sidebar |
| `Cmd/Ctrl+F` | Search |
| `Space` | Live view: Go. Main window: Go only while the show is locked; otherwise play/pause of the audio whose playhead was last moved on its waveform (nothing after a cue was fired by a click) |
| `Backspace` | Back (when live view is open, no editor active) |
| `Shift+Click` | Edit block |
| `Tab` | Accept role name autocomplete |
| `Shift+Enter` | Line break inside a role block |
| `Escape` | Close editor / search |
| digits | Go to the scene with that number |

---

## Development & Build

MDstage is a Rust workspace:

| Crate | Contents |
|---|---|
| `crates/mdstage-core` | Reading and writing the show file, cue logic, checks — no I/O |
| `crates/mdstage-engine` | Audio, MIDI, timecode, OSC, HTTP, display server, the running show |
| `crates/mdstage-app` | The user interface (egui) and the export |

```bash
cargo test --workspace                          # all tests
cargo run --release -p mdstage-app -- SHOW.md   # run the app

scripts/bundle-macos.sh --dmg                   # target/bundle/MDstage.app and .dmg
scripts/bundle-appimage.sh                      # AppImage (on Linux)
```

Linux needs the development packages of ALSA, X11/Wayland and GTK 3 (on Debian/Ubuntu:
`libasound2-dev libxkbcommon-dev libwayland-dev libx11-dev libxcb1-dev libgtk-3-dev`).

Packages for all targets are built by GitHub Actions (`.github/workflows/build.yml`); a tag
(`2.0.0`, without `v`) makes a release.

Audio files go in the `audio/` subfolder next to the `.md` file. Use WAV format for seamless S/L/F transitions.
