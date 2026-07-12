
        const clockEl    = document.getElementById('live-clock')
        const tcEl       = document.getElementById('live-tc')
        const infoBarEl  = document.getElementById('live-info-bar')
        const presenceEl = document.getElementById('live-display-presence')
        const blocksEl   = document.getElementById('script-blocks')
        let liveTextZoom = 1   // loaded from device prefs (editor-prefs.json) below
        function applyLiveZoom() {
            blocksEl.style.zoom = liveTextZoom === 1 ? '' : String(liveTextZoom)
        }
        function setLiveZoom(value) {
            liveTextZoom = Math.round(Math.max(0.5, Math.min(2.0, value)) * 10) / 10
            window.electronAPI.saveEditorPrefs?.({ liveTextZoom })
            applyLiveZoom()
        }
        function changeLiveZoom(delta) {
            setLiveZoom(liveTextZoom + delta)
        }
        window.electronAPI.getSettings?.().then(s => {
            liveTextZoom = parseFloat(s?.liveTextZoom) || 1
            applyLiveZoom()
        }).catch(() => {})
        const scrollEl   = document.getElementById('script-scroll')
        const audioPanEl = document.getElementById('audio-panel')
        const btnGo      = document.getElementById('btn-go')
        const btnBack    = document.getElementById('btn-back')

        const MIC_SVG  = `<svg class="t-icon" viewBox="0 0 12 18" width="10" height="15" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="3" y="0.5" width="6" height="9" rx="3"/><line x1="3.5" y1="3.5" x2="8.5" y2="3.5" stroke-width="0.55"/><line x1="3.5" y1="6" x2="8.5" y2="6" stroke-width="0.55"/><path d="M1 8 Q6 13.5 11 8"/><line x1="6" y1="11.5" x2="6" y2="15"/><line x1="3" y1="15" x2="9" y2="15"/></svg>`
        const TAPE_SVG = `<svg class="t-icon" viewBox="0 0 22 12" width="22" height="12" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><circle cx="5" cy="6" r="4"/><circle cx="5" cy="6" r="1.3"/><line x1="5" y1="2" x2="5" y2="4.7"/><line x1="1.5" y1="8" x2="3.9" y2="6.7"/><line x1="8.5" y1="8" x2="6.1" y2="6.7"/><circle cx="17" cy="6" r="4"/><circle cx="17" cy="6" r="1.3"/><line x1="17" y1="2" x2="17" y2="4.7"/><line x1="13.5" y1="8" x2="15.9" y2="6.7"/><line x1="20.5" y1="8" x2="18.1" y2="6.7"/><line x1="9" y1="2" x2="13" y2="2"/><line x1="9" y1="10" x2="13" y2="10"/></svg>`

        // ── Clock (aligned to second boundary, same as main view) ───────
        function updateClock() {
            const d = new Date()
            const p = n => n.toString().padStart(2, '0')
            clockEl.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
        }
        function scheduleClockTick() {
            updateClock()
            setTimeout(scheduleClockTick, 1000 - (Date.now() % 1000))
        }
        updateClock()
        setTimeout(scheduleClockTick, 1000 - (Date.now() % 1000))

        // ── Helpers ──────────────────────────────────────────────────────
        function esc(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        }
        function safeColor(c) { return /^#[0-9a-f]{3,8}$/i.test(c) ? c : '' }
        // First markdown heading (else first non-empty line), cropped to 20 chars with an ellipsis.
        function displayChipLabel(markdown) {
            const lines = String(markdown || '').split('\n')
            let label = ''
            for (const line of lines) { const h = line.match(/^\s*#{1,6}\s+(.*\S)/); if (h) { label = h[1].trim(); break } }
            if (!label) { for (const line of lines) { const s = line.trim(); if (s) { label = s; break } } }
            label = label.replace(/[#*_`>-]/g, '').trim()
            return label.length > 20 ? label.slice(0, 20) + '…' : label
        }

        let _deviceColors = {}
        let _knownMidiDevices = new Set()
        let _knownOscDevices  = new Set()
        function fmt(s) {
            s = Math.max(0, s | 0)
            return `${s / 60 | 0}:${(s % 60).toString().padStart(2,'0')}`
        }

        // ── Group consecutive sibling triggers ───────────────────────────
        function groupBlocks(blocks) {
            const out = []
            for (const b of blocks) {
                if (b.type === 'trigger' && b.isSibling && out.length > 0) {
                    const prev = out[out.length - 1]
                    if (prev.type === 'trigger-group') {
                        prev.variants.push(b)
                        prev.isNext    = prev.isNext    || b.isNext
                        prev.isCurrent = prev.isCurrent || b.isCurrent
                    } else if (prev.type === 'trigger') {
                        out[out.length - 1] = {
                            type: 'trigger-group',
                            variants: [prev, b],
                            isNext: prev.isNext || b.isNext,
                            isCurrent: prev.isCurrent || b.isCurrent,
                        }
                    }
                } else {
                    out.push(b)
                }
            }
            return out
        }

        // ── Trigger card HTML ────────────────────────────────────────────
        function safeColorClass(c) { return c && /^[a-zA-Z0-9-]+$/.test(c) ? ' color-' + c : '' }
        function buildTriggerHtml(b) {
            let micRow = ''
            if (b.muteall) {
                micRow = `<div class="trigger-mic">${MIC_SVG} <span class="mic-all-off">${window.t ? window.t('mic.muteall') : 'alle aus'}</span></div>`
            } else if (b.micColors && b.micColors.length) {
                let inner = ''
                for (const item of b.micColors) {
                    if (item.isGroup) {
                        const nameHtml = `<span class="mic-group-name${safeColorClass(item.color)}">${esc(item.name)}</span>`
                        const membersHtml = (item.members || []).map(m =>
                            `<span class="mic-chip${safeColorClass(m.color)}">${esc(m.name)}</span>`
                        ).join('')
                        inner += `<span class="mic-group">${nameHtml}${membersHtml}</span> `
                    } else {
                        inner += `<span class="mic-chip${safeColorClass(item.color)}">${esc(item.name)}</span> `
                    }
                }
                micRow = `<div class="trigger-mic">${MIC_SVG} ${inner}</div>`
            }
            let musicRow = ''
            if (b.musicLabel || b.musicAdjust) {
                let inner = TAPE_SVG
                if (b.musicLabel) inner += ' ' + esc(b.musicLabel)
                if (b.musicAdjust) inner += ` <span style="opacity:0.6">${esc(b.musicAdjust)}</span>`
                musicRow = `<div class="trigger-music">${inner}</div>`
            }
            const lightRow = b.lightScene
                ? `<div class="trigger-light">✦ ${esc(b.lightScene)}</div>` : ''
            const oscRow = b.oscPath
                ? `<div class="trigger-osc">⌁ ${esc(b.oscPath)}${b.oscArg !== null ? ' ' + esc(b.oscArg) : ''}</div>` : ''
            let cueMidiRow = ''
            if (b.cueMidi?.length) {
                const chips = b.cueMidi.map(msg => {
                    let text
                    if (msg.comment) { text = esc(msg.comment) }
                    else if (msg.type === 'note')  { text = `N${esc(String(msg.note))}` }
                    else if (msg.type === 'cc')    { text = `CC${esc(String(msg.cc))}=${esc(String(msg.value))}` }
                    else if (msg.type === 'pc')    { text = `PC${esc(String(msg.program))}` }
                    else                           { text = 'SysEx' }
                    const devName = msg.device || ''
                    const devColor = safeColor(_deviceColors['midi:' + devName] || '')
                    const chipStyle = devColor ? ` style="border-color:${devColor}55;background:${devColor}12"` : ''
                    const badgeStyle = devColor ? ` style="background:${devColor}30;color:${devColor}"` : ''
                    const unknown = devName && !_knownMidiDevices.has(devName)
                    const badgeLabel = (unknown ? '! ' : '') + (esc(devName) || 'MIDI')
                    return `<span class="cue-msg-chip cue-msg-chip--midi${unknown ? ' cue-msg-chip--unknown' : ''}"${chipStyle}><span class="cue-type-badge"${badgeStyle}>${badgeLabel}</span><span class="cue-msg-content">${text}</span></span>`
                }).join('')
                cueMidiRow = `<div class="trigger-cue-midi">${chips}</div>`
            }
            let cueOscRow = ''
            if (b.cueOsc?.length) {
                const chips = b.cueOsc.map(msg => {
                    let text
                    if (msg.comment) { text = esc(msg.comment) }
                    else { text = `${esc(msg.path || '')}${msg.arg !== undefined && msg.arg !== '' ? ' ' + esc(String(msg.arg)) : ''}` }
                    const devName = msg.device || ''
                    const devColor = safeColor(_deviceColors['osc:' + devName] || '')
                    const chipStyle = devColor ? ` style="border-color:${devColor}55;background:${devColor}12"` : ''
                    const badgeStyle = devColor ? ` style="background:${devColor}30;color:${devColor}"` : ''
                    const unknown = devName && !_knownOscDevices.has(devName)
                    const badgeLabel = (unknown ? '! ' : '') + (esc(devName) || 'OSC')
                    return `<span class="cue-msg-chip cue-msg-chip--osc${unknown ? ' cue-msg-chip--unknown' : ''}"${chipStyle}><span class="cue-type-badge"${badgeStyle}>${badgeLabel}</span><span class="cue-msg-content">${text}</span></span>`
                }).join('')
                cueOscRow = `<div class="trigger-cue-osc">${chips}</div>`
            }
            let cueDisplayRow = ''
            if (b.cueDisplay?.length) {
                const chips = b.cueDisplay.map(msg => {
                    const devName = msg.device || ''
                    const devColor = safeColor(_deviceColors['display:' + devName] || '')
                    const chipStyle = devColor ? ` style="border-color:${devColor}55;background:${devColor}12"` : ''
                    const badgeStyle = devColor ? ` style="background:${devColor}30;color:${devColor}"` : ''
                    const badgeLabel = esc(devName) || 'Display'
                    let dispLabel = displayChipLabel(msg.markdown)
                    if (msg.announce) dispLabel = '🔊 ' + (dispLabel || displayChipLabel(msg.announce))
                    else if (!dispLabel) dispLabel = '🧹 leeren'
                    return `<span class="cue-msg-chip cue-msg-chip--osc"${chipStyle}><span class="cue-type-badge"${badgeStyle}>${badgeLabel}</span><span class="cue-msg-content">${esc(dispLabel)}</span></span>`
                }).join('')
                cueDisplayRow = `<div class="trigger-cue-osc">${chips}</div>`
            }
            const slfRow = b.slfLabel
                ? `<div class="trigger-slf trigger-slf--${b.slfLabel.role.toLowerCase()}">${esc(b.slfLabel.role)} <span style="opacity:0.65;font-weight:normal">${esc(b.slfLabel.detail)}</span></div>` : ''
            const playDot = b.isPlaying
                ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#98c379;box-shadow:0 0 8px #98c37988;animation:pulse 1.2s ease-in-out infinite"></span>` : ''
            const tnLabel = b.triggerNoteLabel
                ? `<span style="font-size:0.9rem;color:#5c6370;font-variant-numeric:tabular-nums">${esc(b.triggerNoteLabel)}</span>` : ''
            const outroPendingBar = b.outroPending
                ? `<div class="outro-pending-bar-wrap"><div class="outro-pending-bar-fill" style="width:0%"></div></div>`
                : ''
            const autoCuePendingBar = b.autoCuePending
                ? (() => {
                    const ac = b.autoCuePending, base = ac.base ?? 0, denom = ac.at - base
                    const pct = denom > 0 ? Math.min(100, Math.max(0, (ac.currentTime - base) / denom * 100)) : 0
                    return `<div class="autocue-pending-bar-wrap"><div class="autocue-pending-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`
                })()
                : ''
            return `
                <div class="trigger-row">
                    <div class="trigger-info">
                        ${micRow}${musicRow}${lightRow}${oscRow}${cueMidiRow}${cueOscRow}${cueDisplayRow}${slfRow}
                    </div>
                    ${b.note ? `<div class="trigger-note">${esc(b.note)}</div>` : ''}
                    <div style="display:flex;align-items:center;gap:0.5rem;padding-right:0.5rem">${tnLabel}${playDot}</div>
                </div>
                ${outroPendingBar}${autoCuePendingBar}
            `
        }

        // ── Script render ────────────────────────────────────────────────
        let lastCurrentCue = null
        let localSelectedVariant = null

        function centerNextTrigger(animate = true) {
            const anchor = document.getElementById('scroll-anchor')
            if (!anchor) return
            const containerHeight = scrollEl.clientHeight
            const y = Math.round(containerHeight * 0.65 - anchor.offsetTop - anchor.offsetHeight / 2)
            if (!animate) blocksEl.style.transition = 'none'
            blocksEl.style.transform = `translateY(${y}px)`
            if (!animate) requestAnimationFrame(() => { blocksEl.style.transition = '' })
        }

        function renderScript(blocks, nextCue, currentCue, selectedVariant, nextCueIsManual) {
            localSelectedVariant = selectedVariant ?? null
            const grouped = groupBlocks(blocks)
            const frag = document.createDocumentFragment()

            outroPendingBars.clear()
            autoCuePendingBars.clear()

            for (const b of grouped) {
                const wrap = document.createElement('div')

                if (b.type === 'trigger-group') {
                    if (b.isNext) { wrap.className = 'live-block-next'; wrap.id = 'scroll-anchor' }
                    else if (b.isCurrent) { wrap.className = 'live-block-current' }

                    const hasSelection = localSelectedVariant !== null
                        && b.variants.some(v => v.cueIdx === localSelectedVariant)

                    const groupRow = document.createElement('div')
                    groupRow.className = 'live-variant-group' + (b.isNext && !hasSelection ? ' needs-selection' : '')
                    for (const v of b.variants) {
                        const card = document.createElement('div')
                        card.className = 'trigger'
                        if (v.cueIdx === localSelectedVariant) card.classList.add('variant-selected')
                        card.dataset.cueIdx = v.cueIdx
                        card.innerHTML = buildTriggerHtml(v)
                        if (v.outroPending) {
                            const fill = card.querySelector('.outro-pending-bar-fill')
                            if (fill) outroPendingBars.set(v.cueIdx, { fillEl: fill, item: { ...v.outroPending, receivedAt: performance.now() } })
                        }
                        if (v.autoCuePending) {
                            const fill = card.querySelector('.autocue-pending-bar-fill')
                            if (fill) autoCuePendingBars.set(v.cueIdx, { fillEl: fill, item: { ...v.autoCuePending, receivedAt: performance.now() } })
                        }
                        groupRow.appendChild(card)
                    }
                    wrap.appendChild(groupRow)

                } else if (b.type === 'trigger') {
                    if (b.isNext) { wrap.className = 'live-block-next'; wrap.id = 'scroll-anchor' }
                    else if (b.isCurrent) { wrap.className = 'live-block-current' }

                    const card = document.createElement('div')
                    card.className = 'trigger'
                    card.innerHTML = buildTriggerHtml(b)
                    if (b.outroPending) {
                        const fill = card.querySelector('.outro-pending-bar-fill')
                        if (fill) outroPendingBars.set(b.cueIdx, { fillEl: fill, item: { ...b.outroPending, receivedAt: performance.now() } })
                    }
                    if (b.autoCuePending) {
                        const fill = card.querySelector('.autocue-pending-bar-fill')
                        if (fill) autoCuePendingBars.set(b.cueIdx, { fillEl: fill, item: { ...b.autoCuePending, receivedAt: performance.now() } })
                    }
                    wrap.appendChild(card)
                } else {
                    const inner = document.createElement('div')
                    inner.className = 'live-text'
                    inner.innerHTML = b.html
                    wrap.appendChild(inner)
                }
                frag.appendChild(wrap)
            }

            blocksEl.innerHTML = ''
            blocksEl.appendChild(frag)
            // Keep Go enabled when the focus is on a manual cue — the operator must be
            // able to fire it even while an auto-cue is still counting down elsewhere.
            btnGo.disabled = outroPendingBars.size > 0 || (autoCuePendingBars.size > 0 && !nextCueIsManual)
            // Scroll only when the current cue actually fired — not on every periodic update
            const cueChanged = currentCue !== lastCurrentCue
            lastCurrentCue = currentCue
            requestAnimationFrame(() => centerNextTrigger(cueChanged))
        }

        // Variant click — delegated on blocksEl
        blocksEl.addEventListener('click', e => {
            const card = e.target.closest('.live-variant-group .trigger[data-cue-idx]')
            if (!card) return
            const idx = parseInt(card.dataset.cueIdx)
            window.electronAPI.selectVariant(idx)
        })

        // ── Audio panel (rAF-based smooth update) ────────────────────────
        const audioRows = new Map()
        const outroPendingBars = new Map()
        const autoCuePendingBars = new Map()

        function calcProgress(item) {
            const elapsed = (performance.now() - item.receivedAt) / 1000
            const ct      = item.currentTime + elapsed
            const start   = item.loopStart
            const outroLen = item.outroLen ?? 0
            // Treat the loop as if it ends at effEnd (ignoring the tail).
            const end   = outroLen > 0 ? item.loopEnd - outroLen : item.loopEnd
            const range = end - start

            if (item.isLoop) {
                if (item.inTail) return { pct: 1, remaining: 0 }
                const pos       = range > 0 ? ((ct - start) % range + range) % range : 0
                const pct       = range > 0 ? Math.min(1, pos / range) : 0
                const remaining = range > 0 ? range - pos : 0
                return { pct, remaining }
            } else {
                const pct = range > 0 ? Math.min(1, (ct - start) / range) : 0
                return { pct, remaining: range > 0 ? Math.max(0, end - ct) : 0 }
            }
        }

        let liveFrames = null, liveFramesAt = null

        function framesToStr(total) {
            const fps = 25, ff = total % fps, secs = Math.floor(total / fps)
            const ss = secs % 60, mm = Math.floor(secs / 60) % 60, hh = Math.floor(secs / 3600) % 24
            const p = n => String(n).padStart(2, '0')
            return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
        }

        function rafUpdate() {
            requestAnimationFrame(rafUpdate)
            if (liveFrames !== null) {
                tcEl.textContent = framesToStr(Math.floor(liveFrames + (performance.now() - liveFramesAt) / 1000 * 25))
            }
            for (const { fillEl, timeEl, volFill, item } of audioRows.values()) {
                const { pct, remaining } = calcProgress(item)
                fillEl.style.width = (pct * 100).toFixed(2) + '%'
                if (!item.inTail) { fillEl.style.opacity = ''; fillEl.style.transition = '' }
                timeEl.style.visibility = item.inTail ? 'hidden' : ''
                timeEl.textContent = item.inTail ? timeEl.textContent : '-' + fmt(remaining)
                // Volume bar: absolute volume 0–100 % (default 80 % if unset)
                const volPct = Math.min(100, (item.volume ?? 0.8) * 100)
                volFill.style.width = volPct.toFixed(1) + '%'
                volFill.classList.toggle('low', volPct < 30)
            }
            for (const { fillEl, item } of outroPendingBars.values()) {
                const elapsed = (performance.now() - item.receivedAt) / 1000
                const pct = item.initialRemaining > 0
                    ? Math.min(100, (item.initialRemaining - item.remaining + elapsed) / item.initialRemaining * 100)
                    : 100
                fillEl.style.width = pct.toFixed(1) + '%'
            }
            const _acDone = []
            for (const [_acIdx, { fillEl, item }] of autoCuePendingBars.entries()) {
                const elapsed = (performance.now() - item.receivedAt) / 1000
                const base = item.base ?? 0, denom = item.at - base
                const pct = denom > 0
                    ? Math.min(100, Math.max(0, (item.currentTime + elapsed - base) / denom * 100))
                    : 100
                fillEl.style.width = pct.toFixed(1) + '%'
                if (pct >= 100) _acDone.push(_acIdx)
            }
            for (const k of _acDone) {
                const entry = autoCuePendingBars.get(k)
                if (entry) {
                    const wrap = entry.fillEl.parentElement
                    wrap.style.transition = 'opacity 0.25s'
                    wrap.style.opacity = '0'
                }
                autoCuePendingBars.delete(k)
            }
        }
        requestAnimationFrame(rafUpdate)

        function syncAudio(items) {
            const seen = new Set()
            const now  = performance.now()

            for (const item of items) {
                seen.add(item.cueIdx)
                item.receivedAt = now

                if (audioRows.has(item.cueIdx)) {
                    const row = audioRows.get(item.cueIdx)
                    if (item.inTail && !row.item.inTail && item.tailDuration > 0) {
                        row.fillEl.style.transition = `opacity ${item.tailDuration}s linear`
                        row.fillEl.style.opacity = '0'
                    }
                    row.item = item
                } else {
                    const row = document.createElement('div')
                    row.className = 'audio-row entering'

                    const label = document.createElement('div')
                    label.className = 'audio-label'
                    const labelText = document.createElement('span')
                    labelText.className = 'audio-label-text'
                    labelText.textContent = item.label
                    label.appendChild(labelText)
                    if (item.isLoop) {
                        const badge = document.createElement('span')
                        badge.className = 'audio-loop-badge'
                        badge.textContent = '⟳ Loop'
                        label.appendChild(badge)
                    }

                    const barWrap = document.createElement('div')
                    barWrap.className = 'audio-bar-wrap'
                    const fill = document.createElement('div')
                    fill.className = 'audio-bar-fill' + (item.isLoop ? ' audio-loop-fill' : '')
                    fill.style.width = '0%'
                    barWrap.appendChild(fill)

                    const timeEl = document.createElement('div')
                    timeEl.className = 'audio-time'

                    const volWrap = document.createElement('div')
                    volWrap.className = 'audio-vol-wrap'
                    const volFill = document.createElement('div')
                    volFill.className = 'audio-vol-fill'
                    volFill.style.height = '100%'
                    volWrap.appendChild(volFill)

                    const stopBtn = document.createElement('button')
                    stopBtn.className = 'audio-stop-btn'
                    stopBtn.title = 'Stoppen (0.5s Fadeout)'
                    stopBtn.textContent = '✕'
                    stopBtn.addEventListener('click', () => {
                        window.electronAPI.stopAudio(item.cueIdx)
                    })

                    row.append(label, barWrap, timeEl, volWrap, stopBtn)
                    // Insert in cue order rather than always at the bottom, so an audio that
                    // restarts via Back (e.g. a loop, lower cueIdx than its finish) reappears
                    // at its original position — where it went out — instead of sliding in as
                    // the next item in the list.
                    let beforeEl = null, beforeIdx = Infinity
                    for (const [idx, r] of audioRows) {
                        if (idx > item.cueIdx && idx < beforeIdx) { beforeIdx = idx; beforeEl = r.el }
                    }
                    audioPanEl.insertBefore(row, beforeEl)
                    requestAnimationFrame(() => row.classList.remove('entering'))
                    audioRows.set(item.cueIdx, { el: row, fillEl: fill, timeEl, volFill, item })
                }
            }

            for (const [cueIdx, { el }] of audioRows) {
                if (seen.has(cueIdx)) continue
                audioRows.delete(cueIdx)
                el.classList.add('leaving')
                el.addEventListener('transitionend', () => el.remove(), { once: true })
                setTimeout(() => el.remove(), 400)
            }

            audioPanEl.classList.toggle('has-audio', audioRows.size > 0)
        }

        // ── Info bar: device states + mics ──────────────────────────────
        function updateInfoBar(state) {
            const { effectiveDeviceStates, deviceColors, knownMidiDevices, knownOscDevices, effectiveMuteall, effectiveMicColors, hasMicState } = state
            if (deviceColors) _deviceColors = deviceColors
            if (knownMidiDevices) _knownMidiDevices = new Set(knownMidiDevices)
            if (knownOscDevices)  _knownOscDevices  = new Set(knownOscDevices)
            const hasDevices = Array.isArray(effectiveDeviceStates) && effectiveDeviceStates.length > 0
            const hasMic     = !!hasMicState

            infoBarEl.innerHTML = ''
            infoBarEl.classList.toggle('empty', !hasDevices && !hasMic)

            if (hasDevices) {
                for (const item of effectiveDeviceStates) {
                    const devColor = safeColor(deviceColors?.[item.type + ':' + item.device] || '')
                    const colorStyle = devColor ? ` style="color:${devColor}"` : ''
                    let msgSummary = ''
                    if (item.type === 'display') {
                        msgSummary = esc(item.label || '')
                    } else if (item.type === 'midi') {
                        msgSummary = (item.messages || []).map(m => {
                            if (m.comment) return esc(m.comment)
                            if (m.type === 'note') return `N${m.note}`
                            if (m.type === 'cc')   return `CC${m.cc}=${m.value}`
                            if (m.type === 'pc')   return `PC${m.program}`
                            return 'SysEx'
                        }).join(', ')
                    } else {
                        msgSummary = (item.messages || []).map(m => {
                            if (m.comment) return esc(m.comment)
                            let s = esc(m.path || '')
                            if (m.arg !== undefined && String(m.arg).trim() !== '') s += ' ' + esc(String(m.arg))
                            return s
                        }).join(', ')
                    }
                    const cell = document.createElement('div')
                    cell.className = 'live-info-cell'
                    cell.innerHTML = `<span class="live-info-label"${colorStyle}>${esc(item.device)}</span><span class="live-info-device-state"${colorStyle}>${msgSummary}</span>`
                    infoBarEl.appendChild(cell)
                }
            }

            if (hasMic) {
                const cell = document.createElement('div')
                cell.className = 'live-info-cell'
                const label = document.createElement('span')
                label.className = 'live-info-label'
                label.innerHTML = MIC_SVG
                const micsDiv = document.createElement('div')
                micsDiv.className = 'live-info-mics'
                if (effectiveMuteall) {
                    const s = document.createElement('span')
                    s.className = 'mic-all-off'
                    s.textContent = window.t ? window.t('mic.muteall') : 'alle aus'
                    micsDiv.appendChild(s)
                } else if (effectiveMicColors && effectiveMicColors.length) {
                    for (const item of effectiveMicColors) {
                        if (item.isGroup) {
                            const grpEl = document.createElement('span')
                            grpEl.className = 'mic-group'
                            const grpName = document.createElement('span')
                            grpName.className = 'mic-group-name' + (item.color ? ' color-' + item.color : '')
                            grpName.textContent = item.name
                            grpEl.appendChild(grpName)
                            for (const member of (item.members || [])) {
                                const m = document.createElement('span')
                                m.className = 'mic-chip' + (member.color ? ' color-' + member.color : '')
                                m.textContent = member.name
                                grpEl.appendChild(m)
                            }
                            micsDiv.appendChild(grpEl)
                        } else {
                            const s = document.createElement('span')
                            s.className = 'mic-chip' + (item.color ? ' color-' + item.color : '')
                            s.textContent = item.name
                            micsDiv.appendChild(s)
                        }
                    }
                }
                cell.append(label, micsDiv)
                infoBarEl.appendChild(cell)
            }
        }

        // ── Show progress bar ────────────────────────────────────────────
        const progressBarEl = document.getElementById('show-progress-bar')
        let _pbSegCount = -1
        let _pbPrevCurrent = 0

        function updateProgressBar(data) {
            if (!data || !data.segments || data.segments.length === 0) {
                progressBarEl.classList.add('pb-hidden')
                return
            }
            progressBarEl.classList.remove('pb-hidden')

            // Find active segment (last one where startCue <= current)
            let activeIdx = -1
            for (let i = data.segments.length - 1; i >= 0; i--) {
                if (data.current >= data.segments[i].startCue) { activeIdx = i; break }
            }

            // Determine chapter / sub-chapter label
            let chapterLabel = null, subLabel = null
            if (activeIdx >= 0) {
                const seg = data.segments[activeIdx]
                if (seg.level === 2) {
                    subLabel = seg.label
                    for (let i = activeIdx - 1; i >= 0; i--) {
                        if (data.segments[i].level === 1) { chapterLabel = data.segments[i].label; break }
                    }
                } else {
                    chapterLabel = seg.label
                }
            }

            // Rebuild DOM when segment count changes
            if (_pbSegCount !== data.segments.length) {
                _pbSegCount = data.segments.length
                progressBarEl.innerHTML = ''

                const labelEl = document.createElement('div')
                labelEl.className = 'progress-chapter-text'
                progressBarEl.appendChild(labelEl)

                const segsWrap = document.createElement('div')
                segsWrap.className = 'progress-segs-wrap'
                for (const seg of data.segments) {
                    const segEl = document.createElement('div')
                    segEl.className = 'progress-seg'
                    segEl.style.flex = seg.cueCount
                    if (seg.label) segEl.title = seg.label
                    const fill = document.createElement('div')
                    fill.className = 'progress-fill'
                    segEl.appendChild(fill)
                    segsWrap.appendChild(segEl)
                }
                progressBarEl.appendChild(segsWrap)
            }

            // Update label text
            const labelEl = progressBarEl.querySelector('.progress-chapter-text')
            if (labelEl) {
                labelEl.innerHTML = ''
                if (chapterLabel) {
                    const main = document.createElement('span')
                    main.className = 'progress-chapter-main'
                    main.textContent = chapterLabel
                    labelEl.appendChild(main)
                }
                if (subLabel) {
                    const sub = document.createElement('span')
                    sub.className = 'progress-chapter-sub'
                    sub.textContent = subLabel
                    labelEl.appendChild(sub)
                }
            }

            // Update fill widths — stagger transitions on big jumps for sweep effect
            const isJump = Math.abs(data.current - _pbPrevCurrent) > 2
            _pbPrevCurrent = data.current
            const segEls = progressBarEl.querySelectorAll('.progress-seg')
            for (let i = 0; i < data.segments.length; i++) {
                const seg = data.segments[i]
                const done = Math.max(0, Math.min(seg.cueCount, data.current - seg.startCue + 1))
                const fill = segEls[i].firstChild
                const delay = isJump ? (i * 0.055).toFixed(3) + 's' : '0s'
                fill.style.transition = `width 0.3s ease ${delay}`
                fill.style.width = (done / seg.cueCount * 100).toFixed(2) + '%'
            }
        }

        // ── Main render ──────────────────────────────────────────────────
        function render(state) {
            const { blocks, nextCue, currentCue, nextCueIsManual, selectedVariant, timecodeFrames, audioProgress, appLanguage } = state
            if (appLanguage && appLanguage !== window.appLanguage) window.applyI18n(appLanguage)

            if (timecodeFrames !== null && timecodeFrames !== undefined) {
                liveFrames = timecodeFrames; liveFramesAt = performance.now()
            } else {
                liveFrames = null; tcEl.textContent = '--:--:--:--'
            }

            if (state.deviceColors) _deviceColors = state.deviceColors
            renderScript(blocks, nextCue, currentCue ?? 0, selectedVariant, nextCueIsManual)
            syncAudio(audioProgress || [])
            updateInfoBar(state)
            updateProgressBar(state.showProgress)
            if (state.displayClients) updateDisplayPresence(state.displayClients)
        }

        // ── Display-client presence dots (green = connected, red = lost) ────
        function updateDisplayPresence(clients) {
            if (!presenceEl) return
            presenceEl.innerHTML = ''
            if (!Array.isArray(clients) || clients.length === 0) return
            // Group by configured device name.
            const groups = new Map()
            for (const c of clients) {
                const key = c.deviceName || '—'
                if (!groups.has(key)) groups.set(key, [])
                groups.get(key).push(c)
            }
            let autoIdx = 0
            for (const [devName, list] of groups) {
                const grp = document.createElement('div')
                grp.className = 'dp-group'
                const gn = document.createElement('span')
                gn.className = 'dp-group-name'
                gn.textContent = devName
                grp.appendChild(gn)
                for (const c of list) {
                    autoIdx++
                    const chip = document.createElement('span')
                    chip.className = 'dp-client' + (c.connected ? '' : ' dp-offline')
                    const dot = document.createElement('span')
                    dot.className = 'dp-dot'
                    const label = document.createElement('span')
                    label.textContent = c.name && c.name.trim() ? c.name : ('Client ' + autoIdx)
                    chip.append(dot, label)
                    grp.appendChild(chip)
                }
                presenceEl.appendChild(grp)
            }
        }

        // ── Controls ─────────────────────────────────────────────────────
        btnGo.addEventListener('click', () => {
            try { window.electronAPI.liveGo() } catch(e) { console.error(e) }
        })
        btnBack.addEventListener('click', () => {
            try { window.electronAPI.liveBack() } catch(e) { console.error(e) }
        })
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
                e.preventDefault(); changeLiveZoom(+0.1)
            } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
                e.preventDefault(); changeLiveZoom(-0.1)
            } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
                e.preventDefault(); setLiveZoom(1)
            } else if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                try { window.electronAPI.liveGo() } catch(e) { console.error(e) }
            } else if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
                e.preventDefault()
                try { window.electronAPI.liveBack() } catch(e) { console.error(e) }
            }
        }, { capture: true })

        new ResizeObserver(() => centerNextTrigger(false)).observe(scrollEl)

        window.electronAPI.onLiveState(render)

        // High-frequency volume updates during fades (fired from fade intervals, ~60ms)
        window.electronAPI.onLiveVolumes((volumes) => {
            for (const [cueIdxStr, vol] of Object.entries(volumes)) {
                const row = audioRows.get(parseInt(cueIdxStr))
                if (row) row.item.volume = vol
            }
        })
    