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

            // ── Mischpult Fernbedienung (dynamic multi-device) ────────
            const micDevicesList  = document.getElementById('mic-devices-list')
            const addDeviceBtn    = document.getElementById('add-mic-device-btn')
            const micDeviceStates = []   // { card, getValues, cardValidators }

            function buildMicDeviceCard(cfg, midiOutNames) {
                const idx = micDeviceStates.length
                const card = document.createElement('div')
                card.className = 'mic-device-card'

                // Header: name + remove button
                const header = document.createElement('div')
                header.className = 'mic-device-header'
                const nameInput = document.createElement('input')
                nameInput.type = 'text'; nameInput.placeholder = `Gerät ${idx + 1}`
                nameInput.value = cfg.name || `Gerät ${idx + 1}`
                const removeBtn = document.createElement('button')
                removeBtn.className = 'mic-device-remove'; removeBtn.textContent = '−'; removeBtn.title = 'Gerät entfernen'
                removeBtn.style.display = idx === 0 ? 'none' : ''
                removeBtn.addEventListener('click', () => {
                    const i = micDeviceStates.findIndex(s => s.card === card)
                    if (i !== -1) { micDeviceStates.splice(i, 1); card.remove(); updateRemoveBtns() }
                })
                header.append(nameInput, removeBtn)
                card.appendChild(header)

                function mkField(labelText, el) {
                    const wrap = document.createElement('div'); wrap.className = 'field'
                    const lbl = document.createElement('label'); lbl.textContent = labelText
                    wrap.append(lbl, el); return wrap
                }
                function mkSel(...opts) {
                    const s = document.createElement('select')
                    for (const [v, t] of opts) { const o = new Option(t, v); s.appendChild(o) }
                    return s
                }
                function mkIn(type, ph, min, max) {
                    const i = document.createElement('input'); i.type = type; i.placeholder = ph
                    if (min !== undefined) i.min = String(min)
                    if (max !== undefined) i.max = String(max)
                    return i
                }

                // Method
                const methodSel = mkSel(['x32','x32 Midi (CC-Kanal 2)'],['custom-midi','Custom MIDI'],['custom-osc','Custom OSC'])
                methodSel.value = cfg.micMuteMethod || 'x32'
                card.appendChild(mkField('Mikrofon-Stummschaltung', methodSel))

                // MIDI device
                const midiSel = mkSel(['','— kein Gerät —'])
                for (const name of midiOutNames) {
                    const o = new Option(name, name)
                    if (name === cfg.midiX32Device) o.selected = true
                    midiSel.appendChild(o)
                }
                const midiField = mkField('MIDI-Ausgang', midiSel)
                if (cfg.midiX32Device && !midiOutNames.has(cfg.midiX32Device)) {
                    const w = document.createElement('p'); w.className = 'device-warning'
                    w.textContent = `Gerät „${cfg.midiX32Device}" nicht gefunden`; midiField.appendChild(w)
                }
                card.appendChild(midiField)

                // OSC host/port
                const oscHostIn = mkIn('text', '192.168.1.1')
                oscHostIn.value = cfg.x32OscHost || '192.168.1.1'
                const oscPortIn = mkIn('number', '10023', 1, 65535)
                oscPortIn.value = cfg.x32OscPort ?? 10023
                const oscHostField = mkField('Adresse', oscHostIn)
                const oscPortField = mkField('Port', oscPortIn)
                card.append(oscHostField, oscPortField)

                // Custom MIDI
                const customMidiDiv = document.createElement('div')
                const midiTypeSel = mkSel(['sysex','SysEx / Hex-Bytes'],['note','Note On/Off'],['cc','Control Change (CC)'],['pc','Program Change (PC)'])
                midiTypeSel.value = cfg.micMuteMidiType || 'sysex'
                customMidiDiv.appendChild(mkField('Typ', midiTypeSel))

                // sysex
                const sysexDiv = document.createElement('div')
                const sysexUnmuteIn = mkIn('text', 'B1 {ch} 00'); sysexUnmuteIn.value = cfg.micMuteMidiUnmute || 'B1 {ch} 00'
                const sysexMuteIn   = mkIn('text', 'B1 {ch} 7F'); sysexMuteIn.value   = cfg.micMuteMidiMute   || 'B1 {ch} 7F'
                const unmuteWrap = mkField('ON-Befehl (Hex-Bytes)', sysexUnmuteIn)
                const hint1 = document.createElement('p'); hint1.className = 'hint'; hint1.innerHTML = '<code>{ch}</code> = Kanalindex (0-basiert). Bytes als Hex, Leerzeichen-getrennt.'
                unmuteWrap.appendChild(hint1)
                sysexDiv.append(unmuteWrap, mkField('OFF-Befehl (Hex-Bytes)', sysexMuteIn))
                customMidiDiv.appendChild(sysexDiv)

                // note
                const noteDiv = document.createElement('div'); noteDiv.style.display = 'none'
                const noteCh = mkIn('text', '1'); noteCh.value = cfg.micMuteMidiNoteCh || '1'
                const noteNum = mkIn('text', '{ch}'); noteNum.value = cfg.micMuteMidiNoteNum || '{ch}'
                const noteVelOn = mkIn('number', '127', 0, 127); noteVelOn.value = cfg.micMuteMidiVelOn ?? 127
                const noteVelOff = mkIn('number', '0', 0, 127); noteVelOff.value = cfg.micMuteMidiVelOff ?? 0
                const noteGrid1 = document.createElement('div'); noteGrid1.className = 'field'; noteGrid1.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:.5rem'
                noteGrid1.innerHTML = ''; const ng1l = document.createElement('div'); ng1l.append(Object.assign(document.createElement('label'),{textContent:'MIDI-Kanal (1–16)'}), noteCh)
                const ng1r = document.createElement('div'); ng1r.append(Object.assign(document.createElement('label'),{textContent:'Note (0–127 oder {ch})'}), noteNum)
                noteGrid1.append(ng1l, ng1r)
                const noteGrid2 = document.createElement('div'); noteGrid2.className = 'field'; noteGrid2.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:.5rem'
                const ng2l = document.createElement('div'); ng2l.append(Object.assign(document.createElement('label'),{textContent:'Velocity ON'}), noteVelOn)
                const ng2r = document.createElement('div'); ng2r.append(Object.assign(document.createElement('label'),{textContent:'Velocity OFF'}), noteVelOff)
                noteGrid2.append(ng2l, ng2r)
                const noteHint = document.createElement('p'); noteHint.className = 'hint'; noteHint.innerHTML = '<code>{ch}</code> = Kanalindex (0-basiert)'
                noteDiv.append(noteGrid1, noteGrid2, noteHint)
                customMidiDiv.appendChild(noteDiv)

                // cc
                const ccDiv = document.createElement('div'); ccDiv.style.display = 'none'
                const ccCh = mkIn('text', '2'); ccCh.value = cfg.micMuteMidiCcCh || '2'
                const ccNum = mkIn('text', '{ch}'); ccNum.value = cfg.micMuteMidiCcNum || '{ch}'
                const ccValOn = mkIn('number', '0', 0, 127); ccValOn.value = cfg.micMuteMidiCcValOn ?? 0
                const ccValOff = mkIn('number', '127', 0, 127); ccValOff.value = cfg.micMuteMidiCcValOff ?? 127
                const ccGrid1 = document.createElement('div'); ccGrid1.className = 'field'; ccGrid1.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:.5rem'
                const cg1l = document.createElement('div'); cg1l.append(Object.assign(document.createElement('label'),{textContent:'MIDI-Kanal (1–16)'}), ccCh)
                const cg1r = document.createElement('div'); cg1r.append(Object.assign(document.createElement('label'),{textContent:'CC-Nummer (0–127 oder {ch})'}), ccNum)
                ccGrid1.append(cg1l, cg1r)
                const ccGrid2 = document.createElement('div'); ccGrid2.className = 'field'; ccGrid2.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:.5rem'
                const cg2l = document.createElement('div'); cg2l.append(Object.assign(document.createElement('label'),{textContent:'Wert ON'}), ccValOn)
                const cg2r = document.createElement('div'); cg2r.append(Object.assign(document.createElement('label'),{textContent:'Wert OFF'}), ccValOff)
                ccGrid2.append(cg2l, cg2r)
                const ccHint = document.createElement('p'); ccHint.className = 'hint'; ccHint.innerHTML = '<code>{ch}</code> = Kanalindex (0-basiert)'
                ccDiv.append(ccGrid1, ccGrid2, ccHint)
                customMidiDiv.appendChild(ccDiv)

                // pc
                const pcDiv = document.createElement('div'); pcDiv.style.display = 'none'
                const pcCh = mkIn('text', '1'); pcCh.value = cfg.micMuteMidiPcCh || '1'
                const pcOn = mkIn('number', '0', 0, 127); pcOn.value = cfg.micMuteMidiPcOn ?? 0
                const pcOff = mkIn('number', '1', 0, 127); pcOff.value = cfg.micMuteMidiPcOff ?? 1
                const pcGrid = document.createElement('div'); pcGrid.className = 'field'; pcGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem'
                const pg1 = document.createElement('div'); pg1.append(Object.assign(document.createElement('label'),{textContent:'MIDI-Kanal (1–16)'}), pcCh)
                const pg2 = document.createElement('div'); pg2.append(Object.assign(document.createElement('label'),{textContent:'Programm ON (0–127)'}), pcOn)
                const pg3 = document.createElement('div'); pg3.append(Object.assign(document.createElement('label'),{textContent:'Programm OFF (0–127)'}), pcOff)
                pcGrid.append(pg1, pg2, pg3); pcDiv.appendChild(pcGrid)
                customMidiDiv.appendChild(pcDiv)
                card.appendChild(customMidiDiv)

                // Custom OSC
                const customOscDiv = document.createElement('div')
                const oscOnPath = mkIn('text', '/ch/{ch}/mix/on'); oscOnPath.value = cfg.micMuteOscOnPath || cfg.micMuteOscPath || '/ch/{ch}/mix/on'
                const oscOffPath = mkIn('text', '/ch/{ch}/mix/on'); oscOffPath.value = cfg.micMuteOscOffPath || cfg.micMuteOscPath || '/ch/{ch}/mix/on'
                const oscOnType = mkSel(['none','— kein Argument —'],['string','string'],['int','int'],['float','float'])
                oscOnType.value = cfg.micMuteOscOnArgType || 'float'; oscOnType.style.cssText = 'width:auto;flex-shrink:0'
                const oscOffType = mkSel(['none','— kein Argument —'],['string','string'],['int','int'],['float','float'])
                oscOffType.value = cfg.micMuteOscOffArgType || 'float'; oscOffType.style.cssText = 'width:auto;flex-shrink:0'
                const oscOnArg = mkIn('text', 'Wert'); oscOnArg.style.flex = '1'
                oscOnArg.value = cfg.micMuteOscOnArg !== undefined ? String(cfg.micMuteOscOnArg) : (cfg.micMuteOscUnmute !== undefined ? String(cfg.micMuteOscUnmute) : '1')
                const oscOffArg = mkIn('text', 'Wert'); oscOffArg.style.flex = '1'
                oscOffArg.value = cfg.micMuteOscOffArg !== undefined ? String(cfg.micMuteOscOffArg) : (cfg.micMuteOscMute !== undefined ? String(cfg.micMuteOscMute) : '0')

                const onWrap = document.createElement('div'); onWrap.className = 'field'
                const onLbl = document.createElement('label'); onLbl.textContent = 'ON (Unmute)'; onLbl.style.color = '#98c379'
                const onRow = document.createElement('div'); onRow.style.cssText = 'display:flex;gap:.5rem;margin-top:.4rem'
                onRow.append(oscOnType, oscOnArg)
                onWrap.append(onLbl, oscOnPath, onRow)
                const offWrap = document.createElement('div'); offWrap.className = 'field'
                const offLbl = document.createElement('label'); offLbl.textContent = 'OFF (Mute)'; offLbl.style.color = '#e06c75'
                const offRow = document.createElement('div'); offRow.style.cssText = 'display:flex;gap:.5rem;margin-top:.4rem'
                offRow.append(oscOffType, oscOffArg)
                offWrap.append(offLbl, oscOffPath, offRow)
                const oscHint = document.createElement('p'); oscHint.className = 'hint'; oscHint.innerHTML = '<code>{ch}</code> = Kanalindex (1-basiert, 2-stellig)'
                customOscDiv.append(onWrap, offWrap, oscHint)
                card.appendChild(customOscDiv)

                // Visibility logic
                function updateVis() {
                    const m = methodSel.value, t2 = midiTypeSel.value
                    midiField.style.display        = (m === 'x32' || m === 'custom-midi') ? '' : 'none'
                    oscHostField.style.display     = m === 'custom-osc' ? '' : 'none'
                    oscPortField.style.display     = m === 'custom-osc' ? '' : 'none'
                    customMidiDiv.style.display    = m === 'custom-midi' ? '' : 'none'
                    customOscDiv.style.display     = m === 'custom-osc' ? '' : 'none'
                    sysexDiv.style.display  = t2 === 'sysex' ? '' : 'none'
                    noteDiv.style.display   = t2 === 'note'  ? '' : 'none'
                    ccDiv.style.display     = t2 === 'cc'    ? '' : 'none'
                    pcDiv.style.display     = t2 === 'pc'    ? '' : 'none'
                }
                methodSel.addEventListener('change', updateVis)
                midiTypeSel.addEventListener('change', updateVis)
                updateVis()

                // Per-card validators
                const cardValidators = [
                    [oscHostIn, isValidIPv4],
                    [oscPortIn, isValidPort],
                    [noteCh,    isValidMidiCh],
                    [noteNum,   isValidMidiNote],
                    [ccCh,      isValidMidiCh],
                    [ccNum,     isValidMidiNote],
                    [pcCh,      isValidMidiCh],
                    [oscOnPath, isValidOscPath],
                    [oscOffPath,isValidOscPath],
                ]
                for (const [el, fn] of cardValidators) {
                    const check = () => el.classList.toggle('invalid', el.value.trim() !== '' && !fn(el.value))
                    el.addEventListener('input', check); check()
                }

                function getValues() {
                    return {
                        name:                nameInput.value.trim() || nameInput.placeholder,
                        micMuteMethod:       methodSel.value,
                        midiX32Device:       midiSel.value || null,
                        x32OscHost:          oscHostIn.value.trim() || '192.168.1.1',
                        x32OscPort:          parseInt(oscPortIn.value) || 10023,
                        micMuteMidiType:     midiTypeSel.value,
                        micMuteMidiUnmute:   sysexUnmuteIn.value.trim() || 'B1 {ch} 00',
                        micMuteMidiMute:     sysexMuteIn.value.trim()   || 'B1 {ch} 7F',
                        micMuteMidiNoteCh:   noteCh.value.trim()  || '1',
                        micMuteMidiNoteNum:  noteNum.value.trim()  || '{ch}',
                        micMuteMidiVelOn:    parseInt(noteVelOn.value)  ?? 127,
                        micMuteMidiVelOff:   parseInt(noteVelOff.value) ?? 0,
                        micMuteMidiCcCh:     ccCh.value.trim()    || '2',
                        micMuteMidiCcNum:    ccNum.value.trim()    || '{ch}',
                        micMuteMidiCcValOn:  parseInt(ccValOn.value)  ?? 0,
                        micMuteMidiCcValOff: parseInt(ccValOff.value) ?? 127,
                        micMuteMidiPcCh:     pcCh.value.trim()   || '1',
                        micMuteMidiPcOn:     parseInt(pcOn.value)  ?? 0,
                        micMuteMidiPcOff:    parseInt(pcOff.value) ?? 1,
                        micMuteOscOnPath:    oscOnPath.value.trim()  || '/ch/{ch}/mix/on',
                        micMuteOscOnArgType: oscOnType.value,
                        micMuteOscOnArg:     oscOnArg.value.trim(),
                        micMuteOscOffPath:   oscOffPath.value.trim() || '/ch/{ch}/mix/on',
                        micMuteOscOffArgType:oscOffType.value,
                        micMuteOscOffArg:    oscOffArg.value.trim(),
                    }
                }

                micDeviceStates.push({ card, getValues, cardValidators, removeBtn })
                micDevicesList.appendChild(card)
            }

            function updateRemoveBtns() {
                micDeviceStates.forEach((s, i) => { s.removeBtn.style.display = i === 0 ? 'none' : '' })
            }

            // Migrate or load devices
            let initialDevices = settings.micDevices && settings.micDevices.length > 0
                ? settings.micDevices
                : [{
                    name: 'Gerät 1',
                    micMuteMethod:       settings.micMuteMethod    || 'x32',
                    midiX32Device:       settings.midiX32Device     || null,
                    x32OscHost:          settings.x32OscHost         || '192.168.1.1',
                    x32OscPort:          settings.x32OscPort         ?? 10023,
                    micMuteMidiType:     settings.micMuteMidiType    || 'sysex',
                    micMuteMidiUnmute:   settings.micMuteMidiUnmute  || 'B1 {ch} 00',
                    micMuteMidiMute:     settings.micMuteMidiMute    || 'B1 {ch} 7F',
                    micMuteMidiNoteCh:   settings.micMuteMidiNoteCh  || '1',
                    micMuteMidiNoteNum:  settings.micMuteMidiNoteNum || '{ch}',
                    micMuteMidiVelOn:    settings.micMuteMidiVelOn   ?? 127,
                    micMuteMidiVelOff:   settings.micMuteMidiVelOff  ?? 0,
                    micMuteMidiCcCh:     settings.micMuteMidiCcCh    || '2',
                    micMuteMidiCcNum:    settings.micMuteMidiCcNum   || '{ch}',
                    micMuteMidiCcValOn:  settings.micMuteMidiCcValOn  ?? 0,
                    micMuteMidiCcValOff: settings.micMuteMidiCcValOff ?? 127,
                    micMuteMidiPcCh:     settings.micMuteMidiPcCh    || '1',
                    micMuteMidiPcOn:     settings.micMuteMidiPcOn    ?? 0,
                    micMuteMidiPcOff:    settings.micMuteMidiPcOff   ?? 1,
                    micMuteOscOnPath:    settings.micMuteOscOnPath   || settings.micMuteOscPath || '/ch/{ch}/mix/on',
                    micMuteOscOnArgType: settings.micMuteOscOnArgType  || 'float',
                    micMuteOscOnArg:     settings.micMuteOscOnArg !== undefined ? String(settings.micMuteOscOnArg) : (settings.micMuteOscUnmute !== undefined ? String(settings.micMuteOscUnmute) : '1'),
                    micMuteOscOffPath:   settings.micMuteOscOffPath  || settings.micMuteOscPath || '/ch/{ch}/mix/on',
                    micMuteOscOffArgType:settings.micMuteOscOffArgType || 'float',
                    micMuteOscOffArg:    settings.micMuteOscOffArg !== undefined ? String(settings.micMuteOscOffArg) : (settings.micMuteOscMute !== undefined ? String(settings.micMuteOscMute) : '0'),
                }]

            // Need midiOutNames before building cards — gather it first (built below in MIDI section)
            // We defer card building until after MIDI enumeration; use a placeholder:
            let _midiOutNames = new Set()
            let _pendingDevices = initialDevices

            addDeviceBtn.addEventListener('click', () => {
                buildMicDeviceCard({ name: `Gerät ${micDeviceStates.length + 1}` }, _midiOutNames)
                updateRemoveBtns()
            })

            // ── MIDI ──────────────────────────────────────────────────
            const triggerSelect   = document.getElementById('trigger-device')
            const tcSelect        = document.getElementById('tc-device')
            const liveInputSelect = document.getElementById('live-input-device')

            try {
                const midiAccess = await navigator.requestMIDIAccess({ sysex: true })
                const midiOutNames = new Set()
                const midiInNames  = new Set()
                for (const output of midiAccess.outputs.values()) {
                    midiOutNames.add(output.name)
                    const o2 = new Option(output.name, output.name)
                    const o3 = new Option(output.name, output.name)
                    if (settings.midiTriggerDevice === output.name) o2.selected = true
                    if (settings.midiTCDevice === output.name)      o3.selected = true
                    triggerSelect.appendChild(o2)
                    tcSelect.appendChild(o3)
                }
                for (const input of midiAccess.inputs.values()) {
                    midiInNames.add(input.name)
                    const o = new Option(input.name, input.name)
                    if (settings.midiLiveDevice === input.name) o.selected = true
                    liveInputSelect.appendChild(o)
                }
                if (settings.midiTriggerDevice && !midiOutNames.has(settings.midiTriggerDevice))
                    insertWarning(triggerSelect, `Gerät „${settings.midiTriggerDevice}" nicht gefunden – MIDI-Ausgabe deaktiviert`)
                if (settings.midiTCDevice && !midiOutNames.has(settings.midiTCDevice))
                    insertWarning(tcSelect, `Gerät „${settings.midiTCDevice}" nicht gefunden – MIDI-Ausgabe deaktiviert`)
                if (settings.midiLiveDevice && !midiInNames.has(settings.midiLiveDevice))
                    insertWarning(liveInputSelect, `Gerät „${settings.midiLiveDevice}" nicht gefunden – Eingang deaktiviert`)

                // Build mic device cards now that we have the MIDI output list
                _midiOutNames = midiOutNames
                for (const dev of _pendingDevices) buildMicDeviceCard(dev, _midiOutNames)
                updateRemoveBtns()
            } catch (e) {
                insertError('MIDI nicht verfügbar: ' + e.message)
                // Still build cards even without MIDI access
                for (const dev of _pendingDevices) buildMicDeviceCard(dev, _midiOutNames)
                updateRemoveBtns()
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
                ['osc-host', isValidIPv4],
                ['osc-port', isValidPort],
            ]
            for (const [id, validate] of _validators) {
                const el = document.getElementById(id)
                if (!el) continue
                const check = () => el.classList.toggle('invalid', el.value.trim() !== '' && !validate(el.value))
                el.addEventListener('input', check)
                check()
            }

            function _hasInvalidVisible() {
                const globalInvalid = _validators.some(([id]) => {
                    const el = document.getElementById(id)
                    return el && el.offsetParent !== null && el.classList.contains('invalid')
                })
                if (globalInvalid) return true
                return micDeviceStates.some(s =>
                    s.cardValidators.some(([el]) => el.offsetParent !== null && el.classList.contains('invalid'))
                )
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
                    micDevices: micDeviceStates.map(s => s.getValues()),
                })
                window.close()
            })
        }
        init()
