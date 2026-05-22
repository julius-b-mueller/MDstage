"use strict"

const showdown = require('showdown')
const yaml = require('js-yaml')
const WaveSurfer = require('wavesurfer.js')

let config = {}
let usedChs = []
let triggers = []
let triggerYamls = []

// triggerIndex -> { ws: WaveSurfer, wsMonitor: WaveSurfer|null, musicFile: string }
const triggerAudio = new Map()
// musicFile -> triggerIndex[]  (for cross-trigger fade lookups)
const fileToTriggers = new Map()

let mainAudioDevice = null
let monitorAudioDevice = null
let monitorOffsetMs = 0

function monitorShouldPlay() {
    if (!monitorAudioDevice) return false
    if (monitorAudioDevice === mainAudioDevice) return false
    return true
}

let scriptText = ''

const MIC_SVG = `<svg class="t-icon" viewBox="0 0 12 18" width="10" height="15" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="3" y="0.5" width="6" height="9" rx="3"/><line x1="3.5" y1="3.5" x2="8.5" y2="3.5" stroke-width="0.55"/><line x1="3.5" y1="6" x2="8.5" y2="6" stroke-width="0.55"/><path d="M1 8 Q6 13.5 11 8"/><line x1="6" y1="11.5" x2="6" y2="15"/><line x1="3" y1="15" x2="9" y2="15"/></svg>`

const TAPE_SVG = `<svg class="t-icon" viewBox="0 0 22 12" width="22" height="12" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><circle cx="5" cy="6" r="4"/><circle cx="5" cy="6" r="1.3"/><line x1="5" y1="2" x2="5" y2="4.7"/><line x1="1.5" y1="8" x2="3.9" y2="6.7"/><line x1="8.5" y1="8" x2="6.1" y2="6.7"/><circle cx="17" cy="6" r="4"/><circle cx="17" cy="6" r="1.3"/><line x1="17" y1="2" x2="17" y2="4.7"/><line x1="13.5" y1="8" x2="15.9" y2="6.7"/><line x1="20.5" y1="8" x2="18.1" y2="6.7"/><line x1="9" y1="2" x2="13" y2="2"/><line x1="9" y1="10" x2="13" y2="10"/></svg>`

let currentCue = 0
let pickModeCallback = null
let midiAccess = null
let midiX32 = null
let midiTrigger = null
let midiTC = null
let mtc = null

// Kick off MIDI access request immediately at module load, before any async init.
// Electron 36 / Chromium requires this to be initiated early to avoid the
// promise hanging when called deep inside an async IPC callback chain.
const _midiAccessPromise = navigator.requestMIDIAccess({ sysex: true })
    .catch(e => { console.error('MIDI-Zugriff fehlgeschlagen:', e); return null })

let shiftHeld = false
document.addEventListener('keydown', (e) => { if (e.key === 'Shift') { shiftHeld = true; document.body.classList.add('shift-held') } }, { capture: true })
document.addEventListener('keyup',   (e) => { if (e.key === 'Shift') { shiftHeld = false; document.body.classList.remove('shift-held') } }, { capture: true })
window.addEventListener('blur', () => { shiftHeld = false; document.body.classList.remove('shift-held') })


const converter = new showdown.Converter

class MTCTransmitter {
    constructor() {
        this.output = null
        this.intervalId = null
        this.qfIndex = 0
        this.lastFrames = 0
        this.latchedFrames = 0
        this.startFrames = 0
        this.wsRef = null
        this.activeTcIndex = null
        this.displayEl = null
    }

    setOutput(output) { this.output = output }
    setDisplay(el) { this.displayEl = el }

    _parseTC(str) {
        const [h, m, s, f] = str.split(':').map(Number)
        return ((h * 3600 + m * 60 + s) * 25) + f
    }

    _framesToStr(total) {
        const fps = 25
        const ff = total % fps
        const secs = Math.floor(total / fps)
        const ss = secs % 60
        const mins = Math.floor(secs / 60)
        const mm = mins % 60
        const hh = Math.floor(mins / 60) % 24
        const p = n => String(n).padStart(2, '0')
        return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
    }

    _decompose(frames) {
        const fps = 25
        const ff = frames % fps
        const secs = Math.floor(frames / fps)
        const ss = secs % 60
        const mins = Math.floor(secs / 60)
        const mm = mins % 60
        const hh = Math.floor(mins / 60) % 24
        return { hh, mm, ss, ff }
    }

    _sendFullFrame(frames) {
        if (!this.output) return
        const { hh, mm, ss, ff } = this._decompose(frames)
        const hhByte = (0b01 << 5) | hh  // 25fps type bits 6:5
        this.output.send([0xF0, 0x7F, 0x7F, 0x01, 0x01, hhByte, mm, ss, ff, 0xF7])
    }

    _sendQF(frames) {
        if (!this.output) return
        const { hh, mm, ss, ff } = this._decompose(frames)
        const i = this.qfIndex
        let nibble
        switch (i) {
            case 0: nibble = ff & 0x0F; break
            case 1: nibble = (ff >> 4) & 0x01; break
            case 2: nibble = ss & 0x0F; break
            case 3: nibble = (ss >> 4) & 0x03; break
            case 4: nibble = mm & 0x0F; break
            case 5: nibble = (mm >> 4) & 0x03; break
            case 6: nibble = hh & 0x0F; break
            case 7: nibble = ((hh >> 4) & 0x01) | (0b01 << 1); break  // 25fps rate bits
            default: nibble = 0
        }
        this.output.send([0xF1, (i << 4) | nibble])
    }

    _tick() {
        const wsTime = this.wsRef ? this.wsRef.getCurrentTime() : 0
        const frames = this.startFrames + Math.floor(wsTime * 25)

        // At the start of each 8-message cycle: latch the frame number so all
        // 8 QF messages encode the same TC value, and detect scrubs.
        if (this.qfIndex === 0) {
            if (Math.abs(frames - this.lastFrames) > 8) {
                try { this._sendFullFrame(frames) } catch (e) {}
            }
            this.latchedFrames = frames
            this.lastFrames = frames
        }

        try {
            this._sendQF(this.latchedFrames)
        } catch (e) {
            console.error('MTC send error:', e)
        }

        this.qfIndex = (this.qfIndex + 1) % 8

        if (!this.displayEl) this.displayEl = document.querySelector('.tc-display')
        if (this.displayEl) this.displayEl.textContent = this._framesToStr(frames)
    }

    start(startTcStr, ws, triggerIndex) {
        this.stop()
        // Ensure display element is current after any DOM rebuild
        if (!this.displayEl) this.displayEl = document.querySelector('.tc-display')
        this.startFrames = this._parseTC(startTcStr)
        this.wsRef = ws
        this.activeTcIndex = triggerIndex
        this.qfIndex = 0
        this.lastFrames = this.startFrames
        this.latchedFrames = this.startFrames
        try { this._sendFullFrame(this.startFrames) } catch (e) {}
        if (this.displayEl) this.displayEl.textContent = this._framesToStr(this.startFrames)
        // 25fps × 4 QF/frame = 100 QF/sec → 10ms interval
        this.intervalId = setInterval(() => this._tick(), 10)
    }

    stop() {
        if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null }
        this.wsRef = null
        this.activeTcIndex = null
    }

    stopAndClear() {
        this.stop()
        if (this.displayEl) this.displayEl.textContent = '--:--:--:--'
    }
}

function noteToName(note) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return names[note % 12] + (Math.floor(note / 12) - 1)
}

function scrollToTrigger(cue) {
    triggers[cue].scrollIntoView({ behavior: "smooth", block: "center" })
}

function groupRootOf(idx) {
    while (idx >= 1 && triggerYamls[idx]?.sibling) idx--
    return idx
}

function markTriggers(cue) {
    const cueRoot = groupRootOf(cue)
    for (let index = 1; index < triggers.length; index++) {
        if (!triggers[index]) continue
        const root = groupRootOf(index)
        let shouldMark
        if (root === cueRoot) {
            // Same group as current cue: only the clicked trigger gets marked
            shouldMark = index === cue
        } else if (root < cueRoot) {
            // Past group: only mark the group root (shows "this position was passed")
            shouldMark = index === root
        } else {
            shouldMark = false
        }
        triggers[index].classList.toggle("trigger-marked", shouldMark)
    }
}

function applyAudioDevices() {
    for (const { mainAudioEl, monAudioEl, wsMonitor } of triggerAudio.values()) {
        if (mainAudioEl?.setSinkId)
            mainAudioEl.setSinkId(mainAudioDevice || '').catch(() => {})
        if (monAudioEl) {
            if (monitorShouldPlay()) {
                monAudioEl.setSinkId(monitorAudioDevice).catch(() => {})
            } else {
                if (wsMonitor?.isPlaying()) wsMonitor.stop()
            }
        }
    }
}

