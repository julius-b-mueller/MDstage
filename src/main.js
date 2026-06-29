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

// triggerIndex -> { ws, mainAudioEl, audios, musicFile, overlay, getX, autoMarkerState }
const triggerAudio = new Map()
// musicFile → { playbackGain, activeSource, startedAt, startOffset, decodedBuffer, volume }
// Populated in rerender() so buildTrigger can adopt a running audio graph without interrupting it.
const pendingAudioAdoptions = new Map()
let versionMismatchIgnored = false
let versionMismatchFileVersion = null
let _versionBumpAppVersion = null

// Valid top-level keys for each YAML block type — unknown keys are surfaced as parse errors.
const CONFIG_BLOCK_KEYS = new Set([
    'roles', 'groups', 'app_version', 'emLightNote', 'virtualChannels', 'outputDevices',
])
const TRIGGER_BLOCK_KEYS = new Set([
    'sibling', 'trigger_note', 'note', 'auto_mic', 'mic',
    'music', 'music_seq', 'osc', 'osc_arg', 'osc_arg_type',
    'qlcplus', 'projection', 'start_tc',
    'auto_trigger', 'chain_end', 'loop_outro',
    'cue_midi', 'cue_osc', 'cue_http',
])

// Allowed keys for nested objects inside a cue block — used to surface unknown
// keys at any depth, not just the top level. Keep in sync with the YAML spec in
// README.md (see [[project-yaml-spec]]).
const NOTE_REF_KEYS     = new Set(['ch', 'note'])                       // trigger_note / chain_end / loop_outro
const MUSIC_KEYS        = new Set(['file', 'volume', 'start', 'end', 'fadein', 'fadeout', 'fading_point', 'loop', 'audios', 'adjust'])
const MUSIC_SEQ_KEYS    = new Set(['file', 'volume', 'start', 'end', 'fadein', 'fadeout', 'fading_point', 'audios'])
const AUDIO_KEYS        = new Set(['file', 'mono', 'volume', 'patch'])
const ADJUST_KEYS       = new Set(['trigger_note', 'fadeout', 'fadetime', 'volume'])
const AUTO_TRIGGER_KEYS = new Set(['trigger_note', 'at', 'delay'])
const CUE_MIDI_KEYS     = new Set(['device', 'type', 'ch', 'note', 'vel', 'cc', 'value', 'program', 'bytes', 'comment'])
const CUE_OSC_KEYS      = new Set(['device', 'path', 'arg', 'arg_type', 'comment'])
const CUE_HTTP_KEYS     = new Set(['device', 'method', 'path', 'body', 'content_type', 'comment'])

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v) }

// Returns [{block, key}] for every YAML key not in the current spec, recursing
// into known nested objects/arrays. Nested paths use dotted/indexed notation
// (e.g. `music.adjust.foo`, `music_seq[1].bar`, `cue_midi[0].baz`).
function findUnknownYamlKeys(text) {
    const results = []
    const re = /```yaml\n([\s\S]*?)```/g
    let blockIndex = 0, m
    while ((m = re.exec(text)) !== null) {
        blockIndex++
        let parsed
        try { parsed = yaml.load(m[1]) } catch { continue }
        if (!parsed || typeof parsed !== 'object') continue

        const block = blockIndex
        const report = (obj, allowed, prefix) => {
            if (!isPlainObject(obj)) return
            for (const k of Object.keys(obj))
                if (!allowed.has(k)) results.push({ block, key: prefix + k })
        }

        if (parsed.config && typeof parsed.config === 'object') {
            report(parsed.config, CONFIG_BLOCK_KEYS, 'config.')
            continue
        }

        report(parsed, TRIGGER_BLOCK_KEYS, '')

        // Nested objects within a cue block
        report(parsed.trigger_note, NOTE_REF_KEYS, 'trigger_note.')
        report(parsed.chain_end,    NOTE_REF_KEYS, 'chain_end.')
        report(parsed.loop_outro,   NOTE_REF_KEYS, 'loop_outro.')

        if (isPlainObject(parsed.music)) {
            report(parsed.music, MUSIC_KEYS, 'music.')
            if (isPlainObject(parsed.music.adjust)) {
                report(parsed.music.adjust, ADJUST_KEYS, 'music.adjust.')
                report(parsed.music.adjust.trigger_note, NOTE_REF_KEYS, 'music.adjust.trigger_note.')
            }
            if (Array.isArray(parsed.music.audios))
                parsed.music.audios.forEach((a, i) => report(a, AUDIO_KEYS, `music.audios[${i}].`))
        }

        if (Array.isArray(parsed.music_seq))
            parsed.music_seq.forEach((item, i) => {
                report(item, MUSIC_SEQ_KEYS, `music_seq[${i}].`)
                if (isPlainObject(item) && Array.isArray(item.audios))
                    item.audios.forEach((a, j) => report(a, AUDIO_KEYS, `music_seq[${i}].audios[${j}].`))
            })

        if (isPlainObject(parsed.auto_trigger)) {
            report(parsed.auto_trigger, AUTO_TRIGGER_KEYS, 'auto_trigger.')
            report(parsed.auto_trigger.trigger_note, NOTE_REF_KEYS, 'auto_trigger.trigger_note.')
        }

        if (Array.isArray(parsed.cue_midi))
            parsed.cue_midi.forEach((item, i) => report(item, CUE_MIDI_KEYS, `cue_midi[${i}].`))
        if (Array.isArray(parsed.cue_osc))
            parsed.cue_osc.forEach((item, i) => report(item, CUE_OSC_KEYS, `cue_osc[${i}].`))
        if (Array.isArray(parsed.cue_http))
            parsed.cue_http.forEach((item, i) => report(item, CUE_HTTP_KEYS, `cue_http[${i}].`))
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
            hint: t('ver.security.hint'),
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
// cueIdx → {position, at} captured on every timeupdate, so Back can resume a track at
// the position (or beat-compensated loop position) it had right before it was stopped.
const lastPlaybackPos = new Map()
// cueIdx → {phase, at}: total-sequence phase of a multi-file SLF loop at the last slot
// boundary + the wall-clock time it happened. Lets Back compute where the sequence would
// be now (phase + elapsed, mod total length) and resume there, beat-compensated.
const seqPhaseAnchor = new Map()
// Crossfade window (seconds) for the Back loop-resume handover: when Back undoes a
// finish/outro and resumes the loop it handed off from, the finish is faded out over this
// time while the loop snaps back in — a short crossfade instead of two 500 ms fades that
// overlap and comb/phase when loop and finish share material (e.g. same drums + extra
// melody). Tunable by ear: smaller = less phaser but more abrupt, larger = smoother.
const BACK_HANDOVER_FADE = 0.05
// musicFile -> triggerIndex[]  (for cross-trigger fade lookups)
const fileToTriggers = new Map()
// targetIdx → <button> element for auto-cue progress bar updates
const autoTriggerBtns = new Map()
const autoMicBtns = new Map()
// sourceIdx → { links, unPlay, unTime, unPause, unFin, markFired, getUnfiredPast }
const autoTriggerSetup = new Map()
// targetIdx → { sourceIdx, timeoutId, rafId } for delay-based auto-cues currently counting down
const delayAutoTimers = new Map()
// sourceIdx currently being scrubbed (drag on waveform while playing)
const scrubbingSet = new Set()

let mainAudioDevice    = null
// Virtual channels: an abstraction layer between cue audio and the soundcard.
// Defined in settings (count + names, independent of the device), each routed 1:1
// to a physical output. [{ name, output }] — output = 0-based device channel or null.
let virtualChannels = [{ name: 'L', output: 0 }, { name: 'R', output: 1 }]
let audioOutputDevices = []
let editorApp = null
let audioBasePath = 'audio/'
let sharedAudioCtx = null

// Bumped whenever decoded buffers are invalidated (e.g. audio-device change). A decode
// in flight checks its captured generation after the await and skips the assignment if
// it's stale — prevents a freed buffer from being resurrected and avoids double-decodes.
let decodeGen = 0

// Device colours come from the shared .md and are interpolated into style.cssText. Only
// allow hex literals so a hand-edited file can't inject arbitrary CSS (e.g. an exfil beacon
// via `background:url(...)`). Anything else falls back to no colour.
function safeColor(c) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : ''
}

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

// Build the runtime virtual channels from the show's vChannel NAMES (shared, from the .md)
// and the machine-local name→physical-output routing (`virtualChannelOutputs`, userData).
// Unrouted channels default positionally (i-th vChannel → output i), so the default L/R pair
// maps to outputs 0/1 with no local config needed.
function buildVirtualChannels(names, outputs) {
    outputs = (outputs && typeof outputs === 'object') ? outputs : {}
    const list = (Array.isArray(names) && names.length)
        ? names
        : [{ name: 'L' }, { name: 'R' }]
    return list
        .map(v => (typeof v === 'string' ? { name: v } : v))
        .filter(v => v && typeof v.name === 'string' && v.name.trim())
        .map((v, i) => {
            const name = String(v.name).trim()
            const out = outputs[name]
            return { name, output: Number.isInteger(out) && out >= 0 ? out : i }
        })
}

// 0-based physical output channel for a virtual-channel name, or null if the
// vChannel doesn't exist or isn't routed.
function physicalOutputFor(vName) {
    const vc = virtualChannels.find(v => v.name === vName)
    return vc && vc.output != null ? vc.output : null
}

// Number of device output channels needed = highest routed physical channel + 1
// (minimum 2 for stereo). Independent of how many vChannels are defined.
function requiredChannelCount() {
    let max = 1
    for (const v of virtualChannels)
        if (v.output != null && v.output > max) max = v.output
    return max + 1
}

function getAudioCtx() {
    if (!sharedAudioCtx) sharedAudioCtx = new AudioContext()
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {})
    const dest   = sharedAudioCtx.destination
    const needed = requiredChannelCount()
    if (needed > 2 && dest.maxChannelCount >= needed && dest.channelCount < needed) {
        dest.channelCountMode = 'explicit'
        dest.channelCount = needed
    }
    return sharedAudioCtx
}

// Average all channels of a buffer into a single Float32Array (mono downmix).
function downmixMono(buf) {
    const len = buf.length
    const out = new Float32Array(len)
    const n = buf.numberOfChannels
    for (let c = 0; c < n; c++) {
        const data = buf.getChannelData(c)
        for (let i = 0; i < len; i++) out[i] += data[i]
    }
    if (n > 1) for (let i = 0; i < len; i++) out[i] /= n
    return out
}

// Resolve a cue audio's patch into a per-source-channel array of vChannel-name lists.
// audio.patch may be: undefined (simple mode → default stereo onto the first vChannels),
// or an array (entries = name or [names] for fan-out). numCh is the source channel count
// (1 when mono). Returns Float32-channel-count-aligned arrays of names.
function resolveAudioPatch(audio, numCh) {
    if (Array.isArray(audio.patch) && audio.patch.length) {
        return audio.patch.map(entry => Array.isArray(entry) ? entry.slice() : [entry])
    }
    // Simple mode: map channel i → virtualChannels[i]. A mono source fans out to the
    // first two vChannels (L/R) so it isn't stuck on one side.
    if (numCh === 1) {
        const names = virtualChannels.slice(0, 2).map(v => v.name)
        return [names.length ? names : []]
    }
    return Array.from({ length: numCh }, (_, i) =>
        virtualChannels[i] ? [virtualChannels[i].name] : [])
}

// Builds one multichannel AudioBuffer for a cue from its decoded audios.
// `audios`: [{ buf: AudioBuffer, mono: bool, volume: number, patch: [[vName,...], ...] }].
// Each source channel is copied (scaled by per-audio volume) onto the physical output(s)
// of its patched vChannel(s). Routing is 1:1 (no summing); shorter audios are zero-padded.
function buildCueBuffer(audios) {
    if (!audios || !audios.length) return null
    const sr     = audios[0].buf.sampleRate
    const totalCh = requiredChannelCount()
    let maxLen = 0
    for (const a of audios) maxLen = Math.max(maxLen, a.buf.length)

    const dest = sharedAudioCtx?.destination
    if (dest && dest.maxChannelCount < totalCh) {
        console.info(`[multichannel] Gerät unterstützt < ${totalCh} Kanäle – einige vKanäle bleiben stumm`)
    }
    if (dest && dest.maxChannelCount >= totalCh && totalCh > 2) {
        dest.channelCountMode = 'explicit'
        dest.channelCount = totalCh
    }

    const out = sharedAudioCtx.createBuffer(totalCh, maxLen, sr)
    for (const a of audios) {
        const srcChans = a.mono
            ? [downmixMono(a.buf)]
            : Array.from({ length: a.buf.numberOfChannels }, (_, c) => a.buf.getChannelData(c))
        const vol = a.volume ?? 1
        const patch = a.patch || resolveAudioPatch(a, srcChans.length)
        patch.forEach((vNames, chIdx) => {
            let data = srcChans[chIdx]
            if (!data) return
            if (vol !== 1) {
                const scaled = new Float32Array(data.length)
                for (let i = 0; i < data.length; i++) scaled[i] = data[i] * vol
                data = scaled
            }
            for (const vName of vNames) {
                const phys = physicalOutputFor(vName)
                if (phys == null || phys >= totalCh) continue
                out.copyToChannel(data, phys)   // 1:1, last write wins (no summing)
            }
        })
    }
    return out
}

// Decode all of a cue's audio files and merge them into one device buffer.
// `audios`: [{ file, mono, volume, patch }] (patch = raw YAML patch or undefined).
async function decodeCueAudios(ctx, audios) {
    const decoded = []
    for (const a of audios) {
        const ab  = await (await fetch(audioBasePath + a.file)).arrayBuffer()
        const buf = await ctx.decodeAudioData(ab)
        const numCh = a.mono ? 1 : buf.numberOfChannels
        if (Array.isArray(a.patch) && a.patch.length !== numCh)
            console.warn(`[multichannel] ${a.file}: patch hat ${a.patch.length} Einträge, Datei hat ${numCh} Kanäle`)
        decoded.push({ buf, mono: !!a.mono, volume: a.volume ?? 1, patch: resolveAudioPatch(a, numCh) })
    }
    return buildCueBuffer(decoded)
}

// Cache of audio file → channel count (for the cue patch UI). Decoding is the only
// reliable way to learn channel count in the browser; results are memoized.
const channelCountCache = new Map()
async function detectChannelCount(file) {
    if (!file) return 0
    if (channelCountCache.has(file)) return channelCountCache.get(file)
    try {
        const ctx = getAudioCtx()
        const ab  = await (await fetch(audioBasePath + file)).arrayBuffer()
        const buf = await ctx.decodeAudioData(ab)
        channelCountCache.set(file, buf.numberOfChannels)
        return buf.numberOfChannels
    } catch (e) {
        console.warn('[patch] channel detection failed for', file, e)
        return 0
    }
}

// Normalize a cue's `music` YAML into the audios list used for playback.
// Accepts the scalar short form (`music: file.wav`), the `music.file` object form,
// and the explicit `music.audios` list. Returns [{ file, mono, volume, patch }].
function extractCueAudios(musicYaml) {
    if (!musicYaml) return []
    if (typeof musicYaml === 'string') {
        const f = sanitizeAudioPath(musicYaml)
        return f ? [{ file: f, mono: false, volume: 1, patch: null }] : []
    }
    if (Array.isArray(musicYaml.audios) && musicYaml.audios.length) {
        return musicYaml.audios.map(a => ({
            file:   sanitizeAudioPath(a && a.file),
            mono:   !!(a && a.mono),
            volume: (a && a.volume != null) ? a.volume : 1,
            patch:  Array.isArray(a && a.patch) ? a.patch : null,
        })).filter(a => a.file)
    }
    if (musicYaml.file) {
        const f = sanitizeAudioPath(musicYaml.file)
        return f ? [{ file: f, mono: false, volume: 1, patch: null }] : []
    }
    return []
}

