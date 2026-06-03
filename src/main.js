"use strict"

const showdown = require('showdown')
const yaml = require('js-yaml')
const WaveSurfer = require('wavesurfer.js')
const createDOMPurify = require('dompurify')

let config = {}
let usedChs = []
let triggers = []
let triggerYamls = []
let parseErrors = []   // {blockNum, line, message}
let audioWarnings = [] // {file, cueNum}
const loopOutroPending = new Map()         // loopTriggerIdx → outroTriggerIdx
const loopOutroInitialRemaining = new Map() // loopTriggerIdx → remaining at arm time
const loopBtns = new Map()          // triggerIdx → button element
// loopTriggerIdx → { outroIdx, loopVirtualStartTime }
// loopVirtualStartTime: AudioContext time at which the loop was at position mp.start
const loopGroups = new Map()

// triggerIndex -> { ws, mainAudioEl, monitorFile, musicFile, overlay, getX, autoMarkerState }
const triggerAudio = new Map()
const slfDerivedTcBadges = new Map()  // triggerIndex → span element for derived TC badges
// musicFile -> triggerIndex[]  (for cross-trigger fade lookups)
const fileToTriggers = new Map()
// targetIdx → <button> element for auto-cue progress bar updates
const autoTriggerBtns = new Map()
// sourceIdx → { links, unPlay, unTime, unPause, unFin, markFired, getUnfiredPast }
const autoTriggerSetup = new Map()
// sourceIdx currently being scrubbed (drag on waveform while playing)
const scrubbingSet = new Set()

let mainAudioDevice    = null
let mainChannelL    = 0   // 0-indexed device output channels (Main L, Main R, Mon L, Mon R)
let mainChannelR    = 1
let monitorChannelL = 2
let monitorChannelR = 3
let audioOutputDevices = []
let editorApp = null
let audioBasePath = 'audio/'
let sharedAudioCtx = null

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
    } catch (e) {
        console.warn('[gapless] pre-decode failed:', e)
    } finally {
        ta._decoding = false
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
let cueHistory = []
let liveViewOpen = false
let armedCue = null
let midiGoNote = null
let midiBackNote = null
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
        document.getElementById('search-count').textContent = 'Nicht gefunden'
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
            `${searchIdx + 1} / ${searchMatches.length}`
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
    const br = document.createElement('br')
    range.insertNode(br)
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
    // Role block: **Name** with optional \nDialogue
    const roleM = content.match(/^\*\*([^*]+)\*\*(?:\n([\s\S]*))?$/)
    if (roleM) {
        div.dataset.editorType = 'role'
        const roleName = roleM[1]
        const dialogue = (roleM[2] || '').trimEnd()
        const roleColor = ROLE_COLORS[config.roles?.[roleName]?.color] || ''
        const ns = document.createElement('span')
        ns.className = 'editor-role-name'
        ns.textContent = roleName
        if (roleColor) ns.style.color = roleColor
        div.appendChild(ns)
        if (dialogue) {
            // No <br> — role name and dialogue on one visual line (separator via CSS ::after)
            appendDialogueParsed(div, dialogue, roleColor)
        }
        return
    }
    div.dataset.editorType = 'text'
    div.appendChild(document.createTextNode(content))
}

// Re-color parenthetical text in the dialogue portion after each keystroke
function updateEditorParens(div) {
    if (div.dataset.editorType !== 'role') return
    const nameSpan = div.querySelector('.editor-role-name')
    if (!nameSpan) return
    const roleColor = ROLE_COLORS[config.roles?.[nameSpan.textContent]?.color] || ''

    const caretOffset = getCaretOffset(div)
    const afterName = []
    let seen = false
    for (const n of div.childNodes) { if (seen) afterName.push(n); if (n === nameSpan) seen = true }
    // Serialize back to markdown so *(text)* patterns survive the rebuild.
    // Only re-wrap editor-stage-inline spans that still contain balanced (...) —
    // a partially deleted span must not emit raw asterisks into the text.
    const dialogue = afterName.map(serializeRoleNode).join('')
    afterName.forEach(n => n.remove())
    appendDialogueParsed(div, dialogue, roleColor)
    setCaretOffset(div, caretOffset)
}