function groupSiblingTriggers() {
    const content = document.getElementById('script-content')
    const children = [...content.children]
    for (const el of children) {
        const tidx = el.dataset.triggerIndex !== undefined ? parseInt(el.dataset.triggerIndex) : NaN
        if (isNaN(tidx) || !triggerYamls[tidx]?.sibling) continue
        const prev = el.previousElementSibling
        if (!prev) continue
        if (prev.classList.contains('trigger-group')) {
            prev.appendChild(el)
        } else {
            const group = document.createElement('div')
            group.classList.add('trigger-group')
            prev.replaceWith(group)
            group.appendChild(prev)
            group.appendChild(el)
        }
    }
}

function rerender(newText) {
    const scrollY = window.scrollY

    for (const { ws, wsMonitor } of triggerAudio.values()) {
        try { ws.destroy() } catch (e) {}
        if (wsMonitor) { try { wsMonitor.destroy() } catch (e) {} }
    }

    triggers = []
    triggerYamls = []
    triggerAudio.clear()
    fileToTriggers.clear()
    usedChs = []
    config = {}

    document.getElementById('script-content').innerHTML = converter.makeHtml(newText)
    convertCodeblocks()
    colorText()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
    buildInsertZones()

    requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }))
}

function tokenizeScript(text) {
    const blocks = []
    const yamlRe = /```yaml\n[\s\S]*?```/g
    let lastEnd = 0, m
    while ((m = yamlRe.exec(text)) !== null) {
        const before = text.slice(lastEnd, m.index)
        before.split(/\n\n+/).forEach(p => { if (p.trim()) blocks.push({ type: 'text', content: p.trim() }) })
        blocks.push({ type: 'yaml', content: m[0] })
        lastEnd = m.index + m[0].length
    }
    text.slice(lastEnd).split(/\n\n+/).forEach(p => { if (p.trim()) blocks.push({ type: 'text', content: p.trim() }) })
    return blocks
}

// Annotates each direct child of #script-content with data-block-idx (1-based, skipping config).
function annotateBlocks() {
    const content = document.getElementById('script-content')
    ;[...content.children].forEach((el, k) => { el.dataset.blockIdx = k + 1 })
}

function findTriggerByNote(tn) {
    if (!tn) return null
    for (let i = 1; i < triggerYamls.length; i++) {
        const t = triggerYamls[i]
        if (t && t.trigger_note && t.trigger_note.ch === tn.ch && t.trigger_note.note === tn.note) return i
    }
    return null
}

function _pickEscHandler(e) { if (e.key === 'Escape') exitPickMode() }

function enterPickMode(cb) {
    pickModeCallback = cb
    document.body.classList.add('trigger-pick-mode')
    document.addEventListener('keydown', _pickEscHandler)
}

function exitPickMode() {
    pickModeCallback = null
    document.body.classList.remove('trigger-pick-mode')
    document.removeEventListener('keydown', _pickEscHandler)
}

function markControlledTriggers() {
    document.querySelectorAll('.trigger-controlled-indicator').forEach(el => el.remove())
    for (let i = 1; i < triggerYamls.length; i++) {
        const ty = triggerYamls[i]
        if (!ty?.music || typeof ty.music !== 'object') continue
        const adj = ty.music.adjust
        if (!adj?.trigger_note) continue
        const targetIdx = findTriggerByNote(adj.trigger_note)
        if (targetIdx !== null && triggers[targetIdx]) {
            const tn = ty.trigger_note
            const indicator = document.createElement('span')
            indicator.classList.add('trigger-controlled-indicator')
            indicator.textContent = `⇠ ${tn ? tn.ch + '.' + tn.note : '?'}`
            indicator.title = `Wird von ${tn ? tn.ch + '.' + tn.note : '?'} gesteuert`
            triggers[targetIdx].querySelector('.trigger-music')?.appendChild(indicator)
        }
    }
}

// Moves a trigger block one step up or down in the script and rerenders in place.
function moveTriggerInScript(triggerIndex, direction) {
    if (!scriptText) return

    const blocks = tokenizeScript(scriptText)

    // Identify the config block (first yaml) so we never move past it.
    const configIdx = blocks.findIndex(b => b.type === 'yaml')

    // Find the target yaml block (skip config: yamlCount starts at 1 for config).
    let yamlCount = 0, pos = -1
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'yaml') {
            yamlCount++
            if (yamlCount === triggerIndex + 1) { pos = i; break }
        }
    }
    if (pos === -1) return

    if (direction === 'up') {
        const prev = pos - 1
        if (prev < 0 || prev === configIdx) return
        ;[blocks[prev], blocks[pos]] = [blocks[pos], blocks[prev]]
    } else {
        const next = pos + 1
        if (next >= blocks.length) return
        ;[blocks[pos], blocks[next]] = [blocks[next], blocks[pos]]
    }

    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    rerender(updated)
}

// Inserts a new trigger YAML block after the block at insertAfterBlockIdx.
// Block indices correspond to DOM child index + 1 (blocks[0] = config, not in DOM).
function insertTriggerInScript(insertAfterBlockIdx, newYaml) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    if (insertAfterBlockIdx < 0 || insertAfterBlockIdx >= blocks.length) return
    const newBlock = { type: 'yaml', content: '```yaml\n' + yaml.dump(newYaml, { indent: 4 }).trimEnd() + '\n```' }
    blocks.splice(insertAfterBlockIdx + 1, 0, newBlock)
    let updated = blocks.map(b => b.content).join('\n\n') + '\n'
    const { text: assigned, changed } = assignTriggerNotes(updated)
    if (changed) updated = assigned
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    rerender(updated)
}

// Splits the text block at blockIdx into two halves and inserts a trigger between them.
function splitBlockAndInsertTrigger(blockIdx, mdBefore, mdAfter, newYaml) {
    const blocks = tokenizeScript(scriptText)
    const newYamlBlock = { type: 'yaml', content: '```yaml\n' + yaml.dump(newYaml, { indent: 4 }).trimEnd() + '\n```' }
    const replacements = []
    if (mdBefore.trim()) replacements.push({ type: 'text', content: mdBefore.trim() })
    replacements.push(newYamlBlock)
    if (mdAfter.trim()) replacements.push({ type: 'text', content: mdAfter.trim() })
    blocks.splice(blockIdx, 1, ...replacements)
    let updated = blocks.map(b => b.content).join('\n\n') + '\n'
    const { text: assigned, changed } = assignTriggerNotes(updated)
    if (changed) updated = assigned
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    rerender(updated)
}

// Updates all music playback properties in the correct YAML block in scriptText.
function updateMusicPropsInScript(triggerIndex, mp) {
    let blockIdx = 0
    const updated = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIdx++
        if (blockIdx !== triggerIndex + 1) return match

        let c = content
        // Expand scalar form: music: filename → music:\n    file: filename
        c = c.replace(/^music: (\S+)/m, 'music:\n    file: $1')

        const fileMatch = c.match(/^    file: (.+)$/m)
        if (!fileMatch) return match

        const fmt = (n) => parseFloat(n.toFixed(3)).toString()
        const lines = ['    file: ' + fileMatch[1].trim()]
        if (mp.volume  != null)    lines.push('    volume: '  + fmt(mp.volume))
        if (mp.start   > 0)        lines.push('    start: '   + fmt(mp.start))
        if (mp.end     != null)    lines.push('    end: '     + fmt(mp.end))
        if (mp.fadein  > 0)        lines.push('    fadein: '  + fmt(mp.fadein))
        if (mp.fadeout > 0)        lines.push('    fadeout: ' + fmt(mp.fadeout))
        if (mp.loop)               lines.push('    loop: true')

        // Replace the entire music: block (all consecutively indented lines)
        c = c.replace(/^music:(?:\n    [^\n]*)*/m, 'music:\n' + lines.join('\n'))

        return `\`\`\`yaml\n${c}\`\`\``
    })
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    if (triggerYamls[triggerIndex]) {
        if (typeof triggerYamls[triggerIndex].music === 'string') {
            triggerYamls[triggerIndex].music = { file: triggerYamls[triggerIndex].music }
        }
        Object.assign(triggerYamls[triggerIndex].music, mp)
    }
}

function blockIdxForTrigger(triggerIndex) {
    const blocks = tokenizeScript(scriptText)
    let yamlCount = 0
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'yaml' && ++yamlCount === triggerIndex + 1) return i
    }
    return -1
}

