"use strict"

const showdown = require('showdown')
const yaml = require('js-yaml')
const WaveSurfer = require('wavesurfer.js')

let config = {}
let usedChs = []
let triggers = []
let triggerYamls = []
let parseErrors = []  // {blockNum, line, message}
const loopOutroPending = new Map()  // loopTriggerIdx → outroTriggerIdx
const loopBtns = new Map()          // triggerIdx → button element

// triggerIndex -> { ws, wsMonitor, mainAudioEl, monAudioEl, musicFile, overlay, getX, autoMarkerState }
const triggerAudio = new Map()
// musicFile -> triggerIndex[]  (for cross-trigger fade lookups)
const fileToTriggers = new Map()
// targetIdx → <button> element for auto-cue progress bar updates
const autoTriggerBtns = new Map()
// sourceIdx → { links, unPlay, unTime, unPause, unFin, markFired, getUnfiredPast }
const autoTriggerSetup = new Map()
// sourceIdx currently being scrubbed (drag on waveform while playing)
const scrubbingSet = new Set()

let mainAudioDevice = null
let monitorAudioDevice = null
let monitorOffsetMs = 0
let audioOutputDevices = []
let editorApp = null
let audioBasePath = 'audio/'

function resolveDeviceId(label) {
    if (!label) return null
    const found = audioOutputDevices.find(d => d.label === label)
    return found ? found.deviceId : null
}

function monitorShouldPlay() {
    if (!monitorAudioDevice) return false
    if (monitorAudioDevice === mainAudioDevice) return false
    return true
}

let scriptText = ''

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
    const headings = [...document.querySelectorAll('#script-content h2, #script-content h3')]
    // Temporarily un-sticky all headings so getBoundingClientRect reflects natural positions
    headings.forEach(h => { h.style.position = 'static' })
    const tops = headings.map(h => h.getBoundingClientRect().top + window.scrollY)
    headings.forEach(h => { h.style.position = '' })
    headings.forEach((h, idx) => {
        const btn = document.createElement('button')
        const isSub = h.tagName === 'H3'
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
    const headings = [...document.querySelectorAll('#script-content h2, #script-content h3')]
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

// Append parsed dialogue text (with inline stage direction coloring) to parent element.
// Recognizes both *(text)* (markdown) and plain (text) (user-typed, auto-converted on save).
function appendDialogueParsed(parent, text, roleColor) {
    const re = /\*\(([^)]+)\)\*|\(([^)]+)\)/g
    let last = 0, m
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
            const s = document.createElement('span')
            s.className = 'editor-role-text'
            if (roleColor) s.style.color = roleColor
            s.textContent = text.slice(last, m.index)
            parent.appendChild(s)
        }
        const inner = m[1] ?? m[2]
        const s = document.createElement('span')
        s.className = 'editor-stage-inline'
        s.textContent = '(' + inner + ')'
        parent.appendChild(s)
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
    const dialogue = afterName.map(n => {
        if (n.nodeType === Node.TEXT_NODE) return n.textContent
        if (n.classList?.contains('editor-stage-inline')) {
            const t = n.textContent
            return (t.startsWith('(') && t.endsWith(')')) ? '*' + t + '*' : t
        }
        return n.textContent
    }).join('')
    afterName.forEach(n => n.remove())
    appendDialogueParsed(div, dialogue, roleColor)
    setCaretOffset(div, caretOffset)
}