// Split dialogue text at sentence boundaries so each sentence starts on its own line
function wrapSentences(text) {
    return text.replace(/([.!?])[ \t]+(?=[A-ZÄÖÜ"])/g, '$1\n')
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
        bodyEl.innerHTML = body

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'

        const close = (val) => { overlay.remove(); resolve(val) }
        const cancelBtn  = document.createElement('button')
        cancelBtn.className  = 'dialog-btn'
        cancelBtn.textContent = cancelLabel
        cancelBtn.addEventListener('click', () => close(false))

        const confirmBtn = document.createElement('button')
        confirmBtn.className  = 'dialog-btn dialog-btn-primary'
        confirmBtn.textContent = confirmLabel
        confirmBtn.addEventListener('click', () => close(true))

        actions.append(cancelBtn, confirmBtn)
        const imgEl = img ? Object.assign(document.createElement('img'), {
            src: img,
            style: 'width:75%;border-radius:4px;margin:0 auto 0.8rem;display:block',
        }) : null
        box.append(...(imgEl ? [imgEl] : []), h3, bodyEl, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        cancelBtn.focus()
    })
}

// Sentence splitter for the formatter — also handles closing quotes/parens before the space.
function wrapSentencesFormat(text) {
    return text.replace(/([.!?][“”"»)]*)\s+(?=[A-ZÄÖÜ„"(])/g, '$1\n')
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
    if (div.dataset.editorType === 'stage') return '*' + textOf(div).trim() + '*'
    if (div.dataset.editorType === 'text') {
        const raw = textOf(div).trim()
        // Re-append space so "# " or "## " stays valid ATX-heading markdown after trim
        return /^#{1,6}$/.test(raw) ? raw + ' ' : raw
    }
    if (div.dataset.editorType === 'role') {
        let roleName = ''
        let dialogueParts = []
        let afterName = false
        for (const node of div.childNodes) {
            if (node.classList?.contains('editor-role-name')) {
                roleName = node.textContent
                afterName = true
            } else if (afterName) {
                dialogueParts.push(serializeRoleNode(node))
            }
        }
        const dialogue = wrapSentences(dialogueParts.join('').replace(/(<br>)+$/, '').trim())
        return dialogue ? '**' + roleName + '**\n' + dialogue : '**' + roleName + '**'
    }
    return textOf(div).trim()  // fallback (should not normally be reached)
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
    btnUp.className = 'editor-btn'; btnUp.textContent = '▲'; btnUp.title = 'Nach oben'
    const btnDown = document.createElement('button')
    btnDown.className = 'editor-btn'; btnDown.textContent = '▼'; btnDown.title = 'Nach unten'
    const btnDel  = document.createElement('button')
    btnDel.className = 'editor-btn editor-btn-delete'; btnDel.textContent = '✕'; btnDel.title = 'Löschen'
    controls.append(btnUp, btnDown, btnDel)
    wrapper.appendChild(controls)

    document.body.appendChild(wrapper)
    el.focus()
    // Place cursor at end
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)

    blockEl.style.visibility = 'hidden'
    inlineEditor = { el, blockEl, lineStart: info.lineStart, lineEnd: info.lineEnd, isNew: false }

    el.addEventListener('keydown', onEditorKey)
    el.addEventListener('input',   onEditorInput)
    el.addEventListener('blur',    () => setTimeout(() => {
        if (inlineEditor?.el === el) closeEditor(true)
    }, 180))

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

function onEditorKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(true); return }
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
    this._st = setTimeout(saveCurrentEdit, 600)
    updateEditorParens(this)
    syncEditorHeight()
}

function saveCurrentEdit() {
    if (!inlineEditor || inlineEditor.isNew) return
    const { el, lineStart, lineEnd } = inlineEditor
    const newContent = serializeEditorMarkdown(el)
    const newLines = newContent.split('\n')
    const lines = scriptText.split('\n')
    lines.splice(lineStart, lineEnd - lineStart + 1, ...newLines)
    scriptText = lines.join('\n')
    window.electronAPI.writeScriptMd(scriptText)
    inlineEditor.lineEnd = lineStart + newLines.length - 1
}

function closeEditor(save) {
    if (!inlineEditor) return
    if (save) saveCurrentEdit()
    ;(inlineEditor.el.closest('.editor-wrapper') ?? inlineEditor.el).remove()
    if (inlineEditor.blockEl) inlineEditor.blockEl.style.visibility = ''
    inlineEditor = null
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
    window.electronAPI.writeScriptMd(scriptText)
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
    window.electronAPI.writeScriptMd(scriptText)

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
    div.dataset.placeholder = isAfterRole ? 'Dialogue…' : 'Regieanweisung oder Rolle…'

    const wrapper = document.createElement('div')
    wrapper.className = 'new-block-wrapper'
    wrapper.style.width = afterBlockEl.getBoundingClientRect().width + 'px'

    const controls = document.createElement('div')
    controls.className = 'editor-controls new-block-controls'
    const btnUp   = document.createElement('button')
    btnUp.className = 'editor-btn'; btnUp.textContent = '▲'; btnUp.title = 'Block darüber bearbeiten'
    const btnDown = document.createElement('button')
    btnDown.className = 'editor-btn'; btnDown.textContent = '▼'; btnDown.title = 'Block darunter bearbeiten'
    const btnDel  = document.createElement('button')
    btnDel.className = 'editor-btn editor-btn-delete'; btnDel.textContent = '✕'; btnDel.title = 'Abbrechen'
    controls.append(btnUp, btnDown, btnDel)
    wrapper.append(div, controls)

    afterBlockEl.after(wrapper)
    wrapper.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    div.focus()
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
    const hasTextBlocks = tokenizeScript(scriptText).some(b => b.type === 'text')
    if (!hasTextBlocks) openEmptyScriptEditor()
}

function openEmptyScriptEditor() {
    if (inlineEditor) return

    const div = document.createElement('div')
    div.className = 'inline-editor inline-editor-new'
    div.contentEditable = 'true'
    div.dataset.placeholder = 'Regieanweisung oder Rolle…'

    const wrapper = document.createElement('div')
    wrapper.className = 'new-block-wrapper'
    const contentEl = document.getElementById('script-content')
    if (contentEl) wrapper.style.width = contentEl.getBoundingClientRect().width + 'px'

    const controls = document.createElement('div')
    controls.className = 'editor-controls new-block-controls'
    const btnDel = document.createElement('button')
    btnDel.className = 'editor-btn editor-btn-delete'
    btnDel.textContent = '✕'
    btnDel.title = 'Abbrechen'
    controls.append(btnDel)
    wrapper.append(div, controls)

    wrapper.style.marginTop = '4.5rem'
    contentEl?.appendChild(wrapper)
    requestAnimationFrame(() => div.focus())

    const lineStart = scriptText.split('\n').length - 1
    inlineEditor = { el: div, wrapper, blockEl: null, afterBlockEl: null, lineStart, isNew: true, isAfterRole: false, isPersistent: true }

    div.addEventListener('keydown', onNewBlockKey)
    div.addEventListener('beforeinput', onNewBlockBeforeInput)
    div.addEventListener('input', onNewBlockInput)
    div.addEventListener('blur', () => setTimeout(() => {
        if (inlineEditor?.el !== div) return
        if (inlineEditor.isPersistent && !getTyped(div).trim() && !inlineEditor.confirmedRole) return
        commitNewBlock()
    }, 180))

    btnDel.addEventListener('mousedown', (e) => {
        e.preventDefault()
        if (getTyped(div).trim() || inlineEditor?.confirmedRole) {
            clearGhost(); wrapper.remove(); inlineEditor = null
        }
    })
}

function getTyped(el) {
    return [...el.childNodes]
        .filter(n => !(n.nodeType === Node.ELEMENT_NODE && (n.classList.contains('ac-ghost') || n.classList.contains('role-confirmed'))))
        .map(n => n.textContent).join('')
}

function getDialogue(el) {
    const roleSpan = el.querySelector('.role-confirmed')
    if (!roleSpan) return ''
    let after = false
    let text = ''
    for (const node of el.childNodes) {
        if (node === roleSpan) { after = true; continue }
        if (after && !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('ac-ghost'))) {
            text += node.tagName === 'BR' ? '<br>' : node.textContent
        }
    }
    return text.replace(/^\s+/, '')
}

function updateInlineAc(typed) {
    const el = inlineEditor?.el
    if (!el) return
    el.querySelector('.ac-ghost')?.remove()
    if (!typed) { acState = null; return }
    const roles = Object.keys(config.roles || {})
    const match = roles.find(r => r.toLowerCase().startsWith(typed.toLowerCase()))
    if (!match || match.toLowerCase() === typed.toLowerCase()) { acState = null; return }
    acState = { typed, match }
    const ghost = document.createElement('span')
    ghost.className = 'ac-ghost'
    ghost.contentEditable = 'false'
    ghost.textContent = match.slice(typed.length)
    const roleColor = ROLE_COLORS[config.roles?.[match]?.color]
    if (roleColor) ghost.style.color = roleColor
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
        if (inlineEditor?.isPersistent && !getTyped(e.currentTarget).trim() && !inlineEditor?.confirmedRole) {
            return
        }
        if (inlineEditor?.confirmedRole) {
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
        const hasContent = !!(el && getTyped(el).trim()) || !!inlineEditor?.confirmedRole
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
        const hasContent = !!(el && getTyped(el).trim()) || !!inlineEditor?.confirmedRole
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
    }
    // Enter is handled via onNewBlockBeforeInput (reliable in Electron/Chromium contenteditable)
}