function buildTrigger(codeblockYaml, index) {
    const triggerDiv = document.createElement("div")
    triggerDiv.classList.add("trigger")
    triggerDiv.dataset.triggerIndex = index

    // ── header row (always present) ─────────────────────────────────────
    const triggerRow = document.createElement("div")
    triggerRow.classList.add("trigger-row")

    const triggerInfo = document.createElement("div")
    triggerInfo.classList.add("trigger-info")
    const triggerNote = document.createElement("div")
    triggerNote.classList.add("trigger-note")
    const triggerNoteDisplay = document.createElement("div")
    triggerNoteDisplay.classList.add("trigger-number")

    const triggerMic = document.createElement("div")
    triggerMic.classList.add("trigger-mic")
    const triggerMusic = document.createElement("div")
    triggerMusic.classList.add("trigger-music")

    triggerInfo.appendChild(triggerMic)
    triggerInfo.appendChild(triggerMusic)
    const triggerMoveDiv = document.createElement("div")
    triggerMoveDiv.classList.add("trigger-move-btns")
    const triggerUpBtn   = document.createElement("button")
    const triggerDownBtn = document.createElement("button")
    triggerUpBtn.classList.add("trigger-move-btn")
    triggerDownBtn.classList.add("trigger-move-btn")
    triggerUpBtn.textContent = "▲"
    triggerDownBtn.textContent = "▼"
    triggerUpBtn.title = "Nach oben"
    triggerDownBtn.title = "Nach unten"
    triggerMoveDiv.append(triggerUpBtn, triggerDownBtn)

    triggerUpBtn.addEventListener("mousedown",   (e) => { e.stopPropagation(); moveTriggerInScript(index, 'up') })
    triggerDownBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); moveTriggerInScript(index, 'down') })

    const rightWrapper = document.createElement("div")
    rightWrapper.style.cssText = "display:flex;align-items:center"
    rightWrapper.appendChild(triggerNoteDisplay)
    rightWrapper.appendChild(triggerMoveDiv)

    triggerRow.appendChild(triggerInfo)
    if (codeblockYaml.note) triggerRow.appendChild(triggerNote)
    triggerRow.appendChild(rightWrapper)
    triggerDiv.appendChild(triggerRow)

    // ── action buttons row ──────────────────────────────────────────────
    const triggerActions = document.createElement("div")
    triggerActions.classList.add("trigger-actions")

    const triggerEditBtn = document.createElement("button")
    triggerEditBtn.classList.add("trigger-action-btn")
    triggerEditBtn.textContent = "✎ Bearbeiten"
    triggerEditBtn.title = "Trigger bearbeiten"
    triggerEditBtn.addEventListener("mousedown", (e) => { e.stopPropagation() })
    triggerEditBtn.addEventListener("click", (e) => {
        e.stopPropagation()
        let parentTriggerNote = null
        if (codeblockYaml.sibling) {
            for (let i = index - 1; i >= 1; i--) {
                if (triggerYamls[i] && !triggerYamls[i].sibling) {
                    parentTriggerNote = triggerYamls[i].trigger_note ?? null
                    break
                }
            }
        }
        showTriggerDialog({ triggerIndex: index, existingYaml: codeblockYaml, parentTriggerNote })
    })
    triggerActions.appendChild(triggerEditBtn)
    triggerDiv.appendChild(triggerActions)

    triggers[index] = triggerDiv

    // mic info
    triggerMic.innerHTML = MIC_SVG
    if (codeblockYaml.mic) {
        let roles = codeblockYaml.mic
        if (roles === "muteall") {
            triggerMic.appendChild(document.createTextNode(" alle aus"))
        } else {
            triggerMic.appendChild(document.createTextNode(" "))
            if (typeof roles === "string") roles = [roles]
            for (let i = 0; i < roles.length; i++) {
                const roleSpan = document.createElement("span")
                roleSpan.innerText = roles[i]
                roleSpan.classList.add("color-" + config.roles[roles[i]].color)
                triggerMic.appendChild(roleSpan)
            }
        }
    } else {
        triggerMic.appendChild(document.createTextNode(" -"))
    }

    // music info
    triggerMusic.innerHTML = TAPE_SVG
    if (codeblockYaml.music) {
        if (typeof codeblockYaml.music === "string") {
            triggerMusic.appendChild(document.createTextNode(" " + codeblockYaml.music))
        } else if (codeblockYaml.music.file) {
            triggerMusic.appendChild(document.createTextNode(" " + codeblockYaml.music.file))
        }
        if (codeblockYaml.music.adjust) {
            const adjTn = codeblockYaml.music.adjust.trigger_note
            const adjRef = adjTn ? `${adjTn.ch}.${adjTn.note}` : '?'
            if (codeblockYaml.music.file) {
                triggerMusic.appendChild(document.createTextNode(", "))
            }
            if (codeblockYaml.music.adjust.fadeout) {
                triggerMusic.appendChild(document.createTextNode(`⇢ ${adjRef} ausfaden`))
            } else if (codeblockYaml.music.adjust.volume !== undefined) {
                triggerMusic.appendChild(document.createTextNode(`⇢ ${adjRef} auf ${codeblockYaml.music.adjust.volume * 100}%`))
            }
        }
    } else {
        triggerMusic.appendChild(document.createTextNode(" -"))
    }

    // text note
    if (codeblockYaml.note) triggerNote.innerText = codeblockYaml.note

    // MIDI note display
    if (codeblockYaml.trigger_note) {
        const { ch, note } = codeblockYaml.trigger_note
        const numStr = `${ch}.${note}`
        const nameStr = `${ch}.${noteToName(note)}`
        triggerNoteDisplay.textContent = numStr
        triggerNoteDisplay.addEventListener('mouseenter', () => { triggerNoteDisplay.textContent = nameStr })
        triggerNoteDisplay.addEventListener('mouseleave', () => { triggerNoteDisplay.textContent = numStr })
    }

    // ── waveform (only when a music file is set) ─────────────────────────
    const musicFile = codeblockYaml.music
        ? (typeof codeblockYaml.music === "string" ? codeblockYaml.music : codeblockYaml.music.file)
        : null

    if (musicFile) {
        const waveformWrapper = document.createElement("div")
        waveformWrapper.classList.add("waveform-wrapper")
        const waveformContainer = document.createElement("div")
        waveformContainer.classList.add("waveform-container")
        waveformWrapper.appendChild(waveformContainer)

        const controlsRow = document.createElement("div")
        controlsRow.classList.add("waveform-controls")

        // Music properties (start/end/fade/loop/volume)
        const musicObj = typeof codeblockYaml.music === 'object' ? codeblockYaml.music : {}
        const mp = {
            volume:  musicObj.volume  ?? 0.8,
            start:   musicObj.start   ?? 0,
            end:     musicObj.end     ?? null,
            fadein:  musicObj.fadein  ?? 0,
            fadeout: musicObj.fadeout ?? 0,
            loop:    !!musicObj.loop,
        }
        let currentVolume = mp.volume
        let saveTimer = null
        const debouncedSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => updateMusicPropsInScript(index, mp), 500) }

        const zoomOutBtn = makeWaveBtn("−", "Herauszoomen")
        const pauseBtn   = makeWaveBtn("⏵", "Wiedergabe / Pause")
        const stopBtn    = makeWaveBtn("⏹", "Stopp")
        const zoomInBtn  = makeWaveBtn("+", "Hineinzoomen")
        const loopBtn    = makeWaveBtn("⟳", "Loop")
        if (mp.loop) loopBtn.classList.add("waveform-btn-active")

        const volSlider = document.createElement("input")
        volSlider.type = "range"; volSlider.min = "0"; volSlider.max = "1"
        volSlider.step = "0.01"; volSlider.value = String(mp.volume)
        volSlider.classList.add("volume-slider"); volSlider.title = "Lautstärke"

        const volLabel = document.createElement("span")
        volLabel.classList.add("volume-label")
        volLabel.textContent = Math.round(mp.volume * 100) + "%"

        controlsRow.append(zoomOutBtn, pauseBtn, stopBtn, zoomInBtn, loopBtn, volSlider, volLabel)
        waveformWrapper.appendChild(controlsRow)
        triggerDiv.appendChild(waveformWrapper)
        controlsRow.addEventListener("mousedown", (e) => e.stopPropagation())

        const state = { zoom: 20 }

        const mainAudioEl = new Audio()
        if (mainAudioDevice) mainAudioEl.setSinkId(mainAudioDevice).catch(() => {})
        const ws = WaveSurfer.create({
            container: waveformContainer,
            media: mainAudioEl,
            waveColor: '#4b5263', progressColor: '#61afef', cursorColor: '#e5c07b',
            height: 64, interact: false, normalize: true, minPxPerSec: state.zoom,
        })
        ws.load("audio/" + musicFile)
        ws.setVolume(mp.volume)

        const totalWaveWidth = () => ws.getWrapper().clientWidth || ws.getDuration() * state.zoom

        // ── Marker overlay ──────────────────────────────────────────────
        const overlay    = document.createElement("div")
        const preRegion  = document.createElement("div")
        const postRegion = document.createElement("div")
        const fadeinReg  = document.createElement("div")
        const fadeoutReg = document.createElement("div")
        overlay.classList.add("waveform-overlay")
        preRegion.classList.add("ws-inactive")
        postRegion.classList.add("ws-inactive")
        fadeinReg.classList.add("ws-fade", "ws-fade-in")
        fadeoutReg.classList.add("ws-fade", "ws-fade-out")

        const mkBar  = (t)    => { const b = document.createElement("div"); b.classList.add("ws-bar",  "ws-bar-"  + t); return b }
        const mkGrip = (p, s) => { const g = document.createElement("div"); g.classList.add("ws-grip", "ws-grip-" + p, "ws-grip-" + s); return g }
        const startBar     = mkBar("start")
        const endBar       = mkBar("end")
        const startBotGrip = mkGrip("bot", "start")
        const startTopGrip = mkGrip("top", "start")
        const endBotGrip   = mkGrip("bot", "end")
        const endTopGrip   = mkGrip("top", "end")
        overlay.append(preRegion, postRegion, fadeinReg, fadeoutReg, startBar, endBar, startBotGrip, startTopGrip, endBotGrip, endTopGrip)

        function updateMarkers() {
            const dur = ws.getDuration()
            if (!dur) return
            const tw = totalWaveWidth(), scroll = ws.getScroll()
            const cw = waveformContainer.clientWidth
            const px = (t) => (t / dur) * tw - scroll
            const sx = px(mp.start), ex = px(mp.end ?? dur)
            const fix = px(mp.start + mp.fadein)
            const fox = px((mp.end ?? dur) - mp.fadeout)
            preRegion.style.left    = "0px"
            preRegion.style.width   = Math.max(0, sx) + "px"
            postRegion.style.left   = Math.max(0, ex) + "px"
            postRegion.style.width  = Math.max(0, cw - Math.max(0, ex)) + "px"
            fadeinReg.style.left    = sx + "px"
            fadeinReg.style.width   = Math.max(0, fix - sx) + "px"
            fadeoutReg.style.left   = fox + "px"
            fadeoutReg.style.width  = Math.max(0, ex - fox) + "px"
            startBar.style.left     = sx  + "px"
            endBar.style.left       = ex  + "px"
            startBotGrip.style.left = sx  + "px"
            startTopGrip.style.left = fix + "px"
            endBotGrip.style.left   = ex  + "px"
            endTopGrip.style.left   = fox + "px"
        }

        function shiftDrag(el, onDrag) {
            el.addEventListener("mousedown", (e) => {
                if (!shiftHeld) return
                e.stopPropagation(); e.preventDefault()
                const move = (me) => {
                    const rect = waveformContainer.getBoundingClientRect()
                    const tw = totalWaveWidth(), dur = ws.getDuration()
                    if (!tw || !dur) return
                    const t = Math.max(0, Math.min(dur, (ws.getScroll() + me.clientX - rect.left) / tw * dur))
                    onDrag(Math.round(t * 1000) / 1000)
                    updateMarkers()
                }
                const up = () => {
                    document.removeEventListener("mousemove", move)
                    document.removeEventListener("mouseup", up)
                    debouncedSave()
                }
                document.addEventListener("mousemove", move)
                document.addEventListener("mouseup", up)
            })
        }
        shiftDrag(startBotGrip, (t) => { mp.start = Math.min(t, (mp.end ?? ws.getDuration()) - 0.05) })
        shiftDrag(endBotGrip,   (t) => {
            const dur = ws.getDuration()
            const ne = Math.max(mp.start + 0.05, t)
            mp.end = (dur - ne < 0.05) ? null : ne
        })
        shiftDrag(startTopGrip, (t) => { mp.fadein  = Math.max(0, Math.min(t - mp.start, (mp.end ?? ws.getDuration()) - mp.start)) })
        shiftDrag(endTopGrip,   (t) => { const e = mp.end ?? ws.getDuration(); mp.fadeout = Math.max(0, Math.min(e - t, e - mp.start)) })

        ws.on("ready",  () => { waveformContainer.appendChild(overlay); updateMarkers() })
        ws.on("scroll", updateMarkers)
        ws.on("zoom",   updateMarkers)
        ws.on("redraw", updateMarkers)

        // ── Playback: fade + stop-at-end + loop ─────────────────────────
        ws.on("timeupdate", (ct) => {
            const effEnd = mp.end ?? ws.getDuration()
            if (ct >= effEnd) {
                if (mp.loop) { ws.play(mp.start) } else { ws.stop(); if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear() }
                ws.setVolume(currentVolume); return
            }
            let f = 1
            const t = ct - mp.start
            if (mp.fadein  > 0 && t >= 0 && t < mp.fadein)            f = t / mp.fadein
            if (mp.fadeout > 0 && (effEnd - ct) < mp.fadeout) f = Math.min(f, (effEnd - ct) / mp.fadeout)
            ws.setVolume(Math.max(0, currentVolume * f))
        })

        ws.on("error",  (e) => console.error("WaveSurfer:", musicFile, e))
        ws.on("play",   () => { pauseBtn.textContent = "⏸" })
        ws.on("pause",  () => { pauseBtn.textContent = "⏵" })
        ws.on("finish", () => {
            pauseBtn.textContent = "⏵"
            ws.setVolume(currentVolume)
            if (!mp.loop && mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
        })

        // ── Controls ────────────────────────────────────────────────────
        volSlider.addEventListener("input", () => {
            currentVolume = parseFloat(volSlider.value)
            mp.volume = currentVolume
            volLabel.textContent = Math.round(currentVolume * 100) + "%"
            if (!ws.isPlaying()) ws.setVolume(currentVolume)
            debouncedSave()
        })
        loopBtn.addEventListener("click", () => {
            mp.loop = !mp.loop
            loopBtn.classList.toggle("waveform-btn-active", mp.loop)
            debouncedSave()
        })
        pauseBtn.addEventListener("click", () => ws.playPause())
        stopBtn.addEventListener("click",  () => { ws.stop(); ws.setVolume(currentVolume); if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear() })
        zoomOutBtn.addEventListener("click", () => { state.zoom = Math.max(10,  state.zoom / 2); ws.zoom(state.zoom); updateMarkers() })
        zoomInBtn.addEventListener("click",  () => { state.zoom = Math.min(400, state.zoom * 2); ws.zoom(state.zoom); updateMarkers() })

        waveformContainer.addEventListener("mousemove", (e) => {
            const dur = ws.getDuration()
            if (!dur) { waveformContainer.style.cursor = ""; return }
            const rect = waveformContainer.getBoundingClientRect()
            const playheadX = (ws.getCurrentTime() / dur) * totalWaveWidth() - ws.getScroll()
            waveformContainer.style.cursor = Math.abs(e.clientX - rect.left - playheadX) < 10 ? "crosshair" : ""
        })
        waveformContainer.addEventListener("mouseleave", () => { waveformContainer.style.cursor = "" })

        waveformContainer.addEventListener("mousedown", (e) => {
            e.stopPropagation()
            let dragging = false
            const startX = e.clientX
            const onMove = (me) => {
                if (!dragging && Math.abs(me.clientX - startX) > 3) dragging = true
                if (dragging) {
                    const rect = waveformContainer.getBoundingClientRect()
                    const tw = totalWaveWidth()
                    if (!tw) return
                    ws.seekTo(Math.max(0, Math.min(1, (ws.getScroll() + me.clientX - rect.left) / tw)))
                }
            }
            const onUp = () => {
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
                if (!dragging) { currentCue = index; markTriggers(index); triggerAction(index) }
            }
            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })

        // ── Monitor mix ─────────────────────────────────────────────────
        const monitorFile = typeof codeblockYaml.music === 'object' ? codeblockYaml.music.monitor ?? null : null

        let monAudioEl = null, wsMonitor = null
        let monSyncRaf = null

        if (monitorShouldPlay()) {
            // Two-player approach for all monitor scenarios.
            // Explicit monitor file if provided, otherwise same file as main.
            const monFile = monitorFile !== null ? monitorFile : musicFile
            monAudioEl = new Audio()
            if (monitorAudioDevice && monitorAudioDevice !== mainAudioDevice)
                monAudioEl.setSinkId(monitorAudioDevice).catch(() => {})
            const monContainer = document.createElement('div')
            monContainer.style.cssText = 'position:absolute;height:0;overflow:hidden;opacity:0;pointer-events:none'
            triggerDiv.appendChild(monContainer)
            wsMonitor = WaveSurfer.create({
                container: monContainer, media: monAudioEl,
                height: 0, interact: false, normalize: true, minPxPerSec: 1,
            })
            wsMonitor.load('audio/' + monFile)
            wsMonitor.setVolume(mp.volume)

            // Timecode-follower sync loop (targetT = mainT - offsetMs/1000)
            const syncMonitor = () => {
                if (!ws.isPlaying() || !monitorShouldPlay()) { monSyncRaf = null; return }
                const dur = wsMonitor.getDuration()
                if (dur > 0 && !monAudioEl.seeking) {
                    const mainT = mainAudioEl.currentTime
                    const targetT = Math.min(Math.max(mainT - monitorOffsetMs / 1000, 0), dur)
                    if (monAudioEl.paused) {
                        if (mainT * 1000 >= monitorOffsetMs && targetT < dur - 0.1) {
                            if (Math.abs(monAudioEl.currentTime - targetT) >= 0.05)
                                monAudioEl.currentTime = targetT
                            monAudioEl.play().catch(() => {})
                        }
                    } else if (Math.abs(monAudioEl.currentTime - targetT) > 0.1) {
                        monAudioEl.currentTime = targetT
                    }
                }
                monSyncRaf = requestAnimationFrame(syncMonitor)
            }
            ws.on('play', () => {
                if (!monitorShouldPlay()) return
                if (monSyncRaf) cancelAnimationFrame(monSyncRaf)
                syncMonitor()
            })
            ws.on('pause', () => {
                if (monSyncRaf) { cancelAnimationFrame(monSyncRaf); monSyncRaf = null }
                if (!monAudioEl.paused) monAudioEl.pause()
                const dur = wsMonitor.getDuration()
                if (dur > 0) monAudioEl.currentTime = Math.min(
                    Math.max(mainAudioEl.currentTime - monitorOffsetMs / 1000, 0), dur)
            })
            ws.on('seeking', (t) => {
                if (!monitorShouldPlay()) return
                const dur = wsMonitor.getDuration()
                if (dur > 0) monAudioEl.currentTime = Math.min(Math.max(t - monitorOffsetMs / 1000, 0), dur)
            })
        }

        // ── Common patches ────────────────────────────────────────────────
        const _wsSetVol = ws.setVolume.bind(ws)
        ws.setVolume = (v) => {
            _wsSetVol(v)
            if (wsMonitor) wsMonitor.setVolume(v)
        }
        const _wsStop = ws.stop.bind(ws)
        ws.stop = () => {
            if (monSyncRaf) { cancelAnimationFrame(monSyncRaf); monSyncRaf = null }
            if (monAudioEl && !monAudioEl.paused) monAudioEl.pause()
            if (monAudioEl) monAudioEl.currentTime = 0
            _wsStop()
        }

        triggerAudio.set(index, { ws, wsMonitor, mainAudioEl, monAudioEl, musicFile })
        fileToTriggers.set(musicFile, [...(fileToTriggers.get(musicFile) || []), index])
    }

    triggerYamls[index] = codeblockYaml

    triggerDiv.addEventListener("mousedown", (e) => {
        if (pickModeCallback) {
            e.stopPropagation()
            const cb = pickModeCallback
            exitPickMode()
            cb(index)
            return
        }
        currentCue = index
        markTriggers(index)
        triggerAction(index)
    })

    // ── Bezug button ─────────────────────────────────────────────────────
    const hasAdjust = codeblockYaml.music && typeof codeblockYaml.music === 'object' && codeblockYaml.music.adjust
    const adjustBtn = document.createElement("button")
    adjustBtn.classList.add("trigger-action-btn")
    if (hasAdjust) adjustBtn.classList.add("trigger-action-btn-active")
    adjustBtn.textContent = "⇢ Bezug"
    adjustBtn.title = "Anderen Trigger beeinflussen"
    adjustBtn.addEventListener("mousedown", e => e.stopPropagation())
    adjustBtn.addEventListener("click", e => {
        e.stopPropagation()
        const adj = triggerYamls[index]?.music?.adjust
        if (adj) {
            showAdjustDialog(index, triggerYamls[index], findTriggerByNote(adj.trigger_note))
        } else {
            enterPickMode(targetIdx => showAdjustDialog(index, triggerYamls[index], targetIdx))
        }
    })
    triggerDiv.querySelector('.trigger-actions').appendChild(adjustBtn)

    // ── Variante button ──────────────────────────────────────────────────
    const copyBtn = document.createElement("button")
    copyBtn.classList.add("trigger-action-btn")
    copyBtn.textContent = "⊕ Variante"
    copyBtn.title = "Als nebenläufige Variante duplizieren"
    copyBtn.addEventListener("mousedown", e => e.stopPropagation())
    copyBtn.addEventListener("click", e => {
        e.stopPropagation()
        const copy = JSON.parse(JSON.stringify(codeblockYaml))
        const parentTriggerNote = codeblockYaml.trigger_note ?? null
        delete copy.trigger_note
        copy.sibling = true
        showTriggerDialog({ insertAfterBlockIdx: blockIdxForTrigger(index), existingYaml: copy, isCopy: true, parentTriggerNote })
    })
    triggerDiv.querySelector('.trigger-actions').appendChild(copyBtn)

    return triggerDiv
}