async function preDecodeForGapless(targetIdx) {
    const ta = triggerAudio.get(targetIdx)
    if (!ta || ta.decodedBuffer || ta._decoding) return
    ta._decoding = true
    const gen = decodeGen
    try {
        const ctx = getAudioCtx()
        const merged = await decodeCueAudios(ctx, ta.audios || [])
        if (gen !== decodeGen) return   // invalidated mid-decode (e.g. device change) — drop
        ta.decodedBuffer = merged
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
        const gen = decodeGen
        try {
            const merged = await decodeCueAudios(ctx, slot.audios || [])
            if (gen !== decodeGen) continue   // invalidated mid-decode — drop stale buffer
            slot.decodedBuffer = merged
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
function buildSeqSlot({ index, seqSlotIdx, musicFile, audios, mp, parentContainer }) {
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
        audios: audios ?? [{ file: musicFile, mono: false, volume: mp.volume ?? 1, patch: null }],
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

        setGain(v) { if (seqPlaybackGain) seqPlaybackGain.gain.value = v },

        // Fade this slot's gain up from 0 to targetVol — used when Back resumes a stopped
        // multi-file SLF loop on a non-primary slot.
        fadeIn(targetVol, durationSec) {
            const ctx = sharedAudioCtx
            if (!ctx || !seqPlaybackGain) return
            seqPlaybackGain.gain.cancelScheduledValues(ctx.currentTime)
            seqPlaybackGain.gain.setValueAtTime(0, ctx.currentTime)
            seqPlaybackGain.gain.linearRampToValueAtTime(targetVol, ctx.currentTime + durationSec)
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
let cueHistoryAuto = []   // parallel to cueHistory: true = fired automatically (auto_trigger YAML or chain_end transition), not by an operator action
let pendingAutoTrigger = false  // set just before calling triggerAction from auto-trigger
let liveViewOpen = false
let showLock = false
let lockAutoActivated = false
// When a file is opened with Lock active, startup dialogs and the error banner are deferred
// here and only run on the first unlock (so a locked live view opens clean).
let deferredStartupActions = []
let armedCue = null
let lastStartedAudioCue = null  // index of the most recently played audio cue (Space toggles it)
let midiGoNote = null
let midiBackNote = null
let midiBackLongPressTimer = null
let midiBackLongPressed    = false
let pickModeCallback = null
let midiAccess = null
let micDeviceOutputs = []   // MIDI output per micDevices entry (null = not connected / OSC)
let midiTrigger = null
let midiTCOutputs = []
let midiLiveDevice = null
let cueTriggerMidiDevice = null   // dedicated MIDI input that fires cues by their trigger_note
let mtc = null
let oscEnabled = false
let oscHost = '127.0.0.1'
let oscPort = 8000
let outputDevices     = []   // unified [{name, type:'midi'|'osc', ...}]
let midiOutputDevices = []   // [{name, device, sendTriggerNote, color}]  — derived from outputDevices
let midiOutputPorts   = []   // resolved MIDI output ports (parallel array)
let oscOutputDevices  = []   // [{name, enabled, host, port, sendTriggerNote, color}] — derived from outputDevices
let httpOutputDevices = []   // [{name, enabled, url, color}] — derived from outputDevices
let remoteCuesBlocked = false // session gate: when set, no cue drives MIDI/OSC/HTTP outputs
let appLanguage = 'de'
let micGroupDisplay = true      // whether to bundle mic roles into group boxes in the UI
let mainTextZoom = 1   // loaded from device prefs (editor-prefs.json) in initApp

function applyMainZoom() {
    const el = document.getElementById('script-content')
    if (el) el.style.zoom = mainTextZoom === 1 ? '' : String(mainTextZoom)
}

function setMainZoom(value) {
    mainTextZoom = Math.round(Math.max(0.5, Math.min(2.0, value)) * 10) / 10
    window.electronAPI.saveEditorPrefs?.({ mainTextZoom })
    applyMainZoom()
}

function changeMainZoom(delta) {
    setMainZoom(mainTextZoom + delta)
}
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
    updateHeaderShield()  // left reserve of the heading text depends on sidebar state
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
function showConfirmDialog({ title, body, hint = null, confirmLabel = 'Ja', cancelLabel = 'Abbrechen', img = null }) {
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
        bodyEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 1rem;line-height:1.6'
        bodyEl.innerHTML = DOMPurify.sanitize(body, { ALLOWED_TAGS: ['strong', 'br'], ALLOWED_ATTR: [] })

        const hintEl = hint ? document.createElement('p') : null
        if (hintEl) {
            hintEl.style.cssText = 'color:#e06c75;font-size:0.85rem;margin:0 0 1.5rem;line-height:1.6'
            hintEl.textContent = hint
        }

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
        box.append(...(imgEl ? [imgEl] : []), h3, bodyEl, ...(hintEl ? [hintEl] : []), actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        ;(cancelBtn ?? confirmBtn).focus()
    })
}

// Modal asking for a delay in seconds. Resolves to the number (>= 0) or null on cancel.
function showDelayDialog(initial = 5) {
    return new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.className = 'dialog-overlay'
        overlay.style.zIndex = '9999'
        overlay.addEventListener('mousedown', e => e.stopPropagation())

        const box = document.createElement('div')
        box.className = 'dialog-box'
        const h3 = document.createElement('h3')
        h3.textContent = t('dlg.autocue.delay.title')
        const bodyEl = document.createElement('p')
        bodyEl.style.cssText = 'color:#abb2bf;font-size:0.9rem;margin:0 0 1rem;line-height:1.6'
        bodyEl.textContent = t('dlg.autocue.delay.body')

        const input = document.createElement('input')
        input.type = 'number'; input.min = '0'; input.step = '0.1'; input.value = String(initial)
        input.classList.add('dialog-select')
        input.style.cssText = 'width:8rem;margin:0 0 1.2rem'

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'
        const close = (val) => { overlay.remove(); resolve(val) }
        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'dialog-btn'; cancelBtn.textContent = t('dlg.cancel')
        cancelBtn.addEventListener('click', () => close(null))
        const confirmBtn = document.createElement('button')
        confirmBtn.className = 'dialog-btn dialog-btn-primary'; confirmBtn.textContent = t('dlg.ok')
        const submit = () => {
            const v = parseFloat(input.value)
            if (!isFinite(v) || v < 0) { input.focus(); return }
            close(v)
        }
        confirmBtn.addEventListener('click', submit)
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit() })

        actions.append(cancelBtn, confirmBtn)
        box.append(h3, bodyEl, input, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        input.focus(); input.select()
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
        hintEl.style.cssText = 'color:#5c6370;font-size:0.85rem;margin:0 0 0.8rem;line-height:1.6'
        hintEl.textContent = t('ver.mismatch.hint')

        const securityEl = document.createElement('p')
        securityEl.style.cssText = 'color:#e06c75;font-size:0.85rem;margin:0 0 1rem;line-height:1.6'
        securityEl.textContent = t('ver.security.hint')

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'
        const close = () => { overlay.remove(); resolve(false) }

        const okBtn = document.createElement('button')
        okBtn.className = 'dialog-btn dialog-btn-primary'
        okBtn.textContent = t('ver.mismatch.ok')
        okBtn.addEventListener('click', () => close())

        const els = [imgEl, h3, createdEl, currentEl, hintEl, securityEl]
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
        const prevIsRole   = () => {
            const p = out.length ? out[out.length - 1].trim() : ''
            return /^\*\*[^*]/.test(p) && /\*\*$/.test(p)
        }

        if (isHeading) {
            out.push(line)
            if (!nextIsBlank()) out.push('')
            continue
        }

        if (isStage) {
            // A stage direction directly under a role name is that role's inline
            // stage direction — keep it attached (no separating blank line above).
            if (!prevIsRole() && !prevBlankNow()) out.push('')
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
            // Split at hard line breaks first; only when <br> has content after it (not trailing).
            // Trailing <br> (already on its own line ending) is left as-is for idempotency.
            const brParts = trimmed.split(/<br>/i)
            const hasContentAfterBr = brParts.length > 1 && brParts[brParts.length - 1].trim() !== ''
            if (hasContentAfterBr) {
                const segments = brParts.map(p => p.trim()).filter(Boolean)
                const wrapped = segments.map(p => wrapSentencesFormat(p)).join(' <br>\n')
                for (const sl of wrapped.split('\n')) out.push(sl)
            } else {
                const wrapped = wrapSentencesFormat(trimmed)
                for (const sl of wrapped.split('\n')) out.push(sl)
            }
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
    const { blockEl } = inlineEditor
    const blockIdx = parseInt(blockEl.dataset.blockIdx)

    // Remember the previous editable block in the DOM before any changes
    let prevEl = blockEl.previousElementSibling
    while (prevEl && (isTriggerEl(prevEl) || prevEl.dataset.blockIdx === undefined)) {
        prevEl = prevEl.previousElementSibling
    }
    const prevIdx = prevEl ? parseInt(prevEl.dataset.blockIdx) : -1

    closeEditor(false)  // may reformat scriptText and shift line numbers

    // Re-read the block's line range from the (possibly reformatted) text so we
    // never splice with stale numbers.
    const info = getBlockInfo(blockIdx)
    if (info) {
        // Remove block lines plus the blank separator line(s) that precede them
        const lines = scriptText.split('\n')
        let removeFrom = info.lineStart
        while (removeFrom > 0 && lines[removeFrom - 1].trim() === '') removeFrom--
        lines.splice(removeFrom, info.lineEnd - removeFrom + 1)
        scriptText = lines.join('\n')
        writeScriptMd(scriptText)
        rerender(scriptText)
    }

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
    const textBlocks = blocks.filter(b => b.type === 'text')
    const hasCue = blocks.some(b => {
        if (b.type !== 'yaml') return false
        const m = b.content.match(/^```yaml\n([\s\S]*?)\n```$/)
        try { const y = yaml.load(m?.[1]); return y && !y.config } catch {}
        return false
    })
    const isOnlyHeading = textBlocks.length === 1 && /^#{1,2}/.test(textBlocks[0].content)
    const hasContent = hasCue || (textBlocks.length > 0 && !isOnlyHeading)
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
    btnCue.addEventListener('click', (e) => { e.stopPropagation(); showTriggerDialog({ insertAfterBlockIdx: tokenizeScript(scriptText).length - 1 }) })

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
        const hasTyped = !!getTyped(e.currentTarget).trim()
        if (inlineEditor?.isPersistent && !hasTyped && !hasConfirmed) {
            return
        }
        // Escape commits whatever has been entered (like ArrowUp/Down) instead of
        // discarding it — only a truly empty block is thrown away.
        if (hasConfirmed || hasTyped) {
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
        // Parenthetical-only text right after a role-only block is that role's
        // inline stage direction — attach it to the role block (no blank line)
        // instead of dropping it into a separate block on the next line.
        const attachToRole = isAfterRole && /^\s*(?:\([^)]*\)\s*)+$/.test(text)
        insertLines = attachToRole ? [mdLine] : ['', mdLine]
        _target = lineStart + 1
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
            if (e.key === ' ') { e.preventDefault(); if (ae?.tagName === 'BUTTON') ae.blur(); goAction(); return }
            if (e.key === 'Backspace') { e.preventDefault(); if (ae?.tagName === 'BUTTON') ae.blur(); backAction(); return }
        }
    } else if (!liveViewOpen && e.key === ' ' && !inlineEditor && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Live view closed: Space pauses/resumes the most recently started audio cue.
        // In lock mode it has no function — but still swallow it so the page doesn't scroll.
        const ae = document.activeElement
        const isInput = ae?.tagName === 'INPUT' || ae?.tagName === 'TEXTAREA' || ae?.isContentEditable
        if (!isInput) {
            e.preventDefault()
            if (ae?.tagName === 'BUTTON') ae.blur()
            if (!showLock && lastStartedAudioCue !== null) {
                triggerAudio.get(lastStartedAudioCue)?.togglePlayPause()
            }
            return
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
    // Cmd+= / Cmd++ → zoom in; Cmd+- → zoom out; Cmd+0 → reset
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault(); changeMainZoom(+0.1); return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault(); changeMainZoom(-0.1); return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); setMainZoom(1); return
    }
    // Escape → close search or sidebar
    if (e.key === 'Escape') {
        const bar = document.getElementById('search-bar')
        if (!bar.classList.contains('hidden')) { closeSearch(); return }
        document.getElementById('scene-sidebar').classList.remove('open')
        updateHeaderShield()
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
// A button that keeps focus after a mouse click shows a persistent focus ring
// (and Space is a global GO/▶ hotkey — a focused button would also re-fire on
// Space). Drop focus after the click so no ring lingers until the user clicks
// elsewhere. Runs in the capture phase so it still fires for buttons whose own
// click handler calls stopPropagation() (e.g. the cue action buttons).
document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button')
    if (btn && document.activeElement === btn) btn.blur()
}, { capture: true })
window.addEventListener('blur', () => { shiftHeld = false; document.body.classList.remove('shift-held') })
window.addEventListener('scroll', updateSidebarActive, { passive: true })
window.addEventListener('scroll', updateGutterState, { passive: true })
window.addEventListener('scroll', updateHeaderShield, { passive: true })

// Prevent Electron from navigating to dropped files (default browser/Electron behaviour).
// Individual drop targets handle the files themselves.
if (!window.__webPreview) {
    document.addEventListener('dragover', (e) => { e.preventDefault() })
    document.addEventListener('drop',     (e) => { e.preventDefault() })
}

const _headerShield = document.getElementById('header-shield')
const _headerHeading = document.getElementById('header-heading')

// The section heading currently scrolled up to (or past) the top bar — the last
// heading in DOM order whose top is at/above the given threshold.
function currentHeadingForBar(threshold) {
    const content = document.getElementById('script-content')
    if (!content) return null
    const headings = content.querySelectorAll(':scope > h1, :scope > h2, :scope > h3')
    let current = null
    for (const h of headings) {
        if (h.getBoundingClientRect().top <= threshold) current = h
        else break
    }
    // Still above the first heading → show the first (current) section anyway.
    if (!current && headings.length) current = headings[0]
    return current
}

function updateHeaderShield() {
    if (!_headerShield) return
    const btns   = document.querySelector('.buttons')
    const burger = document.querySelector('.sidebar-toggle-button')
    const burgerRect = burger ? burger.getBoundingClientRect() : null

    // Constrain the buttons row so its left edge can't slide under the burger
    // button — when the content needs more room, the emergency group (last flex
    // item) wraps to a second line instead of overlapping the burger.
    if (btns && burgerRect) {
        btns.style.maxWidth = Math.max(0, window.innerWidth - burgerRect.right - 16) + 'px'
    }

    const btnsRect   = btns ? btns.getBoundingClientRect() : null
    const btnEl      = btns ? btns.querySelector('.button') : null
    // Height of a single button row (not the wrapped 2-line height).
    const oneRow     = (btnsRect && btnEl) ? (btnsRect.top + btnEl.offsetHeight)
                                           : (btnsRect ? btnsRect.bottom : 0)
    const btnsBottom = btnsRect ? btnsRect.bottom : 0
    document.documentElement.style.setProperty('--btns-bottom', btnsBottom + 'px')

    if (_headerHeading) {
        // Single-row bar height matches an in-text heading box, min one button row.
        const sampleHeading = document.querySelector('#script-content > h1, #script-content > h2')
        const headingH = sampleHeading ? sampleHeading.offsetHeight : 0
        const rowH = Math.max(headingH, oneRow)

        // Which section are we in? (Heading scrolled up to the single-row bottom.)
        const heading = currentHeadingForBar(rowH)
        _headerHeading.textContent = heading ? heading.textContent.trim() : ''

        const sidebarOpen  = document.getElementById('scene-sidebar')?.classList.contains('open')
        const leftReserve  = sidebarOpen ? 252 : (burgerRect ? burgerRect.right + 10 : 10)
        const rightReserve = btnsRect ? (window.innerWidth - btnsRect.left + 10) : 10

        // Have the emergency buttons wrapped to a second line? (window too narrow)
        const emGroup = document.querySelector('.emergency-group')
        const emRect  = emGroup ? emGroup.getBoundingClientRect() : null
        const emWrapped = !!(emRect && btnsRect && emRect.top > btnsRect.top + 2)

        // Try a single row first: heading centered in the bar, squeezed between
        // the burger (left) and the buttons (right).
        _headerShield.classList.remove('two-row')
        _headerHeading.style.paddingTop   = '0'
        _headerHeading.style.lineHeight   = rowH + 'px'
        _headerHeading.style.paddingLeft  = leftReserve + 'px'
        _headerHeading.style.paddingRight = rightReserve + 'px'

        if (btns) btns.style.rowGap = '0px'
        let barH = rowH
        const overflows = heading && _headerHeading.scrollWidth > _headerHeading.clientWidth + 1
        if (heading && (overflows || emWrapped)) {
            // Two rows: UI on top (rowH), heading on the second rowH row. Always
            // 2*rowH so the bar never shrinks when the emergency group joins it.
            _headerShield.classList.add('two-row')
            _headerHeading.style.lineHeight  = rowH + 'px'
            _headerHeading.style.paddingLeft = '1rem'
            _headerHeading.style.paddingTop  = rowH + 'px'
            barH = rowH * 2
            if (emWrapped) {
                // Push the wrapped emergency group down via row-gap so its centre
                // lines up with the heading's (centre of the 2nd row = 1.5*rowH),
                // and keep its width clear on the right.
                if (btns) btns.style.rowGap = Math.max(0, 1.5 * rowH - oneRow - emRect.height / 2) + 'px'
                _headerHeading.style.paddingRight = (window.innerWidth - emRect.left + 10) + 'px'
            } else {
                _headerHeading.style.paddingRight = '1rem'
            }
        }
        _headerShield.style.height = barH + 'px'
    }

    // Keep the first cue/text block from hiding behind the bar.
    const content = document.getElementById('script-content')
    if (content) {
        const shieldBottom  = _headerShield.getBoundingClientRect().bottom
        const contentAbsTop = content.getBoundingClientRect().top + window.scrollY
        const cuePadding = Math.max(0, shieldBottom - contentAbsTop)
        document.documentElement.style.setProperty('--first-cue-padding', cuePadding + 'px')
    }
}
new ResizeObserver(updateHeaderShield).observe(document.querySelector('.buttons') ?? document.body)
window.addEventListener('resize', updateHeaderShield)
updateHeaderShield()
// Heading box height depends on the heading font / final layout; re-measure once
// fonts have loaded and after full page load so the bar isn't too short until the
// first scroll.
document.fonts?.ready?.then(updateHeaderShield)
window.addEventListener('load', updateHeaderShield)

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
        this.outputs = []
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

    setOutputs(outputs) { this.outputs = outputs ?? [] }
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
        if (!this.outputs.length) return
        const { hh, mm, ss, ff } = this._decompose(frames)
        const hhByte = (0b01 << 5) | hh  // 25fps type bits 6:5
        const msg = [0xF0, 0x7F, 0x7F, 0x01, 0x01, hhByte, mm, ss, ff, 0xF7]
        for (const out of this.outputs) out.send(msg)
    }

    _sendQF(frames) {
        if (!this.outputs.length) return
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
        const msg = [0xF1, (i << 4) | nibble]
        for (const out of this.outputs) out.send(msg)
    }

    onLoopRestart(loopDurSec, newStartSec) {
        // Single-file loop: the TC loops with the audio — jump back to startFrames
        // each iteration (loopOffsetFrames stays 0 here).
        this.loopOffsetFrames = 0
        this.iterStartSec = newStartSec
    }

    // Multi-file (music_seq) Vamp: point the TC at the currently active part-loop
    // slot. `offsetFrames` is the summed length of all earlier parts in the cycle
    // (0 for the first part → the TC resets there); `slotStartSec` is that slot's
    // local start; `ws` is the slot's wavesurfer so getCurrentTime tracks it.
    setSeqSegment(offsetFrames, slotStartSec, ws) {
        this.loopOffsetFrames = offsetFrames
        this.iterStartSec = slotStartSec
        if (ws) this.wsRef = ws
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
        // Re-measure after the headings have actually been laid out, so the bar
        // reaches full (heading-)height before the first scroll, not after.
        requestAnimationFrame(updateHeaderShield)
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

    const knownVChannels = new Set(virtualChannels.map(v => v.name))
    // Validate one entry of an `audios` list (used by music.audios and music_seq[i].audios).
    const validateAudioEntry = (a, prefix) => {
        if (!a || typeof a !== 'object' || typeof a.file !== 'string' || !a.file) {
            parseErrors.push({ blockNum, line: lineNum, message: `${prefix}: 'file' (String) fehlt` })
            return
        }
        if (a.volume != null && (typeof a.volume !== 'number' || !isFinite(a.volume) || a.volume < 0 || a.volume > 1))
            parseErrors.push({ blockNum, line: lineNum, message: `${prefix}.volume ungültig: ${a.volume}` })
        if (a.patch != null) {
            if (!Array.isArray(a.patch)) {
                parseErrors.push({ blockNum, line: lineNum, message: `${prefix}.patch muss eine Liste sein` })
            } else {
                for (const entry of a.patch) {
                    for (const n of (Array.isArray(entry) ? entry : [entry])) {
                        if (n != null && !knownVChannels.has(n))
                            parseErrors.push({ blockNum, line: lineNum, message: `${prefix}.patch: vKanal „${n}" existiert nicht (in den Einstellungen definieren oder YAML aufräumen)` })
                    }
                }
            }
        }
    }

    if (y.music && typeof y.music === 'object') {
        const { volume, start, end, fadein, fadeout, fading_point } = y.music
        if (volume != null && (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 1))
            parseErrors.push({ blockNum, line: lineNum, message: `music.volume ungültig: ${volume} (erwartet 0.0–1.0)` })
        for (const [k, v] of [['start', start], ['end', end], ['fadein', fadein], ['fadeout', fadeout], ['fading_point', fading_point]]) {
            if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0))
                parseErrors.push({ blockNum, line: lineNum, message: `music.${k} ungültig: ${v} (nicht-negative Zahl erwartet)` })
        }
        if (y.music.audios != null) {
            if (!Array.isArray(y.music.audios)) parseErrors.push({ blockNum, line: lineNum, message: 'music.audios muss eine Liste sein' })
            else y.music.audios.forEach((a, i) => validateAudioEntry(a, `music.audios[${i}]`))
        }
    }

    if (y.music_seq != null) {
        if (!Array.isArray(y.music_seq)) {
            parseErrors.push({ blockNum, line: lineNum, message: 'music_seq muss eine Liste sein' })
        } else {
            y.music_seq.forEach((item, i) => {
                const hasAudios = item && typeof item === 'object' && Array.isArray(item.audios) && item.audios.length
                if (!item || typeof item !== 'object' || (!hasAudios && (typeof item.file !== 'string' || !item.file))) {
                    parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}]: 'file' oder 'audios' fehlt` })
                    return
                }
                const { volume, start, end, fadein, fadeout, fading_point } = item
                if (volume != null && (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 1))
                    parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}].volume ungültig: ${volume}` })
                for (const [k, v] of [['start', start], ['end', end], ['fadein', fadein], ['fadeout', fadeout], ['fading_point', fading_point]]) {
                    if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0))
                        parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}].${k} ungültig: ${v}` })
                }
                if (item.audios != null) {
                    if (!Array.isArray(item.audios)) parseErrors.push({ blockNum, line: lineNum, message: `music_seq[${i}].audios muss eine Liste sein` })
                    else item.audios.forEach((a, j) => validateAudioEntry(a, `music_seq[${i}].audios[${j}]`))
                }
            })
        }
    }

    if (y.auto_trigger && typeof y.auto_trigger === 'object' && y.auto_trigger.at != null) {
        const { at } = y.auto_trigger
        if (typeof at !== 'number' || !isFinite(at) || at < 0)
            parseErrors.push({ blockNum, line: lineNum, message: `auto_trigger.at ungültig: ${at} (nicht-negative Zahl erwartet)` })
    }
    if (y.auto_trigger && typeof y.auto_trigger === 'object' && y.auto_trigger.delay != null) {
        const { delay } = y.auto_trigger
        if (typeof delay !== 'number' || !isFinite(delay) || delay < 0)
            parseErrors.push({ blockNum, line: lineNum, message: `auto_trigger.delay ungültig: ${delay} (nicht-negative Zahl erwartet)` })
    }

    if (y.cue_midi != null && !Array.isArray(y.cue_midi))
        parseErrors.push({ blockNum, line: lineNum, message: 'cue_midi muss eine Liste sein' })

    if (y.cue_osc != null && !Array.isArray(y.cue_osc))
        parseErrors.push({ blockNum, line: lineNum, message: 'cue_osc muss eine Liste sein' })

    if (y.cue_http != null && !Array.isArray(y.cue_http))
        parseErrors.push({ blockNum, line: lineNum, message: 'cue_http muss eine Liste sein' })
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

// Persistent, visible state: when outputs are blocked, no cue drives MIDI/OSC/HTTP. Set from
// the settings toggle, the trust dialog's "block" choice, or the indicator's unblock button —
// all three persist `outputsBlocked` so the state survives reloads and stays in sync.
function updateOutputsBlockedBar() {
    let bar = document.getElementById('outputs-blocked-bar')
    if (!remoteCuesBlocked) { bar?.remove(); return }
    if (bar) return
    bar = document.createElement('div')
    bar.id = 'outputs-blocked-bar'
    bar.className = 'outputs-blocked-bar'
    const label = document.createElement('span')
    label.textContent = t('outputs.blocked.label')
    const btn = document.createElement('button')
    btn.textContent = t('outputs.blocked.unblock')
    btn.addEventListener('click', () => setOutputsBlocked(false))
    bar.append(label, btn)
    document.body.appendChild(bar)
}

function setOutputsBlocked(blocked) {
    remoteCuesBlocked = blocked
    updateOutputsBlockedBar()
    // Machine-local flag → write only editor-prefs.json (no show-file rewrite/version bump).
    window.electronAPI?.saveEditorPrefs?.({ outputsBlocked: blocked })
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

// Parse a dotted/indexed key path ("music.adjust.foo", "cue_midi[1].bar",
// "config.baz") into an array of object keys / numeric array indices.
function parseKeyPath(key) {
    const parts = []
    for (const seg of key.split('.')) {
        const name = seg.replace(/\[\d+\]/g, '')
        if (name) parts.push(name)
        for (const im of seg.matchAll(/\[(\d+)\]/g)) parts.push(Number(im[1]))
    }
    return parts
}

// Delete the leaf addressed by a key path from a parsed YAML object, walking
// through intermediate objects/arrays. No-op if any segment is missing.
function deleteByKeyPath(root, key) {
    const parts = parseKeyPath(key)
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur == null) return
        cur = cur[parts[i]]
    }
    if (cur != null && typeof cur === 'object') delete cur[parts[parts.length - 1]]
}

function deleteUnknownYamlKey(blockNum, key) {
    let count = 0
    const newText = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        count++
        if (count !== blockNum) return match
        let parsed
        try { parsed = yaml.load(content) } catch { return match }
        if (!parsed || typeof parsed !== 'object') return match
        deleteByKeyPath(parsed, key)
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

// Read the value addressed by a dotted/indexed key path (mirror of deleteByKeyPath).
function getByKeyPath(root, key) {
    let cur = root
    for (const p of parseKeyPath(key)) {
        if (cur == null) return undefined
        cur = cur[p]
    }
    return cur
}

// Build a cleaned version of the script without writing it. Removes:
//   1. Unknown YAML keys at any nesting level (spec violations).
//   2. Inert loop remnants — `fading_point`/`loop` on a cue that is no longer a
//      loop (e.g. left over after converting a Vamp back to a normal cue).
// Returns { removals: [{block, key, value}], newText }.
function computeYamlCleanup() {
    const unknownByBlock = new Map()
    for (const { block, key } of findUnknownYamlKeys(scriptText)) {
        if (!unknownByBlock.has(block)) unknownByBlock.set(block, [])
        unknownByBlock.get(block).push(key)
    }
    const removals = []
    let blockIndex = 0
    const newText = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIndex++
        let parsed
        try { parsed = yaml.load(content) } catch { return match }
        if (!parsed || typeof parsed !== 'object') return match
        const block = blockIndex
        let changed = false
        const remove = (key) => {
            const value = getByKeyPath(parsed, key)
            if (value === undefined) return
            removals.push({ block, key, value })
            deleteByKeyPath(parsed, key)
            changed = true
        }
        // 1. Unknown keys (spec violations, any nesting)
        for (const key of unknownByBlock.get(block) || []) remove(key)
        // 2. Inert loop remnants — cue blocks that are not loops
        if (!(parsed.config && typeof parsed.config === 'object')) {
            const isLoop = parsed.music?.loop === true
                || Object.prototype.hasOwnProperty.call(parsed, 'loop_outro')
                || Array.isArray(parsed.music_seq)
            if (!isLoop && isPlainObject(parsed.music)) {
                if (Object.prototype.hasOwnProperty.call(parsed.music, 'fading_point')) remove('music.fading_point')
                if (parsed.music.loop === false) remove('music.loop')
            }
        }
        // 3. Audios routed to vChannels that no longer exist in the settings (music + music_seq)
        {
            const known = new Set(virtualChannels.map(v => v.name))
            const patchRefsMissing = (a) => Array.isArray(a?.patch) && a.patch.some(entry =>
                (Array.isArray(entry) ? entry : [entry]).some(n => n != null && !known.has(n)))
            const pruneAudios = (container, keyPrefix) => {
                if (!isPlainObject(container) || !Array.isArray(container.audios)) return
                const kept = []
                container.audios.forEach((a, i) => {
                    if (patchRefsMissing(a)) {
                        removals.push({ block, key: `${keyPrefix}.audios[${i}]`, value: a })
                        changed = true
                    } else kept.push(a)
                })
                if (kept.length !== container.audios.length) container.audios = kept
            }
            pruneAudios(parsed.music, 'music')
            if (Array.isArray(parsed.music_seq))
                parsed.music_seq.forEach((item, i) => pruneAudios(item, `music_seq[${i}]`))
        }
        if (!changed) return match
        const newYaml = yaml.dump(parsed, { indent: 4, lineWidth: -1, noRefs: true })
        return block === 1
            ? `\`\`\`yaml\n${newYaml.trimEnd()}\n\`\`\``
            : `\`\`\`yaml\n${inlineNoteObjects(newYaml.trimEnd())}\n\`\`\``
    })
    return { removals, newText }
}