function acceptGhostInline() {
    if (!inlineEditor || !acState) return
    const el = inlineEditor.el
    const { match } = acState
    acState = null

    // Replace editor content with a styled role name + space for dialogue input
    el.innerHTML = ''
    const roleSpan = document.createElement('span')
    roleSpan.className = 'role-confirmed'
    roleSpan.contentEditable = 'false'
    roleSpan.textContent = match
    const roleColor = ROLE_COLORS[config.roles?.[match]?.color]
    if (roleColor) roleSpan.style.color = roleColor
    el.appendChild(roleSpan)
    const space = document.createTextNode(' ')
    el.appendChild(space)

    inlineEditor.confirmedRole = match
    el.dataset.placeholder = 'Text…'
    if (roleColor) el.style.color = roleColor

    el.focus()
    const range = document.createRange()
    range.setStartAfter(space)
    range.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
}

function onNewBlockBeforeInput(e) {
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        e.preventDefault()
        // Shift+Enter (insertLineBreak) while typing dialogue → insert <br> instead of committing
        if (e.inputType === 'insertLineBreak' && inlineEditor?.confirmedRole && inlineEditor?.el === this) {
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
    const dialogue = afterRole.map(n => n.classList?.contains('ac-ghost') ? '' : serializeRoleNode(n)).join('')
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
    const { el, wrapper, lineStart, isAfterRole, confirmedRole } = inlineEditor

    let insertLines, _target, _afterRole

    if (confirmedRole) {
        // Phase 2: role name was confirmed via Tab; extract any dialogue typed after the space
        const dialogue = getDialogue(el).replace(/(<br>)+$/, '').trim()
        clearGhost()
        ;(wrapper ?? el).remove()
        inlineEditor = null
        if (dialogue) {
            // Role and dialogue on consecutive lines (no blank line) → one block, styled together
            insertLines = ['', `**${confirmedRole}**`, wrapSentences(dialogue.replace(/\(([^)]+)\)/g, '*($1)*'))]
            _target = lineStart + 1   // start of the combined role+dialogue block
            _afterRole = false
        } else {
            insertLines = ['', `**${confirmedRole}**`]
            _target = lineStart + 1   // role line — next editor is for dialogue
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
    window.electronAPI.writeScriptMd(scriptText)
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
    }
}, { capture: true })
window.addEventListener('blur', () => { shiftHeld = false; document.body.classList.remove('shift-held') })
window.addEventListener('scroll', updateSidebarActive, { passive: true })

const _headerShield = document.getElementById('header-shield')
function updateHeaderShield() {
    if (!_headerShield) return
    const btns = document.querySelector('.buttons')
    const btnsBottom = btns ? btns.getBoundingClientRect().bottom : 0
    document.documentElement.style.setProperty('--btns-bottom', btnsBottom + 'px')
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


const converter = new showdown.Converter

// DOMPurify is initialised here (module level, runs in Electron renderer where window exists).
// Allowlist covers everything showdown legitimately produces from this app's Markdown format.
// script/onerror/javascript: and all other XSS vectors are stripped.
const DOMPurify = createDOMPurify(window)
const _purifyConfig = {
    ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','b','i','ul','ol','li','blockquote','code','pre','hr'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
}
function makeHtmlSafe(mdText) {
    return DOMPurify.sanitize(converter.makeHtml(mdText), _purifyConfig)
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
        blocks.splice(rootPos - 1, 0, ...group)
    } else {
        if (rootPos >= blocks.length) { blocks.splice(rootPos, 0, ...group); return }
        blocks.splice(rootPos + 1, 0, ...group)
    }

    const updated = blocks.map(b => b.content).join('\n\n') + '\n'
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    rerender(updated)
}


function rerender(newText) {
    if (inlineEditor) {
        clearGhost()
        inlineEditor = null
    }
    const scrollY = window.scrollY

    // Teardown auto-trigger listeners before destroying WaveSurfer instances
    for (const [, setup] of autoTriggerSetup) {
        setup.unPlay?.(); setup.unTime?.(); setup.unPause?.(); setup.unFin?.()
    }
    autoTriggerSetup.clear()
    autoTriggerBtns.clear()

    for (const { ws } of triggerAudio.values()) {
        try { ws.destroy() } catch (e) {}
    }

    triggers = []
    triggerYamls = []
    triggerAudio.clear()
    slfDerivedTcBadges.clear()
    fileToTriggers.clear()
    usedChs = []
    config = {}
    loopOutroPending.clear()
    loopOutroInitialRemaining.clear()
    loopBtns.clear()
    loopGroups.clear()

    validateYamlBlocks(newText)
    document.getElementById('script-content').innerHTML = makeHtmlSafe(newText)
    convertCodeblocks()
    colorText()
    showParseErrors()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
    buildInsertZones()
    setupAutoTriggers()
    buildSidebar()
    clearSearchHighlights()

    requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, behavior: 'instant' })
        checkEmptyScript()
        updateHeaderShield()
    })
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function validateYamlBlocks(text) {
    parseErrors = []
    audioWarnings = []
    let blockNum = 0
    for (const m of text.matchAll(/```yaml\n([\s\S]*?)\n```/g)) {
        blockNum++
        const line = text.slice(0, m.index).split('\n').length
        try { yaml.load(m[1]) } catch (e) {
            parseErrors.push({ blockNum, line, message: e.message })
        }
    }
}