function makeWaveBtn(label, title) {
    const btn = document.createElement("button")
    btn.classList.add("waveform-btn")
    btn.textContent = label
    btn.title = title
    return btn
}

function mkDialogField(labelText, type, defaultVal) {
    const wrap = document.createElement('div')
    wrap.classList.add('dialog-field')
    const label = document.createElement('label')
    label.textContent = labelText
    const input = document.createElement('input')
    input.type = type
    input.value = defaultVal
    wrap.append(label, input)
    return { wrap, input }
}

function buildInsertZones() {
    const content = document.getElementById('script-content')
    document.querySelectorAll('.insert-zone').forEach(z => z.remove())
    const blockEls = [...content.children]
    let blockCounter = 0
    for (let i = 0; i <= blockEls.length; i++) {
        const insertAfterBlockIdx = blockCounter
        const zone = document.createElement('div')
        zone.classList.add('insert-zone')
        const hotspot = document.createElement('div')
        hotspot.classList.add('insert-hotspot')
        hotspot.addEventListener('mousedown', e => e.stopPropagation())
        const btn = document.createElement('button')
        btn.classList.add('insert-btn')
        btn.textContent = '+'
        btn.title = 'Trigger hier einfügen'
        hotspot.appendChild(btn)
        zone.appendChild(hotspot)
        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            showTriggerDialog({ insertAfterBlockIdx })
        })
        if (i < blockEls.length) {
            content.insertBefore(zone, blockEls[i])
            const el = blockEls[i]
            blockCounter += el.classList.contains('trigger-group')
                ? el.querySelectorAll('.trigger').length
                : 1
        } else {
            content.appendChild(zone)
        }
    }
}

