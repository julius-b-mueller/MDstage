        let deviceIdMap = new Map()  // label → deviceId

        function esc(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        }

        // ── Init ─────────────────────────────────────────────────────────
        async function init() {
            const [settings, hn, emLightNote0] = await Promise.all([
                window.electronAPI.getSettings(),
                window.electronAPI.getHostname(),
                window.electronAPI.getEmLightNote(),
            ])
            // Apply language before rendering anything else
            window.applyI18n(settings.appLanguage || 'de')
            const langSel = document.getElementById('app-language')
            langSel.value = settings.appLanguage || 'de'
            langSel.addEventListener('change', () => window.applyI18n(langSel.value))

            let emLightNote = emLightNote0 || null
            document.getElementById('hostname-label').textContent = 'Dieser PC: ' + hn

            const mainAudioSel = document.getElementById('main-audio-device')

            // ── Channel routing matrix ───────────────────────────────────
            const routingBody    = document.getElementById('routing-body')
            const monitorCheckbox = document.getElementById('monitor-enable')
            const monitorHint    = document.getElementById('monitor-hint')
            const monThL         = document.getElementById('mon-th-l')
            const monThR         = document.getElementById('mon-th-r')
            const COLS = [
                { key: 'mainL', sel: 'sel-main', isMon: false },
                { key: 'mainR', sel: 'sel-main', isMon: false },
                { key: 'monL',  sel: 'sel-mon',  isMon: true  },
                { key: 'monR',  sel: 'sel-mon',  isMon: true  },
            ]
            const routing = {
                mainL: settings.mainChannelL    ?? 0,
                mainR: settings.mainChannelR    ?? 1,
                monL:  settings.monitorChannelL ?? -1,
                monR:  settings.monitorChannelR ?? -1,
            }
            let monitorEnabled = settings.monitorEnabled ?? false

            let currentNumCh = 2

            async function playTestTone(ch, btn) {
                const label = mainAudioSel.value
                const devId = deviceIdMap.get(label) || ''
                btn.classList.add('playing')
                try {
                    const ctx = new AudioContext()
                    if (devId && ctx.setSinkId) await ctx.setSinkId(devId)
                    const numCh = currentNumCh
                    if (ctx.destination.maxChannelCount >= numCh) {
                        ctx.destination.channelCountMode = 'explicit'
                        ctx.destination.channelCount = numCh
                    }
                    const osc    = ctx.createOscillator()
                    const gain   = ctx.createGain()
                    const merger = ctx.createChannelMerger(Math.max(numCh, ch + 1))
                    osc.frequency.value = 880
                    osc.type = 'sine'
                    gain.gain.setValueAtTime(0.35, ctx.currentTime)
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
                    osc.connect(gain)
                    gain.connect(merger, 0, ch)
                    merger.connect(ctx.destination)
                    osc.start()
                    osc.stop(ctx.currentTime + 0.4)
                    osc.addEventListener('ended', () => { ctx.close(); btn.classList.remove('playing') })
                } catch (e) {
                    btn.classList.remove('playing')
                    console.warn('Test tone failed:', e)
                }
            }

            function buildRoutingTable(numCh) {
                currentNumCh = numCh
                const monPossible = numCh >= 4

                // Clamp out-of-range assignments to -1 (unassigned)
                for (const col of COLS) if (routing[col.key] >= numCh) routing[col.key] = -1

                // Monitor checkbox state
                if (!monPossible) {
                    monitorEnabled = false
                    monitorCheckbox.checked = false
                    monitorCheckbox.disabled = true
                } else {
                    monitorCheckbox.disabled = false
                    monitorCheckbox.checked = monitorEnabled
                }
                monThL.style.opacity = monitorEnabled ? '' : '0.35'
                monThR.style.opacity = monitorEnabled ? '' : '0.35'
                monitorHint.textContent = !monPossible
                    ? window.t('s.monitor.need4')
                    : !monitorEnabled ? window.t('s.monitor.disabled')
                    : ''

                routingBody.innerHTML = ''
                for (let ch = 0; ch < numCh; ch++) {
                    const tr = document.createElement('tr')
                    const labelTd = document.createElement('td')
                    labelTd.textContent = `Kanal ${ch + 1}`
                    tr.appendChild(labelTd)
                    for (const col of COLS) {
                        const disabled = col.isMon && !monitorEnabled
                        const isSelected = !disabled && routing[col.key] === ch
                        const td = document.createElement('td')
                        td.className = 'route-cell' + (isSelected ? ' ' + col.sel : '') + (disabled ? ' disabled' : '')
                        td.dataset.col = col.key
                        if (!disabled) {
                            td.addEventListener('click', () => {
                                if (routing[col.key] === ch) {
                                    routing[col.key] = -1
                                } else {
                                    // Exclusive: each channel can only hold one role
                                    for (const c of COLS) {
                                        if (!c.isMon || monitorEnabled) {
                                            if (routing[c.key] === ch) routing[c.key] = -1
                                        }
                                    }
                                    routing[col.key] = ch
                                }
                                buildRoutingTable(numCh)
                            })
                        }
                        tr.appendChild(td)
                    }
                    const testTd = document.createElement('td')
                    testTd.className = 'col-test'
                    const testBtn = document.createElement('button')
                    testBtn.className = 'test-btn'
                    testBtn.textContent = '▶'
                    testBtn.title = `Kanal ${ch + 1} testen`
                    testBtn.addEventListener('click', () => playTestTone(ch, testBtn))
                    testTd.appendChild(testBtn)
                    tr.appendChild(testTd)
                    routingBody.appendChild(tr)
                }
            }

            monitorCheckbox.addEventListener('change', () => {
                monitorEnabled = monitorCheckbox.checked
                buildRoutingTable(currentNumCh)
            })

            async function refreshRoutingTable() {
                const label = mainAudioSel.value
                const devId = deviceIdMap.get(label) || ''
                let numCh = 2
                if (devId) {
                    try {
                        const tmpCtx = new AudioContext()
                        if (tmpCtx.setSinkId) await tmpCtx.setSinkId(devId)
                        numCh = tmpCtx.destination.maxChannelCount
                        tmpCtx.close()
                    } catch {}
                }
                buildRoutingTable(Math.max(2, Math.min(numCh, 16)))
            }

            mainAudioSel.addEventListener('change', refreshRoutingTable)

            const getRouting = () => ({
                mainChannelL:    routing.mainL >= 0 ? routing.mainL : 0,
                mainChannelR:    routing.mainR >= 0 ? routing.mainR : 1,
                monitorChannelL: routing.monL >= 0 ? routing.monL : null,
                monitorChannelR: routing.monR >= 0 ? routing.monR : null,
                monitorEnabled,
            })

            function insertWarning(afterEl, message) {
                const p = document.createElement('p')
                p.className = 'device-warning'
                p.textContent = message
                afterEl.insertAdjacentElement('afterend', p)
            }

            function insertError(message) {
                const p = document.createElement('p')
                p.className = 'error'
                p.textContent = message
                document.body.appendChild(p)
            }

            try {
                const devices = await navigator.mediaDevices.enumerateDevices()
                const outputs = devices.filter(d => d.kind === 'audiooutput')
                const audioLabels = new Set()
                for (const dev of outputs) {
                    const label = dev.label || dev.deviceId
                    audioLabels.add(label)
                    if (!deviceIdMap.has(label)) deviceIdMap.set(label, dev.deviceId)
                    const o = new Option(label, label)
                    if (settings.mainAudioDevice === label) o.selected = true
                    mainAudioSel.appendChild(o)
                }
                if (settings.mainAudioDevice && !audioLabels.has(settings.mainAudioDevice))
                    insertWarning(mainAudioSel, `Gerät „${settings.mainAudioDevice}" nicht gefunden – auf Standard zurückgefallen`)
            } catch (e) {
                insertError('Audio-Geräte nicht verfügbar: ' + e.message)
            }

            await refreshRoutingTable()

            // ── Mischpult Fernbedienung ───────────────────────────────
            const micMuteMethodSel     = document.getElementById('mic-mute-method')
            const micMuteCustomMidiDiv = document.getElementById('mic-mute-custom-midi')
            const micMuteCustomOscDiv  = document.getElementById('mic-mute-custom-osc')
            const x32MidiFields        = document.getElementById('x32-midi-fields')
            const x32OscFields         = document.getElementById('x32-osc-fields')
            const micMuteMidiUnmuteEl  = document.getElementById('mic-mute-midi-unmute')
            const micMuteMidiMuteEl    = document.getElementById('mic-mute-midi-mute')
            const micMuteMidiTypeSel   = document.getElementById('mic-mute-midi-type')

            micMuteMethodSel.value    = settings.micMuteMethod   || 'x32'
            micMuteMidiTypeSel.value  = settings.micMuteMidiType || 'sysex'
            micMuteMidiUnmuteEl.value = settings.micMuteMidiUnmute || 'B1 {ch} 00'
            micMuteMidiMuteEl.value   = settings.micMuteMidiMute   || 'B1 {ch} 7F'
            document.getElementById('mm-note-ch').value    = settings.micMuteMidiNoteCh   || '1'
            document.getElementById('mm-note-num').value   = settings.micMuteMidiNoteNum  || '{ch}'
            document.getElementById('mm-note-vel-on').value  = settings.micMuteMidiVelOn  ?? 127
            document.getElementById('mm-note-vel-off').value = settings.micMuteMidiVelOff ?? 0
            document.getElementById('mm-cc-ch').value      = settings.micMuteMidiCcCh    || '2'
            document.getElementById('mm-cc-num').value     = settings.micMuteMidiCcNum   || '{ch}'
            document.getElementById('mm-cc-val-on').value  = settings.micMuteMidiCcValOn  ?? 0
            document.getElementById('mm-cc-val-off').value = settings.micMuteMidiCcValOff ?? 127
            document.getElementById('mm-pc-ch').value      = settings.micMuteMidiPcCh    || '1'
            document.getElementById('mm-pc-on').value      = settings.micMuteMidiPcOn     ?? 0
            document.getElementById('mm-pc-off').value     = settings.micMuteMidiPcOff    ?? 1
            // OSC: separate on/off paths with backwards compat for old single-path setting
            document.getElementById('mic-mute-osc-on-path').value  = settings.micMuteOscOnPath  || settings.micMuteOscPath || '/ch/{ch}/mix/on'
            document.getElementById('mic-mute-osc-off-path').value = settings.micMuteOscOffPath || settings.micMuteOscPath || '/ch/{ch}/mix/on'
            document.getElementById('mic-mute-osc-on-type').value  = settings.micMuteOscOnArgType  || 'float'
            document.getElementById('mic-mute-osc-off-type').value = settings.micMuteOscOffArgType || 'float'
            document.getElementById('mic-mute-osc-on-arg').value   = settings.micMuteOscOnArg  !== undefined ? String(settings.micMuteOscOnArg)  : (settings.micMuteOscUnmute !== undefined ? String(settings.micMuteOscUnmute) : '1')
            document.getElementById('mic-mute-osc-off-arg').value  = settings.micMuteOscOffArg !== undefined ? String(settings.micMuteOscOffArg) : (settings.micMuteOscMute   !== undefined ? String(settings.micMuteOscMute)   : '0')

            function updateMicMuteVisibility() {
                const m = micMuteMethodSel.value
                x32MidiFields.style.display        = (m === 'x32' || m === 'custom-midi') ? '' : 'none'
                x32OscFields.style.display         = m === 'custom-osc' ? '' : 'none'
                micMuteCustomMidiDiv.style.display = m === 'custom-midi' ? '' : 'none'
                micMuteCustomOscDiv.style.display  = m === 'custom-osc'  ? '' : 'none'
            }
            function updateMidiTypeVisibility() {
                const t = micMuteMidiTypeSel.value
                document.getElementById('mm-sysex').style.display = t === 'sysex' ? '' : 'none'
                document.getElementById('mm-note').style.display  = t === 'note'  ? '' : 'none'
                document.getElementById('mm-cc').style.display    = t === 'cc'    ? '' : 'none'
                document.getElementById('mm-pc').style.display    = t === 'pc'    ? '' : 'none'
            }
            updateMicMuteVisibility()
            updateMidiTypeVisibility()
            micMuteMethodSel.addEventListener('change', updateMicMuteVisibility)
            micMuteMidiTypeSel.addEventListener('change', updateMidiTypeVisibility)

            // ── MIDI ──────────────────────────────────────────────────
            const x32Select       = document.getElementById('x32-device')
            const triggerSelect   = document.getElementById('trigger-device')
            const tcSelect        = document.getElementById('tc-device')
            const liveInputSelect = document.getElementById('live-input-device')

            document.getElementById('x32-osc-host').value = settings.x32OscHost || '192.168.1.1'
            document.getElementById('x32-osc-port').value = settings.x32OscPort ?? 10023

            try {
                const midiAccess = await navigator.requestMIDIAccess({ sysex: true })
                const midiOutNames = new Set()
                const midiInNames  = new Set()
                for (const output of midiAccess.outputs.values()) {
                    midiOutNames.add(output.name)
                    const o1 = new Option(output.name, output.name)
                    const o2 = new Option(output.name, output.name)
                    const o3 = new Option(output.name, output.name)
                    if (settings.midiX32Device === output.name)     o1.selected = true
                    if (settings.midiTriggerDevice === output.name) o2.selected = true
                    if (settings.midiTCDevice === output.name)      o3.selected = true
                    x32Select.appendChild(o1)
                    triggerSelect.appendChild(o2)
                    tcSelect.appendChild(o3)
                }
                for (const input of midiAccess.inputs.values()) {
                    midiInNames.add(input.name)
                    const o = new Option(input.name, input.name)
                    if (settings.midiLiveDevice === input.name) o.selected = true
                    liveInputSelect.appendChild(o)
                }
                if (settings.midiX32Device && !midiOutNames.has(settings.midiX32Device))
                    insertWarning(x32Select, `Gerät „${settings.midiX32Device}" nicht gefunden – MIDI-Ausgabe deaktiviert`)
                if (settings.midiTriggerDevice && !midiOutNames.has(settings.midiTriggerDevice))
                    insertWarning(triggerSelect, `Gerät „${settings.midiTriggerDevice}" nicht gefunden – MIDI-Ausgabe deaktiviert`)
                if (settings.midiTCDevice && !midiOutNames.has(settings.midiTCDevice))
                    insertWarning(tcSelect, `Gerät „${settings.midiTCDevice}" nicht gefunden – MIDI-Ausgabe deaktiviert`)
                if (settings.midiLiveDevice && !midiInNames.has(settings.midiLiveDevice))
                    insertWarning(liveInputSelect, `Gerät „${settings.midiLiveDevice}" nicht gefunden – Eingang deaktiviert`)
            } catch (e) {
                insertError('MIDI nicht verfügbar: ' + e.message)
            }

            // ── Live-Tasten MIDI Learn ────────────────────────────────
            let midiGoNote   = settings.midiGoNote   || null
            let midiBackNote = settings.midiBackNote || null
            let learningFor  = null  // 'go' | 'back'

            function midiNoteLabel(n) { return n ? `K${n.ch}  N${n.note}` : window.t('s.midi.unassigned') }
            function applyMidiLabel(which, note) {
                const el = document.getElementById(which + '-midi-label')
                el.textContent = midiNoteLabel(note)
                el.classList.toggle('assigned', !!note)
            }
            applyMidiLabel('go', midiGoNote)
            applyMidiLabel('back', midiBackNote)

            function stopLearn() {
                learningFor = null
                document.getElementById('go-learn-btn').classList.remove('btn-active')
                document.getElementById('go-learn-btn').textContent = window.t('s.midi.learn')
                document.getElementById('back-learn-btn').classList.remove('btn-active')
                document.getElementById('back-learn-btn').textContent = window.t('s.midi.learn')
            }

            try {
                const midiIn = await navigator.requestMIDIAccess({ sysex: false })
                for (const input of midiIn.inputs.values()) {
                    input.onmidimessage = (msg) => {
                        const [status, note, velocity] = msg.data
                        const type = status & 0xf0
                        const ch   = (status & 0x0f) + 1
                        if (type !== 0x90 || velocity === 0 || !learningFor) return
                        const assignment = { ch, note }
                        if (learningFor === 'go') {
                            midiGoNote = assignment
                            applyMidiLabel('go', assignment)
                        } else {
                            midiBackNote = assignment
                            applyMidiLabel('back', assignment)
                        }
                        stopLearn()
                    }
                }
            } catch {}

            function toggleLearn(which) {
                const was = learningFor
                stopLearn()
                if (was !== which) {
                    learningFor = which
                    const btn = document.getElementById(which + '-learn-btn')
                    btn.classList.add('btn-active')
                    btn.textContent = window.t('s.midi.learn.wait')
                }
            }
            document.getElementById('go-learn-btn').addEventListener('click', () => toggleLearn('go'))
            document.getElementById('back-learn-btn').addEventListener('click', () => toggleLearn('back'))
            document.getElementById('go-clear-btn').addEventListener('click', () => { midiGoNote = null; applyMidiLabel('go', null); stopLearn() })
            document.getElementById('back-clear-btn').addEventListener('click', () => { midiBackNote = null; applyMidiLabel('back', null); stopLearn() })

            // ── Notfall-Licht ────────────────────────────────────────
            const emLightChEl   = document.getElementById('em-light-ch')
            const emLightNoteEl = document.getElementById('em-light-note')
            const emLightClear  = document.getElementById('em-light-clear')

            function applyEmLight(n) {
                emLightNote = n
                if (n) { emLightChEl.value = n.ch; emLightNoteEl.value = n.note }
                else   { emLightChEl.value = ''; emLightNoteEl.value = '' }
            }
            applyEmLight(emLightNote)
            emLightClear.addEventListener('click', () => applyEmLight(null))

            // ── OSC ───────────────────────────────────────────────────
            const oscEnabledEl = document.getElementById('osc-enabled')
            const oscHostEl    = document.getElementById('osc-host')
            const oscPortEl    = document.getElementById('osc-port')
            const oscFieldsEl  = document.getElementById('osc-fields')

            oscEnabledEl.checked = settings.oscEnabled ?? true
            oscHostEl.value      = settings.oscHost    || '127.0.0.1'
            oscPortEl.value      = settings.oscPort    ?? 8000
            oscFieldsEl.style.opacity      = oscEnabledEl.checked ? '' : '0.45'
            oscFieldsEl.style.pointerEvents = oscEnabledEl.checked ? '' : 'none'
            oscEnabledEl.addEventListener('change', () => {
                oscFieldsEl.style.opacity       = oscEnabledEl.checked ? '' : '0.45'
                oscFieldsEl.style.pointerEvents  = oscEnabledEl.checked ? '' : 'none'
            })

            // ── Text-Editor ───────────────────────────────────────────
            const editorAppSel   = document.getElementById('editor-app')

            if (settings.editorApp) editorAppSel.value = settings.editorApp

            // ── Input validation ──────────────────────────────────────────────────
            function isValidIPv4(v) {
                const p = v.trim().split('.')
                return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x >= 0 && +x <= 255)
            }
            function isValidPort(v) {
                const n = parseInt(v)
                return Number.isInteger(n) && n >= 1 && n <= 65535
            }
            function isValidMidiCh(v) {
                if (v.trim() === '{ch}') return true
                const n = parseInt(v)
                return /^\d+$/.test(v.trim()) && n >= 1 && n <= 16
            }
            function isValidMidiNote(v) {
                if (v.trim() === '{ch}') return true
                const n = parseInt(v)
                return /^\d+$/.test(v.trim()) && n >= 0 && n <= 127
            }
            function isValidOscPath(v) {
                return /^\/[\x20-\x7e]*$/.test(v.trim().replace(/\{ch\}/g, '00'))
            }

            const _validators = [
                ['osc-host',              isValidIPv4],
                ['x32-osc-host',          isValidIPv4],
                ['osc-port',              isValidPort],
                ['x32-osc-port',          isValidPort],
                ['mm-note-ch',            isValidMidiCh],
                ['mm-note-num',           isValidMidiNote],
                ['mm-cc-ch',              isValidMidiCh],
                ['mm-cc-num',             isValidMidiNote],
                ['mm-pc-ch',              isValidMidiCh],
                ['mic-mute-osc-on-path',  isValidOscPath],
                ['mic-mute-osc-off-path', isValidOscPath],
            ]
            for (const [id, validate] of _validators) {
                const el = document.getElementById(id)
                if (!el) continue
                const check = () => el.classList.toggle('invalid', el.value.trim() !== '' && !validate(el.value))
                el.addEventListener('input', check)
                check()
            }

            function _hasInvalidVisible() {
                return _validators.some(([id]) => {
                    const el = document.getElementById(id)
                    return el && el.offsetParent !== null && el.classList.contains('invalid')
                })
            }

            document.getElementById('cancel').addEventListener('click', () => window.close())

            document.getElementById('save').addEventListener('click', async () => {
                if (_hasInvalidVisible()) {
                    const first = _validators.map(([id]) => document.getElementById(id))
                        .find(el => el && el.offsetParent !== null && el.classList.contains('invalid'))
                    if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus() }
                    return
                }
                const chVal   = parseInt(emLightChEl.value)
                const noteVal = parseInt(emLightNoteEl.value)
                const newEmLight = (!isNaN(chVal) && !isNaN(noteVal) && emLightChEl.value !== '' && emLightNoteEl.value !== '')
                    ? { ch: Math.max(1, Math.min(16, chVal)), note: Math.max(0, Math.min(127, noteVal)) }
                    : null
                await window.electronAPI.saveEmLightNote(newEmLight)
                const oscPortVal = parseInt(oscPortEl.value)
                await window.electronAPI.saveSettings({
                    mainAudioDevice: mainAudioSel.value || null,
                    ...getRouting(),
                    x32OscHost:      document.getElementById('x32-osc-host').value.trim() || '192.168.1.1',
                    x32OscPort:      parseInt(document.getElementById('x32-osc-port').value) || 10023,
                    midiX32Device:   x32Select.value    || null,
                    midiTriggerDevice: triggerSelect.value || null,
                    midiTCDevice:     tcSelect.value     || null,
                    editorApp:        editorAppSel.value || null,
                    midiGoNote,
                    midiBackNote,
                    midiLiveDevice: liveInputSelect.value || null,
                    appLanguage: langSel.value || 'de',
                    oscEnabled: oscEnabledEl.checked,
                    oscHost:    oscHostEl.value.trim() || '127.0.0.1',
                    oscPort:    isNaN(oscPortVal) ? 8000 : Math.max(1, Math.min(65535, oscPortVal)),
                    micMuteMethod:    micMuteMethodSel.value  || 'x32',
                    micMuteMidiType:  micMuteMidiTypeSel.value || 'sysex',
                    micMuteMidiUnmute: micMuteMidiUnmuteEl.value.trim() || 'B1 {ch} 00',
                    micMuteMidiMute:   micMuteMidiMuteEl.value.trim()   || 'B1 {ch} 7F',
                    micMuteMidiNoteCh:   document.getElementById('mm-note-ch').value.trim()   || '1',
                    micMuteMidiNoteNum:  document.getElementById('mm-note-num').value.trim()  || '{ch}',
                    micMuteMidiVelOn:    parseInt(document.getElementById('mm-note-vel-on').value)  || 127,
                    micMuteMidiVelOff:   parseInt(document.getElementById('mm-note-vel-off').value) || 0,
                    micMuteMidiCcCh:     document.getElementById('mm-cc-ch').value.trim()     || '2',
                    micMuteMidiCcNum:    document.getElementById('mm-cc-num').value.trim()    || '{ch}',
                    micMuteMidiCcValOn:  parseInt(document.getElementById('mm-cc-val-on').value)  ?? 0,
                    micMuteMidiCcValOff: parseInt(document.getElementById('mm-cc-val-off').value) ?? 127,
                    micMuteMidiPcCh:     document.getElementById('mm-pc-ch').value.trim()    || '1',
                    micMuteMidiPcOn:     parseInt(document.getElementById('mm-pc-on').value)  ?? 0,
                    micMuteMidiPcOff:    parseInt(document.getElementById('mm-pc-off').value) ?? 1,
                    micMuteOscOnPath:     document.getElementById('mic-mute-osc-on-path').value.trim()  || '/ch/{ch}/mix/on',
                    micMuteOscOnArgType:  document.getElementById('mic-mute-osc-on-type').value,
                    micMuteOscOnArg:      document.getElementById('mic-mute-osc-on-arg').value.trim(),
                    micMuteOscOffPath:    document.getElementById('mic-mute-osc-off-path').value.trim() || '/ch/{ch}/mix/on',
                    micMuteOscOffArgType: document.getElementById('mic-mute-osc-off-type').value,
                    micMuteOscOffArg:     document.getElementById('mic-mute-osc-off-arg').value.trim(),
                })
                window.close()
            })
        }
        init()