function showParseErrors() {
    const existing = document.getElementById('parse-error-banner')
    if (existing) existing.remove()
    if (!parseErrors.length && !audioWarnings.length) return
    const banner = document.createElement('div')
    banner.id = 'parse-error-banner'
    banner.className = 'parse-error-banner'
    let html = `<button class="parse-error-close" onclick="this.parentElement.remove()">×</button>`
    if (parseErrors.length) {
        const items = parseErrors.map(({ blockNum, line, message }) => {
            const loc = blockNum != null
                ? `Block ${blockNum}${line != null ? `, Zeile ${line}` : ''}`
                : ''
            return `<li>${loc ? loc + ': ' : ''}${escapeHtml(message)}</li>`
        }).join('')
        html += `<strong>${parseErrors.length} YAML-Fehler</strong><ul>${items}</ul>`
    }
    if (audioWarnings.length) {
        const items = audioWarnings.map(({ file }) =>
            `<li>${escapeHtml(file)}</li>`
        ).join('')
        html += `<strong>${audioWarnings.length} Audiodatei${audioWarnings.length > 1 ? 'en' : ''} nicht gefunden</strong><ul>${items}</ul>`
    }
    banner.innerHTML = html
    document.body.prepend(banner)
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
        btn.textContent = '✕ Auto-Cue'
        btn.classList.remove('trigger-action-btn-active')
        btn.classList.add('trigger-action-btn-danger')
        btn.title = 'Auto-Cue löschen (Shift+Klick)'
    } else {
        btn.textContent = '⏱ Auto-Cue'
        btn.classList.remove('trigger-action-btn-danger')
        btn.classList.toggle('trigger-action-btn-active', !!aty)
        btn.title = aty ? 'Auto-Cue bearbeiten' : 'Auto-Cue setzen'
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
    window.electronAPI.writeScriptMd(updated)
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
    const triggerLight = document.createElement("div")
    triggerLight.classList.add("trigger-light")

    if (codeblockYaml.light) triggerInfo.appendChild(triggerLight)
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
    // Warning banner (initially hidden; updated by updateLoopBtnAppearance / updateLoopBtnWavWarning)
    const wavWarnEl = document.createElement('div')
    wavWarnEl.className = 'trigger-wav-warning'
    wavWarnEl.textContent = '⚠ Kein nahtloser Übergang – MP3/AAC haben Encoder-Padding. WAV verwenden.'
    wavWarnEl.style.display = 'none'
    triggerDiv.insertBefore(wavWarnEl, triggerDiv.firstChild ?? null)
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

    // mic info — only show row when mic is configured
    if (codeblockYaml.mic) {
        triggerMic.innerHTML = MIC_SVG
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
                triggerMusic.appendChild(document.createTextNode(`⇢ ${adjRef} ausfaden`))
            } else if (codeblockYaml.music.adjust.volume !== undefined) {
                triggerMusic.appendChild(document.createTextNode(`⇢ ${adjRef} auf ${codeblockYaml.music.adjust.volume * 100}%`))
            }
        }
        // Insert after mic (if present), before light
        const lightEl = triggerInfo.querySelector('.trigger-light')
        triggerInfo.insertBefore(triggerMusic, lightEl ?? null)
    }

    // light scene
    if (codeblockYaml.light) {
        triggerLight.textContent = '✦ ' + codeblockYaml.light
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
        let suppressSeekRestart  = false
        let suppressPauseStop    = false  // prevents ws.on("pause") from killing a group source

        function startSource(offset, when) {
            const ta_ = triggerAudio.get(index)
            if (!sharedAudioCtx || !playbackGain) {
                if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 1
                return
            }
            if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 0
            stopSource()
            if (!ta_?.decodedBuffer) { if (mainAudioCtxGain) mainAudioCtxGain.gain.value = 1; return }
            const src = sharedAudioCtx.createBufferSource()
            src.buffer = ta_.decodedBuffer
            // Ensure group is registered (cheap, idempotent)
            tryBuildLoopGroups()
            const loopGroup   = loopGroups.get(index)
            const isLoopTrigger = loopGroup || loopEnabled
            if (isLoopTrigger) {
                src.loop      = true
                src.loopStart = mp.start ?? 0
                src.loopEnd   = mp.end ?? ta_.decodedBuffer.duration
            }
            src.connect(playbackGain)
            const safeOffset = Math.max(0, offset)
            src.start(when, safeOffset)
            activeSource = src
            activeSourceStartedAt   = when
            activeSourceStartOffset = safeOffset
            if (loopGroup) {
                loopGroup.loopVirtualStartTime = when - (safeOffset - (mp.start ?? 0))
                // Don't set mainAudioEl.loop for group triggers — loop-back seeking would
                // trigger ws.on("seeking") → startSource → second audio instance.
                // Cursor is reset manually in fireLoopRestart instead.
            }
            if (loopEnabled) {
                mainAudioEl.loop = true
            }
            src.addEventListener('ended', () => { if (activeSource === src) activeSource = null })
            // Monitor channels (2-3) are part of the merged 4-ch buffer — no separate source needed.
        }

        function stopSource(when) {
            // If this trigger's audio is owned by a group source from another trigger,
            // delegate to that trigger's forceStop callback instead.
            const ta_ = triggerAudio.get(index)
            if (!activeSource && ta_?.forceStop) {
                ta_.forceStop(when); ta_.forceStop = null; ta_.playbackGainOverride = null; return
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

        ws.on("ready",  () => { waveformContainer.appendChild(overlay); updateMarkers(); autoMarkerState.refresh?.(); preDecodeForGapless(index); updateDerivedTcBadges() })
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
            x32UnmuteChannels(ty?.mic)
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
            cueHistory.push(nextIdx)
            broadcastLiveState()
        }

        function fireGaplessTransition(nextIdx) {
            const nextTa = triggerAudio.get(nextIdx)
            const ty = triggerYamls[nextIdx]
            if (!nextTa || !ty?.music) { triggerAction(nextIdx); return }

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
                const ta_  = triggerAudio.get(index)
                const sr   = ctx.sampleRate
                const loopStartSec     = mp.start ?? 0
                const loopEndSec       = mp.end ?? (ta_?.decodedBuffer?.duration ?? ws.getDuration())
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

                // ① Stop loop source at exact loop boundary
                stopSource(transitionTime)

                // ② Stop cursor shortly before the audio boundary — avoids a visible cursor
                // freeze when the timer fires well before the boundary (increased lead time).
                // gaplessActive (set below) protects against spurious "finish" events meanwhile.
                setTimeout(() => {
                    suppressPauseStop = true
                    mainAudioEl.loop = false
                    mainAudioEl.pause()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                }, Math.max(0, msToTransition - 15))

                // ③ Start outro audio source at the same instant — pure WebAudio, no media element
                const nextPg = nextTa.getPlaybackGain?.()
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(fadein > 0 ? 0 : vol)
                if (nextPg) nextPg.gain.value = fadein > 0 ? 0 : vol
                nextTa.startGaplessSource(ns, transitionTime)

                // ④ Swap cursors: seek loop cursor to start, launch outro cursor
                gaplessActive = true
                setTimeout(() => {
                    mainAudioEl.currentTime = mp.start
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    gaplessActive = false
                    nextTa.startCursor(ns, 0)
                }, msToTransition + 10)

                _nonAudioActions(nextIdx, nextTa)

            } else if (ctx && nextTa.decodedBuffer && nextTa.startGaplessSource) {
                // ── Pure AudioBufferSourceNode transition (e.g. Intro → Loop) ──────────
                let transitionTime
                if (activeSourceStartedAt !== null && activeSourceStartOffset !== null) {
                    transitionTime = activeSourceStartedAt + (effEnd - activeSourceStartOffset)
                } else {
                    transitionTime = ctx.currentTime + timeUntilEnd
                }
                transitionTime = Math.max(ctx.currentTime, transitionTime)
                const msToTransition = Math.max(0, transitionTime - ctx.currentTime) * 1000

                // ① Stop current source at transitionTime
                stopSource(transitionTime)
                gaplessActive = true

                // ② Start next audio source at transitionTime
                const nextPg = nextTa.getPlaybackGain?.()
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(fadein > 0 ? 0 : vol)
                if (nextPg) nextPg.gain.value = fadein > 0 ? 0 : vol
                nextTa.startGaplessSource(ns, transitionTime)

                // ③ Swap cursors at transition
                setTimeout(() => {
                    gaplessActive = false
                    suppressPauseStop = true
                    mainAudioEl.pause()
                    mainAudioEl.currentTime = mp.start
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    setTimeout(() => { suppressPauseStop = false }, 0)
                    nextTa.startCursor(ns, 0)
                }, msToTransition + 5)

                _nonAudioActions(nextIdx, nextTa)

            } else {
                // ── Fallback: buffer not decoded — use media element directly ──
                cancelWsFade(nextTa.ws)
                nextTa.setCurrentVolume(fadein > 0 ? 0 : vol)
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
                // src.loop=true handles audio gaplessly; cursor must be reset here, not in
                // ws.on("finish"), because mainAudioEl plays past mp.end to the file end which
                // creates an audible tail before the cursor jumps back.
                if (!activeSource) return  // outro transition killed source — don't touch cursor
                clearTimeout(loopJumpTimer); loopJumpTimer = null  // cancel any stale timer
                suppressSeekRestart = true
                mainAudioEl.currentTime = mp.start
                setTimeout(() => { suppressSeekRestart = false }, 50)
                return
            }
            if (activeSource && loopEnabled) return

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

        ws.on("timeupdate", (ct) => {
            const effEnd = mp.end ?? ws.getDuration()
            if (ct >= effEnd) {
                if (gaplessActive) { ws.setVolume(currentVolume); return }
                const isManaged = !!triggerYamls[index]?.loop_outro
                if (isManaged) {
                    if (loopOutroPending.has(index)) {
                        fireLoopOutro()   // fallback if timer missed
                    } else {
                        fireLoopRestart(effEnd)
                    }
                } else if (loopEnabled) {
                    fireLoopRestart(effEnd)
                } else {
                    const chainEnd = triggerYamls[index]?.chain_end
                    if (chainEnd && !chainEndArmed) {
                        const nextIdx = findTriggerByNote(chainEnd)
                        if (nextIdx !== null) {
                            fireChainEnd(nextIdx)
                        } else {
                            ws.stop()
                            if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                        }
                    } else if (!chainEnd) {
                        ws.stop()
                        if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    }
                }
                ws.setVolume(currentVolume); return
            }
            // Pre-seek next audio and schedule gapless transition via setTimeout
            // (fires at the precise end time instead of waiting for next timeupdate)
            if (!preSeekArmed) {
                const chainEnd = triggerYamls[index]?.chain_end
                if (chainEnd && effEnd - ct < 0.35) {
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
                        }, Math.max(0, (effEnd - ct) * 1000 - 50))
                    }
                }
                if (!chainEnd) {
                    const loopOutro = triggerYamls[index]?.loop_outro
                    const isManaged = !!loopOutro
                    if (isManaged && effEnd - ct < 0.35) {
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
                                }, Math.max(0, (effEnd - ct) * 1000 - 50))
                            }
                        } else {
                            // No outro: schedule gapless loop restart
                            preDecodeForGapless(index)
                            clearTimeout(loopJumpTimer)
                            loopJumpTimer = setTimeout(() => {
                                loopJumpTimer = null
                                fireLoopRestart(effEnd)
                            }, Math.max(0, (effEnd - ct) * 1000 - 5))
                        }
                    } else if (loopEnabled && effEnd - ct < 0.35) {
                        preSeekArmed = true
                        preDecodeForGapless(index)
                        clearTimeout(loopJumpTimer)
                        loopJumpTimer = setTimeout(() => {
                            loopJumpTimer = null
                            fireLoopRestart(effEnd)
                        }, Math.max(0, (effEnd - ct) * 1000 - 5))
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
            if (!audioWarnings.some(w => w.file === musicFile)) {
                audioWarnings.push({ file: musicFile, cueNum: index })
                showParseErrors()
            }
        })
        ws.on("play",   () => {
            // If a gapless transition is in progress, a cursor restart (e.g. mainAudioEl.loop=true
            // looping back after stopSource cleared activeSource) must not start a new source or
            // clear timers — the transition's setTimeout owns state until gaplessActive=false.
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
        })
        ws.on("seeking", (t) => {
            if (suppressSeekRestart || mainAudioEl.paused) return
            // AudioBufferSourceNode loops internally; cursor seek must not restart the source.
            // Only restart on explicit user scrub (scrubbingSet tracks drag state).
            if ((loopEnabled || loopGroups.has(index)) && activeSource && !scrubbingSet.has(index)) return
            if (sharedAudioCtx) startSource(t, sharedAudioCtx.currentTime)
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
            loopEnabled = mp.loop
            mainAudioEl.loop = mp.loop
            if (activeSource) activeSource.loop = mp.loop
            loopBtn.classList.toggle("waveform-btn-active", mp.loop)
            updateLoopBtnWavWarning()
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

        const monitorFile = typeof codeblockYaml.music === 'object' ? codeblockYaml.music.monitor ?? null : null

        // ── Common patches ────────────────────────────────────────────────
        const _wsSetVol = ws.setVolume.bind(ws)
        ws.setVolume = (v) => {
            _wsSetVol(v)
            const ta_ = triggerAudio.get(index)
            const targetGain = ta_?.playbackGainOverride ?? playbackGain
            if (targetGain) targetGain.gain.value = v
        }
        const _wsStop = ws.stop.bind(ws)
        ws.stop = () => {
            stopSource()
            mainAudioEl.loop = false
            _wsStop()
        }

        triggerAudio.set(index, {
            ws, mainAudioEl, monitorFile, musicFile, overlay, getX, autoMarkerState, mp,
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
                src.buffer = ta_.decodedBuffer
                const loopGroup     = loopGroups.get(index)
                const isLoopTrigger = loopGroup || loopEnabled
                const actualOffset  = Math.max(0, offset)
                if (isLoopTrigger) {
                    src.loop      = true
                    src.loopStart = mp.start ?? 0
                    src.loopEnd   = mp.end ?? ta_.decodedBuffer.duration
                }
                src.connect(playbackGain)
                src.start(when, actualOffset)
                activeSource = src
                activeSourceStartedAt   = when
                activeSourceStartOffset = actualOffset
                if (loopGroup) {
                    loopGroup.loopVirtualStartTime = when - (actualOffset - (mp.start ?? 0))
                }
                if (isLoopTrigger) mainAudioEl.loop = true
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
                const loopEndSec       = mp.end ?? (triggerAudio.get(index)?.decodedBuffer?.duration ?? ws.getDuration())
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
            // Arm the trigger as next cue instead of firing it immediately
            setArmedCue(index)
            broadcastLiveState()
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

    // ── Auto-Cue button ──────────────────────────────────────────────────
    const autoBtn = document.createElement('button')
    autoBtn.classList.add('trigger-action-btn', 'trigger-action-btn-auto')
    autoBtn._triggerIndex = index
    autoBtn._hovering = false
    if (codeblockYaml.auto_trigger) autoBtn.classList.add('trigger-action-btn-active')
    autoBtn.textContent = '⏱ Auto-Cue'
    autoBtn.title = codeblockYaml.auto_trigger ? 'Auto-Cue bearbeiten' : 'Auto-Cue setzen'
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

    // ── Lichtszene ───────────────────────────────────────────────────
    const { wrap: lightWrap, input: lightInput } = mkDialogField('Lichtszene', 'text', '')
    lightInput.placeholder = '— kein Licht-Cue —'
    if ((isEdit || isCopy) && existingYaml?.light && typeof existingYaml.light === 'string') {
        lightInput.value = existingYaml.light
    }
    box.appendChild(lightWrap)

    // ── Start-Timecode ───────────────────────────────────────────────
    let tcInput = null
    if (isNonRootSlfMember) {
        const tcWrap = document.createElement('div')
        tcWrap.classList.add('dialog-field')
        const tcLabel = document.createElement('label')
        tcLabel.textContent = 'Start-Timecode (abgeleitet)'
        const tcDisplay = document.createElement('div')
        tcDisplay.classList.add('dialog-tc-derived')
        const derived = derivedTcFor(triggerIndex)
        if (derived) {
            tcDisplay.textContent = '↳ ' + derived
            tcDisplay.title = 'Timecode wird vom Start-Cue der S/L/F-Gruppe abgeleitet'
        } else {
            tcDisplay.textContent = '—'
            tcDisplay.title = 'Timecode wird abgeleitet (Start-Timecode oder Audiodauer unbekannt)'
        }
        tcWrap.append(tcLabel, tcDisplay)
        box.appendChild(tcWrap)
    } else {
        const { wrap, input } = mkDialogField('Start-Timecode (HH:MM:SS:FF)', 'text', '')
        tcInput = input
        tcInput.placeholder = '00:00:00:00'
        if ((isEdit || isCopy) && existingYaml?.start_tc) tcInput.value = existingYaml.start_tc
        box.appendChild(wrap)
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

        // light scene
        const lightVal = lightInput.value.trim()
        if (lightVal) newYaml.light = lightVal

        // start_tc (only for root SLF cues; non-root members use derived TC)
        const tcVal = tcInput?.value.trim() ?? ''
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
        // preserve auto_trigger when editing or copying (variants share the same auto-cue point)
        if (existingYaml?.auto_trigger) newYaml.auto_trigger = existingYaml.auto_trigger

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

    // ── Fadezeit ─────────────────────────────────────────────────────
    const fadeTimeWrap = document.createElement('div')
    fadeTimeWrap.classList.add('dialog-field')
    const fadeTimeLbl = document.createElement('label')
    fadeTimeLbl.textContent = 'Fadezeit (Sekunden)'
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
        btn.title = 'Loop-Verbindung löschen (Shift+Klick)'
        return
    }
    btn.classList.remove('trigger-action-btn-danger')
    btn.classList.add('trigger-action-btn-active')

    if (hasCE && isOutro) {
        // Bridge: outro of one loop + transition into next loop
        const ce = `${ty.chain_end.ch}.${ty.chain_end.note}`
        const from = sources.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
        btn.textContent = 'Bridge'
        btn.title = `Bridge: Ausgang von Schleife(n) ${from}, startet am Ende Trigger ${ce}`
    } else if (hasCE) {
        const ce = `${ty.chain_end.ch}.${ty.chain_end.note}`
        btn.textContent = 'Start'
        btn.title = `Start: startet am Ende automatisch Trigger ${ce}`
    } else if (hasLO) {
        const lo = `${ty.loop_outro.ch}.${ty.loop_outro.note}`
        btn.textContent = 'Loop'
        btn.title = `Loop: loopt bis Trigger ${lo} am Schleifen-Ende angeklickt wurde`
    } else if (isOutro) {
        const from = sources.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
        btn.textContent = 'Finish'
        btn.title = `Finish: wird am Schleifen-Ende von Schleife(n) ${from} nahtlos gestartet`
    } else {
        btn.textContent = 'S/L/F'
        btn.classList.remove('trigger-action-btn-active')
        btn.title = 'Loop-Struktur einrichten (Start, Loop, Finish …)'
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
    window.electronAPI.writeScriptMd(updated)
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
            window.electronAPI.writeScriptMd(scriptText)
            if (triggerYamls[targetIdx]) delete triggerYamls[targetIdx].start_tc
        }
    }
    for (const [idx, btn] of loopBtns) updateLoopBtnAppearance(btn, idx)
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
    if (ta && ta.ws.isPlaying()) {
        ta.ws.stop()
        if (mtc && mtc.activeTcIndex === cue) mtc.stopAndClear()
        return
    }

    // Outro-interception: if this trigger is the outro for a currently-playing managed loop,
    // queue it instead of playing immediately. Second click cancels the queue.
    for (let i = 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]?.loop_outro) continue
        if (findTriggerByNote(triggerYamls[i].loop_outro) !== cue) continue
        const loopTa = triggerAudio.get(i)
        if (!loopTa?.ws.isPlaying()) continue
        if (loopOutroPending.get(i) === cue) {
            // Second click → cancel pending
            loopOutroPending.delete(i)
            loopOutroInitialRemaining.delete(i)
            setOutroPendingIndicator(cue, false)
        } else {
            // Record how much loop time remains right now (= full bar duration)
            const lmp = loopTa.mp
            const lStart = lmp?.start ?? 0
            const lEnd   = lmp?.end ?? loopTa.ws.getDuration() ?? 0
            const range  = lEnd - lStart
            const ct     = loopTa.mainAudioEl?.currentTime ?? 0
            const pos    = range > 0 ? ((ct - lStart) % range + range) % range : 0
            loopOutroInitialRemaining.set(i, Math.max(0, range - pos))
            loopOutroPending.set(i, cue)
            setOutroPendingIndicator(cue, true)
            loopTa.armOutroTimer?.()
        }
        broadcastLiveState()
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
        const role = config.roles?.[p.firstChild.textContent]
        if (role) p.classList.add('color-' + role.color)
    }
    return div.innerHTML
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
            if (triggerYamls[i]) { nextCue = i; break }
        }
    }

    const rawBlocks = tokenizeScript(scriptText)
    const liveBlocks = []
    let yamlCount = 0
    for (const b of rawBlocks) {
        if (b.type === 'yaml') {
            yamlCount++
            if (yamlCount === 1) continue  // config block
            const cueIdx = yamlCount - 1
            const ty = triggerYamls[cueIdx]
            if (!ty) continue

            const micList = !ty.mic ? [] :
                ty.mic === 'muteall' ? null :
                (typeof ty.mic === 'string' ? [ty.mic] : ty.mic)
            const micColors = micList ? micList.map(name => ({
                name, color: config.roles?.[name]?.color || null
            })) : null

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
                    const loopTa = triggerAudio.get(loopIdx)
                    if (loopTa) {
                        const lmp = loopTa.mp
                        const lStart = lmp?.start ?? 0
                        const lEnd   = lmp?.end ?? loopTa.ws.getDuration() ?? 0
                        const range  = lEnd - lStart
                        const ct     = loopTa.mainAudioEl?.currentTime ?? 0
                        const pos    = range > 0 ? ((ct - lStart) % range + range) % range : 0
                        // remaining = time left in current iteration when bar was last sampled
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
                isPlaying: triggerAudio.get(cueIdx)?.ws.isPlaying() ?? false,
                micColors,
                muteall: ty.mic === 'muteall',
                musicLabel, musicAdjust,
                lightScene: ty.light || null,
                note: ty.note || null,
                triggerNoteLabel,
                outroPending,
                autoCuePending,
                slfLabel,
            })
        } else {
            liveBlocks.push({
                type: 'text',
                html: applyRoleColorsToHtml(makeHtmlSafe(b.content)),
            })
        }
    }

    // Audio progress for all playing cues
    const audioProgress = []
    for (const [cueIdx, ta] of triggerAudio) {
        if (!ta.ws.isPlaying()) continue
        const ty = triggerYamls[cueIdx]
        const { mp } = ta
        const totalDuration = ta.ws.getDuration() ?? 0
        const loopStart = mp?.start ?? 0
        const loopEnd   = mp?.end   ?? totalDuration
        const isLoop    = !!(ty?.loop_outro || mp?.loop)
        audioProgress.push({
            cueIdx,
            label: (typeof ty?.music === 'string' ? ty.music : ty?.music?.file) || ('Cue ' + cueIdx),
            currentTime: ta.mainAudioEl?.currentTime ?? 0,
            loopStart,
            loopEnd,
            isLoop,
            volume: ta.getCurrentVolume?.() ?? (mp?.volume ?? 0.8),
        })
    }

    const tcFrames = (mtc && mtc.activeTcIndex !== null && mtc.wsRef)
        ? mtc.getCurrentFrames()
        : null
    window.electronAPI.sendLiveState({
        blocks: liveBlocks,
        currentCue: liveCurrent,
        nextCue,
        selectedVariant,
        timecodeFrames: tcFrames,
        audioProgress,
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
    setArmedCue(null)
    if (cueHistory.length < 1) return
    const last = cueHistory.pop()

    // Fade out any audio playing on the accidentally triggered cue
    fadeOutAndStop(last)

    // Cancel any loop outro that was queued by the accidental trigger
    for (const [loopIdx, outroIdx] of loopOutroPending) {
        if (outroIdx === last) {
            loopOutroPending.delete(loopIdx)
            loopOutroInitialRemaining.delete(loopIdx)
            setOutroPendingIndicator(last, false)
        }
    }

    const prev = cueHistory.length > 0 ? cueHistory[cueHistory.length - 1] : null

    if (prev !== null) {
        x32UnmuteChannels(triggerYamls[prev]?.mic)
        if (triggerYamls[last]?.light) sendTriggerNote(prev)
        // Restart prev's audio if it was a loop (simple mp.loop or managed loop_outro)
        const prevTa = triggerAudio.get(prev)
        const prevIsLoop = prevTa?.mp?.loop || !!triggerYamls[prev]?.loop_outro
        if (prevTa && !prevTa.ws.isPlaying() && prevIsLoop) playMusic(prev)

        // Undo any volume change or fadeout that last's music.adjust caused
        const lastMusic = triggerYamls[last]?.music
        if (typeof lastMusic === 'object' && lastMusic.adjust) {
            const adjIdx = findTriggerByNote(lastMusic.adjust.trigger_note)
            if (adjIdx !== null) {
                const adjTa = triggerAudio.get(adjIdx)
                if (adjTa) {
                    const adjIsLoop = adjTa.mp?.loop || !!triggerYamls[adjIdx]?.loop_outro
                    if (lastMusic.adjust.fadeout && adjIsLoop) {
                        // cancelWsFade restores currentVolume to pre-fade value if cancelled mid-fade;
                        // if already complete, fadeAdjustAudio already restored it on finish.
                        cancelWsFade(adjTa.ws)
                        adjTa.enableLoop()
                        if (!adjTa.ws.isPlaying()) playMusic(adjIdx)
                    } else if (lastMusic.adjust.volume !== undefined && adjTa.ws.isPlaying()) {
                        // Volume change was undone: fade back to original volume
                        cancelWsFade(adjTa.ws)
                        fadeAdjustVolume(adjTa, adjTa.mp.volume, lastMusic.adjust.fadetime ?? 3)
                    }
                }
            }
        }
        currentCue = prev
        markTriggers(prev)
    } else {
        x32UnmuteChannels('muteall')
        currentCue = 0
        markTriggers(0)
    }
    broadcastLiveState()
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
            ta.ws.stop()
            if (mtc && mtc.wsRef === ta.ws) mtc.stopAndClear()
            ta.enableLoop()
            ta.setCurrentVolume(startVol)
        }
    }, stepInterval)
    // Store ta + restoreVol so cancelWsFade can restore currentVolume if cancelled mid-fade
    activeFades.set(ta.ws, { id, ta, restoreVol: startVol })
}

