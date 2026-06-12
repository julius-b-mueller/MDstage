<img src="dist/assets/icon.png" width="120" alt="MDstage Icon">

# MDstage

Electron-based stage manager app for live shows and theatre productions. The script is stored as a Markdown file; cues are embedded directly as YAML blocks. The app provides audio playback, MIDI control, timecode output, OSC output, and a live view — all from a single file.

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
    settings:
        MacBookPro:
            mainAudioDevice: "Blackmagic Audio"
            monitorAudioDevice: "Built-in Output"
            monitorOffsetMs: 0
            outputDevices:
                - name: "Licht"
                  type: midi
                  device: "IAC Driver"
                  color: yellow
                  sendTriggerNote: true
                - name: "QLab"
                  type: osc
                  enabled: true
                  host: 192.168.1.5
                  port: 53000
                  sendTriggerNote: false
            midiX32Device: "X32"
            midiTCDevice: "IAC Driver"
            midiGoNote: {ch: 1, note: 36}
            midiBackNote: {ch: 1, note: 37}
            editorApp: vscode
```

---

## Inline Editor

The script can be edited directly inside the app — no external editor required.

- **Shift+Click** on a text block opens it for editing
- **Enter** closes the block and opens a new one below
- **Tab** accepts the suggested role name (autocomplete)
- **Shift+Enter** inserts a line break inside a role block
- **Arrow up / down** moves to the previous / next block
- **Escape** closes the editor without saving
- **▲ / ▼** buttons move the block up or down
- **✕** button deletes the block

Right-clicking a block (if an editor is configured) opens the corresponding line in the external editor (VS Code, Zed, or a custom command).

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

Every YAML block (except the config block) is a **cue** (trigger). It is displayed as a numbered control panel in the script.

### Cue Fields

| Field | Description |
|---|---|
| `trigger_note: {ch: 1, note: 42}` | MIDI note sent when the cue fires. Assigned automatically if not set. |
| `mic: "Anna"` | Role name(s) or group name(s) whose microphone channels are opened. All others are muted. `muteall` mutes everyone. Group names expand to all member roles. Not used when Auto-Mic is active. |
| `auto_mic: true` | Enables Auto-Mic for this cue (see [Auto-Mic](#auto-mic)). |
| `music: file.wav` | Audio file from the `audio/` subfolder. Short form or object (see below). |
| `light: "Scene A"` | Free-text note for the lighting operator (documentation only). |
| `note: "Note"` | Internal note displayed on the trigger panel. |
| `start_tc: "01:00:00:00"` | Start timecode (HH:MM:SS:FF, 25 fps) sent as MTC when the cue fires. |
| `osc: "/path/{ch}"` | OSC message path sent when the cue fires (legacy — see [OSC Output](#osc-output)). |
| `cue_midi: [...]` | List of MIDI messages sent when the cue fires (see [MIDI](#midi)). |
| `cue_osc: [...]` | List of OSC messages sent when the cue fires (see [OSC Output](#osc-output)). |
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
    monitor: loop-monitor.wav
```

### Editing a Cue

Every trigger has an **✎ Edit** button that opens a dialog. New cues are added via the **+** button between two blocks.

### Variants

**⊕ Variant** duplicates a cue as a `sibling`. Variants are shown as a group. In live operation, a variant can be selected before Go; if none is selected, the first variant always fires.

---

## Auto-Mic

The **🎙 Auto-Mic** button in the cue action row enables automatic microphone assignment. Instead of selecting microphone channels manually, the app scans the script text and opens exactly the microphones whose roles have dialogue in the section that follows.

### How it works

- Click **🎙 Auto-Mic** on a cue to make it an Auto-Mic cue (`auto_mic: true` is saved in the YAML block).
- **Shift+Click** removes the Auto-Mic flag.
- When an Auto-Mic cue fires, the app looks at all role blocks with dialogue between that cue and the **next** Auto-Mic cue in the script. All matching microphone channels are opened; everything else is muted.
- The **last** Auto-Mic cue (no further Auto-Mic cue after it) mutes all channels.
- The computed microphone list is shown in the cue header.

### Manual selection is disabled when Auto-Mic is in use

