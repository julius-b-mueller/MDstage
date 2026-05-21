"use strict"

const showdown = require('showdown')
const yaml = require('js-yaml')
const WaveSurfer = require('wavesurfer.js')

let config = {}
let usedChs = []
let triggers = []
let triggerYamls = []

// triggerIndex -> { ws: WaveSurfer, musicFile: string }
const triggerAudio = new Map()
// musicFile -> triggerIndex[]  (for cross-trigger fade lookups)
const fileToTriggers = new Map()

let scriptText = ''

let currentCue = 0
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

function markTriggers(cue) {
    for (let index = 1; index <= cue; index++) {
        triggers[index].classList.add("trigger-marked")
    }
    for (let index = cue + 1; index < triggers.length; index++) {
        triggers[index].classList.remove("trigger-marked")
    }
}

function rerender(newText) {
    const scrollY = window.scrollY

    for (const { ws } of triggerAudio.values()) {
        try { ws.destroy() } catch (e) {}
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

function buildTrigger(codeblockYaml, index) {
    const triggerDiv = document.createElement("div")
    triggerDiv.classList.add("trigger")

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
        showTriggerDialog({ triggerIndex: index, existingYaml: codeblockYaml })
    })
    triggerActions.appendChild(triggerEditBtn)
    triggerDiv.appendChild(triggerActions)

    triggers[index] = triggerDiv

    // mic info
    if (codeblockYaml.mic) {
        let roles = codeblockYaml.mic
        if (roles === "muteall") {
            triggerMic.innerText = "🎤 alle aus"
        } else {
            triggerMic.innerText = "🎤 "
            if (typeof roles === "string") roles = [roles]
            for (let i = 0; i < roles.length; i++) {
                const roleSpan = document.createElement("span")
                roleSpan.innerText = roles[i]
                roleSpan.classList.add("color-" + config.roles[roles[i]].color)
                triggerMic.appendChild(roleSpan)
            }
        }
    } else {
        triggerMic.innerText = "🎤 -"
    }

    // music info
    if (codeblockYaml.music) {
        if (typeof codeblockYaml.music === "string") {
            triggerMusic.innerText = "🎶 " + codeblockYaml.music
        } else if (codeblockYaml.music.file) {
            triggerMusic.innerText = "🎶 " + codeblockYaml.music.file
        }
        if (codeblockYaml.music.adjust) {
            if (codeblockYaml.music.file) triggerMusic.innerText += ", "
            else triggerMusic.innerText = "🎶 "
            if (codeblockYaml.music.adjust.fadeout) {
                triggerMusic.innerText += codeblockYaml.music.adjust.file + " ausfaden"
            } else if (codeblockYaml.music.adjust.volume) {
                triggerMusic.innerText += "Lautstärke von " + codeblockYaml.music.adjust.file +
                    " auf " + codeblockYaml.music.adjust.volume * 100 + "%"
            }
        }
    } else {
        triggerMusic.innerText = "🎶 -"
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

        const ws = WaveSurfer.create({
            container: waveformContainer,
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

        triggerAudio.set(index, { ws, musicFile })
        fileToTriggers.set(musicFile, [...(fileToTriggers.get(musicFile) || []), index])
    }

    triggerYamls[index] = codeblockYaml

    triggerDiv.addEventListener("mousedown", (e) => {
        currentCue = index
        markTriggers(index)
        triggerAction(index)
    })

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
    for (let i = 0; i <= blockEls.length; i++) {
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
        const insertAfterBlockIdx = i
        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            showTriggerDialog({ insertAfterBlockIdx })
        })
        if (i < blockEls.length) {
            content.insertBefore(zone, blockEls[i])
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
    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
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
async function showTriggerDialog({ insertAfterBlockIdx = null, triggerIndex = null, existingYaml = null } = {}) {
    const isEdit = triggerIndex !== null
    const audioFiles = await window.electronAPI.listAudioFiles()

    const overlay = document.createElement('div')
    overlay.classList.add('dialog-overlay')

    const box = document.createElement('div')
    box.classList.add('dialog-box')
    box.addEventListener('mousedown', e => e.stopPropagation())
    box.addEventListener('click', e => e.stopPropagation())

    const titleEl = document.createElement('h3')
    titleEl.textContent = isEdit ? 'Trigger bearbeiten' : 'Neuer Trigger'
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

    if (isEdit && existingYaml.mic) {
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

    if (isEdit && existingYaml.music) {
        const currentFile = typeof existingYaml.music === 'string' ? existingYaml.music : existingYaml.music.file
        if (currentFile) mfSelect.value = currentFile
    }

    // ── Hinweis ─────────────────────────────────────────────────────
    const { wrap: noteWrap, input: noteInput } = mkDialogField('Hinweis', 'text', '')
    if (isEdit && existingYaml.note) noteInput.value = existingYaml.note
    box.appendChild(noteWrap)

    // ── Start-Timecode ───────────────────────────────────────────────
    const { wrap: tcWrap, input: tcInput } = mkDialogField('Start-Timecode (HH:MM:SS:FF)', 'text', '')
    tcInput.placeholder = '00:00:00:00'
    if (isEdit && existingYaml.start_tc) tcInput.value = existingYaml.start_tc
    box.appendChild(tcWrap)

    // ── Buttons ──────────────────────────────────────────────────────
    const actions = document.createElement('div')
    actions.classList.add('dialog-actions')

    const cancelBtn = document.createElement('button')
    cancelBtn.classList.add('dialog-btn')
    cancelBtn.textContent = 'Abbrechen'

    const confirmBtn = document.createElement('button')
    confirmBtn.classList.add('dialog-btn', 'dialog-btn-primary')
    confirmBtn.textContent = isEdit ? 'Speichern' : 'Hinzufügen'

    if (isEdit) {
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

        // music (preserve existing object props like volume/start/end when editing)
        const mf = mfSelect.value
        if (mf) {
            if (isEdit && existingYaml.music && typeof existingYaml.music === 'object') {
                newYaml.music = { ...existingYaml.music, file: mf }
            } else {
                newYaml.music = mf
            }
        }

        // note
        const noteVal = noteInput.value.trim()
        if (noteVal) newYaml.note = noteVal

        // start_tc
        const tcVal = tcInput.value.trim()
        if (tcVal) newYaml.start_tc = tcVal

        // preserve trigger_note when editing
        if (isEdit && existingYaml.trigger_note) newYaml.trigger_note = existingYaml.trigger_note

        close()
        if (isEdit) {
            editTriggerInScript(triggerIndex, newYaml)
        } else {
            insertTriggerInScript(insertAfterBlockIdx, newYaml)
        }
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

function playMusic(cue) {
    const music = triggerYamls[cue].music
    if (!music) return

    const ta = triggerAudio.get(cue)
    if (ta) {
        const volume = typeof music === 'object' && music.volume != null ? music.volume : 0.8
        const start  = typeof music === 'object' && music.start  != null ? music.start  : 0
        const fadein = typeof music === 'object' && music.fadein != null ? music.fadein : 0
        ta.ws.setVolume(fadein > 0 ? 0 : volume)
        ta.ws.play(start)
    }

    if (typeof music === 'object' && music.adjust) {
        const { file: adjustFile, fadeout, volume: targetVol } = music.adjust
        for (const idx of (fileToTriggers.get(adjustFile) || [])) {
            const adjustTa = triggerAudio.get(idx)
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
    annotateBlocks()
    buildInsertZones()
    initButtons()

    mtc = new MTCTransmitter()
    mtc.setDisplay(document.querySelector('.tc-display'))

    await initMidi(settings)
    mtc.setOutput(midiTC)

    window.electronAPI.onSettingsChanged((newSettings) => {
        refreshMidiDevices(newSettings)
    })
}

initApp().catch(e => console.error('initApp Fehler:', e))

updateClock()
setInterval(() => updateClock(), 1000)
