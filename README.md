# Main Desk

Electron-based stage manager app for live shows and theatre productions. The script is stored as a Markdown file; cues are embedded directly as YAML blocks. The app provides audio playback, MIDI control, timecode output, OSC output, and a live view — all from a single file.

---

## Table of Contents

1. [Script Format](#script-format)
2. [Inline Editor](#inline-editor)
3. [Cue System (Triggers)](#cue-system-triggers)
4. [Audio Playback](#audio-playback)
5. [S/L/F – Start / Loop / Finish](#slf--start--loop--finish)
6. [Auto-Cue](#auto-cue)
7. [Adjust (Cross-Fade / Volume)](#adjust-cross-fade--volume)
8. [MIDI](#midi)
9. [OSC Output](#osc-output)
10. [Timecode (MTC)](#timecode-mtc)
11. [Live View](#live-view)
12. [Emergency Controls](#emergency-controls)
13. [Cue Navigation](#cue-navigation)
14. [Role Editor](#role-editor)
15. [Settings](#settings)
16. [Export (PDF / DOCX)](#export-pdf--docx)
17. [Scene Sidebar & Search](#scene-sidebar--search)
18. [Script Formatting](#script-formatting)
19. [Keyboard Shortcuts](#keyboard-shortcuts)

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

---

## Cue System (Triggers)

Every YAML block (except the config block) is a **cue** (trigger). It is displayed as a numbered control panel in the script.

### Cue Fields

| Field | Description |
|---|---|
| `trigger_note: {ch: 1, note: 42}` | MIDI note sent when the cue fires. Assigned automatically if not set. |
| `mic: "Anna"` | Role name(s) whose microphone channel on the X32 is opened. All others are muted. `muteall` mutes everyone. |
| `music: file.wav` | Audio file from the `audio/` subfolder. Short form or object (see below). |
| `light: "Scene A"` | Free-text note for the lighting operator (documentation only). |
| `note: "Note"` | Internal note displayed on the trigger panel. |
| `start_tc: "01:00:00:00"` | Start timecode (HH:MM:SS:FF, 25 fps) sent as MTC when the cue fires. |
| `osc: "/path/{ch}"` | OSC message path sent when the cue fires (see [OSC Output](#osc-output)). |
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
    loop: true
    monitor: loop-monitor.wav
```

### Editing a Cue

Every trigger has an **✎ Edit** button that opens a dialog. New cues are added via the **+** button between two blocks.

### Variants

**⊕ Variant** duplicates a cue as a `sibling`. Variants are shown as a group. In live operation, a variant can be selected before Go; if none is selected, the first variant always fires.

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

### Managed Loop with Outro (`loop_outro`)

```yaml
# Loop cue
music: loop.wav
loop_outro: {ch: 1, note: 6}   # note of the outro cue

---

# Outro cue
trigger_note: {ch: 1, note: 6}
music: outro.wav
```

The loop cue loops indefinitely. Clicking the outro cue **queues** it — it then starts exactly at the next loop end, seamlessly. A second click cancels the queue.

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

Three configurable MIDI output devices:

| Device | Function |
|---|---|
| **X32** | Microphone muting: sends CC on channel 2 for each role channel (0 = active, 127 = muted) |
| **Trigger** | Sends Note On / Off when a cue fires (according to `trigger_note`) |
| **TC** | MIDI Timecode output (MTC, 25 fps) |

### MIDI Input

Two configurable MIDI notes for **Go** and **Back** — received on all MIDI inputs. Notes can be assigned using **MIDI Learn** mode in the settings window.

---

## OSC Output

The app can send OSC (Open Sound Control) messages over UDP when a cue fires.

### Enabling OSC

In **Settings**, enable the **OSC** toggle and configure the target **host** and **port**.

### Per-Cue OSC

Add the `osc` field to a cue to send an OSC message when it fires:

```yaml
trigger_note: {ch: 1, note: 10}
osc: /show/cue/go
```

An optional argument can be attached:

```yaml
osc: /show/volume/set
osc_arg: 0.8
osc_arg_type: float   # int | float | string
```

The `{ch}` placeholder in the OSC path is replaced with the role's channel number (two digits, 1-based).

The OSC badge `⌁ /path …` is shown on the trigger panel.

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

---

## Role Editor

The **Role Editor…** menu opens a dedicated window for managing roles.

- **Name** of the role
- **Color** (red, green, blue, purple, cyan, yellow, darkred, …) — determines the text colour in the script and in exports
- **MIDI channel** (ch) — the microphone channel on the mixer

Roles can be renamed; all `**Role name**` occurrences in the script are updated automatically.

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

### MIDI

| Setting | Description |
|---|---|
| Trigger MIDI device | MIDI output for cue notes |
| MIDI Timecode device | MIDI output for MTC |
| Input device (Go / Back) | Filter MIDI input to a specific device, or receive from all |
| Go note / Back note | MIDI notes for Go and Back — can be assigned via **MIDI Learn** |

### OSC

| Setting | Description |
|---|---|
| OSC enabled | Activates OSC output |
| Target address | IP address of the OSC receiver |
| Port | UDP port of the OSC receiver |

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

Settings are stored **per hostname** in the config block of the script file, so the same file can use different devices on multiple computers.

---

## Export (PDF / DOCX)

`Cmd/Ctrl+E` opens the export dialog:

- **Include cues:** Whether trigger blocks (mic, music, light, etc.) appear in the export
- **Role colours:** Whether role names are shown in colour

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