Once any Auto-Mic cue exists in the script, manual microphone selection is disabled on **all** cues (the edit dialog shows an informational note instead of checkboxes). This prevents conflicts between auto and manual assignments.

### Live updates

The computed microphone list is derived at runtime from the script text — editing role dialogue updates the mic list automatically. The `auto_mic: true` flag itself is stored in the YAML block, but the resulting channel list is not. Existing manual `mic` entries are preserved in their YAML blocks even while Auto-Mic is active.

---

## Audio Playback

Audio files (MP3 or WAV) are located in the `audio/` subfolder next to the `.md` file.

### Waveform View

Every cue with an audio file shows an interactive waveform:

- **▶ / ⏸** – Play / Pause
- **⏹** – Stop and return to start point
- **+ / −** – Zoom (10–400 px/s)
- **⟳** – Toggle loop mode
- **Volume slider** – Volume 0–100 %

**Shift+Drag** on the waveform markers:

| Marker | Function |
|---|---|
| Lower start marker | Move playback start point |
| Lower end marker | Move playback end point |
| Upper start marker | Move fade-in end point |
| Upper end marker | Move fade-out start point |

All changes (volume, start/end, fades, loop) are saved automatically to the YAML file.

### Dual Output (Main + Monitor)

Two different audio output devices can be configured in settings:

- **Main audio** – goes to the front-of-house system
- **Monitor audio** – goes to the stage manager monitor (e.g. headphones)

If no separate monitor device is set, no monitor signal is generated. A per-cue `monitor: file.wav` can specify a separate monitor mix file (e.g. with a click track). A configurable **Monitor Offset** (ms) shifts the monitor signal in time relative to the main signal.

### Audio Channel Routing

When using a multi-channel audio interface or an **Aggregate Device** (macOS Audio MIDI Setup), the settings panel shows a routing table. Each audio source (main L/R, monitor L/R) can be freely assigned to any output channel of the device. This allows sending main and monitor to separate physical outputs without needing two separate audio interfaces.

To test each channel assignment directly from the settings window, use the **▶** button in the test column.

### Note: Use WAV for Seamless Transitions

MP3 and AAC files contain encoder padding (silent frames at the beginning/end) that prevents seamless transitions. **Use WAV files** for all S/L/F structures and loop transitions.

---

## S/L/F – Start / Loop / Finish

Seamless transitions between audio clips without silence or clicks, using `AudioBufferSourceNode` (sample-accurate).

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
- Audio from `fading_point` to `end` plays as a tail — an outgoing overlap while the next cue (Devamp) starts.
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

Each `music_seq` entry supports the same fields as the `music` object: `file`, `volume`, `start`, `end`, `fadein`, `fadeout`, `fading_point`, `monitor`.

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

A cue can be triggered automatically when audio playback reaches a specific position.

**Setup:**
1. Scrub the source cue's audio to the desired position and pause
2. Click **⏱ Auto-Cue** on the target cue
3. Click the source cue (pick mode)

The auto-cue marker appears on the source cue's waveform. **Shift+Drag** repositions the marker. **Shift+Click** on the Auto-Cue button deletes the auto-cue.

### YAML Representation