function editTriggerInScript(triggerIndex, newYaml) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    let yamlCount = 0
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'yaml') {
            yamlCount++
            if (yamlCount === triggerIndex + 1) {
                blocks[i] = { type: 'yaml', content: '```yaml\n' + yaml.dump(newYaml, { indent: 4 }).trimEnd() + '\n```' }
                break
            }
        }
    }
    let updated = blocks.map(b => b.content).join('\n\n') + '\n'
    const { text: assigned, changed } = assignTriggerNotes(updated)
    if (changed) updated = assigned
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    rerender(updated)
}

function deleteTriggerInScript(triggerIndex) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    let yamlCount = 0
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'yaml') {
            yamlCount++
            if (yamlCount === triggerIndex + 1) {
                blocks.splice(i, 1)
                break
            }
        }
    }
    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    rerender(updated)
}

// insertAfterBlockIdx: for new triggers (add mode)
// triggerIndex + existingYaml: for editing an existing trigger (edit mode)
async function showTriggerDialog({ insertAfterBlockIdx = null, triggerIndex = null, existingYaml = null, isCopy = false, parentTriggerNote = null } = {}) {
    const isEdit = triggerIndex !== null
    const audioFiles = await window.electronAPI.listAudioFiles()

    const overlay = document.createElement('div')
    overlay.classList.add('dialog-overlay')

    const box = document.createElement('div')
    box.classList.add('dialog-box')
    box.addEventListener('mousedown', e => e.stopPropagation())
    box.addEventListener('click', e => e.stopPropagation())

    const titleEl = document.createElement('h3')
    titleEl.textContent = isEdit ? 'Trigger bearbeiten' : isCopy ? 'Trigger duplizieren' : 'Neuer Trigger'
    box.appendChild(titleEl)

    // ── Mikrofon ────────────────────────────────────────────────────
    const micWrap = document.createElement('div')
    micWrap.classList.add('dialog-field')
    const micTopLabel = document.createElement('label')
    micTopLabel.textContent = 'Mikrofon'
    const micGroup = document.createElement('div')
    micGroup.classList.add('dialog-check-group')

    const muteallLbl = document.createElement('label')
    const muteallCb = document.createElement('input')
    muteallCb.type = 'checkbox'
    muteallLbl.append(muteallCb, ' Alle aus')
    micGroup.appendChild(muteallLbl)

    const roleCheckboxes = {}
    for (const [roleName, roleCfg] of Object.entries(config.roles)) {
        const lbl = document.createElement('label')
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        const span = document.createElement('span')
        span.textContent = roleName
        span.classList.add('color-' + roleCfg.color)
        lbl.append(cb, span)
        micGroup.appendChild(lbl)
        roleCheckboxes[roleName] = cb
    }
    muteallCb.addEventListener('change', () => {
        if (muteallCb.checked) for (const cb of Object.values(roleCheckboxes)) cb.checked = false
    })
    for (const cb of Object.values(roleCheckboxes)) {
        cb.addEventListener('change', () => { if (cb.checked) muteallCb.checked = false })
    }
    micWrap.append(micTopLabel, micGroup)
    box.appendChild(micWrap)

    if ((isEdit || isCopy) && existingYaml?.mic) {
        if (existingYaml.mic === 'muteall') {
            muteallCb.checked = true
        } else {
            const roles = Array.isArray(existingYaml.mic) ? existingYaml.mic : [existingYaml.mic]
            for (const r of roles) { if (roleCheckboxes[r]) roleCheckboxes[r].checked = true }
        }
    }

    // ── Musik-Datei ─────────────────────────────────────────────────
    const mfWrap = document.createElement('div')
    mfWrap.classList.add('dialog-field')
    const mfLabel = document.createElement('label')
    mfLabel.textContent = 'Musik-Datei'
    const mfSelect = document.createElement('select')
    mfSelect.classList.add('dialog-select')
    const emptyOpt = document.createElement('option')
    emptyOpt.value = ''
    emptyOpt.textContent = '— keine —'
    mfSelect.appendChild(emptyOpt)
    for (const f of audioFiles) {
        const opt = document.createElement('option')
        opt.value = f
        opt.textContent = f
        mfSelect.appendChild(opt)
    }
    mfWrap.append(mfLabel, mfSelect)
    box.appendChild(mfWrap)

    if ((isEdit || isCopy) && existingYaml?.music) {
        const currentFile = typeof existingYaml.music === 'string' ? existingYaml.music : existingYaml.music.file
        if (currentFile) mfSelect.value = currentFile
    }

    // ── Monitor-Mix ─────────────────────────────────────────────────
    const monWrap = document.createElement('div')
    monWrap.classList.add('dialog-field')
    const monLabel = document.createElement('label')
    monLabel.textContent = 'Monitor-Mix'
    const monSelect = document.createElement('select')
    monSelect.classList.add('dialog-select')
    const monEmptyOpt = document.createElement('option')
    monEmptyOpt.value = ''
    monEmptyOpt.textContent = '— gleich wie Haupt-Audio —'
    monSelect.appendChild(monEmptyOpt)
    for (const f of audioFiles) {
        const opt = document.createElement('option')
        opt.value = f
        opt.textContent = f
        monSelect.appendChild(opt)
    }
    const monWarning = document.createElement('div')
    monWarning.style.cssText = 'color:#e5c07b;font-size:0.82rem;margin-top:0.3rem;display:none'
    monWrap.append(monLabel, monSelect, monWarning)
    box.appendChild(monWrap)

    if ((isEdit || isCopy) && existingYaml?.music && typeof existingYaml.music === 'object' && existingYaml.music.monitor) {
        monSelect.value = existingYaml.music.monitor
    }

    async function checkMonitorDuration() {
        const mf = mfSelect.value
        const mf2 = monSelect.value
        if (!mf || !mf2) { monWarning.style.display = 'none'; return }
        const [d1, d2] = await Promise.all([
            new Promise(res => { const a = new Audio('audio/' + mf);  a.addEventListener('loadedmetadata', () => res(a.duration)); a.addEventListener('error', () => res(null)) }),
            new Promise(res => { const a = new Audio('audio/' + mf2); a.addEventListener('loadedmetadata', () => res(a.duration)); a.addEventListener('error', () => res(null)) }),
        ])
        if (d1 && d2 && Math.abs(d1 - d2) > 0.1) {
            monWarning.textContent = `⚠ Unterschiedliche Längen: ${d1.toFixed(2)}s vs ${d2.toFixed(2)}s`
            monWarning.style.display = 'block'
        } else {
            monWarning.style.display = 'none'
        }
    }
    mfSelect.addEventListener('change', checkMonitorDuration)
    monSelect.addEventListener('change', checkMonitorDuration)
    checkMonitorDuration()

    // ── Hinweis ─────────────────────────────────────────────────────
    const { wrap: noteWrap, input: noteInput } = mkDialogField('Hinweis', 'text', '')
    if ((isEdit || isCopy) && existingYaml?.note) noteInput.value = existingYaml.note
    box.appendChild(noteWrap)

    // ── Start-Timecode ───────────────────────────────────────────────
    const { wrap: tcWrap, input: tcInput } = mkDialogField('Start-Timecode (HH:MM:SS:FF)', 'text', '')
    tcInput.placeholder = '00:00:00:00'
    if ((isEdit || isCopy) && existingYaml?.start_tc) tcInput.value = existingYaml.start_tc
    box.appendChild(tcWrap)

    // ── Gleiche trigger_note ─────────────────────────────────────────
    let sameTnCheckbox = null
    if (isCopy || (isEdit && existingYaml?.sibling)) {
        const sameTnWrap = document.createElement('div')
        sameTnWrap.classList.add('dialog-field')
        const sameTnLabel = document.createElement('label')
        sameTnLabel.classList.add('dialog-loop-label')
        sameTnCheckbox = document.createElement('input')
        sameTnCheckbox.type = 'checkbox'
        const ptn = parentTriggerNote
        const ptnStr = ptn ? ` (${ptn.ch}.${ptn.note})` : ''
        sameTnLabel.append(sameTnCheckbox, ` Gleiche trigger_note wie Original${ptnStr}`)
        sameTnWrap.appendChild(sameTnLabel)
        box.appendChild(sameTnWrap)
        // default: checked; for edit, reflect actual state
        sameTnCheckbox.checked = true
        if (isEdit && existingYaml?.trigger_note && ptn) {
            sameTnCheckbox.checked = existingYaml.trigger_note.ch === ptn.ch
                && existingYaml.trigger_note.note === ptn.note
        }
    }

    // ── Buttons ──────────────────────────────────────────────────────
    const actions = document.createElement('div')
    actions.classList.add('dialog-actions')

    const cancelBtn = document.createElement('button')
    cancelBtn.classList.add('dialog-btn')
    cancelBtn.textContent = 'Abbrechen'

    const confirmBtn = document.createElement('button')
    confirmBtn.classList.add('dialog-btn', 'dialog-btn-primary')
    confirmBtn.textContent = isEdit ? 'Speichern' : 'Hinzufügen'

    if (isEdit && !isCopy) {
        const deleteBtn = document.createElement('button')
        deleteBtn.classList.add('dialog-btn', 'dialog-btn-danger')
        deleteBtn.textContent = 'Löschen'
        deleteBtn.addEventListener('click', () => { close(); deleteTriggerInScript(triggerIndex) })
        actions.append(deleteBtn, cancelBtn, confirmBtn)
    } else {
        actions.append(cancelBtn, confirmBtn)
    }
    box.appendChild(actions)

    overlay.appendChild(box)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    cancelBtn.addEventListener('click', close)
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })

    confirmBtn.addEventListener('click', () => {
        const newYaml = {}

        // mic
        if (muteallCb.checked) {
            newYaml.mic = 'muteall'
        } else {
            const sel = Object.entries(roleCheckboxes).filter(([, cb]) => cb.checked).map(([n]) => n)
            if (sel.length === 1) newYaml.mic = sel[0]
            else if (sel.length > 1) newYaml.mic = sel
        }

        // music (preserve existing object props like volume/start/end when editing or copying)
        const mf = mfSelect.value
        const mf2 = monSelect.value
        if (mf) {
            if ((isEdit || isCopy) && existingYaml?.music && typeof existingYaml.music === 'object') {
                newYaml.music = { ...existingYaml.music, file: mf }
            } else {
                newYaml.music = mf
            }
            // monitor: expand to object form if needed
            if (mf2) {
                if (typeof newYaml.music === 'string') newYaml.music = { file: newYaml.music }
                newYaml.music.monitor = mf2
            } else if (typeof newYaml.music === 'object') {
                delete newYaml.music.monitor
            }
        }

        // note
        const noteVal = noteInput.value.trim()
        if (noteVal) newYaml.note = noteVal

        // start_tc
        const tcVal = tcInput.value.trim()
        if (tcVal) newYaml.start_tc = tcVal

        // trigger_note: preserve when editing non-sibling; handle checkbox for siblings/copies
        if (sameTnCheckbox) {
            if (sameTnCheckbox.checked && parentTriggerNote) {
                newYaml.trigger_note = parentTriggerNote
            } else if (isEdit && existingYaml?.trigger_note) {
                // unchecked edit: keep existing only if it differs from parent (otherwise let assignTriggerNotes re-assign)
                const ptn = parentTriggerNote
                const wasSame = ptn && existingYaml.trigger_note.ch === ptn.ch && existingYaml.trigger_note.note === ptn.note
                if (!wasSame) newYaml.trigger_note = existingYaml.trigger_note
            }
            // isCopy + unchecked: no trigger_note set → assignTriggerNotes assigns new one
        } else if (isEdit && existingYaml?.trigger_note) {
            newYaml.trigger_note = existingYaml.trigger_note
        }
        // preserve sibling flag when editing; add it when copying
        if (isEdit && existingYaml?.sibling) newYaml.sibling = true
        if (isCopy) newYaml.sibling = true

        close()
        if (isEdit) {
            editTriggerInScript(triggerIndex, newYaml)
        } else {
            insertTriggerInScript(insertAfterBlockIdx, newYaml)
        }
    })
}

