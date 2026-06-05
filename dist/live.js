
        const clockEl    = document.getElementById('live-clock')
        const tcEl       = document.getElementById('live-tc')
        const infoBarEl  = document.getElementById('live-info-bar')
        const blocksEl   = document.getElementById('script-blocks')
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
        function buildTriggerHtml(b) {
            let micRow = ''
            if (b.muteall) {
                micRow = `<div class="trigger-mic">${MIC_SVG} alle aus</div>`
            } else if (b.micColors && b.micColors.length) {
                let spans = ''
                for (const { name, color } of b.micColors)
                    spans += `<span${color ? ` class="color-${color}"` : ''}>${esc(name)}</span> `
                micRow = `<div class="trigger-mic">${MIC_SVG} ${spans}</div>`
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
                ? `<div class="autocue-pending-bar-wrap"><div class="autocue-pending-bar-fill" style="width:${(b.autoCuePending.currentTime / b.autoCuePending.at * 100).toFixed(1)}%"></div></div>`
                : ''
            return `
                <div class="trigger-row">
                    <div class="trigger-info">
                        ${micRow}${musicRow}${lightRow}${oscRow}${slfRow}
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

        function renderScript(blocks, nextCue, currentCue, selectedVariant) {
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
            btnGo.disabled = outroPendingBars.size > 0 || autoCuePendingBars.size > 0
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
            const now     = performance.now()
            const elapsed = (now - item.receivedAt) / 1000
            const ct      = item.currentTime + elapsed
            const start   = item.loopStart
            const end     = item.loopEnd
            const range   = end - start
            if (item.isLoop) {
                const pos = range > 0 ? ((ct - start) % range + range) % range : 0
                const pct = range > 0 ? Math.min(1, pos / range) : 0
                return { pct, remaining: range > 0 ? range - pos : 0 }
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
                timeEl.textContent = '-' + fmt(remaining)
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
            for (const { fillEl, item } of autoCuePendingBars.values()) {
                const elapsed = (performance.now() - item.receivedAt) / 1000
                const pct = item.at > 0
                    ? Math.min(100, (item.currentTime + elapsed) / item.at * 100)
                    : 100
                fillEl.style.width = pct.toFixed(1) + '%'
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
                    audioRows.get(item.cueIdx).item = item
                } else {
                    const row = document.createElement('div')
                    row.className = 'audio-row entering'

                    const label = document.createElement('div')
                    label.className = 'audio-label'
                    label.innerHTML = esc(item.label) + (item.isLoop ? '<span class="audio-loop-badge">⟳ Loop</span>' : '')

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
                    audioPanEl.appendChild(row)
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

        // ── Info bar: effective light scene + mics ───────────────────────
        function updateInfoBar(state) {
            const { effectiveLightScene, effectiveMuteall, effectiveMicColors, hasMicState } = state
            const hasLight = !!effectiveLightScene
            const hasMic   = !!hasMicState

            infoBarEl.innerHTML = ''
            infoBarEl.classList.toggle('empty', !hasLight && !hasMic)

            if (hasLight) {
                const cell = document.createElement('div')
                cell.className = 'live-info-cell'
                cell.innerHTML = `<span class="live-info-label">Licht</span><span class="live-info-light">✦ ${esc(effectiveLightScene)}</span>`
                infoBarEl.appendChild(cell)
            }

            if (hasMic) {
                const cell = document.createElement('div')
                cell.className = 'live-info-cell'
                let micsHtml = `<span class="live-info-label">${MIC_SVG}</span><div class="live-info-mics">`
                if (effectiveMuteall) {
                    micsHtml += `<span class="mic-all-off">alle aus</span>`
                } else if (effectiveMicColors && effectiveMicColors.length) {
                    for (const { name, color } of effectiveMicColors)
                        micsHtml += `<span class="mic-chip${color ? ' color-' + color : ''}">${esc(name)}</span>`
                }
                micsHtml += '</div>'
                cell.innerHTML = micsHtml
                infoBarEl.appendChild(cell)
            }
        }

        // ── Main render ──────────────────────────────────────────────────
        function render(state) {
            const { blocks, nextCue, currentCue, selectedVariant, timecodeFrames, audioProgress, appLanguage } = state
            if (appLanguage && appLanguage !== window.appLanguage) window.applyI18n(appLanguage)

            if (timecodeFrames !== null && timecodeFrames !== undefined) {
                liveFrames = timecodeFrames; liveFramesAt = performance.now()
            } else {
                liveFrames = null; tcEl.textContent = '--:--:--:--'
            }

            renderScript(blocks, nextCue, currentCue ?? 0, selectedVariant)
            syncAudio(audioProgress || [])
            updateInfoBar(state)
        }

        // ── Controls ─────────────────────────────────────────────────────
        btnGo.addEventListener('click', () => {
            try { window.electronAPI.liveGo() } catch(e) { console.error(e) }
        })
        btnBack.addEventListener('click', () => {
            try { window.electronAPI.liveBack() } catch(e) { console.error(e) }
        })
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
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
    