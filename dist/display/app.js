'use strict'
// MDstage display client.
//  • Opens an SSE stream for this page's slug and renders the pushed markdown-HTML,
//    applies the chosen stylesheet, and auto-scrolls page by page when it overflows.
//  • Reads text-to-speech announcements (with a gong) on cue triggers.
//  • Has a settings panel for a client name + TTS voice. Name/voice come from URL query
//    params if present, otherwise from cookies; both are reflected back into the URL and
//    saved as cookies. The name shows up as a green/red presence dot in the app's live view.
;(function () {
    const content   = document.getElementById('content')
    const styleLink = document.getElementById('style-link')
    const audioEnableBtn = document.getElementById('dp-audio-enable')
    const params    = new URLSearchParams(location.search)

    // ── Identity, name, voice ──────────────────────────────────────────────
    // Per-tab clientId (stable across SSE reconnects and in-tab reloads).
    let clientId = sessionStorage.getItem('mdstage-client-id')
    if (!clientId) {
        clientId = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
        sessionStorage.setItem('mdstage-client-id', clientId)
    }

    function cookieGet(k) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + k.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'))
        return m ? decodeURIComponent(m[1]) : null
    }
    function cookieSet(k, v) {
        document.cookie = k + '=' + encodeURIComponent(v) + ';path=/;max-age=31536000;samesite=lax'
    }

    // Precedence: URL query param > cookie > default.
    let clientName = params.has('name')  ? (params.get('name')  || '') : (cookieGet('mdstage-name')  || '')
    let voiceName  = params.has('voice') ? (params.get('voice') || '') : (cookieGet('mdstage-voice') || '')
    let zoom       = parseFloat(params.has('zoom') ? params.get('zoom') : cookieGet('mdstage-zoom'))
    if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1
    zoom = Math.min(5, Math.max(0.3, zoom))
    let deviceLang = ''   // language configured for this display device (from the server)

    // Decoded so the meta slug matches the server's decoded SSE slug (the device name).
    const slugPath = decodeURIComponent(location.pathname)   // "/Device Name"

    function persist() {
        cookieSet('mdstage-name', clientName)
        cookieSet('mdstage-voice', voiceName)
        cookieSet('mdstage-zoom', String(zoom))
        // Reflect current settings in the URL so it can be reused for a kiosk setup.
        const p = new URLSearchParams()
        if (clientName)   p.set('name', clientName)
        if (voiceName)    p.set('voice', voiceName)
        if (zoom !== 1)   p.set('zoom', String(zoom))
        const qs = p.toString()
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''))
    }

    function sendMeta() {
        const p = new URLSearchParams({ clientId, slug: slugPath.replace(/^\//, ''), name: clientName, voice: voiceName })
        fetch('/__display/meta?' + p.toString()).catch(() => {})
    }

    // ── Auto-scroll ────────────────────────────────────────────────────────
    let scrollTimer = null
    function restartAutoScroll(scrollSec) {
        const sec = Number(scrollSec) > 0 ? Number(scrollSec) : 0
        if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null }
        window.scrollTo(0, 0)
        if (sec <= 0) return
        scrollTimer = setInterval(() => {
            const doc = document.documentElement
            const overflow = doc.scrollHeight - window.innerHeight
            if (overflow <= 2) return
            const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 2
            if (atBottom) window.scrollTo({ top: 0, behavior: 'smooth' })
            else window.scrollBy({ top: window.innerHeight, behavior: 'smooth' })
        }, sec * 1000)
    }

    function applyStyle(style) {
        const name = (typeof style === 'string' && style) ? style : 'dark'
        const href = '/__display/style/' + name
        if (styleLink.getAttribute('href') !== href) styleLink.setAttribute('href', href)
    }

    // App-controlled zoom (persisted via cookie + URL, unlike the browser's native zoom).
    // Applied to the content only, so the settings panel keeps its size.
    function applyZoom() {
        content.style.zoom = zoom === 1 ? '' : String(zoom)
        const valEl = document.getElementById('dp-zoom-val')
        if (valEl) valEl.textContent = Math.round(zoom * 100) + '%'
    }
    function setZoom(z) {
        zoom = Math.min(5, Math.max(0.3, Math.round(z * 20) / 20))
        applyZoom(); persist()
    }

    function renderContent(data) {
        applyStyle(data.style)
        content.innerHTML = data.html || ''
        restartAutoScroll(data.scrollSec)
        if (typeof data.lang === 'string' && data.lang !== deviceLang) {
            deviceLang = data.lang
            populateVoices()   // re-filter the voice list for the new language
        }
    }

    // ── Text-to-speech + gong ──────────────────────────────────────────────
    let audioCtx = null
    function ensureAudio() {
        if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch {} }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
        return audioCtx
    }
    // Unlock audio/speech on the first user gesture (browsers block autoplay otherwise).
    function unlock() {
        ensureAudio()
        try { window.speechSynthesis && window.speechSynthesis.resume() } catch {}
        // Any real gesture also satisfies the autoplay policy → drop the unlock button.
        if (audioCtx && audioCtx.state === 'running') hideAudioEnable()
    }
    window.addEventListener('pointerdown', unlock, { once: false })
    window.addEventListener('keydown', unlock, { once: false })

    // ── Audio-permission probe ─────────────────────────────────────────────
    // Show a one-tap "enable audio" button only when the browser blocks autoplay. A kiosk
    // configured to allow audio starts the AudioContext already 'running', so the button
    // never appears there.
    function hideAudioEnable() { if (audioEnableBtn) audioEnableBtn.hidden = true }
    function showAudioEnable() { if (audioEnableBtn) audioEnableBtn.hidden = false }
    function checkAudioPermission() {
        const ctx = ensureAudio()
        if (!ctx) { hideAudioEnable(); return }        // no Web Audio → nothing to unlock
        if (ctx.state === 'running') { hideAudioEnable(); return }   // already permitted (kiosk)
        ctx.resume().catch(() => {})                   // try — succeeds silently if allowed
        // Re-check shortly after: still suspended ⇒ a gesture is required, surface the button.
        setTimeout(() => { if (ctx.state === 'running') hideAudioEnable(); else showAudioEnable() }, 350)
    }
    if (audioEnableBtn) {
        audioEnableBtn.addEventListener('click', () => { unlock(); hideAudioEnable() })
    }

    // A single warm bell/chime strike: a fundamental plus a few (slightly inharmonic) partials
    // with a long exponential decay, so it rings like a front-of-house call bell.
    function bellStrike(ctx, dest, freq, startTime, duration, peak) {
        const partials = [
            { mult: 1,    gain: 1.00 },
            { mult: 2.01, gain: 0.55 },
            { mult: 3.00, gain: 0.28 },
            { mult: 4.20, gain: 0.14 },   // inharmonic → subtle metallic shimmer
            { mult: 5.40, gain: 0.07 },
        ]
        for (const p of partials) {
            const osc = ctx.createOscillator()
            const g = ctx.createGain()
            osc.type = 'sine'
            osc.frequency.value = freq * p.mult
            const amp = Math.max(0.0002, peak * p.gain)
            g.gain.setValueAtTime(0.0001, startTime)
            g.gain.exponentialRampToValueAtTime(amp, startTime + 0.006)
            g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)
            osc.connect(g).connect(dest)
            osc.start(startTime)
            osc.stop(startTime + duration + 0.05)
        }
    }

    // Theatrical "front of house" call: a descending three-note chime whose tones ring into
    // one another, followed by a low sustained tone — longer and warmer than a single blip.
    function playGong() {
        const ctx = ensureAudio()
        if (!ctx) return
        const now = ctx.currentTime
        // Soft master + gentle limiter so overlapping strikes don't clip.
        const master = ctx.createGain(); master.gain.value = 0.9
        const comp = ctx.createDynamicsCompressor()
        master.connect(comp).connect(ctx.destination)
        const seq = [
            { f: 659.25, t: 0.00, d: 2.6 },   // E5
            { f: 523.25, t: 0.50, d: 2.8 },   // C5
            { f: 392.00, t: 1.00, d: 3.4 },   // G4
            { f: 261.63, t: 1.55, d: 4.2 },   // C4 — low sustain underneath
        ]
        for (const n of seq) bellStrike(ctx, master, n.f, now + n.t, n.d, 0.17)
    }
    // Time from the gong strike until speech begins (the chime keeps ringing underneath).
    const GONG_TO_SPEECH_MS = 2000

    function playAnnounce(text, repeat, repeatPhrase) {
        playGong()
        setTimeout(() => {
            speak(text)
            if (repeat) {
                if (repeatPhrase) speak(repeatPhrase)   // "Ich wiederhole" (in the device language)
                speak(text)
            }
        }, GONG_TO_SPEECH_MS)
    }

    function resolveVoice() {
        if (!window.speechSynthesis) return null
        const voices = window.speechSynthesis.getVoices()
        return voices.find(v => v.name === voiceName) || null
    }

    function speak(text) {
        if (!window.speechSynthesis || !text) return
        const u = new SpeechSynthesisUtterance(text)
        const v = resolveVoice()
        if (v) { u.voice = v; u.lang = v.lang }
        window.speechSynthesis.speak(u)
    }

    // ── Settings panel ─────────────────────────────────────────────────────
    const panel   = document.getElementById('dp-panel')
    const toggle  = document.getElementById('dp-toggle')
    const bodyEl  = document.getElementById('dp-body')
    const nameIn  = document.getElementById('dp-name')
    const voiceSel = document.getElementById('dp-voice')
    const testBtn = document.getElementById('dp-test')
    const statusEl = document.getElementById('dp-status')

    nameIn.value = clientName

    function populateVoices() {
        if (!window.speechSynthesis) { statusEl.textContent = 'TTS nicht verfügbar'; return }
        const all = window.speechSynthesis.getVoices()
        // Only voices for the device's configured language (empty = all languages).
        const lang = (deviceLang || '').toLowerCase()
        const voices = lang ? all.filter(v => (v.lang || '').toLowerCase().replace('_', '-').startsWith(lang)) : all
        voiceSel.innerHTML = ''
        const def = document.createElement('option'); def.value = ''; def.textContent = '— Standard —'
        voiceSel.appendChild(def)
        for (const v of voices) {
            const o = document.createElement('option')
            o.value = v.name
            o.textContent = v.name + ' (' + v.lang + ')'
            if (v.name === voiceName) o.selected = true
            voiceSel.appendChild(o)
        }
        // Keep the currently chosen voice selectable even if it's outside the language filter.
        if (voiceName && !voices.some(v => v.name === voiceName)) {
            const o = document.createElement('option')
            o.value = voiceName
            o.textContent = voiceName + ' (andere Sprache)'
            o.selected = true
            voiceSel.appendChild(o)
        }
        statusEl.textContent = lang && voices.length === 0 ? 'Keine Stimme für diese Sprache installiert' : ''
    }
    populateVoices()
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = populateVoices

    toggle.addEventListener('click', () => {
        const willOpen = bodyEl.hasAttribute('hidden')
        if (willOpen) { bodyEl.removeAttribute('hidden'); panel.classList.add('open') }
        else { bodyEl.setAttribute('hidden', ''); panel.classList.remove('open') }
        unlock()
        revealGear()   // re-arm the idle fade-out after closing the panel
    })

    // ── Gear auto-hide ─────────────────────────────────────────────────────
    // The settings gear is invisible until the mouse moves, then fades back out after a short
    // idle — so a kiosk display stays clean but the panel is still reachable when needed.
    let gearIdleTimer = null
    function revealGear() {
        panel.classList.add('dp-visible')
        if (gearIdleTimer) clearTimeout(gearIdleTimer)
        gearIdleTimer = setTimeout(() => {
            if (!bodyEl.hasAttribute('hidden')) return   // settings panel open → keep it visible
            panel.classList.remove('dp-visible')
        }, 2500)
    }
    window.addEventListener('pointermove', revealGear)
    window.addEventListener('pointerdown', revealGear)
    revealGear()   // briefly visible on load so the gear is discoverable
    nameIn.addEventListener('input', () => {
        clientName = nameIn.value
        persist(); sendMeta()
    })
    voiceSel.addEventListener('change', () => {
        voiceName = voiceSel.value
        persist(); sendMeta()
    })
    testBtn.addEventListener('click', () => { unlock(); playAnnounce('Test ' + (clientName || ''), false, '') })

    document.getElementById('dp-zoom-out').addEventListener('click', () => setZoom(zoom - 0.1))
    document.getElementById('dp-zoom-in').addEventListener('click', () => setZoom(zoom + 0.1))
    document.getElementById('dp-zoom-reset').addEventListener('click', () => setZoom(1))
    applyZoom()   // reflect the loaded zoom (query > cookie > default)

    // ── SSE connection ─────────────────────────────────────────────────────
    function connect() {
        // Only the clientId travels on the SSE URL; name/voice are sent via /__display/meta
        // so an automatic reconnect (which reuses this URL) never reverts a later rename.
        const evUrl = '/__display/events' + location.pathname + '?clientId=' + encodeURIComponent(clientId)
        const es = new EventSource(evUrl)
        es.onmessage = (e) => {
            let data
            try { data = JSON.parse(e.data) } catch { return }
            if (data.type === 'announce') playAnnounce(data.text, data.repeat, data.repeatPhrase)
            else renderContent(data)   // type 'content' (or legacy untyped)
        }
        es.onerror = () => { /* EventSource reconnects automatically */ }
    }

    // Persist current settings into URL/cookies on first load, then connect.
    persist()
    sendMeta()
    connect()
    checkAudioPermission()   // surface the "enable audio" button only if autoplay is blocked
})()