function setAdjustOnTrigger(triggerIndex, existingYaml, adjustConfig) {
    const newYaml = { ...existingYaml }
    if (!adjustConfig) {
        if (newYaml.music && typeof newYaml.music === 'object') {
            const { adjust, ...rest } = newYaml.music
            newYaml.music = Object.keys(rest).length ? rest : undefined
            if (!newYaml.music) delete newYaml.music
        }
    } else {
        if (!newYaml.music) {
            newYaml.music = { adjust: adjustConfig }
        } else if (typeof newYaml.music === 'string') {
            newYaml.music = { file: newYaml.music, adjust: adjustConfig }
        } else {
            newYaml.music = { ...newYaml.music, adjust: adjustConfig }
        }
    }
    editTriggerInScript(triggerIndex, newYaml)
}

function showAdjustDialog(triggerIndex, existingYaml, targetIdx) {
    const existingAdj = existingYaml?.music?.adjust
    const targetYaml  = triggerYamls[targetIdx] ?? null

    const overlay = document.createElement('div')
    overlay.classList.add('dialog-overlay')
    const box = document.createElement('div')
    box.classList.add('dialog-box')
    box.addEventListener('mousedown', e => e.stopPropagation())
    box.addEventListener('click',     e => e.stopPropagation())

    const titleEl = document.createElement('h3')
    titleEl.textContent = 'Bezug konfigurieren'
    box.appendChild(titleEl)

    // ── Bezugs-Trigger ──────────────────────────────────────────────
    const targetWrap = document.createElement('div')
    targetWrap.classList.add('dialog-field')
    const targetLbl = document.createElement('label')
    targetLbl.textContent = 'Bezugs-Trigger'
    const targetInfo = document.createElement('div')
    targetInfo.style.cssText = 'margin: 0.3rem 0 0.5rem; font-size: 0.9rem; color: #abb2bf'
    function refreshTargetInfo(idx) {
        const ty = triggerYamls[idx] ?? null
        if (ty && ty.trigger_note) {
            const tn = ty.trigger_note
            const mf = ty.music ? (typeof ty.music === 'string' ? ty.music : ty.music.file) : null
            targetInfo.textContent = `${tn.ch}.${tn.note}` + (mf ? `  –  ${mf}` : '')
        } else {
            targetInfo.textContent = '(kein Trigger ausgewählt)'
        }
    }
    refreshTargetInfo(targetIdx)
    const repickBtn = document.createElement('button')
    repickBtn.classList.add('dialog-btn')
    repickBtn.textContent = 'Anderen auswählen…'
    repickBtn.style.fontSize = '0.8rem'
    repickBtn.addEventListener('click', () => {
        close()
        enterPickMode(newIdx => showAdjustDialog(triggerIndex, triggerYamls[triggerIndex], newIdx))
    })
    targetWrap.append(targetLbl, targetInfo, repickBtn)
    box.appendChild(targetWrap)

    // ── Aktion ──────────────────────────────────────────────────────
    const actionWrap = document.createElement('div')
    actionWrap.classList.add('dialog-field')
    const actionLbl = document.createElement('label')
    actionLbl.textContent = 'Aktion'
    actionWrap.appendChild(actionLbl)

    const fadeoutLbl = document.createElement('label')
    fadeoutLbl.classList.add('dialog-loop-label')
    const fadeoutRb = document.createElement('input')
    fadeoutRb.type = 'radio'; fadeoutRb.name = `adj-${triggerIndex}`; fadeoutRb.value = 'fadeout'
    fadeoutLbl.append(fadeoutRb, ' Fadeout (stoppen)')

    const volLbl = document.createElement('label')
    volLbl.classList.add('dialog-loop-label')
    const volRb = document.createElement('input')
    volRb.type = 'radio'; volRb.name = `adj-${triggerIndex}`; volRb.value = 'volume'
    const volInput = document.createElement('input')
    volInput.type = 'number'; volInput.min = '0'; volInput.max = '1'; volInput.step = '0.01'
    volInput.value = existingAdj?.volume ?? '0.5'
    volInput.style.cssText = 'width: 5rem; margin-left: 0.5rem'
    volInput.classList.add('dialog-volume-inline')
    volLbl.append(volRb, ' Lautstärke auf ', volInput)

    if (existingAdj?.volume !== undefined) volRb.checked = true
    else fadeoutRb.checked = true

    actionWrap.append(fadeoutLbl, volLbl)
    box.appendChild(actionWrap)

    // ── Buttons ─────────────────────────────────────────────────────
    const actions = document.createElement('div')
    actions.classList.add('dialog-actions')
    const cancelBtn = document.createElement('button')
    cancelBtn.classList.add('dialog-btn')
    cancelBtn.textContent = 'Abbrechen'
    const saveBtn = document.createElement('button')
    saveBtn.classList.add('dialog-btn', 'dialog-btn-primary')
    saveBtn.textContent = 'Speichern'
    if (existingAdj) {
        const delBtn = document.createElement('button')
        delBtn.classList.add('dialog-btn', 'dialog-btn-danger')
        delBtn.textContent = 'Deaktivieren'
        delBtn.addEventListener('click', () => { close(); setAdjustOnTrigger(triggerIndex, triggerYamls[triggerIndex], null) })
        actions.append(delBtn, cancelBtn, saveBtn)
    } else {
        actions.append(cancelBtn, saveBtn)
    }
    box.appendChild(actions)
    overlay.appendChild(box)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    cancelBtn.addEventListener('click', close)
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })

    saveBtn.addEventListener('click', () => {
        if (!targetYaml) return
        const adjConfig = { trigger_note: targetYaml.trigger_note }
        if (fadeoutRb.checked) adjConfig.fadeout = true
        else adjConfig.volume = parseFloat(volInput.value) || 0.5
        close()
        setAdjustOnTrigger(triggerIndex, triggerYamls[triggerIndex], adjConfig)
    })
}