```yaml
auto_trigger:
    trigger_note: {ch: 1, note: 3}
    at: 45.2
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

A dedicated **TC** MIDI device can be set in Settings for MTC output. See [Timecode (MTC)](#timecode-mtc).

### MIDI Input

Two configurable MIDI notes for **Go** and **Back** — received on all MIDI inputs. Notes can be assigned using **MIDI Learn** mode in the settings window.

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

## Timecode (MTC)

The app generates MIDI Timecode (25 fps) synchronised to audio playback.

- When a cue with `start_tc` fires, MTC starts from that offset
- In S/L/F chains, timecode counts on without gaps
- Scrubbing on the waveform updates the TC via a Full Frame message
- The current TC is shown in the app header
- Derived timecodes for follow-on cues in an S/L/F chain are calculated and displayed automatically

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
- Per-cue Stop button for immediate stop

The live view communicates bidirectionally with the main window. Go/Back in the live window works exactly like in the main window.

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
| **Go** (Space, when live view is open) | Fire next cue |
| **Back** (Backspace, when live view is open) | Undo last cue (fade-out + undo) |
| MIDI Go/Back | Configurable MIDI notes |
| Show current cue | Scrolls to current position |

Double-clicking a playing cue **stops** it immediately (undo function).

### Cue History (Back)

Back fades the last-fired audio out over 500 ms, restores the previous cue state, and undoes mic changes.

**Behavior after a jump:** Back always follows the actual trigger history, not the script order. If a cue was reached by jumping (clicking it directly), Back returns to the cue that was active before the jump — not to the cue that precedes it in the script.

**Device state restoration (MIDI/OSC):** When Back pops a cue, the app checks which output devices that cue addressed via `cue_midi` / `cue_osc`. For each such device, it scans backwards through the remaining cue history and resends the message set from the most recent earlier cue that addressed the same device. If no earlier cue addressed that device, nothing is sent — the device is left in its current state.

The old `osc:` field and `trigger_note` are **not** part of this restoration mechanism. Only `cue_midi` and `cue_osc` messages participate in device state tracking.

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

When a cue fires, the group is expanded to all its member roles for MIDI/OSC routing. In the cue panel and live view, the group is shown as a labelled box containing the individual role chips.

The built-in group **Alle** (German) / **All** (English) always refers to all defined roles and cannot be created manually.

### Group display in the cue panel and live view

Mic assignments are shown as grouped chips by default. The display can be switched to individual chips (flat list) via **Settings → Mic group display**.

---

## Settings

**Settings…** (`Cmd/Ctrl+,`) opens:

### Audio

| Setting | Description |
|---|---|
| Audio device | Output device for main and monitor signal |
| Monitor Mix enabled | Activates the monitor mix |
| Channel routing table | Assigns main L/R and monitor L/R to specific output channels of the device (for multi-channel interfaces or Aggregate Devices) |
| Monitor Offset (ms) | Time offset of the monitor signal relative to the main signal |

### Output Devices (MIDI + OSC)

The unified device list manages all MIDI and OSC output devices. Each device has:

| Property | Description |
|---|---|
| Name | Display name — used in `cue_midi` / `cue_osc` to target the device |
| Type | `midi` or `osc` |
| Colour | Optional colour shown as a badge on trigger panels |
| Send trigger note | If enabled, this MIDI device receives the cue's `trigger_note` when a cue fires |
| Device (MIDI) | System MIDI port name |
| Host / Port (OSC) | UDP target address |

### MIDI Input

| Setting | Description |
|---|---|
| MIDI Timecode device | MIDI output for MTC (separate from output devices) |
| Input device (Go / Back) | Filter MIDI input to a specific device, or receive from all |
| Go note / Back note | MIDI notes for Go and Back — can be assigned via **MIDI Learn** |

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
| Open in editor (right-click) | VS Code, Zed, or disabled |
| Mic group display | When enabled, mic chips in the cue panel and live view are bundled into labelled group boxes. Disable for a flat chip list. |
| Open locked | When enabled, the script editing lock is activated automatically on startup. |

Settings are stored **per hostname** in the config block of the script file, so the same file can use different devices on multiple computers.

---

## Export (PDF / DOCX)

`Cmd/Ctrl+E` opens the export dialog:

- **Include cues:** Whether trigger blocks (mic, music, light, etc.) appear in the export
- **Role colours:** Whether role names are shown in colour
- **Grouped mics:** Whether mic assignments in cue tables are rendered as labelled group boxes (enabled) or as a flat list of role names (disabled)

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
| `Space` | Go (when live view is open, no editor active) |
| `Backspace` | Back (when live view is open, no editor active) |
| `Shift+Click` | Edit block |
| `Tab` | Accept role name autocomplete |
| `Shift+Enter` | Line break inside a role block |
| `Escape` | Close editor / search / sidebar |

---

## Development & Build

```bash
# Install dependencies
npm install

# Start Webpack in watch mode
npm run develop

# Start Electron
npm start

# Production build (macOS .dmg / Windows .exe)
npm run build
```

Audio files go in the `audio/` subfolder next to the `.md` file. Use WAV format for seamless S/L/F transitions.