// Split dialogue text at sentence boundaries so each sentence starts on its own line
function wrapSentences(text) {
    return text.replace(/([.!?])[ \t]+(?=[A-ZÄÖÜ"])/g, '$1\n')
}

// Convert styled contenteditable HTML back to markdown
function serializeEditorMarkdown(div) {
    function textOf(node) {
        let t = ''
        for (const c of node.childNodes) {
            if (c.nodeType === Node.TEXT_NODE) t += c.textContent
            else if (c.tagName === 'BR') t += '\n'
            else t += textOf(c)
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
                if (node.nodeType === Node.TEXT_NODE) dialogueParts.push(node.textContent)
                else if (node.tagName === 'BR') dialogueParts.push('\n')
                else if (node.classList?.contains('editor-stage-inline')) dialogueParts.push('*' + node.textContent + '*')
                else dialogueParts.push(textOf(node))
            }
        }
        const dialogue = wrapSentences(dialogueParts.join('').trim())
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
            text += node.textContent
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
    const dialogue = afterRole.map(n => {
        if (n.classList?.contains('ac-ghost')) return ''
        if (n.nodeType === Node.TEXT_NODE) return n.textContent
        if (n.classList?.contains('editor-stage-inline')) {
            const t = n.textContent
            return (t.startsWith('(') && t.endsWith(')')) ? '*' + t + '*' : t
        }
        return n.textContent
    }).join('')
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
        const dialogue = getDialogue(el).trim()
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
    if (e.key === 'Shift') {
        shiftHeld = true
        document.body.classList.add('shift-held')
        document.querySelectorAll('.trigger-action-btn-auto').forEach(btn => {
            updateAutoBtnAppearance(btn, parseInt(btn._triggerIndex))
        })
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
                else if (!monAudioEl.paused) monAudioEl.pause()
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
    loopOutroPending.clear()
    loopBtns.clear()

    validateYamlBlocks(newText)
    document.getElementById('script-content').innerHTML = converter.makeHtml(newText)
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
    })
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function validateYamlBlocks(text) {
    parseErrors = []
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
    if (!parseErrors.length) return
    const banner = document.createElement('div')
    banner.id = 'parse-error-banner'
    banner.className = 'parse-error-banner'
    const items = parseErrors.map(({ blockNum, line, message }) => {
        const loc = blockNum != null
            ? `Block ${blockNum}${line != null ? `, Zeile ${line}` : ''}`
            : ''
        return `<li>${loc ? loc + ': ' : ''}${escapeHtml(message)}</li>`
    }).join('')
    banner.innerHTML = `<button class="parse-error-close" onclick="this.parentElement.remove()">×</button>
<strong>${parseErrors.length} YAML-Fehler</strong><ul>${items}</ul>`
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

    // ── Light toggle ────────────────────────────────────────────────────────
    const lightBtn = document.createElement('button')
    lightBtn.classList.add('trigger-action-btn')
    if (codeblockYaml.light) lightBtn.classList.add('trigger-action-btn-active')
    lightBtn.textContent = '✦ Licht'
    lightBtn.title = codeblockYaml.light
        ? 'Licht-Cue: Back stellt Licht wieder her – klicken zum Deaktivieren'
        : 'Als Licht-Cue markieren (Back-Taste stellt Licht wieder her)'
    lightBtn.addEventListener('mousedown', e => e.stopPropagation())
    lightBtn.addEventListener('click', e => {
        e.stopPropagation()
        const newVal = !triggerYamls[index]?.light
        setLightInScript(index, newVal)
        lightBtn.classList.toggle('trigger-action-btn-active', newVal)
        lightBtn.title = newVal
            ? 'Licht-Cue: Back stellt Licht wieder her – klicken zum Deaktivieren'
            : 'Als Licht-Cue markieren (Back-Taste stellt Licht wieder her)'
    })
    triggerActions.appendChild(lightBtn)

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
        ws.load(audioBasePath + musicFile)
        ws.setVolume(mp.volume)

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

        ws.on("ready",  () => { waveformContainer.appendChild(overlay); updateMarkers(); autoMarkerState.refresh?.() })
        ws.on("scroll", () => { updateMarkers(); autoMarkerState.refresh?.() })
        ws.on("zoom",   () => { updateMarkers(); autoMarkerState.refresh?.() })
        ws.on("redraw", () => { updateMarkers(); autoMarkerState.refresh?.() })

        // ── Playback: fade + stop-at-end + loop ─────────────────────────
        let chainEndArmed = false
        ws.on("timeupdate", (ct) => {
            const effEnd = mp.end ?? ws.getDuration()
            if (ct >= effEnd) {
                const isManaged = !!triggerYamls[index]?.loop_outro
                if (isManaged) {
                    if (loopOutroPending.has(index)) {
                        // Outro pending → fire it at this loop boundary
                        const outroIdx = loopOutroPending.get(index)
                        loopOutroPending.delete(index)
                        setOutroPendingIndicator(outroIdx, false)
                        ws.stop()
                        ws.setVolume(currentVolume)
                        currentCue = outroIdx
                        markTriggers(outroIdx)
                        triggerAction(outroIdx)
                    } else {
                        ws.play(mp.start)   // next loop iteration
                    }
                } else if (mp.loop) {
                    ws.play(mp.start)
                } else {
                    ws.stop()
                    if (mtc && mtc.activeTcIndex === index) mtc.stopAndClear()
                    // chain_end: fire next trigger seamlessly on audio end
                    const chainEnd = triggerYamls[index]?.chain_end
                    if (chainEnd && !chainEndArmed) {
                        chainEndArmed = true
                        const nextIdx = findTriggerByNote(chainEnd)
                        if (nextIdx !== null) {
                            currentCue = nextIdx
                            markTriggers(nextIdx)
                            scrollToTrigger(nextIdx)
                            triggerAction(nextIdx)
                        }
                    }
                }
                ws.setVolume(currentVolume); return
            }
            let f = 1
            const t = ct - mp.start
            if (mp.fadein  > 0 && t >= 0 && t < mp.fadein)            f = t / mp.fadein
            if (mp.fadeout > 0 && (effEnd - ct) < mp.fadeout) f = Math.min(f, (effEnd - ct) / mp.fadeout)
            ws.setVolume(Math.max(0, currentVolume * f))
        })

        ws.on("error",  (e) => console.error("WaveSurfer:", musicFile, e))
        ws.on("play",   () => { pauseBtn.textContent = "⏸"; chainEndArmed = false })
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
                } else {
                    currentCue = index; markTriggers(index); triggerAction(index)
                }
            }
            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })

        // ── Monitor mix ─────────────────────────────────────────────────
        const monitorFile = typeof codeblockYaml.music === 'object' ? codeblockYaml.music.monitor ?? null : null

        let monAudioEl = null, wsMonitor = null
        let monSyncRaf = null

        if (monitorFile !== null && monitorShouldPlay()) {
            // ── Path A: explicit monitor file — WaveSurfer + sync loop ────
            monAudioEl = new Audio()
            monAudioEl.setSinkId(monitorAudioDevice).catch(() => {})
            const monContainer = document.createElement('div')
            monContainer.style.cssText = 'position:absolute;height:0;overflow:hidden;opacity:0;pointer-events:none'
            triggerDiv.appendChild(monContainer)
            wsMonitor = WaveSurfer.create({
                container: monContainer, media: monAudioEl,
                height: 0, interact: false, normalize: true, minPxPerSec: 1,
            })
            wsMonitor.load(audioBasePath + monitorFile)
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

        } else if (monitorFile === null && monitorShouldPlay()) {
            // ── Path B: same file as main — plain Audio mirror ────────────
            // No WaveSurfer wrapper and no sync loop needed: same file means
            // both players stay in sync naturally. Preload the file so the
            // browser has the audio ready before the user clicks.
            monAudioEl = new Audio()
            monAudioEl.src = 'audio/' + musicFile
            monAudioEl.preload = 'auto'
            monAudioEl.volume = mp.volume
            monAudioEl.setSinkId(monitorAudioDevice).catch(() => {})
            // Pre-seek to start position once loadable so first click is instant
            const monStart = mp.start ?? 0
            if (monStart > 0) {
                monAudioEl.addEventListener('canplay', () => {
                    monAudioEl.currentTime = monStart
                }, { once: true })
            }
            ws.on('play', () => {
                if (!monitorShouldPlay() || !monAudioEl.paused) return
                monAudioEl.play().catch(() => {})
            })
            ws.on('pause', () => {
                if (!monAudioEl.paused) monAudioEl.pause()
            })
            ws.on('seeking', (t) => {
                if (monitorShouldPlay()) monAudioEl.currentTime = t
            })
        }

        // ── Common patches ────────────────────────────────────────────────
        const _wsSetVol = ws.setVolume.bind(ws)
        ws.setVolume = (v) => {
            _wsSetVol(v)
            if (wsMonitor) wsMonitor.setVolume(v)
            else if (monAudioEl) monAudioEl.volume = v
        }
        const _wsStop = ws.stop.bind(ws)
        ws.stop = () => {
            if (monSyncRaf) { cancelAnimationFrame(monSyncRaf); monSyncRaf = null }
            if (monAudioEl && !monAudioEl.paused) monAudioEl.pause()
            // Reset to the correct start position so next click needs no seek
            if (monAudioEl) monAudioEl.currentTime = monitorFile === null ? (mp.start ?? 0) : 0
            _wsStop()
        }

        triggerAudio.set(index, { ws, wsMonitor, mainAudioEl, monAudioEl, musicFile, overlay, getX, autoMarkerState })
        fileToTriggers.set(musicFile, [...(fileToTriggers.get(musicFile) || []), index])
    }

    triggerYamls[index] = codeblockYaml

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
        btn.textContent = '✕ Loop'
        btn.classList.remove('trigger-action-btn-active')
        btn.classList.add('trigger-action-btn-danger')
        btn.title = 'Loop-Verbindung löschen (Shift+Klick)'
        return
    }
    btn.classList.remove('trigger-action-btn-danger')
    btn.classList.add('trigger-action-btn-active')

    if (hasCE && isOutro) {
        // Zwischenteil: outro of one loop + transition into next loop
        const ce = `${ty.chain_end.ch}.${ty.chain_end.note}`
        const from = sources.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
        btn.textContent = `⟲ → ${ce}`
        btn.title = `Zwischenteil: Ausgang von Schleife(n) ${from}, startet am Ende Trigger ${ce}`
    } else if (hasCE) {
        const ce = `${ty.chain_end.ch}.${ty.chain_end.note}`
        btn.textContent = `→ ${ce}`
        btn.title = `Übergang: startet am Ende automatisch Trigger ${ce}`
    } else if (hasLO) {
        const lo = `${ty.loop_outro.ch}.${ty.loop_outro.note}`
        btn.textContent = `⟲ → ${lo}`
        btn.title = `Schleife: loopt bis Trigger ${lo} am Schleifen-Ende angeklickt wurde`
    } else if (isOutro) {
        const from = sources.map(i => { const tn = triggerYamls[i]?.trigger_note; return tn ? `${tn.ch}.${tn.note}` : '?' }).join(', ')
        btn.textContent = '⟲ Outro'
        btn.title = `Outro: wird am Schleifen-Ende von Schleife(n) ${from} nahtlos gestartet`
    } else {
        btn.textContent = '⟲ Loop'
        btn.classList.remove('trigger-action-btn-active')
        btn.title = 'Loop-Struktur einrichten (Übergang, Schleife …)'
    }
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
    for (const [idx, btn] of loopBtns) updateLoopBtnAppearance(btn, idx)
}