function triggerAction(cue) {
    // Second press while playing → stop (undo accidental trigger)
    const ta = triggerAudio.get(cue)
    if (ta && ta.ws.isPlaying()) {
        ta.ws.stop()
        if (mtc && mtc.activeTcIndex === cue) mtc.stopAndClear()
        return
    }

    x32UnmuteChannels(triggerYamls[cue].mic)

    const startTc = triggerYamls[cue].start_tc
    if (startTc && mtc && mtc.activeTcIndex !== null && mtc.activeTcIndex !== cue) {
        // Stop and reset any other trigger that was the TC source
        const prevAudio = triggerAudio.get(mtc.activeTcIndex)
        if (prevAudio) prevAudio.ws.stop()
        mtc.stop()
    }

    playMusic(cue)
    sendTriggerNote(cue)

    if (startTc && mtc) {
        if (ta) mtc.start(startTc, ta.ws, cue)
    }
}

function sendTriggerNote(cue) {
    const tn = triggerYamls[cue].trigger_note
    if (!tn || !midiTrigger) return
    midiTrigger.send([0x90 | (tn.ch - 1), tn.note, 100])
    setTimeout(() => midiTrigger.send([0x80 | (tn.ch - 1), tn.note, 0]), 100)
}

async function playMusic(cue) {
    const music = triggerYamls[cue].music
    if (!music) return

    const ta = triggerAudio.get(cue)
    if (ta) {
        const volume = typeof music === 'object' && music.volume != null ? music.volume : 0.8
        const start  = typeof music === 'object' && music.start  != null ? music.start  : 0
        const fadein = typeof music === 'object' && music.fadein != null ? music.fadein : 0

        ta.ws.setVolume(fadein > 0 ? 0 : volume)

        const useMonitor = monitorShouldPlay() && ta.wsMonitor && ta.wsMonitor.getDuration() > 0
        if (useMonitor) {
            // Seek both elements to their target positions in parallel, then fire
            // play() on both in the same microtask — zero relative start-time offset.
            const monDur = ta.wsMonitor.getDuration()
            const monTargetT = Math.min(Math.max(start - monitorOffsetMs / 1000, 0), monDur)
            const seekReady = (el, t) => new Promise(resolve => {
                el.currentTime = t
                if (!el.seeking) { resolve(); return }
                const guard = setTimeout(resolve, 2000)  // Never hang on a stuck seek
                el.addEventListener('seeked', () => { clearTimeout(guard); resolve() }, { once: true })
            })
            await Promise.all([
                seekReady(ta.mainAudioEl, start),
                seekReady(ta.monAudioEl, monTargetT),
            ])
            ta.mainAudioEl.play().catch(() => {})
            if (monitorOffsetMs <= 0) ta.monAudioEl.play().catch(() => {})
            // positive offset: syncMonitor starts monitor once delay has elapsed
        } else {
            ta.ws.play(start)
        }
    }

    if (typeof music === 'object' && music.adjust) {
        const { trigger_note: adjTn, fadeout, volume: targetVol } = music.adjust
        const targetIdx = findTriggerByNote(adjTn)
        if (targetIdx !== null) {
            const adjustTa = triggerAudio.get(targetIdx)
            if (adjustTa && adjustTa.ws.isPlaying()) {
                if (fadeout) {
                    fadeWaveSurfer(adjustTa.ws, 0, 3, true)
                } else if (targetVol !== undefined) {
                    fadeWaveSurfer(adjustTa.ws, targetVol, 3, false)
                }
            }
        }
    }
}