// Menu entry point (invoked from electron/main.js via window.__runYamlCleanup).
window.__runYamlCleanup = async function () {
    const { removals, newText } = computeYamlCleanup()
    if (!removals.length) {
        await showConfirmDialog({
            title: t('cleanup.title'),
            body: t('cleanup.none'),
            confirmLabel: 'OK',
            cancelLabel: null,
        })
        return
    }
    const MAX = 30
    const shown = removals.slice(0, MAX).map(r =>
        `Block ${r.block}: <strong>${escapeHtml(r.key)}</strong> = ${escapeHtml(JSON.stringify(r.value))}`
    ).join('<br>')
    const more = removals.length > MAX ? `<br>… ${removals.length - MAX} ${t('cleanup.more')}` : ''
    const proceed = await showConfirmDialog({
        title: t('cleanup.title'),
        body: `${t('cleanup.body').replace('%1', removals.length)}<br><br>${shown}${more}`,
        hint: t('cleanup.backup'),
        confirmLabel: t('cleanup.confirm'),
        cancelLabel: t('btn.cancel'),
    })
    if (!proceed) return
    try {
        await window.electronAPI.backupScriptMdUncleaned()
    } catch (e) {
        console.error('YAML-Cleanup-Backup fehlgeschlagen:', e)
        return
    }
    scriptText = newText
    await writeScriptMd(newText)
    rerender(newText)
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
        // Skip yaml tokens with no DOM representation (config yaml is removed by convertCodeblocks).
        // Always skip config yaml (detected by leading "config:" key), even for trigger children.
        while (ti < blocks.length) {
            const b = blocks[ti]
            if (b.type !== 'yaml') break
            if (isTriggerEl(child) && !/^```yaml\nconfig:/.test(b.content)) break
            ti++
        }
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
    const isFirstText = firstBlock?.tagName === 'P'
    content.classList.toggle('first-block-is-cue', isFirstCue)
    content.classList.toggle('first-block-is-text', !!isFirstText)
    // Mark the very first heading so it can drop its top margin (no gap at the
    // top when scrolled up) — :first-child fails because of leading .insert-zone.
    if (firstBlock?.matches?.('h1, h2')) firstBlock.classList.add('first-heading')
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

// cb(index) on pick. eligibilityFn gates which clicks count (others cancel). highlightFn (when
// given) marks a *subset* visually without dimming the rest — used by Auto-Cue, where every cue
// is a valid source but only the audio-positioned ones deserve a highlight.
function enterPickMode(cb, eligibilityFn = null, highlightFn = null) {
    pickModeCallback = cb
    pickModeEligibilityFn = eligibilityFn
    if (highlightFn) {
        document.body.classList.add('trigger-pick-mode-highlight')
        for (let i = 1; i < triggers.length; i++)
            if (triggers[i]) triggers[i].classList.toggle('trigger-pick-eligible', highlightFn(i))
    } else if (eligibilityFn) {
        document.body.classList.add('trigger-pick-mode-filtered')
        for (let i = 1; i < triggers.length; i++)
            if (triggers[i]) triggers[i].classList.toggle('trigger-pick-eligible', eligibilityFn(i))
    } else {
        document.body.classList.add('trigger-pick-mode')
    }
    document.addEventListener('keydown', _pickEscHandler)
}

function exitPickMode() {
    pickModeCallback = null
    pickModeEligibilityFn = null
    document.body.classList.remove('trigger-pick-mode', 'trigger-pick-mode-filtered', 'trigger-pick-mode-highlight')
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
        btn.title = aty
            ? (aty.delay != null ? `${t('btn.autocue.title.edit')} (+${aty.delay}s)` : t('btn.autocue.title.edit'))
            : t('btn.autocue.title.set')
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

// Cancel a pending delay-based auto-cue (timer + progress bar) for one target.
function cancelDelayAutoCue(targetIdx) {
    const d = delayAutoTimers.get(targetIdx)
    if (!d) return
    clearTimeout(d.timeoutId)
    if (d.rafId) cancelAnimationFrame(d.rafId)
    delayAutoTimers.delete(targetIdx)
    const btn = autoTriggerBtns.get(targetIdx)
    if (btn) { btn.style.background = ''; btn.style.color = '' }
}

// Cancel all delay-based auto-cues whose source is one of the given cues.
function cancelDelayAutoCuesFromSources(sourceIdxs) {
    const set = new Set(sourceIdxs)
    for (const [target, d] of [...delayAutoTimers]) if (set.has(d.sourceIdx)) cancelDelayAutoCue(target)
}

// When `sourceCue` fires, arm every delay-based auto-cue that points at it (or at one of
// its variant siblings). Each fires its target `delay` seconds later via triggerAction —
// identical downstream behaviour (cueHistoryAuto tagging, live view) to audio auto-cues.
function armDelayAutoCues(sourceCue) {
    if (!triggerYamls[sourceCue]?.trigger_note) return
    const sourceRoot = groupRootOf(sourceCue)
    let armedAny = false
    for (let targetIdx = 1; targetIdx < triggerYamls.length; targetIdx++) {
        const aty = triggerYamls[targetIdx]?.auto_trigger
        if (!aty || aty.delay == null || !aty.trigger_note) continue
        const explicit = findTriggerByNote(aty.trigger_note)
        if (explicit === null || groupRootOf(explicit) !== sourceRoot) continue

        cancelDelayAutoCue(targetIdx)   // re-arm cleanly
        const delayMs = Math.max(0, aty.delay * 1000)
        const startedAt = performance.now()
        const btn = autoTriggerBtns.get(targetIdx)
        const entry = { sourceIdx: sourceCue, timeoutId: null, rafId: null, startedAt, delay: aty.delay }

        const tick = () => {
            if (!delayAutoTimers.has(targetIdx)) return
            const pct = delayMs > 0 ? Math.min(100, (performance.now() - startedAt) / delayMs * 100) : 100
            if (btn) btn.style.background = `linear-gradient(to right, rgba(152,195,121,0.35) ${pct}%, transparent ${pct}%)`
            if (pct < 100) entry.rafId = requestAnimationFrame(tick)
        }
        entry.timeoutId = setTimeout(() => {
            delayAutoTimers.delete(targetIdx)
            if (btn) { btn.style.background = ''; btn.style.color = '' }
            currentCue = targetIdx
            markTriggers(targetIdx)
            scrollToTrigger(targetIdx)
            pendingAutoTrigger = true
            triggerAction(targetIdx)
        }, delayMs)
        delayAutoTimers.set(targetIdx, entry)
        if (delayMs > 0) entry.rafId = requestAnimationFrame(tick)
        armedAny = true
    }
    // Push the new countdown(s) to the live view so it shows the auto-cue pending bar.
    if (armedAny) broadcastLiveState()
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
        let lastCt = -1   // previous playhead time, for loop-wrap detection

        // The auto-cue with the next-smaller `at` (this one's progress is relative
        // to it). Returns null if this is the first auto-cue on the source.
        const prevLinkOf = (link) => {
            let prev = null
            for (const o of links) {
                if (o === link || o.at >= link.at) continue
                if (prev === null || o.at > prev.at) prev = o
            }
            return prev
        }

        const clearProgressBars = () => {
            for (const link of links) {
                const b = autoTriggerBtns.get(link.targetIdx)
                if (b) { b.style.background = ''; b.style.color = '' }
            }
        }

        const onPlay = () => {
            firedSet.clear()
            // Use currentTime directly — it's already at the correct position whether
            // play was triggered by triggerAction, the waveform ▶ button, or after
            // a manual scrub while paused.
            const ct = ta.mainAudioEl.currentTime
            lastCt = ct
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
            // Loop wrap: the cursor jumped back to the loop start → re-arm all
            // auto-cues so they fire again on every loop pass, and reset their bars.
            if (ct < lastCt - 0.3) {
                firedSet.clear()
                clearProgressBars()
            }
            lastCt = ct
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
                // Progress bar fill — relative to the previous auto-cue (or the loop
                // start for the first one). The bar only appears once the previous
                // auto-cue has actually fired.
                const btn = autoTriggerBtns.get(link.targetIdx)
                if (btn && !firedSet.has(link.targetIdx)) {
                    const prev  = prevLinkOf(link)
                    const base  = prev ? prev.at : (ta.mp?.start ?? 0)
                    const ready = !prev || firedSet.has(prev.targetIdx)
                    if (ready && link.at > base) {
                        const pct = Math.min(100, Math.max(0, (ct - base) / (link.at - base) * 100))
                        btn.style.background = `linear-gradient(to right, rgba(152,195,121,0.35) ${pct}%, transparent ${pct}%)`
                    } else {
                        btn.style.background = ''
                    }
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
            const { trigger_note: tn, at, delay } = autoYaml
            const lines = ['auto_trigger:']
            if (tn) lines.push(`    trigger_note: {ch: ${tn.ch}, note: ${tn.note}}`)
            if (delay != null) lines.push(`    delay: ${parseFloat(delay.toFixed(3))}`)
            else lines.push(`    at: ${parseFloat(at.toFixed(3))}`)
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
        // Collect indices of all cues that currently have a manual mic set
        const manualMicIndices = triggerYamls
            .map((ty, i) => (i > 0 && ty?.mic !== undefined ? i : -1))
            .filter(i => i > 0)
        if (manualMicIndices.length > 0) {
            // All indices that should receive auto_mic (clicked cue + all manual-mic cues)
            const targets = [...new Set([triggerIndex, ...manualMicIndices])]
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
            keepBtn.addEventListener('click', () => { close(); _applyAutoMicToMany(targets, true) })
            removeBtn.addEventListener('click', () => { close(); removeAllManualMicsFromScript(); _applyAutoMicToMany(targets, true) })
            return
        }
    }
    _applyAutoMicInScript(triggerIndex, enabled)
}

// Apply auto_mic to multiple trigger indices in a single script write.
function _applyAutoMicToMany(indices, enabled) {
    const indexSet = new Set(indices)
    let blockIdx = 0
    const updated = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIdx++
        if (!indexSet.has(blockIdx - 1)) return match
        let c = content.replace(/^\s*auto_mic\s*:.*\n?/m, '')
        if (enabled) c = c.trimEnd() + '\nauto_mic: true\n'
        return `\`\`\`yaml\n${c}\`\`\``
    })
    scriptText = updated
    writeScriptMd(updated)
    for (const ti of indices) {
        if (!triggerYamls[ti]) continue
        if (enabled) triggerYamls[ti].auto_mic = true
        else delete triggerYamls[ti].auto_mic
    }
    _refreshAllMicDisplays()
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
    _refreshAllMicDisplays()
}