function setLightInScript(triggerIndex, value) {
    let blockIdx = 0
    const updated = scriptText.replace(/```yaml\n([\s\S]*?)```/g, (match, content) => {
        blockIdx++
        if (blockIdx !== triggerIndex + 1) return match
        let c = content.replace(/^light:[ \t]*[^\n]*\n?/m, '').replace(/\n{3,}/g, '\n\n')
        if (value) c = c.trimEnd() + '\nlight: true\n'
        return '```yaml\n' + c + '```'
    })
    scriptText = updated
    window.electronAPI.writeScriptMd(updated)
    if (triggerYamls[triggerIndex]) {
        if (value) triggerYamls[triggerIndex].light = true
        else delete triggerYamls[triggerIndex].light
    }
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
            setOutroPendingIndicator(cue, false)
        } else {
            loopOutroPending.set(i, cue)
            setOutroPendingIndicator(cue, true)
        }
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

    cueHistory.push(cue)
    broadcastLiveState()
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

    // Next cue to fire
    let nextCue = null
    for (let i = currentCue + 1; i < triggerYamls.length; i++) {
        if (triggerYamls[i]) { nextCue = i; break }
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

            liveBlocks.push({
                type: 'trigger',
                cueIdx,
                isCurrent: cueIdx === currentCue,
                isNext: cueIdx === nextCue,
                isPlaying: triggerAudio.get(cueIdx)?.ws.isPlaying() ?? false,
                micColors,
                muteall: ty.mic === 'muteall',
                musicLabel,
                note: ty.note || null,
                light: !!ty.light,
            })
        } else {
            liveBlocks.push({
                type: 'text',
                html: applyRoleColorsToHtml(converter.makeHtml(b.content)),
            })
        }
    }

    // Audio progress for all playing cues
    const audioProgress = []
    for (const [cueIdx, ta] of triggerAudio) {
        if (!ta.ws.isPlaying()) continue
        const ty = triggerYamls[cueIdx]
        audioProgress.push({
            cueIdx,
            label: (typeof ty?.music === 'string' ? ty.music : ty?.music?.file) || ('Cue ' + cueIdx),
            currentTime: ta.mainAudioEl?.currentTime ?? 0,
            duration: ta.ws.getDuration() ?? 0,
        })
    }

    const tcEl = document.querySelector('.tc-display')
    window.electronAPI.sendLiveState({
        blocks: liveBlocks,
        currentCue,
        nextCue,
        timecode: tcEl ? tcEl.textContent.trim() : '',
        audioProgress,
    })
}