function fadeWaveSurfer(ws, targetVolume, fadeTime, stop) {
    const startVolume = ws.getVolume()
    if (startVolume === targetVolume) {
        if (stop) ws.stop()
        return
    }
    const steps = 50
    const stepInterval = (fadeTime * 1000) / steps
    const volumeStep = (targetVolume - startVolume) / steps
    let step = 0
    const interval = setInterval(() => {
        step++
        ws.setVolume(Math.max(0, Math.min(1, startVolume + volumeStep * step)))
        if (step >= steps) {
            clearInterval(interval)
            if (stop) ws.stop()
        }
    }, stepInterval)
}

function stopall() {
    for (const { ws } of triggerAudio.values()) {
        fadeWaveSurfer(ws, 0, 3, true)
    }
    if (mtc) mtc.stopAndClear()
}

// Finds codeblocks in raw markdown that lack trigger_note and assigns sequential ones.
function assignTriggerNotes(text) {
    const usedNotes = new Set()
    let blockIndex = 0
    for (const match of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
        blockIndex++
        if (blockIndex === 1) continue
        try {
            const parsed = yaml.load(match[1])
            if (parsed && parsed.trigger_note) {
                usedNotes.add(`${parsed.trigger_note.ch}.${parsed.trigger_note.note}`)
            }
        } catch {}
    }

    function nextFreeNote() {
        for (let ch = 1; ch <= 16; ch++) {
            for (let note = 1; note <= 127; note++) {
                const key = `${ch}.${note}`
                if (!usedNotes.has(key)) { usedNotes.add(key); return { ch, note } }
            }
        }
        return null
    }

    let changed = false
    blockIndex = 0
    const result = text.replace(/```yaml\n([\s\S]*?)```/g, (match, yamlContent) => {
        blockIndex++
        if (blockIndex === 1) return match
        try {
            const parsed = yaml.load(yamlContent)
            if (!parsed || parsed.trigger_note) return match
        } catch { return match }

        const assignment = nextFreeNote()
        if (!assignment) return match
        changed = true
        const trimmed = yamlContent.replace(/\s+$/, '')
        return `\`\`\`yaml\n${trimmed}\ntrigger_note: {ch: ${assignment.ch}, note: ${assignment.note}}\n\`\`\``
    })

    return { text: result, changed }
}

function convertCodeblocks() {
    const codeblocks = document.querySelectorAll("pre")
    config = yaml.load(codeblocks[0].firstChild.textContent).config
    codeblocks[0].remove()
    for (let index = 1; index < codeblocks.length; index++) {
        const codeblock = codeblocks[index]
        const codeblockYaml = yaml.load(codeblock.firstChild.textContent)
        codeblock.replaceWith(buildTrigger(codeblockYaml, index))
    }
    for (let index = 0; index < Object.keys(config.roles).length; index++) {
        if (!usedChs.includes(config.roles[Object.keys(config.roles)[index]].ch)) {
            usedChs.push(config.roles[Object.keys(config.roles)[index]].ch)
        }
    }
}

function colorText() {
    const paragraphs = document.querySelectorAll("p")
    for (let index = 0; index < paragraphs.length; index++) {
        const paragraph = paragraphs[index]
        if (paragraph.firstChild.tagName === "STRONG") {
            const roleName = paragraph.firstChild.textContent
            paragraph.classList.add("color-" + config.roles[roleName].color)
        }
    }
}

function initButtons() {
    document.querySelector(".em-music").addEventListener("mousedown", stopall)
    document.querySelector(".em-mic").addEventListener("mousedown", () => x32UnmuteChannels("muteall"))
    document.querySelector(".current-trigger-button").addEventListener("mousedown", () => scrollToTrigger(currentCue))
    document.querySelector(".reload-button").addEventListener("mousedown", () => location.reload())
}

function x32UnmuteChannels(mic) {
    if (!mic) return
    let channels = []
    if (typeof mic === "string") {
        if (mic !== "muteall") channels.push(config.roles[mic].ch)
    } else {
        for (let index = 0; index < mic.length; index++) {
            channels.push(config.roles[mic[index]].ch)
        }
    }
    if (!midiX32) return
    for (let index = 0; index < usedChs.length; index++) {
        const value = channels.includes(usedChs[index]) ? 0 : 127
        midiX32.send([0xB1, usedChs[index] - 1, value])  // CC on channel 2
    }
}

function refreshMidiDevices(settings) {
    midiX32 = null
    midiTrigger = null
    midiTC = null
    if (!midiAccess) return
    for (const output of midiAccess.outputs.values()) {
        if (settings.midiX32Device && output.name === settings.midiX32Device) midiX32 = output
        if (settings.midiTriggerDevice && output.name === settings.midiTriggerDevice) midiTrigger = output
        if (settings.midiTCDevice && output.name === settings.midiTCDevice) midiTC = output
    }
    if (mtc) mtc.setOutput(midiTC)
}

async function initMidi(settings) {
    midiAccess = await _midiAccessPromise
    if (!midiAccess) return
    refreshMidiDevices(settings)
}

function updateClock() {
    const clock = document.querySelector(".clock")
    const date = new Date()
    const h = date.getHours() > 9 ? date.getHours().toString() : "0" + date.getHours().toString()
    const m = date.getMinutes() > 9 ? date.getMinutes().toString() : "0" + date.getMinutes().toString()
    const s = date.getSeconds() > 9 ? date.getSeconds().toString() : "0" + date.getSeconds().toString()
    clock.innerText = `${h}:${m}:${s}`
}

async function initApp() {
    const settings = await window.electronAPI.getSettings()

    const response = await fetch('script.md')
    let text = await response.text()

    const { text: modifiedText, changed } = assignTriggerNotes(text)
    if (changed) {
        await window.electronAPI.writeScriptMd(modifiedText)
        text = modifiedText
    }

    scriptText = text
    document.getElementById('script-content').innerHTML = converter.makeHtml(text)
    convertCodeblocks()
    colorText()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
    buildInsertZones()
    initButtons()

    mtc = new MTCTransmitter()
    mtc.setDisplay(document.querySelector('.tc-display'))

    mainAudioDevice = settings.mainAudioDevice ?? null
    monitorAudioDevice = settings.monitorAudioDevice ?? null
    monitorOffsetMs = settings.monitorOffsetMs ?? 0
    applyAudioDevices()

    await initMidi(settings)
    mtc.setOutput(midiTC)

    window.electronAPI.onSettingsChanged((newSettings) => {
        refreshMidiDevices(newSettings)
        mainAudioDevice = newSettings.mainAudioDevice ?? null
        monitorAudioDevice = newSettings.monitorAudioDevice ?? null
        monitorOffsetMs = newSettings.monitorOffsetMs ?? 0
        applyAudioDevices()
    })
}

initApp().catch(e => console.error('initApp Fehler:', e))

updateClock()
setInterval(() => updateClock(), 1000)