function _refreshAllMicDisplays() {
    const anyAutoMic = hasAnyAutoMic()
    for (let i = 1; i < triggerYamls.length; i++) {
        // Keep the auto-mic button's active state in sync first — it lives in the
        // action row, independent of the .trigger-info mic display below, so it
        // must not be gated behind the trigger-info guards.
        const btn = autoMicBtns.get(i)
        if (btn) updateAutoMicBtnAppearance(btn, i)

        const triggerEl = triggers[i]
        if (!triggerEl) continue
        const triggerInfo = triggerEl.querySelector('.trigger-info')
        if (!triggerInfo) continue
        triggerInfo.querySelector('.trigger-mic')?.remove()
        const ty = triggerYamls[i]
        const micValue = ty?.auto_mic ? computeAutoMicRoles(i) : (!anyAutoMic ? ty?.mic : null)
        if (micValue) {
            const micEl = document.createElement('div')
            micEl.classList.add('trigger-mic')
            renderMicIntoEl(micEl, micValue, !!ty?.auto_mic)
            triggerInfo.insertBefore(micEl, triggerInfo.firstChild)
        }
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

    // cue_http chips
    if (Array.isArray(codeblockYaml.cue_http) && codeblockYaml.cue_http.length > 0) {
        const httpRow = document.createElement('div')
        httpRow.classList.add('trigger-cue-osc')
        for (const msg of codeblockYaml.cue_http) {
            const chip = document.createElement('span')
            chip.classList.add('cue-msg-chip', 'cue-msg-chip--osc')
            const httpDevName = msg.device || httpOutputDevices[0]?.name || ''
            const isUnknownHttp = !!msg.device && !httpOutputDevices.some(d => d.name === msg.device)
            const httpDevColor = (httpOutputDevices.find(d => d.name === httpDevName) ?? httpOutputDevices[0])?.color || ''
            if (isUnknownHttp) chip.classList.add('cue-msg-chip--unknown')
            if (httpDevColor) chip.style.cssText = `border-color:${httpDevColor}55;background:${httpDevColor}12`
            const badge = document.createElement('span')
            badge.className = 'cue-type-badge'
            badge.textContent = (isUnknownHttp ? '! ' : '') + (httpDevName || 'HTTP')
            if (httpDevColor) badge.style.cssText = `background:${httpDevColor}30;color:${httpDevColor}`
            const content = document.createElement('span')
            content.className = 'cue-msg-content'
            content.textContent = msg.comment || `${(msg.method || 'GET')} ${msg.path || ''}`.trim()
            chip.appendChild(badge)
            chip.appendChild(content)
            httpRow.appendChild(chip)
        }
        triggerInfo.appendChild(httpRow)
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
        let inTail                  = false  // true while tail (post-fading_point) is playing
        let inTailDuration          = 0     // duration of the tail in seconds
        let suppressSeekRestart  = false
        let suppressPauseStop    = false  // prevents ws.on("pause") from killing a group source
        let forceFullBuffer      = false  // play button: ignore trim region, use full buffer
        let loopSourceSliced     = false  // active source is a sliced [start,end] loop buffer
                                          // (region-relative offset → audio-locked fade applies)

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
            loopSourceSliced = false
            // A fresh source start means no gapless transition is in progress for this trigger.
            // Clear any stale gaplessActive — otherwise ws.on("play") returns early on its
            // `if (gaplessActive) return` guard and never resets it, which would leave the
            // timeupdate boundary handler permanently skipping fireLoopRestart/fireLoopOutro
            // (hard loop, no tail, armed finish never fires) after a Back-resume.
            gaplessActive = false
            // Not in an outro tail anymore — the stale cleanup that would have reset these is
            // skipped on a Back-resume, so reset here (else the live-view fill stays faded out).
            inTail = false
            inTailDuration = 0
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
                loopSourceSliced        = true   // offset is region-relative (0..loopDur)
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

            // Initialise the SLF phase anchor here — the single choke-point where the primary
            // source actually starts. ws.on("play") used to do this, but ws.play(start) fires
            // "seeking" first, which starts the source via ws.on("seeking"); the "play" handler
            // then bails at `if (activeSource) return` before its anchor code, so a multi-file
            // loop started without ever anchoring → Back fell back to the non-beat-accurate
            // resume ("von vorne"). `when` is the exact AudioContext source-start time.
            { const _sd = triggerSeqSlots.get(index)
              if (_sd && _sd.total > 1 && _sd.idx === 0) {
                  const _ph = Math.max(0, offset - (mp.start ?? 0))
                  seqPhaseAnchor.set(index, { phase: _ph, at: performance.now(), ctxAt: when })
              } }
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

        function _nonAudioActions(nextIdx, nextTa, isAuto = false) {
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
                    let frames = mtc.getCurrentFrames()
                    // Multi-file Vamp Finish: TC = loop start + total length of all
                    // part-loops, regardless of which part the devamp fired from.
                    const sd = triggerSeqSlots.get(index)
                    if (isOT && sd && sd.total > 1) frames = mtc.startFrames + seqTotalFrames(index)
                    mtc.startFromFrames(frames, nextTa.ws, nextIdx, nextTa.mp?.start ?? 0)
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
            cueHistory.push(nextIdx); cueHistoryAuto.push(isAuto)
            broadcastLiveState()
        }

        function fireGaplessTransition(nextIdx, isAuto = false) {
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
                sendCueHttpMessages(nextIdx)
                cueHistory.push(nextIdx); cueHistoryAuto.push(isAuto)
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
                    // ① fading_point: stop the looping source at the boundary and play its
                    // decay tail as a scheduled one-shot. `activeSource.loop = false` is racy —
                    // a late JS timer lets the audio thread wrap back to mp.start first, then
                    // the source plays a full pass from the top instead of just the tail (same
                    // bug as the seq A→B transition). A sample-accurate stop()/one-shot can't be
                    // outrun by the audio thread (mirrors _fireLoopOverlap).
                    const srcBuf     = activeSource.buffer
                    const tailOffset = (srcBuf === ta_?.decodedBuffer) ? loopEndSec : (srcBuf.duration - tailLen)
                    stopSource(transitionTime)
                    const tailSrc = ctx.createBufferSource()
                    tailSrc.buffer = srcBuf
                    tailSrc.connect(playbackGain)
                    tailSrc.start(transitionTime, tailOffset, tailLen)
                    activeTailSrc = tailSrc
                    tailSrc.addEventListener('ended', () => { if (activeTailSrc === tailSrc) activeTailSrc = null })
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
                inTail = tailLen > 0
                inTailDuration = tailLen
                setTimeout(() => {
                    if (!gaplessActive) return   // Back-resume cleared it → stale handoff, skip
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
                    // If a Back-resume restarted this loop during the tail, it cleared
                    // gaplessActive — skip this now-stale cleanup, or it would pause the
                    // resumed cursor and hide its playbar (finish then never fires).
                    if (!gaplessActive) return
                    suppressPauseStop = true
                    mainAudioEl.loop = false
                    mainAudioEl.pause()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                    mainAudioEl.currentTime = mp.start
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    gaplessActive = false
                    inTail = false
                    inTailDuration = 0
                    visuallyDone = true
                }, msToTransition + 10 + tailMs)

                _nonAudioActions(nextIdx, nextTa, isAuto)

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

                // ① Without tail: stop current source at transition; with tail let it play out.
                // The current cue's (non-looping) source plays its decay tail to the natural end.
                const tailMs2 = outroAt2 > 0 ? (effEnd - outroAt2) * 1000 : 0
                if (outroAt2 <= 0) stopSource(transitionTime)
                gaplessActive = true

                // ② Start next audio source at the musical boundary (transition point)
                const nextPg = nextTa.getPlaybackGain?.()
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(vol)
                if (nextPg) nextPg.gain.value = fadein > 0 ? 0 : vol
                nextTa.startGaplessSource(ns, transitionTime)

                // ③ At the musical boundary: hand the cursor to the next cue IMMEDIATELY so its
                //    loop/seq machinery starts running right away (it's driven by the cursor's
                //    timeupdate). The current cue's decay tail keeps playing and is shown as a
                //    ghost cursor sliding to the end. Delaying the handoff until the tail ends
                //    would let the next loop run "blind" (no boundary detection) and then hard-cut
                //    when it catches up. Mirrors the isGroupOutro (Loop→Outro) path.
                setTimeout(() => {
                    if (outroAt2 > 0) {
                        suppressPauseStop = true
                        mainAudioEl.loop = false
                        mainAudioEl.pause()
                        setTimeout(() => { suppressPauseStop = false }, 0)
                        inTail = true
                        inTailDuration = tailMs2 / 1000
                        // Ghost cursor slides from the fading point to the end over the tail.
                        const _dur = ws.getDuration()
                        if (_dur > 0) {
                            if (activeTailCurEl) { activeTailCurEl.remove(); activeTailCurEl = null }
                            const tailCurEl = document.createElement('div')
                            tailCurEl.classList.add('ws-tail-cursor')
                            tailCurEl.style.left = getX(effTransition2) + 'px'
                            overlay.appendChild(tailCurEl)
                            activeTailCurEl = tailCurEl
                            requestAnimationFrame(() => { requestAnimationFrame(() => {
                                tailCurEl.style.transitionDuration = (tailMs2 / 1000) + 's'
                                tailCurEl.style.left = getX(effEnd) + 'px'
                            }) })
                            setTimeout(() => { if (activeTailCurEl === tailCurEl) { activeTailCurEl = null } tailCurEl.remove() }, tailMs2 + 150)
                        }
                        broadcastLiveState()
                    }
                    nextTa.startCursor(ns, 0)
                }, Math.max(0, msToTransition))

                // ④ After the tail finishes: clean up the current cue's transport state.
                setTimeout(() => {
                    // Skip if a Back-resume already restarted this trigger during the tail
                    // (it cleared gaplessActive) — otherwise this stale cleanup pauses the
                    // resumed cursor.
                    if (!gaplessActive) return
                    gaplessActive = false
                    inTail = false
                    inTailDuration = 0
                    suppressPauseStop = true
                    mainAudioEl.loop = false
                    mainAudioEl.pause()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                    mainAudioEl.currentTime = mp.start
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                }, msToTransition + 5 + tailMs2)

                _nonAudioActions(nextIdx, nextTa, isAuto)

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
                _nonAudioActions(nextIdx, nextTa, isAuto)
            }
        }

        function fireChainEnd(nextIdx) {
            if (!ws.isPlaying() || chainEndArmed) return
            chainEndArmed = true
            currentCue = nextIdx
            markTriggers(nextIdx)
            scrollToTrigger(nextIdx)
            fireGaplessTransition(nextIdx, true)
        }
        function fireLoopOutro() {
            if (!ws.isPlaying() || !loopOutroPending.has(index)) return
            const outroIdx = loopOutroPending.get(index)
            loopOutroPending.delete(index)
            loopOutroInitialRemaining.delete(index)
            setOutroPendingIndicator(outroIdx, false)
            // Multi-file Vamp: the devamp fired from the primary slot — clear its
            // amber active-slot outline (the non-primary path does this via setActive).
            triggerSeqSlots.get(index)?.slots[0]?.setActive?.(false)
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
                // Reject a stale call: if the current source hasn't reached its first real
                // boundary yet, this fireSeqNext was triggered by a stale signal — e.g. the
                // primary cursor's timeupdate still reporting its pre-resume position right after
                // a Back, which would otherwise snap the transition to "now" and stomp the fresh
                // resume. firstBound scales with the resume offset, so a genuine boundary is never
                // blocked, no matter how close to the boundary the operator pressed Back. An
                // ongoing loop has firstBound well in the past, so normal transitions pass.
                if (ctx.currentTime < firstBound - 0.1) { seqData.transitionInProgress = false; return }
                const n = Math.max(0, Math.ceil((ctx.currentTime - firstBound) * sr / loopDurSamp))
                let transitionTime = firstBound + n * loopDurSamp / sr
                if (transitionTime - ctx.currentTime > (loopEnd - loopStart) * 0.5) {
                    transitionTime = ctx.currentTime
                }
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                if (outroAt > 0) {
                    // Stop the looping primary source exactly at the musical boundary and play
                    // its decay tail as a scheduled one-shot. Using `activeSource.loop = false`
                    // here is racy: the boundary is detected by a JS timer (~5ms early), and if
                    // it fires late the audio thread has already wrapped the loop back to
                    // mp.start. Disabling loop then only stops *future* wraps — the source keeps
                    // playing a full pass from the top, so A and B both restart from their
                    // beginning. A sample-accurate stop()/one-shot can't be outrun by the audio
                    // thread (mirrors _fireLoopOverlap).
                    const srcBuf     = activeSource.buffer
                    const tailOffset = (srcBuf === ta_?.decodedBuffer) ? loopEnd : (srcBuf.duration - tailLen)
                    stopSource(transitionTime)
                    const tailSrc = ctx.createBufferSource()
                    tailSrc.buffer = srcBuf
                    tailSrc.connect(playbackGain)
                    tailSrc.start(transitionTime, tailOffset, tailLen)
                    activeTailSrc = tailSrc
                    tailSrc.addEventListener('ended', () => { if (activeTailSrc === tailSrc) activeTailSrc = null })
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
                    setSeqPhaseAnchor(nextSlotIdx)
                    seqData.slots[0]?.setActive?.(false)
                    nextSlot.setActive?.(true)
                    nextSlot.startCursor(nextNs, 0)
                    // Continue the TC into the next part-loop (see [[BACKLOG]] SLF ticket).
                    if (mtc && mtc.activeTcIndex === index)
                        mtc.setSeqSegment(seqOffsetFrames(index, nextSlotIdx), nextNs, nextSlot.ws)
                    armSeqBoundaryTimer(nextSlotIdx)
                }, Math.max(0, msToTransition))
                // After tail: reset primary cursor and clear gapless flag.
                // Guard: skip media reset if seqData.idx moved on (wrap-back already happened)
                // OR if a new transition is already in progress (wrap-back fired between
                // startGaplessSource and its own timeout — seqData.idx not yet updated).
                setTimeout(() => {
                    if (!gaplessActive) return   // Back-resume already restarted this loop → stale
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
                    inTail = outroLen > 0
                    inTailDuration = outroLen

                    setTimeout(() => {
                        if (!gaplessActive) return   // Back-resume cleared it → stale handoff, skip
                        if (outroLen > 0) curSlot.startTailCursor(effTrans, outroLen)
                        curSlot.pauseCursor()
                        curSlot.setActive?.(false)
                        seqData.idx = 0
                        seqData.transitionInProgress = false
                        nextTa.startCursor(ns, 0)
                    }, Math.max(0, msToTransition))
                    setTimeout(() => {
                        if (!gaplessActive) return   // Back-resume already restarted this loop → stale
                        gaplessActive = false
                        inTail = false
                        inTailDuration = 0
                        visuallyDone = true
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
                    setSeqPhaseAnchor(nextSlotIdx)

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
                        // Cycle wrapped to the first part-loop → TC resets to the cue start.
                        if (mtc && mtc.activeTcIndex === index)
                            mtc.setSeqSegment(0, nextNs, _ta_wb?.ws)
                    } else {
                        nextSlot.setActive?.(true)
                        nextSlot.startCursor(nextNs, 0)
                        // Continue the TC into the next part-loop.
                        if (mtc && mtc.activeTcIndex === index)
                            mtc.setSeqSegment(seqOffsetFrames(index, nextSlotIdx), nextNs, nextSlot.ws)
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

        // Loop length (start → fading_point/end) of each slot in this multi-file SLF
        // sequence, or null if this isn't a multi-file loop.
        function seqSlotLengths() {
            const seqData = triggerSeqSlots.get(index)
            if (!seqData || seqData.total <= 1) return null
            const lens = []
            for (let k = 0; k < seqData.total; k++) {
                let sm, dur
                if (k === 0) { sm = mp; dur = (triggerAudio.get(index)?.decodedBuffer?.duration) ?? ws.getDuration() ?? 0 }
                else { const s = seqData.slots[k]; sm = s?.mp ?? {}; dur = s?.decodedBuffer?.duration ?? s?.ws?.getDuration?.() ?? 0 }
                const start = sm.start ?? 0
                const fp = sm.fading_point ?? 0
                const loopEnd = fp > 0 ? fp : (sm.end ?? dur)
                lens.push(Math.max(0, loopEnd - start))
            }
            return lens
        }

        // Anchor the sequence phase at the start of slot `slotIdx` (used at every boundary
        // so Back can later reconstruct where the loop would be now).
        function setSeqPhaseAnchor(slotIdx) {
            const lens = seqSlotLengths()
            if (!lens) return
            let phase = 0
            for (let k = 0; k < slotIdx && k < lens.length; k++) phase += lens[k]
            seqPhaseAnchor.set(index, { phase, at: performance.now(), ctxAt: sharedAudioCtx?.currentTime ?? null })
        }

        // Back: resume a stopped multi-file SLF loop at the beat-compensated position it
        // would be at had it never stopped. Returns false (→ caller falls back) if this
        // isn't a multi-file loop or the data needed isn't available.
        function resumeSeqBeatComp(primaryVol, opts = {}) {
            const seqData = triggerSeqSlots.get(index)
            const lens    = seqSlotLengths()
            const anchor  = seqPhaseAnchor.get(index)
            if (!seqData || !lens || !anchor) return false
            const total = lens.reduce((a, b) => a + b, 0)
            if (total <= 0) return false
            gaplessActive = false   // clear any stale transition flag before re-arming the loop
            // Clear any tail/done state on the main closure so the live-view fill un-fades
            // immediately — even when we resume into a non-primary slot (which wouldn't
            // otherwise touch these flags, leaving the bar faded until slot 0 comes round).
            inTail = false; inTailDuration = 0; visuallyDone = false

            // Schedule the resume at a precise AudioContext time and compute the phase for
            // *that* instant on the same clock, so the vamp comes back exactly in beat.
            // `opts.when` lets backAction align the resume with the outgoing finish's stop.
            const lead   = 0.02
            const ctxNow = sharedAudioCtx?.currentTime ?? null
            const when   = opts.when ?? (ctxNow != null ? ctxNow + lead : null)
            const fadeIn = opts.fadeIn   // short crossfade-in when set, else the 0.5 s default
            const elapsed = (anchor.ctxAt != null && when != null)
                ? (when - anchor.ctxAt)
                : ((performance.now() - anchor.at) / 1000 + lead)
            let P = (anchor.phase + elapsed) % total
            if (P < 0) P += total
            let k = 0, acc = 0
            while (k < lens.length - 1 && acc + lens[k] <= P) { acc += lens[k]; k++ }
            const within = Math.max(0, P - acc)

            clearTimeout(seqData.boundaryTimer); seqData.boundaryTimer = null
            // Cancel ALL pending playback timers from the old run — the resume re-establishes
            // playback from scratch and re-arms its own. A leftover loopJumpTimer/chainEndTimer
            // would otherwise fire a stale fireSeqNext in the ~20ms gap before startCursor's
            // delayed ws.play() runs (which is what clears them), stomping the fresh resume:
            // idx jumps to the next slot, the primary source is stopped → loop "restarts from top".
            clearTimeout(loopJumpTimer);  loopJumpTimer  = null
            clearTimeout(chainEndTimer);  chainEndTimer  = null
            preSeekArmed  = false
            chainEndArmed = false
            seqData.transitionInProgress = false
            for (let j = 0; j < seqData.total; j++) seqData.slots[j]?.setActive?.(false)

            if (k === 0) {
                const o = (mp.start ?? 0) + within
                seqData.idx = 0
                seqData.slots[0]?.setActive?.(true)
                const ta = triggerAudio.get(index)
                ta?.enableLoop?.()
                ta?.setCurrentVolume?.(0)
                // Sample-accurate primary-slot resume — same scheduled-source path the SLF
                // transitions already use; avoids ws.play latency / seek quantization.
                const scheduled = when != null && ta?.startGaplessSource?.(o, when)
                if (scheduled) {
                    ta.startCursor?.(o, Math.round(Math.max(0, when - (sharedAudioCtx?.currentTime ?? when)) * 1000))
                } else {
                    ws.setVolume(0)
                    ws.play(o)
                }
                if (fadeIn != null && scheduled && playbackGain && when != null) {
                    // Short crossfade-in (< timeupdate interval, so the per-timeupdate gain
                    // write won't clobber it); currentVolume set to target so it holds after.
                    currentVolume = primaryVol
                    try {
                        playbackGain.gain.cancelScheduledValues(sharedAudioCtx.currentTime)
                        playbackGain.gain.setValueAtTime(0, when)
                        playbackGain.gain.linearRampToValueAtTime(primaryVol, when + fadeIn)
                    } catch (_) {}
                } else {
                    fadeAdjustVolume(ta, primaryVol, 0.5)
                }
            } else {
                const slot = seqData.slots[k]
                if (!slot?.decodedBuffer || !sharedAudioCtx) return false
                const o = (slot.mp.start ?? 0) + within
                suppressPauseStop = true
                try { mainAudioEl.loop = false; mainAudioEl.pause() } catch {}
                setTimeout(() => { suppressPauseStop = false }, 0)
                stopSource()
                seqData.idx = k
                slot.setActive?.(true)
                slot.setGain?.(0)
                slot.startGaplessSource(o, when ?? (sharedAudioCtx.currentTime + lead))
                slot.startCursor(o, Math.round(lead * 1000))
                // slot.fadeIn ramps the slot's own gain node (AudioContext-scheduled), so a
                // short fade here is clean; use the handover crossfade time when given.
                slot.fadeIn?.(slot.mp.volume ?? 0.8, fadeIn ?? 0.5)
                armSeqBoundaryTimer(k)
            }
            // Anchor at the scheduled resume instant so a subsequent Back stays consistent.
            seqPhaseAnchor.set(index, { phase: P, at: performance.now(), ctxAt: when })
            return true
        }

        ws.on("timeupdate", (ct) => {
            if (ws.isPlaying()) {
                // Capture the position against the AudioContext clock (sample-accurate, free of
                // timeupdate jitter) so Back can resume beat-accurately. `position` is the
                // linear elapsed since the source started (resume wraps it into the loop);
                // fall back to the cursor time / wall clock when no buffer source is running.
                const ctxNow = sharedAudioCtx?.currentTime ?? null
                const pos = (activeSource && activeSourceStartedAt !== null && ctxNow !== null)
                    ? activeSourceStartOffset + (ctxNow - activeSourceStartedAt)
                    : ct
                lastPlaybackPos.set(index, { position: pos, at: performance.now(), ctxAt: ctxNow })
            }
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
                // Don't slam a fading loop to full volume right at the seam — that produced a
                // loud blip. The next timeupdate's audio-locked fade keeps the gain near 0
                // through the loop boundary.
                if (!(loopSourceSliced && (mp.fadein > 0 || mp.fadeout > 0))) ws.setVolume(currentVolume)
                return
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
            // For a sliced loop region the audio thread loops sample-accurately while the
            // media-element cursor (ct) drifts against it — driving the fade off ct leaks the
            // loop seam at non-zero gain (audible "too loud" click). Derive the fade position
            // from the source's own AudioContext clock so the seam always lands at gain≈0.
            let fadeCt = ct
            if (loopSourceSliced && activeSource && activeSourceStartedAt !== null
                && activeSourceStartOffset !== null && sharedAudioCtx) {
                const loopDur = (mp.end ?? ws.getDuration()) - (mp.start ?? 0)
                if (loopDur > 0) {
                    const elapsed = sharedAudioCtx.currentTime - activeSourceStartedAt
                    const posInRegion = (((activeSourceStartOffset + elapsed) % loopDur) + loopDur) % loopDur
                    fadeCt = (mp.start ?? 0) + posInRegion
                }
            }
            const t = fadeCt - mp.start
            if (mp.fadein  > 0 && t >= 0 && t < mp.fadein)            f = t / mp.fadein
            if (mp.fadeout > 0 && (effEnd - fadeCt) < mp.fadeout) f = Math.min(f, (effEnd - fadeCt) / mp.fadeout)
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
            lastStartedAudioCue = index   // Space (live view closed) toggles this cue
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
            // Anchor the SLF sequence phase at the primary's start. Use the actual cursor
            // offset so a Back-resume mid-slot-0 (ws.play(offset)) anchors at its real phase,
            // not at 0.
            { const _sd = triggerSeqSlots.get(index); if (_sd && _sd.total > 1 && _sd.idx === 0) seqPhaseAnchor.set(index, { phase: Math.max(0, mainAudioEl.currentTime - (mp.start ?? 0)), at: performance.now(), ctxAt: sharedAudioCtx?.currentTime ?? null }) }
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
                    fireGaplessTransition(nextIdx, true)
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

        const cueAudios = extractCueAudios(codeblockYaml.music)

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
            ws, mainAudioEl, audios: cueAudios, musicFile, overlay, getX, autoMarkerState, mp,
            stopAndReset: () => wsStopAndReset(),
            togglePlayPause: () => pauseBtn.click(),
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
            // Back: beat-compensated resume of a stopped multi-file SLF loop (returns false
            // if not a multi-file loop, so the caller falls back to the single-file path).
            resumeSeqBeatComp: (vol, opts) => resumeSeqBeatComp(vol, opts),
            // Called by another trigger's fireGaplessTransition to start this trigger's source
            getPlaybackGain:    () => playbackGain,
            stopActiveSource:   () => stopSource(),
            // Back resume of a managed loop: start the source the same way normal play does
            // (sample-accurate src.start(when, offset)), so the full managed-loop state is set
            // up — visuallyDone reset, no cursor self-loop, loopGroup timing — and the
            // timeupdate boundary handler drives the fading_point tail and fires the armed
            // finish. Returns true if a source was created.
            startSourceAt: (offset, when) => { startSource(offset, when); return !!activeSource },
            getActiveSourceInfo: () => ({ src: activeSource, startedAt: activeSourceStartedAt, startOffset: activeSourceStartOffset }),
            // True as long as the AudioBufferSourceNode is running, even if WaveSurfer's
            // media element isn't playing yet (e.g. during the adoption cursor-sync gap).
            isAudioActive: () => !visuallyDone && (activeSource !== null || ws.isPlaying() || (triggerSeqSlots.get(index)?.idx ?? 0) > 0 || inTail),
            getInTail: () => inTail,
            getInTailDuration: () => inTailDuration,
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
                visuallyDone = false   // a source is starting → live-view bar visible again
                inTail = false; inTailDuration = 0   // not in an outro tail anymore (fill un-fades)
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
                // A seq slot is a `file` (single audio) or its own `audios` list (multichannel patch).
                const slotAudios = extractCueAudios(seqEntry)
                if (!slotAudios.length) continue
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
                    musicFile: slotAudios[0].file,   // primary file drives the waveform/cursor
                    audios: slotAudios,
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
        // The source audio is positioned (paused mid-track) → record an audio-position auto-cue.
        // Otherwise a delay-based auto-cue is offered. Any cue with a trigger_note is selectable.
        const isAudioPositioned = (idx) => {
            const ta = triggerAudio.get(idx)
            if (!ta || !ta.mainAudioEl.paused) return false
            const el = ta.mainAudioEl
            const srcYaml = triggerYamls[idx]
            const srcStart = (typeof srcYaml?.music === 'object' ? srcYaml.music.start : null) ?? 0
            const srcEnd   = (typeof srcYaml?.music === 'object' ? srcYaml.music.end   : null) ?? ta.ws.getDuration()
            if (Math.abs(el.currentTime - srcStart) < 0.3) return false
            if (el.currentTime >= srcEnd - 0.3) return false
            return true
        }
        const isEligible = (idx) => idx !== index && !!triggerYamls[idx]?.trigger_note
        // Pick source trigger, then either record its audio position or ask for a delay.
        enterPickMode(async sourceIdx => {
            const srcYaml = triggerYamls[sourceIdx]
            if (!srcYaml?.trigger_note) return
            if (isAudioPositioned(sourceIdx)) {
                const el = triggerAudio.get(sourceIdx).mainAudioEl
                updateAutoTriggerInScript(index, { trigger_note: srcYaml.trigger_note, at: el.currentTime })
            } else {
                const existing = triggerYamls[index]?.auto_trigger
                const delay = await showDelayDialog(existing?.delay ?? 5)
                if (delay == null) return
                updateAutoTriggerInScript(index, { trigger_note: srcYaml.trigger_note, delay })
            }
        }, isEligible, isAudioPositioned)   // highlight only audio-positioned sources; all others still pickable (→ delay)
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
    autoMicBtn.addEventListener('mousedown', e => e.stopPropagation())
    autoMicBtn.addEventListener('click', e => {
        e.stopPropagation()
        const isActive = triggerYamls[index]?.auto_mic
        if (isActive && !e.shiftKey) return   // deactivate only via Shift+Click
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

// Length (seconds, up to the fading point / Ausklingpunkt) of each part-loop in a
// multi-file Vamp (music_seq). Index 0 = the primary `music:` file. Returns null
// if any part's duration isn't known yet.
function seqPartLengthsSec(index) {
    const seqData = triggerSeqSlots.get(index)
    const total = seqData?.total ?? 1
    const partLen = (mp, dur) => {
        if (!mp || !(dur > 0)) return null
        const start = mp.start ?? 0
        const effTrans = (mp.fading_point ?? 0) > 0 ? mp.fading_point : (mp.end ?? dur)
        return Math.max(0, effTrans - start)
    }
    const ta = triggerAudio.get(index)
    const l0 = partLen(ta?.mp, ta?.decodedBuffer?.duration ?? ta?.ws?.getDuration() ?? 0)
    if (l0 === null) return null
    const lens = [l0]
    for (let k = 1; k < total; k++) {
        const slot = seqData.slots[k]
        const l = partLen(slot?.mp, slot?.decodedBuffer?.duration ?? slot?.ws?.getDuration() ?? 0)
        if (l === null) return null
        lens.push(l)
    }
    return lens
}

// Cumulative TC frame offset at the start of seq slot `slotIdx` (= summed length
// of all earlier part-loops in the cycle). 0 for slot 0 → the TC resets there.
function seqOffsetFrames(index, slotIdx) {
    const lens = seqPartLengthsSec(index)
    if (!lens) return 0
    let sec = 0
    for (let k = 0; k < slotIdx && k < lens.length; k++) sec += lens[k]
    return Math.round(sec * 25)
}

// Total TC frames of one full multi-file Vamp cycle (sum of all part-loops).
function seqTotalFrames(index) {
    const lens = seqPartLengthsSec(index)
    return lens ? Math.round(lens.reduce((a, b) => a + b, 0) * 25) : 0
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
        const seqData = triggerSeqSlots.get(current)
        if (seqData && seqData.total > 1) {
            // Multi-file Vamp: the Finish is offset by the summed length of every
            // part-loop (each up to its fading point), not just the primary file.
            const lens = seqPartLengthsSec(current)
            if (!lens) return null
            frames += Math.round(lens.reduce((a, b) => a + b, 0) * 25)
        } else {
            const audioEl = ta?.mainAudioEl
            const mp = ta?.mp
            if (audioEl && isFinite(audioEl.duration) && audioEl.duration > 0) {
                const start = mp?.start ?? 0
                const end   = mp?.end   ?? audioEl.duration
                frames += Math.round((end - start) * 25)
            } else {
                return null  // duration unknown
            }
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
    // Multi-audio (simultaneous) editing is available for normal cues when more than the
    // default 2 virtual channels (L/R) are defined. Seq-loop cues keep their sequential
    // vamp-slot editing (music_seq) unchanged.
    const multiAudio = !isSeqLoop && virtualChannels.length > 2
    // SLF-Loop cues with >2 vChannels: each slot (primary + sequence) holds its own audio list
    const seqMulti   = isSeqLoop && virtualChannels.length > 2
    const seqLabel = document.createElement('label')
    seqLabel.textContent = isSeqLoop ? t('dlg.trigger.music_seq.all') : t('dlg.trigger.music')
    seqLabel.style.marginBottom = '0'
    const addSeqBtn = document.createElement('button')
    addSeqBtn.type = 'button'; addSeqBtn.classList.add('dialog-btn')
    addSeqBtn.textContent = seqMulti ? t('dlg.trigger.slot.add') : isSeqLoop ? t('dlg.trigger.music_seq.add') : t('dlg.trigger.audio.add')
    addSeqBtn.style.cssText = 'padding:0.2rem 0.6rem;font-size:0.82rem'
    if (isSeqLoop || multiAudio) seqHeaderRow.append(seqLabel, addSeqBtn)
    else seqHeaderRow.append(seqLabel)
    seqSection.appendChild(seqHeaderRow)
    const seqList = document.createElement('div')
    seqSection.appendChild(seqList)
    box.appendChild(seqSection)

    // One audio layer within a slot: file + mono toggle + per-channel patch chips.
    // getValues → { file, mono, patch }. Used by slot cards when >2 vChannels exist.
    function buildAudioRow(cfg, { onRemove = null } = {}) {
        cfg = cfg || {}
        const row = document.createElement('div')
        row.className = 'audio-row'

        const fileRow = document.createElement('div')
        fileRow.style.cssText = 'display:flex;gap:0.4rem;align-items:center;margin-bottom:0.3rem'
        const fileComp = createAudioSelect(audioFiles, t('dlg.trigger.music.none'))
        if (cfg.file) fileComp.setValue(cfg.file)
        fileComp.element.style.flex = '1'
        const monoBtn = document.createElement('button')
        monoBtn.type = 'button'; monoBtn.className = 'dialog-btn audio-mono-btn'
        monoBtn.textContent = t('dlg.trigger.audio.mono')
        monoBtn.style.cssText = 'padding:0.15rem 0.6rem;font-size:0.8rem;flex-shrink:0'
        let monoOn = !!cfg.mono
        const syncMono = () => monoBtn.classList.toggle('active', monoOn)
        syncMono()
        fileRow.append(fileComp.element, monoBtn)
        if (onRemove) {
            const rm = document.createElement('button')
            rm.type = 'button'; rm.className = 'cue-msg-card-remove'; rm.textContent = '✕'
            rm.addEventListener('click', () => { row.remove(); onRemove() })
            fileRow.appendChild(rm)
        }

        const patchWrap = document.createElement('div'); patchWrap.className = 'audio-patch'
        let patchState = []
        const seedFromCfg = (numCh) => {
            patchState = []
            for (let i = 0; i < numCh; i++) {
                const entry = Array.isArray(cfg.patch) ? cfg.patch[i] : null
                const names = entry == null ? [] : (Array.isArray(entry) ? entry : [entry])
                patchState.push(new Set(names.filter(n => virtualChannels.some(v => v.name === n))))
            }
        }
        const renderPatch = (numCh) => {
            patchWrap.innerHTML = ''
            for (let ch = 0; ch < numCh; ch++) {
                const r = document.createElement('div'); r.className = 'audio-patch-row'
                const lbl = document.createElement('span'); lbl.className = 'audio-patch-ch'
                lbl.textContent = `${t('dlg.trigger.audio.channel')} ${ch + 1}`
                r.appendChild(lbl)
                for (const v of virtualChannels) {
                    const chip = document.createElement('button')
                    chip.type = 'button'; chip.className = 'audio-patch-chip'; chip.textContent = v.name
                    if (patchState[ch]?.has(v.name)) chip.classList.add('active')
                    chip.addEventListener('click', () => {
                        if (patchState[ch].has(v.name)) patchState[ch].delete(v.name)
                        else patchState[ch].add(v.name)
                        chip.classList.toggle('active')
                    })
                    r.appendChild(chip)
                }
                patchWrap.appendChild(r)
            }
        }
        const refreshPatch = async () => {
            const file = fileComp.getValue()
            if (!file) { patchState = []; patchWrap.innerHTML = ''; return }
            const numCh = monoOn ? 1 : await detectChannelCount(file)
            seedFromCfg(numCh); renderPatch(numCh)
        }
        monoBtn.addEventListener('click', () => { monoOn = !monoOn; syncMono(); refreshPatch() })
        fileComp.onChange(refreshPatch)
        refreshPatch()

        row.append(fileRow, patchWrap)
        row._fileComp = fileComp
        row.getValues = () => ({ file: fileComp.getValue() || null, mono: monoOn, patch: patchState.map(s => Array.from(s)) })
        return row
    }

    // fading_point control (number input + BPM/beats helper). Returns { row, getValue }.
    function buildFadingPointRow(initial, getFileForCalc) {
        const olRow = document.createElement('div')
        olRow.style.cssText = 'display:flex;gap:0.4rem;align-items:center;margin-top:0.3rem'
        const olLabel2 = document.createElement('span')
        olLabel2.textContent = t('dlg.trigger.fading_point')
        olLabel2.style.cssText = 'font-size:0.82rem;white-space:nowrap;color:#7a8394'
        const olInput2 = document.createElement('input')
        olInput2.type = 'number'; olInput2.min = '0'; olInput2.step = '0.001'
        olInput2.className = 'no-spin'; olInput2.style.cssText = 'width:6rem'
        olInput2.value = initial > 0 ? initial : ''
        const bpm2 = document.createElement('input'); bpm2.type = 'number'; bpm2.min = '1'; bpm2.step = '1'; bpm2.className = 'no-spin'
        bpm2.placeholder = t('dlg.trigger.fading_point.bpm'); bpm2.style.cssText = 'width:5rem'
        const beats2 = document.createElement('input'); beats2.type = 'number'; beats2.min = '1'; beats2.step = '1'; beats2.className = 'no-spin'
        beats2.placeholder = t('dlg.trigger.fading_point.beats'); beats2.style.cssText = 'width:5rem'
        const calc2 = async () => {
            const b = parseFloat(bpm2.value), n = parseFloat(beats2.value)
            if (!(b > 0 && n > 0)) return
            const tailDur = (n / b) * 60
            const filename = getFileForCalc()
            if (!filename) return
            const fileDur = await new Promise(res => { const a = new Audio(audioBasePath + filename); a.addEventListener('loadedmetadata', () => res(a.duration)); a.addEventListener('error', () => res(null)) })
            if (fileDur != null && fileDur > tailDur) olInput2.value = parseFloat((fileDur - tailDur).toFixed(4))
        }
        bpm2.addEventListener('input', calc2); beats2.addEventListener('input', calc2)
        olRow.append(olLabel2, olInput2, bpm2, beats2)
        return { row: olRow, getValue: () => parseFloat(olInput2.value) || 0 }
    }

    // One loop slot (primary or sequence) holding a list of simultaneous audios, each with its
    // own channel patch. Used for SLF-Loop cues when >2 vChannels exist.
    // getValues → { audios: [{file, mono, patch}], fading_point }.
    function buildSlotCard(cfg, { isPrimary = false, showOutroLen = true, slotNum = 1 } = {}) {
        cfg = cfg || {}
        const card = document.createElement('div')
        card.className = 'seq-entry-card'

        const header = document.createElement('div')
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem'
        const title = document.createElement('span')
        title.style.cssText = 'font-size:0.78rem;font-weight:700;color:#7a8394'
        title.textContent = String(slotNum)
        header.appendChild(title)
        if (!isPrimary) {
            const rm = document.createElement('button')
            rm.type = 'button'; rm.className = 'cue-msg-card-remove'; rm.textContent = '✕'
            rm.addEventListener('click', () => card.remove())
            header.appendChild(rm)
        }
        card.appendChild(header)

        const audioListEl = document.createElement('div')
        card.appendChild(audioListEl)
        const rows = []
        const addAudio = (ac) => {
            const r = buildAudioRow(ac, { onRemove: () => { const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1) } })
            rows.push(r); audioListEl.appendChild(r)
        }
        const initialAudios = Array.isArray(cfg.audios) && cfg.audios.length ? cfg.audios
            : (cfg.file ? [{ file: cfg.file, mono: cfg.mono, patch: cfg.patch }] : [{}])
        for (const a of initialAudios) addAudio(a)

        const addBtn = document.createElement('button')
        addBtn.type = 'button'; addBtn.className = 'dialog-btn'
        addBtn.textContent = t('dlg.trigger.audio.add')
        addBtn.style.cssText = 'padding:0.15rem 0.6rem;font-size:0.8rem;margin-top:0.2rem'
        addBtn.addEventListener('click', () => addAudio({}))
        card.appendChild(addBtn)

        const fp = buildFadingPointRow(cfg.fading_point ?? 0, () => rows[0]?._fileComp?.getValue())
        if (showOutroLen) card.appendChild(fp.row)

        card.getValues = () => ({
            audios: rows.map(r => r.getValues()).filter(a => a.file),
            fading_point: showOutroLen ? fp.getValue() : 0,
        })
        return card
    }

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

        // ── Mono toggle + channel patch (only when more than 2 vChannels) ──
        let getMono = () => false
        let getPatch = () => null
        if (multiAudio) {
            const monoBtn = document.createElement('button')
            monoBtn.type = 'button'; monoBtn.className = 'dialog-btn audio-mono-btn'
            monoBtn.textContent = t('dlg.trigger.audio.mono')
            monoBtn.style.cssText = 'padding:0.15rem 0.6rem;font-size:0.8rem;margin:0.1rem 0 0.4rem'
            let monoOn = !!cfg.mono
            const syncMono = () => monoBtn.classList.toggle('active', monoOn)
            syncMono()
            getMono = () => monoOn

            const patchWrap = document.createElement('div')
            patchWrap.className = 'audio-patch'
            let patchState = []   // per source channel: Set<vChannel name>

            const seedFromCfg = (numCh) => {
                patchState = []
                for (let i = 0; i < numCh; i++) {
                    const entry = Array.isArray(cfg.patch) ? cfg.patch[i] : null
                    const names = entry == null ? [] : (Array.isArray(entry) ? entry : [entry])
                    patchState.push(new Set(names.filter(n => virtualChannels.some(v => v.name === n))))
                }
            }
            const renderPatch = (numCh) => {
                patchWrap.innerHTML = ''
                for (let ch = 0; ch < numCh; ch++) {
                    const row = document.createElement('div')
                    row.className = 'audio-patch-row'
                    const lbl = document.createElement('span')
                    lbl.className = 'audio-patch-ch'
                    lbl.textContent = `${t('dlg.trigger.audio.channel')} ${ch + 1}`
                    row.appendChild(lbl)
                    for (const v of virtualChannels) {
                        const chip = document.createElement('button')
                        chip.type = 'button'; chip.className = 'audio-patch-chip'
                        chip.textContent = v.name
                        if (patchState[ch]?.has(v.name)) chip.classList.add('active')
                        chip.addEventListener('click', () => {
                            if (patchState[ch].has(v.name)) patchState[ch].delete(v.name)
                            else patchState[ch].add(v.name)
                            chip.classList.toggle('active')
                        })
                        row.appendChild(chip)
                    }
                    patchWrap.appendChild(row)
                }
            }
            const refreshPatch = async () => {
                const file = fileComp.getValue()
                if (!file) { patchState = []; patchWrap.innerHTML = ''; return }
                const numCh = monoOn ? 1 : await detectChannelCount(file)
                seedFromCfg(numCh)
                renderPatch(numCh)
            }
            monoBtn.addEventListener('click', () => { monoOn = !monoOn; syncMono(); refreshPatch() })
            fileComp.onChange(refreshPatch)
            refreshPatch()
            getPatch = () => patchState.map(set => Array.from(set))

            card.append(fileRow, monoBtn, patchWrap)
            if (isPrimary && showOutroLen) card.appendChild(olRow)
        } else {
            if (showOutroLen) card.append(fileRow, olRow)
            else card.append(fileRow)
        }

        card._fileComp = fileComp

        card.getValues = () => ({
            file:      fileComp.getValue() || null,
            mono:      getMono(),
            patch:     getPatch(),
            fading_point: showOutroLen ? (parseFloat(olInput2.value) || 0) : 0,
        })
        return card
    }

    // Populate cards — primary audio first (isPrimary). For multi-audio cues, additional
    // simultaneous audios from music.audios[1..]; for seq-loop cues, music_seq slots.
    {
        const musicObj = (existingYaml && typeof existingYaml.music === 'object') ? existingYaml.music : null
        const audioList = musicObj && Array.isArray(musicObj.audios) ? musicObj.audios : null
        if (seqMulti) {
            // Each slot (primary + sequence) is a card holding its own audio list.
            const primarySlotCfg = {
                audios:       audioList,
                file:         typeof existingYaml?.music === 'string' ? existingYaml.music : (musicObj?.file ?? ''),
                fading_point: musicObj && musicObj.fading_point > 0 ? musicObj.fading_point : 0,
            }
            seqList.appendChild(buildSlotCard(primarySlotCfg, { isPrimary: true, showOutroLen, slotNum: 1 }))
            if (Array.isArray(existingYaml?.music_seq))
                existingYaml.music_seq.forEach((entry, i) =>
                    seqList.appendChild(buildSlotCard(entry, { showOutroLen: true, slotNum: i + 2 })))
        } else {
            const primaryCfg = {
                file:         typeof existingYaml?.music === 'string' ? existingYaml.music
                              : (audioList ? (audioList[0]?.file ?? '') : (musicObj?.file ?? '')),
                mono:         audioList ? !!audioList[0]?.mono : false,
                patch:        audioList ? (audioList[0]?.patch ?? null) : null,
                fading_point: musicObj && musicObj.fading_point > 0 ? musicObj.fading_point : 0,
            }
            seqList.appendChild(buildSeqCard(primaryCfg, { isPrimary: true, showOutroLen }))

            if (multiAudio && audioList) {
                for (const a of audioList.slice(1)) seqList.appendChild(buildSeqCard(a))
            } else if (isSeqLoop && Array.isArray(existingYaml?.music_seq)) {
                for (const entry of existingYaml.music_seq) seqList.appendChild(buildSeqCard(entry))
            }
        }
    }
    addSeqBtn.addEventListener('click', () => {
        if (seqMulti) {
            const n = seqList.querySelectorAll('.seq-entry-card').length + 1
            seqList.appendChild(buildSlotCard({}, { showOutroLen: true, slotNum: n }))
        } else {
            seqList.appendChild(buildSeqCard({}))
        }
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

        // ─ HTTP fields ─
        const httpSection = document.createElement('div')
        const httpRow = document.createElement('div')
        httpRow.style.cssText = 'display:flex;gap:0.4rem;margin-bottom:0.4rem'
        const methodSel = document.createElement('select')
        methodSel.classList.add('dialog-select'); methodSel.style.cssText = 'width:auto;flex-shrink:0'
        for (const m of ['GET','POST','PUT','DELETE','PATCH']) {
            const o = new Option(m, m)
            if (m === (cfg.method || 'GET')) o.selected = true
            methodSel.appendChild(o)
        }
        const httpPathIn = document.createElement('input')
        httpPathIn.type = 'text'; httpPathIn.placeholder = '/pfad/zum/ziel'
        httpPathIn.value = cfg.path || ''
        httpPathIn.classList.add('dialog-select'); httpPathIn.style.flex = '1'
        httpRow.append(methodSel, httpPathIn)
        const bodyIn = document.createElement('textarea')
        bodyIn.placeholder = t('dlg.trigger.http.body')
        bodyIn.value = cfg.body || ''
        bodyIn.classList.add('dialog-select'); bodyIn.style.cssText = 'width:100%;min-height:3rem;margin-bottom:0.4rem;font-family:inherit'
        const ctIn = document.createElement('input')
        ctIn.type = 'text'; ctIn.placeholder = 'application/json'
        ctIn.value = cfg.content_type || ''
        ctIn.classList.add('dialog-select'); ctIn.style.width = '100%'
        httpSection.append(httpRow, mkLbl(t('dlg.trigger.http.body')), bodyIn, mkLbl(t('dlg.trigger.http.contentType')), ctIn)
        card.appendChild(httpSection)

        function updateDevSections() {
            const selectedDev = outputDevices.find(d => d.name === devSel.value)
            const type = selectedDev?.type || 'midi'
            midiSection.style.display = type === 'midi' ? '' : 'none'
            oscSection.style.display  = type === 'osc'  ? '' : 'none'
            httpSection.style.display = type === 'http' ? '' : 'none'
        }
        devSel.addEventListener('change', updateDevSections)
        updateDevSections()

        card.getValues = () => {
            const selectedDev = outputDevices.find(d => d.name === devSel.value)
            const type = selectedDev?.type || 'midi'
            if (type === 'http') {
                const out = { device: devSel.value || httpOutputDevices[0]?.name || '', method: methodSel.value, path: httpPathIn.value.trim() }
                if (commentIn.value.trim()) out.comment = commentIn.value.trim()
                if (bodyIn.value !== '') out.body = bodyIn.value
                if (ctIn.value.trim()) out.content_type = ctIn.value.trim()
                out._isHttp = true
                return out
            } else if (type === 'osc') {
                const out = { device: devSel.value || oscOutputDevices[0]?.name || '', path: pathIn.value.trim() }
                if (commentIn.value.trim()) out.comment = commentIn.value.trim()
                if (argTypeSel.value !== 'none' && argIn.value.trim() !== '') { out.arg = argIn.value.trim(); out.arg_type = argTypeSel.value }
                out._isOsc = true
                return out
            } else {
                const tv = typeSel.value
                const out = { type: tv, device: devSel.value || midiOutputDevices[0]?.name || '' }
                if (commentIn.value.trim()) out.comment = commentIn.value.trim()
                if (tv === 'note') { out.ch = parseInt(noteCh.value) || 1; out.note = parseInt(noteNote.value) || 0; out.vel = parseInt(noteVel.value) ?? 100 }
                else if (tv === 'cc') { out.ch = parseInt(ccCh.value) || 1; out.cc = parseInt(ccNum.value) || 0; out.value = parseInt(ccVal.value) ?? 0 }
                else if (tv === 'pc') { out.ch = parseInt(pcCh.value) || 1; out.program = parseInt(pcPgm.value) || 0 }
                else if (tv === 'sysex') { out.bytes = sysexIn.value.trim() }
                out._isMidi = true
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
    // Load existing HTTP messages (tagged as http)
    if ((isEdit || isCopy) && Array.isArray(existingYaml?.cue_http)) {
        for (const m of existingYaml.cue_http) buildMsgCard(m, 'http')
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

        // Convert a slot card's {audios:[{file,mono,patch}], fading_point} into a YAML music
        // entry — a plain `file` for a single default-patched audio, else an `audios` list.
        const slotToEntry = (slotVals, base = {}) => {
            const obj = { ...base }
            const audios = (slotVals.audios || []).filter(a => a.file)
            const needsList = audios.length > 1 ||
                audios.some(a => a.mono || (Array.isArray(a.patch) && a.patch.some(p => p && p.length)))
            if (needsList) {
                obj.audios = audios.map(a => {
                    const o = { file: a.file }
                    if (a.mono) o.mono = true
                    const patch = (a.patch || []).map(p => Array.isArray(p) ? p : [])
                    if (patch.some(p => p.length)) o.patch = patch.map(p => p.length === 1 ? p[0] : p)
                    return o
                })
            } else if (audios[0]) {
                obj.file = audios[0].file
            }
            if (slotVals.fading_point > 0) obj.fading_point = slotVals.fading_point
            return obj
        }

        if (seqMulti) {
            // SLF-Loop: primary slot → music, sequence slots → music_seq (handled below).
            const slotCards = [...seqList.querySelectorAll('.seq-entry-card')].filter(c => typeof c.getValues === 'function')
            // Preserve existing music-level fields not edited in the slot UI (volume/start/end/
            // fade*/loop/adjust); file/audios/fading_point come from the slot card.
            const existingMusic = (isEdit || isCopy) && existingYaml?.music && typeof existingYaml.music === 'object' ? existingYaml.music : {}
            const { file: _f, audios: _a, fading_point: _fp, monitor: _m, ...musicBase } = existingMusic
            const primaryEntry = slotCards.length ? slotToEntry(slotCards[0].getValues(), musicBase) : { ...musicBase }
            newYaml.music = Object.keys(primaryEntry).length ? primaryEntry : undefined
            if (!newYaml.music) delete newYaml.music
        } else {
            // music: read from the primary card (and, in multi-audio mode, all audio cards)
            const primaryCard = seqList.querySelector('.seq-entry-card')
            const pv = primaryCard?.getValues?.() ?? {}
            let mf = pv.file || '', resolvedOlVal = pv.fading_point ?? 0

            // Collect simultaneous audios from all cards (multi-audio mode only).
            const audioCards = multiAudio
                ? [...seqList.querySelectorAll('.seq-entry-card')]
                    .filter(c => typeof c.getValues === 'function')
                    .map(c => c.getValues())
                    .filter(e => e.file)
                : []
            // An audio needs the explicit list form when there are several, or when it carries
            // mono / a non-empty patch. A lone default-patched audio stays a plain `file`.
            const needsAudioList = multiAudio && (audioCards.length > 1 ||
                audioCards.some(a => a.mono || (Array.isArray(a.patch) && a.patch.some(p => p && p.length))))

            if (mf) {
                if ((isEdit || isCopy) && existingYaml?.music && typeof existingYaml.music === 'object') {
                    newYaml.music = { ...existingYaml.music, file: mf }
                    delete newYaml.music.audios
                } else {
                    newYaml.music = mf
                }
                if (needsAudioList) {
                    if (typeof newYaml.music === 'string') newYaml.music = { file: newYaml.music }
                    delete newYaml.music.file
                    newYaml.music.audios = audioCards.map(a => {
                        const obj = { file: a.file }
                        if (a.mono) obj.mono = true
                        const patch = (a.patch || []).map(p => Array.isArray(p) ? p : [])
                        if (patch.some(p => p.length)) obj.patch = patch.map(p => p.length === 1 ? p[0] : p)
                        return obj
                    })
                }
            } else if (isEdit && existingYaml?.music && typeof existingYaml.music === 'object' && existingYaml.music.adjust) {
                const { file, monitor, audios, ...rest } = existingYaml.music
                newYaml.music = rest
            }
            // fading_point
            if (resolvedOlVal > 0) {
                if (typeof newYaml.music === 'string') newYaml.music = { file: newYaml.music }
                if (typeof newYaml.music === 'object') newYaml.music.fading_point = resolvedOlVal
            } else if (typeof newYaml.music === 'object') {
                delete newYaml.music.fading_point
            }
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
        const httpMsgs = allMsgs.filter(m => m._isHttp).map(({ _isHttp, ...m }) => m)
        if (midiMsgs.length) newYaml.cue_midi = midiMsgs
        if (oscMsgs.length)  newYaml.cue_osc  = oscMsgs
        if (httpMsgs.length) newYaml.cue_http = httpMsgs

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
        if (seqMulti) {
            const slotCards = [...seqList.querySelectorAll('.seq-entry-card')].filter(c => typeof c.getValues === 'function')
            const seqEntries = slotCards.slice(1).map(c => slotToEntry(c.getValues())).filter(e => e.file || e.audios)
            if (seqEntries.length > 0) newYaml.music_seq = seqEntries
        } else if (isSeqLoop) {
            const allCards = [...seqList.querySelectorAll('.seq-entry-card')]
                .filter(c => typeof c.getValues === 'function')
            // First card = primary (already saved to music:), rest = music_seq
            const seqEntries = allCards.slice(1)
                .map(c => c.getValues())
                .filter(e => e.file)
                .map(e => {
                    const obj = { file: e.file }
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
    const wasLocked = showLock
    showLock = locked
    document.body.classList.toggle('show-locked', locked)
    document.querySelector('.lock-button')?.classList.toggle('active', locked)
    if (locked && inlineEditor) closeEditor(false)
    // First unlock of an open-locked session → run the deferred startup dialogs/banner.
    if (wasLocked && !locked && deferredStartupActions.length) flushDeferredStartupActions()
}

function flushDeferredStartupActions() {
    const actions = deferredStartupActions
    deferredStartupActions = []
    ;(async () => {
        for (const fn of actions) { try { await fn() } catch (e) { console.error('deferred startup action failed:', e) } }
    })()
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

function fadeOutAndStop(cueIdx, ms = 500) {
    const ta = triggerAudio.get(cueIdx)
    if (!ta || !ta.ws.isPlaying()) return
    // Start the ramp from the *current* (possibly ducked) volume, not the configured
    // mp.volume — otherwise a ducked track jumps up to full level on the first frame
    // before fading out. Mirrors fadeAdjustAudio.
    cancelWsFade(ta.ws)
    const startVol = ta.getCurrentVolume?.() ?? ta.ws.getVolume()
    const start = performance.now()
    // Register the rAF fade in activeFades (as every other fade helper does) so a later
    // cancelWsFade() — e.g. when Back resumes this very cue — can abort it. Otherwise the
    // terminal stop()/setVolume below would fire ~ms later and kill the resumed playback.
    const token = { raf: 0 }
    const tick = () => {
        if (activeFades.get(ta.ws) !== token) return   // cancelled or superseded
        const t = Math.min(1, (performance.now() - start) / ms)
        ta.ws.setVolume(Math.max(0, startVol * (1 - t)))
        if (t < 1) {
            token.raf = requestAnimationFrame(tick)
        } else {
            activeFades.delete(ta.ws)
            ta.ws.stop()
            ta.ws.setVolume(startVol)
        }
    }
    token.raf = requestAnimationFrame(tick)
    activeFades.set(ta.ws, token)
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
    // Consume the auto-trigger flag immediately, so it can't leak into the next
    // triggerAction via one of the early returns below (which would mis-tag a later
    // manual cue as auto and make Back roll back more than one Go).
    const wasAuto = pendingAutoTrigger
    pendingAutoTrigger = false

    // Second press while playing → stop (undo accidental trigger)
    const ta = triggerAudio.get(cue)
    const _seqData = triggerSeqSlots.get(cue)
    const _seqActive = _seqData && _seqData.total > 1 && _seqData.idx > 0
    if (ta && (ta.ws.isPlaying() || _seqActive)) {
        ta.stopAndReset()
        if (mtc && mtc.activeTcIndex === cue) mtc.stopAndClear()
        cancelDelayAutoCuesFromSources([cue])   // stopping the source cancels its pending delay auto-cues
        return
    }

    // Outro-interception: if this trigger is the outro for a currently-playing managed loop,
    // queue it instead of playing immediately. Second click cancels the queue.
    for (let i = 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]?.loop_outro) continue
        if (findTriggerByNote(triggerYamls[i].loop_outro) !== cue) continue
        const loopTa = triggerAudio.get(i)
        const _seqData = triggerSeqSlots.get(i)
        // A Back-resumed loop plays via its AudioBufferSource (activeSource, set synchronously)
        // before its mainAudioEl cursor reports isPlaying — and an SLF loop resumed into its
        // primary slot has idx===0. So also treat a live source as "loop active"; otherwise a
        // quick Go right after Back fires the finish immediately instead of arming it.
        const _loopActive = loopTa?.ws.isPlaying()
            || (_seqData && _seqData.total > 1 && _seqData.idx > 0)
            || !!loopTa?.getActiveSourceInfo?.().src
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
    sendCueHttpMessages(cue)

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
    cueHistoryAuto.push(wasAuto)
    broadcastLiveState()

    // Arm any delay-based auto-cues that point at this cue (fire after their delay)
    armDelayAutoCues(cue)

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

// The operator's real position: the most recently *manually* triggered cue.
// Auto-cues (loop fires) don't move it, so it stays put while a loop runs.
function lastManualCue() {
    for (let i = cueHistory.length - 1; i >= 0; i--) {
        if (!cueHistoryAuto[i]) return cueHistory[i]
    }
    return 0
}

// The next cue the live view focuses and that Go fires: the first non-sibling cue
// after the operator's last manual position that has not fired yet. Auto-cues that
// already fired stay in cueHistory (it accumulates a fresh entry on every loop
// pass), so they are skipped and the focus never bounces back to them when the
// loop wraps — while an un-triggered manual cue in between is never skipped.
function nextFocusCue() {
    const fired = new Set(cueHistory)
    for (let i = lastManualCue() + 1; i < triggerYamls.length; i++) {
        const ty = triggerYamls[i]
        if (!ty || ty.sibling) continue
        if (!fired.has(i)) return i
    }
    return null
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
    if (nextCue === null) nextCue = nextFocusCue()

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
                            // Progress is relative to the previous auto-cue on the same
                            // source (or the loop start). Only show once it's been reached.
                            let base = srcTa.mp?.start ?? 0
                            for (let k = 1; k < triggerYamls.length; k++) {
                                if (k === cueIdx) continue
                                const kAty = triggerYamls[k]?.auto_trigger
                                if (!kAty?.trigger_note) continue
                                const kSrc = findTriggerByNote(kAty.trigger_note)
                                if (kSrc === null || groupRootOf(kSrc) !== srcRoot) continue
                                if (kAty.at < aty.at && kAty.at > base) base = kAty.at
                            }
                            if (ct < aty.at && ct >= base) autoCuePending = { currentTime: ct, at: aty.at, base }
                            break
                        }
                    }
                }
            }
            // Delay-based auto-cue counting down → same live-view bar as audio auto-cues.
            if (!autoCuePending) {
                const dTimer = delayAutoTimers.get(cueIdx)
                if (dTimer) autoCuePending = { currentTime: (performance.now() - dTimer.startedAt) / 1000, at: dTimer.delay, base: 0 }
            }
            // Check if this cue is the chain_end target of a currently playing Start cue (S→L transition).
            // Skip if already current — the transition already fired (tail may still be playing).
            if (!autoCuePending && cueIdx !== liveCurrent) {
                for (let i = 1; i < triggerYamls.length; i++) {
                    const srcTy = triggerYamls[i]
                    if (!srcTy?.chain_end) continue
                    if (findTriggerByNote(srcTy.chain_end) !== cueIdx) continue
                    const srcTa = triggerAudio.get(i)
                    if (srcTa?.ws.isPlaying()) {
                        const ct  = srcTa.mainAudioEl?.currentTime ?? 0
                        const fp  = srcTa.mp?.fading_point ?? 0
                        const end = fp > 0 ? fp : (srcTa.mp?.end ?? srcTa.ws.getDuration() ?? 0)
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
            inTail: ta.getInTail?.() ?? false,
            tailDuration: ta.getInTailDuration?.() ?? 0,
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

    // Whether the focused next cue is operator-triggered (not an auto-cue). Used by
    // the live view to keep Go enabled while only an auto-cue is pending.
    const nextCueIsManual = nextCue !== null && !!triggerYamls[nextCue] && !triggerYamls[nextCue].auto_trigger

    window.electronAPI.sendLiveState({
        blocks: liveBlocks,
        currentCue: liveCurrent,
        nextCue,
        nextCueIsManual,
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

// Fire the cue whose trigger_note matches `tn` ({ch, note}), regardless of the
// current position — used by remote triggering via MIDI/OSC input. No-op if no
// cue carries that note. Mirrors the armed-cue branch of goAction().
function triggerCueByNote(tn) {
    const idx = findTriggerByNote(tn)
    if (idx == null) return
    setArmedCue(null)
    selectedVariant = null
    currentCue = idx
    markTriggers(idx)
    scrollToTrigger(idx)
    triggerAction(idx)
}

// Entry point invoked from the main process for OSC cue triggering (/cue/<ch>/<note>).
window.__cueTrigger = (ch, note) => triggerCueByNote({ ch, note })

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
    // Advance from the last manual position, skipping cues that already fired (incl.
    // auto-cues fired by a running loop) so Go lands on the same un-triggered cue the
    // live view focuses — never skipping an un-triggered manual cue in between.
    const fired = new Set(cueHistory)
    for (let i = lastManualCue() + 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]) continue
        if (triggerYamls[i].sibling) continue  // skip non-root variants — only reachable via selectedVariant
        if (fired.has(i)) continue             // already triggered — keep advancing to the next un-fired cue
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
        const pendingOutros = [...loopOutroPending.values()]
        for (const [loopIdx, outroIdx] of loopOutroPending) {
            loopOutroInitialRemaining.delete(loopIdx)
            setOutroPendingIndicator(outroIdx, false)
        }
        loopOutroPending.clear()
        // Re-arm only when a single outro was pending; several armed Devamps can't be
        // represented by one armedCue, so in that case just cancel them all.
        setArmedCue(pendingOutros.length === 1 ? pendingOutros[0] : null)
        broadcastLiveState()
        return
    }

    // A manually armed cue (jump target / selected variant) is treated like the pending
    // Devamp above: Back just cancels the arming, it does not also step back a cue.
    if (armedCue !== null) {
        setArmedCue(null)
        selectedVariant = null
        broadcastLiveState()
        return
    }

    selectedVariant = null
    if (cueHistory.length < 1) return

    // Undo the operator's last Go entirely: pop the automatic entries it spawned
    // (chain_end parts, auto-cues) together with that last manual cue, restoring the
    // exact state from before the Go. The un-fired manual cue then becomes the live
    // view's focus again (via nextFocusCue), as if Go had never been pressed.
    const popped = []
    while (cueHistory.length > 0) {
        const idx   = cueHistory.pop()
        const isAuto = cueHistoryAuto.pop() ?? false
        popped.push(idx)
        if (!isAuto) break   // stop after the first non-auto entry
    }

    // Undoing a Go cancels any delay-based auto-cues that the undone cues had armed.
    cancelDelayAutoCuesFromSources(popped)

    // Determine the cue Back lands on (last manual cue still in history) and whether its
    // loop will be resumed — so a popped finish/outro it handed off from can be handed back
    // with a short coordinated crossfade instead of a 500 ms overlap (phaser on shared
    // material). `prev` is reused by the resume block below.
    let prev = null
    for (let i = cueHistory.length - 1; i >= 0; i--) {
        if (!cueHistoryAuto[i]) { prev = cueHistory[i]; break }
    }
    const prevTa = prev !== null ? triggerAudio.get(prev) : null
    const prevWillResume = !!(prevTa && !prevTa.ws.isPlaying()
        && (prevTa.mp?.loop || !!triggerYamls[prev]?.loop_outro))
    let handoverFinishIdx = null
    if (prevWillResume) {
        const succNote = triggerYamls[prev]?.loop_outro || triggerYamls[prev]?.chain_end
        const succIdx  = succNote ? findTriggerByNote(succNote) : null
        if (succIdx !== null && popped.includes(succIdx)
            && triggerAudio.get(succIdx)?.getActiveSourceInfo?.().src) {
            handoverFinishIdx = succIdx   // stopped in the resume block, not faded here
        }
    }

    // Stop the popped cues' own audio and clear their loop-outro queues / progress bars.
    // (Audio they adjusted on *other* cues is restored separately below.)
    for (const pIdx of popped) {
        if (pIdx !== handoverFinishIdx) fadeOutAndStop(pIdx)
        // fadeOutAndStop doesn't touch the timecode, so stop MTC here if the reverted
        // cue was the active TC source — otherwise the timecode keeps rolling on a track
        // that Back just stopped.
        if (mtc && mtc.activeTcIndex === pIdx) mtc.stopAndClear()

        // Clear a lingering auto-cue progress bar on the reverted cue. If its
        // source loop is still playing it will be repainted on the next
        // timeupdate; otherwise it stays cleared (fixes a bar running on after Back).
        const acBtn = autoTriggerBtns.get(pIdx)
        if (acBtn) { acBtn.style.background = ''; acBtn.style.color = '' }
    }

    // Restore any audio the popped cues ducked or faded out, so the result matches the
    // state from before the undone Go. `popped` is newest-first, so the first adjust seen
    // per target is the most recent and wins.
    const restoredAudio = new Set()
    for (const pIdx of popped) {
        const pMusic = triggerYamls[pIdx]?.music
        const adj = (typeof pMusic === 'object') ? pMusic.adjust : null
        if (!adj) continue
        const adjIdx = findTriggerByNote(adj.trigger_note)
        if (adjIdx === null || restoredAudio.has(adjIdx)) continue
        restoredAudio.add(adjIdx)
        const adjTa = triggerAudio.get(adjIdx)
        if (!adjTa) continue
        const eff    = effectiveAudioStateOf(adjIdx, cueHistory)
        if (!eff.playing || eff.volume <= 0) continue   // remaining history says: stay stopped
        const isLoop = adjTa.mp?.loop || !!triggerYamls[adjIdx]?.loop_outro
        if (adjTa.ws.isPlaying()) {
            // Not stopped yet — just pull the volume back up. Back always uses a fixed
            // 0.5 s fade, regardless of the cue's configured fade time.
            cancelWsFade(adjTa.ws)
            fadeAdjustVolume(adjTa, eff.volume, 0.5)
        } else if (adj.fadeout) {
            // The cue faded the track out and it has stopped → resume it, beat-compensated
            // for loops (multi-file SLF via resumeSeqBeatComp, single-file via resumeAudioAt),
            // at the exact stop position for other audio.
            const seqResumed = isLoop && adjTa.resumeSeqBeatComp?.(eff.volume)
            if (!seqResumed) {
                resumeAudioAt(adjIdx, eff.volume, isLoop)
                // If this track drove the timecode before the undone Go, restart MTC on it.
                // mtc.start derives frames from wsTime, so it re-aligns to the resumed
                // (beat-compensated) position automatically. SLF re-sync isn't handled here.
                const adjTc = triggerYamls[adjIdx]?.start_tc
                if (adjTc && mtc) mtc.start(adjTc, adjTa.ws, adjIdx, adjTa.mp?.start ?? 0)
            }
        }
    }

    // Collect device keys touched by the popped cues
    const poppedDeviceKeys = new Set()
    for (const pIdx of popped) {
        const ty = triggerYamls[pIdx]
        if (ty?.cue_midi?.length) {
            for (const msg of ty.cue_midi)
                if (msg.device) poppedDeviceKeys.add('midi:' + msg.device)
        }
        if (ty?.cue_osc?.length) {
            for (const msg of ty.cue_osc)
                if (msg.device) poppedDeviceKeys.add('osc:' + msg.device)
        }
        if (ty?.cue_http?.length) {
            for (const msg of ty.cue_http)
                if (msg.device) poppedDeviceKeys.add('http:' + msg.device)
        }
    }

    // Land on the last *manual* cue still in history (computed above as `prev`) — never on a
    // leftover auto-cue entry from a loop that was already running before the popped cue.
    if (prev !== null) {
        x32UnmuteChannels(getMicForCue(prev))
        // Restart prev's audio only if it was a loop (simple mp.loop or managed
        // loop_outro) — i.e. something that was still playing before the undone Go.
        // A loop that the undone cue stopped (e.g. a devamp/outro) is restored here at
        // the volume the remaining history implies.
        const prevIsLoop = prevTa?.mp?.loop || !!triggerYamls[prev]?.loop_outro
        if (prevTa && !prevTa.ws.isPlaying() && prevIsLoop) {
            const effPrev = effectiveAudioStateOf(prev, cueHistory)
            const vol = effPrev.volume > 0 ? effPrev.volume : (prevTa.mp?.volume ?? 0.8)

            // Coordinated handover: if the undone Go handed this loop off to a finish/outro we
            // just popped, fade that finish out over a short window (BACK_HANDOVER_FADE) while
            // the loop snaps back in (12 ms) at its beat-compensated position — a brief
            // crossfade instead of two 500 ms fades overlapping (which combs/phases when loop
            // and finish share material, e.g. same drums + extra melody). The loop's 30 ms
            // scheduling lead means the finish has already pre-faded before the loop enters,
            // so the residual overlap is at low level.
            let opts
            if (handoverFinishIdx !== null) {
                fadeOutAndStop(handoverFinishIdx, BACK_HANDOVER_FADE * 1000)
                opts = { fadeIn: 0.012 }
            }

            // Beat-compensated so the loop stays in beat: multi-file SLF via resumeSeqBeatComp,
            // single-file via resumeAudioAt.
            if (!prevTa.resumeSeqBeatComp?.(vol, opts)) {
                resumeAudioAt(prev, vol, true, opts)
                // Resume the timecode too if this loop was the TC source before the undone Go
                // (e.g. undoing an outro handoff that moved MTC onto the outro). mtc.start
                // re-derives frames from wsTime, so it tracks the beat-compensated position.
                // SLF (resumeSeqBeatComp) MTC re-sync is a known limitation — not handled here.
                const prevTc = triggerYamls[prev]?.start_tc
                if (prevTc && mtc) mtc.start(prevTc, prevTa.ws, prev, prevTa.mp?.start ?? 0)
            }
        }
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
            else if (state.type === 'http') _sendHttpMsgArray(state.messages)
        }
    }

    broadcastLiveState()
}

// MIDIOutput.send() throws (InvalidStateError) on a disconnected/closed port. Guard every
// send so one bad device can't abort a multi-device/-channel loop, and so the deferred
// Note-Off timers below never throw uncaught.
function _safeMidiSend(port, bytes) {
    try { port?.send(bytes) } catch (e) { console.warn('[midi] send failed:', e) }
}

function sendTriggerNote(cue) {
    const tn = triggerYamls[cue].trigger_note
    if (!tn) return
    for (let i = 0; i < midiOutputDevices.length; i++) {
        if (!midiOutputDevices[i].sendTriggerNote) continue
        if (midiOutputDevices[i].enabled === false) continue
        const port = midiOutputPorts[i]
        if (!port) continue
        _safeMidiSend(port, [0x90 | (tn.ch - 1), tn.note, 100])
        setTimeout(() => _safeMidiSend(port, [0x80 | (tn.ch - 1), tn.note, 0]), 100)
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

// Effective playback state of a single track (the cue that owns `targetIdx`'s audio)
// implied by a cue history: its own start volume, every music.adjust in the history
// that targets it (applied in order, fade-out → stopped), and a stop once its
// loop_outro / chain_end successor has fired. Used by Back to restore ducked or
// faded audio to exactly what it was before the undone Go.
function effectiveAudioStateOf(targetIdx, history) {
    const ownMusic = triggerYamls[targetIdx]?.music
    let volume  = (typeof ownMusic === 'object' && ownMusic.volume != null) ? ownMusic.volume : 0.8
    let playing = false
    const succNote = triggerYamls[targetIdx]?.loop_outro || triggerYamls[targetIdx]?.chain_end
    const succIdx  = succNote ? findTriggerByNote(succNote) : null
    for (const idx of history) {
        const music = triggerYamls[idx]?.music
        if (idx === targetIdx && music) {
            playing = true
            volume  = (typeof music === 'object' && music.volume != null) ? music.volume : 0.8
        } else if (idx === succIdx && playing) {
            playing = false   // the loop/chain source handed off to its successor
        }
        const adj = (typeof music === 'object') ? music.adjust : null
        if (adj && findTriggerByNote(adj.trigger_note) === targetIdx) {
            if (adj.fadeout) { playing = false; volume = 0 }
            else if (adj.volume !== undefined) volume = adj.volume
        }
    }
    return { playing, volume }
}

function computeEffectiveDeviceStates(history) {
    const result = new Map()
    for (let i = history.length - 1; i >= 0; i--) {
        const ty = triggerYamls[history[i]]
        if (!ty) continue
        if (ty.cue_midi?.length) {
            const byDev = new Map()
            for (const msg of ty.cue_midi) {
                if (!msg.device) continue
                if (!byDev.has(msg.device)) byDev.set(msg.device, [])
                byDev.get(msg.device).push(msg)
            }
            for (const [dName, msgs] of byDev) {
                const key = 'midi:' + dName
                if (!result.has(key)) result.set(key, { type: 'midi', device: dName, messages: msgs })
            }
        }
        if (ty.cue_osc?.length) {
            const byDev = new Map()
            for (const msg of ty.cue_osc) {
                if (!msg.device) continue
                if (!byDev.has(msg.device)) byDev.set(msg.device, [])
                byDev.get(msg.device).push(msg)
            }
            for (const [dName, msgs] of byDev) {
                const key = 'osc:' + dName
                if (!result.has(key)) result.set(key, { type: 'osc', device: dName, messages: msgs })
            }
        }
        if (ty.cue_http?.length) {
            const byDev = new Map()
            for (const msg of ty.cue_http) {
                if (!msg.device) continue
                if (!byDev.has(msg.device)) byDev.set(msg.device, [])
                byDev.get(msg.device).push(msg)
            }
            for (const [dName, msgs] of byDev) {
                const key = 'http:' + dName
                if (!result.has(key)) result.set(key, { type: 'http', device: dName, messages: msgs })
            }
        }
    }
    return result
}

function _sendMidiMsgArray(messages) {
    if (remoteCuesBlocked) return
    for (const msg of messages) {
        // Require an explicit, locally-configured device — no fall back to the first device.
        const devIdx = midiOutputDevices.findIndex(d => d.name === (msg.device || ''))
        if (devIdx < 0) continue
        const dev = midiOutputDevices[devIdx]
        if (!dev.enabled || dev.unconfigured) continue
        const port = midiOutputPorts[devIdx]
        if (!port) continue
        if (msg.type === 'note') {
            const ch = ((parseInt(msg.ch) || 1) - 1) & 0xF
            const note = Math.max(0, Math.min(127, parseInt(msg.note) || 0))
            const vel  = Math.max(0, Math.min(127, parseInt(msg.vel) ?? 100))
            _safeMidiSend(port, [0x90 | ch, note, vel])
            setTimeout(() => _safeMidiSend(port, [0x80 | ch, note, 0]), 100)
        } else if (msg.type === 'cc') {
            const ch  = ((parseInt(msg.ch)    || 1) - 1) & 0xF
            const cc  = Math.max(0, Math.min(127, parseInt(msg.cc)    || 0))
            const val = Math.max(0, Math.min(127, parseInt(msg.value) ?? 0))
            _safeMidiSend(port, [0xB0 | ch, cc, val])
        } else if (msg.type === 'pc') {
            const ch  = ((parseInt(msg.ch) || 1) - 1) & 0xF
            const pgm = Math.max(0, Math.min(127, parseInt(msg.program) || 0))
            _safeMidiSend(port, [0xC0 | ch, pgm])
        } else if (msg.type === 'sysex') {
            const bytes = String(msg.bytes || '').trim().split(/\s+/)
                .map(h => parseInt(h, 16)).filter(n => !isNaN(n) && n >= 0 && n <= 255)
            if (bytes.length) _safeMidiSend(port, bytes)
        }
    }
}

function _sendOscMsgArray(messages) {
    if (!window.electronAPI?.sendOsc) return
    if (remoteCuesBlocked) return
    for (const msg of messages) {
        const dev = oscOutputDevices.find(d => d.name === (msg.device || ''))
        if (!dev || !dev.enabled || dev.unconfigured || !dev.host) continue
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

function _sendHttpMsgArray(messages) {
    if (!window.electronAPI?.sendHttp) return
    if (remoteCuesBlocked) return
    for (const msg of messages) {
        const dev = httpOutputDevices.find(d => d.name === (msg.device || ''))
        if (!dev || !dev.enabled || dev.unconfigured || !dev.url) continue
        window.electronAPI.sendHttp({
            url:         dev.url,
            method:      msg.method || 'GET',
            path:        msg.path || '',
            body:        msg.body ?? null,
            contentType: msg.content_type || null,
        }).then(res => {
            if (res && res.ok === false) console.warn('[http] request failed:', res.error || res.status)
        }).catch(e => console.warn('[http] send failed:', e))
    }
}

function sendCueHttpMessages(cue) {
    const ty = triggerYamls[cue]
    if (!ty?.cue_http?.length) return
    _sendHttpMsgArray(ty.cue_http)
}

// True if any cue references an output device that is actually configured & enabled on this
// machine — i.e. opening the file could really command local gear. Drives the trust warning.
function fileDrivesConfiguredDevice() {
    const hasDev = (list, name) => list.some(d => d.name === name && d.enabled && !d.unconfigured)
    for (const ty of triggerYamls) {
        for (const m of ty?.cue_midi || []) if (hasDev(midiOutputDevices, m.device || '')) return true
        for (const m of ty?.cue_osc  || []) if (hasDev(oscOutputDevices,  m.device || '')) return true
        for (const m of ty?.cue_http || []) if (hasDev(httpOutputDevices, m.device || '')) return true
    }
    return false
}

let _trustPromptOpen = false
// Warn (once) when the open file's last change happened on another machine and it actually
// drives a configured output device — letting the user allow it or block all outputs for the
// session. Re-checked on settings changes too, so configuring a matching device *after* opening
// an untrusted file still triggers the prompt instead of silently arming its cues.
async function maybeWarnUntrustedScript() {
    if (window.__webPreview) return
    if (remoteCuesBlocked || _trustPromptOpen) return
    if (!fileDrivesConfiguredDevice()) return
    if (await window.electronAPI.getScriptTrusted()) return
    _trustPromptOpen = true
    try {
        const allow = await showConfirmDialog({
            title: t('remote.warn.title'),
            body: t('remote.warn.body'),
            hint: t('remote.warn.hint'),
            confirmLabel: t('remote.warn.allow'),
            cancelLabel: t('remote.warn.block'),
        })
        if (allow) await window.electronAPI.ackScriptTrust()
        else setOutputsBlocked(true)
    } finally {
        _trustPromptOpen = false
    }
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
    if (entry.raf != null) cancelAnimationFrame(entry.raf)   // rAF fade (fadeOutAndStop)
    else clearInterval(entry.id ?? entry)
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
    // A fade-out already in progress takes precedence: ignore a volume change that
    // arrives while the target is fading out to stop, so the fade-out is not revived.
    if (activeFades.get(ta.ws)?.fadingOut) return
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
// Keeps the loop running during the fade: a loop that reaches its end / fading point
// before the fade time is over restarts from the top and keeps fading, instead of
// stopping hard at the boundary. The loop is only torn down once the fade has elapsed.
function fadeAdjustAudio(ta, fadeTime) {
    cancelWsFade(ta.ws)
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
            ta.disableLoop()   // fade is over — prevent any further loop restart, then stop
            if (ta.stopAndReset) ta.stopAndReset()
            else ta.ws.stop()
            if (mtc && mtc.wsRef === ta.ws) mtc.stopAndClear()
            ta.enableLoop()
            ta.setCurrentVolume(startVol)
        }
    }, stepInterval)
    // Store ta + restoreVol so cancelWsFade can restore currentVolume if cancelled mid-fade.
    // `fadingOut` lets a concurrent volume adjust know the target is on its way out and
    // must not be revived (fade-out wins over a volume change that arrives right after).
    activeFades.set(ta.ws, { id, ta, restoreVol: startVol, fadingOut: true })
}

// Resume a track that a now-undone cue had stopped, with a short 0.5 s fade so Back
// stays smooth. A loop (beatCompensate=true) re-enters at the position it would be at
// had it never stopped — elapsed time since the stop, wrapped into the loop region —
// so Back stays in beat. Other audio resumes at the exact position it was stopped.
function resumeAudioAt(cueIdx, targetVol, beatCompensate, opts = {}) {
    const ta = triggerAudio.get(cueIdx)
    if (!ta) return
    const mp = ta.mp
    const loopStart = mp?.start ?? 0
    const info = lastPlaybackPos.get(cueIdx)
    const ctx = sharedAudioCtx

    // Beat-accurate loop resume: schedule the buffer source at a precise AudioContext time
    // and compute the offset for *that* instant on the same clock. This avoids ws.play()'s
    // start latency and frame-quantized media seek (which read a stale mainAudioEl.currentTime),
    // and keeps the position math on the audio clock instead of the wall clock.
    if (beatCompensate && info && ctx && ta.startGaplessSource && ta.startCursor) {
        const lead    = 0.03
        const when    = opts.when ?? (ctx.currentTime + lead)
        const fp      = mp?.fading_point ?? 0
        const loopEnd = fp > 0 ? fp : (mp?.end ?? (ta.ws.getDuration?.() ?? 0))
        const range   = loopEnd - loopStart
        // Same clock as `when`; fall back to wall clock for captures without a ctx timestamp.
        const elapsed = info.ctxAt != null ? (when - info.ctxAt) : ((performance.now() - info.at) / 1000 + (when - ctx.currentTime))
        let pos = info.position
        if (range > 0) pos = loopStart + (((info.position - loopStart + elapsed) % range) + range) % range
        cancelWsFade(ta.ws)
        ta.enableLoop()
        ta.setCurrentVolume(0)
        // Managed loops (loop_outro) must resume via startSource — the same primitive normal
        // play uses — so the fading_point tail and the armed-finish firing (both driven by the
        // timeupdate boundary handler) work. startGaplessSource only sets up a self-looping
        // source and leaves that machinery dead → hard loop, finish never fires, playbar hidden.
        // Simple loops have no such machinery and keep the leaner startGaplessSource path.
        const useManaged = !!triggerYamls[cueIdx]?.loop_outro && !!ta.startSourceAt
        const started = useManaged ? ta.startSourceAt(pos, when) : ta.startGaplessSource(pos, when)
        if (started) {
            // startSource doesn't force the cursor's own loop off for loopGroup loops; ensure
            // it's off so fireLoopRestart (not the media element) manages the cursor.
            if (useManaged && ta.mainAudioEl) ta.mainAudioEl.loop = false
            ta.startCursor(pos, Math.round(Math.max(0, when - ctx.currentTime) * 1000))
            if (opts.fadeIn != null) {
                // Short crossfade-in for the Back handover: ramp the gain directly on the
                // AudioContext over a window shorter than the timeupdate interval (so the
                // per-timeupdate gain write can't clobber it). currentVolume set to target so
                // the engine holds full volume once the ramp completes.
                const pg = ta.getPlaybackGain?.()
                ta.setCurrentVolume(targetVol)
                if (pg) {
                    try {
                        pg.gain.cancelScheduledValues(ctx.currentTime)
                        pg.gain.setValueAtTime(0, when)
                        pg.gain.linearRampToValueAtTime(targetVol, when + opts.fadeIn)
                    } catch (_) {}
                } else {
                    fadeAdjustVolume(ta, targetVol, 0.5)
                }
            } else {
                fadeAdjustVolume(ta, targetVol, 0.5)
            }
            return
        }
        // startGaplessSource declined (no decoded buffer yet) → fall through to ws.play.
    }

    // Fallback / non-loop audio: resume at the wall-clock-extrapolated (loops) or exact
    // (other audio) stop position via the media element.
    let pos = info ? info.position : loopStart
    if (info && beatCompensate) {
        const fp = mp?.fading_point ?? 0
        const loopEnd = fp > 0 ? fp : (mp?.end ?? (ta.ws.getDuration?.() ?? 0))
        const range = loopEnd - loopStart
        if (range > 0) {
            const elapsed = (performance.now() - info.at) / 1000
            pos = loopStart + (((info.position - loopStart + elapsed) % range) + range) % range
        }
    }
    cancelWsFade(ta.ws)
    if (beatCompensate) ta.enableLoop()
    ta.setCurrentVolume(0)
    ta.ws.setVolume(0)
    ta.ws.play(pos)
    fadeAdjustVolume(ta, targetVol, 0.5)
}

function stopall() {
    for (const [idx, ta] of triggerAudio.entries()) {
        const _sd = triggerSeqSlots.get(idx)
        const _seqActive = _sd && _sd.total > 1 && _sd.idx > 0
        if (ta.ws.isPlaying() || _seqActive) fadeAdjustAudio(ta, 0.5)
    }
    for (const target of [...delayAutoTimers.keys()]) cancelDelayAutoCue(target)
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
    // Capture phase so it still runs while locked — the lock handler on
    // #script-content calls stopImmediatePropagation() and would otherwise
    // swallow the outside click that closes the open sidebar.
    document.addEventListener('mousedown', (e) => {
        const sidebar = document.getElementById('scene-sidebar')
        if (!sidebar.classList.contains('open')) return
        if (sidebar.contains(e.target)) return
        if (e.target.closest('.sidebar-toggle-button')) return
        sidebar.classList.remove('open')
        updateHeaderShield()
    }, true)

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
// Build the runtime output-device list by merging the show's device declarations
// (name/type/colour, from the .md) with the machine-local endpoints (address + flags,
// from userData via `deviceEndpoints`). A declared device without a local endpoint is
// `unconfigured` and never sends — addresses live only on this machine, never in the file.
function _migrateOutputDevices(settings) {
    const endpoints = (settings.deviceEndpoints && typeof settings.deviceEndpoints === 'object') ? settings.deviceEndpoints : {}
    const decls = Array.isArray(settings.outputDevices) ? settings.outputDevices : []
    return decls.filter(d => d && d.name).map(d => {
        const base = { name: d.name, type: d.type || 'midi', color: safeColor(d.color) }
        const ep = endpoints[d.name]
        if (!ep || typeof ep !== 'object') {
            return { ...base, enabled: false, unconfigured: true, sendTriggerNote: false, sendTimecode: false }
        }
        return {
            ...base,
            enabled:         ep.enabled ?? true,
            sendTriggerNote: !!ep.sendTriggerNote,
            sendTimecode:    !!ep.sendTimecode,
            device:          ep.device ?? null,
            host:            ep.host,
            port:            ep.port,
            url:             ep.url,
        }
    })
}

// Migrate flat settings to micDevices array (backwards compat)
function _migrateMicDevices(s) {
    if (s.micDevices && s.micDevices.length > 0) return s.micDevices
    if (!s.midiX32Device && !s.micMuteMethod) return []
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
        for (const ch of allChs) _safeMidiSend(out, [0xB1, ch - 1, unmuteChs.includes(ch) ? 0 : 127])
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
                if (bytes.length) _safeMidiSend(out, bytes)
            }
        } else if (dev.micMuteMidiType === 'note') {
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const mCh  = (resolveCh(dev.micMuteMidiNoteCh, ch - 1) - 1) & 0xF
                const note = resolveCh(dev.micMuteMidiNoteNum, ch - 1) & 0x7F
                const vel  = (isUnmuted ? dev.micMuteMidiVelOn : dev.micMuteMidiVelOff) & 0x7F
                _safeMidiSend(out, [0x90 | mCh, note, vel])
                if (vel > 0) setTimeout(() => _safeMidiSend(out, [0x80 | mCh, note, 0]), 100)
            }
        } else if (dev.micMuteMidiType === 'cc') {
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const mCh = (resolveCh(dev.micMuteMidiCcCh, ch - 1) - 1) & 0xF
                const cc  = resolveCh(dev.micMuteMidiCcNum, ch - 1) & 0x7F
                _safeMidiSend(out, [0xB0 | mCh, cc, (isUnmuted ? dev.micMuteMidiCcValOn : dev.micMuteMidiCcValOff) & 0x7F])
            }
        } else if (dev.micMuteMidiType === 'pc') {
            for (const ch of allChs) {
                const isUnmuted = unmuteChs.includes(ch)
                const mCh  = (resolveCh(dev.micMuteMidiPcCh, ch - 1) - 1) & 0xF
                _safeMidiSend(out, [0xC0 | mCh, (isUnmuted ? dev.micMuteMidiPcOn : dev.micMuteMidiPcOff) & 0x7F])
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
    midiTCOutputs = []
    midiGoNote    = settings.midiGoNote    || null
    midiBackNote  = settings.midiBackNote  || null
    midiLiveDevice = settings.midiLiveDevice || null
    cueTriggerMidiDevice = settings.cueTriggerInput === 'midi' ? (settings.cueTriggerMidiDevice || null) : null
    if (!midiAccess) return
    // Determine which device names should receive TC.
    // Per-device sendTimecode flag takes precedence; fall back to legacy midiTCDevice setting.
    const hasSendTimecodeFlag = midiOutputDevices.some(d => d.sendTimecode)
    const tcDeviceNames = hasSendTimecodeFlag
        ? new Set(midiOutputDevices.filter(d => d.sendTimecode).map(d => d.device).filter(Boolean))
        : (settings.midiTCDevice ? new Set([settings.midiTCDevice]) : new Set())
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
        if (tcDeviceNames.has(output.name)) midiTCOutputs.push(output)
    }
    midiTrigger = midiOutputPorts[0] ?? null  // keeps sendTriggerNote working
    if (mtc) mtc.setOutputs(midiTCOutputs)
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
        // A device may serve as the Live (Go/Back) input, the dedicated cue-trigger
        // input, or both. An empty midiLiveDevice means "all devices" for Go/Back.
        const isLive    = !midiLiveDevice || input.name === midiLiveDevice
        const isTrigger = cueTriggerMidiDevice && input.name === cueTriggerMidiDevice
        if (!isLive && !isTrigger) {
            input.onmidimessage = null
            continue
        }
        input.onmidimessage = (msg) => {
            const [status, note, velocity] = msg.data
            const type     = status & 0xf0
            const ch       = (status & 0x0f) + 1
            const isNoteOn  = type === 0x90 && velocity > 0
            const isNoteOff = type === 0x80 || (type === 0x90 && velocity === 0)

            // Cue triggering: an incoming Note-On fires the cue whose trigger_note matches.
            if (isTrigger && isNoteOn) triggerCueByNote({ ch, note })

            if (!isLive) return

            if (midiGoNote && ch === midiGoNote.ch && note === midiGoNote.note && isNoteOn)
                goAction()

            if (midiBackNote && ch === midiBackNote.ch && note === midiBackNote.note) {
                if (isNoteOn) {
                    // Guard against a repeated Note-On without an intervening Note-Off
                    // (key-repeat / doubly-sending controllers): clear the prior timer so it
                    // can't fire stopAllAudio() unexpectedly after being orphaned.
                    clearTimeout(midiBackLongPressTimer)
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
    virtualChannels = buildVirtualChannels(savedSettings.virtualChannels, savedSettings.virtualChannelOutputs)
    appLanguage     = savedSettings.appLanguage     || 'de'
    remoteCuesBlocked = savedSettings.outputsBlocked ?? false
    micGroupDisplay = savedSettings.micGroupDisplay ?? true
    mainTextZoom    = parseFloat(savedSettings.mainTextZoom) || 1
    applyMainZoom()
    document.getElementById('script-content').classList.toggle('show-md-line-numbers', !!(savedSettings.showMdLineNumbers))
    if (savedSettings.openLocked) { lockAutoActivated = false; setShowLock(true) }
    // Opened with Lock → suppress startup dialogs/error banner until the first unlock.
    const deferStartup = !!savedSettings.openLocked && !window.__webPreview
    window.applyI18n?.(appLanguage)
    editorApp       = savedSettings.editorApp || null
    outputDevices     = _migrateOutputDevices(savedSettings)
    midiOutputDevices = outputDevices.filter(d => d.type === 'midi')
    midiOutputPorts   = midiOutputDevices.map(() => null)
    oscOutputDevices  = outputDevices.filter(d => d.type === 'osc')
    httpOutputDevices = outputDevices.filter(d => d.type === 'http')
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
        const formatDialogArgs = {
            title: 'Skript formatieren?',
            body:  `<strong>${escapeHtml(fileName)}</strong> entspricht nicht dem Formatierungsstandard.<br><br>` +
                   `Fehlende Leerzeilen werden ergänzt, lange Zeilen aufgeteilt.<br>` +
                   `Eine Sicherungskopie wird als <strong>${escapeHtml(backupName)}</strong> gespeichert.`,
            confirmLabel: 'Formatieren',
            cancelLabel:  'Überspringen',
            img: 'assets/formatter.png',
        }
        if (deferStartup) {
            // Defer to first unlock: format the (already rendered) script, then reload.
            deferredStartupActions.push(async () => {
                if (!needsFormatting(scriptText)) return
                if (await showConfirmDialog(formatDialogArgs)) {
                    await window.electronAPI.backupScriptMd()
                    await writeScriptMd(formatScriptText(scriptText))
                    location.reload()
                }
            })
        } else if (await showConfirmDialog(formatDialogArgs)) {
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
            // Side effects apply immediately; only the dialog is deferred when opened locked.
            versionMismatchIgnored = true
            versionMismatchFileVersion = String(fileVersion)
            window.electronAPI.setSuppressVersionBump(true)
            if (deferStartup) deferredStartupActions.push(() => showVersionMismatchDialog(String(fileVersion), appVersion))
            else await showVersionMismatchDialog(String(fileVersion), appVersion)
        }

        if (!savedSettings.dismissedUpdatePopup) {
            const showUpdate = async () => {
                const dismissed = await showUpdateInfoDialog(appVersion)
                if (dismissed) window.electronAPI.saveSettings({ ...savedSettings, dismissedUpdatePopup: true })
            }
            if (deferStartup) deferredStartupActions.push(showUpdate)
            else await showUpdate()
        }

        // Security: a show file's cue_midi/cue_osc/cue_http blocks command this machine's
        // configured devices (mixer, lighting, media server) over the trusted LAN — the same
        // capability a sandboxed browser is denied. Warn whenever the file's last change
        // happened on another machine (hash mismatch) and it actually drives a configured
        // device, and let the user block all outputs for the session. Shown immediately even
        // when opened locked, since auto/remote triggers could fire a cue before unlock.
        await maybeWarnUntrustedScript()
    }

    colorText()
    // Check for duplicate device names across MIDI and OSC output devices
    const _devNames = new Set()
    for (const d of [...midiOutputDevices, ...oscOutputDevices]) {
        if (_devNames.has(d.name))
            parseErrors.push({ blockNum: null, line: null, message: `Doppelter Gerätename: „${d.name}" – Gerätenamen müssen eindeutig sein` })
        _devNames.add(d.name)
    }
    // Warn about cue-referenced output devices that have no local address configured.
    // Addresses live only on this machine (deviceEndpoints), so a shared file needs them set up here.
    if (!window.__webPreview) {
        const _referencedDevs = new Set()
        for (const ty of triggerYamls) {
            for (const m of ty?.cue_midi || []) if (m?.device) _referencedDevs.add(m.device)
            for (const m of ty?.cue_osc  || []) if (m?.device) _referencedDevs.add(m.device)
            for (const m of ty?.cue_http || []) if (m?.device) _referencedDevs.add(m.device)
        }
        for (const name of _referencedDevs) {
            const dev = outputDevices.find(d => d.name === name)
            if (dev?.unconfigured)
                parseErrors.push({ blockNum: null, line: null, message: `Gerät „${name}" hat auf diesem Rechner keine Adresse – in den Einstellungen konfigurieren` })
        }
    }
    if (deferStartup) deferredStartupActions.push(() => showParseErrors())
    else showParseErrors()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
    annotateLineNumbers()
    buildInsertZones()
    initButtons()
    setupAutoTriggers()
    buildSidebar()
    updateOutputsBlockedBar()

    checkEmptyScript()
    // Initial load doesn't go through rerender(), so populate the top bar (current
    // heading + height) now, once the headings have been laid out.
    requestAnimationFrame(() => { updateHeaderShield(); requestAnimationFrame(updateHeaderShield) })

    mtc = new MTCTransmitter()
    mtc.setDisplay(document.querySelector('.tc-display'))

    applyAudioDevices()

    await initMidi(savedSettings)
    mtc.setOutputs(midiTCOutputs)

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
            const newVChannels = buildVirtualChannels(newSettings.virtualChannels, newSettings.virtualChannelOutputs)
            const changed = JSON.stringify(newVChannels) !== JSON.stringify(virtualChannels)
            mainAudioDevice = resolveDeviceId(newSettings.mainAudioDevice)
            virtualChannels = newVChannels
            editorApp       = newSettings.editorApp || null
            outputDevices     = _migrateOutputDevices(newSettings)
            midiOutputDevices = outputDevices.filter(d => d.type === 'midi')
            midiOutputPorts   = midiOutputDevices.map(() => null)
            oscOutputDevices  = outputDevices.filter(d => d.type === 'osc')
            httpOutputDevices = outputDevices.filter(d => d.type === 'http')
            remoteCuesBlocked = newSettings.outputsBlocked ?? false
            updateOutputsBlockedBar()
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
            if (changed) {
                decodeGen++   // invalidate any in-flight decode so it won't resurrect a freed buffer
                for (const ta of triggerAudio.values()) { ta.decodedBuffer = null; ta._decoding = false }
            }
            applyAudioDevices()
            // A device may have just become configured for a cue in an untrusted file — re-run
            // the trust gate so its cues can't arm without consent (unless already blocked here).
            if (!remoteCuesBlocked) maybeWarnUntrustedScript()
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