function goAction() {
    for (let i = currentCue + 1; i < triggerYamls.length; i++) {
        if (!triggerYamls[i]) continue
        currentCue = i
        markTriggers(i)
        triggerAction(i)
        return
    }
}

function backAction() {
    if (cueHistory.length < 1) return
    const last = cueHistory.pop()
    const prev = cueHistory.length > 0 ? cueHistory[cueHistory.length - 1] : null

    if (prev !== null) {
        // Re-apply mic state for the cue before the accidental one
        x32UnmuteChannels(triggerYamls[prev]?.mic)
        // If the accidental cue was a light cue, re-send the previous cue's trigger note
        if (triggerYamls[last]?.light) sendTriggerNote(prev)
        currentCue = prev
        markTriggers(prev)
    } else {
        // No previous cue: just mute all mics
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

        const hasExplicitMonitor = typeof music === 'object' && music.monitor != null
        const useMonitor = monitorShouldPlay() && ta.wsMonitor && ta.wsMonitor.getDuration() > 0
        if (useMonitor && hasExplicitMonitor) {
            // Explicit monitor file (e.g. a song with a separate mix):
            // seek both elements in parallel, then fire play() simultaneously.
            const monDur = ta.wsMonitor.getDuration()
            const monTargetT = Math.min(Math.max(start - monitorOffsetMs / 1000, 0), monDur)
            const seekReady = (el, t) => new Promise(resolve => {
                el.currentTime = t
                if (!el.seeking) { resolve(); return }
                const guard = setTimeout(resolve, 2000)
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
            // Same-file monitor or no monitor: play immediately via WaveSurfer.
            // monAudioEl is pre-seeked at load time, so the sync loop fires
            // play() in the same event-handler tick as the main play event.
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
    document.querySelector(".em-music").addEventListener("mousedown", stopall)
    document.querySelector(".em-mic").addEventListener("mousedown", () => x32UnmuteChannels("muteall"))
    document.querySelector(".current-trigger-button").addEventListener("mousedown", () => scrollToTrigger(currentCue))
    document.querySelector(".reload-button").addEventListener("mousedown", () => location.reload())
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
    const date = new Date()
    const h = date.getHours() > 9 ? date.getHours().toString() : "0" + date.getHours().toString()
    const m = date.getMinutes() > 9 ? date.getMinutes().toString() : "0" + date.getMinutes().toString()
    const s = date.getSeconds() > 9 ? date.getSeconds().toString() : "0" + date.getSeconds().toString()
    clock.innerText = `${h}:${m}:${s}`
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

    mainAudioDevice    = resolveDeviceId(savedSettings.mainAudioDevice)
    monitorAudioDevice = resolveDeviceId(savedSettings.monitorAudioDevice)
    monitorOffsetMs    = savedSettings.monitorOffsetMs ?? 0
    editorApp          = savedSettings.editorApp || null

    let text = await window.electronAPI.getScriptMd()

    const { text: modifiedText, changed } = assignTriggerNotes(text)
    if (changed) {
        await window.electronAPI.writeScriptMd(modifiedText)
        text = modifiedText
    }

    // Show current file name in title bar
    const scriptPath = await window.electronAPI.getScriptPath()
    document.title = scriptPath.split(/[\\/]/).pop()
    const scriptDir = scriptPath.substring(0, scriptPath.lastIndexOf('/'))
    audioBasePath = encodeURI('file://' + scriptDir + '/audio/')

    validateYamlBlocks(text)
    scriptText = text
    document.getElementById('script-content').innerHTML = converter.makeHtml(text)
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
        navigator.mediaDevices.enumerateDevices().then(devs => {
            audioOutputDevices = devs.filter(d => d.kind === 'audiooutput')
            mainAudioDevice    = resolveDeviceId(newSettings.mainAudioDevice)
            monitorAudioDevice = resolveDeviceId(newSettings.monitorAudioDevice)
            monitorOffsetMs    = newSettings.monitorOffsetMs ?? 0
            editorApp          = newSettings.editorApp || null
            applyAudioDevices()
        }).catch(() => {
            mainAudioDevice    = resolveDeviceId(newSettings.mainAudioDevice)
            monitorAudioDevice = resolveDeviceId(newSettings.monitorAudioDevice)
            monitorOffsetMs    = newSettings.monitorOffsetMs ?? 0
            editorApp          = newSettings.editorApp || null
            applyAudioDevices()
        })
    })

    window.electronAPI.onLiveGo(() => goAction())
    window.electronAPI.onLiveBack(() => backAction())

    broadcastLiveState()
}

initApp().catch(e => console.error('initApp Fehler:', e))

updateClock()
setInterval(() => {
    updateClock()
    broadcastLiveState()
}, 1000)