function stopall() {
    for (const ta of triggerAudio.values()) {
        if (ta.ws.isPlaying()) fadeAdjustAudio(ta, 0.5)
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
        return `\`\`\`yaml\n${yaml.dump(withNote, { indent: 4, lineWidth: -1, noRefs: true }).trimEnd()}\n\`\`\``
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
    for (const roleName of Object.keys(config.roles ?? {})) {
        const ch = config.roles[roleName].ch
        if (!usedChs.includes(ch)) usedChs.push(ch)
    }
}

function colorText() {
    const paragraphs = document.querySelectorAll("p")
    for (const paragraph of paragraphs) {
        if (paragraph.firstChild?.tagName !== 'STRONG') continue
        const roleName = paragraph.firstChild.textContent
        const role = config.roles?.[roleName]
        if (!role) {
            if (!parseErrors.some(e => e.message === `Unbekannte Rolle: "${roleName}"`))
                parseErrors.push({ blockNum: null, line: null, message: `Unbekannte Rolle: "${roleName}"` })
            continue
        }
        paragraph.classList.add('color-' + role.color)
    }
}

function initButtons() {
    document.querySelector(".em-light").addEventListener("mousedown", () => {
        const eln = config.emLightNote
        if (!eln || !midiTrigger) return
        midiTrigger.send([0x90 | (eln.ch - 1), eln.note, 100])
        setTimeout(() => midiTrigger.send([0x80 | (eln.ch - 1), eln.note, 0]), 100)
    })
    document.querySelector(".em-music").addEventListener("mousedown", stopall)
    document.querySelector(".em-mic").addEventListener("mousedown", () => x32UnmuteChannels("muteall"))
    document.querySelector(".live-window-button").addEventListener("mousedown", () => window.electronAPI.openLiveWindow())
    document.querySelector(".current-trigger-button").addEventListener("mousedown", () => scrollToTrigger(currentCue))
    document.querySelector(".reload-button").addEventListener("mousedown", () => {
        sessionStorage.setItem('reloadScrollY', String(window.scrollY))
        location.reload()
    })
    document.querySelector(".sidebar-toggle-button").addEventListener("mousedown", toggleSidebar)
    document.getElementById('script-content').addEventListener('click', onScriptClick)
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
    midiGoNote   = settings.midiGoNote   || null
    midiBackNote = settings.midiBackNote || null
    if (!midiAccess) return
    for (const output of midiAccess.outputs.values()) {
        if (settings.midiX32Device && output.name === settings.midiX32Device) midiX32 = output
        if (settings.midiTriggerDevice && output.name === settings.midiTriggerDevice) midiTrigger = output
        if (settings.midiTCDevice && output.name === settings.midiTCDevice) midiTC = output
    }
    if (mtc) mtc.setOutput(midiTC)
}

function setupMidiInputListeners() {
    if (!midiAccess) return
    for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = (msg) => {
            const [status, note, velocity] = msg.data
            const type = status & 0xf0
            const ch   = (status & 0x0f) + 1
            if (type !== 0x90 || velocity === 0) return
            if (midiGoNote   && ch === midiGoNote.ch   && note === midiGoNote.note)   goAction()
            if (midiBackNote && ch === midiBackNote.ch && note === midiBackNote.note)  backAction()
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
    monitorChannelL = savedSettings.monitorChannelL ?? 2
    monitorChannelR = savedSettings.monitorChannelR ?? 3
    editorApp       = savedSettings.editorApp || null

    let text = await window.electronAPI.getScriptMd()

    const { text: modifiedText, changed } = assignTriggerNotes(text)
    if (changed) {
        await window.electronAPI.writeScriptMd(modifiedText)
        text = modifiedText
    }

    // Ask to format if the script doesn't match canonical style
    if (needsFormatting(text)) {
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
            await window.electronAPI.writeScriptMd(formatted)
            text = formatted
        }
    }

    // Show current file name in title bar
    const scriptPath = await window.electronAPI.getScriptPath()
    document.title = scriptPath.split(/[\\/]/).pop()
    const scriptDir = scriptPath.substring(0, scriptPath.lastIndexOf('/'))
    audioBasePath = encodeURI('file://' + scriptDir + '/audio/')

    validateYamlBlocks(text)
    scriptText = text
    document.getElementById('script-content').innerHTML = makeHtmlSafe(text)
    convertCodeblocks()
    colorText()
    showParseErrors()
    markControlledTriggers()
    groupSiblingTriggers()
    annotateBlocks()
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
        // Re-enumerate to pick up newly connected devices, then resolve labels.
        const applyNew = () => {
            const newML  = newSettings.mainChannelL    ?? 0
            const newMR  = newSettings.mainChannelR    ?? 1
            const newMoL = newSettings.monitorChannelL ?? 2
            const newMoR = newSettings.monitorChannelR ?? 3
            const changed = newML !== mainChannelL || newMR !== mainChannelR ||
                            newMoL !== monitorChannelL || newMoR !== monitorChannelR
            mainAudioDevice = resolveDeviceId(newSettings.mainAudioDevice)
            mainChannelL    = newML;  mainChannelR    = newMR
            monitorChannelL = newMoL; monitorChannelR = newMoR
            editorApp       = newSettings.editorApp || null
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

function buildExportData(withCues, withColors) {
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
            if (parsed.mic) {
                const roles = Array.isArray(parsed.mic) ? parsed.mic : [parsed.mic]
                cue.micRoles = roles  // keep array for coloring
                cue.mic = roles.join(', ')
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
            if (parsed.light)      cue.light      = String(parsed.light)
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
                const micHtml = (item.micRoles || [item.mic]).map(n => _esc(n)).join(', ')
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
            if (item.light)      rows.push(`<tr><td class="cfl">Licht</td><td class="cfv">${_esc(item.light)}</td></tr>`)
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
.narr{margin:.3rem 0;color:#222}`

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${css}</style></head><body>
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
        h3.textContent = 'Skript exportieren'

        const chkStyle = 'display:flex;align-items:center;gap:.6rem;color:#abb2bf;font-size:.9rem;margin-bottom:.8rem;cursor:pointer'

        const labelCues = document.createElement('label')
        labelCues.style.cssText = chkStyle
        const chkCues = document.createElement('input')
        chkCues.type = 'checkbox'
        chkCues.checked = false
        chkCues.style.cssText = 'width:15px;height:15px;cursor:pointer'
        labelCues.append(chkCues, 'Cues einschließen')

        const labelColors = document.createElement('label')
        labelColors.style.cssText = chkStyle + ';margin-bottom:1.5rem'
        const chkColors = document.createElement('input')
        chkColors.type = 'checkbox'
        chkColors.checked = true
        chkColors.style.cssText = 'width:15px;height:15px;cursor:pointer'
        labelColors.append(chkColors, 'Rollenfarben verwenden')

        const actions = document.createElement('div')
        actions.className = 'dialog-actions'

        const close = val => { overlay.remove(); resolve(val) }

        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'dialog-btn'
        cancelBtn.textContent = 'Abbrechen'
        cancelBtn.addEventListener('click', () => close(null))

        const pdfBtn = document.createElement('button')
        pdfBtn.className = 'dialog-btn dialog-btn-primary'
        pdfBtn.textContent = 'Als PDF'
        pdfBtn.addEventListener('click', () => close({ format: 'pdf', withCues: chkCues.checked, withColors: chkColors.checked }))

        const docxBtn = document.createElement('button')
        docxBtn.className = 'dialog-btn dialog-btn-primary'
        docxBtn.textContent = 'Als DOCX'
        docxBtn.addEventListener('click', () => close({ format: 'docx', withCues: chkCues.checked, withColors: chkColors.checked }))

        actions.append(cancelBtn, pdfBtn, docxBtn)
        box.append(h3, labelCues, labelColors, actions)
        overlay.append(box)
        document.body.appendChild(overlay)
        cancelBtn.focus()
    })
}

async function runExport() {
    const choice = await showExportDialog()
    if (!choice) return
    const data = buildExportData(choice.withCues, choice.withColors)
    if (choice.format === 'pdf') {
        await window.electronAPI.exportPdf({ html: generateExportHtml(data), title: data.title })
    } else {
        await window.electronAPI.exportDocx(data)
    }
}

// Registered at module level (before async initApp) so the listener is always ready.
window.addEventListener('__live-go__', () => {
    console.log('[main-win] live-go received, triggerYamls.length:', triggerYamls.length, 'currentCue:', currentCue)
    goAction()
})
window.addEventListener('__live-back__', () => backAction())
window.__liveGo = goAction
window.__liveBack = backAction
window.__selectVariant = (idx) => { selectedVariant = idx; broadcastLiveState() }
window.__stopAudio = (cueIdx) => { const ta = triggerAudio.get(cueIdx); if (ta) fadeAdjustAudio(ta, 0.5) }
window.__runExport = runExport

window.electronAPI.onLiveWindowState((isOpen) => {
    liveViewOpen = isOpen
    if (!isOpen) setArmedCue(null)
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
