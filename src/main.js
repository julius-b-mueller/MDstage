"use strict"

const { marked } = require('marked')
const yaml = require('js-yaml')
const WaveSurfer = require('wavesurfer.js')
const createDOMPurify = require('dompurify')

let config = {}
let triggers = []
let triggerYamls = []
let parseErrors    = []   // {blockNum, line, message}
let audioWarnings  = []   // {file, cueNum}
let noteConflicts  = []   // {key, first, second} – duplicate trigger_note entries
const loopOutroPending = new Map()         // loopTriggerIdx → outroTriggerIdx
const loopOutroInitialRemaining = new Map() // loopTriggerIdx → remaining at arm time
const loopBtns = new Map()          // triggerIdx → button element
const slfGripUpdaters = new Map()   // triggerIdx → updateSlfGrips fn
// loopTriggerIdx → { outroIdx, loopVirtualStartTime }
// loopVirtualStartTime: AudioContext time at which the loop was at position mp.start
const loopGroups = new Map()

// Multi-file SLF Loop sequence state
// index → { idx: 0, total: N, slots: [null, slot1, slot2, ...], fireNext: fn|null, boundaryTimer: null, transitionInProgress: false }
// slots[0] = null (primary slot, handled by buildTrigger closure vars)
// slots[1..N] = objects returned by buildSeqSlot()
const triggerSeqSlots = new Map()

// triggerIndex -> { ws, mainAudioEl, monitorFile, musicFile, overlay, getX, autoMarkerState }
const triggerAudio = new Map()
// musicFile → { playbackGain, activeSource, startedAt, startOffset, decodedBuffer, volume }
// Populated in rerender() so buildTrigger can adopt a running audio graph without interrupting it.
const pendingAudioAdoptions = new Map()
let versionMismatchIgnored = false
let versionMismatchFileVersion = null
let _versionBumpAppVersion = null

// Valid top-level keys for each YAML block type — unknown keys are surfaced as parse errors.
const CONFIG_BLOCK_KEYS = new Set([
    'roles', 'groups', 'settings', 'app_version', 'emLightNote',
])
const TRIGGER_BLOCK_KEYS = new Set([
    'sibling', 'trigger_note', 'note', 'auto_mic', 'mic',
    'music', 'music_seq', 'osc', 'osc_arg', 'osc_arg_type',
    'qlcplus', 'projection', 'start_tc',
    'auto_trigger', 'chain_end', 'loop_outro',
    'cue_midi', 'cue_osc',
])

// Returns [{block, key}] for every YAML key not in the current spec.
function findUnknownYamlKeys(text) {
    const results = []
    const re = /```yaml\n([\s\S]*?)```/g
    let blockIndex = 0, m
    while ((m = re.exec(text)) !== null) {
        blockIndex++
        let parsed
        try { parsed = yaml.load(m[1]) } catch { continue }
        if (!parsed || typeof parsed !== 'object') continue
        if (blockIndex === 1) {
            if (parsed.config && typeof parsed.config === 'object') {
                for (const k of Object.keys(parsed.config).filter(k => !CONFIG_BLOCK_KEYS.has(k)))
                    results.push({ block: blockIndex, key: `config.${k}` })
            }
        } else {
            for (const k of Object.keys(parsed).filter(k => !TRIGGER_BLOCK_KEYS.has(k)))
                results.push({ block: blockIndex, key: k })
        }
    }
    return results
}

async function writeScriptMd(content) {
    if (versionMismatchIgnored) {
        versionMismatchIgnored = false
        window.electronAPI.setSuppressVersionBump(false)

        const backupName = await window.electronAPI.backupScriptMdVersioned(versionMismatchFileVersion || 'old')
        const body = t('ver.upgrade.body')
            .replace('%1', _versionBumpAppVersion || '')
            .replace('%2', versionMismatchFileVersion || '?')
            .replace('%3', backupName || '')

        const proceed = await showConfirmDialog({
            title: t('ver.upgrade.title'),
            body,
            confirmLabel: t('ver.upgrade.ok'),
            cancelLabel: t('ver.upgrade.cancel'),
            img: 'assets/version-mismatch.png',
        })
        if (!proceed) {
            versionMismatchIgnored = true
            window.electronAPI.setSuppressVersionBump(true)
            return
        }
    }
    return window.electronAPI.writeScriptMd(content)
}
const slfDerivedTcBadges = new Map()  // triggerIndex → span element for derived TC badges
// musicFile -> triggerIndex[]  (for cross-trigger fade lookups)
const fileToTriggers = new Map()
// targetIdx → <button> element for auto-cue progress bar updates
const autoTriggerBtns = new Map()
const autoMicBtns = new Map()
// sourceIdx → { links, unPlay, unTime, unPause, unFin, markFired, getUnfiredPast }
const autoTriggerSetup = new Map()
// sourceIdx currently being scrubbed (drag on waveform while playing)
const scrubbingSet = new Set()

let mainAudioDevice    = null
let mainChannelL    = 0   // 0-indexed device output channels (Main L, Main R, Mon L, Mon R)
let mainChannelR    = 1
let monitorChannelL = 2
let monitorChannelR = 3
let monitorEnabled  = false
let audioOutputDevices = []
let editorApp = null
let audioBasePath = 'audio/'
let sharedAudioCtx = null

// Prevent path traversal from user-supplied YAML filenames (e.g. ../../etc/passwd).
// Preserves legitimate subdirectory paths like "subfolder/song.mp3".
function sanitizeAudioPath(filename) {
    if (typeof filename !== 'string' || !filename) return null
    return filename
        .replace(/\0/g, '')
        .split(/[\\/]/)
        .filter(seg => seg !== '..' && seg !== '.' && seg !== '')
        .join('/')
}

function getAudioCtx() {
    if (!sharedAudioCtx) sharedAudioCtx = new AudioContext()
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {})
    const dest   = sharedAudioCtx.destination
    const needed = Math.max(mainChannelL, mainChannelR, monitorChannelL, monitorChannelR) + 1
    if (needed > 2 && dest.maxChannelCount >= needed && dest.channelCount < needed) {
        dest.channelCountMode = 'explicit'
        dest.channelCount = needed
    }
    return sharedAudioCtx
}

// Builds a multichannel AudioBuffer routing main L/R and monitor L/R to the configured
// device output channels. If no monitor file is given, main audio is duplicated to monitor
// channels (unless monitor channels equal main channels — then fast path).
// Shorter buffer is zero-padded with silence automatically (copyToChannel).
function mergeToMultichannel(mainBuf, monBuf) {
    const monitorDiffers = monitorChannelL !== mainChannelL || monitorChannelR !== mainChannelR
    const monSrc  = monBuf ?? mainBuf   // duplicate main when no separate monitor file
    const totalCh = monitorDiffers
        ? Math.max(mainChannelL, mainChannelR, monitorChannelL, monitorChannelR) + 1
        : Math.max(mainChannelL, mainChannelR) + 1

    // Fast path: main on ch1-2, no separate monitor routing
    if (totalCh <= 2 && mainChannelL === 0 && mainChannelR === 1 && !monitorDiffers) return mainBuf

    const dest = sharedAudioCtx?.destination
    if (!dest || dest.maxChannelCount < totalCh) {
        console.info(`[multichannel] Gerät unterstützt < ${totalCh} Kanäle – Standard-Routing`)
        return mainBuf
    }
    dest.channelCountMode = 'explicit'
    dest.channelCount = totalCh

    const maxLen = Math.max(mainBuf.length, monBuf ? monBuf.length : 0)
    const merged = sharedAudioCtx.createBuffer(totalCh, maxLen, mainBuf.sampleRate)
    merged.copyToChannel(mainBuf.getChannelData(0), mainChannelL)
    if (mainBuf.numberOfChannels > 1) merged.copyToChannel(mainBuf.getChannelData(1), mainChannelR)
    if (monitorDiffers) {
        merged.copyToChannel(monSrc.getChannelData(0), monitorChannelL)
        if (monSrc.numberOfChannels > 1) merged.copyToChannel(monSrc.getChannelData(1), monitorChannelR)
        if (monBuf && Math.abs(mainBuf.duration - monBuf.duration) > 0.1)
            console.warn(`[multichannel] Längenunterschied: Haupt ${mainBuf.duration.toFixed(2)}s, Monitor ${monBuf.duration.toFixed(2)}s – Monitor mit Stille aufgefüllt`)
    }
    return merged
}

async function preDecodeForGapless(targetIdx) {
    const ta = triggerAudio.get(targetIdx)
    if (!ta || ta.decodedBuffer || ta._decoding) return
    ta._decoding = true
    try {
        const ctx = getAudioCtx()
        const mainAb = await (await fetch(audioBasePath + ta.musicFile)).arrayBuffer()
        const mainBuf = await ctx.decodeAudioData(mainAb)
        let monBuf = null
        if (ta.monitorFile) {
            try {
                const monAb = await (await fetch(audioBasePath + ta.monitorFile)).arrayBuffer()
                monBuf = await ctx.decodeAudioData(monAb)
            } catch (e) {
                console.warn('[multichannel] Monitor-Decode fehlgeschlagen:', e)
            }
        }
        ta.decodedBuffer = mergeToMultichannel(mainBuf, monBuf)
        tryBuildLoopGroups()
        preDecodeSeqSlots(targetIdx)
    } catch (e) {
        console.warn('[gapless] pre-decode failed:', e)
    } finally {
        ta._decoding = false
    }
}

async function preDecodeSeqSlots(targetIdx) {
    const seqData = triggerSeqSlots.get(targetIdx)
    if (!seqData) return
    const ctx = getAudioCtx()
    for (let i = 1; i < seqData.total; i++) {
        const slot = seqData.slots[i]
        if (!slot || slot.decodedBuffer || slot._decoding) continue
        slot._decoding = true
        try {
            const mainAb  = await (await fetch(audioBasePath + slot.musicFile)).arrayBuffer()
            const mainBuf = await ctx.decodeAudioData(mainAb)
            let monBuf = null
            if (slot.monitorFile) {
                try {
                    const monAb = await (await fetch(audioBasePath + slot.monitorFile)).arrayBuffer()
                    monBuf = await ctx.decodeAudioData(monAb)
                } catch (e) { console.warn('[seq] monitor decode failed slot', i, e) }
            }
            slot.decodedBuffer = mergeToMultichannel(mainBuf, monBuf)
        } catch (e) { console.warn('[seq] decode failed slot', i, e) }
        finally { slot._decoding = false }
    }
}

// Register all loop/outro pairs from YAML — no buffer building needed.
function tryBuildLoopGroups() {
    for (let i = 0; i < triggerYamls.length; i++) {
        const ty = triggerYamls[i]
        if (!ty?.loop_outro) continue
        if (loopGroups.has(i)) continue
        const outroIdx = findTriggerByNote(ty.loop_outro)
        if (outroIdx === null) continue
        loopGroups.set(i, { outroIdx, loopVirtualStartTime: null })
        console.log('[loopGroup] registered', i, '→', outroIdx)
    }
}

// Creates a minimal WaveSurfer + audio closure for one additional seq slot.
// Returns the slot API object that is stored in triggerSeqSlots.get(index).slots[k].
function buildSeqSlot({ index, seqSlotIdx, musicFile, monitorFile, mp, parentContainer }) {
    const wrapper = document.createElement('div')
    wrapper.classList.add('waveform-wrapper', 'seq-slot')

    // Label (1-based slot number)
    const slotLabel = document.createElement('div')
    slotLabel.className = 'seq-slot-label'
    slotLabel.textContent = String(seqSlotIdx + 1)
    wrapper.appendChild(slotLabel)

    const waveformContainer = document.createElement('div')
    waveformContainer.classList.add('waveform-container')
    wrapper.appendChild(waveformContainer)

    // Outro marker overlay
    const overlay = document.createElement('div')
    overlay.classList.add('waveform-overlay')
    waveformContainer.appendChild(overlay)
    const outroBar = document.createElement('div')
    outroBar.className = 'ws-bar ws-bar-outro'
    overlay.appendChild(outroBar)

    parentContainer.appendChild(wrapper)

    // Cursor media element (silenced — audio comes from AudioBufferSourceNode)
    const seqAudioEl = new Audio()
    if (mainAudioDevice) seqAudioEl.setSinkId(mainAudioDevice).catch(() => {})

    const ws = WaveSurfer.create({
        container: waveformContainer,
        media: seqAudioEl,
        waveColor: '#4b5263', progressColor: '#61afef', cursorColor: '#e5c07b',
        height: 64, interact: false, normalize: true, minPxPerSec: 20,
    })
    ws.load(audioBasePath + musicFile)
    ws.setVolume(mp.volume ?? 0.8)

    // Silence the media element via AudioContext, create own playback gain
    let seqPlaybackGain = null
    try {
        const ctx = getAudioCtx()
        const mediaSource = ctx.createMediaElementSource(seqAudioEl)
        const muteGain = ctx.createGain()
        muteGain.gain.value = 0
        mediaSource.connect(muteGain)
        muteGain.connect(ctx.destination)
        seqPlaybackGain = ctx.createGain()
        seqPlaybackGain.gain.value = mp.volume ?? 0.8
        seqPlaybackGain.connect(ctx.destination)
    } catch (e) { console.warn('[seq] audio setup failed slot', seqSlotIdx, e) }

    // Update outro bar on waveform ready
    ws.on('ready', () => {
        const dur = ws.getDuration()
        if (!dur) return
        const effEnd = mp.end ?? dur
        if (mp.fading_point > 0 && effEnd > mp.fading_point) {
            const markerPos = mp.fading_point
            outroBar.style.left = (markerPos / dur * 100) + '%'
            outroBar.style.display = 'block'
        } else {
            outroBar.style.display = 'none'
        }
    })

    // Audio state
    let slotSrc = null
    let slotStartedAt = null
    let slotStartOffset = null

    const slot = {
        ws,
        mp,
        musicFile,
        monitorFile: monitorFile ?? null,
        decodedBuffer: null,
        _decoding: false,

        getActiveSourceInfo() {
            return { src: slotSrc, startedAt: slotStartedAt, startOffset: slotStartOffset }
        },

        startGaplessSource(offset, when) {
            const ctx = sharedAudioCtx
            if (!ctx || !this.decodedBuffer || !seqPlaybackGain) return false
            if (slotSrc) { try { slotSrc.stop() } catch {} ; slotSrc = null }
            const src = ctx.createBufferSource()
            src.buffer = this.decodedBuffer
            src.loop = false
            src.connect(seqPlaybackGain)
            const safeOff = Math.max(0, offset)
            src.start(when, safeOff)
            slotSrc = src
            slotStartedAt   = when
            slotStartOffset = safeOff
            src.addEventListener('ended', () => { if (slotSrc === src) slotSrc = null })
            return true
        },

        startCursor(offset, delayMs) {
            setTimeout(() => {
                seqAudioEl.currentTime = Math.max(0, offset)
                seqAudioEl.play().catch(() => {})
            }, Math.max(0, delayMs))
        },

        pauseCursor() {
            seqAudioEl.pause()
        },

        resetCursor() {
            seqAudioEl.currentTime = mp.start ?? 0
        },

        setActive(active) {
            wrapper.classList.toggle('seq-slot-active', active)
        },

        stopSourceAt(when) {
            if (slotSrc) {
                try { if (when != null) slotSrc.stop(when); else slotSrc.stop() } catch {}
                slotSrc = null
            }
        },

        startTailCursor(effTrans, outroLen) {
            const dur = ws.getDuration()
            if (!dur || outroLen <= 0) return
            const tw = ws.getWrapper()?.clientWidth ?? waveformContainer.clientWidth
            const getX_s = (t) => tw > 0 ? (t / dur) * tw - ws.getScroll() : 0
            const tailCurEl = document.createElement('div')
            tailCurEl.classList.add('ws-tail-cursor')
            tailCurEl.style.left = getX_s(effTrans) + 'px'
            overlay.appendChild(tailCurEl)
            slot._activeTailCurEl = tailCurEl
            requestAnimationFrame(() => { requestAnimationFrame(() => {
                tailCurEl.style.transitionDuration = outroLen + 's'
                tailCurEl.style.left = getX_s(effTrans + outroLen) + 'px'
            }) })
            setTimeout(() => { if (slot._activeTailCurEl === tailCurEl) slot._activeTailCurEl = null; tailCurEl.remove() }, outroLen * 1000 + 150)
        },

        clearTailCursor() {
            if (slot._activeTailCurEl) { slot._activeTailCurEl.remove(); slot._activeTailCurEl = null }
        },

        fadeOut(durationSec) {
            const ctx = sharedAudioCtx
            if (!ctx || !seqPlaybackGain) return
            seqPlaybackGain.gain.cancelScheduledValues(ctx.currentTime)
            seqPlaybackGain.gain.setValueAtTime(seqPlaybackGain.gain.value, ctx.currentTime)
            seqPlaybackGain.gain.linearRampToValueAtTime(0, ctx.currentTime + durationSec)
        },
    }

    // Prevent ws.on("play") from causing issues — source is managed externally
    ws.on('play', () => {
        if (slotSrc) return  // source already started by seq transition
    })

    return slot
}

function resolveDeviceId(label) {
    if (!label) return null
    const found = audioOutputDevices.find(d => d.label === label)
    return found ? found.deviceId : null
}


let scriptText = ''
let selectedVariant = null  // cueIdx chosen by user in live view before Go

const ROLE_COLORS = {
    red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef',
    purple: '#c678dd', cyan: '#56b6c2', darkred: '#b03c45', darkgreen: '#68b349',
    darkyellow: '#b5904b', darkblue: '#317fbf', darkpurple: '#9648ad', darkcyan: '#268692',
}
const STAGE_COLOR = '#7c8898'

const MIC_SVG = `<svg class="t-icon" viewBox="0 0 12 18" width="10" height="15" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="3" y="0.5" width="6" height="9" rx="3"/><line x1="3.5" y1="3.5" x2="8.5" y2="3.5" stroke-width="0.55"/><line x1="3.5" y1="6" x2="8.5" y2="6" stroke-width="0.55"/><path d="M1 8 Q6 13.5 11 8"/><line x1="6" y1="11.5" x2="6" y2="15"/><line x1="3" y1="15" x2="9" y2="15"/></svg>`

const TAPE_SVG = `<svg class="t-icon" viewBox="0 0 22 12" width="22" height="12" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><circle cx="5" cy="6" r="4"/><circle cx="5" cy="6" r="1.3"/><line x1="5" y1="2" x2="5" y2="4.7"/><line x1="1.5" y1="8" x2="3.9" y2="6.7"/><line x1="8.5" y1="8" x2="6.1" y2="6.7"/><circle cx="17" cy="6" r="4"/><circle cx="17" cy="6" r="1.3"/><line x1="17" y1="2" x2="17" y2="4.7"/><line x1="13.5" y1="8" x2="15.9" y2="6.7"/><line x1="20.5" y1="8" x2="18.1" y2="6.7"/><line x1="9" y1="2" x2="13" y2="2"/><line x1="9" y1="10" x2="13" y2="10"/></svg>`

let currentCue = 0
let cueHistory     = []
let cueHistoryAuto = []   // parallel to cueHistory: true = fired by auto_trigger YAML
let pendingAutoTrigger = false  // set just before calling triggerAction from auto-trigger
let liveViewOpen = false
let showLock = false
let lockAutoActivated = false
let armedCue = null
let midiGoNote = null
let midiBackNote = null
let midiBackLongPressTimer = null
let midiBackLongPressed    = false
let pickModeCallback = null
let midiAccess = null
let micDeviceOutputs = []   // MIDI output per micDevices entry (null = not connected / OSC)
let midiTrigger = null
let midiTC = null
let midiLiveDevice = null
let mtc = null
let oscEnabled = false
let oscHost = '127.0.0.1'
let oscPort = 8000
let outputDevices     = []   // unified [{name, type:'midi'|'osc', ...}]
let midiOutputDevices = []   // [{name, device, sendTriggerNote, color}]  — derived from outputDevices
let midiOutputPorts   = []   // resolved MIDI output ports (parallel array)
let oscOutputDevices  = []   // [{name, enabled, host, port, sendTriggerNote, color}] — derived from outputDevices
let appLanguage = 'de'
let micGroupDisplay = true      // whether to bundle mic roles into group boxes in the UI
let effectiveDeviceStates = new Map()  // device key → {type, device, messages}
let effectiveMics       = null  // mic: value of last fired cue that had one
let micDevices = []   // array of device config objects (from settings.micDevices)

// t() is defined by dist/i18n.js which is loaded before bundle.js in index.html.
// Fallback for unit-test contexts where window.t may not exist.
function t(key) { return (window.t ? window.t(key) : null) ?? key }

// Kick off MIDI access request immediately at module load, before any async init.
// Electron 36 / Chromium requires this to be initiated early to avoid the
// promise hanging when called deep inside an async IPC callback chain.
const _midiAccessPromise = navigator.requestMIDIAccess({ sysex: true })
    .catch(e => { console.error('MIDI-Zugriff fehlgeschlagen:', e); return null })

// ── Scene Sidebar ────────────────────────────────────────────────────────────

function buildSidebar() {
    const list = document.getElementById('scene-list')
    if (!list) return
    list.innerHTML = ''
    const headings = [...document.querySelectorAll('#script-content h1, #script-content h2, #script-content h3')]
    // Temporarily un-sticky all headings so getBoundingClientRect reflects natural positions
    headings.forEach(h => { h.style.position = 'static' })
    const tops = headings.map(h => h.getBoundingClientRect().top + window.scrollY)
    headings.forEach(h => { h.style.position = '' })
    headings.forEach((h, idx) => {
        const btn = document.createElement('button')
        const isSub = h.tagName === 'H2' || h.tagName === 'H3'
        btn.className = 'scene-link' + (isSub ? ' scene-link-sub' : '')
        btn.textContent = h.textContent
        const top = tops[idx]
        btn.addEventListener('click', () => {
            window.scrollTo({ top, behavior: 'smooth' })
        })
        list.appendChild(btn)
    })
}

function toggleSidebar() {
    document.getElementById('scene-sidebar').classList.toggle('open')
}

// Highlight active scene in sidebar based on scroll position
function updateSidebarActive() {
    const headings = [...document.querySelectorAll('#script-content h1, #script-content h2, #script-content h3')]
    const links = [...document.querySelectorAll('#scene-list .scene-link')]
    if (!headings.length) return
    const scrollY = window.scrollY + 80
    let activeIdx = 0
    for (let i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top + window.scrollY <= scrollY) activeIdx = i
        else break
    }
    links.forEach((l, i) => l.classList.toggle('scene-link-active', i === activeIdx))
}

// ── Search ───────────────────────────────────────────────────────────────────

let searchMatches = []
let searchIdx = -1

function openSearch() {
    const bar = document.getElementById('search-bar')
    bar.classList.remove('hidden')
    const input = document.getElementById('search-input')
    input.focus()
    input.select()
}

function closeSearch() {
    document.getElementById('search-bar').classList.add('hidden')
    clearSearchHighlights()
    document.getElementById('search-count').textContent = ''
    searchMatches = []
    searchIdx = -1
}

function clearSearchHighlights() {
    document.querySelectorAll('mark.search-highlight').forEach(m => {
        m.replaceWith(document.createTextNode(m.textContent))
    })
    document.getElementById('script-content')?.normalize()
}

function doSearch(query) {
    clearSearchHighlights()
    searchMatches = []
    searchIdx = -1
    if (!query.trim()) {
        document.getElementById('search-count').textContent = ''
        return
    }
    const lower = query.toLowerCase()
    const walker = document.createTreeWalker(
        document.getElementById('script-content'), NodeFilter.SHOW_TEXT)
    const textNodes = []
    let node
    while ((node = walker.nextNode())) textNodes.push(node)

    for (const tn of textNodes) {
        const txt = tn.textContent
        const low = txt.toLowerCase()
        let pos = 0, fragments = [], found = false
        while (true) {
            const idx = low.indexOf(lower, pos)
            if (idx === -1) { fragments.push(document.createTextNode(txt.slice(pos))); break }
            if (idx > pos) fragments.push(document.createTextNode(txt.slice(pos, idx)))
            const mark = document.createElement('mark')
            mark.className = 'search-highlight'
            mark.textContent = txt.slice(idx, idx + query.length)
            fragments.push(mark)
            searchMatches.push(mark)
            pos = idx + query.length
            found = true
        }
        if (found) {
            const parent = tn.parentNode
            fragments.forEach(f => parent.insertBefore(f, tn))
            parent.removeChild(tn)
        }
    }

    const count = searchMatches.length
    if (count === 0) {
        document.getElementById('search-count').textContent = t('search.notfound')
        return
    }
    searchIdx = 0
    applySearchCurrent()
}

function applySearchCurrent() {
    searchMatches.forEach((m, i) => m.classList.toggle('search-current', i === searchIdx))
    const cur = searchMatches[searchIdx]
    if (cur) {
        cur.scrollIntoView({ behavior: 'smooth', block: 'center' })
        document.getElementById('search-count').textContent =
            `${searchIdx + 1}${t('search.result')}${searchMatches.length}`
    }
}

function searchStep(delta) {
    if (!searchMatches.length) return
    searchIdx = (searchIdx + delta + searchMatches.length) % searchMatches.length
    applySearchCurrent()
}

// ── Inline Text Editor ───────────────────────────────────────────────────────

let inlineEditor = null  // { ta?, el?, blockEl, lineStart, lineEnd, isNew, isAfterRole }
let acState = null       // { typed, match } — inline ghost text state

// Map data-block-idx k → { block, lineStart, lineEnd } using sequential search to handle duplicates
function getBlockInfo(k) {
    if (!scriptText) return null
    const blocks = tokenizeScript(scriptText)
    if (k < 0 || k >= blocks.length) return null
    let search = 0
    for (let i = 0; i <= k; i++) {
        const pos = scriptText.indexOf(blocks[i].content, search)
        if (pos < 0) return null
        if (i === k) {
            const lineStart = (scriptText.slice(0, pos).match(/\n/g) || []).length
            const lineEnd   = lineStart + blocks[k].content.split('\n').length - 1
            return { block: blocks[k], lineStart, lineEnd }
        }
        search = pos + blocks[i].content.length
    }
    return null
}

function isTriggerEl(el) {
    return el.classList.contains('trigger') || el.classList.contains('trigger-group') ||
           !!el.querySelector('.trigger, .trigger-group')
}

// ── Existing block editor helpers ─────────────────────────────────────────────

// Character offset of cursor in a contenteditable element.
// BR elements are counted as 1 char to match setCaretOffset.
function getCaretOffset(root) {
    const sel = window.getSelection()
    if (!sel.rangeCount) return 0
    const range = sel.getRangeAt(0)
    let chars = 0

    function countAll(node) {
        if (node.nodeType === Node.TEXT_NODE) { chars += node.length; return }
        if (node.tagName === 'BR') { chars++; return }
        for (const child of node.childNodes) countAll(child)
    }

    function walkTo(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node === range.startContainer) { chars += range.startOffset; return true }
            chars += node.length
            return false
        }
        if (node.tagName === 'BR') {
            chars++
            return false
        }
        if (node === range.startContainer) {
            for (let i = 0; i < range.startOffset; i++) countAll(node.childNodes[i])
            return true
        }
        for (const child of node.childNodes) {
            if (walkTo(child)) return true
        }
        return false
    }

    walkTo(root)
    return chars
}

function setCaretOffset(root, offset) {
    const sel = window.getSelection()
    let chars = 0
    function find(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (chars + node.length >= offset) {
                const r = document.createRange()
                r.setStart(node, offset - chars)
                r.collapse(true)
                sel.removeAllRanges(); sel.addRange(r)
                return true
            }
            chars += node.length
        } else if (node.tagName === 'BR') {
            chars++
            if (chars >= offset) {
                const r = document.createRange()
                r.setStartAfter(node)
                r.collapse(true)
                sel.removeAllRanges(); sel.addRange(r)
                return true
            }
        } else {
            for (const child of node.childNodes) if (find(child)) return true
        }
        return false
    }
    if (!find(root)) {
        const r = document.createRange()
        r.selectNodeContents(root); r.collapse(false)
        sel.removeAllRanges(); sel.addRange(r)
    }
}

// True when the cursor is visually on the first / last line of the element
function editorCursorOnFirstLine(el) {
    const sel = window.getSelection()
    if (!sel.rangeCount || !sel.isCollapsed) return false
    const rects = sel.getRangeAt(0).getClientRects()
    if (!rects.length) return true
    return rects[0].top < el.getBoundingClientRect().top + 26
}

function editorCursorOnLastLine(el) {
    const sel = window.getSelection()
    if (!sel.rangeCount || !sel.isCollapsed) return false
    const rects = sel.getRangeAt(0).getClientRects()
    if (!rects.length) return true
    return rects[rects.length - 1].bottom > el.getBoundingClientRect().bottom - 26
}

// Insert a <br> at the current cursor in a contenteditable.
// Adds a sentinel <br> when at end-of-content so the new line is immediately visible.
function insertRoleLineBreak() {
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    // Insert visual marker + actual <br>
    const marker = document.createElement('span')
    marker.className = 'br-marker'
    marker.contentEditable = 'false'
    marker.textContent = '↵'
    const br = document.createElement('br')
    range.insertNode(br)
    br.before(marker)
    // Contenteditable quirk: a trailing <br> is invisible without content after it.
    // Add a sentinel <br> so the new line shows up; it gets stripped on save.
    let hasContentAfter = false
    let node = br.nextSibling
    while (node) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent) { hasContentAfter = true; break }
        if (node.tagName === 'BR') { hasContentAfter = true; break }
        node = node.nextSibling
    }
    if (!hasContentAfter) {
        const sentinel = document.createElement('br')
        br.after(sentinel)
    }
    range.setStartAfter(br)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
}

// Serialize a DOM node in the role editor back to a markdown-like string,
// preserving <br> elements as the literal string "<br>".
function serializeRoleNode(n) {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent
    if (n.tagName === 'BR') return '<br>'
    if (n.classList?.contains('br-marker')) return ''  // visual-only indicator, not stored
    if (n.classList?.contains('editor-stage-inline')) {
        const t = n.textContent
        return (t.startsWith('(') && t.endsWith(')')) ? '*' + t + '*' : t
    }
    let t = ''
    for (const c of n.childNodes) t += serializeRoleNode(c)
    return t
}

// Append parsed dialogue text (with inline stage direction coloring) to parent element.
// Recognizes both *(text)* (markdown) and plain (text) (user-typed, auto-converted on save).
function appendDialogueParsed(parent, text, roleColor) {
    // Strip soft sentence-wrap newlines (added by wrapSentences for markdown readability).
    // Hard line breaks are represented as the literal string "<br>" and handled below.
    text = text.replace(/\n/g, ' ')

    const re = /\*\(([^)]+)\)\*|\(([^)]+)\)|<br>/g
    let last = 0, m
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
            const s = document.createElement('span')
            s.className = 'editor-role-text'
            if (roleColor) s.style.color = roleColor
            s.textContent = text.slice(last, m.index)
            parent.appendChild(s)
        }
        if (m[0] === '<br>') {
            // Show a visible indicator before the actual line break
            const marker = document.createElement('span')
            marker.className = 'br-marker'
            marker.contentEditable = 'false'
            marker.textContent = '↵'
            parent.appendChild(marker)
            parent.appendChild(document.createElement('br'))
        } else {
            const inner = m[1] ?? m[2]
            const s = document.createElement('span')
            s.className = 'editor-stage-inline'
            s.textContent = '(' + inner + ')'
            parent.appendChild(s)
        }
        last = re.lastIndex
    }
    if (last < text.length) {
        const s = document.createElement('span')
        s.className = 'editor-role-text'
        if (roleColor) s.style.color = roleColor
        s.textContent = text.slice(last)
        parent.appendChild(s)
    }
}

// Parse markdown block content into styled HTML inside div
function parseBlockToHTML(content, div) {
    div.innerHTML = ''
    // Stage direction: *...*
    const stageM = content.match(/^\*((?:[^*]|\*(?!\*))+)\*$/)
    if (stageM) {
        div.dataset.editorType = 'stage'
        const s = document.createElement('span')
        s.className = 'editor-stage-text'
        s.textContent = stageM[1].trim()
        div.appendChild(s)
        return
    }
    // Role block: **Name** or **Name1/Name2/…** with optional \nDialogue
    const roleM = content.match(/^\*\*([^*]+)\*\*(?:\n([\s\S]*))?$/)
    if (roleM) {
        div.dataset.editorType = 'role'
        const roleNames = roleM[1].split('/').map(s => s.trim()).filter(Boolean)
        const dialogue = (roleM[2] || '').trimEnd()
        for (let i = 0; i < roleNames.length; i++) {
            if (i > 0) {
                const sep = document.createElement('span')
                sep.className = 'editor-role-separator'
                sep.contentEditable = 'false'
                sep.textContent = ' / '
                div.appendChild(sep)
            }
            const ns = document.createElement('span')
            ns.className = 'editor-role-name'
            ns.textContent = roleNames[i]
            const roleColor = ROLE_COLORS[config.roles?.[roleNames[i]]?.color]
                           || ROLE_COLORS[getGroupColor(roleNames[i])] || ''
            if (roleColor) ns.style.color = roleColor
            div.appendChild(ns)
        }
        if (dialogue) {
            const primaryColor = ROLE_COLORS[config.roles?.[roleNames[0]]?.color]
                              || ROLE_COLORS[getGroupColor(roleNames[0])] || ''
            appendDialogueParsed(div, dialogue, primaryColor)
        }
        return
    }
    div.dataset.editorType = 'text'
    div.appendChild(document.createTextNode(content))
}

// Re-color parenthetical text in the dialogue portion after each keystroke
function updateEditorParens(div) {
    if (div.dataset.editorType !== 'role') return
    const nameSpans = div.querySelectorAll('.editor-role-name')
    const nameSpan = nameSpans[nameSpans.length - 1]  // last name span — dialogue follows it
    if (!nameSpan) return
    const roleColor = ROLE_COLORS[config.roles?.[nameSpans[0].textContent]?.color]
                   || ROLE_COLORS[getGroupColor(nameSpans[0].textContent)] || ''

    const caretOffset = getCaretOffset(div)
    const afterName = []
    let seen = false
    for (const n of div.childNodes) { if (seen) afterName.push(n); if (n === nameSpan) seen = true }
    // Serialize back to markdown so *(text)* patterns survive the rebuild.
    // Only re-wrap editor-stage-inline spans that still contain balanced (...) —
    // a partially deleted span must not emit raw asterisks into the text.
    // Strip trailing <br> tokens (sentinel line breaks added by insertRoleLineBreak)
    // to avoid reconstructing spurious br-marker+<br> pairs on rebuild.
    const dialogue = afterName.map(serializeRoleNode).join('').replace(/(<br>)+$/, '')
    afterName.forEach(n => n.remove())
    appendDialogueParsed(div, dialogue, roleColor)
    setCaretOffset(div, caretOffset)
}

// Common abbreviations and single capital letters (e.g. "H." in "H. Grönemeyer") that must
// not trigger a sentence break even though they are followed by a capital letter.
const SENTENCE_ABBREVS_RE = /^(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Inc|Ltd|Co|Gen|Sgt|Lt|Cpt|Nr|Str|bzw|usw|etc|ggf|bzgl|ca|vs|vgl|Abb|Bd)$/i

function _isAbbrevBefore(str, dotOffset) {
    const m = str.slice(0, dotOffset).match(/(\S+)$/)
    if (!m) return false
    const word = m[1]
    return /^[A-Za-zÄÖÜäöüß]$/.test(word) || SENTENCE_ABBREVS_RE.test(word)
}

// Split dialogue text at sentence boundaries so each sentence starts on its own line.
// Does NOT split after abbreviations like Mr., Dr., H., etc.
function wrapSentences(text) {
    return text.replace(/([.!?])[ \t]+(?=[A-ZÄÖÜ"])/g, (match, punct, offset, str) => {
        if (punct === '.' && _isAbbrevBefore(str, offset)) return match
        return punct + '\n'
    })
}

// Custom confirm dialog — returns a Promise<boolean>.
function showConfirmDialog({ title, body, confirmLabel = 'Ja', cancelLabel = 'Abbrechen', img = null }) {
    return new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'dialog-overlay'
        overlay.style.zIndex = '9999'
        overlay.addEventListener('mousedown', e => e.stopPropagation())

        const box = document.createElement('div')
        box.className = 'dialog-box'

        const h3 = document.createElement('h3')
        h3.textContent = title

        const bodyEl = document.createElement('p')
        bodyEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 1.5rem;line-height:1.6'
        bodyEl.innerHTML = DOMPurify.sanitize(body, { ALLOWED_TAGS: ['strong', 'br'], ALLOWED_ATTR: [] })

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'

        const close = (val) => { overlay.remove(); resolve(val) }
        const cancelBtn = cancelLabel ? document.createElement('button') : null
        if (cancelBtn) {
            cancelBtn.className  = 'dialog-btn'
            cancelBtn.textContent = cancelLabel
            cancelBtn.addEventListener('click', () => close(false))
        }

        const confirmBtn = document.createElement('button')
        confirmBtn.className  = 'dialog-btn dialog-btn-primary'
        confirmBtn.textContent = confirmLabel
        confirmBtn.addEventListener('click', () => close(true))

        actions.append(...(cancelBtn ? [cancelBtn] : []), confirmBtn)
        const imgEl = img ? Object.assign(document.createElement('img'), {
            src: img,
            style: 'width:75%;border-radius:4px;margin:0 auto 0.8rem;display:block',
        }) : null
        box.append(...(imgEl ? [imgEl] : []), h3, bodyEl, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        ;(cancelBtn ?? confirmBtn).focus()
    })
}

const GITHUB_RELEASES = 'https://github.com/julius-b-mueller/MDstage/releases'

function showUpdateInfoDialog(appVersion) {
    return new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'dialog-overlay'
        overlay.style.zIndex = '9999'
        overlay.addEventListener('mousedown', e => e.stopPropagation())

        const box = document.createElement('div')
        box.className = 'dialog-box'

        const imgEl = document.createElement('img')
        imgEl.src = 'assets/update.png'
        imgEl.style.cssText = 'width:75%;border-radius:4px;margin:0 auto 0.8rem;display:block'

        const h3 = document.createElement('h3')
        h3.textContent = t('upd.title')

        const bodyEl = document.createElement('p')
        bodyEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 0.4rem;line-height:1.6'
        bodyEl.textContent = t('upd.body')

        const hintEl = document.createElement('p')
        hintEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 0.8rem;line-height:1.6'
        hintEl.textContent = t('upd.hint')

        const versionEl = document.createElement('p')
        versionEl.style.cssText = 'color:#5c6370;font-size:0.85rem;margin:0 0 1rem'
        versionEl.textContent = t('upd.version') + ': ' + appVersion

        const linkBtn = document.createElement('button')
        linkBtn.className = 'dialog-btn'
        linkBtn.textContent = t('upd.link')
        linkBtn.style.cssText = 'margin-bottom:1.2rem;width:100%'
        linkBtn.addEventListener('click', () => window.electronAPI.openExternalUrl(GITHUB_RELEASES))

        const checkRow = document.createElement('label')
        checkRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem;font-size:0.88rem;color:#5c6370;margin-bottom:1.2rem;cursor:pointer'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        const checkLabel = document.createElement('span')
        checkLabel.textContent = t('upd.dismiss')
        checkRow.append(checkbox, checkLabel)

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'
        actions.style.justifyContent = 'flex-end'
        const okBtn = document.createElement('button')
        okBtn.className = 'dialog-btn dialog-btn-primary'
        okBtn.textContent = t('upd.ok')
        okBtn.addEventListener('click', () => { overlay.remove(); resolve(checkbox.checked) })
        actions.append(okBtn)

        box.append(imgEl, h3, bodyEl, hintEl, versionEl, linkBtn, checkRow, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        okBtn.focus()
    })
}

function showVersionMismatchDialog(fileVersion, appVersion) {
    return new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'dialog-overlay'
        overlay.style.zIndex = '9999'
        overlay.addEventListener('mousedown', e => e.stopPropagation())

        const box = document.createElement('div')
        box.className = 'dialog-box'

        const imgEl = document.createElement('img')
        imgEl.src = 'assets/version-mismatch.png'
        imgEl.style.cssText = 'width:75%;border-radius:4px;margin:0 auto 0.8rem;display:block'

        const h3 = document.createElement('h3')
        h3.textContent = t('ver.mismatch.title')

        const createdEl = document.createElement('p')
        createdEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 0.2rem;line-height:1.6'
        createdEl.textContent = t('ver.mismatch.created').replace('%1', fileVersion)

        const currentEl = document.createElement('p')
        currentEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 0.8rem;line-height:1.6'
        currentEl.textContent = t('ver.mismatch.current').replace('%1', appVersion)

        const hintEl = document.createElement('p')
        hintEl.style.cssText = 'color:#5c6370;font-size:0.85rem;margin:0 0 1rem;line-height:1.6'
        hintEl.textContent = t('ver.mismatch.hint')

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'
        const close = () => { overlay.remove(); resolve(false) }

        const okBtn = document.createElement('button')
        okBtn.className = 'dialog-btn dialog-btn-primary'
        okBtn.textContent = t('ver.mismatch.ok')
        okBtn.addEventListener('click', () => close())

        const els = [imgEl, h3, createdEl, currentEl, hintEl]
        if (/^\d+\.\d+\.\d+$/.test(fileVersion)) {
            const linkBtn = document.createElement('button')
            linkBtn.className = 'dialog-btn'
            linkBtn.textContent = t('ver.mismatch.link').replace('%1', fileVersion)
            linkBtn.style.cssText = 'margin-bottom:1.2rem;width:100%'
            linkBtn.addEventListener('click', () =>
                window.electronAPI.openExternalUrl(GITHUB_RELEASES + '/tag/' + fileVersion)
            )
            els.push(linkBtn)
        }
        actions.append(okBtn)
        box.append(...els, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        okBtn.focus()
    })
}

// Sentence splitter for the formatter — also handles closing quotes/parens before the space.
// Does NOT split after abbreviations like Mr., Dr., H., etc.
function wrapSentencesFormat(text) {
    return text.replace(/([.!?][“””»)]*)\s+(?=[A-ZÄÖÜ„”(])/g, (match, punct, offset, str) => {
        if (punct.startsWith('.') && _isAbbrevBefore(str, offset)) return match
        return punct + '\n'
    })
}

// Format a script text to canonical style:
//   • blank line after every heading
//   • blank line before/after every standalone stage direction (*...*)
//   • blank line before every role name (**Name**)
//   • sentence wrapping on dialogue lines
//   • collapse multiple blank lines to one
// yaml code fences are passed through unchanged.
function formatScriptText(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const out = []
    let inYaml = false

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()

        // Track yaml fences — pass through unchanged
        if (!inYaml && trimmed === '```yaml') { inYaml = true;  out.push(line); continue }
        if ( inYaml && trimmed === '```')      { inYaml = false; out.push(line); continue }
        if (inYaml) { out.push(line); continue }

        const isBlank   = trimmed === ''
        const isHeading = /^#{1,6} /.test(trimmed)
        // Stage direction: line wrapped in *…* (optionally ending with ^)
        const isStage   = /^\*[^*]/.test(trimmed) && /\*\^?$/.test(trimmed)
        // Role name: **Name** alone on the line
        const isRole    = /^\*\*[^*]/.test(trimmed) && /\*\*$/.test(trimmed)

        const prevBlankNow = () => out.length === 0 || out[out.length - 1].trim() === ''
        const nextIsBlank  = () => i + 1 >= lines.length || lines[i + 1].trim() === ''

        if (isHeading) {
            out.push(line)
            if (!nextIsBlank()) out.push('')
            continue
        }

        if (isStage) {
            if (!prevBlankNow()) out.push('')
            out.push(line)
            if (!nextIsBlank()) out.push('')
            continue
        }

        if (isRole) {
            if (!prevBlankNow()) out.push('')
            out.push(line)
            continue
        }

        if (!isBlank) {
            // Dialogue / narrative text — wrap at sentence boundaries
            const wrapped = wrapSentencesFormat(trimmed)
            for (const sl of wrapped.split('\n')) out.push(sl)
            continue
        }

        out.push(line)
    }

    // Collapse consecutive blank lines to one
    const result = []
    let prevWasBlank = false
    for (const line of out) {
        const blank = line.trim() === ''
        if (blank && prevWasBlank) continue
        result.push(line)
        prevWasBlank = blank
    }

    // Strip leading/trailing blank lines, ensure single trailing newline
    while (result.length > 0 && result[0].trim() === '')             result.shift()
    while (result.length > 0 && result[result.length - 1].trim() === '') result.pop()
    return result.join('\n') + '\n'
}

function needsFormatting(text) {
    return formatScriptText(text) !== text
}

// Convert styled contenteditable HTML back to markdown
function serializeEditorMarkdown(div) {
    function textOf(node, brTag = false) {
        let t = ''
        for (const c of node.childNodes) {
            if (c.nodeType === Node.TEXT_NODE) t += c.textContent
            else if (c.tagName === 'BR') t += brTag ? '<br>' : '\n'
            else t += textOf(c, brTag)
        }
        return t
    }
    if (div.dataset.editorType === 'stage') {
        const stageText = textOf(div).trim()
        return stageText ? '*' + stageText + '*' : ''
    }
    if (div.dataset.editorType === 'text') {
        const raw = textOf(div).trim()
        // Re-append space so "# " or "## " stays valid ATX-heading markdown after trim
        return /^#{1,6}$/.test(raw) ? raw + ' ' : raw
    }
    if (div.dataset.editorType === 'role') {
        const nameSpans = [...div.querySelectorAll('.editor-role-name')]
        const roleName = nameSpans.map(s => s.textContent).join('/')
        const lastNameSpan = nameSpans[nameSpans.length - 1]
        let dialogueParts = []
        let afterName = false
        for (const node of div.childNodes) {
            if (node === lastNameSpan) { afterName = true; continue }
            if (afterName && !node.classList?.contains('editor-role-separator')) {
                dialogueParts.push(serializeRoleNode(node))
            }
        }
        const dialogue = wrapSentences(dialogueParts.join('').replace(/(<br>)+$/, '').trim())
        return dialogue ? '**' + roleName + '**\n' + dialogue : '**' + roleName + '**'
    }
    return textOf(div).trim()  // fallback (should not normally be reached)
}

// ── Role-change dropdown ───────────────────────────────────────────────────────

function openRoleChangeDropdown(nameSpan, editorEl, opts = {}) {
    document.getElementById('role-change-dropdown')?.remove()

    let roleSelected = false
    const allRoles = Object.keys(config.roles || {})
    const allGroups = [...Object.keys(config.groups || {}), 'Alle']
    // Exclude names already in the block (except the one currently on this span)
    const takenNames = new Set(
        [...editorEl.querySelectorAll('.editor-role-name')]
            .map(n => n.textContent)
            .filter(name => name !== nameSpan.textContent && name !== '?')
    )
    const roles  = allRoles.filter(r => !takenNames.has(r))
    const groups = allGroups.filter(g => !takenNames.has(g))
    if (!roles.length && !groups.length) return

    const dropdown = document.createElement('div')
    dropdown.id = 'role-change-dropdown'
    dropdown.style.cssText = `
        position: fixed;
        background: #21252b;
        border: 1px solid #4b5263;
        border-radius: 5px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        z-index: 300;
        min-width: 10rem;
        padding: 0.3rem 0;
        font-size: 0.95rem;
        max-height: 60vh;
        overflow-y: auto;
        overscroll-behavior: contain;
    `

    const rect = nameSpan.getBoundingClientRect()
    dropdown.style.left = rect.left + 'px'
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    if (spaceBelow >= 80 || spaceBelow >= spaceAbove) {
        dropdown.style.top = (rect.bottom + 4) + 'px'
        dropdown.style.maxHeight = Math.min(spaceBelow, window.innerHeight * 0.6) + 'px'
    } else {
        dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px'
        dropdown.style.top = 'auto'
        dropdown.style.maxHeight = Math.min(spaceAbove, window.innerHeight * 0.6) + 'px'
    }

    // ── Action row: two halves (−  |  +) ──────────────────────────────────────
    if (!opts.noActionRow) {
        const allNameSpansNow = () => [...editorEl.querySelectorAll('.editor-role-name')]
        const canRemove = allNameSpansNow().length > 1

        const actionRow = document.createElement('div')
        actionRow.style.cssText = `
            display: flex;
            border-bottom: 1px solid #4b5263;
            margin-bottom: 0.2rem;
        `

        const halfStyle = (dimmed) => `
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0.35rem 0;
            cursor: ${dimmed ? 'default' : 'pointer'};
            color: ${dimmed ? '#5c6370' : '#abb2bf'};
            font-size: 1.1rem;
            user-select: none;
        `

        const removeHalf = document.createElement('div')
        removeHalf.textContent = '−'
        removeHalf.title = 'Rolle entfernen'
        removeHalf.style.cssText = halfStyle(!canRemove)
        if (canRemove) {
            removeHalf.addEventListener('mouseenter', () => { removeHalf.style.background = '#2c313a' })
            removeHalf.addEventListener('mouseleave', () => { removeHalf.style.background = '' })
            removeHalf.addEventListener('mousedown', (e) => {
                e.preventDefault()
                dropdown.remove()
                const prev = nameSpan.previousSibling
                const next = nameSpan.nextSibling
                if (prev?.classList?.contains('editor-role-separator')) prev.remove()
                else if (next?.classList?.contains('editor-role-separator')) next.remove()
                nameSpan.remove()
                const remaining = editorEl.querySelectorAll('.editor-role-name')
                const firstColor = ROLE_COLORS[config.roles?.[remaining[0]?.textContent]?.color] || ''
                const lastRemaining = remaining[remaining.length - 1]
                let after = false
                for (const node of editorEl.childNodes) {
                    if (node === lastRemaining) { after = true; continue }
                    if (after && node.nodeType === Node.ELEMENT_NODE && node.classList.contains('editor-role-text')) {
                        node.style.color = firstColor
                    }
                }
            })
        }

        const divider = document.createElement('div')
        divider.style.cssText = 'width: 1px; background: #4b5263; flex-shrink: 0;'

        const addHalf = document.createElement('div')
        addHalf.textContent = '+'
        addHalf.title = 'Weitere Rolle hinzufügen'
        addHalf.style.cssText = halfStyle(false)
        addHalf.addEventListener('mouseenter', () => { addHalf.style.background = '#2c313a' })
        addHalf.addEventListener('mouseleave', () => { addHalf.style.background = '' })
        addHalf.addEventListener('mousedown', (e) => {
            e.preventDefault()
            dropdown.remove()
            const currentSpans = allNameSpansNow()
            const lastNs = currentSpans[currentSpans.length - 1]

            const sep = document.createElement('span')
            sep.className = 'editor-role-separator'
            sep.contentEditable = 'false'
            sep.textContent = ' / '
            lastNs.after(sep)

            const newNs = document.createElement('span')
            newNs.className = 'editor-role-name'
            newNs.contentEditable = 'false'
            newNs.textContent = '?'
            newNs.style.cssText = 'color: #5c6370; font-style: italic;'
            sep.after(newNs)

            newNs.addEventListener('mousedown', (ev) => {
                ev.preventDefault()
                openRoleChangeDropdown(newNs, editorEl)
            })

            requestAnimationFrame(() => openRoleChangeDropdown(newNs, editorEl, {
                noActionRow: true,
                onCancel: () => { sep.remove(); newNs.remove() },
                onSelect: (roleName) => {
                    newNs.style.cssText = ''
                    const c = ROLE_COLORS[config.roles?.[roleName]?.color] || ''
                    if (c) newNs.style.color = c
                }
            }))
        })

        actionRow.appendChild(removeHalf)
        actionRow.appendChild(divider)
        actionRow.appendChild(addHalf)
        dropdown.appendChild(actionRow)
    }

    function makeDropdownItem(name, color) {
        const item = document.createElement('div')
        item.style.cssText = `padding: 0.4rem 1rem; cursor: pointer; color: ${color || '#abb2bf'}; white-space: nowrap;`
        item.textContent = name
        item.addEventListener('mouseenter', () => { item.style.background = '#2c313a' })
        item.addEventListener('mouseleave', () => { item.style.background = '' })
        item.addEventListener('mousedown', (e) => {
            e.preventDefault()
            roleSelected = true
            dropdown.remove()
            opts.onSelect?.(name)
            const newColor = ROLE_COLORS[config.roles?.[name]?.color] || ROLE_COLORS[getGroupColor(name)] || ''
            nameSpan.textContent = name
            nameSpan.style.color = newColor || ''
            const allNameSpans = editorEl.querySelectorAll('.editor-role-name')
            const firstColor = ROLE_COLORS[config.roles?.[allNameSpans[0]?.textContent]?.color]
                            || ROLE_COLORS[getGroupColor(allNameSpans[0]?.textContent)] || ''
            const lastNameSpan = allNameSpans[allNameSpans.length - 1]
            let afterLast = false
            for (const node of editorEl.childNodes) {
                if (node === lastNameSpan) { afterLast = true; continue }
                if (afterLast && node.nodeType === Node.ELEMENT_NODE && node.classList.contains('editor-role-text')) {
                    node.style.color = firstColor
                }
            }
            requestAnimationFrame(() => { editorEl.focus(); placeCaretAfterRoleName(editorEl) })
        })
        return item
    }

    for (const roleName of roles) {
        dropdown.appendChild(makeDropdownItem(roleName, ROLE_COLORS[config.roles[roleName]?.color]))
    }

    if (groups.length > 0) {
        if (roles.length > 0) {
            const sep = document.createElement('div')
            sep.style.cssText = 'height:1px;background:#4b5263;margin:0.2rem 0;'
            dropdown.appendChild(sep)
        }
        for (const gName of groups) {
            const gColor = ROLE_COLORS[getGroupColor(gName)] || '#abb2bf'
            const item = makeDropdownItem(gName, gColor)
            const badge = document.createElement('span')
            badge.textContent = ' ↗'
            badge.style.cssText = 'font-size:0.7em;opacity:0.6;'
            item.appendChild(badge)
            dropdown.appendChild(item)
        }
    }

    document.body.appendChild(dropdown)

    function closeDropdown() {
        dropdown.remove()
        document.removeEventListener('mousedown', onOutside, true)
        document.removeEventListener('keydown',   onEsc,     true)
        window.removeEventListener('scroll',      onScroll,  true)
    }
    function onOutside(e) {
        if (dropdown.contains(e.target)) return
        if (!roleSelected) opts.onCancel?.()
        closeDropdown()
    }
    function onEsc(e) {
        if (e.key !== 'Escape') return
        if (!roleSelected) opts.onCancel?.()
        closeDropdown()
    }
    // Only close on scroll if it's the page scrolling, not the dropdown itself
    function onScroll(e)  { if (!dropdown.contains(e.target) && e.target !== dropdown) closeDropdown() }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown',   onEsc,     true)
    window.addEventListener('scroll',      onScroll,  true)
}

// ── Existing block editor ──────────────────────────────────────────────────────

function openEditor(blockEl, clientX, clientY) {
    if (inlineEditor) closeEditor(true)
    const k = parseInt(blockEl.dataset.blockIdx)
    if (isNaN(k) || k < 0) return
    const info = getBlockInfo(k)
    if (!info || info.block.type === 'yaml') return

    const rect = blockEl.getBoundingClientRect()

    const wrapper = document.createElement('div')
    wrapper.className = 'editor-wrapper'
    wrapper.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;`

    const el = document.createElement('div')
    el.className = 'inline-editor'
    el.contentEditable = 'true'
    parseBlockToHTML(info.block.content, el)
    wrapper.appendChild(el)

    const controls = document.createElement('div')
    controls.className = 'editor-controls'
    const btnUp   = document.createElement('button')
    btnUp.className = 'editor-btn'; btnUp.textContent = '▲'; btnUp.title = t('editor.up.title')
    const btnDown = document.createElement('button')
    btnDown.className = 'editor-btn'; btnDown.textContent = '▼'; btnDown.title = t('editor.down.title')
const btnDel  = document.createElement('button')
    btnDel.className = 'editor-btn editor-btn-delete'; btnDel.textContent = '✕'; btnDel.title = t('editor.del2.title')
    controls.append(btnUp, btnDown, btnDel)
    wrapper.appendChild(controls)

    document.body.appendChild(wrapper)
    el.focus()
    // Place cursor at end
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)

    blockEl.style.visibility = 'hidden'
    inlineEditor = { el, blockEl, lineStart: info.lineStart, lineEnd: info.lineEnd, isNew: false }

    // Track scroll so the fixed wrapper follows the block
    function onEditorScroll() {
        if (!inlineEditor?.blockEl) return
        const w = inlineEditor.el.closest('.editor-wrapper')
        if (!w) return
        const r2 = inlineEditor.blockEl.getBoundingClientRect()
        w.style.top = r2.top + 'px'
    }
    inlineEditor._scrollHandler = onEditorScroll
    window.addEventListener('scroll', onEditorScroll, { passive: true })

    el.addEventListener('keydown', onEditorKey)
    el.addEventListener('input',   onEditorInput)
    el.addEventListener('blur',    () => setTimeout(() => {
        if (inlineEditor?.el === el) closeEditor(true)
    }, 180))

    // Role name(s): make non-editable, prevent cursor from entering, click opens dropdown
    if (el.dataset.editorType === 'role') {
        el.querySelectorAll('.editor-role-name, .editor-role-separator').forEach(span => {
            span.contentEditable = 'false'
        })
        el.querySelectorAll('.editor-role-name').forEach(nameSpan => {
            nameSpan.addEventListener('mousedown', (e) => {
                e.preventDefault()
                openRoleChangeDropdown(nameSpan, el)
            })
        })
        // Clamp cursor on selectionchange (catches mouse clicks, triple-click, drag-select, etc.)
        function clampRoleCaret() {
            if (!inlineEditor?.el) return
            if (caretIsInRoleName(inlineEditor.el)) { placeCaretAfterRoleName(inlineEditor.el); return }
            // Snap out of the gap between a br-marker and its <br> (e.g. from mouse click on ↵)
            const sel = window.getSelection()
            if (!sel?.rangeCount || !sel.isCollapsed) return
            const range = sel.getRangeAt(0)
            const prev = nodeBeforeCaret(range)
            if (prev?.classList?.contains('br-marker')) {
                // Cursor is in the gap — snap backward to before the marker (end of prev line)
                const r = document.createRange()
                r.setStartBefore(prev)
                r.collapse(true)
                sel.removeAllRanges(); sel.addRange(r)
            }
        }
        inlineEditor._caretClampHandler = clampRoleCaret
        document.addEventListener('selectionchange', clampRoleCaret)
    }

    btnUp.addEventListener('mousedown',   (e) => { e.preventDefault(); moveBlock(-1) })
    btnDown.addEventListener('mousedown', (e) => { e.preventDefault(); moveBlock(1) })
    btnDel.addEventListener('mousedown',  (e) => { e.preventDefault(); deleteBlock() })

    requestAnimationFrame(syncEditorHeight)
}

function syncEditorHeight() {
    if (!inlineEditor?.blockEl) return
    const wrapper = inlineEditor.el.closest('.editor-wrapper')
    if (wrapper) inlineEditor.blockEl.style.minHeight = wrapper.offsetHeight + 'px'
}

// Places the cursor right AFTER the last role name span (start of dialogue).
function placeCaretAfterRoleName(el) {
    const spans = el?.querySelectorAll('.editor-role-name')
    const ns = spans?.[spans.length - 1]
    if (!ns) return
    const sel = window.getSelection()
    const r = document.createRange()
    r.setStartAfter(ns)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
}

// Returns true if the cursor is inside any role name span or before the first one.
function caretIsInRoleName(el) {
    const nameSpans = el?.querySelectorAll('.editor-role-name')
    if (!nameSpans?.length) return false
    const sel = window.getSelection()
    if (!sel?.rangeCount) return false
    const range = sel.getRangeAt(0)
    for (const ns of nameSpans) {
        if (ns.contains(range.startContainer)) return true
    }
    // Edge case: cursor at el offset 0 (before all spans)
    if (range.startContainer === el && range.startOffset === 0) return true
    return false
}

// Returns the DOM node immediately following the cursor (at end of line / end of node).
// Walks up to parent if cursor is at the end of a text node inside a span.
function nodeAfterCaret(range) {
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
        if (range.startOffset < range.startContainer.length) return null
        // At end of text node — look at next sibling, then parent's next sibling
        return range.startContainer.nextSibling
            ?? range.startContainer.parentNode?.nextSibling
            ?? null
    }
    return range.startContainer.childNodes[range.startOffset] ?? null
}

// Returns the DOM node immediately before the cursor.
function nodeBeforeCaret(range) {
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
        if (range.startOffset > 0) return null
        // At start of text node — look at prev sibling, then parent's prev sibling
        return range.startContainer.previousSibling
            ?? range.startContainer.parentNode?.previousSibling
            ?? null
    }
    return range.startContainer.childNodes[range.startOffset - 1] ?? null
}

function onEditorKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(true); return }

    // Clamp cursor: don't let it move into any role name span
    if (inlineEditor?.el?.dataset.editorType === 'role') {
        const el = inlineEditor.el
        const nameSpans = el.querySelectorAll('.editor-role-name')
        const lastNs = nameSpans[nameSpans.length - 1]
        if (lastNs) {
            if (e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'Backspace') {
                // Check if cursor is at the very start of dialogue (right after last name span)
                const sel = window.getSelection()
                const range = sel?.rangeCount ? sel.getRangeAt(0) : null
                if (!range) { e.preventDefault(); return }
                const atDialogueStart =
                    (range.startContainer === el && range.startOffset <= nameSpans.length) ||
                    caretIsInRoleName(el) ||
                    (range.startOffset === 0 &&
                     range.startContainer.nodeType === Node.TEXT_NODE &&
                     range.startContainer.parentNode?.previousSibling === lastNs)
                if (atDialogueStart) {
                    e.preventDefault()
                    if (caretIsInRoleName(el)) placeCaretAfterRoleName(el)
                    return
                }
            }
            if (caretIsInRoleName(el) && e.key !== 'Escape') {
                // Any other key while inside name: block and move caret out
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault()
                    placeCaretAfterRoleName(el)
                    return
                }
            }
        }

        // Skip br-marker on ArrowRight: jump directly past both marker and <br>
        if (e.key === 'ArrowRight') {
            const sel = window.getSelection()
            const range = sel?.rangeCount ? sel.getRangeAt(0) : null
            if (range) {
                const next = nodeAfterCaret(range)
                if (next?.classList?.contains('br-marker')) {
                    const br = next.nextSibling
                    if (br?.tagName === 'BR') {
                        e.preventDefault()
                        const r = document.createRange()
                        r.setStartAfter(br)
                        r.collapse(true)
                        sel.removeAllRanges(); sel.addRange(r)
                        return
                    }
                }
                // Cursor is already between br-marker and <br> — skip the <br>
                const prev = nodeBeforeCaret(range)
                if (prev?.classList?.contains('br-marker')) {
                    const br = nodeAfterCaret(range)
                    if (br?.tagName === 'BR') {
                        e.preventDefault()
                        const r = document.createRange()
                        r.setStartAfter(br)
                        r.collapse(true)
                        sel.removeAllRanges(); sel.addRange(r)
                        return
                    }
                }
            }
        }

        // Backspace at start of a post-br line: remove both <br> and the preceding br-marker
        if (e.key === 'Backspace') {
            const sel = window.getSelection()
            const range = sel?.rangeCount ? sel.getRangeAt(0) : null
            if (range && range.collapsed) {
                const prev = nodeBeforeCaret(range)
                let br = null, marker = null
                if (prev?.tagName === 'BR') {
                    // Cursor is right after <br>
                    br = prev
                    if (br.previousSibling?.classList?.contains('br-marker')) marker = br.previousSibling
                } else if (prev?.classList?.contains('br-marker')) {
                    // Cursor is between br-marker and <br>
                    marker = prev
                    if (marker.nextSibling?.tagName === 'BR') br = marker.nextSibling
                }
                if (br && marker) {
                    e.preventDefault()
                    // Remove nodes first, then place cursor — avoids detached-range issues
                    const parent    = marker.parentNode
                    const beforeNode = marker.previousSibling
                    marker.remove()
                    br.remove()
                    const r = document.createRange()
                    if (beforeNode) r.setStartAfter(beforeNode)
                    else            r.setStart(parent, 0)
                    r.collapse(true)
                    sel.removeAllRanges(); sel.addRange(r)
                    onEditorInput.call(el)
                    return
                }
            }
        }

        // Delete at end of a line: remove the br-marker + <br> pair going forward
        if (e.key === 'Delete') {
            const sel = window.getSelection()
            const range = sel?.rangeCount ? sel.getRangeAt(0) : null
            if (range && range.collapsed) {
                const next = nodeAfterCaret(range)
                let marker = null, br = null
                if (next?.classList?.contains('br-marker')) {
                    marker = next
                    if (marker.nextSibling?.tagName === 'BR') br = marker.nextSibling
                } else if (next?.tagName === 'BR' && nodeBeforeCaret(range)?.classList?.contains('br-marker')) {
                    // Cursor is in the gap between marker and <br>
                    br = next; marker = br.previousSibling
                }
                if (marker && br) {
                    e.preventDefault()
                    marker.remove(); br.remove()
                    onEditorInput.call(el)
                    return
                }
            }
        }

        // Skip br-marker on ArrowLeft: jump directly before the marker
        if (e.key === 'ArrowLeft') {
            const sel = window.getSelection()
            const range = sel?.rangeCount ? sel.getRangeAt(0) : null
            if (range) {
                const prev = nodeBeforeCaret(range)
                // Cursor is right after a <br> → also skip the br-marker before it
                if (prev?.tagName === 'BR') {
                    const marker = prev.previousSibling
                    if (marker?.classList?.contains('br-marker')) {
                        e.preventDefault()
                        const r = document.createRange()
                        r.setStartBefore(marker)
                        r.collapse(true)
                        sel.removeAllRanges(); sel.addRange(r)
                        return
                    }
                }
                // Cursor is between br-marker and <br> → jump before the marker
                if (prev?.classList?.contains('br-marker')) {
                    e.preventDefault()
                    const r = document.createRange()
                    r.setStartBefore(prev)
                    r.collapse(true)
                    sel.removeAllRanges(); sel.addRange(r)
                    return
                }
            }
        }
    }

    if (e.key === 'Enter' && e.shiftKey && inlineEditor?.el?.dataset.editorType === 'role') {
        e.preventDefault()
        insertRoleLineBreak()
        return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const afterIdx = inlineEditor?.blockEl?.dataset.blockIdx
        closeEditor(true)
        if (afterIdx) {
            requestAnimationFrame(() => {
                const newAfterEl = document.querySelector(`[data-block-idx="${afterIdx}"]`)
                if (newAfterEl) openNewBlock(newAfterEl)
            })
        }
        return
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
        const el = inlineEditor?.el
        if (!el || !editorCursorOnFirstLine(el)) return
        e.preventDefault()
        let prev = inlineEditor.blockEl?.previousElementSibling
        while (prev && (isTriggerEl(prev) || !prev.dataset?.blockIdx)) prev = prev.previousElementSibling
        const idx = prev ? parseInt(prev.dataset.blockIdx) : -1
        closeEditor(true)
        if (idx >= 0) requestAnimationFrame(() => {
            const found = document.querySelector(`[data-block-idx="${idx}"]`)
            if (found && !isTriggerEl(found)) openEditor(found)
        })
        return
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) {
        const el = inlineEditor?.el
        if (!el || !editorCursorOnLastLine(el)) return
        e.preventDefault()
        let next = inlineEditor.blockEl?.nextElementSibling
        while (next && (isTriggerEl(next) || !next.dataset?.blockIdx)) next = next.nextElementSibling
        const idx = next ? parseInt(next.dataset.blockIdx) : -1
        closeEditor(true)
        if (idx >= 0) requestAnimationFrame(() => {
            const found = document.querySelector(`[data-block-idx="${idx}"]`)
            if (found && !isTriggerEl(found)) openEditor(found)
        })
        return
    }
}

function onEditorInput() {
    clearTimeout(this._st)
    this._st = setTimeout(saveCurrentEdit, 5000)
    updateEditorParens(this)
    syncEditorHeight()
}

function saveCurrentEdit(isClosing = false) {
    if (!inlineEditor || inlineEditor.isNew) return
    const { el, lineStart, lineEnd } = inlineEditor
    const newContent = serializeEditorMarkdown(el)

    if (!newContent) {
        if (isClosing && !inlineEditor.deleted) {
            // Empty stage direction on close — remove block and its preceding blank lines
            const lines = scriptText.split('\n')
            let removeFrom = lineStart
            while (removeFrom > 0 && lines[removeFrom - 1].trim() === '') removeFrom--
            lines.splice(removeFrom, lineEnd - removeFrom + 1)
            scriptText = lines.join('\n')
            writeScriptMd(scriptText)
            inlineEditor.deleted = true
        }
        return
    }

    const newLines = newContent.split('\n')
    const lines = scriptText.split('\n')
    lines.splice(lineStart, lineEnd - lineStart + 1, ...newLines)
    scriptText = lines.join('\n')
    writeScriptMd(scriptText)
    inlineEditor.lineEnd = lineStart + newLines.length - 1
}

function closeEditor(save) {
    if (!inlineEditor) return
    if (inlineEditor._scrollHandler) {
        window.removeEventListener('scroll', inlineEditor._scrollHandler)
    }
    if (inlineEditor._caretClampHandler) {
        document.removeEventListener('selectionchange', inlineEditor._caretClampHandler)
    }
    if (save) saveCurrentEdit(true)
    ;(inlineEditor.el.closest('.editor-wrapper') ?? inlineEditor.el).remove()
    if (inlineEditor.blockEl && !inlineEditor.deleted) inlineEditor.blockEl.style.visibility = ''
    const wasDeleted = inlineEditor.deleted
    inlineEditor = null
    if (!wasDeleted) {
        const formatted = formatScriptText(scriptText)
        if (formatted !== scriptText) {
            scriptText = formatted
            writeScriptMd(scriptText)
        }
    }
    rerender(scriptText)
}

function deleteBlock() {
    if (!inlineEditor) return
    const { blockEl, lineStart, lineEnd } = inlineEditor

    // Remember the previous editable block in the DOM before any changes
    let prevEl = blockEl.previousElementSibling
    while (prevEl && (isTriggerEl(prevEl) || prevEl.dataset.blockIdx === undefined)) {
        prevEl = prevEl.previousElementSibling
    }
    const prevIdx = prevEl ? parseInt(prevEl.dataset.blockIdx) : -1

    closeEditor(false)

    // Remove block lines plus the blank separator line(s) that precede them
    const lines = scriptText.split('\n')
    let removeFrom = lineStart
    while (removeFrom > 0 && lines[removeFrom - 1].trim() === '') removeFrom--
    lines.splice(removeFrom, lineEnd - removeFrom + 1)
    scriptText = lines.join('\n')
    writeScriptMd(scriptText)
    rerender(scriptText)

    if (prevIdx >= 0) {
        requestAnimationFrame(() => {
            const el = document.querySelector(`[data-block-idx="${prevIdx}"]`)
            if (el && !isTriggerEl(el)) openEditor(el)
        })
    }
}

function moveBlock(direction) {
    if (!inlineEditor) return
    saveCurrentEdit()

    const k = parseInt(inlineEditor.blockEl.dataset.blockIdx)
    if (isNaN(k)) return
    const blocks = tokenizeScript(scriptText)

    // Find the nearest text block in the given direction (skip yaml/trigger blocks)
    let targetK = k + direction
    while (targetK >= 0 && targetK < blocks.length && blocks[targetK].type !== 'text') {
        targetK += direction
    }
    if (targetK < 0 || targetK >= blocks.length || blocks[targetK].type !== 'text') return

    // Locate both blocks in scriptText and swap their content
    let search = 0
    const pos = []
    for (let i = 0; i < blocks.length; i++) {
        const p = scriptText.indexOf(blocks[i].content, search)
        if (p < 0) break
        pos[i] = p
        search = p + blocks[i].content.length
    }
    if (pos[k] === undefined || pos[targetK] === undefined) return

    const [lo, hi] = k < targetK ? [k, targetK] : [targetK, k]
    const loC = blocks[lo].content, hiC = blocks[hi].content
    let text = scriptText
    text = text.slice(0, pos[hi]) + loC + text.slice(pos[hi] + hiC.length)
    text = text.slice(0, pos[lo]) + hiC + text.slice(pos[lo] + loC.length)

    scriptText = text
    writeScriptMd(scriptText)

    // After swap: the block we were editing is now at index targetK
    const editIdx = targetK
    closeEditor(false)
    rerender(scriptText)
    requestAnimationFrame(() => {
        const el = document.querySelector(`[data-block-idx="${editIdx}"]`)
        if (el && !isTriggerEl(el)) openEditor(el)
    })
}

// ── New block editor (contenteditable div, inline ghost autocomplete) ─────────

function openNewBlock(afterBlockEl, forceAfterRole) {
    if (inlineEditor) return
    const k = parseInt(afterBlockEl.dataset.blockIdx)
    if (isNaN(k) || k < 0) return
    const info = getBlockInfo(k)
    if (!info) return

    const isAfterRole = forceAfterRole ?? /^\*\*[^*]+\*\*$/.test(info.block.content.trim())

    const div = document.createElement('div')
    div.className = 'inline-editor inline-editor-new'
    div.contentEditable = 'true'
    div.dataset.placeholder = isAfterRole ? t('editor.ph.dialogue') : t('editor.ph.stage')

    const wrapper = document.createElement('div')
    wrapper.className = 'new-block-wrapper'
    wrapper.style.width = afterBlockEl.getBoundingClientRect().width + 'px'

    const controls = document.createElement('div')
    controls.className = 'editor-controls new-block-controls'
    const btnUp   = document.createElement('button')
    btnUp.className = 'editor-btn'; btnUp.textContent = '▲'; btnUp.title = t('editor.up.title')
    const btnDown = document.createElement('button')
    btnDown.className = 'editor-btn'; btnDown.textContent = '▼'; btnDown.title = t('editor.down.title')
    const btnDel  = document.createElement('button')
    btnDel.className = 'editor-btn editor-btn-delete'; btnDel.textContent = '✕'; btnDel.title = t('editor.del.title')
    controls.append(btnUp, btnDown, btnDel)
    wrapper.append(div, controls)

    afterBlockEl.after(wrapper)
    div.focus()
    requestAnimationFrame(() => wrapper.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    inlineEditor = { el: div, wrapper, blockEl: null, afterBlockEl, lineStart: info.lineEnd + 1, isNew: true, isAfterRole }

    div.addEventListener('keydown',     onNewBlockKey)
    div.addEventListener('beforeinput', onNewBlockBeforeInput)
    div.addEventListener('input',       onNewBlockInput)
    div.addEventListener('blur',        () => setTimeout(() => {
        if (inlineEditor?.el === div) commitNewBlock()
    }, 180))

    btnUp.addEventListener('mousedown', (e) => {
        e.preventDefault()
        clearGhost(); wrapper.remove(); inlineEditor = null
        if (!isTriggerEl(afterBlockEl)) openEditor(afterBlockEl)
    })
    btnDown.addEventListener('mousedown', (e) => {
        e.preventDefault()
        let next = wrapper.nextElementSibling
        while (next && (isTriggerEl(next) || !next.dataset?.blockIdx)) next = next.nextElementSibling
        clearGhost(); wrapper.remove(); inlineEditor = null
        if (next && !isTriggerEl(next)) openEditor(next)
    })
    btnDel.addEventListener('mousedown', (e) => {
        e.preventDefault()
        clearGhost(); wrapper.remove(); inlineEditor = null
    })
}

function checkEmptyScript() {
    if (inlineEditor) return
    const blocks = tokenizeScript(scriptText)
    const hasContent = blocks.some(b => {
        if (b.type === 'text') return true
        if (b.type === 'yaml') {
            const m = b.content.match(/^```yaml\n([\s\S]*?)\n```$/)
            try { const y = yaml.load(m?.[1]); return y && !y.config } catch {}
        }
        return false
    })
    showEmptyState(!hasContent)
}

function showEmptyState(show) {
    const contentEl = document.getElementById('script-content')
    if (!contentEl) return
    const existing = contentEl.querySelector('.empty-script-state')
    if (!show) { existing?.remove(); return }
    if (existing) return

    const state = document.createElement('div')
    state.className = 'empty-script-state'

    const btns = document.createElement('div')
    btns.className = 'empty-script-buttons'

    const btnCue = document.createElement('button')
    btnCue.className = 'empty-script-btn'
    btnCue.innerHTML = '+ Cue'
    btnCue.addEventListener('click', (e) => { e.stopPropagation(); showTriggerDialog({ insertAfterBlockIdx: 0 }) })

    const btnText = document.createElement('button')
    btnText.className = 'empty-script-btn'
    btnText.innerHTML = '+ Rollentext / Regieanweisung'
    btnText.addEventListener('click', (e) => {
        e.stopPropagation()
        if (inlineEditor) return

        const w = contentEl.getBoundingClientRect().width  // measure before state.remove()

        const div = document.createElement('div')
        div.className = 'inline-editor inline-editor-new'
        div.contentEditable = 'true'
        div.dataset.placeholder = t('editor.ph.stage')

        const wrapper = document.createElement('div')
        wrapper.className = 'new-block-wrapper'
        if (w) wrapper.style.width = w + 'px'

        const controls = document.createElement('div')
        controls.className = 'editor-controls new-block-controls'
        const btnDel = document.createElement('button')
        btnDel.className = 'editor-btn editor-btn-delete'
        btnDel.textContent = '✕'
        btnDel.title = t('editor.del.title')
        controls.append(btnDel)
        wrapper.append(div, controls)

        wrapper.style.marginTop = '4.5rem'
        contentEl.appendChild(wrapper)

        const lineStart = scriptText.split('\n').length - 1
        inlineEditor = { el: div, wrapper, blockEl: null, afterBlockEl: null, lineStart, isNew: true, isAfterRole: false, isPersistent: true }

        div.addEventListener('keydown', onNewBlockKey)
        div.addEventListener('beforeinput', onNewBlockBeforeInput)
        div.addEventListener('input', onNewBlockInput)

        div.addEventListener('blur', () => setTimeout(() => {
            if (inlineEditor?.el !== div) return
            if (document.getElementById('chip-dropdown') || document.getElementById('role-add-dropdown')) {
                div.focus()
                return
            }
            if (inlineEditor.isPersistent && !getTyped(div).trim() && !inlineEditor.confirmedRole && !inlineEditor.confirmedRoles?.length) {
                wrapper.remove(); inlineEditor = null; checkEmptyScript()
                return
            }
            commitNewBlock()
        }, 180))

        btnDel.addEventListener('mousedown', (e) => {
            e.preventDefault()
            if (getTyped(div).trim() || inlineEditor?.confirmedRole || inlineEditor?.confirmedRoles?.length) {
                clearGhost(); wrapper.remove(); inlineEditor = null
            }
        })

        state.remove()  // remove after inlineEditor is set so checkEmptyScript bails early
        div.focus()
    })

    btns.append(btnCue, btnText)

    const hint = document.createElement('div')
    hint.className = 'empty-script-hint'
    const hintLink = document.createElement('span')
    hintLink.className = 'empty-script-hint-link'
    hintLink.textContent = 'Rolleneditor'
    hintLink.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.openRoleEditor?.() })
    hint.append('Rollen können im ', hintLink, ' angelegt werden.')

    state.append(btns, hint)
    contentEl.appendChild(state)
}

function getTyped(el) {
    return [...el.childNodes]
        .filter(n => !(n.nodeType === Node.ELEMENT_NODE && (n.classList.contains('ac-ghost') || n.classList.contains('role-confirmed') || n.classList.contains('role-separator'))))
        .map(n => n.textContent).join('')
}

function getDialogue(el) {
    const roleSpans = el.querySelectorAll('.role-confirmed')
    const lastRoleSpan = roleSpans[roleSpans.length - 1]
    if (!lastRoleSpan) return ''
    let after = false
    let text = ''
    for (const node of el.childNodes) {
        if (node === lastRoleSpan) { after = true; continue }
        if (after && !(node.nodeType === Node.ELEMENT_NODE && (node.classList.contains('ac-ghost') || node.classList.contains('role-separator')))) {
            if (node.tagName === 'BR') text += '<br>'
            else if (node.classList?.contains('br-marker')) { /* skip visual indicator */ }
            else text += node.textContent
        }
    }
    return text.replace(/^\s+/, '')
}

function updateInlineAc(typed) {
    const el = inlineEditor?.el
    if (!el) return
    el.querySelector('.ac-ghost')?.remove()
    if (!typed) { acState = null; return }
    const existing = new Set([...(inlineEditor?.confirmedRoles || []), inlineEditor?.confirmedRole].filter(Boolean))
    const allNames = [
        ...Object.keys(config.roles || {}),
        ...Object.keys(config.groups || {}),
        'Alle',
    ].filter(r => !existing.has(r))
    const match = allNames.find(r => r.toLowerCase().startsWith(typed.toLowerCase()))
    if (!match || match.toLowerCase() === typed.toLowerCase()) { acState = null; return }
    acState = { typed, match }
    const ghost = document.createElement('span')
    ghost.className = 'ac-ghost'
    ghost.contentEditable = 'false'
    ghost.textContent = match.slice(typed.length)
    const color = ROLE_COLORS[config.roles?.[match]?.color] || ROLE_COLORS[getGroupColor(match)] || ''
    if (color) ghost.style.color = color
    const br = el.querySelector('br')
    if (br) el.insertBefore(ghost, br); else el.appendChild(ghost)
}

function clearGhost() {
    inlineEditor?.el?.querySelector('.ac-ghost')?.remove()
    acState = null
}

function onNewBlockKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault()
        const hasConfirmed = inlineEditor?.confirmedRole || inlineEditor?.confirmedRoles?.length
        if (inlineEditor?.isPersistent && !getTyped(e.currentTarget).trim() && !hasConfirmed) {
            return
        }
        if (hasConfirmed) {
            if (inlineEditor?.el === e.currentTarget) commitNewBlock()
        } else {
            clearGhost()
            ;(inlineEditor?.wrapper ?? inlineEditor?.el)?.remove()
            inlineEditor = null
        }
        return
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault()
        const { afterBlockEl, wrapper, el } = inlineEditor ?? {}
        const afterIdx = afterBlockEl ? parseInt(afterBlockEl.dataset.blockIdx) : -1
        const hasContent = !!(el && getTyped(el).trim()) || !!(inlineEditor?.confirmedRole || inlineEditor?.confirmedRoles?.length)
        if (hasContent) {
            commitNewBlock(undefined, true)
            // afterBlockEl index is unchanged (insertion was after it)
            const found = afterIdx >= 0 ? document.querySelector(`[data-block-idx="${afterIdx}"]`) : null
            if (found && !isTriggerEl(found)) openEditor(found)
        } else {
            clearGhost()
            ;(wrapper ?? el)?.remove()
            inlineEditor = null
            if (afterBlockEl && !isTriggerEl(afterBlockEl)) openEditor(afterBlockEl)
        }
        return
    }
    if (e.key === 'ArrowDown') {
        e.preventDefault()
        const { wrapper, el } = inlineEditor ?? {}
        const container = wrapper ?? el
        let next = container?.nextElementSibling
        while (next && (isTriggerEl(next) || !next.dataset?.blockIdx)) next = next.nextElementSibling
        const nextIdx = next ? parseInt(next.dataset.blockIdx) : -1
        const hasContent = !!(el && getTyped(el).trim()) || !!(inlineEditor?.confirmedRole || inlineEditor?.confirmedRoles?.length)
        if (hasContent) {
            const textBlocksBefore = tokenizeScript(scriptText).filter(b => b.type === 'text').length
            commitNewBlock(undefined, true)
            // Blocks after the insertion point shift up by the number of newly inserted text blocks
            const inserted = tokenizeScript(scriptText).filter(b => b.type === 'text').length - textBlocksBefore
            const adjustedIdx = nextIdx >= 0 ? nextIdx + inserted : -1
            const found = adjustedIdx >= 0 ? document.querySelector(`[data-block-idx="${adjustedIdx}"]`) : null
            if (found && !isTriggerEl(found)) openEditor(found)
        } else {
            clearGhost()
            container?.remove()
            inlineEditor = null
            if (next && !isTriggerEl(next)) openEditor(next)
        }
        return
    }
    if (e.key === 'Tab') {
        e.preventDefault()  // must be in keydown to prevent focus movement
        if (inlineEditor?.el === e.currentTarget) acceptGhostInline()
        return
    }
    // Backspace at position 0 with confirmed roles: remove the last role chip
    if (e.key === 'Backspace' && inlineEditor?.confirmedRoles?.length && !inlineEditor?.confirmedRole) {
        const el = e.currentTarget
        if (!getTyped(el).trim()) {
            e.preventDefault()
            const chips = el.querySelectorAll('.role-confirmed')
            const lastChip = chips[chips.length - 1]
            if (lastChip) removeRoleChip(lastChip)
            return
        }
    }
    // Backspace at start of a post-br line in a confirmed-role block: remove br-marker + <br>
    if (e.key === 'Backspace' && inlineEditor?.confirmedRole) {
        const el = e.currentTarget
        const sel = window.getSelection()
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null
        if (range && range.collapsed) {
            const prev = nodeBeforeCaret(range)
            let br = null, marker = null
            if (prev?.tagName === 'BR') {
                br = prev
                if (br.previousSibling?.classList?.contains('br-marker')) marker = br.previousSibling
            } else if (prev?.classList?.contains('br-marker')) {
                marker = prev
                if (marker.nextSibling?.tagName === 'BR') br = marker.nextSibling
            }
            if (marker && br) {
                e.preventDefault()
                const parent     = marker.parentNode
                const beforeNode = marker.previousSibling
                marker.remove(); br.remove()
                const r = document.createRange()
                if (beforeNode) r.setStartAfter(beforeNode)
                else            r.setStart(parent, 0)
                r.collapse(true)
                sel.removeAllRanges(); sel.addRange(r)
                onNewBlockInput.call(el)
                return
            }
            // Block Backspace at the very start of dialogue (before the role span)
            const roleSpan = el.querySelector('.role-confirmed')
            if (roleSpan) {
                const atStart =
                    (range.startContainer === el && range.startOffset <= 1) ||
                    roleSpan.contains(range.startContainer) ||
                    (range.startOffset === 0 &&
                     range.startContainer.nodeType === Node.TEXT_NODE &&
                     range.startContainer.parentNode?.previousSibling === roleSpan)
                if (atStart) { e.preventDefault(); return }
            }
        }
    }
    // Enter is handled via onNewBlockBeforeInput (reliable in Electron/Chromium contenteditable)
}

function acceptGhostInline() {
    if (!inlineEditor || !acState) return
    const el = inlineEditor.el
    const { match } = acState
    acState = null

    // Remove only the typed text and ghost — keep existing role chips + separators
    ;[...el.childNodes].forEach(n => {
        if (n.nodeType === Node.TEXT_NODE) n.remove()
        else if (n.classList?.contains('ac-ghost')) n.remove()
    })

    // Add separator if there are already role chips
    if (el.querySelectorAll('.role-confirmed').length > 0) {
        const sep = document.createElement('span')
        sep.className = 'role-separator'
        sep.contentEditable = 'false'
        sep.textContent = ' / '
        el.appendChild(sep)
    }

    const roleSpan = createRoleChipElement(match)
    el.appendChild(roleSpan)

    const space = document.createTextNode(' ')
    el.appendChild(space)

    if (!inlineEditor.confirmedRoles) inlineEditor.confirmedRoles = []
    inlineEditor.confirmedRoles.push(match)
    el.dataset.placeholder = t('editor.ph.nextrole')
    el.style.color = ''

    el.focus()
    const range = document.createRange()
    range.setStartAfter(space)
    range.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
}

function createRoleChipElement(roleName) {
    const roleSpan = document.createElement('span')
    roleSpan.className = 'role-confirmed'
    roleSpan.contentEditable = 'false'
    roleSpan.dataset.roleName = roleName
    roleSpan.textContent = roleName
    const roleColor = ROLE_COLORS[config.roles?.[roleName]?.color] || ROLE_COLORS[getGroupColor(roleName)]
    if (roleColor) roleSpan.style.color = roleColor
    roleSpan.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        openChipDropdown(roleSpan)
    })
    return roleSpan
}

function openChipDropdown(chip) {
    document.getElementById('chip-dropdown')?.remove()
    const roleName = chip.dataset.roleName
    const existingRoles = inlineEditor?.confirmedRoles ?? []

    const dropdown = document.createElement('div')
    dropdown.id = 'chip-dropdown'
    dropdown.style.cssText = `
        position: fixed;
        background: #21252b;
        border: 1px solid #4b5263;
        border-radius: 5px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        z-index: 300;
        min-width: 10rem;
        font-size: 0.9rem;
        max-height: 60vh;
        overflow-y: auto;
        overscroll-behavior: contain;
    `
    const rect = chip.getBoundingClientRect()
    dropdown.style.left = rect.left + 'px'
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    if (spaceBelow >= 80 || spaceBelow >= spaceAbove) {
        dropdown.style.top = (rect.bottom + 4) + 'px'
        dropdown.style.maxHeight = Math.min(spaceBelow, window.innerHeight * 0.6) + 'px'
    } else {
        dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px'
        dropdown.style.top = 'auto'
        dropdown.style.maxHeight = Math.min(spaceAbove, window.innerHeight * 0.6) + 'px'
    }

    // Action row: [\u2212 Entfernen | + Hinzuf\u00fcgen]
    const actionRow = document.createElement('div')
    actionRow.style.cssText = `display: flex; border-bottom: 1px solid #4b5263;`

    const btnRemove = document.createElement('button')
    btnRemove.type = 'button'
    btnRemove.textContent = '\u2212'
    btnRemove.style.cssText = `flex: 1; padding: 0.35rem 0; background: none; border: none; border-right: 1px solid #4b5263; color: #e06c75; cursor: pointer; font-size: 1rem; transition: background 0.1s;`
    btnRemove.addEventListener('mouseenter', () => { btnRemove.style.background = '#2c313a' })
    btnRemove.addEventListener('mouseleave', () => { btnRemove.style.background = '' })
    btnRemove.addEventListener('mousedown', (e) => {
        e.preventDefault()
        closeChipDropdown()
        removeRoleChip(chip)
    })

    const btnAdd = document.createElement('button')
    btnAdd.type = 'button'
    btnAdd.textContent = '+'
    btnAdd.style.cssText = `flex: 1; padding: 0.35rem 0; background: none; border: none; color: #98c379; cursor: pointer; font-size: 1rem; transition: background 0.1s;`
    btnAdd.addEventListener('mouseenter', () => { btnAdd.style.background = '#2c313a' })
    btnAdd.addEventListener('mouseleave', () => { btnAdd.style.background = '' })
    btnAdd.addEventListener('mousedown', (e) => {
        e.preventDefault()
        closeChipDropdown()
        openAddRoleDropdown(chip)
    })

    actionRow.append(btnRemove, btnAdd)
    dropdown.appendChild(actionRow)

    // Role list: change this chip to a different role
    const otherRoles = Object.keys(config.roles || {}).filter(r => r !== roleName && !existingRoles.includes(r))
    for (const r of otherRoles) {
        const color = ROLE_COLORS[config.roles[r]?.color] || '#abb2bf'
        const item = document.createElement('div')
        item.style.cssText = `padding: 0.4rem 1rem; cursor: pointer; color: ${color}; white-space: nowrap;`
        item.textContent = r
        item.addEventListener('mouseenter', () => { item.style.background = '#2c313a' })
        item.addEventListener('mouseleave', () => { item.style.background = '' })
        item.addEventListener('mousedown', (e) => {
            e.preventDefault()
            closeChipDropdown()
            changeRoleChip(chip, r)
        })
        dropdown.appendChild(item)
    }

    document.body.appendChild(dropdown)

    function closeChipDropdown() {
        dropdown.remove()
        document.removeEventListener('mousedown', onOutside, true)
        document.removeEventListener('keydown',   onEsc,     true)
        window.removeEventListener('scroll',      onScroll,  true)
        inlineEditor?.el?.focus()
    }
    function onOutside(e) { if (!dropdown.contains(e.target)) closeChipDropdown() }
    function onEsc(e)     { if (e.key === 'Escape') closeChipDropdown() }
    function onScroll()   { closeChipDropdown() }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown',   onEsc,     true)
    window.addEventListener('scroll',      onScroll,  true)
}

function changeRoleChip(chip, newRoleName) {
    const el = inlineEditor?.el
    if (!el) return
    const chips = [...el.querySelectorAll('.role-confirmed')]
    const idx = chips.indexOf(chip)
    if (idx < 0) return
    if (inlineEditor.confirmedRoles) inlineEditor.confirmedRoles[idx] = newRoleName
    chip.dataset.roleName = newRoleName
    chip.textContent = newRoleName
    const newColor = ROLE_COLORS[config.roles?.[newRoleName]?.color]
    chip.style.color = newColor || ''
    el.focus()
}

function openAddRoleDropdown(referenceChip) {
    document.getElementById('role-add-dropdown')?.remove()
    const existingRoles = inlineEditor?.confirmedRoles ?? []
    const roles = Object.keys(config.roles || {}).filter(r => !existingRoles.includes(r))
    if (!roles.length) return

    const dropdown = document.createElement('div')
    dropdown.id = 'role-add-dropdown'
    dropdown.style.cssText = `
        position: fixed;
        background: #21252b;
        border: 1px solid #4b5263;
        border-radius: 5px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        z-index: 300;
        min-width: 10rem;
        padding: 0.3rem 0;
        font-size: 0.9rem;
        max-height: 60vh;
        overflow-y: auto;
        overscroll-behavior: contain;
    `
    const rect = referenceChip.getBoundingClientRect()
    dropdown.style.left = rect.left + 'px'
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    if (spaceBelow >= 80 || spaceBelow >= spaceAbove) {
        dropdown.style.top = (rect.bottom + 4) + 'px'
        dropdown.style.maxHeight = Math.min(spaceBelow, window.innerHeight * 0.6) + 'px'
    } else {
        dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px'
        dropdown.style.top = 'auto'
        dropdown.style.maxHeight = Math.min(spaceAbove, window.innerHeight * 0.6) + 'px'
    }

    for (const roleName of roles) {
        const color = ROLE_COLORS[config.roles[roleName]?.color] || '#abb2bf'
        const item = document.createElement('div')
        item.style.cssText = `padding: 0.4rem 1rem; cursor: pointer; color: ${color}; white-space: nowrap;`
        item.textContent = roleName
        item.addEventListener('mouseenter', () => { item.style.background = '#2c313a' })
        item.addEventListener('mouseleave', () => { item.style.background = '' })
        item.addEventListener('mousedown', (e) => {
            e.preventDefault()
            closeAddDropdown()
            addRoleChipAtEnd(roleName)
        })
        dropdown.appendChild(item)
    }

    document.body.appendChild(dropdown)

    function closeAddDropdown() {
        dropdown.remove()
        document.removeEventListener('mousedown', onOutside, true)
        document.removeEventListener('keydown',   onEsc,     true)
        window.removeEventListener('scroll',      onScroll,  true)
        inlineEditor?.el?.focus()
    }
    function onOutside(e) { if (!dropdown.contains(e.target)) closeAddDropdown() }
    function onEsc(e)     { if (e.key === 'Escape') closeAddDropdown() }
    function onScroll()   { closeAddDropdown() }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown',   onEsc,     true)
    window.addEventListener('scroll',      onScroll,  true)
}

function addRoleChipAtEnd(roleName) {
    const el = inlineEditor?.el
    if (!el) return
    if (!inlineEditor.confirmedRoles) inlineEditor.confirmedRoles = []
    inlineEditor.confirmedRoles.push(roleName)

    // Remove trailing text nodes and ghost
    ;[...el.childNodes].forEach(n => {
        if (n.nodeType === Node.TEXT_NODE) n.remove()
        else if (n.classList?.contains('ac-ghost')) n.remove()
    })

    const sep = document.createElement('span')
    sep.className = 'role-separator'
    sep.contentEditable = 'false'
    sep.textContent = ' / '
    el.appendChild(sep)

    const newChip = createRoleChipElement(roleName)
    el.appendChild(newChip)

    const space = document.createTextNode(' ')
    el.appendChild(space)

    el.focus()
    const range = document.createRange()
    range.setStartAfter(space)
    range.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    updateInlineAc('')
}

function removeRoleChip(roleSpan) {
    const el = inlineEditor?.el
    if (!el) return
    const chips = [...el.querySelectorAll('.role-confirmed')]
    const idx = chips.indexOf(roleSpan)
    if (idx < 0) return
    inlineEditor.confirmedRoles?.splice(idx, 1)
    const nextSib = roleSpan.nextSibling
    const prevSib = roleSpan.previousSibling
    if (nextSib?.classList?.contains('role-separator')) nextSib.remove()
    else if (prevSib?.classList?.contains('role-separator')) prevSib.remove()
    roleSpan.remove()
    if (!inlineEditor.confirmedRoles?.length) el.dataset.placeholder = t('editor.ph.stage')
    focusForNewRole()
}

function focusForNewRole() {
    const el = inlineEditor?.el
    if (!el) return
    ;[...el.childNodes].forEach(n => {
        if (n.nodeType === Node.TEXT_NODE) n.remove()
        else if (n.classList?.contains('ac-ghost')) n.remove()
    })
    const space = document.createTextNode('')
    el.appendChild(space)
    el.focus()
    const range = document.createRange()
    range.setStartAfter(space)
    range.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    updateInlineAc('')
}

function onNewBlockBeforeInput(e) {
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        e.preventDefault()
        // Shift+Enter (insertLineBreak) while typing dialogue → insert <br> instead of committing
        if (e.inputType === 'insertLineBreak' && (inlineEditor?.confirmedRole || inlineEditor?.confirmedRoles?.length) && inlineEditor?.el === this) {
            insertRoleLineBreak()
            return
        }
        if (inlineEditor?.el === this) commitNewBlock()
    }
}

// Re-color *(text)* inline stage directions live while typing in a confirmed-role new block
function updateNewBlockParens(el) {
    const roleSpan = el.querySelector('.role-confirmed')
    if (!roleSpan) return
    const roleColor = ROLE_COLORS[config.roles?.[inlineEditor?.confirmedRole]?.color] || ''

    const caretOffset = getCaretOffset(el)
    const afterRole = []
    let seen = false
    for (const n of el.childNodes) {
        if (seen) afterRole.push(n)
        if (n === roleSpan) seen = true
    }
    const dialogue = afterRole.map(n => n.classList?.contains('ac-ghost') ? '' : serializeRoleNode(n)).join('').replace(/(<br>)+$/, '')
    afterRole.filter(n => !n.classList?.contains('ac-ghost')).forEach(n => n.remove())
    appendDialogueParsed(el, dialogue, roleColor)
    setCaretOffset(el, caretOffset)
}

function onNewBlockInput() {
    if (!inlineEditor?.confirmedRole) {
        updateInlineAc(getTyped(this).trimStart())
    } else {
        updateNewBlockParens(this)
    }
}

function commitNewBlock(asRole, skipNavigate = false) {
    if (!inlineEditor) return
    const { el, wrapper, lineStart, isAfterRole, confirmedRole, confirmedRoles } = inlineEditor

    let insertLines, _target, _afterRole

    if (confirmedRoles?.length > 0) {
        // Multi-role (or single role via the new Tab flow): collect roles as "R1/R2/…"
        const dialogue = getDialogue(el).replace(/(<br>)+$/, '').trim()
        clearGhost()
        ;(wrapper ?? el).remove()
        inlineEditor = null
        const rolesStr = confirmedRoles.join('/')
        if (dialogue) {
            insertLines = ['', `**${rolesStr}**`, wrapSentences(dialogue.replace(/\(([^)]+)\)/g, '*($1)*'))]
            _target = lineStart + 1
            _afterRole = false
        } else {
            insertLines = ['', `**${rolesStr}**`]
            _target = lineStart + 1
            _afterRole = true
        }
    } else if (confirmedRole) {
        // Legacy single-role path (kept for safety)
        const dialogue = getDialogue(el).replace(/(<br>)+$/, '').trim()
        clearGhost()
        ;(wrapper ?? el).remove()
        inlineEditor = null
        if (dialogue) {
            insertLines = ['', `**${confirmedRole}**`, wrapSentences(dialogue.replace(/\(([^)]+)\)/g, '*($1)*'))]
            _target = lineStart + 1
            _afterRole = false
        } else {
            insertLines = ['', `**${confirmedRole}**`]
            _target = lineStart + 1
            _afterRole = true
        }
    } else {
        // Phase 1: plain text committed directly
        const typed = getTyped(el).trim()
        const text  = asRole ? (acState?.match || typed) : typed
        clearGhost()
        ;(wrapper ?? el).remove()
        inlineEditor = null
        if (!text) { requestAnimationFrame(checkEmptyScript); return }

        const isRoleName = !asRole && !!config.roles?.[text]
        let mdLine
        if (text.startsWith('#')) {
            mdLine = text                // heading: preserve # / ## as-is
            _afterRole = false
        } else if (asRole || isRoleName) {
            mdLine = `**${text}**`
            _afterRole = true
        } else if (isAfterRole) {
            mdLine = text.replace(/\(([^)]+)\)/g, '*($1)*')
            _afterRole = false
        } else {
            mdLine = `*${text}*`
            _afterRole = false
        }
        insertLines = ['', mdLine]
        _target = lineStart + 1
    }

    // Auto-prepend an empty heading when this is the very first text block and isn't a heading.
    // The sticky h1 acts as a spacer below the fixed controls bar.
    if (!tokenizeScript(scriptText).some(b => b.type === 'text') && !/^#(?!#)/.test(insertLines[1] || '')) {
        insertLines = ['', '# ', ...insertLines]
        _target += 2
    }

    const lines = scriptText.split('\n')
    lines.splice(lineStart, 0, ...insertLines)
    scriptText = lines.join('\n')
    writeScriptMd(scriptText)
    rerender(scriptText)
    if (!skipNavigate) requestAnimationFrame(() => openNextBlockAfterLine(_target, _afterRole))
}

function openNextBlockAfterLine(targetLine, forceAfterRole) {
    const blocks = tokenizeScript(scriptText)
    let search = 0
    for (let k = 0; k < blocks.length; k++) {
        const pos = scriptText.indexOf(blocks[k].content, search)
        if (pos < 0) break
        const bLine = (scriptText.slice(0, pos).match(/\n/g) || []).length
        if (bLine === targetLine) {
            const el = document.querySelector(`[data-block-idx="${k}"]`)
            if (el) openNewBlock(el, forceAfterRole)
            return
        }
        search = pos + blocks[k].content.length
    }
}

function onScriptClick(e) {
    if (showLock) return
    const blockEl    = e.target.closest('[data-block-idx]')
    const isEditable = blockEl && !isTriggerEl(blockEl)
    const activeContainer = inlineEditor?.wrapper ?? inlineEditor?.el

    if (inlineEditor) {
        if (activeContainer?.contains(e.target)) return
        if (inlineEditor.isNew) {
            clearGhost()
            ;(inlineEditor.wrapper ?? inlineEditor.el)?.remove()
            inlineEditor = null
        } else {
            const targetIdx = isEditable ? parseInt(blockEl.dataset.blockIdx) : null
            closeEditor(true)
            if (targetIdx) {
                const newEl = document.querySelector(`[data-block-idx="${targetIdx}"]`)
                if (newEl && !isTriggerEl(newEl)) openEditor(newEl, e.clientX, e.clientY)
            }
        }
        return
    }

    if (!shiftHeld || !isEditable) return
    e.preventDefault()
    openEditor(blockEl, e.clientX, e.clientY)
}

let shiftHeld = false
document.addEventListener('keydown', (e) => {
    // Space → Go, Backspace → Back when live window is open and no editor/input is active
    if (liveViewOpen && !inlineEditor && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ae = document.activeElement
        const isInput = ae?.tagName === 'INPUT' || ae?.tagName === 'TEXTAREA' || ae?.isContentEditable
        if (!isInput) {
            if (e.key === ' ') { e.preventDefault(); goAction(); return }
            if (e.key === 'Backspace') { e.preventDefault(); backAction(); return }
        }
    }
    if (e.key === 'Shift') {
        shiftHeld = true
        document.body.classList.add('shift-held')
        document.querySelectorAll('.trigger-action-btn-auto').forEach(btn => {
            updateAutoBtnAppearance(btn, parseInt(btn._triggerIndex))
        })
        for (const [idx, btn] of autoMicBtns) updateAutoMicBtnAppearance(btn, idx)
        return
    }
    // Cmd+L → open live view (fallback in case menu accelerator is swallowed by Chromium)
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        window.electronAPI.openLiveWindow()
        return
    }
    // Ctrl+F → open search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        openSearch()
        return
    }
    // Ctrl+B → toggle sidebar
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
        return
    }
    // Escape → close search or sidebar
    if (e.key === 'Escape') {
        const bar = document.getElementById('search-bar')
        if (!bar.classList.contains('hidden')) { closeSearch(); return }
        document.getElementById('scene-sidebar').classList.remove('open')
        return
    }
    // Enter / Shift+Enter in search bar → navigate
    if (e.key === 'Enter') {
        const input = document.getElementById('search-input')
        if (document.activeElement === input) {
            e.preventDefault()
            searchStep(e.shiftKey ? -1 : 1)
        }
    }
}, { capture: true })
document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
        shiftHeld = false
        document.body.classList.remove('shift-held')
        document.querySelectorAll('.trigger-action-btn-auto').forEach(btn => {
            updateAutoBtnAppearance(btn, parseInt(btn._triggerIndex))
        })
        for (const [idx, btn] of autoMicBtns) updateAutoMicBtnAppearance(btn, idx)
    }
}, { capture: true })
window.addEventListener('blur', () => { shiftHeld = false; document.body.classList.remove('shift-held') })
window.addEventListener('scroll', updateSidebarActive, { passive: true })
window.addEventListener('scroll', updateGutterState, { passive: true })

// Prevent Electron from navigating to dropped files (default browser/Electron behaviour).
// Individual drop targets handle the files themselves.
if (!window.__webPreview) {
    document.addEventListener('dragover', (e) => { e.preventDefault() })
    document.addEventListener('drop',     (e) => { e.preventDefault() })
}

const _headerShield = document.getElementById('header-shield')
function updateHeaderShield() {
    if (!_headerShield) return
    const btns = document.querySelector('.buttons')
    const btnsBottom = btns ? btns.getBoundingClientRect().bottom : 0
    document.documentElement.style.setProperty('--btns-bottom', btnsBottom + 'px')
    const content = document.getElementById('script-content')
    if (content) {
        const contentAbsTop = content.getBoundingClientRect().top + window.scrollY
        const cuePadding = Math.max(0, btnsBottom - contentAbsTop)
        document.documentElement.style.setProperty('--first-cue-padding', cuePadding + 'px')
    }
    const heading = document.querySelector('#script-content h1, #script-content h2, #script-content h3')
    const stickyTop = heading ? parseFloat(getComputedStyle(heading).top) || 0 : 0
    if (stickyTop <= 0) { _headerShield.style.height = '0'; return }
    _headerShield.style.height = Math.max(btnsBottom, stickyTop) + 'px'
}
new ResizeObserver(updateHeaderShield).observe(document.querySelector('.buttons') ?? document.body)
window.addEventListener('resize', updateHeaderShield)
updateHeaderShield()

document.addEventListener('contextmenu', (e) => {
    if (!editorApp) return
    const blockEl = e.target.closest('[data-block-idx]')
    if (!blockEl || isTriggerEl(blockEl)) return
    const k = parseInt(blockEl.dataset.blockIdx)
    if (isNaN(k)) return
    const info = getBlockInfo(k)
    if (!info) return
    e.preventDefault()
    window.electronAPI.showEditorContextMenu(info.lineStart + 1)
})


// DOMPurify is initialised here (module level, runs in Electron renderer where window exists).
// script/onerror/javascript: and all other XSS vectors are stripped.
const DOMPurify = createDOMPurify(window)
const _purifyConfig = {
    ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','b','i','ul','ol','li','blockquote','code','pre','hr'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
}
function makeHtmlSafe(mdText) {
    return DOMPurify.sanitize(marked.parse(mdText), _purifyConfig)
}

class MTCTransmitter {
    constructor() {
        this.output = null
        this.intervalId = null
        this.qfIndex = 0
        this.lastFrames = 0
        this.latchedFrames = 0
        this.startFrames = 0
        this.loopOffsetFrames = 0
        this.iterStartSec = 0
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

    onLoopRestart(loopDurSec, newStartSec) {
        // TC loops with the audio: jump back to startFrames each iteration
        this.iterStartSec = newStartSec
    }

    getCurrentFrames() {
        const wsTime = this.wsRef ? this.wsRef.getCurrentTime() : 0
        return this.startFrames + this.loopOffsetFrames + Math.floor((wsTime - this.iterStartSec) * 25)
    }

    startFromFrames(frames, ws, triggerIndex, iterStartSec = 0) {
        this.stop()
        if (!this.displayEl) this.displayEl = document.querySelector('.tc-display')
        this.startFrames = frames
        this.loopOffsetFrames = 0
        this.iterStartSec = iterStartSec
        this.wsRef = ws
        this.activeTcIndex = triggerIndex
        this.qfIndex = 0
        this.lastFrames = frames
        this.latchedFrames = frames
        try { this._sendFullFrame(frames) } catch (e) {}
        if (this.displayEl) this.displayEl.textContent = this._framesToStr(frames)
        this.intervalId = setInterval(() => this._tick(), 10)
    }

    _tick() {
        const wsTime = this.wsRef ? this.wsRef.getCurrentTime() : 0
        const frames = this.startFrames + this.loopOffsetFrames + Math.floor((wsTime - this.iterStartSec) * 25)

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

    start(startTcStr, ws, triggerIndex, iterStartSec = 0) {
        this.stop()
        // Ensure display element is current after any DOM rebuild
        if (!this.displayEl) this.displayEl = document.querySelector('.tc-display')
        this.startFrames = this._parseTC(startTcStr)
        this.loopOffsetFrames = 0
        this.iterStartSec = iterStartSec
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

let _scrollRaf = null

function scrollToTrigger(cue) {
    const el = triggers[cue]
    if (!el) return
    const viewH  = window.innerHeight
    const rect   = el.getBoundingClientRect()
    const elMid  = window.scrollY + rect.top + rect.height / 2
    const target = Math.max(0, elMid - viewH / 2)
    const dist   = Math.abs(target - window.scrollY)
    if (dist < 4) return

    // Continuous ease-in-out: ~1200 px/s, clamped 500–900 ms
    const duration = Math.max(500, Math.min(900, dist / 1.2))
    if (_scrollRaf) cancelAnimationFrame(_scrollRaf)
    const startY = window.scrollY
    const startT = performance.now()
    const step = (now) => {
        const t = Math.min(1, (now - startT) / duration)
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
        window.scrollTo(0, startY + (target - startY) * e)
        _scrollRaf = t < 1 ? requestAnimationFrame(step) : null
    }
    _scrollRaf = requestAnimationFrame(step)
}

function groupRootOf(idx) {
    while (idx >= 1 && triggerYamls[idx]?.sibling) idx--
    return idx
}

function markTriggers(cue) {
    const cueRoot = groupRootOf(cue)
    const historyRoots = new Set(cueHistory.map(h => groupRootOf(h)))
    for (let index = 1; index < triggers.length; index++) {
        if (!triggers[index]) continue
        const root = groupRootOf(index)
        let shouldMark
        if (root === cueRoot) {
            // Same group as current cue: only the clicked trigger gets marked
            shouldMark = index === cue
        } else if (root < cueRoot) {
            // Past group: only mark if it was actually triggered (in history)
            shouldMark = index === root && historyRoots.has(root)
        } else {
            shouldMark = false
        }
        triggers[index].classList.toggle("trigger-marked", shouldMark)
    }
}

function applyAudioDevices() {
    if (sharedAudioCtx?.setSinkId) sharedAudioCtx.setSinkId(mainAudioDevice || '').catch(() => {})
    for (const { mainAudioEl } of triggerAudio.values()) {
        if (mainAudioEl?.setSinkId) mainAudioEl.setSinkId(mainAudioDevice || '').catch(() => {})
    }
    // After sink switch, re-enable 4-ch if the new device supports it
    if (sharedAudioCtx) getAudioCtx()
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

    // Fix move buttons: only the last trigger in each group shows arrows,
    // and those arrows move the entire group.
    for (const group of document.querySelectorAll('.trigger-group')) {
        const members = [...group.children]
        const rootIdx = parseInt(members[0].dataset.triggerIndex)
        const lastIdx = parseInt(members[members.length - 1].dataset.triggerIndex)

        // Hide move buttons on all but the last member
        for (let i = 0; i < members.length - 1; i++) {
            const btns = members[i].querySelector('.trigger-move-btns')
            if (btns) btns.style.display = 'none'
        }

        // Re-wire last member's move buttons to move the whole group.
        // Clone each button to strip the existing single-trigger addEventListener handler,
        // then attach a fresh group handler so only one move fires per click.
        const lastMember = members[members.length - 1]
        const upBtn   = lastMember.querySelector('.trigger-move-btn:first-child')
        const downBtn = lastMember.querySelector('.trigger-move-btn:last-child')
        if (upBtn) {
            const fresh = upBtn.cloneNode(true)
            upBtn.replaceWith(fresh)
            fresh.addEventListener('mousedown', (e) => { e.stopPropagation(); moveTriggerGroupInScript(rootIdx, lastIdx, 'up') })
        }
        if (downBtn) {
            const fresh = downBtn.cloneNode(true)
            downBtn.replaceWith(fresh)
            fresh.addEventListener('mousedown', (e) => { e.stopPropagation(); moveTriggerGroupInScript(rootIdx, lastIdx, 'down') })
        }
    }
}

function moveTriggerGroupInScript(rootIndex, lastIndex, direction) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    const configIdx = blocks.findIndex(b => b.type === 'yaml')

    let yamlCount = 0, rootPos = -1, lastPos = -1
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type !== 'yaml') continue
        yamlCount++
        if (yamlCount === rootIndex + 1) rootPos = i
        if (yamlCount === lastIndex + 1)  lastPos = i
    }
    if (rootPos === -1 || lastPos === -1) return

    const groupLen = lastPos - rootPos + 1
    const group = blocks.splice(rootPos, groupLen)

    if (direction === 'up') {
        if (rootPos <= configIdx + 1) { blocks.splice(rootPos, 0, ...group); return }
        // Adjust cue tracking when the block above the group is also a yaml trigger
        if (blocks[rootPos - 1]?.type === 'yaml') {
            const adjust = (h) => {
                if (h >= rootIndex && h <= lastIndex) return h - 1
                if (h === rootIndex - 1) return lastIndex
                return h
            }
            currentCue = adjust(currentCue)
            cueHistory = cueHistory.map(adjust)
        }
        blocks.splice(rootPos - 1, 0, ...group)
    } else {
        if (rootPos >= blocks.length) { blocks.splice(rootPos, 0, ...group); return }
        // After the splice, blocks[rootPos] is what was originally just after the group
        if (blocks[rootPos]?.type === 'yaml') {
            const adjust = (h) => {
                if (h >= rootIndex && h <= lastIndex) return h + 1
                if (h === lastIndex + 1) return rootIndex
                return h
            }
            currentCue = adjust(currentCue)
            cueHistory = cueHistory.map(adjust)
        }
        blocks.splice(rootPos + 1, 0, ...group)
    }

    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    writeScriptMd(updated)
    rerender(updated)
}


function rerender(newText) {
    if (inlineEditor) {
        clearGhost()
        inlineEditor = null
    }
    const scrollY = window.scrollY

    // For each playing cue, save the running audio graph so buildTrigger can adopt it
    // after the DOM rebuild — the AudioBufferSourceNode never stops.
    pendingAudioAdoptions.clear()
    for (const [, ta] of triggerAudio) {
        if (!ta.isAudioActive?.()) continue
        const srcInfo = ta.getActiveSourceInfo?.() ?? {}
        pendingAudioAdoptions.set(ta.musicFile, {
            playbackGain:            ta.getPlaybackGain(),
            activeSource:            srcInfo.src         ?? null,
            activeSourceStartedAt:   srcInfo.startedAt   ?? null,
            activeSourceStartOffset: srcInfo.startOffset ?? null,
            decodedBuffer:           ta.decodedBuffer    ?? null,
            volume:                  ta.getCurrentVolume?.() ?? null,
        })
    }

    // Teardown auto-trigger listeners before destroying WaveSurfer instances
    for (const [, setup] of autoTriggerSetup) {
        setup.unPlay?.(); setup.unTime?.(); setup.unPause?.(); setup.unFin?.()
    }
    autoTriggerSetup.clear()
    autoTriggerBtns.clear()
    autoMicBtns.clear()

    for (const { ws } of triggerAudio.values()) {
        try { ws.destroy() } catch (e) {}
    }
    for (const seqData of triggerSeqSlots.values()) {
        clearTimeout(seqData.boundaryTimer)
        for (const slot of seqData.slots) {
            if (!slot) continue
            try { slot.ws?.destroy() } catch {}
            const info = slot.getActiveSourceInfo?.()
            if (info?.src) try { info.src.stop() } catch {}
        }
    }
    triggerSeqSlots.clear()

    triggers = []
    triggerYamls = []
    triggerAudio.clear()
    slfDerivedTcBadges.clear()
    fileToTriggers.clear()
    config = {}
    effectiveDeviceStates = new Map()
    effectiveMics       = null
    loopOutroPending.clear()
    loopOutroInitialRemaining.clear()
    loopBtns.clear()
    slfGripUpdaters.clear()
    loopGroups.clear()

    validateYamlBlocks(newText)
    document.getElementById('script-content').innerHTML = makeHtmlSafe(newText)
    convertCodeblocks()
    colorText()
    showParseErrors()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
    annotateLineNumbers()
    buildInsertZones()

setupAutoTriggers()
    buildSidebar()
    clearSearchHighlights()
    markTriggers(currentCue)

    requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, behavior: 'instant' })
        checkEmptyScript()
        updateHeaderShield()
        // Try to compute derived TCs immediately in case audio was already loaded
        updateDerivedTcBadges()
    })
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function validateCueFields(y, blockNum, lineNum) {
    if (!y || typeof y !== 'object') return

    if (y.start_tc != null) {
        const tc = String(y.start_tc)
        const m = tc.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/)
        if (!m || +m[1] > 23 || +m[2] > 59 || +m[3] > 59 || +m[4] > 24)
            parseErrors.push({ blockNum, line: lineNum, message: `Ungültiger Timecode: "${tc}" (Format HH:MM:SS:FF, Stunden 0–23)` })
    }

    if (y.osc != null) {
        const normalized = String(y.osc).replace(/\{ch\}/g, '00')
        if (!/^\/[\x20-\x7e]*$/.test(normalized))
            parseErrors.push({ blockNum, line: lineNum, message: `Ungültiger OSC-Pfad: "${y.osc}"` })
    }

    if (y.trigger_note != null) {
        const { ch, note } = y.trigger_note || {}
        if (!Number.isInteger(ch) || ch < 1 || ch > 16 || !Number.isInteger(note) || note < 0 || note > 127)
            parseErrors.push({ blockNum, line: lineNum, message: `trigger_note ungültig: ch=${ch} (1–16), note=${note} (0–127)` })
    }

    if (y.music && typeof y.music === 'object') {
        const { volume, start, end, fadein, fadeout, fading_point } = y.music
        if (volume != null && (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 1))
            parseErrors.push({ blockNum, line: lineNum, message: `music.volume ungültig: ${volume} (erwartet 0.0–1.0)` })
        for (const [k, v] of [['start', start], ['end', end], ['fadein', fadein], ['fadeout', fadeout], ['fading_point', fading_point]]) {
            if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0))
                parseErrors.push({ blockNum, line: lineNum, message: `music.${k} ungültig: ${v} (nicht-negative Zahl erwartet)` })
        }
    }

    if (y.music_seq != null) {
        if (!Array.isArray(y.music_seq)) {
            parseErrors.push({ blockNum, line: lineNum, message: 'music_seq muss eine Liste sein' })
        } else {
            y.music_seq.forEach((item, i) => {
                if (!item || typeof item !== 'object' || typeof item.file !== 'string' || !item.file)
                    parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}]: 'file' (String) fehlt` })
                else {
                    const { volume, start, end, fadein, fadeout, fading_point } = item
                    if (volume != null && (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 1))
                        parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}].volume ungültig: ${volume}` })
                    for (const [k, v] of [['start', start], ['end', end], ['fadein', fadein], ['fadeout', fadeout], ['fading_point', fading_point]]) {
                        if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0))
                            parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}].${k} ungültig: ${v}` })
                    }
                }
            })
        }
    }

    if (y.auto_trigger && typeof y.auto_trigger === 'object' && y.auto_trigger.at != null) {
        const { at } = y.auto_trigger
        if (typeof at !== 'number' || !isFinite(at) || at < 0)
            parseErrors.push({ blockNum, line: lineNum, message: `auto_trigger.at ungültig: ${at} (nicht-negative Zahl erwartet)` })
    }

    if (y.cue_midi != null && !Array.isArray(y.cue_midi))
        parseErrors.push({ blockNum, line: lineNum, message: 'cue_midi muss eine Liste sein' })

    if (y.cue_osc != null && !Array.isArray(y.cue_osc))
        parseErrors.push({ blockNum, line: lineNum, message: 'cue_osc muss eine Liste sein' })
}

function validateYamlBlocks(text) {
    parseErrors   = []
    audioWarnings = []
    noteConflicts = []
    const parsedBlocks = []  // {blockNum, line, yaml, groupId}
    let blockNum = 0
    for (const m of text.matchAll(/```yaml\n([\s\S]*?)\n```/g)) {
        blockNum++
        const line = text.slice(0, m.index).split('\n').length
        let parsed = null
        try {
            parsed = yaml.load(m[1])
        } catch (e) {
            parseErrors.push({ blockNum, line, message: e.message })
        }
        if (parsed && blockNum > 1) validateCueFields(parsed, blockNum, line)
        parsedBlocks.push({ blockNum, line, yaml: parsed })
    }
    // Assign variant-group IDs: each non-sibling trigger starts a new group
    let groupId = 0
    for (const b of parsedBlocks) {
        if (b.blockNum === 1) { b.groupId = 0; continue }
        if (!b.yaml?.sibling) groupId++
        b.groupId = groupId
    }
    // Detect duplicate trigger_notes, ignoring intentional same-note variants
    const seenTriggerNotes = new Map()  // "ch.note" → {blockNum, groupId}
    for (const b of parsedBlocks) {
        if (b.blockNum === 1 || !b.yaml?.trigger_note) continue
        const key = `${b.yaml.trigger_note.ch}.${b.yaml.trigger_note.note}`
        if (seenTriggerNotes.has(key)) {
            const prev = seenTriggerNotes.get(key)
            if (prev.groupId !== b.groupId) {
                noteConflicts.push({ key, first: prev.blockNum, second: b.blockNum })
            }
        } else {
            seenTriggerNotes.set(key, { blockNum: b.blockNum, groupId: b.groupId })
        }
    }
}

function getYamlBlockStartLine(blockNum) {
    if (!scriptText || blockNum == null) return null
    const re = /```yaml\n/g
    let count = 0, m
    while ((m = re.exec(scriptText)) !== null) {
        if (++count === blockNum)
            return (scriptText.slice(0, m.index).match(/\n/g) || []).length + 1
    }
    return null
}

function showParseErrors() {
    const existing = document.getElementById('parse-error-banner')
    if (existing) existing.remove()
    if (!parseErrors.length && !audioWarnings.length && !noteConflicts.length) return
    const banner = document.createElement('div')
    banner.id = 'parse-error-banner'
    banner.className = 'parse-error-banner'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'parse-error-close'
    closeBtn.textContent = t('parse.error.dismiss')
    closeBtn.addEventListener('click', () => { banner.remove(); updateGutterState() })
    banner.appendChild(closeBtn)
    let html = ''
    if (parseErrors.length) {
        const items = parseErrors.map(({ blockNum, line, message, unknownKey }) => {
            const mdLine = getYamlBlockStartLine(blockNum)
            const locHtml = mdLine != null
                ? `<button class="parse-error-line-btn" data-md-line="${mdLine}" type="button">Zeile ${mdLine}</button>${line != null ? `, YAML-Zeile ${line}` : ''}`
                : (line != null ? `YAML-Zeile ${line}` : '')
            const deleteHtml = unknownKey != null
                ? ` <button class="parse-error-delete-btn" data-block-num="${blockNum}" data-key="${escapeHtml(unknownKey)}" type="button">${escapeHtml(t('parse.error.delete.key'))}</button>`
                : ''
            return `<li>${locHtml ? locHtml + ': ' : ''}${escapeHtml(message)}${deleteHtml}</li>`
        }).join('')
        html += `<strong>${parseErrors.length} YAML-Fehler</strong><ul>${items}</ul>`
    }
    if (audioWarnings.length) {
        const items = audioWarnings.map(({ file }) =>
            `<li>${escapeHtml(file)}</li>`
        ).join('')
        html += `<strong>${audioWarnings.length} Audiodatei${audioWarnings.length > 1 ? 'en' : ''} nicht gefunden</strong><ul>${items}</ul>`
    }
    if (noteConflicts.length) {
        const items = noteConflicts.map(({ key, first, second }) =>
            `<li>MIDI-Note ${escapeHtml(key)}: Block ${first} und Block ${second}</li>`
        ).join('')
        html += `<strong>${noteConflicts.length} doppelte MIDI-Note${noteConflicts.length > 1 ? 'n' : ''}</strong><ul>${items}</ul>`
    }
    const content = document.createElement('div')
    content.innerHTML = html
    content.querySelectorAll('.parse-error-line-btn').forEach(btn => {
        btn.addEventListener('click', () => scrollToMdLine(parseInt(btn.dataset.mdLine)))
    })
    content.querySelectorAll('.parse-error-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteUnknownYamlKey(parseInt(btn.dataset.blockNum), btn.dataset.key))
    })
    banner.appendChild(content)
    document.body.prepend(banner)
}

function scrollToMdLine(mdLine) {
    const el = document.querySelector(`#script-content > [data-md-line="${mdLine}"]`)
    if (!el) return
    const banner = document.getElementById('parse-error-banner')
    const bannerH = banner ? banner.offsetHeight : 0
    // Find the nearest preceding h1/h2 — it will be sticky at the top after scrolling
    let stickyH = 0
    let prev = el.previousElementSibling
    while (prev) {
        if (prev.tagName === 'H1' || prev.tagName === 'H2') { stickyH = prev.offsetHeight; break }
        prev = prev.previousElementSibling
    }
    const targetTop = el.getBoundingClientRect().top + window.scrollY - bannerH - stickyH - 8
    window.scrollTo({ top: targetTop, behavior: 'smooth' })
}

function deleteUnknownYamlKey(blockNum, key) {
    let count = 0
    const newText = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        count++
        if (count !== blockNum) return match
        let parsed
        try { parsed = yaml.load(content) } catch { return match }
        if (!parsed || typeof parsed !== 'object') return match
        if (key.startsWith('config.')) {
            if (parsed.config && typeof parsed.config === 'object') delete parsed.config[key.slice(7)]
        } else {
            delete parsed[key]
        }
        const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
        return count === 1
            ? `\`\`\`yaml\n${newYaml.trimEnd()}\n\`\`\``
            : `\`\`\`yaml\n${inlineNoteObjects(newYaml.trimEnd())}\n\`\`\``
    })
    parseErrors = parseErrors.filter(e => !(e.unknownKey === key && e.blockNum === blockNum))
    scriptText = newText
    showParseErrors()
    writeScriptMd(newText)
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
    const blocks = tokenizeScript(scriptText)
    let ti = 0
    for (const child of content.children) {
        // Skip yaml tokens with no DOM representation (config yaml is removed by convertCodeblocks)
        while (ti < blocks.length && blocks[ti].type === 'yaml' && !isTriggerEl(child)) ti++
        if (ti >= blocks.length) break
        child.dataset.blockIdx = ti
        if (child.classList.contains('trigger-group')) {
            ti += child.querySelectorAll('[data-trigger-index]').length
        } else {
            ti++
        }
    }
    const firstBlock = content.querySelector(':scope > :not(.insert-zone):not(.empty-script-state)')
    const isFirstCue = !!(firstBlock?.classList.contains('trigger') || firstBlock?.classList.contains('trigger-group'))
    content.classList.toggle('first-block-is-cue', isFirstCue)
}

function annotateLineNumbers() {
    const content = document.getElementById('script-content')
    let maxLine = 0
    for (const child of content.children) {
        if (child.dataset.blockIdx === undefined) continue
        const info = getBlockInfo(parseInt(child.dataset.blockIdx))
        if (!info) continue
        child.dataset.mdLine = info.lineStart + 1
        if (info.lineStart + 1 > maxLine) maxLine = info.lineStart + 1
    }
    // Number box ends 0.5rem before separator: gutter = digits*~0.5rem + 1.4rem overhead
    const digits = maxLine > 0 ? String(maxLine).length : 1
    const widths = [0, 1.8, 2.3, 2.8, 3.3, 3.9]
    const w = widths[Math.min(digits, widths.length - 1)]
    const wStr = w + 'rem'
    content.style.setProperty('--md-gutter-w', wStr)
    document.documentElement.style.setProperty('--md-gutter-w', wStr)
    updateGutterState()
}

function updateGutterState() {
    const content = document.getElementById('script-content')
    if (!content) return
    const headings = Array.from(content.querySelectorAll(':scope > h1, :scope > h2'))
    const showNumbers = content.classList.contains('show-md-line-numbers')
    if (!showNumbers) {
        headings.forEach(h => h.classList.remove('md-heading-inactive'))
        content.querySelectorAll(':scope > .md-line-hidden').forEach(el => el.classList.remove('md-line-hidden'))
        return
    }
    // Among headings stuck at top: 0, only the last (DOM-order) one is visually on top.
    let lastStuck = null
    for (const h of headings) {
        if (h.getBoundingClientRect().top <= 1) lastStuck = h
    }
    for (const h of headings) {
        h.classList.toggle('md-heading-inactive', h.getBoundingClientRect().top <= 1 && h !== lastStuck)
    }
    // Hide line numbers for non-heading blocks whose top is above the sticky area.
    const banner = document.getElementById('parse-error-banner')
    const cutoff = (banner ? banner.offsetHeight : 0) + (lastStuck ? lastStuck.offsetHeight : 0)
    for (const block of content.querySelectorAll(':scope > [data-md-line]')) {
        if (block.tagName === 'H1' || block.tagName === 'H2') continue
        block.classList.toggle('md-line-hidden', block.getBoundingClientRect().top < cutoff)
    }
}

function findTriggerByNote(tn) {
    if (!tn) return null
    for (let i = 1; i < triggerYamls.length; i++) {
        const t = triggerYamls[i]
        if (t && t.trigger_note && t.trigger_note.ch === tn.ch && t.trigger_note.note === tn.note) return i
    }
    return null
}

let pickModeEligibilityFn = null

function _pickEscHandler(e) { if (e.key === 'Escape') exitPickMode() }

function enterPickMode(cb, eligibilityFn = null) {
    pickModeCallback = cb
    pickModeEligibilityFn = eligibilityFn
    if (eligibilityFn) {
        document.body.classList.add('trigger-pick-mode-filtered')
        for (let i = 1; i < triggers.length; i++) {
            if (triggers[i]) triggers[i].classList.toggle('trigger-pick-eligible', eligibilityFn(i))
        }
    } else {
        document.body.classList.add('trigger-pick-mode')
    }
    document.addEventListener('keydown', _pickEscHandler)
}

function exitPickMode() {
    pickModeCallback = null
    pickModeEligibilityFn = null
    document.body.classList.remove('trigger-pick-mode', 'trigger-pick-mode-filtered')
    document.querySelectorAll('.trigger-pick-eligible').forEach(el => el.classList.remove('trigger-pick-eligible'))
    document.removeEventListener('keydown', _pickEscHandler)
}

function updateAutoBtnAppearance(btn, idx) {
    const aty = triggerYamls[idx]?.auto_trigger
    if (shiftHeld && aty) {
        btn.textContent = t('btn.autocue.delete')
        btn.classList.remove('trigger-action-btn-active')
        btn.classList.add('trigger-action-btn-danger')
        btn.title = t('btn.autocue.title.delete')
    } else {
        btn.textContent = t('btn.autocue')
        btn.classList.remove('trigger-action-btn-danger')
        btn.classList.toggle('trigger-action-btn-active', !!aty)
        btn.title = aty ? t('btn.autocue.title.edit') : t('btn.autocue.title.set')
    }
}

function updateAutoMicBtnAppearance(btn, idx) {
    const isActive = triggerYamls[idx]?.auto_mic
    if (shiftHeld && isActive) {
        btn.textContent = '✕ Auto-Mic'
        btn.classList.remove('trigger-action-btn-active')
        btn.classList.add('trigger-action-btn-danger')
        btn.title = t('btn.automic.title.active')
    } else {
        btn.innerHTML = MIC_SVG + ' Auto-Mic'
        btn.classList.remove('trigger-action-btn-danger')
        btn.classList.toggle('trigger-action-btn-active', !!isActive)
        btn.title = isActive ? t('btn.automic.title.active') : t('btn.automic.title.set')
    }
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

function setupAutoTriggers() {
    // Teardown old listeners
    for (const [, setup] of autoTriggerSetup) {
        setup.unPlay?.()
        setup.unTime?.()
        setup.unPause?.()
        setup.unFin?.()
    }
    autoTriggerSetup.clear()

    // Remove old waveform markers
    document.querySelectorAll('.ws-auto-marker').forEach(el => el.remove())

    // Clear any stale progress bars
    for (const [, btn] of autoTriggerBtns) {
        btn.style.background = ''
        btn.style.color = ''
    }

    // Build source → links map (keyed by source trigger index).
    // Expands each explicit source to include all its siblings so that variant
    // music tracks auto-trigger the same cue at the same position.
    const sourceLinks = new Map()
    for (let targetIdx = 1; targetIdx < triggerYamls.length; targetIdx++) {
        const aty = triggerYamls[targetIdx]?.auto_trigger
        if (!aty?.trigger_note) continue
        const explicitSourceIdx = findTriggerByNote(aty.trigger_note)
        if (explicitSourceIdx === null) continue

        // Collect all group members of the source (root + consecutive siblings)
        const sourceRoot = groupRootOf(explicitSourceIdx)
        const allSourceIdxs = [sourceRoot]
        for (let i = sourceRoot + 1; i < triggerYamls.length; i++) {
            if (!triggerYamls[i]?.sibling) break
            allSourceIdxs.push(i)
        }

        for (const srcIdx of allSourceIdxs) {
            if (!sourceLinks.has(srcIdx)) sourceLinks.set(srcIdx, [])
            const existing = sourceLinks.get(srcIdx)
            if (!existing.find(l => l.targetIdx === targetIdx)) {
                existing.push({
                    targetIdx,
                    at: aty.at,
                    tn: triggerYamls[targetIdx]?.trigger_note ?? null,
                    markerEl: null,
                })
            }
        }
    }

    for (const [sourceIdx, links] of sourceLinks) {
        const ta = triggerAudio.get(sourceIdx)
        if (!ta) continue

        // Add waveform markers to source overlay
        for (const link of links) {
            if (!ta.overlay) continue
            const marker = document.createElement('div')
            marker.classList.add('ws-auto-marker')
            if (link.tn) {
                const label = document.createElement('span')
                label.classList.add('ws-auto-marker-label')
                label.textContent = `${link.tn.ch}.${link.tn.note}`
                marker.appendChild(label)
            }
            ta.overlay.appendChild(marker)
            link.markerEl = marker
        }

        const positionMarkers = () => {
            for (const link of links) {
                if (!link.markerEl) continue
                link.markerEl.style.left = ta.getX(link.at) + 'px'
            }
        }
        if (ta.autoMarkerState) {
            ta.autoMarkerState.refresh = positionMarkers
            positionMarkers()
        }

        // Shift-drag to reposition auto-cue markers
        for (const link of links) {
            if (!link.markerEl) continue
            link.markerEl.addEventListener('mousedown', (e) => {
                if (!shiftHeld) return
                e.stopPropagation(); e.preventDefault()
                const move = (me) => {
                    const t = ta.getTimeAtClientX?.(me.clientX)
                    if (t == null) return
                    link.at = Math.round(t * 1000) / 1000
                    positionMarkers()
                }
                const up = () => {
                    document.removeEventListener('mousemove', move)
                    document.removeEventListener('mouseup', up)
                    const aty = triggerYamls[link.targetIdx]?.auto_trigger
                    if (aty) updateAutoTriggerInScript(link.targetIdx, { ...aty, at: link.at })
                }
                document.addEventListener('mousemove', move)
                document.addEventListener('mouseup', up)
            })
        }

        // Firing + progress bar state
        const firedSet = new Set()

        const onPlay = () => {
            firedSet.clear()
            // Use currentTime directly — it's already at the correct position whether
            // play was triggered by triggerAction, the waveform ▶ button, or after
            // a manual scrub while paused.
            const ct = ta.mainAudioEl.currentTime
            let lastPast = null
            for (const link of links) {
                if (link.at <= ct) {
                    firedSet.add(link.targetIdx)
                    if (lastPast === null || link.at > lastPast.at) lastPast = link
                }
            }
            // Fire the last past auto-trigger (scrub-then-play, resume mid-track, etc.)
            if (lastPast !== null) {
                currentCue = lastPast.targetIdx
                markTriggers(lastPast.targetIdx)
                scrollToTrigger(lastPast.targetIdx)
                pendingAutoTrigger = true
                triggerAction(lastPast.targetIdx)
            }
        }

        const onTime = (ct) => {
            // Don't fire during seeks or waveform scrubbing — only during actual playback
            if (ta.mainAudioEl.paused || scrubbingSet.has(sourceIdx)) return
            for (const link of links) {
                if (!firedSet.has(link.targetIdx) && ct >= link.at) {
                    firedSet.add(link.targetIdx)
                    const btn = autoTriggerBtns.get(link.targetIdx)
                    if (btn) { btn.style.background = ''; btn.style.color = '' }
                    currentCue = link.targetIdx
                    markTriggers(link.targetIdx)
                    scrollToTrigger(link.targetIdx)
                    pendingAutoTrigger = true
                    triggerAction(link.targetIdx)
                    continue
                }
                // Progress bar fill
                const btn = autoTriggerBtns.get(link.targetIdx)
                if (btn && !firedSet.has(link.targetIdx) && link.at > 0) {
                    const pct = Math.min(100, Math.max(0, ct / link.at * 100))
                    btn.style.background = `linear-gradient(to right, rgba(152,195,121,0.35) ${pct}%, transparent ${pct}%)`
                }
            }
        }

        const onPause = () => {
            for (const link of links) {
                const btn = autoTriggerBtns.get(link.targetIdx)
                if (btn) { btn.style.background = ''; btn.style.color = '' }
            }
        }

        const unPlay  = ta.ws.on('play',       onPlay)
        const unTime  = ta.ws.on('timeupdate', onTime)
        const unPause = ta.ws.on('pause',      onPause)
        const unFin   = ta.ws.on('finish',     onPause)

        autoTriggerSetup.set(sourceIdx, {
            links, unPlay, unTime, unPause, unFin,
            markFired:      (targetIdx) => firedSet.add(targetIdx),
            getUnfiredPast: (ct) => links
                .filter(l => !firedSet.has(l.targetIdx) && l.at <= ct)
                .sort((a, b) => b.at - a.at),
        })
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
        // Adjust cue tracking only when the adjacent block is also a yaml trigger
        if (blocks[prev].type === 'yaml') {
            if (currentCue === triggerIndex) currentCue--
            else if (currentCue === triggerIndex - 1) currentCue++
            cueHistory = cueHistory.map(h => h === triggerIndex ? h - 1 : h === triggerIndex - 1 ? h + 1 : h)
        }
        ;[blocks[prev], blocks[pos]] = [blocks[pos], blocks[prev]]
    } else {
        const next = pos + 1
        if (next >= blocks.length) return
        if (blocks[next].type === 'yaml') {
            if (currentCue === triggerIndex) currentCue++
            else if (currentCue === triggerIndex + 1) currentCue--
            cueHistory = cueHistory.map(h => h === triggerIndex ? h + 1 : h === triggerIndex + 1 ? h - 1 : h)
        }
        ;[blocks[pos], blocks[next]] = [blocks[next], blocks[pos]]
    }

    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    writeScriptMd(updated)
    rerender(updated)
}

// Inserts a new trigger YAML block after the block at insertAfterBlockIdx.
// Block indices correspond to DOM child index + 1 (blocks[0] = config, not in DOM).
function insertTriggerInScript(insertAfterBlockIdx, newYaml) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    if (insertAfterBlockIdx < 0 || insertAfterBlockIdx >= blocks.length) return

    // Count yaml blocks (including config) up to and including insertAfterBlockIdx —
    // that count is the 1-based trigger index of the newly inserted block.
    let yamlCountUpTo = 0
    for (let i = 0; i <= insertAfterBlockIdx; i++) {
        if (blocks[i].type === 'yaml') yamlCountUpTo++
    }
    // All triggers at index >= yamlCountUpTo shift up by 1
    if (currentCue >= yamlCountUpTo) currentCue++
    cueHistory = cueHistory.map(h => h >= yamlCountUpTo ? h + 1 : h)

    const newBlock = { type: 'yaml', content: '```yaml\n' + inlineNoteObjects(yaml.dump(newYaml, { indent: 4 }).trimEnd()) + '\n```' }
    blocks.splice(insertAfterBlockIdx + 1, 0, newBlock)
    let updated = blocks.map(b => b.content).join('\n\n') + '\n'
    const { text: assigned, changed } = assignTriggerNotes(updated)
    if (changed) updated = assigned
    scriptText = updated
    writeScriptMd(updated)
    rerender(updated)
}

// Splits the text block at blockIdx into two halves and inserts a trigger between them.
function splitBlockAndInsertTrigger(blockIdx, mdBefore, mdAfter, newYaml) {
    const blocks = tokenizeScript(scriptText)

    // blockIdx is a text block — count yamls strictly before it to get new trigger's index
    let yamlCountBefore = 0
    for (let i = 0; i < blockIdx; i++) {
        if (blocks[i].type === 'yaml') yamlCountBefore++
    }
    if (currentCue >= yamlCountBefore) currentCue++
    cueHistory = cueHistory.map(h => h >= yamlCountBefore ? h + 1 : h)

    const newYamlBlock = { type: 'yaml', content: '```yaml\n' + inlineNoteObjects(yaml.dump(newYaml, { indent: 4 }).trimEnd()) + '\n```' }
    const replacements = []
    if (mdBefore.trim()) replacements.push({ type: 'text', content: mdBefore.trim() })
    replacements.push(newYamlBlock)
    if (mdAfter.trim()) replacements.push({ type: 'text', content: mdAfter.trim() })
    blocks.splice(blockIdx, 1, ...replacements)
    let updated = blocks.map(b => b.content).join('\n\n') + '\n'
    const { text: assigned, changed } = assignTriggerNotes(updated)
    if (changed) updated = assigned
    scriptText = updated
    writeScriptMd(updated)
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
        if (mp.fadein     > 0)     lines.push('    fadein: '    + fmt(mp.fadein))
        if (mp.fadeout    > 0)     lines.push('    fadeout: '   + fmt(mp.fadeout))
        if (mp.loop)               lines.push('    loop: true')
        if (mp.fading_point  > 0)     lines.push('    fading_point: ' + fmt(mp.fading_point))

        // Replace the entire music: block (all consecutively indented lines)
        c = c.replace(/^music:(?:\n    [^\n]*)*/m, 'music:\n' + lines.join('\n'))

        return `\`\`\`yaml\n${c}\`\`\``
    })
    scriptText = updated
    writeScriptMd(updated)
    if (triggerYamls[triggerIndex]) {
        if (typeof triggerYamls[triggerIndex].music === 'string') {
            triggerYamls[triggerIndex].music = { file: triggerYamls[triggerIndex].music }
        }
        Object.assign(triggerYamls[triggerIndex].music, mp)
    }
}

function updateAutoTriggerInScript(targetIndex, autoYaml) {
    let blockIdx = 0
    const updated = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIdx++
        if (blockIdx !== targetIndex + 1) return match
        // Remove existing auto_trigger block (key + all indented sub-lines)
        let c = content.replace(/^auto_trigger:(?:\n    [^\n]*)*/m, '').replace(/\n{3,}/g, '\n\n')
        if (autoYaml !== null) {
            const { trigger_note: tn, at } = autoYaml
            const lines = ['auto_trigger:']
            if (tn) lines.push(`    trigger_note: {ch: ${tn.ch}, note: ${tn.note}}`)
            lines.push(`    at: ${parseFloat(at.toFixed(3))}`)
            c = c.trimEnd() + '\n' + lines.join('\n') + '\n'
        }
        return `\`\`\`yaml\n${c}\`\`\``
    })
    scriptText = updated
    writeScriptMd(updated)
    if (triggerYamls[targetIndex]) {
        if (autoYaml !== null) {
            triggerYamls[targetIndex].auto_trigger = autoYaml
        } else {
            delete triggerYamls[targetIndex].auto_trigger
        }
    }
    const btn = autoTriggerBtns.get(targetIndex)
    if (btn) updateAutoBtnAppearance(btn, targetIndex)
    setupAutoTriggers()
}

// ── Role-group helpers ─────────────────────────────────────────────────────────

function isGroup(name) {
    if (name === 'Alle' || (name === 'All' && appLanguage === 'en')) return true
    return !!(config.groups?.[name])
}

function getGroupRoles(name) {
    if (name === 'Alle' || (name === 'All' && appLanguage === 'en')) return Object.keys(config.roles || {})
    return config.groups?.[name]?.roles || []
}

function getGroupColor(name) {
    if (name === 'Alle' || (name === 'All' && appLanguage === 'en')) return null
    return config.groups?.[name]?.color || null
}

function getGroupDisplayName(name) {
    if (name === 'Alle') return t('mic.group.alle')
    return name
}

// Converts a mic value (group names or individual roles) into a display-ready array.
// Each entry is either {isGroup:true, name, color, members:[{name,color}]}
//                   or {isGroup:false, name, color}.
// When entries are already group names → expand directly.
// When entries are individual role names → reverse-map to groups where all members are active.
function groupRolesForDisplay(micVal, grouped = true) {
    if (!micVal || micVal === 'muteall') return []
    const arr = typeof micVal === 'string' ? [micVal] : micVal

    if (!grouped) {
        // Flat mode: expand groups to individual roles, deduplicate by name
        const result = []
        const seen = new Set()
        for (const name of arr) {
            if (isGroup(name)) {
                for (const r of getGroupRoles(name).filter(r => config.roles?.[r])) {
                    if (!seen.has(r)) { seen.add(r); result.push({ isGroup: false, name: r, color: config.roles[r]?.color || null }) }
                }
            } else if (!seen.has(name)) {
                seen.add(name)
                result.push({ isGroup: false, name, color: config.roles?.[name]?.color || null })
            }
        }
        return result
    }

    // If any entry is already a group name, use direct expansion (manual mic case)
    if (arr.some(name => isGroup(name))) {
        return arr.map(name => {
            if (isGroup(name)) {
                const members = getGroupRoles(name).filter(r => config.roles?.[r])
                return {
                    isGroup: true,
                    name: getGroupDisplayName(name),
                    color: getGroupColor(name),
                    members: members.map(r => ({ name: r, color: config.roles[r]?.color || null }))
                }
            }
            return { isGroup: false, name, color: config.roles?.[name]?.color || null }
        })
    }

    // All entries are individual role names — show as-is without reverse-mapping to groups.
    // Groups only appear when their name was explicitly used (handled by the branch above).
    return arr.map(name => ({ isGroup: false, name, color: config.roles?.[name]?.color || null }))
}

// Expands group names in a mic value to individual role names (for MIDI/OSC routing)
function expandMicForRouting(mic) {
    if (!mic || mic === 'muteall') return mic
    const arr = Array.isArray(mic) ? mic : [mic]
    const result = []
    for (const name of arr) {
        if (isGroup(name)) {
            for (const r of getGroupRoles(name)) {
                if (!result.includes(r)) result.push(r)
            }
        } else {
            if (!result.includes(name)) result.push(name)
        }
    }
    return result.length === 0 ? undefined : result.length === 1 ? result[0] : result
}

// ── Auto-Mic helpers ───────────────────────────────────────────────────────────

// Returns true if any cue has auto_mic: true
function hasAnyAutoMic() {
    return triggerYamls.some(ty => ty?.auto_mic === true)
}

// Computes the effective mic value for a cue that has auto_mic: true.
// Reads scriptText directly (no dependency on triggerYamls being fully populated).
// Returns: string role name | string[] | 'muteall' | null
function computeAutoMicRoles(triggerIndex) {
    const blocks = tokenizeScript(scriptText)
    let yamlCount = 0
    let myBlockIdx = -1
    let nextAutoMicBlockIdx = null

    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type !== 'yaml') continue
        yamlCount++
        // yamlCount=1 is config (triggerIndex=0), yamlCount=2 is first cue (triggerIndex=1), etc.
        if (yamlCount === triggerIndex) {
            // blockIdxForTrigger uses yamlCount === triggerIndex+1, so this is actually one before.
            // Let me use the same arithmetic: triggerIndex corresponds to yamlCount = triggerIndex
            // No wait - blockIdxForTrigger: ++yamlCount === triggerIndex+1 → yamlCount = triggerIndex+1
            // So at myBlockIdx, yamlCount will be triggerIndex+1 AFTER the increment.
        }
        if (yamlCount === triggerIndex + 1) {
            myBlockIdx = i
        } else if (myBlockIdx !== -1) {
            // Check if this yaml block has auto_mic: true via regex (avoids relying on triggerYamls)
            const rawContent = blocks[i].content.replace(/^```yaml\n?/, '').replace(/\n?```$/, '')
            if (/^\s*auto_mic\s*:\s*true/m.test(rawContent)) {
                nextAutoMicBlockIdx = i
                break
            }
        }
    }

    if (myBlockIdx === -1) return null

    // Collect roles/groups with dialogue in text blocks between this cue and the next auto-mic cue.
    // Preserve group names as-is so the display shows the group rather than its individual members.
    const seen = new Set()       // names added to roles (groups by group name, individuals by role name)
    const covered = new Set()    // individual members already covered by an added group
    const roles = []
    for (let i = myBlockIdx + 1; i < blocks.length; i++) {
        if (nextAutoMicBlockIdx !== null && i >= nextAutoMicBlockIdx) break
        if (blocks[i].type !== 'text') continue
        const m = blocks[i].content.match(/^\*\*([^*]+)\*\*\n([\s\S]+)/)
        if (m && m[2].trim()) {
            for (const r of m[1].split('/').map(s => s.trim()).filter(Boolean)) {
                if (isGroup(r)) {
                    if (!seen.has(r)) {
                        seen.add(r); roles.push(r)
                        for (const member of getGroupRoles(r)) covered.add(member)
                    }
                } else if (!covered.has(r) && !seen.has(r) && config.roles?.[r]) {
                    seen.add(r); roles.push(r)
                }
            }
        }
    }

    if (nextAutoMicBlockIdx === null) return 'muteall'
    if (roles.length === 0) return null
    return roles.length === 1 ? roles[0] : roles
}

// Returns the mic value to use when firing a cue: computed (auto_mic) or stored (mic).
function getMicForCue(triggerIndex) {
    const ty = triggerYamls[triggerIndex]
    if (!ty) return undefined
    if (ty.auto_mic) return computeAutoMicRoles(triggerIndex)
    return ty.mic
}

// Renders mic roles/muteall into a .trigger-mic element, optionally marking it as auto.
function renderMicIntoEl(el, mic, isAuto) {
    el.innerHTML = MIC_SVG
    if (mic === 'muteall') {
        const s = document.createElement('span')
        s.className = 'mic-all-off'
        s.textContent = ' ' + t('mic.muteall')
        el.appendChild(s)
        return
    }
    el.appendChild(document.createTextNode(' '))
    for (const item of groupRolesForDisplay(mic, micGroupDisplay)) {
        if (item.isGroup) {
            const grpEl = document.createElement('span')
            grpEl.className = 'mic-group'
            const grpName = document.createElement('span')
            grpName.className = 'mic-group-name' + (item.color ? ' color-' + item.color : '')
            grpName.textContent = item.name
            grpEl.appendChild(grpName)
            for (const member of (item.members || [])) {
                const mEl = document.createElement('span')
                mEl.className = 'mic-chip' + (member.color ? ' color-' + member.color : '')
                mEl.textContent = member.name
                grpEl.appendChild(mEl)
            }
            el.appendChild(grpEl)
        } else {
            const sp = document.createElement('span')
            sp.innerText = item.name
            if (item.color) sp.classList.add('color-' + item.color)
            el.appendChild(sp)
        }
    }
}

// Removes mic: fields from all YAML cue blocks in the script.
function removeAllManualMicsFromScript() {
    const blocks = tokenizeScript(scriptText)
    let changed = false
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type !== 'yaml') continue
        const raw = blocks[i].content.replace(/^```yaml\n/, '').replace(/\n?```$/, '')
        try {
            const parsed = yaml.load(raw)
            if (parsed && parsed.mic !== undefined) {
                delete parsed.mic
                blocks[i] = { type: 'yaml', content: '```yaml\n' + inlineNoteObjects(yaml.dump(parsed, { indent: 4 }).trimEnd()) + '\n```' }
                changed = true
            }
        } catch (e) {}
    }
    if (!changed) return
    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    writeScriptMd(updated)
    for (const ty of triggerYamls) {
        if (ty) delete ty.mic
    }
}

// Saves or removes auto_mic: true on a cue in scriptText, then refreshes all mic displays.
function updateAutoMicInScript(triggerIndex, enabled) {
    if (enabled && !hasAnyAutoMic()) {
        const hasManualMics = triggerYamls.some(ty => ty?.mic !== undefined)
        if (hasManualMics) {
            const overlay = document.createElement('div')
            overlay.className = 'dialog-overlay'
            overlay.style.zIndex = '9999'
            const box = document.createElement('div')
            box.className = 'dialog-box'
            box.style.maxWidth = '420px'
            const msg = document.createElement('p')
            msg.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 1.5rem;line-height:1.6'
            msg.textContent = t('automic.warn.msg')
            const actions = document.createElement('div')
            actions.className = 'dialog-actions'
            actions.style.cssText = 'flex-direction:column;align-items:stretch'
            const cancelBtn = document.createElement('button')
            cancelBtn.className = 'dialog-btn'
            cancelBtn.textContent = t('btn.cancel')
            const keepBtn = document.createElement('button')
            keepBtn.className = 'dialog-btn'
            keepBtn.textContent = t('automic.warn.keep')
            const removeBtn = document.createElement('button')
            removeBtn.className = 'dialog-btn dialog-btn-danger'
            removeBtn.textContent = t('automic.warn.remove')
            actions.append(cancelBtn, keepBtn, removeBtn)
            box.append(msg, actions)
            overlay.appendChild(box)
            document.body.appendChild(overlay)
            const close = () => overlay.remove()
            cancelBtn.addEventListener('click', close)
            overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })
            keepBtn.addEventListener('click', () => { close(); _applyAutoMicInScript(triggerIndex, enabled) })
            removeBtn.addEventListener('click', () => { close(); removeAllManualMicsFromScript(); _applyAutoMicInScript(triggerIndex, enabled) })
            return
        }
    }
    _applyAutoMicInScript(triggerIndex, enabled)
}

function _applyAutoMicInScript(triggerIndex, enabled) {
    let blockIdx = 0
    const updated = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIdx++
        if (blockIdx !== triggerIndex + 1) return match
        let c = content.replace(/^\s*auto_mic\s*:.*\n?/m, '')
        if (enabled) c = c.trimEnd() + '\nauto_mic: true\n'
        return `\`\`\`yaml\n${c}\`\`\``
    })
    scriptText = updated
    writeScriptMd(updated)
    if (triggerYamls[triggerIndex]) {
        if (enabled) triggerYamls[triggerIndex].auto_mic = true
        else delete triggerYamls[triggerIndex].auto_mic
    }
    // Refresh mic header displays and button states for all triggers
    for (let i = 1; i < triggerYamls.length; i++) {
        const triggerEl = triggers[i]
        if (!triggerEl) continue
        const triggerInfo = triggerEl.querySelector('.trigger-info')
        if (!triggerInfo) continue
        // Remove old mic display
        triggerInfo.querySelector('.trigger-mic')?.remove()
        // Auto_mic cues always show computed mics; manual mics only when no auto_mic is active anywhere
        const ty = triggerYamls[i]
        const anyAutoMic = hasAnyAutoMic()
        const micValue = ty?.auto_mic ? computeAutoMicRoles(i) : (!anyAutoMic ? ty?.mic : null)
        if (micValue) {
            const micEl = document.createElement('div')
            micEl.classList.add('trigger-mic')
            renderMicIntoEl(micEl, micValue, !!ty?.auto_mic)
            triggerInfo.insertBefore(micEl, triggerInfo.firstChild)
        }
        // Update auto-mic button state
        const btn = autoMicBtns.get(i)
        if (btn) updateAutoMicBtnAppearance(btn, i)
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
    const triggerMoveDiv = document.createElement("div")
    triggerMoveDiv.classList.add("trigger-move-btns")
    const triggerUpBtn   = document.createElement("button")
    const triggerDownBtn = document.createElement("button")
    triggerUpBtn.classList.add("trigger-move-btn")
    triggerDownBtn.classList.add("trigger-move-btn")
    triggerUpBtn.textContent = "▲"
    triggerDownBtn.textContent = "▼"
    triggerUpBtn.title = t('btn.move.up.title')
    triggerDownBtn.title = t('btn.move.down.title')
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
    // Warning banner (initially hidden; updated by updateLoopBtnAppearance / updateLoopBtnWavWarning)
    const wavWarnEl = document.createElement('div')
    wavWarnEl.className = 'trigger-wav-warning'
    wavWarnEl.textContent = t('warn.wav')
    wavWarnEl.style.display = 'none'
    triggerDiv.insertBefore(wavWarnEl, triggerDiv.firstChild ?? null)
    triggerDiv.appendChild(triggerRow)

    // ── action buttons row ──────────────────────────────────────────────
    const triggerActions = document.createElement("div")
    triggerActions.classList.add("trigger-actions")

    const triggerEditBtn = document.createElement("button")
    triggerEditBtn.classList.add("trigger-action-btn")
    triggerEditBtn.textContent = t('btn.edit')
    triggerEditBtn.title = t('btn.edit.title')
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

    // mic info — auto_mic cues always show computed mics; manual mics only when no auto_mic is active anywhere
    const micValue = codeblockYaml.auto_mic ? computeAutoMicRoles(index) : (!hasAnyAutoMic() ? codeblockYaml.mic : null)
    if (micValue) {
        renderMicIntoEl(triggerMic, micValue, codeblockYaml.auto_mic)
        triggerInfo.insertBefore(triggerMic, triggerInfo.firstChild)
    }

    // music info — only show row when music is configured
    if (codeblockYaml.music) {
        triggerMusic.innerHTML = TAPE_SVG
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
                triggerMusic.appendChild(document.createTextNode(`⇢ ${adjRef} ${t('adj.display.fadeout')}`))
            } else if (codeblockYaml.music.adjust.volume !== undefined) {
                triggerMusic.appendChild(document.createTextNode(`⇢ ${adjRef} ${t('adj.display.volume.pre')} ${Math.round(codeblockYaml.music.adjust.volume * 100)}%`))
            }
        }
        triggerInfo.appendChild(triggerMusic)
    }

    // OSC path badge
    if (codeblockYaml.osc) {
        const oscBadge = document.createElement('div')
        oscBadge.classList.add('trigger-osc')
        let oscText = '⌁ ' + codeblockYaml.osc
        if (codeblockYaml.osc_arg !== undefined && codeblockYaml.osc_arg !== '') {
            oscText += ' ' + codeblockYaml.osc_arg
        }
        oscBadge.textContent = oscText
        triggerInfo.appendChild(oscBadge)
    }

    // cue_midi chips
    if (Array.isArray(codeblockYaml.cue_midi) && codeblockYaml.cue_midi.length > 0) {
        const midiRow = document.createElement('div')
        midiRow.classList.add('trigger-cue-midi')
        for (const msg of codeblockYaml.cue_midi) {
            const chip = document.createElement('span')
            chip.classList.add('cue-msg-chip', 'cue-msg-chip--midi')
            const devName = msg.device || midiOutputDevices[0]?.name || ''
            const isUnknownMidi = !!msg.device && !midiOutputDevices.some(d => d.name === msg.device)
            const _rawColor = midiOutputDevices.find(d => d.name === devName)?.color || ''
            const devColor = /^#[0-9a-f]{3,8}$/i.test(_rawColor) ? _rawColor : ''
            if (isUnknownMidi) chip.classList.add('cue-msg-chip--unknown')
            if (devColor) {
                chip.style.cssText = `border-color:${devColor}55;background:${devColor}12`
            }
            const badge = document.createElement('span')
            badge.className = 'cue-type-badge'
            badge.textContent = (isUnknownMidi ? '! ' : '') + (devName || 'MIDI')
            if (devColor) badge.style.cssText = `background:${devColor}30;color:${devColor}`
            let text
            if (msg.comment) { text = msg.comment }
            else if (msg.type === 'note')  { text = `N${msg.note}` }
            else if (msg.type === 'cc')    { text = `CC${msg.cc}=${msg.value}` }
            else if (msg.type === 'pc')    { text = `PC${msg.program}` }
            else                           { text = 'SysEx' }
            const content = document.createElement('span')
            content.className = 'cue-msg-content'
            content.textContent = text
            chip.appendChild(badge)
            chip.appendChild(content)
            midiRow.appendChild(chip)
        }
        triggerInfo.appendChild(midiRow)
    }

    // cue_osc chips
    if (Array.isArray(codeblockYaml.cue_osc) && codeblockYaml.cue_osc.length > 0) {
        const oscRow = document.createElement('div')
        oscRow.classList.add('trigger-cue-osc')
        for (const msg of codeblockYaml.cue_osc) {
            const chip = document.createElement('span')
            chip.classList.add('cue-msg-chip', 'cue-msg-chip--osc')
            const oscDevName = msg.device || oscOutputDevices[0]?.name || ''
            const isUnknownOsc = !!msg.device && !oscOutputDevices.some(d => d.name === msg.device)
            const oscDevColor = (oscOutputDevices.find(d => d.name === oscDevName) ?? oscOutputDevices[0])?.color || ''
            if (isUnknownOsc) chip.classList.add('cue-msg-chip--unknown')
            if (oscDevColor) {
                chip.style.cssText = `border-color:${oscDevColor}55;background:${oscDevColor}12`
            }
            const badge = document.createElement('span')
            badge.className = 'cue-type-badge'
            badge.textContent = (isUnknownOsc ? '! ' : '') + (oscDevName || 'OSC')
            if (oscDevColor) badge.style.cssText = `background:${oscDevColor}30;color:${oscDevColor}`
            let text
            if (msg.comment) { text = msg.comment }
            else {
                text = msg.path || ''
                if (msg.arg !== undefined && String(msg.arg).trim() !== '') text += ` ${msg.arg}`
            }
            const content = document.createElement('span')
            content.className = 'cue-msg-content'
            content.textContent = text
            chip.appendChild(badge)
            chip.appendChild(content)
            oscRow.appendChild(chip)
        }
        triggerInfo.appendChild(oscRow)
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

    if (codeblockYaml.start_tc) {
        const tcBadge = document.createElement('span')
        tcBadge.className = 'trigger-tc-badge'
        tcBadge.textContent = '⏱ ' + codeblockYaml.start_tc
        tcBadge.title = 'Timecode-Offset'
        triggerDiv.appendChild(tcBadge)
    }
    // Derived TC badge for non-root SLF members: filled in after triggerYamls[index] is set below

    // ── waveform (only when a music file is set) ─────────────────────────
    const musicFile = sanitizeAudioPath(
        codeblockYaml.music
            ? (typeof codeblockYaml.music === "string" ? codeblockYaml.music : codeblockYaml.music.file)
            : null
    )

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
            volume:    musicObj.volume    ?? 0.8,
            start:     musicObj.start     ?? 0,
            end:       musicObj.end       ?? null,
            fadein:    musicObj.fadein    ?? 0,
            fadeout:   musicObj.fadeout   ?? 0,
            loop:      !!musicObj.loop,
            fading_point: musicObj.fading_point ?? 0,
        }
        let currentVolume = mp.volume
        let loopEnabled = mp.loop
        let saveTimer = null
        const debouncedSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => updateMusicPropsInScript(index, mp), 500) }

        const zoomOutBtn = makeWaveBtn("−", "Herauszoomen")
        const pauseBtn   = makeWaveBtn("⏵", "Wiedergabe / Pause")
        const stopBtn    = makeWaveBtn("⏹", "Stopp")
        const zoomInBtn  = makeWaveBtn("+", "Hineinzoomen")
        const loopBtn    = makeWaveBtn("⟳", "Loop")
        const updateLoopBtnWavWarning = () => {
            const ty_  = triggerYamls[index]
            const nonWav   = musicFile && !/\.wav$/i.test(musicFile)
            const isGapless = !!(ty_?.chain_end || ty_?.loop_outro || loopSourcesOf(index).length > 0 || mp.loop)
            loopBtn.classList.toggle('waveform-btn-wav-warning', !!(mp.loop && nonWav))
            loopBtn.title = 'Loop'
            const warnEl = triggers[index]?.querySelector('.trigger-wav-warning')
            if (warnEl) warnEl.style.display = (isGapless && nonWav) ? '' : 'none'
        }
        if (mp.loop) loopBtn.classList.add("waveform-btn-active")
        updateLoopBtnWavWarning()

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
        ws.load(audioBasePath + musicFile)
        ws.setVolume(mp.volume)

        // Media element is captured by AudioContext (prevents default device output)
        // but permanently silenced — all audio comes from AudioBufferSourceNode → playbackGain.
        // WaveSurfer continues to use the media element for waveform cursor display only.
        let mainAudioCtxGain = null
        let playbackGain     = null
        try {
            const ctx = getAudioCtx()
            if (mainAudioDevice && ctx.setSinkId) ctx.setSinkId(mainAudioDevice).catch(() => {})
            const mediaSource = ctx.createMediaElementSource(mainAudioEl)
            mainAudioCtxGain = ctx.createGain()
            mainAudioCtxGain.gain.value = 0          // media element audio permanently silenced
            mediaSource.connect(mainAudioCtxGain)
            mainAudioCtxGain.connect(ctx.destination)
            playbackGain = ctx.createGain()
            playbackGain.gain.value = mp.volume
            playbackGain.connect(ctx.destination)
        } catch (e) { /* falls back to direct element output */ }

        // ── AudioBufferSourceNode management (one active source per trigger) ──
        let activeSource            = null   // currently playing AudioBufferSourceNode
        let activeSourceStartedAt   = null   // AudioContext time when source was started
        let activeSourceStartOffset = null   // buffer offset (seconds) where source began
        let activeTailSrc           = null   // one-shot outro-tail source during loop overlap
        let activeTailCurEl         = null   // ghost cursor DOM element during loop overlap
        let tailEndTime             = null   // AudioContext time when the current tail ends
        let visuallyDone            = false  // hide from live-view bar after loop→finish handoff
        let suppressSeekRestart  = false
        let suppressPauseStop    = false  // prevents ws.on("pause") from killing a group source
        let forceFullBuffer      = false  // play button: ignore trim region, use full buffer

        // If this cue was playing during a rerender, adopt the running audio graph so the
        // AudioBufferSourceNode is never interrupted.  The new playbackGain (just created
        // above, nothing connected yet) is discarded in favour of the still-live old one.
        const _adoption = pendingAudioAdoptions.get(musicFile)
        if (_adoption) {
            pendingAudioAdoptions.delete(musicFile)
            try { playbackGain.disconnect() } catch {}
            playbackGain            = _adoption.playbackGain
            activeSource            = _adoption.activeSource
            activeSourceStartedAt   = _adoption.activeSourceStartedAt
            activeSourceStartOffset = _adoption.activeSourceStartOffset
            if (_adoption.volume !== null) currentVolume = _adoption.volume
        }

        // Copy [startSec, endSec] out of srcBuf into a fresh AudioBuffer.
        // The result can be looped with loopStart=0/loopEnd=duration for gapless region looping.
        // Returns true when the selected region covers the entire buffer — no slicing needed.
        function isFullFile(buf, startSec, endSec) {
            return (startSec ?? 0) <= 0 && endSec >= buf.duration - 0.001
        }

        function sliceBuffer(srcBuf, startSec, endSec, ctx) {
            const sr = srcBuf.sampleRate
            const s  = Math.round(startSec * sr)
            const e  = Math.min(Math.round(endSec * sr), srcBuf.length)
            const n  = Math.max(1, e - s)
            const out = ctx.createBuffer(srcBuf.numberOfChannels, n, sr)
            for (let ch = 0; ch < srcBuf.numberOfChannels; ch++)
                out.getChannelData(ch).set(srcBuf.getChannelData(ch).subarray(s, s + n))
            return out
        }

        function startSource(offset, when) {
            visuallyDone = false
            const ta_ = triggerAudio.get(index)
            if (!sharedAudioCtx || !playbackGain) {
                if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 1
                return
            }
            if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 0
            stopSource()
            if (!ta_?.decodedBuffer) { if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 1; return }
            if (forceFullBuffer) {
                forceFullBuffer = false
                const src = sharedAudioCtx.createBufferSource()
                src.buffer = ta_.decodedBuffer
                src.connect(playbackGain)
                const safeOff = Math.max(0, offset)
                src.start(when, safeOff)
                activeSource            = src
                activeSourceStartedAt   = when
                activeSourceStartOffset = safeOff
                src.addEventListener('ended', () => { if (activeSource === src) activeSource = null })
                return
            }
            const src = sharedAudioCtx.createBufferSource()
            tryBuildLoopGroups()
            const loopGroup = loopGroups.get(index)

            if (loopEnabled && !loopGroup && mp.end != null && !isFullFile(ta_.decodedBuffer, mp.start, mp.end)) {
                // Build a dedicated buffer for the selected region so the AudioBufferSourceNode
                // loops sample-accurately with no loopStart/loopEnd rounding drift.
                const regionStart = mp.start ?? 0
                const loopBuf     = sliceBuffer(ta_.decodedBuffer, regionStart, mp.end, sharedAudioCtx)
                src.buffer        = loopBuf
                src.loop          = true
                src.loopStart     = 0
                // fading_point is the absolute clip position of the loop boundary; tail plays on last pass
                src.loopEnd       = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) - regionStart : loopBuf.duration
                src.connect(playbackGain)
                const regionOff = Math.max(0, Math.min(offset - regionStart, loopBuf.duration))
                src.start(when, regionOff)
                activeSource            = src
                activeSourceStartedAt   = when
                activeSourceStartOffset = regionOff
                mainAudioEl.loop        = true  // cursor managed by fireLoopRestart timer
            } else {
                const safeOffset  = Math.max(0, offset)
                const regionStart = mp.start ?? 0
                if (loopGroup && mp.end != null && !isFullFile(ta_.decodedBuffer, mp.start, mp.end)) {
                    // SLF loop segment: slice the region into a dedicated buffer for
                    // sample-accurate gapless looping (same technique as plain loopEnabled).
                    // activeSourceStartOffset stays in original-file coords so armOutroTimer
                    // and fireGaplessTransition timing calculations remain correct.
                    const loopBuf  = sliceBuffer(ta_.decodedBuffer, regionStart, mp.end, sharedAudioCtx)
                    src.buffer     = loopBuf
                    src.loop       = true
                    src.loopStart  = 0
                    src.loopEnd    = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) - regionStart : loopBuf.duration
                    src.connect(playbackGain)
                    const regionOff = Math.max(0, Math.min(safeOffset - regionStart, loopBuf.duration))
                    src.start(when, regionOff)
                    activeSource            = src
                    activeSourceStartedAt   = when
                    activeSourceStartOffset = safeOffset  // original-file coords
                    loopGroup.loopVirtualStartTime = when - (safeOffset - regionStart)
                } else {
                    src.buffer = ta_.decodedBuffer
                    const isLoopTrigger = loopGroup || loopEnabled
                    if (isLoopTrigger) {
                        src.loop      = true
                        src.loopStart = regionStart
                        src.loopEnd   = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) : (mp.end ?? ta_.decodedBuffer.duration)
                    }
                    src.connect(playbackGain)
                    src.start(when, safeOffset)
                    activeSource            = src
                    activeSourceStartedAt   = when
                    activeSourceStartOffset = safeOffset
                    if (loopGroup) {
                        loopGroup.loopVirtualStartTime = when - (safeOffset - regionStart)
                        // Don't set mainAudioEl.loop for group triggers — loop-back seeking would
                        // trigger ws.on("seeking") → startSource → second audio instance.
                        // Cursor is reset manually in fireLoopRestart instead.
                    }
                    if (loopEnabled) mainAudioEl.loop = true
                }
            }
            src.addEventListener('ended', () => { if (activeSource === src) activeSource = null })
        }

        function stopSource(when) {
            // If this trigger's audio is owned by a group source from another trigger,
            // delegate to that trigger's forceStop callback instead.
            const ta_ = triggerAudio.get(index)
            if (!activeSource && ta_?.forceStop) {
                ta_.forceStop(when); ta_.forceStop = null; ta_.playbackGainOverride = null; return
            }
            if (activeTailSrc) {
                const ts = activeTailSrc; activeTailSrc = null
                try { ts.stop(when ?? sharedAudioCtx?.currentTime ?? 0) } catch (_) {}
            }
            if (!activeSource) return
            const src = activeSource
            activeSource = null
            activeSourceStartedAt   = null
            activeSourceStartOffset = null
            try { src.stop(when ?? sharedAudioCtx?.currentTime ?? 0) } catch (_) {}
        }

        const totalWaveWidth = () => ws.getWrapper().clientWidth || ws.getDuration() * state.zoom
        const getX = (t) => {
            const dur = ws.getDuration()
            if (!dur) return 0
            return (t / dur) * totalWaveWidth() - ws.getScroll()
        }
        const autoMarkerState = { refresh: null }

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
        const outroBar     = mkBar("outro")
        const startBotGrip = mkGrip("bot", "start")
        const startTopGrip = mkGrip("top", "start")
        const endBotGrip   = mkGrip("bot", "end")
        const endTopGrip   = mkGrip("top", "end")
        overlay.append(preRegion, postRegion, fadeinReg, fadeoutReg, startBar, endBar, outroBar, startBotGrip, startTopGrip, endBotGrip, endTopGrip)
        // Disable In/Out/Fadein/Fadeout grips for cues that use multiple loop files or fading_point.
        const _isComplexLoop = mp.fading_point > 0
            || (Array.isArray(codeblockYaml.music_seq) && codeblockYaml.music_seq.length > 0)
        if (_isComplexLoop) {
            for (const g of [startBotGrip, startTopGrip, endBotGrip, endTopGrip]) g.style.display = 'none'
            fadeinReg.style.display = 'none'
            fadeoutReg.style.display = 'none'
        }

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
            const outroX = mp.fading_point > 0 ? px(mp.fading_point) : null
            outroBar.style.left    = outroX !== null ? outroX + "px" : "0"
            outroBar.style.display = outroX !== null ? "block" : "none"
            startBotGrip.style.left = sx  + "px"
            startTopGrip.style.left = fix + "px"
            endBotGrip.style.left   = ex  + "px"
            endTopGrip.style.left   = fox + "px"
        }

        function isSlfCue() {
            const ty = triggerYamls[index]
            return !!(ty?.chain_end || ty?.loop_outro || loopSourcesOf(index).length > 0)
        }

        function updateSlfGrips() {
            // Grips are now always visible — SLF cues support start/end/fadein/fadeout too.
        }
        slfGripUpdaters.set(index, updateSlfGrips)

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

        ws.on("ready",  () => {
            waveformContainer.appendChild(overlay); updateMarkers(); updateSlfGrips(); autoMarkerState.refresh?.(); preDecodeForGapless(index); updateDerivedTcBadges()
            const s = mp.start ?? 0
            if (s > 0) { mainAudioEl.currentTime = s; requestAnimationFrame(() => ws.setScrollTime(s)) }
        })
        ws.on("scroll", () => { updateMarkers(); autoMarkerState.refresh?.() })
        ws.on("zoom",   () => { updateMarkers(); autoMarkerState.refresh?.() })
        ws.on("redraw", () => { updateMarkers(); autoMarkerState.refresh?.() })

        // ── Playback: fade + stop-at-end + loop ─────────────────────────
        let chainEndArmed = false
        let preSeekArmed  = false
        let chainEndTimer = null
        let loopJumpTimer = null

        // Gapless transition: sample-accurate via AudioBufferSourceNode.
        //
        // The key insight: AudioBufferSourceNode.start(when) is sample-accurate.
        // HTMLMediaElement.play() has ~baseLatency processing delay before audio
        // appears in the AudioContext graph. So:
        //   1. bufSource starts at transitionTime (exact)
        //   2. HTMLMediaElement starts from ns via setTimeout(delay=timeUntilEnd)
        //      → its audio appears at AudioContext time transitionTime + baseLatency
        //   3. switchTime = transitionTime + baseLatency: instant cut bufSource→media
        //      → both sources are at position ns + baseLatency at switchTime ✓
        // No crossfade, no audible click.
        let gaplessActive = false

        function _nonAudioActions(nextIdx, nextTa) {
            const ty = triggerYamls[nextIdx]
            const _mic = getMicForCue(nextIdx)
            if (_mic !== undefined && _mic !== null) effectiveMics = _mic
            x32UnmuteChannels(_mic)
            sendTriggerNote(nextIdx)
            const startTc = ty?.start_tc
            if (startTc && mtc) {
                mtc.start(startTc, nextTa.ws, nextIdx, nextTa.mp?.start ?? 0)
            } else if (!startTc && mtc && mtc.activeTcIndex !== null) {
                const srcTy = triggerYamls[index]
                const isCE = srcTy?.chain_end  && findTriggerByNote(srcTy.chain_end)  === nextIdx
                const isOT = srcTy?.loop_outro && findTriggerByNote(srcTy.loop_outro) === nextIdx
                if ((isCE || isOT) && nextTa) {
                    mtc.startFromFrames(mtc.getCurrentFrames(), nextTa.ws, nextIdx, nextTa.mp?.start ?? 0)
                }
            }
            if (typeof ty?.music === 'object' && ty.music.adjust) {
                const { trigger_note: adjTn, fadeout, volume: adjVol } = ty.music.adjust
                const adjIdx = findTriggerByNote(adjTn)
                if (adjIdx !== null) {
                    const adjTa = triggerAudio.get(adjIdx)
                    if (adjTa?.ws.isPlaying()) {
                        const ft = ty.music.adjust.fadetime ?? 3
                        if (fadeout) fadeAdjustAudio(adjTa, ft)
                        else if (adjVol !== undefined) fadeAdjustVolume(adjTa, adjVol, ft)
                    }
                }
            }
            cueHistory.push(nextIdx); cueHistoryAuto.push(false)
            broadcastLiveState()
        }

        function fireGaplessTransition(nextIdx) {
            const nextTa = triggerAudio.get(nextIdx)
            const ty = triggerYamls[nextIdx]
            const _micGap = getMicForCue(nextIdx)
            if (_micGap !== undefined && _micGap !== null) effectiveMics = _micGap
            if (!nextTa || !ty?.music) {
                // Audio-less outro: execute non-audio actions directly instead of going
                // through triggerAction, which would re-queue the outro via outro-interception
                // while the loop source is still playing.
                x32UnmuteChannels(_micGap)
                sendTriggerNote(nextIdx)
                sendOscMessage(nextIdx)
                sendCueMidiMessages(nextIdx)
                sendCueOscMessages(nextIdx)
                cueHistory.push(nextIdx); cueHistoryAuto.push(false)
                broadcastLiveState()
                return
            }

            const ns     = nextTa.mp?.start ?? 0
            const vol    = typeof ty.music === 'object' && ty.music.volume != null ? ty.music.volume : 0.8
            const fadein = typeof ty.music === 'object' && ty.music.fadein != null ? ty.music.fadein : 0
            const effEnd = mp.end ?? ws.getDuration()
            const timeUntilEnd = Math.max(0, effEnd - mainAudioEl.currentTime)

            const ctx = sharedAudioCtx

            const group = loopGroups.get(index)
            const isGroupOutro = group && group.outroIdx === nextIdx
            console.log('[gapless] transition', index, '→', nextIdx,
                '| isGroupOutro=', isGroupOutro, '| activeSource=', !!activeSource,
                '| loopVirtualStartTime=', group?.loopVirtualStartTime)

            if (isGroupOutro && ctx && activeSource) {
                // ── Sample-accurate Loop→Outro transition ──────────────────────────────
                const ta_       = triggerAudio.get(index)
                const sr        = ctx.sampleRate
                const outroAt   = mp.fading_point ?? 0
                const loopStartSec = mp.start ?? 0
                const clipEnd   = mp.end ?? (ta_?.decodedBuffer?.duration ?? ws.getDuration())
                const loopEndSec = outroAt > 0 ? outroAt : clipEnd
                const tailLen   = outroAt > 0 ? clipEnd - outroAt : 0
                // Use Math.round(x*sr) for each endpoint separately — matches how browsers
                // quantise loopStart/loopEnd to sample frames internally.
                const loopEndSamples   = Math.round(loopEndSec * sr)
                const loopStartSamples = Math.round(loopStartSec * sr)
                const loopDurSamples   = loopEndSamples - loopStartSamples
                // Compute next loop boundary directly from source start parameters.
                // firstBoundaryTime = AudioContext time when source first reaches loopEnd.
                const startOffSamples   = Math.round(activeSourceStartOffset * sr)
                const firstBoundaryTime = activeSourceStartedAt + (loopEndSamples - startOffSamples) / sr
                // n = additional loop periods needed to reach a boundary ≥ now
                const n = Math.max(0, Math.ceil((ctx.currentTime - firstBoundaryTime) * sr / loopDurSamples))
                let transitionTime = firstBoundaryTime + n * loopDurSamples / sr
                // Guard: boundary missed (timer arrived late, ws.on("finish") fallback).
                // Starting immediately is always better than waiting a full extra loop.
                if (transitionTime - ctx.currentTime > (loopEndSec - loopStartSec) * 0.5) {
                    transitionTime = ctx.currentTime
                }
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                if (outroAt > 0) {
                    // ① fading_point: disable looping so the source plays the decay tail naturally
                    if (activeSource) activeSource.loop = false
                } else {
                    // ① No tail: stop loop source at the exact musical boundary
                    stopSource(transitionTime)

                    // ② Stop cursor shortly before the audio boundary
                    setTimeout(() => {
                        suppressPauseStop = true
                        mainAudioEl.loop = false
                        mainAudioEl.pause()
                        setTimeout(() => { suppressPauseStop = false }, 0)
                    }, Math.max(0, msToTransition - 15))
                }

                // ③ Start outro audio source at the musical boundary
                const nextPg = nextTa.getPlaybackGain?.()
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(vol)
                if (nextPg) nextPg.gain.value = fadein > 0 ? 0 : vol
                nextTa.startGaplessSource(ns, transitionTime)

                // ④ At the musical boundary: stop Loop cursor, show ghost cursor for the tail,
                //    start Finish cursor immediately. Cleanup cursor state after the tail.
                const tailMs = tailLen * 1000
                gaplessActive = true
                setTimeout(() => {
                    visuallyDone = true  // hide loop bar immediately as finish takes over
                    if (outroAt > 0) {
                        // Stop the Loop cursor immediately; the audio tail continues playing.
                        suppressPauseStop = true
                        mainAudioEl.loop = false
                        mainAudioEl.pause()
                        setTimeout(() => { suppressPauseStop = false }, 0)
                        // Ghost cursor slides from outro point to end over tailLen seconds
                        const _dur = ws.getDuration()
                        if (_dur > 0) {
                            if (activeTailCurEl) { activeTailCurEl.remove(); activeTailCurEl = null }
                            const tailCurEl = document.createElement('div')
                            tailCurEl.classList.add('ws-tail-cursor')
                            tailCurEl.style.left = getX(loopEndSec) + 'px'
                            overlay.appendChild(tailCurEl)
                            activeTailCurEl = tailCurEl
                            requestAnimationFrame(() => { requestAnimationFrame(() => {
                                tailCurEl.style.transitionDuration = tailLen + 's'
                                tailCurEl.style.left = getX(effEnd) + 'px'
                            }) })
                            setTimeout(() => { if (activeTailCurEl === tailCurEl) { activeTailCurEl = null } tailCurEl.remove() }, tailLen * 1000 + 150)
                        }
                    }
                    nextTa.startCursor(ns, 0)
                }, Math.max(0, msToTransition))
                setTimeout(() => {
                    suppressPauseStop = true
                    mainAudioEl.loop = false
                    mainAudioEl.pause()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                    mainAudioEl.currentTime = mp.start
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    gaplessActive = false
                }, msToTransition + 10 + tailMs)

                _nonAudioActions(nextIdx, nextTa)

            } else if (ctx && nextTa.decodedBuffer && nextTa.startGaplessSource) {
                // ── Pure AudioBufferSourceNode transition (e.g. Intro → Loop) ──────────
                // With fading_point: transition fires at the absolute fading_point position from clip start.
                const outroAt2       = mp.fading_point ?? 0
                const effTransition2 = outroAt2 > 0 ? outroAt2 : effEnd
                const timeUntilTrans = Math.max(0, effTransition2 - mainAudioEl.currentTime)
                let transitionTime
                if (activeSourceStartedAt !== null && activeSourceStartOffset !== null) {
                    transitionTime = activeSourceStartedAt + (effTransition2 - activeSourceStartOffset)
                } else {
                    transitionTime = ctx.currentTime + timeUntilTrans
                }
                transitionTime = Math.max(ctx.currentTime, transitionTime)
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                // ① Without tail: stop current source at transition; with tail: let it play out
                if (outroAt2 > 0) {
                    // current source continues to its natural end (the decay tail)
                } else {
                    stopSource(transitionTime)
                }
                gaplessActive = true

                // ② Start next audio source at the musical boundary (transition point)
                const nextPg = nextTa.getPlaybackGain?.()
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(vol)
                if (nextPg) nextPg.gain.value = fadein > 0 ? 0 : vol
                nextTa.startGaplessSource(ns, transitionTime)

                // ③ Swap cursors after the tail finishes (immediately if no tail)
                const tailMs2 = outroAt2 > 0 ? (effEnd - outroAt2) * 1000 : 0
                setTimeout(() => {
                    gaplessActive = false
                    suppressPauseStop = true
                    mainAudioEl.pause()
                    mainAudioEl.currentTime = mp.start
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                    nextTa.startCursor(ns, 0)
                }, msToTransition + 5 + tailMs2)

                _nonAudioActions(nextIdx, nextTa)

            } else {
                // ── Fallback: buffer not decoded — use media element directly ──
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(vol)
                nextTa.ws.setVolume(fadein > 0 ? 0 : vol)
                nextTa.mainAudioEl.play().catch(() => {})
                mainAudioEl.pause()
                mainAudioEl.currentTime = mp.start
                ws.setVolume(currentVolume)
                if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                if (!nextTa.decodedBuffer) preDecodeForGapless(nextIdx)
                _nonAudioActions(nextIdx, nextTa)
            }
        }

        function fireChainEnd(nextIdx) {
            if (!ws.isPlaying() || chainEndArmed) return
            chainEndArmed = true
            currentCue = nextIdx
            markTriggers(nextIdx)
            scrollToTrigger(nextIdx)
            fireGaplessTransition(nextIdx)
        }
        function fireLoopOutro() {
            if (!ws.isPlaying() || !loopOutroPending.has(index)) return
            const outroIdx = loopOutroPending.get(index)
            loopOutroPending.delete(index)
            loopOutroInitialRemaining.delete(index)
            setOutroPendingIndicator(outroIdx, false)
            currentCue = outroIdx
            markTriggers(outroIdx)
            fireGaplessTransition(outroIdx)
        }
        // Shared helper for loopGroups and loopEnabled restart with fading_point > 0.
        // Plays the outro tail simultaneously with the new pass (true audio overlap).
        function _fireLoopOverlap(outroLen_, ctx_, ta_l) {
            const sr             = ctx_.sampleRate
            const loopStartSec   = mp.start ?? 0
            const effTransSec    = (mp.end ?? ta_l.decodedBuffer.duration) - outroLen_
            const loopEndSamples   = Math.round(effTransSec * sr)
            const loopStartSamples = Math.round(loopStartSec * sr)
            const loopDurSamples   = Math.max(1, loopEndSamples - loopStartSamples)
            const startOffSamples  = Math.round(activeSourceStartOffset * sr)
            const firstBoundaryTime = activeSourceStartedAt + (loopEndSamples - startOffSamples) / sr
            const n = Math.max(0, Math.ceil((ctx_.currentTime - firstBoundaryTime) * sr / loopDurSamples))
            let transitionTime = firstBoundaryTime + n * loopDurSamples / sr
            if (transitionTime - ctx_.currentTime > (effTransSec - loopStartSec) * 0.5) {
                transitionTime = ctx_.currentTime
            }
            const msToTransition = Math.max(0, transitionTime - ctx_.currentTime) * 1000

            const srcBuf     = activeSource.buffer
            const tailOffset = (srcBuf === ta_l.decodedBuffer) ? effTransSec : (srcBuf.duration - outroLen_)

            // Stop the looping source at the boundary; play the outro portion as a one-shot
            // so the tail overlaps with the fresh pass starting from mp.start.
            stopSource(transitionTime)
            const tailSrc = ctx_.createBufferSource()
            tailSrc.buffer = srcBuf
            tailSrc.connect(playbackGain)
            tailSrc.start(transitionTime, tailOffset, outroLen_)
            activeTailSrc = tailSrc
            tailSrc.addEventListener('ended', () => { if (activeTailSrc === tailSrc) activeTailSrc = null })

            // New loop source starts from mp.start at the same boundary time
            const newSrc = ctx_.createBufferSource()
            newSrc.buffer = srcBuf
            newSrc.loop   = true
            if (srcBuf === ta_l.decodedBuffer) {
                newSrc.loopStart = loopStartSec
                newSrc.loopEnd   = effTransSec
                newSrc.start(transitionTime, loopStartSec)
            } else {
                newSrc.loopStart = 0
                newSrc.loopEnd   = srcBuf.duration - outroLen_
                newSrc.start(transitionTime, 0)
            }
            newSrc.connect(playbackGain)
            activeSource            = newSrc
            activeSourceStartedAt   = transitionTime
            activeSourceStartOffset = loopStartSec
            newSrc.addEventListener('ended', () => { if (activeSource === newSrc) activeSource = null })
            const loopGroup_ = loopGroups.get(index)
            if (loopGroup_) loopGroup_.loopVirtualStartTime = transitionTime

            // Ghost second playhead: slides from effTransition → mp.end so the overlap is
            // visually obvious while the main cursor resets to mp.start.
            const _tailDur = ws.getDuration()
            if (_tailDur > 0) {
                if (activeTailCurEl) { activeTailCurEl.remove(); activeTailCurEl = null }
                const tailCurEl = document.createElement('div')
                tailCurEl.classList.add('ws-tail-cursor')
                tailCurEl.style.left = getX(effTransSec) + 'px'
                overlay.appendChild(tailCurEl)
                activeTailCurEl = tailCurEl
                requestAnimationFrame(() => { requestAnimationFrame(() => {
                    tailCurEl.style.transitionDuration  = outroLen_ + 's'
                    tailCurEl.style.transitionDelay     = (msToTransition / 1000).toFixed(3) + 's'
                    tailCurEl.style.left = getX(mp.end ?? _tailDur) + 'px'
                }) })
                setTimeout(() => { if (activeTailCurEl === tailCurEl) { activeTailCurEl = null } tailCurEl.remove() }, msToTransition + outroLen_ * 1000 + 150)
            }
            tailEndTime = transitionTime + outroLen_
            setTimeout(() => { if (tailEndTime !== null && sharedAudioCtx && sharedAudioCtx.currentTime >= tailEndTime - 0.1) tailEndTime = null }, msToTransition + outroLen_ * 1000 + 200)

            gaplessActive = true
            setTimeout(() => {
                suppressSeekRestart = true
                mainAudioEl.currentTime = loopStartSec
                gaplessActive = false
                setTimeout(() => { suppressSeekRestart = false }, 50)
            }, msToTransition)
        }

        function fireLoopRestart(effEnd) {
            if (!ws.isPlaying()) return
            // Outro may have been armed after the loop-restart timer was scheduled — fire it now.
            if (loopOutroPending.has(index)) { fireLoopOutro(); return }
            const loopDur = effEnd - mp.start
            if (mtc && mtc.activeTcIndex === index) {
                mtc.onLoopRestart(loopDur, mp.start)
                broadcastLiveState()  // immediately sync live TC after loop-back
            }
            preSeekArmed = false

            if (loopGroups.has(index)) {
                // Multi-file sequence: delegate to fireSeqNext for cross-file gapless transition
                const seqData_ = triggerSeqSlots.get(index)
                if (seqData_ && seqData_.total > 1) {
                    fireSeqNext()
                    return
                }
                if (!activeSource) return  // outro transition killed source — don't touch cursor
                clearTimeout(loopJumpTimer); loopJumpTimer = null

                const _ctx = sharedAudioCtx
                const _ta  = triggerAudio.get(index)
                const _outroAt = mp.fading_point ?? 0
                const _clipEnd = mp.end ?? _ta?.decodedBuffer?.duration ?? ws.getDuration()
                const _tailLen = _outroAt > 0 ? _clipEnd - _outroAt : 0
                if (_outroAt > 0 && _ctx && _ta?.decodedBuffer && playbackGain) {
                    _fireLoopOverlap(_tailLen, _ctx, _ta)
                } else {
                    suppressSeekRestart = true
                    mainAudioEl.currentTime = mp.start
                    setTimeout(() => { suppressSeekRestart = false }, 50)
                }
                return
            }
            if (activeSource && loopEnabled) {
                preSeekArmed = false
                clearTimeout(loopJumpTimer); loopJumpTimer = null

                const _ctx = sharedAudioCtx
                const _ta  = triggerAudio.get(index)
                const _outroAt = mp.fading_point ?? 0
                const _clipEnd = mp.end ?? _ta?.decodedBuffer?.duration ?? ws.getDuration()
                const _tailLen = _outroAt > 0 ? _clipEnd - _outroAt : 0
                if (_outroAt > 0 && _ctx && _ta?.decodedBuffer && playbackGain) {
                    _fireLoopOverlap(_tailLen, _ctx, _ta)
                } else {
                    suppressSeekRestart = true
                    mainAudioEl.currentTime = mp.start
                    setTimeout(() => { suppressSeekRestart = false }, 50)
                }
                return
            }

            const ctx = sharedAudioCtx
            const ta  = triggerAudio.get(index)

            if (ctx && ta?.decodedBuffer && activeSource && playbackGain) {
                // ── AudioBufferSourceNode loop restart (non-loopEnabled, e.g. managed loop) ──
                let transitionTime
                if (activeSourceStartedAt !== null && activeSourceStartOffset !== null) {
                    transitionTime = activeSourceStartedAt + (effEnd - activeSourceStartOffset)
                } else {
                    transitionTime = ctx.currentTime + Math.max(0, effEnd - mainAudioEl.currentTime)
                }
                transitionTime = Math.max(ctx.currentTime, transitionTime)
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                stopSource(transitionTime)
                const src = ctx.createBufferSource()
                src.buffer = ta.decodedBuffer
                src.connect(playbackGain)
                src.start(transitionTime, mp.start)
                activeSource = src
                activeSourceStartedAt   = transitionTime
                activeSourceStartOffset = mp.start
                src.addEventListener('ended', () => { if (activeSource === src) activeSource = null })

                gaplessActive = true
                setTimeout(() => {
                    suppressSeekRestart = true
                    mainAudioEl.currentTime = mp.start
                    gaplessActive = false
                    setTimeout(() => { suppressSeekRestart = false }, 50)
                }, msToTransition)

            } else {
                mainAudioEl.currentTime = mp.start
            }
        }

        // ── Multi-file sequence transition ──────────────────────────────────────────────
        // Called when the current seq slot reaches its effTransition boundary.
        // Handles both slot 0 (primary closure) and slots 1..N (minimal closures).
        function fireSeqNext() {
            const seqData = triggerSeqSlots.get(index)
            if (!seqData || seqData.total <= 1 || seqData.transitionInProgress) return
            // Primary slot active: use normal outro path (ws.isPlaying() = true there)
            if (loopOutroPending.has(index) && seqData.idx === 0) { fireLoopOutro(); return }

            const curSlotIdx  = seqData.idx
            const nextSlotIdx = (curSlotIdx + 1) % seqData.total
            const nextSlot    = seqData.slots[nextSlotIdx]

            const ctx = sharedAudioCtx
            if (!ctx) return

            if (nextSlotIdx !== 0 && !nextSlot?.decodedBuffer) {
                preDecodeSeqSlots(index)
                return
            }

            seqData.transitionInProgress = true
            clearTimeout(seqData.boundaryTimer); seqData.boundaryTimer = null

            const nextNs  = nextSlotIdx === 0 ? (mp.start ?? 0) : (nextSlot?.mp.start ?? 0)

            if (curSlotIdx === 0) {
                // ── Primary slot → next slot (primary src.loop=true → manual single-play) ──
                if (!activeSource) { seqData.transitionInProgress = false; return }
                const ta_        = triggerAudio.get(index)
                const sr         = ctx.sampleRate
                const outroAt    = mp.fading_point ?? 0
                const clipEnd_   = mp.end ?? (ta_?.decodedBuffer?.duration ?? ws.getDuration())
                const loopStart  = mp.start ?? 0
                const loopEnd    = outroAt > 0 ? outroAt : clipEnd_
                const tailLen    = outroAt > 0 ? clipEnd_ - outroAt : 0
                const loopEndSamp  = Math.round(loopEnd * sr)
                const loopStartSamp = Math.round(loopStart * sr)
                const loopDurSamp  = Math.max(1, loopEndSamp - loopStartSamp)
                const startOffSamp = Math.round(activeSourceStartOffset * sr)
                const firstBound   = activeSourceStartedAt + (loopEndSamp - startOffSamp) / sr
                const n = Math.max(0, Math.ceil((ctx.currentTime - firstBound) * sr / loopDurSamp))
                let transitionTime = firstBound + n * loopDurSamp / sr
                if (transitionTime - ctx.currentTime > (loopEnd - loopStart) * 0.5) {
                    transitionTime = ctx.currentTime
                }
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                if (outroAt > 0) {
                    if (activeSource) activeSource.loop = false
                } else {
                    stopSource(transitionTime)
                    setTimeout(() => {
                        suppressPauseStop = true
                        mainAudioEl.loop = false
                        mainAudioEl.pause()
                        setTimeout(() => { suppressPauseStop = false }, 0)
                    }, Math.max(0, msToTransition - 15))
                }

                nextSlot.startGaplessSource(nextNs, transitionTime)

                const tailMs = tailLen * 1000
                gaplessActive = true
                clearTimeout(loopJumpTimer); loopJumpTimer = null

                // At boundary: stop A cursor, show ghost tail, hand cursor to next slot
                setTimeout(() => {
                    if (outroAt > 0) {
                        suppressPauseStop = true
                        mainAudioEl.loop = false
                        mainAudioEl.pause()
                        setTimeout(() => { suppressPauseStop = false }, 0)
                        // Ghost cursor slides from effTransition to mp.end over tailLen seconds
                        const _dur = ws.getDuration()
                        if (_dur > 0) {
                            if (activeTailCurEl) { activeTailCurEl.remove(); activeTailCurEl = null }
                            const tailCurEl = document.createElement('div')
                            tailCurEl.classList.add('ws-tail-cursor')
                            tailCurEl.style.left = getX(loopEnd) + 'px'
                            overlay.appendChild(tailCurEl)
                            activeTailCurEl = tailCurEl
                            requestAnimationFrame(() => { requestAnimationFrame(() => {
                                tailCurEl.style.transitionDuration = tailLen + 's'
                                tailCurEl.style.left = getX(loopEnd + tailLen) + 'px'
                            }) })
                            setTimeout(() => { if (activeTailCurEl === tailCurEl) { activeTailCurEl = null } tailCurEl.remove() }, tailLen * 1000 + 150)
                        }
                    }
                    seqData.idx = nextSlotIdx
                    seqData.transitionInProgress = false
                    seqData.slots[0]?.setActive?.(false)
                    nextSlot.setActive?.(true)
                    nextSlot.startCursor(nextNs, 0)
                    armSeqBoundaryTimer(nextSlotIdx)
                }, Math.max(0, msToTransition))
                // After tail: reset primary cursor and clear gapless flag.
                // Guard: skip media reset if seqData.idx moved on (wrap-back already happened)
                // OR if a new transition is already in progress (wrap-back fired between
                // startGaplessSource and its own timeout — seqData.idx not yet updated).
                setTimeout(() => {
                    preSeekArmed = false
                    gaplessActive = false
                    if (seqData.idx !== nextSlotIdx || seqData.transitionInProgress) return
                    suppressPauseStop = true
                    mainAudioEl.loop = false
                    mainAudioEl.pause()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                    mainAudioEl.currentTime = mp.start ?? 0
                }, msToTransition + 10 + tailMs)

            } else {
                // ── Non-primary slot → next slot ──────────────────────────────────────────
                const curSlot  = seqData.slots[curSlotIdx]
                const { src: curSrc, startedAt, startOffset } = curSlot.getActiveSourceInfo()
                const curMp    = curSlot.mp
                const effEnd   = curMp.end ?? curSlot.decodedBuffer?.duration ?? 0
                const outroAt  = curMp.fading_point ?? 0
                const outroLen = outroAt > 0 ? effEnd - outroAt : 0
                const effTrans = outroAt > 0 ? outroAt : effEnd

                let transitionTime
                if (curSrc && startedAt !== null && startOffset !== null) {
                    transitionTime = startedAt + (effTrans - startOffset)
                } else {
                    transitionTime = ctx.currentTime
                }
                transitionTime = Math.max(ctx.currentTime, transitionTime)
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                // Finish triggered while this non-primary slot is active: fire outro inline
                if (loopOutroPending.has(index)) {
                    const outroIdx = loopOutroPending.get(index)
                    loopOutroPending.delete(index)
                    loopOutroInitialRemaining.delete(index)
                    setOutroPendingIndicator(outroIdx, false)

                    const nextTa = triggerAudio.get(outroIdx)
                    if (!nextTa) { seqData.transitionInProgress = false; return }

                    // Let tail play if outroLen > 0; otherwise stop source at boundary
                    if (!outroLen && curSrc) curSlot.stopSourceAt(transitionTime)

                    // Start Finish audio at boundary
                    const vol    = nextTa.mp?.volume ?? 0.8
                    const fadein = nextTa.mp?.fadein ?? 0
                    const ns     = nextTa.mp?.start  ?? 0
                    cancelWsFade(nextTa.ws)
                    nextTa.setCurrentVolume(vol)
                    const nextPg = nextTa.getPlaybackGain?.()
                    if (nextPg) nextPg.gain.value = fadein > 0 ? 0 : vol
                    nextTa.startGaplessSource(ns, transitionTime)

                    const tailMs = outroLen * 1000
                    gaplessActive = true

                    setTimeout(() => {
                        visuallyDone = true
                        if (outroLen > 0) curSlot.startTailCursor(effTrans, outroLen)
                        curSlot.pauseCursor()
                        curSlot.setActive?.(false)
                        seqData.idx = 0
                        seqData.transitionInProgress = false
                        nextTa.startCursor(ns, 0)
                    }, Math.max(0, msToTransition))
                    setTimeout(() => {
                        gaplessActive = false
                        mainAudioEl.currentTime = mp.start ?? 0
                        curSlot.resetCursor()
                    }, msToTransition + 10 + tailMs)

                    currentCue = outroIdx
                    markTriggers(outroIdx)
                    _nonAudioActions(outroIdx, nextTa)
                    return
                }

                if (outroLen > 0 && curSrc) {
                    curSrc.loop = false
                } else if (curSrc) {
                    curSlot.stopSourceAt(transitionTime)
                }

                if (nextSlotIdx === 0) {
                    // Wrap back to primary: start primary source, then start primary cursor
                    const ta_ = triggerAudio.get(index)
                    ta_?.startGaplessSource(nextNs, transitionTime)
                } else {
                    nextSlot.startGaplessSource(nextNs, transitionTime)
                }

                // At boundary: hand cursor to next slot immediately
                setTimeout(() => {
                    if (outroLen > 0) curSlot.startTailCursor(effTrans, outroLen)
                    curSlot.pauseCursor()
                    curSlot.setActive?.(false)
                    seqData.idx = nextSlotIdx
                    seqData.transitionInProgress = false

                    if (nextSlotIdx === 0) {
                        // Wrap back to primary: start primary cursor now
                        seqData.slots[0]?.setActive?.(true)
                        suppressSeekRestart = true
                        mainAudioEl.currentTime = nextNs
                        setTimeout(() => { suppressSeekRestart = false }, 50)
                        // Guard ws.on("play") from starting a duplicate source.
                        // gaplessSwitchActive tells the play handler the source was
                        // already started by startGaplessSource — skip startSource().
                        const _ta_wb = triggerAudio.get(index)
                        if (_ta_wb) _ta_wb.gaplessSwitchActive = true
                        mainAudioEl.play().catch(() => {})
                    } else {
                        nextSlot.setActive?.(true)
                        nextSlot.startCursor(nextNs, 0)
                        armSeqBoundaryTimer(nextSlotIdx)
                    }
                }, Math.max(0, msToTransition))
                // After tail: reset cursor to start so waveform goes gray (matches primary behaviour)
                if (outroLen > 0) {
                    setTimeout(() => curSlot.resetCursor(), Math.max(0, msToTransition) + outroLen * 1000 + 150)
                }
            }
        }

        // Schedules the boundary timer for a non-primary seq slot.
        // When it fires, calls fireSeqNext() if we're still on that slot.
        function armSeqBoundaryTimer(slotIdx) {
            const seqData = triggerSeqSlots.get(index)
            if (!seqData || slotIdx === 0 || slotIdx >= seqData.total) return
            const slot = seqData.slots[slotIdx]
            if (!slot || !sharedAudioCtx) return

            const { src: slotSrc, startedAt, startOffset } = slot.getActiveSourceInfo()
            if (!slotSrc || startedAt === null || startOffset === null) return

            const effEnd   = slot.mp.end ?? slot.decodedBuffer?.duration ?? 0
            const outroAt  = slot.mp.fading_point ?? 0
            const effTrans = outroAt > 0 ? outroAt : effEnd
            const transitionTime = startedAt + (effTrans - startOffset)
            const msToFire = Math.max(0, (transitionTime - sharedAudioCtx.currentTime) * 1000 - 50)

            clearTimeout(seqData.boundaryTimer)
            seqData.boundaryTimer = setTimeout(() => {
                seqData.boundaryTimer = null
                if (seqData.idx === slotIdx && !seqData.transitionInProgress) fireSeqNext()
            }, msToFire)
        }

        ws.on("timeupdate", (ct) => {
            const effEnd        = mp.end ?? ws.getDuration()
            const effTransition = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) : effEnd
            if (ct >= effTransition) {
                if (gaplessActive) { ws.setVolume(currentVolume); return }
                const isManaged = !!triggerYamls[index]?.loop_outro
                if (isManaged) {
                    if (loopOutroPending.has(index)) {
                        fireLoopOutro()   // fallback if timer missed
                    } else {
                        fireLoopRestart(effTransition)
                    }
                } else if (loopEnabled) {
                    fireLoopRestart(effTransition)
                } else {
                    const chainEnd = triggerYamls[index]?.chain_end
                    if (chainEnd && !chainEndArmed) {
                        const nextIdx = findTriggerByNote(chainEnd)
                        if (nextIdx !== null) {
                            fireChainEnd(nextIdx)
                        } else {
                            wsStopAndReset()
                            if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                        }
                    } else if (!chainEnd) {
                        wsStopAndReset()
                        if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    }
                }
                ws.setVolume(currentVolume); return
            }
            // Pre-seek next audio and schedule gapless transition via setTimeout
            // (fires at the precise end time instead of waiting for next timeupdate)
            if (!preSeekArmed) {
                // effTransition = musical boundary (absolute position from clip start)
                const outroLen      = mp.fading_point ?? 0
                const effTransition = outroLen > 0 ? outroLen : effEnd
                const chainEnd = triggerYamls[index]?.chain_end
                if (chainEnd && effTransition - ct < 0.35) {
                    preSeekArmed = true
                    const nextIdx = findTriggerByNote(chainEnd)
                    const nextTa  = nextIdx !== null ? triggerAudio.get(nextIdx) : null
                    if (nextTa) {
                        const ns = nextTa.mp?.start ?? 0
                        nextTa.mainAudioEl.currentTime = ns
                        clearTimeout(chainEndTimer)
                        chainEndTimer = setTimeout(() => {
                            chainEndTimer = null
                            fireChainEnd(nextIdx)
                        }, Math.max(0, (effTransition - ct) * 1000 - 50))
                    }
                }
                if (!chainEnd) {
                    const loopOutro = triggerYamls[index]?.loop_outro
                    const isManaged = !!loopOutro
                    if (isManaged && effTransition - ct < 0.35) {
                        preSeekArmed = true
                        if (loopOutroPending.has(index)) {
                            // Outro armed: pre-seek outro and schedule its start
                            const outroIdx = findTriggerByNote(loopOutro)
                            const outroTa  = outroIdx !== null ? triggerAudio.get(outroIdx) : null
                            if (outroTa) {
                                const ns = outroTa.mp?.start ?? 0
                                outroTa.mainAudioEl.currentTime = ns
                                clearTimeout(loopJumpTimer)
                                loopJumpTimer = setTimeout(() => {
                                    loopJumpTimer = null
                                    fireLoopOutro()
                                }, Math.max(0, (effTransition - ct) * 1000 - 50))
                            }
                        } else {
                            // No outro: schedule gapless loop restart at musical boundary
                            preDecodeForGapless(index)
                            clearTimeout(loopJumpTimer)
                            loopJumpTimer = setTimeout(() => {
                                loopJumpTimer = null
                                fireLoopRestart(effTransition)
                            }, Math.max(0, (effTransition - ct) * 1000 - 5))
                        }
                    } else if (loopEnabled && effTransition - ct < 0.35) {
                        preSeekArmed = true
                        preDecodeForGapless(index)
                        clearTimeout(loopJumpTimer)
                        loopJumpTimer = setTimeout(() => {
                            loopJumpTimer = null
                            fireLoopRestart(effTransition)
                        }, Math.max(0, (effTransition - ct) * 1000 - 5))
                    }
                }
            }
            let f = 1
            const t = ct - mp.start
            if (mp.fadein  > 0 && t >= 0 && t < mp.fadein)            f = t / mp.fadein
            if (mp.fadeout > 0 && (effEnd - ct) < mp.fadeout) f = Math.min(f, (effEnd - ct) / mp.fadeout)
            ws.setVolume(Math.max(0, currentVolume * f))
        })

        ws.on("error",  () => {
            // Ignore errors from destroyed/replaced instances (e.g. aborted fetch during rerender)
            if (triggerAudio.get(index)?.ws !== ws) return
            if (!audioWarnings.some(w => w.file === musicFile)) {
                audioWarnings.push({ file: musicFile, cueNum: index })
                showParseErrors()
            }
        })
        ws.on("play",   () => {
            // If a gapless transition is in progress, a cursor restart (e.g. mainAudioEl.loop=true
            // looping back after stopSource cleared activeSource) must not start a new source or
            // clear timers — the transition's setTimeout owns state until gaplessActive=false.
            // Show the amber active-slot indicator on the primary slot whenever it starts playing.
            const _sdPlay = triggerSeqSlots.get(index)
            if (_sdPlay && _sdPlay.idx === 0) _sdPlay.slots[0]?.setActive?.(true)
            if (gaplessActive) return
            pauseBtn.textContent = "⏸"
            chainEndArmed = false
            preSeekArmed  = false
            gaplessActive = false
            clearTimeout(chainEndTimer);  chainEndTimer  = null
            clearTimeout(loopJumpTimer);  loopJumpTimer  = null
            const ta = triggerAudio.get(index)
            if (ta?.gaplessSwitchActive) {
                // Source already started by gapless transition — just clear the flag
                ta.gaplessSwitchActive = false
                return
            }
            // Don't start a new source if one is already running (e.g. media-element cursor restart)
            if (activeSource) return
            if (sharedAudioCtx) startSource(mainAudioEl.currentTime, sharedAudioCtx.currentTime)
            // Schedule chain_end timer immediately from AudioContext time — bypasses timeupdate
            // frequency dependency and ensures ≥50ms of WebAudio scheduling headroom.
            const chainEndNote = triggerYamls[index]?.chain_end
            if (chainEndNote && activeSourceStartedAt !== null && activeSourceStartOffset !== null && !chainEndArmed) {
                const effEnd_ = mp.end ?? ws.getDuration()
                const tTime   = activeSourceStartedAt + (effEnd_ - activeSourceStartOffset)
                const msTT    = Math.max(0, (tTime - sharedAudioCtx.currentTime) * 1000)
                if (msTT > 50) {
                    const nextIdx_ = findTriggerByNote(chainEndNote)
                    if (nextIdx_ !== null) {
                        clearTimeout(chainEndTimer)
                        chainEndTimer = setTimeout(() => {
                            chainEndTimer = null
                            fireChainEnd(nextIdx_)
                        }, msTT - 50)
                    }
                }
            }
        })
        ws.on("pause",  () => {
            pauseBtn.textContent = "⏵"
            if (!suppressPauseStop) {
                // For group triggers: the cursor media element plays to file end (past mp.end)
                // and the browser fires a natural "pause" when it reaches "ended" state.
                // Don't kill the AudioBufferSourceNode loop source for that — it has already
                // looped back correctly at mp.end and must keep running.
                if (loopGroups.has(index) && mainAudioEl.ended) return
                stopSource()
            }
        })
        ws.on("finish", () => {
            pauseBtn.textContent = "⏵"
            // Group triggers keep mainAudioEl.loop=false on purpose, so "finish" does fire.
            // gaplessActive is set synchronously in fireGaplessTransition (before any events),
            // so it reliably marks an outro/chain transition in progress.
            // Don't loop the cursor then — the transition's setTimeout handles cursor handoff.
            if (loopGroups.has(index)) {
                if (gaplessActive) return
                // If outro is armed, fire transition directly — calling ws.play() would trigger
                // ws.on("play") which clears loopJumpTimer, causing a one-iteration delay.
                if (loopOutroPending.has(index)) {
                    const outroIdx = loopOutroPending.get(index)
                    loopOutroPending.delete(index)
                    loopOutroInitialRemaining.delete(index)
                    setOutroPendingIndicator(outroIdx, false)
                    clearTimeout(loopJumpTimer); loopJumpTimer = null
                    currentCue = outroIdx
                    markTriggers(outroIdx)
                    fireGaplessTransition(outroIdx)
                    return
                }
                suppressPauseStop = true   // prevent pause (fired after ended in some browsers) from killing the loop source
                suppressSeekRestart = true
                mainAudioEl.currentTime = mp.start ?? 0
                ws.play()  // restart cursor; ws.on("play") guard prevents double source
                setTimeout(() => { suppressSeekRestart = false; suppressPauseStop = false }, 50)
                return
            }
            // Plain loopEnabled sources use mainAudioEl.loop=true so this shouldn't fire.
            // Safeguard: reset cursor without calling play().
            if (activeSource && loopEnabled) {
                suppressSeekRestart = true
                mainAudioEl.currentTime = mp.start ?? 0
                mainAudioEl.loop = true
                setTimeout(() => { suppressSeekRestart = false }, 50)
                return
            }
            // Fire chain_end transition now if finish fired before chainEndTimer (race condition).
            // Must happen before stopSource() so activeSourceStartedAt is still valid for timing.
            const chainEnd = triggerYamls[index]?.chain_end
            if (chainEnd && chainEndTimer !== null && !chainEndArmed) {
                clearTimeout(chainEndTimer); chainEndTimer = null
                chainEndArmed = true
                const nextIdx = findTriggerByNote(chainEnd)
                if (nextIdx !== null) {
                    currentCue = nextIdx
                    markTriggers(nextIdx)
                    scrollToTrigger(nextIdx)
                    fireGaplessTransition(nextIdx)
                }
            }
            stopSource()
            ws.setVolume(currentVolume)
            if (!mp.loop && mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
            wsStopAndReset()
        })
        ws.on("seeking", (t) => {
            if (suppressSeekRestart || gaplessActive || mainAudioEl.paused) return
            // AudioBufferSourceNode loops internally; cursor seek must not restart the source.
            // Only restart on explicit user scrub (scrubbingSet tracks drag state).
            if ((loopEnabled || loopGroups.has(index)) && activeSource && !scrubbingSet.has(index)) return
            if (sharedAudioCtx) startSource(t, sharedAudioCtx.currentTime)
        })

        // ws.stop() is overridden above to reset to mp.start instead of file position 0.
        function wsStopAndReset() {
            if (activeTailCurEl) { activeTailCurEl.remove(); activeTailCurEl = null }
            tailEndTime = null
            const seqData_ = triggerSeqSlots.get(index)
            if (seqData_) {
                if (seqData_.idx > 0) {
                    const activeSlot = seqData_.slots[seqData_.idx]
                    if (activeSlot) { activeSlot.stopSourceAt(); activeSlot.pauseCursor(); activeSlot.resetCursor(); activeSlot.setActive?.(false) }
                    seqData_.idx = 0
                    seqData_.transitionInProgress = false
                    clearTimeout(seqData_.boundaryTimer); seqData_.boundaryTimer = null
                }
                // Clear ghost cursors on ALL non-primary slots — a slot's tail cursor may
                // still be running even after it already handed playback back to the primary.
                for (let si = 1; si < seqData_.total; si++) seqData_.slots[si]?.clearTailCursor?.()
                // Remove active-slot indicator so waveform is visually idle after stop.
                seqData_.slots[0]?.setActive?.(false)
            }
            ws.stop()
        }

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
            loopEnabled = mp.loop
            mainAudioEl.loop = mp.loop
            if (activeSource) activeSource.loop = mp.loop
            loopBtn.classList.toggle("waveform-btn-active", mp.loop)
            updateLoopBtnWavWarning()
            debouncedSave()
        })
        pauseBtn.addEventListener("click", () => {
            if (ws.isPlaying()) {
                ws.pause()
            } else {
                const cur = mainAudioEl.currentTime
                // Play from mp.start only if cursor is still at position 0 (untouched).
                // If the user moved the playhead anywhere else — inside or outside the
                // start/end region — honour that position and use the full buffer.
                if (cur >= 0.001) forceFullBuffer = true
                ws.play(cur < 0.001 ? (mp.start ?? 0) : cur)
            }
        })
        stopBtn.addEventListener("click",  () => {
            wsStopAndReset()
            ws.setVolume(currentVolume)
            if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
        })
        zoomOutBtn.addEventListener("click", () => {
            const dur = ws.getDuration()
            const cw  = waveformContainer.clientWidth
            // Keep viewport center stable: compute center time before zoom
            const centerSec = dur ? (ws.getScroll() + cw / 2) / totalWaveWidth() * dur : 0
            // Don't go below the natural fit-to-width zoom so one press is always effective
            const minZoom = dur ? Math.max(10, Math.ceil(cw / dur)) : 10
            state.zoom = Math.max(minZoom, state.zoom / 2)
            ws.zoom(state.zoom)
            if (dur) requestAnimationFrame(() => {
                ws.setScroll(Math.max(0, centerSec / dur * totalWaveWidth() - cw / 2))
                updateMarkers()
            })
            else updateMarkers()
        })
        zoomInBtn.addEventListener("click", () => {
            const dur = ws.getDuration()
            const cw  = waveformContainer.clientWidth
            const centerSec = dur ? (ws.getScroll() + cw / 2) / totalWaveWidth() * dur : 0
            // First + press should always produce a visible change: start from actual px/s
            const actualZoom = dur ? Math.max(state.zoom, totalWaveWidth() / dur) : state.zoom
            state.zoom = Math.min(400, actualZoom * 2)
            ws.zoom(state.zoom)
            if (dur) requestAnimationFrame(() => {
                ws.setScroll(Math.max(0, centerSec / dur * totalWaveWidth() - cw / 2))
                updateMarkers()
            })
            else updateMarkers()
        })

        waveformContainer.addEventListener("mousemove", (e) => {
            const dur = ws.getDuration()
            if (!dur) { waveformContainer.style.cursor = ""; return }
            const rect = waveformContainer.getBoundingClientRect()
            const playheadX = (ws.getCurrentTime() / dur) * totalWaveWidth() - ws.getScroll()
            waveformContainer.style.cursor = Math.abs(e.clientX - rect.left - playheadX) < 10 ? "crosshair" : ""
        })
        waveformContainer.addEventListener("mouseleave", () => { waveformContainer.style.cursor = "" })

        // l / r while paused: set start / end point to current cursor position
        waveformContainer.setAttribute("tabindex", "-1")
        waveformContainer.addEventListener("keydown", (e) => {
            if (e.key !== "l" && e.key !== "r") return
            if (ws.isPlaying()) return
            const dur = ws.getDuration()
            if (!dur) return
            const ct = mainAudioEl.currentTime
            const regionStart = mp.start ?? 0
            const regionEnd   = mp.end   ?? dur
            // Ignore if cursor is sitting exactly at start or end (nothing to do)
            if (Math.abs(ct - regionStart) < 0.001 || Math.abs(ct - regionEnd) < 0.001) return
            if (e.key === "l") {
                mp.start = Math.min(Math.max(0, parseFloat(ct.toFixed(3))), regionEnd - 0.05)
                mp.fadein = Math.max(0, Math.min(mp.fadein, (mp.end ?? dur) - mp.start))
            } else {
                const ne = parseFloat(ct.toFixed(3))
                mp.end    = (dur - ne < 0.05) ? null : Math.max(mp.start + 0.05, ne)
                mp.fadeout = Math.max(0, Math.min(mp.fadeout, (mp.end ?? dur) - mp.start))
            }
            updateMarkers()
            debouncedSave()
        })

        waveformContainer.addEventListener("mousedown", (e) => {
            e.stopPropagation()
            waveformContainer.focus({ preventScroll: true })
            let dragging = false
            const startX = e.clientX
            const onMove = (me) => {
                if (!dragging && Math.abs(me.clientX - startX) > 3) {
                    dragging = true
                    scrubbingSet.add(index)
                }
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
                if (dragging) {
                    scrubbingSet.delete(index)
                    // If audio was playing during scrub, fire the last past auto-trigger (no scroll)
                    if (!mainAudioEl.paused) {
                        const atSetup = autoTriggerSetup.get(index)
                        if (atSetup) {
                            const past = atSetup.getUnfiredPast(mainAudioEl.currentTime)
                            if (past.length > 0) {
                                atSetup.markFired(past[0].targetIdx)
                                currentCue = past[0].targetIdx
                                markTriggers(past[0].targetIdx)
                                pendingAutoTrigger = true
                                triggerAction(past[0].targetIdx)
                            }
                        }
                    }
                } else if (liveViewOpen) {
                    setArmedCue(index)
                    broadcastLiveState()
                } else {
                    currentCue = index; markTriggers(index); triggerAction(index)
                }
            }
            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })

        const monitorFile = sanitizeAudioPath(typeof codeblockYaml.music === 'object' ? codeblockYaml.music.monitor ?? null : null)

        // ── Common patches ────────────────────────────────────────────────
        const _wsSetVol = ws.setVolume.bind(ws)
        ws.setVolume = (v) => {
            _wsSetVol(v)
            const ta_ = triggerAudio.get(index)
            const targetGain = ta_?.playbackGainOverride ?? playbackGain
            if (targetGain) targetGain.gain.value = v
        }
        ws.stop = () => {
            stopSource()
            mainAudioEl.loop = false
            // Never call the original ws.stop(): it calls setTime(0) → scrollIntoView(0).
            // Instead, pause and reset to the user's startpoint.
            const s = mp.start ?? 0
            mainAudioEl.pause()
            mainAudioEl.currentTime = s
            requestAnimationFrame(() => ws.setScrollTime(s))
        }

        triggerAudio.set(index, {
            ws, mainAudioEl, monitorFile, musicFile, overlay, getX, autoMarkerState, mp,
            stopAndReset: () => wsStopAndReset(),
            fadeOutActiveSeqSlot: (durationSec) => {
                const sd = triggerSeqSlots.get(index)
                if (sd && sd.idx > 0) sd.slots[sd.idx]?.fadeOut?.(durationSec)
            },
            getTimeAtClientX: (clientX) => {
                const rect = waveformContainer.getBoundingClientRect()
                const tw = totalWaveWidth(), dur = ws.getDuration()
                if (!tw || !dur) return null
                return Math.max(0, Math.min(dur, (ws.getScroll() + clientX - rect.left) / tw * dur))
            },
            mainAudioCtxGain,
            decodedBuffer: null, _decoding: false,
            gaplessSwitchActive: false,  // suppresses new source start in ws.on("play") during transition
            getCurrentVolume: () => currentVolume,
            setCurrentVolume: (v) => { currentVolume = v },
            disableLoop: () => { loopEnabled = false },
            enableLoop:  () => { loopEnabled = mp.loop },
            // Called by another trigger's fireGaplessTransition to start this trigger's source
            getPlaybackGain:    () => playbackGain,
            stopActiveSource:   () => stopSource(),
            getActiveSourceInfo: () => ({ src: activeSource, startedAt: activeSourceStartedAt, startOffset: activeSourceStartOffset }),
            // True as long as the AudioBufferSourceNode is running, even if WaveSurfer's
            // media element isn't playing yet (e.g. during the adoption cursor-sync gap).
            isAudioActive: () => !visuallyDone && (activeSource !== null || ws.isPlaying() || (triggerSeqSlots.get(index)?.idx ?? 0) > 0),
            // Returns playback position from AudioContext arithmetic when mainAudioEl lags.
            getPlaybackTime: () => {
                if (activeSource && activeSourceStartedAt !== null && sharedAudioCtx)
                    return Math.max(0, activeSourceStartOffset + (sharedAudioCtx.currentTime - activeSourceStartedAt))
                return mainAudioEl?.currentTime ?? 0
            },
            getTailInfo: () => {
                if (!sharedAudioCtx || tailEndTime === null) return { active: false, remaining: 0 }
                const remaining = Math.max(0, tailEndTime - sharedAudioCtx.currentTime)
                return { active: remaining > 0, remaining }
            },
            // Starts the AudioBufferSourceNode only — no mainAudioEl interaction.
            // The caller is responsible for all cursor/media element handling.
            startGaplessSource: (offset, when) => {
                if (!sharedAudioCtx || !playbackGain) return false
                const ta_ = triggerAudio.get(index)
                if (!ta_?.decodedBuffer) return false
                if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 0
                tryBuildLoopGroups()
                stopSource()
                const src = sharedAudioCtx.createBufferSource()
                const loopGroup    = loopGroups.get(index)
                const actualOffset = Math.max(0, offset)
                const regionStart  = mp.start ?? 0

                if (loopGroup && mp.end != null && !isFullFile(ta_.decodedBuffer, mp.start, mp.end)) {
                    const loopBuf  = sliceBuffer(ta_.decodedBuffer, regionStart, mp.end, sharedAudioCtx)
                    src.buffer     = loopBuf
                    src.loop       = true
                    src.loopStart  = 0
                    src.loopEnd    = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) - regionStart : loopBuf.duration
                    src.connect(playbackGain)
                    const regionOff = Math.max(0, Math.min(actualOffset - regionStart, loopBuf.duration))
                    src.start(when, regionOff)
                    activeSource            = src
                    activeSourceStartedAt   = when
                    activeSourceStartOffset = actualOffset  // original-file coords for armOutroTimer
                    loopGroup.loopVirtualStartTime = when - (actualOffset - regionStart)
                    mainAudioEl.loop = true  // cursor managed by fireLoopRestart timer (matches original startGaplessSource behaviour)
                } else {
                    src.buffer = ta_.decodedBuffer
                    const isLoopTrigger = loopGroup || loopEnabled
                    if (isLoopTrigger) {
                        src.loop      = true
                        src.loopStart = regionStart
                        src.loopEnd   = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) : (mp.end ?? ta_.decodedBuffer.duration)
                    }
                    src.connect(playbackGain)
                    src.start(when, actualOffset)
                    activeSource            = src
                    activeSourceStartedAt   = when
                    activeSourceStartOffset = actualOffset
                    if (loopGroup) {
                        loopGroup.loopVirtualStartTime = when - (actualOffset - regionStart)
                    }
                    if (loopGroup || loopEnabled) mainAudioEl.loop = true
                }
                src.addEventListener('ended', () => { if (activeSource === src) activeSource = null })

                return true
            },
            // Schedules loopJumpTimer to fire 50ms before the next loop boundary.
            // Called when outro is armed so the timer is set immediately rather than waiting
            // for a timeupdate event to enter the 350ms pre-seek window.
            armOutroTimer: () => {
                const ctx = sharedAudioCtx
                if (!ctx || !loopGroups.has(index) || !activeSource || activeSourceStartedAt === null) return
                const sr = ctx.sampleRate
                const loopStartSec     = mp.start ?? 0
                const loopEndSec       = (mp.fading_point ?? 0) > 0 ? (mp.fading_point ?? 0) : (mp.end ?? (triggerAudio.get(index)?.decodedBuffer?.duration ?? ws.getDuration()))
                const loopEndSamples   = Math.round(loopEndSec * sr)
                const loopStartSamples = Math.round(loopStartSec * sr)
                const loopDurSamples   = loopEndSamples - loopStartSamples
                if (loopDurSamples <= 0) return
                const startOffSamples   = Math.round(activeSourceStartOffset * sr)
                const firstBoundaryTime = activeSourceStartedAt + (loopEndSamples - startOffSamples) / sr
                const n = Math.max(0, Math.ceil((ctx.currentTime - firstBoundaryTime) * sr / loopDurSamples))
                const transitionTime    = firstBoundaryTime + n * loopDurSamples / sr
                const msToTransition    = Math.max(0, (transitionTime - ctx.currentTime) * 1000)
                clearTimeout(loopJumpTimer)
                loopJumpTimer = setTimeout(() => {
                    loopJumpTimer = null
                    if (loopOutroPending.has(index)) fireLoopOutro()
                }, Math.max(0, msToTransition - 50))
            },
            // Starts the cursor (mainAudioEl) at offset, after delayMs, without starting a new source.
            startCursor: (offset, delayMs) => {
                const actualOffset = Math.max(0, offset)
                setTimeout(() => {
                    suppressSeekRestart = true
                    mainAudioEl.currentTime = actualOffset
                    setTimeout(() => { suppressSeekRestart = false }, 50)
                    // Play without triggering startSource — activeSource guard in ws.on("play") handles this.
                    mainAudioEl.play().catch(() => {})
                }, Math.max(0, delayMs))
            },
        })
        fileToTriggers.set(musicFile, [...(fileToTriggers.get(musicFile) || []), index])

        // Finish adoption: inject the decoded buffer and sync the cursor element to the
        // current playback position so the UI reflects the running source.
        if (_adoption) {
            const ta = triggerAudio.get(index)
            if (ta && _adoption.decodedBuffer) ta.decodedBuffer = _adoption.decodedBuffer
            if (_adoption.activeSource && _adoption.activeSourceStartedAt !== null) {
                const syncCursor = () => {
                    if (activeSource !== _adoption.activeSource) return
                    const ctx = sharedAudioCtx
                    if (!ctx) return
                    const pos = Math.max(0, Math.min(
                        ws.getDuration() || Infinity,
                        _adoption.activeSourceStartOffset + (ctx.currentTime - _adoption.activeSourceStartedAt)
                    ))
                    mainAudioEl.loop = mp.loop
                    suppressSeekRestart = true
                    mainAudioEl.currentTime = pos
                    setTimeout(() => { suppressSeekRestart = false }, 50)
                    mainAudioEl.play().catch(() => {})
                }
                if (ws.getDuration()) syncCursor()
                else ws.once('ready', syncCursor)
            }
        }

        // ── Multi-file sequence slot rendering (SLF Loop with music_seq) ──────────────
        const musicSeqArr = codeblockYaml.music_seq
        if (Array.isArray(musicSeqArr) && musicSeqArr.length > 0 && codeblockYaml.loop_outro) {
            // Wrap the primary waveformWrapper inside a horizontal flex row
            const seqRow = document.createElement('div')
            seqRow.classList.add('seq-slots-row')
            waveformWrapper.parentElement.insertBefore(seqRow, waveformWrapper)
            seqRow.appendChild(waveformWrapper)
            waveformWrapper.classList.add('seq-slot')

            // Label on primary slot
            const label0 = document.createElement('div')
            label0.className = 'seq-slot-label'
            label0.textContent = '1'
            waveformWrapper.insertBefore(label0, waveformWrapper.firstChild)

            const total = 1 + musicSeqArr.length
            // slot 0 = primary — minimal wrapper so setActive() can toggle the CSS class
            const primarySlotProxy = { setActive: (active) => waveformWrapper.classList.toggle('seq-slot-active', active) }
            const slots = [primarySlotProxy]

            for (const [si, seqEntry] of musicSeqArr.entries()) {
                if (!seqEntry?.file) continue
                const slotMp = {
                    volume:    seqEntry.volume    ?? mp.volume,
                    start:     seqEntry.start     ?? 0,
                    end:       seqEntry.end       ?? null,
                    fadein:    seqEntry.fadein     ?? 0,
                    fadeout:   seqEntry.fadeout    ?? 0,
                    fading_point: seqEntry.fading_point  ?? 0,
                }
                slots.push(buildSeqSlot({
                    index, seqSlotIdx: si + 1,
                    musicFile: sanitizeAudioPath(seqEntry.file),
                    monitorFile: sanitizeAudioPath(seqEntry.monitor ?? null),
                    mp: slotMp, parentContainer: seqRow,
                }))
            }

            triggerSeqSlots.set(index, {
                idx: 0, total, slots,
                fireNext: () => fireSeqNext(),
                boundaryTimer: null,
                transitionInProgress: false,
            })
            preDecodeSeqSlots(index)
        }
    }

    triggerYamls[index] = codeblockYaml

    // Now that triggerYamls[index] is set, findTriggerByNote can resolve this trigger →
    // check if it's a non-root SLF member and add a derived TC badge if so
    if (!codeblockYaml.start_tc) {
        const isFinish = loopSourcesOf(index).length > 0
        let isChainTarget = false
        for (let i = 1; i < triggerYamls.length; i++) {
            if (i === index) continue
            if (triggerYamls[i]?.chain_end && findTriggerByNote(triggerYamls[i].chain_end) === index) {
                isChainTarget = true; break
            }
        }
        if (isFinish || isChainTarget) {
            const rootTc = triggerYamls[slfChainRootOf(index)]?.start_tc
            if (rootTc) {
                const tcBadge = document.createElement('span')
                tcBadge.className = 'trigger-tc-badge trigger-tc-badge--derived'
                tcBadge.textContent = `⏱ ↳ ${rootTc}`
                tcBadge.title = 'Timecode abgeleitet vom Start-Cue (Audiodauer lädt…)'
                slfDerivedTcBadges.set(index, tcBadge)
                triggerDiv.appendChild(tcBadge)
            }
        }
    }

    // Capture phase: intercept button/control clicks while locked before their own handlers fire
    triggerDiv.addEventListener("mousedown", (e) => {
        if (showLock && !pickModeCallback && e.target.closest('button, select, input')) {
            e.stopPropagation()
            e.preventDefault()
            showLockHint(e)
        }
    }, true)

    triggerDiv.addEventListener("mousedown", (e) => {
        if (pickModeCallback) {
            e.stopPropagation()
            // In filtered pick mode: ineligible click = accidental, just exit
            if (pickModeEligibilityFn && !pickModeEligibilityFn(index)) {
                exitPickMode()
                return
            }
            const cb = pickModeCallback
            exitPickMode()
            cb(index)
            return
        }
        if (liveViewOpen) {
            // Arm the trigger as next cue — allowed even when locked (body click only;
            // button clicks are already blocked in capture phase above)
            setArmedCue(index)
            const isSibling = !!triggerYamls[index]?.sibling
            const hasNextSibling = !!(triggerYamls[index + 1]?.sibling)
            if (isSibling || hasNextSibling) selectedVariant = index
            broadcastLiveState()
            return
        }
        if (showLock) {
            e.stopPropagation()
            e.preventDefault()
            showLockHint(e)
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
    adjustBtn.textContent = t('btn.adjust')
    adjustBtn.title = t('btn.adjust.title')
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

    // ── Auto-Cue button ──────────────────────────────────────────────────
    const autoBtn = document.createElement('button')
    autoBtn.classList.add('trigger-action-btn', 'trigger-action-btn-auto')
    autoBtn._triggerIndex = index
    autoBtn._hovering = false
    if (codeblockYaml.auto_trigger) autoBtn.classList.add('trigger-action-btn-active')
    autoBtn.textContent = t('btn.autocue')
    autoBtn.title = codeblockYaml.auto_trigger ? t('btn.autocue.title.edit') : t('btn.autocue.title.set')
    autoTriggerBtns.set(index, autoBtn)

    autoBtn.addEventListener('mouseenter', () => { autoBtn._hovering = true;  updateAutoBtnAppearance(autoBtn, index) })
    autoBtn.addEventListener('mouseleave', () => { autoBtn._hovering = false; updateAutoBtnAppearance(autoBtn, index) })
    autoBtn.addEventListener('mousedown', e => e.stopPropagation())
    autoBtn.addEventListener('click', e => {
        e.stopPropagation()
        if (shiftHeld) {
            if (triggerYamls[index]?.auto_trigger) updateAutoTriggerInScript(index, null)
            return
        }
        // Eligibility: has audio + paused + not at start or end
        const isEligible = (idx) => {
            if (idx === index) return false
            const ta = triggerAudio.get(idx)
            if (!ta) return false
            if (!ta.mainAudioEl.paused) return false
            if (!triggerYamls[idx]?.trigger_note) return false
            const el = ta.mainAudioEl
            const srcYaml = triggerYamls[idx]
            const srcStart = (typeof srcYaml?.music === 'object' ? srcYaml.music.start : null) ?? 0
            const srcEnd   = (typeof srcYaml?.music === 'object' ? srcYaml.music.end   : null) ?? ta.ws.getDuration()
            if (Math.abs(el.currentTime - srcStart) < 0.3) return false
            if (el.currentTime >= srcEnd - 0.3) return false
            return true
        }
        // Pick source trigger (only eligible ones highlight), then record its playhead position
        enterPickMode(sourceIdx => {
            const ta = triggerAudio.get(sourceIdx)
            const el = ta.mainAudioEl
            const srcYaml = triggerYamls[sourceIdx]
            const srcStart = (typeof srcYaml?.music === 'object' ? srcYaml.music.start : null) ?? 0
            const srcEnd   = (typeof srcYaml?.music === 'object' ? srcYaml.music.end   : null) ?? ta.ws.getDuration()
            // Abort if at start or end (covered by eligibilityFn for playing; this catches edge positions)
            if (Math.abs(el.currentTime - srcStart) < 0.3) return
            if (el.currentTime >= srcEnd - 0.3) return
            updateAutoTriggerInScript(index, { trigger_note: srcYaml.trigger_note, at: el.currentTime })
        }, isEligible)
    })
    triggerDiv.querySelector('.trigger-actions').appendChild(autoBtn)

    // ── Loop-Gruppe button ───────────────────────────────────────────────
    const loopGrpBtn = document.createElement('button')
    loopGrpBtn.classList.add('trigger-action-btn')
    loopGrpBtn._triggerIndex = index
    loopBtns.set(index, loopGrpBtn)
    updateLoopBtnAppearance(loopGrpBtn, index)

    loopGrpBtn.addEventListener('mouseenter', () => updateLoopBtnAppearance(loopGrpBtn, index))
    loopGrpBtn.addEventListener('mouseleave', () => updateLoopBtnAppearance(loopGrpBtn, index))
    loopGrpBtn.addEventListener('mousedown', e => e.stopPropagation())
    loopGrpBtn.addEventListener('click', e => {
        e.stopPropagation()
        if (shiftHeld) {
            if (triggerYamls[index]?.chain_end) updateLoopGroupInScript(index, 'chain_end', null)
            else if (triggerYamls[index]?.loop_outro) updateLoopGroupInScript(index, 'loop_outro', null)
            return
        }
        showLoopGroupDialog(index, loopGrpBtn)
    })
    triggerDiv.querySelector('.trigger-actions').appendChild(loopGrpBtn)

    // ── Auto-Mic button ──────────────────────────────────────────────────
    const autoMicBtn = document.createElement('button')
    autoMicBtn.classList.add('trigger-action-btn', 'trigger-action-btn-automic')
    autoMicBtn._triggerIndex = index
    autoMicBtns.set(index, autoMicBtn)
    updateAutoMicBtnAppearance(autoMicBtn, index)
    autoMicBtn.addEventListener('mouseenter', () => updateAutoMicBtnAppearance(autoMicBtn, index))
    autoMicBtn.addEventListener('mouseleave', () => updateAutoMicBtnAppearance(autoMicBtn, index))
    autoMicBtn.addEventListener('mousedown', e => {
        e.stopPropagation()
        autoMicBtn._shiftAtMousedown = shiftHeld
    })
    autoMicBtn.addEventListener('click', e => {
        e.stopPropagation()
        const isActive = triggerYamls[index]?.auto_mic
        if (isActive && !autoMicBtn._shiftAtMousedown) return   // deactivate only via Shift+Click
        updateAutoMicInScript(index, !isActive)
    })
    triggerDiv.querySelector('.trigger-actions').appendChild(autoMicBtn)

    // ── Variante button ──────────────────────────────────────────────────
    const copyBtn = document.createElement("button")
    copyBtn.classList.add("trigger-action-btn")
    copyBtn.textContent = t('btn.variant')
    copyBtn.title = t('btn.variant.title')
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

// Enforce HH:MM:SS:FF format on a text input. Allows only digits, auto-inserts
// colons, validates ranges (MM/SS < 60, FF < 25), and marks invalid values.
function installTcMask(input) {
    function digits(val) { return val.replace(/\D/g, '').slice(0, 8) }

    function format(d) {
        let out = ''
        for (let i = 0; i < d.length; i++) {
            if (i === 2 || i === 4 || i === 6) out += ':'
            out += d[i]
        }
        return out
    }

    function isValid(val) {
        if (!val) return true
        if (!/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(val)) return false
        const [, m, s, f] = val.split(':').map(Number)
        return m < 60 && s < 60 && f < 25
    }

    input.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey) return
        if (['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'].includes(e.key)) return
        if (!/^\d$/.test(e.key)) e.preventDefault()
    })

    input.addEventListener('input', () => {
        const pos = input.selectionStart
        const digsBefore = input.value.slice(0, pos).replace(/\D/g, '').length
        const d = digits(input.value)
        const formatted = format(d)
        input.value = formatted
        // Restore cursor after the same number of digits, skipping any colon
        let seen = 0, newPos = 0
        for (let i = 0; i < formatted.length; i++) {
            if (seen >= digsBefore) break
            if (/\d/.test(formatted[i])) seen++
            newPos = i + 1
        }
        if (formatted[newPos] === ':') newPos++
        input.setSelectionRange(newPos, newPos)
        input.classList.toggle('tc-input-invalid', !isValid(formatted))
    })

    input.addEventListener('blur', () => {
        input.classList.toggle('tc-input-invalid', !isValid(input.value))
    })
}

// Searchable combobox replacing a plain <select> for audio file lists.
// Returns { element, getValue, setValue, addOption, onChange }.
function createAudioSelect(files, emptyLabel) {
    let selectedValue = ''
    let isOpen = false
    const changeListeners = []
    const allOptions = [{ value: '', label: emptyLabel }]
    for (const f of files) allOptions.push({ value: f, label: f })

    const wrap = document.createElement('div')
    wrap.className = 'audio-select-wrap'

    const inputRow = document.createElement('div')
    inputRow.className = 'audio-select-input-row'

    const input = document.createElement('input')
    input.type = 'text'; input.className = 'audio-select-input'
    input.placeholder = emptyLabel; input.autocomplete = 'off'; input.spellcheck = false

    const arrow = document.createElement('span')
    arrow.className = 'audio-select-arrow'; arrow.textContent = '▾'

    const dropdown = document.createElement('div')
    dropdown.className = 'audio-select-dropdown'; dropdown.style.display = 'none'

    inputRow.append(input, arrow)
    wrap.append(inputRow, dropdown)

    function buildList(filter) {
        dropdown.innerHTML = ''
        const q = (filter || '').toLowerCase()
        let count = 0
        for (const opt of allOptions) {
            if (q && opt.value && !opt.label.toLowerCase().includes(q)) continue
            const div = document.createElement('div')
            div.className = 'audio-select-option' + (opt.value === selectedValue ? ' selected' : '')
            div.textContent = opt.label; div.dataset.value = opt.value
            div.addEventListener('mousedown', (e) => { e.preventDefault(); doSelect(opt.value) })
            dropdown.appendChild(div); count++
        }
        return count
    }

    function open() {
        if (isOpen) return; isOpen = true
        input.value = ''; input.placeholder = 'Suchen…'
        buildList('')
        dropdown.style.display = ''
        // scroll selected into view
        const sel = dropdown.querySelector('.selected')
        if (sel) sel.scrollIntoView({ block: 'nearest' })
    }

    function close() {
        if (!isOpen) return; isOpen = false
        dropdown.style.display = 'none'
        input.placeholder = emptyLabel
        input.value = selectedValue || ''
    }

    function doSelect(value) {
        selectedValue = value
        isOpen = false
        dropdown.style.display = 'none'
        input.placeholder = emptyLabel
        input.value = selectedValue || ''
        changeListeners.forEach(cb => cb(value))
    }

    input.addEventListener('focus', open)
    input.addEventListener('input', () => { if (!isOpen) { isOpen = true; dropdown.style.display = '' } buildList(input.value) })
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const items = [...dropdown.querySelectorAll('.audio-select-option')]
            const cur = items.findIndex(d => d.classList.contains('selected'))
            const next = e.key === 'ArrowDown' ? Math.min(cur + 1, items.length - 1) : Math.max(cur - 1, 0)
            items.forEach(d => d.classList.remove('selected'))
            if (items[next]) { items[next].classList.add('selected'); items[next].scrollIntoView({ block: 'nearest' }) }
        }
        if (e.key === 'Enter') {
            e.preventDefault()
            const sel = dropdown.querySelector('.audio-select-option.selected')
            if (sel) doSelect(sel.dataset.value)
        }
    })
    arrow.addEventListener('mousedown', (e) => { e.preventDefault(); if (isOpen) close(); else { input.focus() } })

    // Close when clicking outside
    const outsideHandler = (e) => {
        if (!wrap.isConnected) { document.removeEventListener('mousedown', outsideHandler); return }
        if (!wrap.contains(e.target)) close()
    }
    document.addEventListener('mousedown', outsideHandler)

    // Drag & Drop (Electron only)
    if (!window.__webPreview) {
        wrap.addEventListener('dragover', (e) => {
            e.preventDefault(); e.stopPropagation()
            // During dragover, file names are not yet accessible (browser security).
            // Accept any file drag and let the drop handler filter by extension.
            if ([...e.dataTransfer.items].some(i => i.kind === 'file'))
                wrap.classList.add('audio-drop-active')
        })
        wrap.addEventListener('dragleave', (e) => {
            if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('audio-drop-active')
        })
        wrap.addEventListener('drop', async (e) => {
            e.preventDefault(); e.stopPropagation(); wrap.classList.remove('audio-drop-active')
            const file = e.dataTransfer.files[0]
            if (!file) return
            if (!/\.(mp3|wav|aiff|flac|ogg|aac|m4a)$/i.test(file.name)) return
            // file.path was removed in Electron 28; use webUtils.getPathForFile instead
            const filePath = window.electronAPI.getPathForFile(file)
            if (!filePath) return
            try {
                const filename = await window.electronAPI.handleAudioDrop(filePath)
                addOption(filename); doSelect(filename)
            } catch (err) { console.error('Audio drop failed:', err) }
        })
    }

    function addOption(filename) {
        if (!allOptions.find(o => o.value === filename))
            allOptions.push({ value: filename, label: filename })
    }

    return {
        element: wrap,
        getValue: () => selectedValue,
        setValue(v) { selectedValue = v || ''; input.value = selectedValue; input.placeholder = emptyLabel },
        addOption,
        onChange(cb) { changeListeners.push(cb) },
    }
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
        const previousBlockEl = i > 0 ? blockEls[i - 1] : null
        const zone = document.createElement('div')
        zone.classList.add('insert-zone')
        const hotspot = document.createElement('div')
        hotspot.classList.add('insert-hotspot')
        hotspot.addEventListener('mousedown', e => e.stopPropagation())
        const btn = document.createElement('button')
        btn.classList.add('insert-btn')
        btn.textContent = t('btn.insert')
        btn.title = t('btn.insert.title')
        hotspot.appendChild(btn)
        zone.appendChild(hotspot)
        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (shiftHeld && previousBlockEl) {
                // SHIFT + click → open text editor instead of trigger dialog
                openNewBlock(previousBlockEl)
            } else {
                showTriggerDialog({ insertAfterBlockIdx })
            }
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

// Converts block-style {ch, note} objects produced by yaml.dump back to inline format.
// Only targets known note-reference keys to avoid accidentally inlining unrelated objects.
function inlineNoteObjects(yamlStr) {
    return yamlStr.replace(
        /^([ \t]*)(trigger_note|chain_end|loop_outro):\n\1    ch: (\d+)\n\1    note: (\d+)/gm,
        '$1$2: {ch: $3, note: $4}'
    )
}

// Updates cross-references in all YAML blocks except skipYamlIdx when a trigger_note
// is renamed from oldTn to newTn. Uses YAML parse so it handles both inline and block style.
function rewriteTriggerNoteRefsInBlocks(blocks, skipYamlIdx, oldTn, newTn) {
    const tnMatches = (tn) => tn && typeof tn === 'object' && tn.ch === oldTn.ch && tn.note === oldTn.note
    let yamlIdx = 0
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type !== 'yaml') continue
        if (yamlIdx === skipYamlIdx) { yamlIdx++; continue }
        const m = blocks[i].content.match(/^```yaml\n([\s\S]*?)\n```$/)
        if (!m) { yamlIdx++; continue }
        let parsed
        try { parsed = yaml.load(m[1]) } catch { yamlIdx++; continue }
        if (!parsed || typeof parsed !== 'object') { yamlIdx++; continue }

        let changed = false
        if (tnMatches(parsed.chain_end)) {
            parsed.chain_end = { ch: newTn.ch, note: newTn.note }; changed = true
        }
        if (tnMatches(parsed.loop_outro)) {
            parsed.loop_outro = { ch: newTn.ch, note: newTn.note }; changed = true
        }
        if (tnMatches(parsed.auto_trigger?.trigger_note)) {
            parsed.auto_trigger = { ...parsed.auto_trigger, trigger_note: { ch: newTn.ch, note: newTn.note } }
            changed = true
        }
        if (typeof parsed.music === 'object' && tnMatches(parsed.music?.adjust?.trigger_note)) {
            parsed.music = { ...parsed.music, adjust: { ...parsed.music.adjust, trigger_note: { ch: newTn.ch, note: newTn.note } } }
            changed = true
        }
        if (changed) {
            const raw = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true }).trimEnd()
            blocks[i] = { type: 'yaml', content: `\`\`\`yaml\n${inlineNoteObjects(raw)}\n\`\`\`` }
        }
        yamlIdx++
    }
}

function editTriggerInScript(triggerIndex, newYaml, oldTriggerNote = null) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    let yamlCount = 0
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'yaml') {
            yamlCount++
            if (yamlCount === triggerIndex + 1) {
                blocks[i] = { type: 'yaml', content: '```yaml\n' + inlineNoteObjects(yaml.dump(newYaml, { indent: 4 }).trimEnd()) + '\n```' }
                break
            }
        }
    }
    const newTn = newYaml.trigger_note ?? null
    if (oldTriggerNote && newTn && (oldTriggerNote.ch !== newTn.ch || oldTriggerNote.note !== newTn.note)) {
        rewriteTriggerNoteRefsInBlocks(blocks, triggerIndex, oldTriggerNote, newTn)
    }
    let updated = blocks.map(b => b.content).join('\n\n') + '\n'
    const { text: assigned, changed } = assignTriggerNotes(updated)
    if (changed) updated = assigned
    scriptText = updated
    writeScriptMd(updated)
    rerender(updated)
}

function deleteTriggerInScript(triggerIndex) {
    if (!scriptText) return
    const blocks = tokenizeScript(scriptText)
    let yamlCount = 0
    let deletedIdx = -1
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'yaml') {
            yamlCount++
            if (yamlCount === triggerIndex + 1) {
                blocks.splice(i, 1)
                deletedIdx = i
                break
            }
        }
    }
    // If we deleted the root of a sibling group, the new first element would
    // have sibling:true but no root before it — strip the flag.
    if (deletedIdx >= 0 && deletedIdx < blocks.length && blocks[deletedIdx].type === 'yaml') {
        const prevIsYaml = deletedIdx > 0 && blocks[deletedIdx - 1].type === 'yaml'
        if (!prevIsYaml) {
            const m = blocks[deletedIdx].content.match(/^```yaml\n([\s\S]*?)\n```$/)
            if (m) {
                try {
                    const parsed = yaml.load(m[1])
                    if (parsed?.sibling) {
                        delete parsed.sibling
                        blocks[deletedIdx] = { type: 'yaml', content: '```yaml\n' + inlineNoteObjects(yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true }).trimEnd()) + '\n```' }
                    }
                } catch {}
            }
        }
    }
    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    writeScriptMd(updated)
    rerender(updated)
}

// Updates all derived TC badges once audio durations become available
function updateDerivedTcBadges() {
    for (const [idx, badge] of slfDerivedTcBadges) {
        const tc = derivedTcFor(idx)
        if (tc) {
            badge.textContent = `⏱ ↳ ${tc}`
            badge.title = 'Timecode abgeleitet vom Start-Cue der S/L/F-Gruppe'
        }
    }
}

// Returns the SLF chain root index for a given trigger (traverses backwards through chain_end and loop_outro links)
function slfChainRootOf(idx) {
    for (let i = 1; i < triggerYamls.length; i++) {
        if (triggerYamls[i]?.chain_end && findTriggerByNote(triggerYamls[i].chain_end) === idx)
            return slfChainRootOf(i)
        if (triggerYamls[i]?.loop_outro && findTriggerByNote(triggerYamls[i].loop_outro) === idx)
            return slfChainRootOf(i)
    }
    return idx
}

// Computes derived TC string (HH:MM:SS:FF) for a non-root SLF cue.
// Returns a TC string or null if root has no TC or audio durations are unknown.
function derivedTcFor(idx) {
    const rootIdx = slfChainRootOf(idx)
    if (rootIdx === idx) return null  // already the root
    const rootTc = triggerYamls[rootIdx]?.start_tc
    if (!rootTc) return null

    const [h, m, s, f] = rootTc.split(':').map(Number)
    let frames = ((h * 3600 + m * 60 + s) * 25) + f

    let current = rootIdx
    while (current !== idx) {
        const ty = triggerYamls[current]
        let next = null
        if (ty?.chain_end) next = findTriggerByNote(ty.chain_end)
        else if (ty?.loop_outro) next = findTriggerByNote(ty.loop_outro)
        if (next === null || next === current || next === undefined) break

        const ta = triggerAudio.get(current)
        const audioEl = ta?.mainAudioEl
        const mp = ta?.mp
        if (audioEl && isFinite(audioEl.duration) && audioEl.duration > 0) {
            const start = mp?.start ?? 0
            const end   = mp?.end   ?? audioEl.duration
            frames += Math.round((end - start) * 25)
        } else {
            return null  // duration unknown
        }
        current = next
    }

    const fps = 25
    const ff  = frames % fps
    const secs = Math.floor(frames / fps)
    const ss  = secs % 60
    const mins = Math.floor(secs / 60)
    const mm  = mins % 60
    const hh  = Math.floor(mins / 60) % 24
    const p   = n => String(n).padStart(2, '0')
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}

// insertAfterBlockIdx: for new triggers (add mode)
// triggerIndex + existingYaml: for editing an existing trigger (edit mode)
async function showTriggerDialog({ insertAfterBlockIdx = null, triggerIndex = null, existingYaml = null, isCopy = false, parentTriggerNote = null } = {}) {
    const isEdit = triggerIndex !== null
    const audioFiles = await window.electronAPI.listAudioFiles()

    // Detect if this is a non-root member of an SLF chain (Finish/outro or chain target → no manual TC)
    let isNonRootSlfMember = false
    if (isEdit && triggerIndex !== null) {
        const isFinish = loopSourcesOf(triggerIndex).length > 0
        let isChainTarget = false
        for (let i = 1; i < triggerYamls.length; i++) {
            if (i === triggerIndex) continue
            if (triggerYamls[i]?.chain_end && findTriggerByNote(triggerYamls[i].chain_end) === triggerIndex) {
                isChainTarget = true; break
            }
        }
        isNonRootSlfMember = isFinish || isChainTarget
    }

    const overlay = document.createElement('div')
    overlay.classList.add('dialog-overlay')

    const box = document.createElement('div')
    box.classList.add('dialog-box')
    box.addEventListener('mousedown', e => e.stopPropagation())
    box.addEventListener('click', e => e.stopPropagation())

    const titleEl = document.createElement('h3')
    titleEl.textContent = isEdit ? t('dlg.trigger.edit') : isCopy ? t('dlg.trigger.copy') : t('dlg.trigger.new')
    box.appendChild(titleEl)

    // ── Mikrofon ────────────────────────────────────────────────────
    const micWrap = document.createElement('div')
    micWrap.classList.add('dialog-field')
    const micTopLabel = document.createElement('label')
    micTopLabel.textContent = t('dlg.trigger.mic')

    let muteallCb = { checked: false }, roleCheckboxes = {}, groupCheckboxes = {}

    if (hasAnyAutoMic()) {
        const autoNote = document.createElement('p')
        autoNote.style.cssText = 'font-size:0.8rem;color:#636d83;margin:0.2rem 0 0;font-style:italic'
        autoNote.textContent = t('dlg.trigger.mic.auto')
        micWrap.append(micTopLabel, autoNote)
    } else {
        const micGroup = document.createElement('div')
        micGroup.className = 'dialog-chip-group'

        // Muteall chip
        const muteallBtn = document.createElement('button')
        muteallBtn.type = 'button'
        muteallBtn.className = 'mic-select-chip'
        muteallBtn.textContent = t('dlg.trigger.mic.muteall')
        muteallBtn.style.setProperty('--chip-col', '#e06c75')
        muteallBtn.addEventListener('click', () => {
            muteallCb.checked = !muteallCb.checked
            muteallBtn.classList.toggle('active', muteallCb.checked)
            if (muteallCb.checked) {
                for (const obj of [...Object.values(groupCheckboxes), ...Object.values(roleCheckboxes)]) {
                    obj.checked = false
                    obj._btn.classList.remove('active')
                }
            }
        })
        micGroup.appendChild(muteallBtn)

        // Groups (Alle + custom groups) — shown before individual roles
        const groupEntries = [
            ['Alle', null],
            ...Object.entries(config.groups || {}).map(([n, g]) => [n, g.color])
        ]
        if (groupEntries.length > 0) {
            const groupSep = document.createElement('div')
            groupSep.className = 'mic-chip-sep'
            groupSep.textContent = 'Gruppen'
            micGroup.appendChild(groupSep)
            for (const [gName, gColor] of groupEntries) {
                const btn = document.createElement('button')
                btn.type = 'button'
                btn.className = 'mic-select-chip'
                btn.textContent = gName
                btn.style.setProperty('--chip-col', gColor ? (ROLE_COLORS[gColor] || '#abb2bf') : '#abb2bf')
                const obj = { checked: false, _btn: btn }
                btn.addEventListener('click', () => {
                    obj.checked = !obj.checked
                    btn.classList.toggle('active', obj.checked)
                    if (obj.checked) { muteallCb.checked = false; muteallBtn.classList.remove('active') }
                })
                micGroup.appendChild(btn)
                groupCheckboxes[gName] = obj
            }
            const roleSep = document.createElement('div')
            roleSep.className = 'mic-chip-sep'
            roleSep.textContent = 'Einzelrollen'
            micGroup.appendChild(roleSep)
        }

        for (const [roleName, roleCfg] of Object.entries(config.roles)) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'mic-select-chip'
            btn.textContent = roleName
            btn.style.setProperty('--chip-col', ROLE_COLORS[roleCfg.color] || '#abb2bf')
            const obj = { checked: false, _btn: btn }
            btn.addEventListener('click', () => {
                obj.checked = !obj.checked
                btn.classList.toggle('active', obj.checked)
                if (obj.checked) { muteallCb.checked = false; muteallBtn.classList.remove('active') }
            })
            micGroup.appendChild(btn)
            roleCheckboxes[roleName] = obj
        }

        micWrap.append(micTopLabel, micGroup)

        if ((isEdit || isCopy) && existingYaml?.mic) {
            if (existingYaml.mic === 'muteall') {
                muteallCb.checked = true
                muteallBtn.classList.add('active')
            } else {
                const sel = Array.isArray(existingYaml.mic) ? existingYaml.mic : [existingYaml.mic]
                for (const r of sel) {
                    if (groupCheckboxes[r]) {
                        groupCheckboxes[r].checked = true
                        groupCheckboxes[r]._btn.classList.add('active')
                    } else if (roleCheckboxes[r]) {
                        roleCheckboxes[r].checked = true
                        roleCheckboxes[r]._btn.classList.add('active')
                    }
                }
            }
        }
    }
    box.appendChild(micWrap)

    // ── Musik-Datei ─────────────────────────────────────────────────
    const mfWrap = document.createElement('div')
    mfWrap.classList.add('dialog-field')
    const mfLabel = document.createElement('label')
    mfLabel.textContent = t('dlg.trigger.music')
    const mfComp = createAudioSelect(audioFiles, t('dlg.trigger.music.none'))
    mfWrap.append(mfLabel, mfComp.element)
    if (!window.__webPreview) {
        const mfHint = document.createElement('p')
        mfHint.style.cssText = 'font-size:0.72rem;color:#4a505a;margin:0.2rem 0 0'
        mfHint.textContent = 'Aus vorhandenen auswählen oder neue Datei per Drag & Drop hinzufügen'
        mfWrap.appendChild(mfHint)
    }
    // For seq-loop cues the primary file will be shown inside the seq group — hide standalone fields
    const isSeqLoop = isEdit && !!existingYaml?.loop_outro
    // mfWrap is superseded by the seq-card display below for all cue types

    if ((isEdit || isCopy) && existingYaml?.music) {
        const currentFile = typeof existingYaml.music === 'string' ? existingYaml.music : existingYaml.music.file
        if (currentFile) mfComp.setValue(currentFile)
    }

    // ── Monitor-Mix ─────────────────────────────────────────────────
    const monWrap = document.createElement('div')
    monWrap.classList.add('dialog-field')
    const monLabel = document.createElement('label')
    monLabel.textContent = t('dlg.trigger.monitor')
    const monComp = createAudioSelect(audioFiles, t('dlg.trigger.monitor.none'))
    const monWarning = document.createElement('div')
    monWarning.style.cssText = 'color:#e5c07b;font-size:0.82rem;margin-top:0.3rem;display:none'
    monWrap.append(monLabel, monComp.element, monWarning)
    if (!window.__webPreview) {
        const monHint = document.createElement('p')
        monHint.style.cssText = 'font-size:0.72rem;color:#4a505a;margin:0.2rem 0 0'
        monHint.textContent = 'Aus vorhandenen auswählen oder neue Datei per Drag & Drop hinzufügen'
        monWrap.appendChild(monHint)
    }
    // monWrap is superseded by the seq-card display below

    if ((isEdit || isCopy) && existingYaml?.music && typeof existingYaml.music === 'object' && existingYaml.music.monitor) {
        monComp.setValue(existingYaml.music.monitor)
    }

    async function checkMonitorDuration() {
        const mf = mfComp.getValue()
        const mf2 = monComp.getValue()
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
    mfComp.onChange(checkMonitorDuration)
    monComp.onChange(checkMonitorDuration)
    checkMonitorDuration()

    // ── Ausklingpunkt (fading_point) ────────────────────────────────────
    // Shown only for SLF Loop / SLF Start / SLF Bridge / normal Loop cues when editing
    const showOutroLen = isEdit && (
        !!existingYaml?.loop_outro ||
        !!existingYaml?.chain_end  ||
        (typeof existingYaml?.music === 'object' && !!existingYaml.music.loop)
    )
    let outroLenInput = null
    if (showOutroLen) {
        const olWrap = document.createElement('div')
        olWrap.classList.add('dialog-field')
        const olLabel = document.createElement('label')
        olLabel.textContent = t('dlg.trigger.fading_point')
        const olRow = document.createElement('div')
        olRow.style.cssText = 'display:flex;gap:0.5rem;align-items:center'
        outroLenInput = document.createElement('input')
        outroLenInput.type = 'number'; outroLenInput.min = '0'; outroLenInput.step = '0.001'
        outroLenInput.style.cssText = 'width:7rem'
        outroLenInput.value = (typeof existingYaml?.music === 'object' && existingYaml.music.fading_point > 0)
            ? existingYaml.music.fading_point : ''

        // BPM + Beats → auto-calculate seconds
        const bpmInput   = document.createElement('input')
        bpmInput.type = 'number'; bpmInput.min = '1'; bpmInput.step = '1'; bpmInput.placeholder = t('dlg.trigger.fading_point.bpm')
        bpmInput.style.cssText = 'width:6rem'
        const beatsInput = document.createElement('input')
        beatsInput.type = 'number'; beatsInput.min = '1'; beatsInput.step = '1'; beatsInput.placeholder = t('dlg.trigger.fading_point.beats')
        beatsInput.style.cssText = 'width:5rem'
        const calcOutroLen = async () => {
            const bpm = parseFloat(bpmInput.value), beats = parseFloat(beatsInput.value)
            if (bpm <= 0 || beats <= 0) return
            const tailDur = (beats / bpm) * 60
            const filename = mfComp.getValue()
            if (!filename) return
            const fileDur = await new Promise(res => {
                const a = new Audio(audioBasePath + filename)
                a.addEventListener('loadedmetadata', () => res(a.duration))
                a.addEventListener('error', () => res(null))
            })
            if (fileDur != null && fileDur > tailDur)
                outroLenInput.value = parseFloat((fileDur - tailDur).toFixed(4))
        }
        bpmInput.addEventListener('input', calcOutroLen)
        beatsInput.addEventListener('input', calcOutroLen)

        olRow.append(outroLenInput, bpmInput, beatsInput)
        olWrap.append(olLabel, olRow)
        // fading_point lives inside the seq card for all cue types — standalone field not shown
    }

    // ── Audiodateien (Sequenz, alle Slots) / Weitere Dateien ────────
    const seqSection = document.createElement('div')
    seqSection.classList.add('dialog-field')
    const seqHeaderRow = document.createElement('div')
    seqHeaderRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem'
    const seqLabel = document.createElement('label')
    seqLabel.textContent = isSeqLoop ? t('dlg.trigger.music_seq.all') : t('dlg.trigger.music')
    seqLabel.style.marginBottom = '0'
    const addSeqBtn = document.createElement('button')
    addSeqBtn.type = 'button'; addSeqBtn.classList.add('dialog-btn')
    addSeqBtn.textContent = t('dlg.trigger.music_seq.add')
    addSeqBtn.style.cssText = 'padding:0.2rem 0.6rem;font-size:0.82rem'
    if (isSeqLoop) seqHeaderRow.append(seqLabel, addSeqBtn)
    else seqHeaderRow.append(seqLabel)
    seqSection.appendChild(seqHeaderRow)
    const seqList = document.createElement('div')
    seqSection.appendChild(seqList)
    box.appendChild(seqSection)

    function buildSeqCard(cfg, { isPrimary = false, showOutroLen = true } = {}) {
        cfg = cfg || {}
        const card = document.createElement('div')
        card.className = 'seq-entry-card'

        // File selector row
        const fileRow = document.createElement('div')
        fileRow.style.cssText = 'display:flex;gap:0.4rem;align-items:center;margin-bottom:0.3rem'
        const fileComp = createAudioSelect(audioFiles, t('dlg.trigger.music.none'))
        if (cfg.file) fileComp.setValue(cfg.file)
        fileComp.element.style.flex = '1'
        if (isPrimary) {
            const numBadge = document.createElement('span')
            numBadge.textContent = '1'
            numBadge.style.cssText = 'font-size:0.78rem;font-weight:700;color:#7a8394;width:1.4rem;text-align:center;flex-shrink:0'
            fileRow.append(fileComp.element, numBadge)
        } else {
            const removeBtn = document.createElement('button')
            removeBtn.type = 'button'; removeBtn.className = 'cue-msg-card-remove'
            removeBtn.textContent = '✕'
            removeBtn.addEventListener('click', () => card.remove())
            fileRow.append(fileComp.element, removeBtn)
        }

        // Monitor selector row
        const monRow = document.createElement('div')
        monRow.style.cssText = 'display:flex;gap:0.4rem;align-items:center;margin-bottom:0.3rem'
        const monLabel = document.createElement('span')
        monLabel.textContent = t('dlg.trigger.monitor')
        monLabel.style.cssText = 'font-size:0.82rem;white-space:nowrap;color:#7a8394'
        const monComp2 = createAudioSelect(audioFiles, t('dlg.trigger.monitor.none'))
        if (cfg.monitor) monComp2.setValue(cfg.monitor)
        monComp2.element.style.flex = '1'
        monRow.append(monLabel, monComp2.element)

        // fading_point row
        const olRow = document.createElement('div')
        olRow.style.cssText = 'display:flex;gap:0.4rem;align-items:center'
        const olLabel2 = document.createElement('span')
        olLabel2.textContent = t('dlg.trigger.fading_point')
        olLabel2.style.cssText = 'font-size:0.82rem;white-space:nowrap;color:#7a8394'
        const olInput2 = document.createElement('input')
        olInput2.type = 'number'; olInput2.min = '0'; olInput2.step = '0.001'
        olInput2.className = 'no-spin'; olInput2.style.cssText = 'width:6rem'
        olInput2.value = cfg.fading_point > 0 ? cfg.fading_point : ''
        const bpm2 = document.createElement('input')
        bpm2.type = 'number'; bpm2.min = '1'; bpm2.step = '1'
        bpm2.className = 'no-spin'
        bpm2.placeholder = t('dlg.trigger.fading_point.bpm'); bpm2.style.cssText = 'width:5rem'
        const beats2 = document.createElement('input')
        beats2.type = 'number'; beats2.min = '1'; beats2.step = '1'
        beats2.className = 'no-spin'
        beats2.placeholder = t('dlg.trigger.fading_point.beats'); beats2.style.cssText = 'width:5rem'
        const calc2 = async () => {
            const b = parseFloat(bpm2.value), n = parseFloat(beats2.value)
            if (!(b > 0 && n > 0)) return
            const tailDur = (n / b) * 60
            const filename = fileComp.getValue() || cfg.file
            if (!filename) return
            const fileDur = await new Promise(res => {
                const a = new Audio(audioBasePath + filename)
                a.addEventListener('loadedmetadata', () => res(a.duration))
                a.addEventListener('error', () => res(null))
            })
            if (fileDur != null && fileDur > tailDur)
                olInput2.value = parseFloat((fileDur - tailDur).toFixed(4))
        }
        bpm2.addEventListener('input', calc2); beats2.addEventListener('input', calc2)
        olRow.append(olLabel2, olInput2, bpm2, beats2)

        if (showOutroLen) card.append(fileRow, monRow, olRow)
        else card.append(fileRow, monRow)

        card._fileComp = fileComp
        card._monComp  = monComp2

        card.getValues = () => ({
            file:      fileComp.getValue() || null,
            monitor:   monComp2.getValue() || null,
            fading_point: showOutroLen ? (parseFloat(olInput2.value) || 0) : 0,
        })
        return card
    }

    // Populate seq entries — primary file card first (isPrimary), then music_seq entries
    {
        const primaryCfg = {
            file:         typeof existingYaml?.music === 'string' ? existingYaml.music : (existingYaml?.music?.file ?? ''),
            monitor:      typeof existingYaml?.music === 'object' ? (existingYaml.music.monitor ?? '') : '',
            fading_point: typeof existingYaml?.music === 'object' && existingYaml.music.fading_point > 0 ? existingYaml.music.fading_point : 0,
        }
        const primaryCard = buildSeqCard(primaryCfg, { isPrimary: true, showOutroLen })
        seqList.appendChild(primaryCard)

        // Wire monitor duration check to the card's selects (replaces standalone monWarning)
        if (primaryCard._fileComp && primaryCard._monComp) {
            const warnEl = document.createElement('div')
            warnEl.style.cssText = 'color:#e5c07b;font-size:0.82rem;margin-top:0.3rem;display:none'
            primaryCard.appendChild(warnEl)
            const checkDur = async () => {
                const f1 = primaryCard._fileComp.getValue(), f2 = primaryCard._monComp.getValue()
                if (!f1 || !f2) { warnEl.style.display = 'none'; return }
                const [d1, d2] = await Promise.all([
                    new Promise(r => { const a = new Audio('audio/' + f1); a.addEventListener('loadedmetadata', () => r(a.duration)); a.addEventListener('error', () => r(null)) }),
                    new Promise(r => { const a = new Audio('audio/' + f2); a.addEventListener('loadedmetadata', () => r(a.duration)); a.addEventListener('error', () => r(null)) }),
                ])
                if (d1 && d2 && Math.abs(d1 - d2) > 0.1) {
                    warnEl.textContent = `⚠ Unterschiedliche Längen: ${d1.toFixed(2)}s vs ${d2.toFixed(2)}s`
                    warnEl.style.display = 'block'
                } else { warnEl.style.display = 'none' }
            }
            primaryCard._fileComp.onChange(checkDur)
            primaryCard._monComp.onChange(checkDur)
            checkDur()
        }

        if (isSeqLoop && Array.isArray(existingYaml?.music_seq)) {
            for (const entry of existingYaml.music_seq) {
                seqList.appendChild(buildSeqCard(entry))
            }
        }
    }
    addSeqBtn.addEventListener('click', () => {
        seqList.appendChild(buildSeqCard({}))
    })

    // ── Hinweis ─────────────────────────────────────────────────────
    const { wrap: noteWrap, input: noteInput } = mkDialogField(t('dlg.trigger.note'), 'text', '')
    if ((isEdit || isCopy) && existingYaml?.note) noteInput.value = existingYaml.note
    box.appendChild(noteWrap)

    // ── Geräte-Nachrichten (cue_midi + cue_osc unified) ──────────────────
    const cueMsgSection = document.createElement('div')
    cueMsgSection.classList.add('dialog-field')
    const cueMsgHeaderRow = document.createElement('div')
    cueMsgHeaderRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem'
    const cueMsgLabel = document.createElement('label')
    cueMsgLabel.textContent = 'Nachrichten'
    cueMsgLabel.style.marginBottom = '0'
    const addMsgBtn = document.createElement('button')
    addMsgBtn.type = 'button'
    addMsgBtn.classList.add('dialog-btn')
    addMsgBtn.textContent = '+ Nachricht'
    addMsgBtn.style.cssText = 'padding:0.2rem 0.6rem;font-size:0.82rem'
    cueMsgHeaderRow.append(cueMsgLabel, addMsgBtn)
    cueMsgSection.appendChild(cueMsgHeaderRow)
    const cueMsgList = document.createElement('div')
    cueMsgSection.appendChild(cueMsgList)
    box.appendChild(cueMsgSection)

    function buildMsgCard(cfg, defaultDevType) {
        cfg = cfg || {}
        // Determine which device this belongs to
        const matchedDev = outputDevices.find(d => d.name === cfg.device)
        const devType = matchedDev?.type || defaultDevType || (outputDevices[0]?.type ?? 'midi')

        const card = document.createElement('div')
        card.className = 'cue-msg-card'

        const cardHeader = document.createElement('div')
        cardHeader.className = 'cue-msg-card-header'

        const commentIn = document.createElement('input')
        commentIn.type = 'text'; commentIn.placeholder = 'Kommentar (optional)'
        commentIn.value = cfg.comment || ''
        commentIn.style.flex = '1'

        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.className = 'cue-msg-card-remove'
        removeBtn.textContent = '✕'
        removeBtn.addEventListener('click', () => card.remove())

        cardHeader.append(commentIn, removeBtn)
        card.appendChild(cardHeader)

        // Device select — all outputDevices
        const devSel = document.createElement('select')
        devSel.classList.add('dialog-select')
        devSel.style.marginBottom = '0.4rem'
        for (const d of outputDevices) {
            const o = new Option(d.name, d.name)
            if (d.name === cfg.device) o.selected = true
            devSel.appendChild(o)
        }
        if (!devSel.value && outputDevices.length) devSel.value = outputDevices.find(d => d.type === devType)?.name || outputDevices[0].name
        card.appendChild(devSel)

        // ─ MIDI fields ─
        const midiSection = document.createElement('div')
        const devRow = document.createElement('div')
        devRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;margin-bottom:0.4rem'
        const typeSel = document.createElement('select')
        typeSel.classList.add('dialog-select')
        for (const [v, lbl] of [['note','Note'],['cc','CC'],['pc','Program Change'],['sysex','SysEx']]) {
            const o = new Option(lbl, v)
            if (v === (cfg.type || 'note')) o.selected = true
            typeSel.appendChild(o)
        }
        devRow.appendChild(typeSel)
        midiSection.appendChild(devRow)

        const mkNumIn = (ph, min, max, val) => {
            const el = document.createElement('input'); el.type = 'number'
            el.placeholder = ph; el.min = min; el.max = max
            if (val !== undefined) el.value = val
            el.classList.add('dialog-select'); el.style.width = '100%'
            return el
        }
        const mkLbl = txt => { const l = document.createElement('div'); l.style.cssText = 'font-size:0.72rem;color:#5c6370'; l.textContent = txt; return l }

        const noteDiv = document.createElement('div')
        noteDiv.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.4rem;margin-bottom:0.4rem'
        const noteCh   = mkNumIn('Kanal', 1, 16, cfg.ch || 1)
        const noteNote = mkNumIn('Note', 0, 127, cfg.note !== undefined ? cfg.note : '')
        const noteVel  = mkNumIn('Velocity', 0, 127, cfg.vel !== undefined ? cfg.vel : 100)
        const nChW = document.createElement('div'); nChW.append(mkLbl('Kanal (1–16)'), noteCh)
        const nNoW = document.createElement('div'); nNoW.append(mkLbl('Note (0–127)'), noteNote)
        const nVlW = document.createElement('div'); nVlW.append(mkLbl('Velocity'), noteVel)
        noteDiv.append(nChW, nNoW, nVlW)

        const ccDiv = document.createElement('div')
        ccDiv.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.4rem;margin-bottom:0.4rem'
        const ccCh  = mkNumIn('Kanal', 1, 16, cfg.ch || 1)
        const ccNum = mkNumIn('CC-Nummer', 0, 127, cfg.cc !== undefined ? cfg.cc : '')
        const ccVal = mkNumIn('Wert', 0, 127, cfg.value !== undefined ? cfg.value : '')
        const ccChW = document.createElement('div'); ccChW.append(mkLbl('Kanal (1–16)'), ccCh)
        const ccNuW = document.createElement('div'); ccNuW.append(mkLbl('CC (0–127)'), ccNum)
        const ccVlW = document.createElement('div'); ccVlW.append(mkLbl('Wert (0–127)'), ccVal)
        ccDiv.append(ccChW, ccNuW, ccVlW)

        const pcDiv = document.createElement('div')
        pcDiv.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;margin-bottom:0.4rem'
        const pcCh  = mkNumIn('Kanal', 1, 16, cfg.ch || 1)
        const pcPgm = mkNumIn('Programm', 0, 127, cfg.program !== undefined ? cfg.program : '')
        const pcChW = document.createElement('div'); pcChW.append(mkLbl('Kanal (1–16)'), pcCh)
        const pcPgW = document.createElement('div'); pcPgW.append(mkLbl('Programm (0–127)'), pcPgm)
        pcDiv.append(pcChW, pcPgW)

        const sysexDiv = document.createElement('div')
        sysexDiv.style.marginBottom = '0.4rem'
        const sysexIn = document.createElement('input'); sysexIn.type = 'text'
        sysexIn.placeholder = 'z.B. F0 41 F7'; sysexIn.value = cfg.bytes || ''
        sysexIn.classList.add('dialog-select'); sysexIn.style.width = '100%'
        sysexDiv.append(mkLbl('Hex-Bytes (Leerzeichen-getrennt)'), sysexIn)

        midiSection.append(noteDiv, ccDiv, pcDiv, sysexDiv)
        card.appendChild(midiSection)

        function updateMidiTypeDivs() {
            const tv = typeSel.value
            noteDiv.style.display  = tv === 'note'  ? '' : 'none'
            ccDiv.style.display    = tv === 'cc'    ? '' : 'none'
            pcDiv.style.display    = tv === 'pc'    ? '' : 'none'
            sysexDiv.style.display = tv === 'sysex' ? '' : 'none'
        }
        typeSel.addEventListener('change', updateMidiTypeDivs)
        updateMidiTypeDivs()

        // ─ OSC fields ─
        const oscSection = document.createElement('div')
        const pathIn = document.createElement('input')
        pathIn.type = 'text'; pathIn.placeholder = '/pfad/zum/ziel'
        pathIn.value = cfg.path || ''
        pathIn.classList.add('dialog-select'); pathIn.style.width = '100%'; pathIn.style.marginBottom = '0.4rem'
        const argRow = document.createElement('div')
        argRow.style.cssText = 'display:flex;gap:0.4rem;margin-bottom:0.4rem'
        const argTypeSel = document.createElement('select')
        argTypeSel.classList.add('dialog-select'); argTypeSel.style.cssText = 'width:auto;flex-shrink:0'
        for (const [v, lbl] of [['none','— kein Argument —'],['string','string'],['int','int'],['float','float']]) {
            const o = new Option(lbl, v)
            if (v === (cfg.arg !== undefined && cfg.arg !== '' ? (cfg.arg_type || 'string') : 'none')) o.selected = true
            argTypeSel.appendChild(o)
        }
        const argIn = document.createElement('input')
        argIn.type = 'text'; argIn.placeholder = 'Wert'; argIn.style.flex = '1'
        argIn.value = cfg.arg !== undefined ? String(cfg.arg) : ''
        const updateArgVis = () => { argIn.style.display = argTypeSel.value === 'none' ? 'none' : '' }
        argTypeSel.addEventListener('change', updateArgVis)
        updateArgVis()
        argRow.append(argTypeSel, argIn)
        oscSection.append(pathIn, argRow)
        card.appendChild(oscSection)

        function updateDevSections() {
            const selectedDev = outputDevices.find(d => d.name === devSel.value)
            const isMidi = selectedDev ? selectedDev.type === 'midi' : true
            midiSection.style.display = isMidi ? '' : 'none'
            oscSection.style.display  = isMidi ? 'none' : ''
        }
        devSel.addEventListener('change', updateDevSections)
        updateDevSections()

        card.getValues = () => {
            const selectedDev = outputDevices.find(d => d.name === devSel.value)
            const isMidi = selectedDev ? selectedDev.type === 'midi' : true
            if (isMidi) {
                const tv = typeSel.value
                const out = { type: tv, device: devSel.value || midiOutputDevices[0]?.name || '' }
                if (commentIn.value.trim()) out.comment = commentIn.value.trim()
                if (tv === 'note') { out.ch = parseInt(noteCh.value) || 1; out.note = parseInt(noteNote.value) || 0; out.vel = parseInt(noteVel.value) ?? 100 }
                else if (tv === 'cc') { out.ch = parseInt(ccCh.value) || 1; out.cc = parseInt(ccNum.value) || 0; out.value = parseInt(ccVal.value) ?? 0 }
                else if (tv === 'pc') { out.ch = parseInt(pcCh.value) || 1; out.program = parseInt(pcPgm.value) || 0 }
                else if (tv === 'sysex') { out.bytes = sysexIn.value.trim() }
                out._isMidi = true
                return out
            } else {
                const out = { device: devSel.value || oscOutputDevices[0]?.name || '', path: pathIn.value.trim() }
                if (commentIn.value.trim()) out.comment = commentIn.value.trim()
                if (argTypeSel.value !== 'none' && argIn.value.trim() !== '') { out.arg = argIn.value.trim(); out.arg_type = argTypeSel.value }
                out._isOsc = true
                return out
            }
        }

        cueMsgList.appendChild(card)
    }

    // Load existing MIDI messages (tagged as midi)
    if ((isEdit || isCopy) && Array.isArray(existingYaml?.cue_midi)) {
        for (const m of existingYaml.cue_midi) buildMsgCard(m, 'midi')
    }
    // Load existing OSC messages (tagged as osc)
    if ((isEdit || isCopy) && Array.isArray(existingYaml?.cue_osc)) {
        for (const m of existingYaml.cue_osc) buildMsgCard(m, 'osc')
    }
    addMsgBtn.addEventListener('click', () => buildMsgCard({}))

    // ── Start-Timecode ───────────────────────────────────────────────
    let tcInput = null
    if (isNonRootSlfMember) {
        const tcWrap = document.createElement('div')
        tcWrap.classList.add('dialog-field')
        const tcLabel = document.createElement('label')
        tcLabel.textContent = t('dlg.trigger.tc.derived')
        const tcDisplay = document.createElement('div')
        tcDisplay.classList.add('dialog-tc-derived')
        const derived = derivedTcFor(triggerIndex)
        if (derived) {
            tcDisplay.textContent = '↳ ' + derived
            tcDisplay.title = t('dlg.trigger.tc.derived.title')
        } else {
            tcDisplay.textContent = t('dlg.trigger.tc.derived.none')
            tcDisplay.title = t('dlg.trigger.tc.derived.hint')
        }
        tcWrap.append(tcLabel, tcDisplay)
        box.appendChild(tcWrap)
    } else {
        const { wrap, input } = mkDialogField(t('dlg.trigger.tc'), 'text', '')
        tcInput = input
        tcInput.placeholder = t('dlg.trigger.tc.ph')
        tcInput.classList.add('tc-input')
        installTcMask(tcInput)
        if ((isEdit || isCopy) && existingYaml?.start_tc) tcInput.value = existingYaml.start_tc
        box.appendChild(wrap)
    }

    // ── MIDI-Note (nur beim Bearbeiten, nicht bei neuen Triggern) ────
    let tnInput = null
    if (isEdit && !isCopy && existingYaml?.trigger_note) {
        const { wrap: tnWrap, input: tnIn } = mkDialogField('MIDI-Note (Kanal.Note)', 'text', '')
        tnInput = tnIn
        tnInput.classList.add('tc-input')
        tnInput.placeholder = `${existingYaml.trigger_note.ch}.${existingYaml.trigger_note.note}`
        tnInput.value = `${existingYaml.trigger_note.ch}.${existingYaml.trigger_note.note}`
        // Validate format, range, and uniqueness on input
        const myGroupRoot = groupRootOf(triggerIndex)
        tnInput.addEventListener('input', () => {
            const raw = tnInput.value.trim()
            if (!raw) { tnInput.classList.remove('tc-input-invalid'); tnInput.title = ''; return }
            const parts = raw.split('.')
            const c = parseInt(parts[0]), n = parseInt(parts[1])
            const isValid = parts.length === 2 && !isNaN(c) && !isNaN(n)
                && c >= 1 && c <= 16 && n >= 0 && n <= 127
            if (!isValid) {
                tnInput.classList.add('tc-input-invalid')
                tnInput.title = 'Ungültige MIDI-Note – Format: Kanal.Note (z.B. 1.42)'
                return
            }
            const inUse = triggerYamls.some((ty, i) =>
                i > 0 && i !== triggerIndex && groupRootOf(i) !== myGroupRoot
                && ty?.trigger_note?.ch === c && ty?.trigger_note?.note === n)
            tnInput.classList.toggle('tc-input-invalid', inUse)
            tnInput.title = inUse ? `Note ${c}.${n} wird bereits von einem anderen Cue verwendet` : ''
        })
        box.appendChild(tnWrap)
    }

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
        sameTnLabel.append(sameTnCheckbox, t('dlg.trigger.same_tn.prefix') + ptnStr)
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
    cancelBtn.textContent = t('btn.cancel')

    const confirmBtn = document.createElement('button')
    confirmBtn.classList.add('dialog-btn', 'dialog-btn-primary')
    confirmBtn.textContent = isEdit ? t('btn.save') : t('btn.add')

    if (isEdit && !isCopy) {
        const deleteBtn = document.createElement('button')
        deleteBtn.classList.add('dialog-btn', 'dialog-btn-danger')
        deleteBtn.textContent = t('btn.delete')
        deleteBtn.addEventListener('click', () => { close(); deleteTriggerInScript(triggerIndex) })
        actions.append(deleteBtn, cancelBtn, confirmBtn)
    } else {
        actions.append(cancelBtn, confirmBtn)
    }
    // Wrap all content except the button bar in a scrollable area so the buttons
    // remain visible at the bottom without scrolling the dialog.
    const scrollContent = document.createElement('div')
    scrollContent.classList.add('dialog-scroll-content')
    while (box.firstChild) scrollContent.appendChild(box.firstChild)
    box.appendChild(scrollContent)
    box.appendChild(actions)
    box.classList.add('dialog-box-scrollable')

    overlay.appendChild(box)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    cancelBtn.addEventListener('click', close)
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })

    confirmBtn.addEventListener('click', () => {
        const newYaml = {}

        // mic — when auto-mic is active globally, preserve any existing manual value; else use checkboxes
        if (!hasAnyAutoMic()) {
            if (muteallCb.checked) {
                newYaml.mic = 'muteall'
            } else {
                const sel = [
                    ...Object.entries(groupCheckboxes).filter(([, cb]) => cb.checked).map(([n]) => n),
                    ...Object.entries(roleCheckboxes).filter(([, cb]) => cb.checked).map(([n]) => n),
                ]
                if (sel.length === 1) newYaml.mic = sel[0]
                else if (sel.length > 1) newYaml.mic = sel
            }
        } else if (existingYaml?.mic !== undefined) {
            newYaml.mic = existingYaml.mic
        }

        // music: always read from the primary seq card
        const primaryCard = seqList.querySelector('.seq-entry-card')
        const pv = primaryCard?.getValues?.() ?? {}
        let mf = pv.file || '', mf2 = pv.monitor || '', resolvedOlVal = pv.fading_point ?? 0
        if (mf) {
            if ((isEdit || isCopy) && existingYaml?.music && typeof existingYaml.music === 'object') {
                newYaml.music = { ...existingYaml.music, file: mf }
            } else {
                newYaml.music = mf
            }
            // monitor
            if (mf2) {
                if (typeof newYaml.music === 'string') newYaml.music = { file: newYaml.music }
                newYaml.music.monitor = mf2
            } else if (typeof newYaml.music === 'object') {
                delete newYaml.music.monitor
            }
        } else if (isEdit && existingYaml?.music && typeof existingYaml.music === 'object' && existingYaml.music.adjust) {
            const { file, monitor, ...rest } = existingYaml.music
            newYaml.music = rest
        }
        // fading_point
        if (resolvedOlVal > 0) {
            if (typeof newYaml.music === 'string') newYaml.music = { file: newYaml.music }
            if (typeof newYaml.music === 'object') newYaml.music.fading_point = resolvedOlVal
        } else if (typeof newYaml.music === 'object') {
            delete newYaml.music.fading_point
        }

        // note
        const noteVal = noteInput.value.trim()
        if (noteVal) newYaml.note = noteVal

        // OSC-Pfad: bestehende Felder beim Bearbeiten erhalten (UI-Feld wurde entfernt)
        if (isEdit && !isCopy && existingYaml?.osc) {
            newYaml.osc = existingYaml.osc
            if (existingYaml.osc_arg !== undefined) newYaml.osc_arg = existingYaml.osc_arg
            if (existingYaml.osc_arg_type) newYaml.osc_arg_type = existingYaml.osc_arg_type
        }

        // cue_midi + cue_osc messages (split from unified list)
        const allMsgs = [...cueMsgList.querySelectorAll('.cue-msg-card')]
            .filter(c => typeof c.getValues === 'function')
            .map(c => c.getValues())
        const midiMsgs = allMsgs.filter(m => m._isMidi).map(({ _isMidi, ...m }) => m).filter(m => m.type !== 'sysex' || m.bytes)
        const oscMsgs  = allMsgs.filter(m => m._isOsc).map(({ _isOsc, ...m }) => m).filter(m => m.path)
        if (midiMsgs.length) newYaml.cue_midi = midiMsgs
        if (oscMsgs.length)  newYaml.cue_osc  = oscMsgs

        // start_tc (only for root SLF cues; non-root members use derived TC)
        const tcVal = tcInput?.value.trim() ?? ''
        if (/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(tcVal)) newYaml.start_tc = tcVal

        // trigger_note: apply manual override from tnInput with validation
        const oldTriggerNote = existingYaml?.trigger_note
            ? { ch: existingYaml.trigger_note.ch, note: existingYaml.trigger_note.note }
            : null
        if (tnInput) {
            const raw = tnInput.value.trim()
            if (raw) {
                const parts = raw.split('.')
                const c = parseInt(parts[0]), n = parseInt(parts[1])
                const isValid = parts.length === 2 && !isNaN(c) && !isNaN(n)
                    && c >= 1 && c <= 16 && n >= 0 && n <= 127
                if (!isValid) {
                    tnInput.classList.add('tc-input-invalid')
                    tnInput.title = 'Ungültige MIDI-Note – Format: Kanal.Note (z.B. 1.42)'
                    tnInput.focus()
                    return
                }
                const myGroupRoot = groupRootOf(triggerIndex)
                const inUse = triggerYamls.some((ty, i) =>
                    i > 0 && i !== triggerIndex && groupRootOf(i) !== myGroupRoot
                    && ty?.trigger_note?.ch === c && ty?.trigger_note?.note === n)
                if (inUse) {
                    tnInput.classList.add('tc-input-invalid')
                    tnInput.title = `Note ${c}.${n} wird bereits von einem anderen Cue verwendet`
                    tnInput.focus()
                    return
                }
                tnInput.classList.remove('tc-input-invalid')
                tnInput.title = ''
                newYaml.trigger_note = { ch: c, note: n }
            }
            // empty → fall through to preserve existing below
        }

        // trigger_note: preserve when editing non-sibling; handle checkbox for siblings/copies
        // sameTnCheckbox.checked takes priority over tnInput (user explicitly chose parent note)
        if (sameTnCheckbox?.checked && parentTriggerNote) {
            newYaml.trigger_note = parentTriggerNote
        } else if (sameTnCheckbox && !sameTnCheckbox.checked && isEdit && existingYaml?.trigger_note && !newYaml.trigger_note) {
            // unchecked edit: keep existing only if it differs from parent (otherwise let assignTriggerNotes re-assign)
            const ptn = parentTriggerNote
            const wasSame = ptn && existingYaml.trigger_note.ch === ptn.ch && existingYaml.trigger_note.note === ptn.note
            if (!wasSame) newYaml.trigger_note = existingYaml.trigger_note
            // isCopy + unchecked: no trigger_note set → assignTriggerNotes assigns new one
        } else if (!sameTnCheckbox && isEdit && existingYaml?.trigger_note && !newYaml.trigger_note) {
            newYaml.trigger_note = existingYaml.trigger_note
        }
        // preserve sibling flag when editing; add it when copying
        if (isEdit && existingYaml?.sibling) newYaml.sibling = true
        if (isCopy) newYaml.sibling = true
        // preserve auto_trigger when editing or copying (variants share the same auto-cue point)
        if (existingYaml?.auto_trigger) newYaml.auto_trigger = existingYaml.auto_trigger
        // preserve S/L/F links — managed by the S/L/F button, not the edit dialog
        if (isEdit && existingYaml?.chain_end)  newYaml.chain_end  = existingYaml.chain_end
        if (isEdit && existingYaml?.loop_outro) newYaml.loop_outro = existingYaml.loop_outro
        // music_seq: collect additional cards (skip first = primary) when seq-loop, else preserve
        if (isSeqLoop) {
            const allCards = [...seqList.querySelectorAll('.seq-entry-card')]
                .filter(c => typeof c.getValues === 'function')
            // First card = primary (already saved to music:), rest = music_seq
            const seqEntries = allCards.slice(1)
                .map(c => c.getValues())
                .filter(e => e.file)
                .map(e => {
                    const obj = { file: e.file }
                    if (e.monitor) obj.monitor = e.monitor
                    if (e.fading_point > 0) obj.fading_point = e.fading_point
                    return obj
                })
            if (seqEntries.length > 0) newYaml.music_seq = seqEntries
            // if seqEntries is empty, music_seq key is omitted → removes it from YAML
        } else if (isEdit && existingYaml?.music_seq) {
            newYaml.music_seq = existingYaml.music_seq
        }
        // cue_midi and cue_osc are already collected from the UI above; no separate preservation needed

        close()
        if (isEdit) {
            editTriggerInScript(triggerIndex, newYaml, oldTriggerNote)
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
    titleEl.textContent = t('dlg.adjust.title')
    box.appendChild(titleEl)

    // ── Bezugs-Trigger ──────────────────────────────────────────────
    const targetWrap = document.createElement('div')
    targetWrap.classList.add('dialog-field')
    const targetLbl = document.createElement('label')
    targetLbl.textContent = t('dlg.adjust.target')
    const targetInfo = document.createElement('div')
    targetInfo.style.cssText = 'margin: 0.3rem 0 0.5rem; font-size: 0.9rem; color: #abb2bf'
    function refreshTargetInfo(idx) {
        const ty = triggerYamls[idx] ?? null
        if (ty && ty.trigger_note) {
            const tn = ty.trigger_note
            const mf = ty.music ? (typeof ty.music === 'string' ? ty.music : ty.music.file) : null
            targetInfo.textContent = `${tn.ch}.${tn.note}` + (mf ? `  –  ${mf}` : '')
        } else {
            targetInfo.textContent = t('dlg.adjust.target.none')
        }
    }
    refreshTargetInfo(targetIdx)
    const repickBtn = document.createElement('button')
    repickBtn.classList.add('dialog-btn')
    repickBtn.textContent = t('dlg.adjust.repick')
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
    actionLbl.textContent = t('dlg.adjust.action')
    actionWrap.appendChild(actionLbl)

    const fadeoutLbl = document.createElement('label')
    fadeoutLbl.classList.add('dialog-loop-label')
    const fadeoutRb = document.createElement('input')
    fadeoutRb.type = 'radio'; fadeoutRb.name = `adj-${triggerIndex}`; fadeoutRb.value = 'fadeout'
    fadeoutLbl.append(fadeoutRb, t('dlg.adjust.fadeout'))

    const volLbl = document.createElement('label')
    volLbl.classList.add('dialog-loop-label')
    const volRb = document.createElement('input')
    volRb.type = 'radio'; volRb.name = `adj-${triggerIndex}`; volRb.value = 'volume'
    const volInput = document.createElement('input')
    volInput.type = 'number'; volInput.min = '0'; volInput.max = '1'; volInput.step = '0.01'
    volInput.value = existingAdj?.volume ?? '0.5'
    volInput.style.cssText = 'width: 5rem; margin-left: 0.5rem'
    volInput.classList.add('dialog-volume-inline')
    volLbl.append(volRb, t('dlg.adjust.volume'), volInput)

    if (existingAdj?.volume !== undefined) volRb.checked = true
    else fadeoutRb.checked = true

    actionWrap.append(fadeoutLbl, volLbl)
    box.appendChild(actionWrap)

    // ── Fadezeit ─────────────────────────────────────────────────────
    const fadeTimeWrap = document.createElement('div')
    fadeTimeWrap.classList.add('dialog-field')
    const fadeTimeLbl = document.createElement('label')
    fadeTimeLbl.textContent = t('dlg.adjust.fadetime')
    const fadeTimeInput = document.createElement('input')
    fadeTimeInput.type = 'number'; fadeTimeInput.min = '0'; fadeTimeInput.step = '0.5'
    fadeTimeInput.value = existingAdj?.fadetime ?? 3
    fadeTimeInput.style.cssText = 'width: 5rem; margin-left: 0.5rem'
    fadeTimeInput.classList.add('dialog-volume-inline')
    fadeTimeWrap.append(fadeTimeLbl, fadeTimeInput)
    box.appendChild(fadeTimeWrap)

    // ── Buttons ─────────────────────────────────────────────────────
    const actions = document.createElement('div')
    actions.classList.add('dialog-actions')
    const cancelBtn = document.createElement('button')
    cancelBtn.classList.add('dialog-btn')
    cancelBtn.textContent = t('btn.cancel')
    const saveBtn = document.createElement('button')
    saveBtn.classList.add('dialog-btn', 'dialog-btn-primary')
    saveBtn.textContent = t('btn.save')
    if (existingAdj) {
        const delBtn = document.createElement('button')
        delBtn.classList.add('dialog-btn', 'dialog-btn-danger')
        delBtn.textContent = t('dlg.adjust.remove')
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
        const ft = parseFloat(fadeTimeInput.value)
        if (!isNaN(ft) && ft !== 3) adjConfig.fadetime = ft
        close()
        setAdjustOnTrigger(triggerIndex, triggerYamls[triggerIndex], adjConfig)
    })
}

function isOutroTrigger(idx) {
    for (let i = 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]?.loop_outro) continue
        if (findTriggerByNote(triggerYamls[i].loop_outro) === idx) return true
    }
    return false
}

function setOutroPendingIndicator(idx, on) {
    const el = triggers[idx]
    if (el) el.classList.toggle('trigger-outro-pending', on)
}

function setArmedCue(idx) {
    if (armedCue !== null && triggers[armedCue]) triggers[armedCue].classList.remove('trigger-armed')
    armedCue = idx
    if (armedCue !== null && triggers[armedCue]) triggers[armedCue].classList.add('trigger-armed')
}

function setShowLock(locked) {
    showLock = locked
    document.body.classList.toggle('show-locked', locked)
    document.querySelector('.lock-button')?.classList.toggle('active', locked)
    if (locked && inlineEditor) closeEditor(false)
}

let _lockHintTimer = null
function showLockHint(e) {
    let hint = document.getElementById('lock-hint')
    if (!hint) {
        hint = document.createElement('div')
        hint.id = 'lock-hint'
        hint.textContent = t('lock.hint') || 'Gesperrt'
        document.body.appendChild(hint)
    }
    hint.style.left = (e.clientX + 14) + 'px'
    hint.style.top  = (e.clientY + 6)  + 'px'
    hint.style.opacity = '1'
    clearTimeout(_lockHintTimer)
    _lockHintTimer = setTimeout(() => { hint.style.opacity = '0' }, 1200)
}

// Returns list of trigger indices whose loop_outro points to idx
function loopSourcesOf(idx) {
    const sources = []
    for (let i = 1; i < triggerYamls.length; i++) {
        if (triggerYamls[i]?.loop_outro && findTriggerByNote(triggerYamls[i].loop_outro) === idx) sources.push(i)
    }
    return sources
}

function updateLoopBtnAppearance(btn, idx) {
    const ty = triggerYamls[idx]
    const hasCE  = !!ty?.chain_end
    const hasLO  = !!ty?.loop_outro
    const sources = loopSourcesOf(idx)   // loop triggers that treat this as their outro
    const isOutro = sources.length > 0

    if (shiftHeld && (hasCE || hasLO)) {
        btn.textContent = '✕ S/L/F'
        btn.classList.remove('trigger-action-btn-active')
        btn.classList.add('trigger-action-btn-danger')
        btn.title = t('btn.loopgrp.delete.title')
        return
    }
    btn.classList.remove('trigger-action-btn-danger')
    btn.classList.add('trigger-action-btn-active')

    if (hasCE && isOutro) {
        const ce = `${ty.chain_end.ch}.${ty.chain_end.note}`
        const from = sources.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
        btn.textContent = 'Bridge'
        btn.title = t('btn.loopgrp.bridge.title').replace('%1', from).replace('%2', ce)
    } else if (hasCE) {
        const ce = `${ty.chain_end.ch}.${ty.chain_end.note}`
        btn.textContent = 'Start'
        btn.title = t('btn.loopgrp.start.title').replace('%1', ce)
    } else if (hasLO) {
        const lo = `${ty.loop_outro.ch}.${ty.loop_outro.note}`
        btn.textContent = 'Loop'
        btn.title = t('btn.loopgrp.loop.title').replace('%1', lo)
    } else if (isOutro) {
        const from = sources.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
        btn.textContent = 'Finish'
        btn.title = t('btn.loopgrp.finish.title').replace('%1', from)
    } else {
        btn.textContent = 'S/L/F'
        btn.classList.remove('trigger-action-btn-active')
        btn.title = t('btn.loopgrp.title')
    }

    // WAV warning: gapless playback only works with WAV files
    const musicFile  = triggerAudio.get(idx)?.musicFile
    const mpLoop     = !!triggerAudio.get(idx)?.mp?.loop
    const isSLF      = hasCE || hasLO || isOutro   // part of a S/L/F group
    const isGapless  = isSLF || mpLoop
    const nonWav     = !!(musicFile && !/\.wav$/i.test(musicFile))
    // S/L/F button warning only for actual S/L/F structure — plain mp.loop uses the ⟳ button
    btn.classList.toggle('trigger-action-btn-wav-warning', isSLF && nonWav)
    if (isSLF && nonWav)
        btn.title += '\n⚠ Kein nahtloser Übergang – MP3/AAC haben Encoder-Padding. WAV verwenden.'
    const warnEl = triggers[idx]?.querySelector('.trigger-wav-warning')
    if (warnEl) warnEl.style.display = (isGapless && nonWav) ? '' : 'none'
}

function updateLoopGroupInScript(triggerIndex, key, value) {
    let blockIdx = 0
    const keyRe = new RegExp(`^${key}:[ \\t]*\\{[^\\n]*\\}[ \\t]*\\n?`, 'm')
    const updated = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIdx++
        if (blockIdx !== triggerIndex + 1) return match
        let c = content.replace(keyRe, '').replace(/\n{3,}/g, '\n\n')
        if (value !== null) c = c.trimEnd() + `\n${key}: {ch: ${value.ch}, note: ${value.note}}\n`
        return `\`\`\`yaml\n${c}\`\`\``
    })
    scriptText = updated
    writeScriptMd(updated)
    if (triggerYamls[triggerIndex]) {
        if (value !== null) triggerYamls[triggerIndex][key] = value
        else delete triggerYamls[triggerIndex][key]
    }
    // Remove start_tc from the target trigger (TC is now auto-computed from chain)
    if (value !== null) {
        const targetIdx = findTriggerByNote(value)
        if (targetIdx !== null && triggerYamls[targetIdx]?.start_tc) {
            // Remove start_tc from target in both YAML and script
            let blockIdx2 = 0
            const startTcRe = /^start_tc:[ \t]*[^\n]*\n?/m
            scriptText = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
                blockIdx2++
                if (blockIdx2 !== targetIdx + 1) return match
                const c = content.replace(startTcRe, '').replace(/\n{3,}/g, '\n\n')
                return `\`\`\`yaml\n${c}\`\`\``
            })
            writeScriptMd(scriptText)
            if (triggerYamls[targetIdx]) delete triggerYamls[targetIdx].start_tc
        }
    }
    for (const [idx, btn] of loopBtns) updateLoopBtnAppearance(btn, idx)
    for (const [idx, fn] of slfGripUpdaters) fn()
}

function fadeOutAndStop(cueIdx) {
    const ta = triggerAudio.get(cueIdx)
    if (!ta || !ta.ws.isPlaying()) return
    const originalVol = ta.mp?.volume ?? 1
    const start = performance.now()
    const tick = () => {
        const t = Math.min(1, (performance.now() - start) / 500)
        const v = originalVol * (1 - t)
        ta.ws.setVolume(v)
        if (t < 1) {
            requestAnimationFrame(tick)
        } else {
            ta.ws.stop()
            ta.ws.setVolume(originalVol)
        }
    }
    requestAnimationFrame(tick)
}

function showLoopGroupDialog(index, anchorBtn) {
    const existing = triggerYamls[index]
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2000'
    const box = document.createElement('div')
    box.className = 'loop-dialog'
    const rect = anchorBtn.getBoundingClientRect()
    box.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:2001`

    const close = () => { overlay.remove(); box.remove() }
    overlay.addEventListener('click', close)

    const makeOption = (html, onClick) => {
        const btn = document.createElement('button')
        btn.className = 'loop-dialog-option'
        btn.innerHTML = html
        btn.addEventListener('click', e => { e.stopPropagation(); close(); onClick() })
        return btn
    }

    box.appendChild(makeOption(
        '<strong>→ Übergang am Ende</strong><small>Startet automatisch einen anderen Trigger, wenn dieses Audio endet (z.B. Intro → Loop, Zwischenspiel → Loop)</small>',
        () => enterPickMode(targetIdx => {
            if (targetIdx === index) return
            updateLoopGroupInScript(index, 'chain_end', triggerYamls[targetIdx]?.trigger_note ?? null)
        })
    ))
    box.appendChild(makeOption(
        '<strong>⟲ Schleife</strong><small>Loopt diesen Trigger, bis ein gewählter Outro-Trigger am Schleifen-Ende nahtlos übernimmt</small>',
        () => enterPickMode(outroIdx => {
            if (outroIdx === index) return
            updateLoopGroupInScript(index, 'loop_outro', triggerYamls[outroIdx]?.trigger_note ?? null)
        })
    ))

    if (existing?.chain_end || existing?.loop_outro) {
        const removeBtn = document.createElement('button')
        removeBtn.className = 'loop-dialog-option loop-dialog-danger'
        removeBtn.textContent = '✕ Verbindung entfernen'
        removeBtn.addEventListener('click', e => {
            e.stopPropagation(); close()
            if (existing.chain_end) updateLoopGroupInScript(index, 'chain_end', null)
            if (existing.loop_outro) updateLoopGroupInScript(index, 'loop_outro', null)
        })
        box.appendChild(removeBtn)
    }

    document.body.append(overlay, box)
}

function triggerAction(cue) {
    // Second press while playing → stop (undo accidental trigger)
    const ta = triggerAudio.get(cue)
    const _seqData = triggerSeqSlots.get(cue)
    const _seqActive = _seqData && _seqData.total > 1 && _seqData.idx > 0
    if (ta && (ta.ws.isPlaying() || _seqActive)) {
        ta.stopAndReset()
        if (mtc && mtc.activeTcIndex === cue) mtc.stopAndClear()
        return
    }

    // Outro-interception: if this trigger is the outro for a currently-playing managed loop,
    // queue it instead of playing immediately. Second click cancels the queue.
    for (let i = 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]?.loop_outro) continue
        if (findTriggerByNote(triggerYamls[i].loop_outro) !== cue) continue
        const loopTa = triggerAudio.get(i)
        const _seqData = triggerSeqSlots.get(i)
        const _loopActive = loopTa?.ws.isPlaying() || (_seqData && _seqData.total > 1 && _seqData.idx > 0)
        if (!_loopActive) continue
        if (loopOutroPending.get(i) === cue) {
            // Second click → cancel pending
            loopOutroPending.delete(i)
            loopOutroInitialRemaining.delete(i)
            setOutroPendingIndicator(cue, false)
        } else {
            // Record how much loop time remains right now (= full bar duration)
            const _armInfo = getLoopSlotInfo(i)
            if (_armInfo) {
                const { loopStart: lStart, loopEnd: lEnd, currentTime: ct } = _armInfo
                const range = lEnd - lStart
                const pos   = range > 0 ? ((ct - lStart) % range + range) % range : 0
                loopOutroInitialRemaining.set(i, Math.max(0, range - pos))
            }
            loopOutroPending.set(i, cue)
            setOutroPendingIndicator(cue, true)
            loopTa.armOutroTimer?.()
        }
        broadcastLiveState()
        return
    }

    const _ty = triggerYamls[cue]
    const _micFire = getMicForCue(cue)
    if (_micFire !== undefined && _micFire !== null) effectiveMics = _micFire

    x32UnmuteChannels(_micFire)

    const startTc = triggerYamls[cue].start_tc
    if (startTc && mtc && mtc.activeTcIndex !== null && mtc.activeTcIndex !== cue) {
        // Stop and reset any other trigger that was the TC source
        const prevAudio = triggerAudio.get(mtc.activeTcIndex)
        if (prevAudio) prevAudio.ws.stop()
        mtc.stop()
    }

    playMusic(cue)
    sendTriggerNote(cue)
    sendOscMessage(cue)
    sendCueMidiMessages(cue)
    sendCueOscMessages(cue)

    if (startTc && mtc) {
        if (ta) mtc.start(startTc, ta.ws, cue, ta.mp?.start ?? 0)
    }

    // Auto-compute TC for chain targets (no explicit start_tc, but chained from active TC source)
    if (!startTc && mtc && mtc.activeTcIndex !== null && ta) {
        const srcTy = triggerYamls[mtc.activeTcIndex]
        const isChainEnd = srcTy?.chain_end && findTriggerByNote(srcTy.chain_end) === cue
        const isOutro    = srcTy?.loop_outro && findTriggerByNote(srcTy.loop_outro) === cue
        if (isChainEnd || isOutro) {
            const frames    = mtc.getCurrentFrames()
            const startSec  = ta.mp?.start ?? 0
            mtc.startFromFrames(frames, ta.ws, cue, startSec)
        }
    }

    cueHistory.push(cue)
    cueHistoryAuto.push(pendingAutoTrigger)
    pendingAutoTrigger = false
    broadcastLiveState()

    // Pre-decode next audio in background for gapless playback
    const gaplessNote = triggerYamls[cue]?.chain_end || triggerYamls[cue]?.loop_outro
    if (gaplessNote) {
        const gaplessIdx = findTriggerByNote(gaplessNote)
        if (gaplessIdx !== null) preDecodeForGapless(gaplessIdx)
    }
}

function applyRoleColorsToHtml(html) {
    const div = document.createElement('div')
    div.innerHTML = html
    for (const p of div.querySelectorAll('p')) {
        if (p.firstChild?.tagName !== 'STRONG') continue
        const strong = p.firstChild
        const names = strong.textContent.split('/').map(s => s.trim()).filter(Boolean)
        const roles = names.map(n => config.roles?.[n])
        const firstRole = roles.find(Boolean)
        const firstGroupIdx = !firstRole ? names.findIndex(n => isGroup(n)) : -1
        if (!firstRole && firstGroupIdx < 0) continue
        const primaryColor = firstRole ? firstRole.color : getGroupColor(names[firstGroupIdx])
        if (primaryColor) p.classList.add('color-' + primaryColor)
        if (names.length > 1) {
            strong.innerHTML = ''
            for (let i = 0; i < names.length; i++) {
                if (i > 0) {
                    const sep = document.createElement('span')
                    sep.className = 'role-name-sep'
                    sep.textContent = ' / '
                    strong.appendChild(sep)
                }
                const span = document.createElement('span')
                span.textContent = names[i]
                const role = config.roles?.[names[i]]
                const color = role ? role.color : (isGroup(names[i]) ? getGroupColor(names[i]) : null)
                if (color) span.className = 'color-' + color
                strong.appendChild(span)
            }
        }
    }
    return div.innerHTML
}

// Returns { currentTime, loopStart, loopEnd } for the active slot of a loop cue.
// For seq-loops with a non-primary slot playing, derives position from AudioContext arithmetic.
// loopEnd = fading_point when set, so progress bars cycle start→fading_point.
function getLoopSlotInfo(loopIdx) {
    const loopTa  = triggerAudio.get(loopIdx)
    if (!loopTa) return null
    const seqData = triggerSeqSlots.get(loopIdx)
    const slotIdx = seqData?.idx ?? 0

    if (seqData && slotIdx > 0) {
        const slot = seqData.slots[slotIdx]
        const { startedAt, startOffset } = slot.getActiveSourceInfo()
        const ct = (startedAt !== null && sharedAudioCtx)
            ? startOffset + (sharedAudioCtx.currentTime - startedAt)
            : (slot.mp.start ?? 0)
        const fp = slot.mp.fading_point ?? 0
        return {
            currentTime: Math.max(0, ct),
            loopStart:   slot.mp.start ?? 0,
            loopEnd:     fp > 0 ? fp : (slot.mp.end ?? (slot.decodedBuffer?.duration ?? 0)),
        }
    }

    const lmp = loopTa.mp
    const fp  = lmp?.fading_point ?? 0
    return {
        currentTime: loopTa.getPlaybackTime?.() ?? (loopTa.mainAudioEl?.currentTime ?? 0),
        loopStart:   lmp?.start ?? 0,
        loopEnd:     fp > 0 ? fp : (lmp?.end ?? (loopTa.ws.getDuration() ?? 0)),
    }
}

function broadcastLiveState() {
    if (!window.electronAPI?.sendLiveState) return

    // If currentCue is a pending outro, treat the loop as still current for live display
    // so the live view only scrolls when the loop actually ends and the outro fires.
    let liveCurrent = currentCue
    let liveNextOverride = null
    for (const [loopIdx, outroIdx] of loopOutroPending) {
        if (outroIdx === currentCue) {
            liveCurrent = loopIdx
            liveNextOverride = outroIdx
            break
        }
    }

    // Next cue to fire: armed cue takes priority over normal next-cue calculation
    let nextCue = liveNextOverride ?? armedCue
    if (nextCue === null) {
        for (let i = liveCurrent + 1; i < triggerYamls.length; i++) {
            if (triggerYamls[i] && !triggerYamls[i].sibling) { nextCue = i; break }
        }
    }

    const rawBlocks = tokenizeScript(scriptText)
    const liveBlocks = []
    let yamlCount = 0
    // For progress bar: track headings (h1/h2) and cue count
    const _progressHeadings = []  // { afterCueIdx, label }
    let _progressCueCount = 0
    for (const b of rawBlocks) {
        if (b.type === 'yaml') {
            yamlCount++
            if (yamlCount === 1) continue  // config block
            _progressCueCount++
            const cueIdx = yamlCount - 1
            const ty = triggerYamls[cueIdx]
            if (!ty) continue

            const anyAutoMic = hasAnyAutoMic()
            const rawMicVal = ty.auto_mic ? getMicForCue(cueIdx) : (!anyAutoMic ? ty.mic : undefined)
            const muteallCue = rawMicVal === 'muteall'
            const micColors = (rawMicVal === undefined || muteallCue) ? null : groupRolesForDisplay(rawMicVal, micGroupDisplay)

            const musicLabel = typeof ty.music === 'string' ? ty.music :
                ty.music?.file ? ty.music.file : null
            let musicAdjust = null
            if (ty.music?.adjust) {
                const adjTn = ty.music.adjust.trigger_note
                const adjRef = adjTn ? `${adjTn.ch}.${adjTn.note}` : '?'
                if (ty.music.adjust.fadeout) musicAdjust = `⇢ ${adjRef} ausfaden`
                else if (ty.music.adjust.volume !== undefined) musicAdjust = `⇢ ${adjRef} auf ${Math.round(ty.music.adjust.volume * 100)}%`
            }
            const triggerNoteLabel = ty.trigger_note
                ? `${ty.trigger_note.ch}.${ty.trigger_note.note}` : null

            // Check if this trigger is a pending outro (armed and waiting for loop to finish)
            let outroPending = null
            for (const [loopIdx, outroIdx] of loopOutroPending) {
                if (outroIdx === cueIdx) {
                    const slotInfo = getLoopSlotInfo(loopIdx)
                    if (slotInfo) {
                        const { loopStart: lStart, loopEnd: lEnd, currentTime: ct } = slotInfo
                        const range = lEnd - lStart
                        const pos   = range > 0 ? ((ct - lStart) % range + range) % range : 0
                        outroPending = { remaining: Math.max(0, range - pos), initialRemaining: loopOutroInitialRemaining.get(loopIdx) ?? range }
                    }
                    break
                }
            }

            // Check if this cue will be auto-fired by a currently playing source
            let autoCuePending = null
            const aty = ty.auto_trigger
            if (aty?.trigger_note) {
                const srcIdx = findTriggerByNote(aty.trigger_note)
                if (srcIdx !== null) {
                    const srcRoot = groupRootOf(srcIdx)
                    for (let j = srcRoot; j < triggerYamls.length; j++) {
                        if (j !== srcRoot && !triggerYamls[j]?.sibling) break
                        const srcTa = triggerAudio.get(j)
                        if (srcTa?.ws.isPlaying()) {
                            const ct = srcTa.mainAudioEl?.currentTime ?? 0
                            if (ct < aty.at) autoCuePending = { currentTime: ct, at: aty.at }
                            break
                        }
                    }
                }
            }
            // Check if this cue is the chain_end target of a currently playing Start cue (S→L transition)
            if (!autoCuePending) {
                for (let i = 1; i < triggerYamls.length; i++) {
                    const srcTy = triggerYamls[i]
                    if (!srcTy?.chain_end) continue
                    if (findTriggerByNote(srcTy.chain_end) !== cueIdx) continue
                    const srcTa = triggerAudio.get(i)
                    if (srcTa?.ws.isPlaying()) {
                        const ct  = srcTa.mainAudioEl?.currentTime ?? 0
                        const end = srcTa.mp?.end ?? srcTa.ws.getDuration() ?? 0
                        autoCuePending = { currentTime: ct, at: end }
                    }
                    break
                }
            }

            const hasCE   = !!ty.chain_end
            const hasLO   = !!ty.loop_outro
            const slfSrcs = loopSourcesOf(cueIdx)
            const isOutro = slfSrcs.length > 0
            let slfLabel  = null
            if (hasCE && isOutro) {
                const ce   = `${ty.chain_end.ch}.${ty.chain_end.note}`
                const from = slfSrcs.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
                slfLabel = { role: 'Bridge', detail: `← ${from} → ${ce}` }
            } else if (hasCE) {
                slfLabel = { role: 'Start',  detail: `→ ${ty.chain_end.ch}.${ty.chain_end.note}` }
            } else if (hasLO) {
                slfLabel = { role: 'Loop',   detail: `↩ ${ty.loop_outro.ch}.${ty.loop_outro.note}` }
            } else if (isOutro) {
                const from = slfSrcs.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
                slfLabel = { role: 'Finish', detail: `← ${from}` }
            }

            liveBlocks.push({
                type: 'trigger',
                cueIdx,
                isCurrent: cueIdx === liveCurrent,
                isNext: cueIdx === nextCue,
                isSibling: !!ty.sibling,
                isPlaying: triggerAudio.get(cueIdx)?.isAudioActive?.() ?? false,
                micColors,
                muteall: muteallCue,
                musicLabel, musicAdjust,
                oscPath: ty.osc || null,
                oscArg: (ty.osc && ty.osc_arg !== undefined && ty.osc_arg !== '') ? String(ty.osc_arg) : null,
                oscArgType: ty.osc_arg_type || null,
                note: ty.note || null,
                triggerNoteLabel,
                outroPending,
                autoCuePending,
                slfLabel,
                cueMidi: ty.cue_midi || null,
                cueOsc:  ty.cue_osc  || null,
            })
        } else {
            const hm = b.content.match(/^(#{1,2}) (.+)/)
            if (hm) _progressHeadings.push({ afterCueIdx: _progressCueCount, label: hm[2].trim(), level: hm[1].length })
            liveBlocks.push({
                type: 'text',
                html: applyRoleColorsToHtml(makeHtmlSafe(b.content)),
            })
        }
    }

    // Build progress segments from headings
    const _progressSegs = []
    if (_progressHeadings.length === 0) {
        if (_progressCueCount > 0) _progressSegs.push({ label: null, startCue: 1, cueCount: _progressCueCount })
    } else {
        if (_progressHeadings[0].afterCueIdx > 0)
            _progressSegs.push({ label: null, level: null, startCue: 1, cueCount: _progressHeadings[0].afterCueIdx })
        for (let i = 0; i < _progressHeadings.length; i++) {
            const start = _progressHeadings[i].afterCueIdx + 1
            const end = i + 1 < _progressHeadings.length ? _progressHeadings[i + 1].afterCueIdx : _progressCueCount
            if (end >= start) _progressSegs.push({ label: _progressHeadings[i].label, level: _progressHeadings[i].level, startCue: start, cueCount: end - start + 1 })
        }
    }

    // Audio progress for all playing cues
    const audioProgress = []
    for (const [cueIdx, ta] of triggerAudio) {
        if (!ta.isAudioActive?.()) continue
        const ty = triggerYamls[cueIdx]
        const { mp } = ta
        const seqData  = triggerSeqSlots.get(cueIdx)
        const slotInfo = getLoopSlotInfo(cueIdx)
        const isLoop   = !!(ty?.loop_outro || mp?.loop || (seqData?.total > 1))
        const tailInfo = ta.getTailInfo?.()
        audioProgress.push({
            cueIdx,
            label: (typeof ty?.music === 'string' ? ty.music : ty?.music?.file) || ('Cue ' + cueIdx),
            currentTime: slotInfo?.currentTime ?? (ta.getPlaybackTime?.() ?? (ta.mainAudioEl?.currentTime ?? 0)),
            loopStart:   slotInfo?.loopStart   ?? (mp?.start ?? 0),
            loopEnd:     slotInfo?.loopEnd      ?? (mp?.end   ?? (ta.ws.getDuration() ?? 0)),
            isLoop,
            volume: ta.getCurrentVolume?.() ?? (mp?.volume ?? 0.8),
            tailRemaining: tailInfo?.active ? tailInfo.remaining : null,
        })
    }

    const tcFrames = (mtc && mtc.activeTcIndex !== null && mtc.wsRef)
        ? mtc.getCurrentFrames()
        : null
    // Build effective mic display from effectiveMics
    let effectiveMicColors = null
    if (effectiveMics && effectiveMics !== 'muteall') {
        effectiveMicColors = groupRolesForDisplay(effectiveMics, micGroupDisplay)
    }

    // Compute per-device effective states from cue history
    const _devStatesMap = computeEffectiveDeviceStates(cueHistory)
    // Sort by settings order: MIDI devices first (in settings order), then OSC devices
    const _deviceOrder = new Map()
    midiOutputDevices.forEach((d, i) => _deviceOrder.set('midi:' + d.name, i))
    oscOutputDevices.forEach((d, i)  => _deviceOrder.set('osc:'  + d.name, midiOutputDevices.length + i))
    const effectiveDeviceStatesArr = Array.from(_devStatesMap.values())
        .sort((a, b) => {
            const ka = (a.type === 'midi' ? 'midi:' : 'osc:') + a.device
            const kb = (b.type === 'midi' ? 'midi:' : 'osc:') + b.device
            return (_deviceOrder.get(ka) ?? 9999) - (_deviceOrder.get(kb) ?? 9999)
        })

    // Build device color lookup
    const deviceColors = {}
    for (const d of midiOutputDevices) { if (d.color) deviceColors['midi:' + d.name] = d.color }
    for (const d of oscOutputDevices)  { if (d.color) deviceColors['osc:'  + d.name] = d.color }

    // Known device name sets for unknown-device warnings in live view
    const knownMidiDevices = midiOutputDevices.map(d => d.name)
    const knownOscDevices  = oscOutputDevices.map(d => d.name)

    window.electronAPI.sendLiveState({
        blocks: liveBlocks,
        currentCue: liveCurrent,
        nextCue,
        selectedVariant,
        timecodeFrames: tcFrames,
        audioProgress,
        appLanguage,
        effectiveDeviceStates: effectiveDeviceStatesArr,
        deviceColors,
        knownMidiDevices,
        knownOscDevices,
        effectiveMuteall: effectiveMics === 'muteall',
        effectiveMicColors: effectiveMics === 'muteall' ? null : (effectiveMicColors ?? undefined),
        hasMicState: effectiveMics !== null,
        showProgress: { current: liveCurrent, total: _progressCueCount, segments: _progressSegs },
    })
}

function goAction() {
    if (armedCue !== null) {
        const cue = armedCue
        setArmedCue(null)
        currentCue = cue
        markTriggers(cue)
        scrollToTrigger(cue)
        triggerAction(cue)
        return
    }
    for (let i = currentCue + 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]) continue
        if (triggerYamls[i].sibling) continue  // skip non-root variants — only reachable via selectedVariant
        // If a variant was chosen for this group, fire it instead of the first sibling
        if (selectedVariant !== null) {
            let sv = selectedVariant
            selectedVariant = null
            let inGroup = false
            for (let j = i; j < triggerYamls.length && (j === i || triggerYamls[j]?.sibling); j++) {
                if (j === sv) { inGroup = true; break }
            }
            if (inGroup) { currentCue = sv; markTriggers(sv); scrollToTrigger(sv); triggerAction(sv); return }
        }
        selectedVariant = null
        currentCue = i
        markTriggers(i)
        scrollToTrigger(i)
        triggerAction(i)
        return
    }
}

function backAction() {
    // If a Finish or Bridge is armed (waiting for loop end), only cancel the arming —
    // leave the loop running and do not navigate back.
    if (loopOutroPending.size > 0) {
        let outroToRearm = null
        for (const [loopIdx, outroIdx] of loopOutroPending) {
            loopOutroInitialRemaining.delete(loopIdx)
            setOutroPendingIndicator(outroIdx, false)
            outroToRearm = outroIdx
        }
        loopOutroPending.clear()
        setArmedCue(outroToRearm)
        broadcastLiveState()
        return
    }

    setArmedCue(null)
    if (cueHistory.length < 1) return

    // Pop auto-triggered cues AND the last manually triggered cue in one go,
    // so Back always reverts to the previous manual state.
    const popped = []
    while (cueHistory.length > 0) {
        const idx   = cueHistory.pop()
        const isAuto = cueHistoryAuto.pop() ?? false
        popped.push(idx)
        if (!isAuto) break   // stop after the first non-auto entry
    }

    // Undo each popped cue's effects (audio, loop outro queues, music.adjust)
    for (const pIdx of popped) {
        fadeOutAndStop(pIdx)

        for (const [loopIdx, outroIdx] of loopOutroPending) {
            if (outroIdx === pIdx) {
                loopOutroPending.delete(loopIdx)
                loopOutroInitialRemaining.delete(loopIdx)
                setOutroPendingIndicator(pIdx, false)
            }
        }

        const pMusic = triggerYamls[pIdx]?.music
        if (typeof pMusic === 'object' && pMusic.adjust) {
            const adjIdx = findTriggerByNote(pMusic.adjust.trigger_note)
            if (adjIdx !== null) {
                const adjTa = triggerAudio.get(adjIdx)
                if (adjTa) {
                    const adjIsLoop = adjTa.mp?.loop || !!triggerYamls[adjIdx]?.loop_outro
                    if (pMusic.adjust.fadeout && adjIsLoop) {
                        cancelWsFade(adjTa.ws)
                        adjTa.enableLoop()
                        if (!adjTa.ws.isPlaying()) playMusic(adjIdx)
                    } else if (pMusic.adjust.volume !== undefined && adjTa.ws.isPlaying()) {
                        cancelWsFade(adjTa.ws)
                        fadeAdjustVolume(adjTa, adjTa.mp.volume, pMusic.adjust.fadetime ?? 3)
                    }
                }
            }
        }
    }

    // Collect device keys touched by the popped cues
    const poppedDeviceKeys = new Set()
    for (const pIdx of popped) {
        const ty = triggerYamls[pIdx]
        if (ty?.cue_midi?.length) {
            for (const msg of ty.cue_midi) {
                poppedDeviceKeys.add('midi:' + (msg.device || midiOutputDevices[0]?.name || ''))
            }
        }
        if (ty?.cue_osc?.length) {
            for (const msg of ty.cue_osc) {
                const dev = oscOutputDevices.find(d => d.name === (msg.device || '')) ?? oscOutputDevices[0]
                poppedDeviceKeys.add('osc:' + (dev?.name || ''))
            }
        }
    }

    const prev = cueHistory.length > 0 ? cueHistory[cueHistory.length - 1] : null

    if (prev !== null) {
        x32UnmuteChannels(getMicForCue(prev))
        // Restart prev's audio if it was a loop (simple mp.loop or managed loop_outro)
        const prevTa = triggerAudio.get(prev)
        const prevIsLoop = prevTa?.mp?.loop || !!triggerYamls[prev]?.loop_outro
        if (prevTa && !prevTa.ws.isPlaying() && prevIsLoop) playMusic(prev)
        currentCue = prev
        markTriggers(prev)
    } else {
        x32UnmuteChannels('muteall')
        currentCue = 0
        markTriggers(0)
    }

    // Recompute effectiveMics from remaining history
    effectiveMics = null
    for (let i = cueHistory.length - 1; i >= 0; i--) {
        const m = getMicForCue(cueHistory[i])
        if (m !== undefined && m !== null) { effectiveMics = m; break }
    }

    // Resend previous device messages for any device touched by the popped cues
    if (poppedDeviceKeys.size > 0) {
        const prevDevStates = computeEffectiveDeviceStates(cueHistory)
        for (const key of poppedDeviceKeys) {
            const state = prevDevStates.get(key)
            if (!state) continue
            if (state.type === 'midi') _sendMidiMsgArray(state.messages)
            else if (state.type === 'osc') _sendOscMsgArray(state.messages)
        }
    }

    broadcastLiveState()
}

function sendTriggerNote(cue) {
    const tn = triggerYamls[cue].trigger_note
    if (!tn) return
    for (let i = 0; i < midiOutputDevices.length; i++) {
        if (!midiOutputDevices[i].sendTriggerNote) continue
        if (midiOutputDevices[i].enabled === false) continue
        const port = midiOutputPorts[i]
        if (!port) continue
        port.send([0x90 | (tn.ch - 1), tn.note, 100])
        setTimeout(() => port.send([0x80 | (tn.ch - 1), tn.note, 0]), 100)
    }
}

function sendOscMessage(cue) {
    if (!window.electronAPI?.sendOsc) return
    const ty = triggerYamls[cue]
    if (!ty) return
    let oscPath, args = []
    if (ty.osc) {
        oscPath = ty.osc
        if (ty.osc_arg !== undefined && ty.osc_arg !== '') {
            const type = ty.osc_arg_type || 'string'
            if (type === 'int')         args.push(parseInt(ty.osc_arg)   || 0)
            else if (type === 'float')  args.push(parseFloat(ty.osc_arg) || 0.0)
            else                        args.push(String(ty.osc_arg))
        }
    } else if (ty.trigger_note) {
        const { ch, note } = ty.trigger_note
        oscPath = `/mdstage/triggernote/${ch}/${note}`
    } else {
        return
    }
    for (const dev of oscOutputDevices) {
        if (!dev.enabled || !dev.sendTriggerNote) continue
        window.electronAPI.sendOsc({ path: oscPath, args, host: dev.host || '127.0.0.1', port: dev.port ?? 8000 })
    }
}

function computeEffectiveDeviceStates(history) {
    const result = new Map()
    for (let i = history.length - 1; i >= 0; i--) {
        const ty = triggerYamls[history[i]]
        if (!ty) continue
        if (ty.cue_midi?.length) {
            const byDev = new Map()
            for (const msg of ty.cue_midi) {
                const dName = msg.device || midiOutputDevices[0]?.name || ''
                if (!byDev.has(dName)) byDev.set(dName, [])
                byDev.get(dName).push(msg)
            }
            for (const [dName, msgs] of byDev) {
                const key = 'midi:' + dName
                if (!result.has(key)) result.set(key, { type: 'midi', device: dName, messages: msgs })
            }
        }
        if (ty.cue_osc?.length) {
            const byDev = new Map()
            for (const msg of ty.cue_osc) {
                const dev = oscOutputDevices.find(d => d.name === (msg.device || '')) ?? oscOutputDevices[0]
                const dName = dev?.name || ''
                if (!byDev.has(dName)) byDev.set(dName, [])
                byDev.get(dName).push(msg)
            }
            for (const [dName, msgs] of byDev) {
                const key = 'osc:' + dName
                if (!result.has(key)) result.set(key, { type: 'osc', device: dName, messages: msgs })
            }
        }
    }
    return result
}

function _sendMidiMsgArray(messages) {
    for (const msg of messages) {
        const devIdx = midiOutputDevices.findIndex(d => d.name === (msg.device || ''))
        const dev  = devIdx >= 0 ? midiOutputDevices[devIdx] : midiOutputDevices[0]
        if (dev && dev.enabled === false) continue
        const port = (devIdx >= 0 ? midiOutputPorts[devIdx] : null) ?? midiOutputPorts[0]
        if (!port) continue
        if (msg.type === 'note') {
            const ch = ((parseInt(msg.ch) || 1) - 1) & 0xF
            const note = Math.max(0, Math.min(127, parseInt(msg.note) || 0))
            const vel  = Math.max(0, Math.min(127, parseInt(msg.vel) ?? 100))
            port.send([0x90 | ch, note, vel])
            setTimeout(() => port.send([0x80 | ch, note, 0]), 100)
        } else if (msg.type === 'cc') {
            const ch  = ((parseInt(msg.ch)    || 1) - 1) & 0xF
            const cc  = Math.max(0, Math.min(127, parseInt(msg.cc)    || 0))
            const val = Math.max(0, Math.min(127, parseInt(msg.value) ?? 0))
            port.send([0xB0 | ch, cc, val])
        } else if (msg.type === 'pc') {
            const ch  = ((parseInt(msg.ch) || 1) - 1) & 0xF
            const pgm = Math.max(0, Math.min(127, parseInt(msg.program) || 0))
            port.send([0xC0 | ch, pgm])
        } else if (msg.type === 'sysex') {
            const bytes = String(msg.bytes || '').trim().split(/\s+/)
                .map(h => parseInt(h, 16)).filter(n => !isNaN(n) && n >= 0 && n <= 255)
            if (bytes.length) port.send(bytes)
        }
    }
}

function _sendOscMsgArray(messages) {
    if (!window.electronAPI?.sendOsc) return
    for (const msg of messages) {
        const dev = oscOutputDevices.find(d => d.name === (msg.device || '')) ?? oscOutputDevices[0]
        if (!dev?.enabled) continue
        const oscPath = String(msg.path || '').trim()
        if (!oscPath || !/^\/[\x20-\x7e]*$/.test(oscPath)) continue
        const args = []
        if (msg.arg !== undefined && String(msg.arg).trim() !== '') {
            const type = msg.arg_type || 'string'
            if (type === 'int')        args.push(parseInt(msg.arg)   || 0)
            else if (type === 'float') args.push(parseFloat(msg.arg) || 0)
            else                       args.push(String(msg.arg))
        }
        window.electronAPI.sendOsc({ path: oscPath, args, host: dev.host || '127.0.0.1', port: dev.port ?? 8000 })
    }
}

function sendCueMidiMessages(cue) {
    const ty = triggerYamls[cue]
    if (!ty?.cue_midi?.length) return
    _sendMidiMsgArray(ty.cue_midi)
}

function sendCueOscMessages(cue) {
    const ty = triggerYamls[cue]
    if (!ty?.cue_osc?.length) return
    _sendOscMsgArray(ty.cue_osc)
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
        ta.ws.play(start)
    }

    if (typeof music === 'object' && music.adjust) {
        const { trigger_note: adjTn, fadeout, volume: targetVol } = music.adjust
        const targetIdx = findTriggerByNote(adjTn)
        if (targetIdx !== null) {
            const adjustTa = triggerAudio.get(targetIdx)
            if (adjustTa && adjustTa.ws.isPlaying()) {
                const ft = music.adjust.fadetime ?? 3
                if (fadeout) {
                    fadeAdjustAudio(adjustTa, ft)
                } else if (targetVol !== undefined) {
                    fadeAdjustVolume(adjustTa, targetVol, ft)
                }
            }
        }
    }
}

const activeFades = new WeakMap()

function cancelWsFade(ws) {
    const entry = activeFades.get(ws)
    if (entry == null) return
    clearInterval(entry.id ?? entry)
    // For fadeAdjustAudio: restore currentVolume to pre-fade value on cancel
    if (entry.ta && entry.restoreVol !== undefined) entry.ta.setCurrentVolume(entry.restoreVol)
    activeFades.delete(ws)
}

function fadeWaveSurfer(ws, targetVolume, fadeTime, stop) {
    cancelWsFade(ws)
    const startVolume = ws.getVolume()
    if (startVolume === targetVolume) {
        if (stop) ws.stop()
        return
    }
    const steps = 50
    const stepInterval = (fadeTime * 1000) / steps
    const volumeStep = (targetVolume - startVolume) / steps
    let step = 0
    const id = setInterval(() => {
        step++
        ws.setVolume(Math.max(0, Math.min(1, startVolume + volumeStep * step)))
        if (step >= steps) {
            clearInterval(id)
            activeFades.delete(ws)
            if (stop) ws.stop()
        }
    }, stepInterval)
    activeFades.set(ws, id)
}

function broadcastLiveVolumes() {
    if (!window.electronAPI?.sendLiveVolumes) return
    const volumes = {}
    for (const [cueIdx, ta] of triggerAudio) {
        if (ta.ws.isPlaying()) volumes[cueIdx] = ta.getCurrentVolume?.() ?? (ta.mp?.volume ?? 0.8)
    }
    window.electronAPI.sendLiveVolumes(volumes)
}

// Fade currentVolume to a target (keep playing). Works with timeupdate's volume management.
function fadeAdjustVolume(ta, targetVol, fadeTime) {
    cancelWsFade(ta.ws)
    const startVol = ta.getCurrentVolume()
    const steps = 50
    const stepInterval = (fadeTime * 1000) / steps
    let step = 0
    const id = setInterval(() => {
        step++
        ta.setCurrentVolume(startVol + (targetVol - startVol) * (step / steps))
        broadcastLiveVolumes()
        if (step >= steps) {
            clearInterval(id)
            activeFades.delete(ta.ws)
        }
    }, stepInterval)
    activeFades.set(ta.ws, id)
}

// Fade out a loop-capable trigger by reducing currentVolume (plays nicely with timeupdate).
// Disables loop restarts during the fade so the audio doesn't restart mid-fade.
function fadeAdjustAudio(ta, fadeTime) {
    cancelWsFade(ta.ws)
    ta.disableLoop()
    // If a non-primary seq slot is active, fade its gain node via WebAudio scheduling.
    ta.fadeOutActiveSeqSlot?.(fadeTime)
    const startVol = ta.getCurrentVolume()
    const steps = 50
    const stepInterval = (fadeTime * 1000) / steps
    let step = 0
    const id = setInterval(() => {
        step++
        ta.setCurrentVolume(Math.max(0, startVol * (1 - step / steps)))
        broadcastLiveVolumes()
        if (step >= steps) {
            clearInterval(id)
            activeFades.delete(ta.ws)
            if (ta.stopAndReset) ta.stopAndReset()
            else ta.ws.stop()
            if (mtc && mtc.wsRef === ta.ws) mtc.stopAndClear()
            ta.enableLoop()
            ta.setCurrentVolume(startVol)
        }
    }, stepInterval)
    // Store ta + restoreVol so cancelWsFade can restore currentVolume if cancelled mid-fade
    activeFades.set(ta.ws, { id, ta, restoreVol: startVol })
}

function stopall() {
    for (const [idx, ta] of triggerAudio.entries()) {
        const _sd = triggerSeqSlots.get(idx)
        const _seqActive = _sd && _sd.total > 1 && _sd.idx > 0
        if (ta.ws.isPlaying() || _seqActive) fadeAdjustAudio(ta, 0.5)
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
        // Re-dump so we never produce invalid YAML (e.g. {} + appended block lines)
        let base
        try { base = yaml.load(yamlContent) } catch { base = null }
        const withNote = (base && typeof base === 'object')
            ? { ...base, trigger_note: { ch: assignment.ch, note: assignment.note } }
            : { trigger_note: { ch: assignment.ch, note: assignment.note } }
        return `\`\`\`yaml\n${inlineNoteObjects(yaml.dump(withNote, { indent: 4, lineWidth: -1, noRefs: true }).trimEnd())}\n\`\`\``
    })

    return { text: result, changed }
}

function convertCodeblocks() {
    const codeblocks = document.querySelectorAll("pre")
    try {
        config = yaml.load(codeblocks[0].firstChild.textContent).config ?? {}
    } catch (e) {
        config = { roles: {}, settings: {} }
        parseErrors.unshift({ blockNum: 1, line: 1, message: 'Config-Block: ' + e.message })
    }
    // Check for name conflicts between roles and groups
    const _roleNames = new Set(Object.keys(config.roles || {}))
    for (const gName of Object.keys(config.groups || {})) {
        if (gName === 'Alle') {
            parseErrors.push({ blockNum: 1, line: null, message: `"Alle" ist ein reservierter Gruppenname und kann nicht als Gruppe definiert werden` })
        } else if (_roleNames.has(gName)) {
            parseErrors.push({ blockNum: 1, line: null, message: `Name-Konflikt: "${gName}" ist sowohl als Rolle als auch als Gruppe definiert` })
        }
    }
    if (window.__webPreview) {
        try { localStorage.setItem('preview-roles', JSON.stringify({ roles: config.roles || {}, groups: config.groups || {} })) } catch {}
    }
    codeblocks[0].remove()
    for (let index = 1; index < codeblocks.length; index++) {
        const codeblock = codeblocks[index]
        let codeblockYaml
        try {
            codeblockYaml = yaml.load(codeblock.firstChild.textContent)
        } catch (e) {
            const err = parseErrors.find(pe => pe.blockNum === index + 1)
            const errEl = document.createElement('div')
            errEl.className = 'trigger-parse-error'
            const loc = err ? `Block ${err.blockNum}, Zeile ${err.line}` : `Block ${index + 1}`
            errEl.textContent = `YAML-Fehler (${loc}): ${e.message}`
            codeblock.replaceWith(errEl)
            continue
        }
        codeblock.replaceWith(buildTrigger(codeblockYaml, index))
    }
}

function colorText() {
    const paragraphs = document.querySelectorAll("p")
    for (const paragraph of paragraphs) {
        if (paragraph.firstChild?.tagName !== 'STRONG') continue
        const strong = paragraph.firstChild
        const rawName = strong.textContent
        const names = rawName.split('/').map(s => s.trim()).filter(Boolean)
        const roles = names.map(n => config.roles?.[n])
        const firstRole = roles.find(Boolean)
        const firstGroupIdx = !firstRole ? names.findIndex(n => isGroup(n)) : -1
        if (!firstRole && firstGroupIdx < 0) {
            if (!parseErrors.some(e => e.message === `Unbekannte Rolle: "${rawName}"`))
                parseErrors.push({ blockNum: null, line: null, message: `Unbekannte Rolle: "${rawName}"` })
            continue
        }
        // Paragraph color = first role or group color
        const primaryColor = firstRole ? firstRole.color : getGroupColor(names[firstGroupIdx])
        if (primaryColor) paragraph.classList.add('color-' + primaryColor)
        if (names.length > 1) {
            strong.innerHTML = ''
            for (let i = 0; i < names.length; i++) {
                if (i > 0) {
                    const sep = document.createElement('span')
                    sep.className = 'role-name-sep'
                    sep.textContent = ' / '
                    strong.appendChild(sep)
                }
                const span = document.createElement('span')
                span.textContent = names[i]
                const role = config.roles?.[names[i]]
                const color = role ? role.color : (isGroup(names[i]) ? getGroupColor(names[i]) : null)
                if (color) span.className = 'color-' + color
                strong.appendChild(span)
            }
        }
    }
}

function initButtons() {
    document.querySelector(".em-music").addEventListener("mousedown", stopall)
    document.querySelector(".em-mic").addEventListener("mousedown", () => x32UnmuteChannels("muteall"))
    document.querySelector(".live-window-button").addEventListener("mousedown", () => window.electronAPI.openLiveWindow())
    document.querySelector(".lock-button").addEventListener("mousedown", () => { lockAutoActivated = false; setShowLock(!showLock) })
    document.querySelector(".current-trigger-button").addEventListener("mousedown", () => scrollToTrigger(currentCue))
    document.querySelector(".reload-button").addEventListener("mousedown", () => {
        sessionStorage.setItem('reloadScrollY', String(window.scrollY))
        location.reload()
    })
    document.querySelector(".sidebar-toggle-button").addEventListener("mousedown", toggleSidebar)
    document.getElementById('script-content').addEventListener('click', onScriptClick)

    // Capture-phase listener: when show-locked, intercept all clicks in script area
    document.getElementById('script-content').addEventListener('mousedown', (e) => {
        if (!showLock || pickModeCallback) return
        if (e.target.closest('.dialog-overlay')) return
        const triggerEl = e.target.closest('[data-trigger-index]')
        if (triggerEl) {
            e.stopImmediatePropagation()
            if (e.target.closest('button, select, input')) {
                e.preventDefault()
                showLockHint(e)
                return
            }
            const index = parseInt(triggerEl.dataset.triggerIndex)
            if (liveViewOpen) {
                setArmedCue(index)
                const isSibling = !!triggerYamls[index]?.sibling
                const hasNextSibling = !!(triggerYamls[index + 1]?.sibling)
                if (isSibling || hasNextSibling) selectedVariant = index
                broadcastLiveState()
            } else {
                currentCue = index
                markTriggers(index)
                triggerAction(index)
            }
        } else {
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    }, true)
    // Capture-phase click listener: block button/control clicks inside triggers while locked
    document.getElementById('script-content').addEventListener('click', (e) => {
        if (!showLock || pickModeCallback) return
        if (e.target.closest('.dialog-overlay')) return
        if (e.target.closest('[data-trigger-index]') && e.target.closest('button, select, input')) {
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    }, true)
    document.addEventListener('mousedown', (e) => {
        const sidebar = document.getElementById('scene-sidebar')
        if (!sidebar.classList.contains('open')) return
        if (sidebar.contains(e.target)) return
        if (e.target.closest('.sidebar-toggle-button')) return
        sidebar.classList.remove('open')
    })

    const searchInput = document.getElementById('search-input')
    let searchTimer = null
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer)
        searchTimer = setTimeout(() => doSearch(searchInput.value), 150)
    })
    document.getElementById('search-prev').addEventListener('click', () => searchStep(-1))
    document.getElementById('search-next').addEventListener('click', () => searchStep(1))
    document.getElementById('search-close').addEventListener('click', closeSearch)
}

// Migrate to unified outputDevices array (backwards compat)
function _migrateOutputDevices(settings) {
    if (Array.isArray(settings.outputDevices)) {
        return settings.outputDevices.map((d, i) => ({
            enabled: true,
            sendTriggerNote: i === 0,
            ...d,
        }))
    }
    // Migrate old separate arrays
    const midiDevs = settings.midiOutputDevices?.length > 0
        ? settings.midiOutputDevices
        : [{ name: 'Gerät 1', device: settings.midiTriggerDevice || null, sendTriggerNote: true }]
    const oscDevs = settings.oscOutputDevices?.length > 0
        ? settings.oscOutputDevices
        : [{ name: 'Gerät 1', enabled: settings.oscEnabled ?? false, host: settings.oscHost || '127.0.0.1', port: settings.oscPort ?? 8000, sendTriggerNote: false }]
    return [
        ...midiDevs.map((d, i) => ({ enabled: true, sendTriggerNote: i === 0, ...d, type: 'midi' })),
        ...oscDevs.map(d => ({ sendTriggerNote: false, ...d, type: 'osc' })),
    ]
}

// Migrate flat settings to micDevices array (backwards compat)
function _migrateMicDevices(s) {
    if (s.micDevices && s.micDevices.length > 0) return s.micDevices
    return [{
        name:                'Gerät 1',
        micMuteMethod:       s.micMuteMethod        || 'x32',
        midiX32Device:       s.midiX32Device         || null,
        x32OscHost:          s.x32OscHost             || '192.168.1.1',
        x32OscPort:          s.x32OscPort             ?? 10023,
        micMuteMidiType:     s.micMuteMidiType        || 'sysex',
        micMuteMidiUnmute:   s.micMuteMidiUnmute       || 'B1 {ch} 00',
        micMuteMidiMute:     s.micMuteMidiMute         || 'B1 {ch} 7F',
        micMuteMidiNoteCh:   s.micMuteMidiNoteCh       || '1',
        micMuteMidiNoteNum:  s.micMuteMidiNoteNum      || '{ch}',
        micMuteMidiVelOn:    s.micMuteMidiVelOn        ?? 127,
        micMuteMidiVelOff:   s.micMuteMidiVelOff       ?? 0,
        micMuteMidiCcCh:     s.micMuteMidiCcCh         || '2',
        micMuteMidiCcNum:    s.micMuteMidiCcNum        || '{ch}',
        micMuteMidiCcValOn:  s.micMuteMidiCcValOn      ?? 0,
        micMuteMidiCcValOff: s.micMuteMidiCcValOff     ?? 127,
        micMuteMidiPcCh:     s.micMuteMidiPcCh         || '1',
        micMuteMidiPcOn:     s.micMuteMidiPcOn         ?? 0,
        micMuteMidiPcOff:    s.micMuteMidiPcOff        ?? 1,
        micMuteOscOnPath:    s.micMuteOscOnPath  || s.micMuteOscPath || '/ch/{ch}/mix/on',
        micMuteOscOnArgType: s.micMuteOscOnArgType  || 'float',
        micMuteOscOnArg:     s.micMuteOscOnArg  !== undefined ? String(s.micMuteOscOnArg)  : (s.micMuteOscUnmute !== undefined ? String(s.micMuteOscUnmute) : '1'),
        micMuteOscOffPath:   s.micMuteOscOffPath || s.micMuteOscPath || '/ch/{ch}/mix/on',
        micMuteOscOffArgType:s.micMuteOscOffArgType || 'float',
        micMuteOscOffArg:    s.micMuteOscOffArg !== undefined ? String(s.micMuteOscOffArg) : (s.micMuteOscMute !== undefined ? String(s.micMuteOscMute) : '0'),
    }]
}

function x32UnmuteChannels(mic) {
    if (!mic) return
    const expanded = expandMicForRouting(mic)
    if (!expanded) return
    const unmutedRoles = expanded === 'muteall' ? [] : (Array.isArray(expanded) ? expanded : [expanded])

    for (let devIdx = 0; devIdx < micDevices.length; devIdx++) {
        const dev = micDevices[devIdx]
        // Collect all channels for this device + which ones to unmute
        const devChs = [], unmuteChs = []
        for (const [roleName, roleCfg] of Object.entries(config.roles || {})) {
            if ((roleCfg.device ?? 0) !== devIdx) continue
            const ch = roleCfg.ch
            if (!ch) continue
            if (!devChs.includes(ch)) devChs.push(ch)
            if (unmutedRoles.includes(roleName) && !unmuteChs.includes(ch)) unmuteChs.push(ch)
        }
        if (devChs.length === 0) continue
        _sendMicToDevice(dev, devIdx, devChs, unmuteChs)
    }
}

function _sendMicToDevice(dev, devIdx, allChs, unmuteChs) {
    if (dev.micMuteMethod === 'x32') {
        const out = micDeviceOutputs[devIdx]
        if (!out) return
        for (const ch of allChs) out.send([0xB1, ch - 1, unmuteChs.includes(ch) ? 0 : 127])
    } else if (dev.micMuteMethod === 'custom-midi') {
        const out = micDeviceOutputs[devIdx]
        if (!out) return
        function resolveCh(tmpl, used0) { return parseInt(String(tmpl).replace('{ch}', used0)) }
        if (dev.micMuteMidiType === 'sysex') {
            function parseMidiTemplate(tmpl, ch, val) {
                return tmpl.trim().split(/\s+/).map(b => {
                    const s = b.replace('{ch}', ch).replace('{val}', val)
                    return parseInt(s, 16)
                }).filter(n => !isNaN(n))
            }
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const bytes = parseMidiTemplate(isUnmuted ? dev.micMuteMidiUnmute : dev.micMuteMidiMute, ch - 1, isUnmuted ? 0x00 : 0x7F)
                if (bytes.length) out.send(bytes)
            }
        } else if (dev.micMuteMidiType === 'note') {
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const mCh  = (resolveCh(dev.micMuteMidiNoteCh, ch - 1) - 1) & 0xF
                const note = resolveCh(dev.micMuteMidiNoteNum, ch - 1) & 0x7F
                const vel  = (isUnmuted ? dev.micMuteMidiVelOn : dev.micMuteMidiVelOff) & 0x7F
                out.send([0x90 | mCh, note, vel])
                if (vel > 0) setTimeout(() => out?.send([0x80 | mCh, note, 0]), 100)
            }
        } else if (dev.micMuteMidiType === 'cc') {
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const mCh = (resolveCh(dev.micMuteMidiCcCh, ch - 1) - 1) & 0xF
                const cc  = resolveCh(dev.micMuteMidiCcNum, ch - 1) & 0x7F
                out.send([0xB0 | mCh, cc, (isUnmuted ? dev.micMuteMidiCcValOn : dev.micMuteMidiCcValOff) & 0x7F])
            }
        } else if (dev.micMuteMidiType === 'pc') {
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const mCh  = (resolveCh(dev.micMuteMidiPcCh, ch - 1) - 1) & 0xF
                out.send([0xC0 | mCh, (isUnmuted ? dev.micMuteMidiPcOn : dev.micMuteMidiPcOff) & 0x7F])
            }
        }
    } else if (dev.micMuteMethod === 'custom-osc') {
        if (!window.electronAPI?.sendOsc) return
        function padCh(n) { return String(n).padStart(2, '0') }
        const host = dev.x32OscHost || '192.168.1.1'
        const port = dev.x32OscPort || 10023
        for (const ch of allChs) {
            const isUnmuted = unmuteChs.includes(ch)
            const path    = (isUnmuted ? dev.micMuteOscOnPath    : dev.micMuteOscOffPath).replace('{ch}', padCh(ch))
            const argType = isUnmuted  ? dev.micMuteOscOnArgType : dev.micMuteOscOffArgType
            const argVal  = isUnmuted  ? dev.micMuteOscOnArg     : dev.micMuteOscOffArg
            const args = []
            if (argType !== 'none' && argVal !== '') {
                if (argType === 'int')        args.push(parseInt(argVal) || 0)
                else if (argType === 'float') args.push(parseFloat(argVal) || 0)
                else                         args.push(String(argVal))
            }
            window.electronAPI.sendOsc({ path, args, host, port })
        }
    }
}

function refreshMidiDevices(settings) {
    micDeviceOutputs = micDevices.map(() => null)
    midiOutputPorts  = midiOutputDevices.map(() => null)
    midiTrigger = null
    midiTC = null
    midiGoNote    = settings.midiGoNote    || null
    midiBackNote  = settings.midiBackNote  || null
    midiLiveDevice = settings.midiLiveDevice || null
    if (!midiAccess) return
    for (const output of midiAccess.outputs.values()) {
        for (let i = 0; i < micDevices.length; i++) {
            const dev = micDevices[i]
            if ((dev.micMuteMethod === 'x32' || dev.micMuteMethod === 'custom-midi') &&
                dev.midiX32Device && output.name === dev.midiX32Device)
                micDeviceOutputs[i] = output
        }
        for (let i = 0; i < midiOutputDevices.length; i++) {
            if (midiOutputDevices[i].device && output.name === midiOutputDevices[i].device)
                midiOutputPorts[i] = output
        }
        if (settings.midiTCDevice && output.name === settings.midiTCDevice) midiTC = output
    }
    midiTrigger = midiOutputPorts[0] ?? null  // keeps sendTriggerNote working
    if (mtc) mtc.setOutput(midiTC)
}

function stopAllAudio() {
    for (const [cueIdx] of triggerAudio) fadeOutAndStop(cueIdx)
    if (mtc) mtc.stopAndClear()
    for (const [loopIdx, outroIdx] of loopOutroPending) {
        loopOutroInitialRemaining.delete(loopIdx)
        setOutroPendingIndicator(outroIdx, false)
    }
    loopOutroPending.clear()
    setArmedCue(null)
    broadcastLiveState()
}

const MIDI_BACK_LONG_PRESS_MS = 600

function setupMidiInputListeners() {
    if (!midiAccess) return
    for (const input of midiAccess.inputs.values()) {
        if (midiLiveDevice && input.name !== midiLiveDevice) {
            input.onmidimessage = null
            continue
        }
        input.onmidimessage = (msg) => {
            const [status, note, velocity] = msg.data
            const type     = status & 0xf0
            const ch       = (status & 0x0f) + 1
            const isNoteOn  = type === 0x90 && velocity > 0
            const isNoteOff = type === 0x80 || (type === 0x90 && velocity === 0)

            if (midiGoNote && ch === midiGoNote.ch && note === midiGoNote.note && isNoteOn)
                goAction()

            if (midiBackNote && ch === midiBackNote.ch && note === midiBackNote.note) {
                if (isNoteOn) {
                    midiBackLongPressed = false
                    midiBackLongPressTimer = setTimeout(() => {
                        midiBackLongPressed = true
                        stopAllAudio()
                    }, MIDI_BACK_LONG_PRESS_MS)
                } else if (isNoteOff) {
                    clearTimeout(midiBackLongPressTimer)
                    midiBackLongPressTimer = null
                    if (!midiBackLongPressed) backAction()
                }
            }
        }
    }
}

async function initMidi(settings) {
    midiAccess = await _midiAccessPromise
    if (!midiAccess) return
    refreshMidiDevices(settings)
    setupMidiInputListeners()
}

function updateClock() {
    const clock = document.querySelector(".clock")
    if (!clock) return
    const d = new Date()
    const p = n => n.toString().padStart(2, '0')
    clock.innerText = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function initApp() {
    const savedSettings = await window.electronAPI.getSettings()

    // Enumerate available audio outputs, cache for label→deviceId resolution.
    // Main audio falls back to system default (null) if label not found;
    // monitor is disabled (null) if label not found.
    try {
        audioOutputDevices = (await navigator.mediaDevices.enumerateDevices())
            .filter(d => d.kind === 'audiooutput')
    } catch {}

    mainAudioDevice = resolveDeviceId(savedSettings.mainAudioDevice)
    mainChannelL    = savedSettings.mainChannelL    ?? 0
    mainChannelR    = savedSettings.mainChannelR    ?? 1
    monitorEnabled  = savedSettings.monitorEnabled  ?? false
    appLanguage     = savedSettings.appLanguage     || 'de'
    micGroupDisplay = savedSettings.micGroupDisplay ?? true
    document.getElementById('script-content').classList.toggle('show-md-line-numbers', !!(savedSettings.showMdLineNumbers))
    if (savedSettings.openLocked) { lockAutoActivated = false; setShowLock(true) }
    window.applyI18n?.(appLanguage)
    monitorChannelL = monitorEnabled ? (savedSettings.monitorChannelL ?? mainChannelL) : mainChannelL
    monitorChannelR = monitorEnabled ? (savedSettings.monitorChannelR ?? mainChannelR) : mainChannelR
    editorApp       = savedSettings.editorApp || null
    outputDevices     = _migrateOutputDevices(savedSettings)
    midiOutputDevices = outputDevices.filter(d => d.type === 'midi')
    midiOutputPorts   = midiOutputDevices.map(() => null)
    oscOutputDevices  = outputDevices.filter(d => d.type === 'osc')
    // Keep compat vars (used by sendOscMessage and other places) from first device
    const _firstOsc = oscOutputDevices[0] || {}
    oscEnabled = _firstOsc.enabled ?? false
    oscHost    = _firstOsc.host    || '127.0.0.1'
    oscPort    = _firstOsc.port    ?? 8000
    micDevices       = _migrateMicDevices(savedSettings)
    micDeviceOutputs = micDevices.map(() => null)

    let text = await window.electronAPI.getScriptMd()

    const { text: modifiedText, changed } = assignTriggerNotes(text)
    if (changed) {
        await writeScriptMd(modifiedText)
        text = modifiedText
    }

    // Ask to format if the script doesn't match canonical style
    if (!window.__webPreview && needsFormatting(text)) {
        const scriptPath0 = await window.electronAPI.getScriptPath()
        const fileName = scriptPath0.split(/[\\/]/).pop()
        const backupName = fileName.replace(/\.md$/, '~unformatted.md')
        const yes = await showConfirmDialog({
            title: 'Skript formatieren?',
            body:  `<strong>${escapeHtml(fileName)}</strong> entspricht nicht dem Formatierungsstandard.<br><br>` +
                   `Fehlende Leerzeilen werden ergänzt, lange Zeilen aufgeteilt.<br>` +
                   `Eine Sicherungskopie wird als <strong>${escapeHtml(backupName)}</strong> gespeichert.`,
            confirmLabel: 'Formatieren',
            cancelLabel:  'Überspringen',
            img: 'assets/formatter.png',
        })
        if (yes) {
            await window.electronAPI.backupScriptMd()
            const formatted = formatScriptText(text)
            await writeScriptMd(formatted)
            text = formatted
        }
    }

    // Show current file name in title bar
    if (window.__webPreview) {
        audioBasePath = 'audio/'
        document.title = 'MDstage – Vorschau'
    } else {
        const scriptPath = await window.electronAPI.getScriptPath()
        document.title = scriptPath.split(/[\\/]/).pop()
        const scriptDir = scriptPath.substring(0, scriptPath.lastIndexOf('/'))
        audioBasePath = encodeURI('file://' + scriptDir + '/audio/')
    }

    validateYamlBlocks(text)
    scriptText = text
    document.getElementById('script-content').innerHTML = makeHtmlSafe(text)
    convertCodeblocks()

    if (!window.__webPreview) {
        for (const { block, key } of findUnknownYamlKeys(text)) {
            parseErrors.push({ blockNum: block, line: null, message: `Unbekanntes YAML-Feld: „${key}"`, unknownKey: key })
        }

        const appVersion = await window.electronAPI.getAppVersion()
        _versionBumpAppVersion = appVersion

        const fileVersion = config?.app_version
        if (fileVersion && String(fileVersion) !== appVersion) {
            await showVersionMismatchDialog(String(fileVersion), appVersion)
            versionMismatchIgnored = true
            versionMismatchFileVersion = String(fileVersion)
            window.electronAPI.setSuppressVersionBump(true)
        }

        if (!savedSettings.dismissedUpdatePopup) {
            const dismissed = await showUpdateInfoDialog(appVersion)
            if (dismissed) {
                window.electronAPI.saveSettings({ ...savedSettings, dismissedUpdatePopup: true })
            }
        }
    }

    colorText()
    // Check for duplicate device names across MIDI and OSC output devices
    const _devNames = new Set()
    for (const d of [...midiOutputDevices, ...oscOutputDevices]) {
        if (_devNames.has(d.name))
            parseErrors.push({ blockNum: null, line: null, message: `Doppelter Gerätename: „${d.name}" – Gerätenamen müssen eindeutig sein` })
        _devNames.add(d.name)
    }
    showParseErrors()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
    annotateLineNumbers()
    buildInsertZones()
    initButtons()
    setupAutoTriggers()
    buildSidebar()

    checkEmptyScript()

    mtc = new MTCTransmitter()
    mtc.setDisplay(document.querySelector('.tc-display'))

    applyAudioDevices()

    await initMidi(savedSettings)
    mtc.setOutput(midiTC)

    window.electronAPI.onScriptChanged(async () => {
        const newText = await window.electronAPI.getScriptMd()
        scriptText = newText
        rerender(newText)
    })

    window.electronAPI.onSettingsChanged((newSettings) => {
        // Sync scriptText so trigger-editing operations don't overwrite the newly
        // saved settings section in the config YAML block.
        window.electronAPI.getScriptMd().then(text => { scriptText = text })
        refreshMidiDevices(newSettings)
        setupMidiInputListeners()
        // Re-enumerate to pick up newly connected devices, then resolve labels.
        const applyNew = () => {
            const newML  = newSettings.mainChannelL    ?? 0
            const newMR  = newSettings.mainChannelR    ?? 1
            const monEn  = newSettings.monitorEnabled  ?? false
            const newMoL = monEn ? (newSettings.monitorChannelL ?? newML) : newML
            const newMoR = monEn ? (newSettings.monitorChannelR ?? newMR) : newMR
            const changed = newML !== mainChannelL || newMR !== mainChannelR ||
                            newMoL !== monitorChannelL || newMoR !== monitorChannelR
            mainAudioDevice = resolveDeviceId(newSettings.mainAudioDevice)
            mainChannelL    = newML;  mainChannelR    = newMR
            monitorEnabled  = monEn
            monitorChannelL = newMoL; monitorChannelR = newMoR
            editorApp       = newSettings.editorApp || null
            outputDevices     = _migrateOutputDevices(newSettings)
            midiOutputDevices = outputDevices.filter(d => d.type === 'midi')
            midiOutputPorts   = midiOutputDevices.map(() => null)
            oscOutputDevices  = outputDevices.filter(d => d.type === 'osc')
            const _newFirstOsc = oscOutputDevices[0] || {}
            oscEnabled = _newFirstOsc.enabled ?? false
            oscHost    = _newFirstOsc.host    || '127.0.0.1'
            oscPort    = _newFirstOsc.port    ?? 8000
            micDevices       = _migrateMicDevices(newSettings)
            micDeviceOutputs = micDevices.map(() => null)
            const newLang   = newSettings.appLanguage || 'de'
            if (newLang !== appLanguage) {
                appLanguage = newLang
                window.applyI18n?.(appLanguage)
            }
            micGroupDisplay = newSettings.micGroupDisplay ?? true
            document.getElementById('script-content').classList.toggle('show-md-line-numbers', !!(newSettings.showMdLineNumbers))
            updateGutterState()
            if (changed)
                for (const ta of triggerAudio.values()) { ta.decodedBuffer = null; ta._decoding = false }
            applyAudioDevices()
        }
        navigator.mediaDevices.enumerateDevices().then(devs => {
            audioOutputDevices = devs.filter(d => d.kind === 'audiooutput')
            applyNew()
        }).catch(applyNew)
    })

    broadcastLiveState()

    const savedScrollY = sessionStorage.getItem('reloadScrollY')
    if (savedScrollY !== null) {
        sessionStorage.removeItem('reloadScrollY')
        requestAnimationFrame(() => window.scrollTo({ top: parseInt(savedScrollY), behavior: 'instant' }))
    }
}

// ── Export ───────────────────────────────────────────────────────────────────

function _slfRolesForExport(allYamls) {
    const noteKey = tn => tn ? `${tn.ch}.${tn.note}` : null
    const noteToIdx = new Map()
    allYamls.forEach((y, i) => { if (y.trigger_note) noteToIdx.set(noteKey(y.trigger_note), i) })

    // collect which cues are loop_outro targets
    const outroSources = new Map()  // finishIdx → [loopIdx, ...]
    for (let i = 0; i < allYamls.length; i++) {
        const lo = allYamls[i].loop_outro
        if (!lo) continue
        const loIdx = noteToIdx.get(noteKey(lo))
        if (loIdx === undefined) continue
        if (!outroSources.has(loIdx)) outroSources.set(loIdx, [])
        outroSources.get(loIdx).push(i)
    }

    return allYamls.map((y, i) => {
        const hasCE   = !!y.chain_end
        const hasLO   = !!y.loop_outro
        const sources = outroSources.get(i) || []
        const isOutro = sources.length > 0
        if (!hasCE && !hasLO && !isOutro) return null
        const fromStr = sources.map(j => {
            const tn = allYamls[j]?.trigger_note; return tn ? noteKey(tn) : '?'
        }).join(', ')
        if (hasCE && isOutro) return { role: 'Bridge', detail: `← ${fromStr} → ${noteKey(y.chain_end)}` }
        if (hasCE)            return { role: 'Start',  detail: `→ ${noteKey(y.chain_end)}` }
        if (hasLO)            return { role: 'Loop',   detail: `↩ ${noteKey(y.loop_outro)}` }
        return                       { role: 'Finish', detail: `← ${fromStr}` }
    })
}

function buildExportData(withCues, withColors, withGroupedMics = true) {
    const titleMatch = scriptText.match(/^# (.+)/m)
    const title = titleMatch ? titleMatch[1].trim() : 'Skript'
    const date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

    const roleColors = {}
    if (withColors) {
        for (const [name, role] of Object.entries(config.roles || {})) {
            roleColors[name] = ROLE_COLORS[role.color] || '#888888'
        }
    }

    // Two-pass: first collect all cue YAMLs to compute SLF roles
    const allCueYamls = []
    for (const block of tokenizeScript(scriptText)) {
        if (block.type !== 'yaml') continue
        let p; try { p = yaml.load(block.content.slice(7, -3).trim()) } catch { continue }
        if (p?.config !== undefined) continue
        allCueYamls.push(p)
    }
    const slfMap = _slfRolesForExport(allCueYamls)

    const items = []
    let cueNumber = 0
    for (const block of tokenizeScript(scriptText)) {
        if (block.type === 'yaml') {
            let parsed
            try { parsed = yaml.load(block.content.slice(7, -3).trim()) } catch { continue }
            if (parsed?.config !== undefined) continue
            cueNumber++
            if (!withCues) continue
            const cue = { type: 'cue', number: cueNumber }
            const slf = slfMap[cueNumber - 1]
            if (slf) cue.slf = slf
            if (parsed.sibling)    cue.sibling = true
            if (parsed.trigger_note) {
                const tn = parsed.trigger_note
                cue.trigger = `${tn.ch}.${tn.note}`
            }
            if (parsed.note)    cue.note = String(parsed.note)
            if (parsed.auto_mic) {
                const computed = computeAutoMicRoles(cueNumber)
                if (computed === 'muteall') {
                    cue.mic = 'muteall'
                } else if (computed) {
                    cue.micItems = groupRolesForDisplay(computed, withGroupedMics)
                    cue.mic = true
                }
            } else if (parsed.mic) {
                cue.micItems = groupRolesForDisplay(parsed.mic, withGroupedMics)
                cue.mic = true
            }
            if (parsed.music) {
                const m = typeof parsed.music === 'string' ? { file: parsed.music } : (parsed.music || {})
                cue.music = {}
                if (m.file)                      cue.music.file    = m.file
                if (m.volume   !== undefined)    cue.music.volume  = m.volume
                if (m.start    !== undefined)    cue.music.start   = m.start
                if (m.end      !== undefined)    cue.music.end     = m.end
                if (m.fadein)                    cue.music.fadein  = m.fadein
                if (m.fadeout)                   cue.music.fadeout = m.fadeout
                if (m.loop)                      cue.music.loop    = true
                if (m.adjust) {
                    const adjTn = m.adjust.trigger_note
                    cue.music.adjust = {
                        trigger:  adjTn ? `${adjTn.ch}.${adjTn.note}` : null,
                        fadeout:  !!m.adjust.fadeout,
                        volume:   m.adjust.volume,
                    }
                }
            }
            if (parsed.qlcplus)    cue.qlcplus    = String(parsed.qlcplus)
            if (parsed.projection) cue.projection = String(parsed.projection)
            if (parsed.start_tc)   cue.start_tc   = String(parsed.start_tc)
            if (parsed.auto_trigger) {
                const at = parsed.auto_trigger
                const atTn = at.trigger_note
                cue.auto_trigger = {
                    trigger: atTn ? `${atTn.ch}.${atTn.note}` : null,
                    at:      at.at,
                }
            }
            items.push(cue)
        } else {
            const c = block.content
            const hm = c.match(/^(#{1,3}) (.+)$/)
            if (hm) { items.push({ type: 'heading', level: hm[1].length, text: hm[2].trim() }); continue }
            if (/^\*[^*]/.test(c) && /\*\^?$/.test(c)) {
                items.push({ type: 'stage', text: c.replace(/^\*/, '').replace(/\*\^?$/, '').trim() })
                continue
            }
            const rm = c.match(/^(\*\*[^*]+\*\*(?:\s+\*\*[^*]+\*\*)*)(?:\n([\s\S]*))?$/)
            if (rm) {
                const names = [...rm[1].matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1].trim())
                const dialogue = (rm[2] || '').replace(/<br>/gi, '\n').trim()
                items.push({ type: 'role', names, dialogue })
                continue
            }
            items.push({ type: 'text', text: c })
        }
    }
    return { title, date, items, roleColors }
}

function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _dlgHtml(text) {
    return _esc(text).replace(/\n/g, '<br>').replace(/\*\(([^)]*)\)\*/g, '<em class="si">($1)</em>')
}

function generateExportHtml(data) {
    const { title, date, items, roleColors } = data

    // Assign stable IDs to all headings so TOC links can target them
    const headingIds = new Map()
    let hIdx = 0
    for (const item of items) {
        if (item.type === 'heading') headingIds.set(item, `s${hIdx++}`)
    }

    const tocEntries = items.filter(it => it.type === 'heading' && it.level >= 1)
    const tocHtml = tocEntries.length ? `<div class="toc-page">
<div class="toc-title">Inhaltsverzeichnis</div>
<div class="toc-list">${tocEntries.map(e => {
    const id = headingIds.get(e)
    const cls = e.level === 2 ? ' toc-sub' : e.level >= 3 ? ' toc-sub2' : ''
    return `<div class="toc-entry${cls}"><a class="toc-link" href="#${id}">${_esc(e.text)}</a></div>`
}).join('\n')}</div></div>` : ''

    const contentLines = []
    for (const item of items) {
        if (item.type === 'heading') {
            const tag = `h${item.level}`
            const id = headingIds.get(item)
            contentLines.push(`<${tag}${id ? ` id="${id}"` : ''}>${_esc(item.text)}</${tag}>`)
        } else if (item.type === 'stage') {
            contentLines.push(`<p class="stage">${_esc(item.text)}</p>`)
        } else if (item.type === 'role') {
            const nameHtml = item.names.map(n => {
                const col = roleColors[n]
                return `<span class="rn"${col ? ` style="color:${col}"` : ''}>${_esc(n)}</span>`
            }).join(' ')
            const dlgPart = item.dialogue ? `<span class="dlg">${_dlgHtml(item.dialogue)}</span>` : ''
            contentLines.push(`<p class="role"><span class="rnames">${nameHtml}</span>${dlgPart}</p>`)
        } else if (item.type === 'cue') {
            const rows = []
            if (item.mic) {
                let micHtml
                if (item.mic === 'muteall') {
                    micHtml = '<em>alle aus</em>'
                } else if (item.micItems) {
                    const parts = []
                    for (const mi of item.micItems) {
                        if (mi.isGroup) {
                            const mems = (mi.members || []).map(m => `<span class="exp-chip">${_esc(m.name)}</span>`).join('')
                            parts.push(`<span class="exp-group"><span class="exp-gname">${_esc(mi.name)}</span>${mems}</span>`)
                        } else {
                            parts.push(_esc(mi.name))
                        }
                    }
                    micHtml = parts.join(' ')
                } else {
                    micHtml = ''
                }
                rows.push(`<tr><td class="cfl">Mic</td><td class="cfv">${micHtml}</td></tr>`)
            }
            if (item.music) {
                const m = item.music
                let ms = m.file ? _esc(m.file) : ''
                const det = []
                if (m.volume  !== undefined) det.push(`Vol ${Math.round(m.volume * 100)}%`)
                if (m.start   !== undefined) det.push(`Start ${m.start}s`)
                if (m.end     !== undefined) det.push(`Ende ${m.end}s`)
                if (m.fadein)               det.push(`Fade-in ${m.fadein}s`)
                if (m.fadeout)              det.push(`Fade-out ${m.fadeout}s`)
                if (m.loop)                 det.push('Loop')
                if (det.length) ms += ` <span class="cfd">(${det.join(', ')})</span>`
                if (m.adjust) {
                    const ref = m.adjust.trigger ? `Cue ${_esc(m.adjust.trigger)}` : '?'
                    if (m.adjust.fadeout)                   ms += ` → ${ref} ausfaden`
                    else if (m.adjust.volume !== undefined) ms += ` → ${ref} auf ${Math.round(m.adjust.volume * 100)}%`
                }
                rows.push(`<tr><td class="cfl">♬</td><td class="cfv">${ms}</td></tr>`)
            }
            if (item.qlcplus)    rows.push(`<tr><td class="cfl">QLC+</td><td class="cfv">${_esc(item.qlcplus)}</td></tr>`)
            if (item.projection) rows.push(`<tr><td class="cfl">Proj.</td><td class="cfv">${_esc(item.projection)}</td></tr>`)
            if (item.note)       rows.push(`<tr><td class="cfl">Notiz</td><td class="cfv">${_esc(item.note)}</td></tr>`)
            if (item.start_tc)   rows.push(`<tr><td class="cfl">TC</td><td class="cfv">${_esc(item.start_tc)}</td></tr>`)
            if (item.auto_trigger) {
                const at = item.auto_trigger
                const ref = at.trigger ? `Cue ${_esc(at.trigger)}` : '?'
                rows.push(`<tr><td class="cfl">Auto</td><td class="cfv">bei ${at.at}s in ${ref}</td></tr>`)
            }
            const variant = item.sibling ? '<span class="cue-variant">Variante</span> ' : ''
            const trigStr = item.trigger ? `<span class="cue-trig">${_esc(item.trigger)}</span>` : ''
            const slfStr  = item.slf ? `<span class="cue-slf">${_esc(item.slf.role)} ${_esc(item.slf.detail)}</span>` : ''
            const hdr = `<div class="cue-head"><span>${variant}${slfStr}</span>${trigStr}</div>`
            contentLines.push(`<div class="cue">${hdr}${rows.length ? `<table class="cue-tbl">${rows.join('')}</table>` : ''}</div>`)
        } else if (item.type === 'text') {
            contentLines.push(`<p class="narr">${_esc(item.text).replace(/\n/g, '<br>')}</p>`)
        }
    }

    const css = `
*{box-sizing:border-box;margin:0;padding:0}
@page{margin:2.5cm;size:A4}
body{font-family:'Times New Roman',Times,serif;font-size:11pt;line-height:1.55;color:#000;background:#fff}
.title-page{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90vh;text-align:center;page-break-after:always}
.title-page h1{font-size:2.4rem;margin-bottom:.6rem;border:none;page-break-after:auto;font-weight:bold}
.title-meta{font-size:1rem;color:#444;margin-top:.4rem}
.toc-page{page-break-after:always;padding-top:1rem}
.toc-title{font-size:1.3rem;font-weight:bold;border-bottom:2px solid #333;padding-bottom:.4rem;margin-bottom:1rem}
.toc-entry{padding:.2rem 0;font-size:1rem;font-weight:bold}
.toc-sub{padding-left:1.2rem;font-size:.95rem;font-weight:normal;color:#222}
.toc-sub2{padding-left:2.4rem;font-size:.88rem;font-weight:normal;color:#444}
.toc-link{color:inherit;text-decoration:none}
h1{font-size:1.6rem;font-weight:bold;margin-top:2rem;margin-bottom:.6rem;border-bottom:2px solid #333;page-break-after:avoid}
h2{font-size:1.3rem;font-weight:bold;margin-top:1.8rem;margin-bottom:.5rem;border-bottom:1px solid #aaa;page-break-after:avoid}
h3{font-size:1.1rem;font-weight:bold;font-style:italic;margin-top:1.2rem;margin-bottom:.3rem;page-break-after:avoid}
.stage{font-style:italic;color:#555;margin:.35rem 0;padding-left:1rem;font-size:.95rem}
.role{margin:.25rem 0 .15rem}
.rnames{font-weight:bold;margin-right:.4rem}
.rn{display:inline}
.dlg{display:inline}
.dlg .si{font-style:italic;color:#555}
.cue{font-size:.82rem;border:0.5pt solid #888;padding:.25rem .4rem;margin:.35rem 0;page-break-inside:avoid}
.cue-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.1rem}
.cue-trig{color:#777;font-size:.85em}
.cue-variant{font-style:italic;font-size:.85em;margin-right:.3rem}
.cue-slf{font-size:.82em;color:#555;margin-right:.2rem}
.cue-tbl{border-collapse:collapse;width:100%}
.cfl{white-space:nowrap;padding-right:.5rem;color:#555;vertical-align:top}
.cfv{vertical-align:top}
.cfd{color:#555}
.narr{margin:.3rem 0;color:#222}
.exp-group{display:inline-block;border:0.5pt solid #999;border-radius:2pt;padding:0 2pt;margin:0 1pt;white-space:nowrap}
.exp-gname{font-weight:bold;margin-right:2pt}
.exp-chip{display:inline-block;margin:0 1pt}`

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>${css}</style></head><body>
<div class="title-page"><h1>${_esc(title)}</h1><div class="title-meta">Regiebuch &mdash; ${_esc(date)}</div></div>
${tocHtml}
${contentLines.join('\n')}
</body></html>`
}

function showExportDialog() {
    return new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'dialog-overlay'
        overlay.style.zIndex = '9999'
        overlay.addEventListener('mousedown', e => e.stopPropagation())

        const box = document.createElement('div')
        box.className = 'dialog-box'

        const h3 = document.createElement('h3')
        h3.textContent = t('dlg.export.title')

        const chkStyle = 'display:flex;align-items:center;gap:.6rem;color:#abb2bf;font-size:.9rem;margin-bottom:.8rem;cursor:pointer'

        const labelCues = document.createElement('label')
        labelCues.style.cssText = chkStyle
        const chkCues = document.createElement('input')
        chkCues.type = 'checkbox'
        chkCues.checked = false
        chkCues.style.cssText = 'width:15px;height:15px;cursor:pointer'
        labelCues.append(chkCues, t('dlg.export.cues'))

        const labelColors = document.createElement('label')
        labelColors.style.cssText = chkStyle
        const chkColors = document.createElement('input')
        chkColors.type = 'checkbox'
        chkColors.checked = true
        chkColors.style.cssText = 'width:15px;height:15px;cursor:pointer'
        labelColors.append(chkColors, t('dlg.export.colors'))

        const labelGrouped = document.createElement('label')
        labelGrouped.style.cssText = chkStyle + ';margin-bottom:1.5rem'
        const chkGrouped = document.createElement('input')
        chkGrouped.type = 'checkbox'
        chkGrouped.checked = true
        chkGrouped.style.cssText = 'width:15px;height:15px;cursor:pointer'
        labelGrouped.append(chkGrouped, t('dlg.export.grouped'))

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'

        const close = val => { overlay.remove(); resolve(val) }

        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'dialog-btn'
        cancelBtn.textContent = t('btn.cancel')
        cancelBtn.addEventListener('click', () => close(null))

        const pdfBtn = document.createElement('button')
        pdfBtn.className = 'dialog-btn dialog-btn-primary'
        pdfBtn.textContent = t('dlg.export.pdf')
        pdfBtn.addEventListener('click', () => close({ format: 'pdf', withCues: chkCues.checked, withColors: chkColors.checked, withGroupedMics: chkGrouped.checked }))

        const docxBtn = document.createElement('button')
        docxBtn.className = 'dialog-btn dialog-btn-primary'
        docxBtn.textContent = t('dlg.export.docx')
        docxBtn.addEventListener('click', () => close({ format: 'docx', withCues: chkCues.checked, withColors: chkColors.checked, withGroupedMics: chkGrouped.checked }))

        actions.append(cancelBtn, pdfBtn, docxBtn)
        box.append(h3, labelCues, labelColors, labelGrouped, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        cancelBtn.focus()
    })
}

async function runExport() {
    const choice = await showExportDialog()
    if (!choice) return
    const data = buildExportData(choice.withCues, choice.withColors, choice.withGroupedMics ?? true)
    if (choice.format === 'pdf') {
        await window.electronAPI.exportPdf({ html: generateExportHtml(data), title: data.title })
    } else {
        await window.electronAPI.exportDocx(data)
    }
}

function showWelcomeDialog() {
    const quit = () => window.electronAPI.quitApp?.()

    const overlay = document.createElement('div')
    overlay.className = 'dialog-overlay'
    overlay.style.zIndex = '9999'
    overlay.addEventListener('mousedown', () => quit())

    const box = document.createElement('div')
    box.className = 'dialog-box'
    box.style.cssText = 'text-align:center;max-width:380px'
    box.addEventListener('mousedown', e => e.stopPropagation())

    const img = document.createElement('img')
    img.src = 'assets/new.png'
    img.style.cssText = 'width:80%;border-radius:4px;margin:0 auto 0.8rem;display:block'

    const h3 = document.createElement('h3')
    h3.textContent = t('welcome.title')

    const bodyEl = document.createElement('p')
    bodyEl.style.cssText = 'color:#5c6370;font-size:0.88rem;margin:0 0 0.5rem;line-height:1.6'
    bodyEl.textContent = t('welcome.body')

    const actions = document.createElement('div')
    actions.className = 'dialog-actions'
    actions.style.justifyContent = 'center'

    const btnOpen = document.createElement('button')
    btnOpen.className = 'dialog-btn'
    btnOpen.textContent = t('welcome.open')
    btnOpen.addEventListener('click', () => window.electronAPI.openFileWelcome())

    const btnNew = document.createElement('button')
    btnNew.className = 'dialog-btn dialog-btn-primary'
    btnNew.textContent = t('welcome.new')
    btnNew.addEventListener('click', () => window.electronAPI.newFile())

    actions.append(btnOpen, btnNew)
    box.append(img, h3, bodyEl, actions)
    overlay.append(box)
    document.body.appendChild(overlay)
    btnNew.focus()

    const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); quit() } }
    document.addEventListener('keydown', onKey)
}

// Registered at module level (before async initApp) so the listener is always ready.
window.electronAPI.onWelcomeDialog?.(() => showWelcomeDialog())

window.addEventListener('__live-go__', () => {
    console.log('[main-win] live-go received, triggerYamls.length:', triggerYamls.length, 'currentCue:', currentCue)
    goAction()
})
window.addEventListener('__live-back__', () => backAction())
window.__liveGo = goAction
window.__liveBack = backAction
window.__selectVariant = (idx) => { selectedVariant = idx; broadcastLiveState() }
window.__stopAudio = (cueIdx) => { const ta = triggerAudio.get(cueIdx); if (ta) fadeAdjustAudio(ta, 0.5) }
window.__rerender = () => { if (scriptText) rerender(scriptText) }
window.__runExport = runExport
window.__handleRolesSaved = ({ roles, renames, groups }) => {
    let text = scriptText
    for (const { from, to } of (renames || [])) {
        if (!from || !to || from === to) continue
        const re = new RegExp(`\\*\\*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`, 'g')
        text = text.replace(re, `**${to}**`)
        for (const grp of Object.values(groups || {})) {
            if (Array.isArray(grp.roles)) {
                const idx = grp.roles.indexOf(from)
                if (idx !== -1) grp.roles[idx] = to
            }
        }
    }
    const m = text.match(/```yaml\n([\s\S]*?)\n```/)
    if (m) {
        try {
            const parsed = yaml.load(m[1])
            if (parsed?.config) {
                parsed.config.roles = roles
                if (groups && Object.keys(groups).length > 0) {
                    parsed.config.groups = groups
                } else {
                    delete parsed.config.groups
                }
                const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
                text = text.replace(m[0], '```yaml\n' + newYaml.trimEnd() + '\n```')
            }
        } catch {}
    }
    writeScriptMd(text)
}

window.electronAPI.onLiveWindowState((isOpen) => {
    liveViewOpen = isOpen
    if (!isOpen) {
        setArmedCue(null)
        if (lockAutoActivated) { lockAutoActivated = false; setShowLock(false) }
    } else if (!showLock) {
        lockAutoActivated = true
        setShowLock(true)
    }
    broadcastLiveState()
})

initApp().catch(e => console.error('initApp Fehler:', e))

// Align clock tick to the real second boundary so both views jump simultaneously.
function scheduleClockTick() {
    updateClock()
    setTimeout(scheduleClockTick, 1000 - (Date.now() % 1000))
}
updateClock()
setTimeout(scheduleClockTick, 1000 - (Date.now() % 1000))

setInterval(broadcastLiveState, 1000)
