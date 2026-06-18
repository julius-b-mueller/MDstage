        // ── Tab switching ─────────────────────────────────────────────
        const TAB_STORAGE_KEY = 'settings-active-tab'
        const _tabBtns   = document.querySelectorAll('.tab-btn')
        const _tabPanels = document.querySelectorAll('.tab-panel')

        function activateTab(tabId) {
            _tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId))
            _tabPanels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + tabId))
            try { localStorage.setItem(TAB_STORAGE_KEY, tabId) } catch {}
        }

        _tabBtns.forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)))

        try {
            const _savedTab = localStorage.getItem(TAB_STORAGE_KEY)
            if (_savedTab && document.getElementById('tab-' + _savedTab)) activateTab(_savedTab)
        } catch {}

        let deviceIdMap = new Map()  // label → deviceId

        function esc(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        }

        // ── Init ─────────────────────────────────────────────────────────
        async function init() {
            const [settings, hn] = await Promise.all([
                window.electronAPI.getSettings(),
                window.electronAPI.getHostname(),
            ])
            // Apply language before rendering anything else
            window.applyI18n(settings.appLanguage || 'de')
            const langSel = document.getElementById('app-language')
            langSel.value = settings.appLanguage || 'de'
            langSel.addEventListener('change', () => window.applyI18n(langSel.value))

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
                // Append inside the Geräte panel so it's visible when the tab is open
                ;(document.getElementById('tab-geraete') || document.body).appendChild(p)
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
                : (settings.midiX32Device || settings.micMuteMethod) ? [{
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
                }] : []

            // Need midiOutNames before building cards — gather it first (built below in MIDI section)
            // We defer card building until after MIDI enumeration; use a placeholder:
            let _midiOutNames = new Set()
            let _pendingDevices = initialDevices

            addDeviceBtn.addEventListener('click', () => {
                buildMicDeviceCard({ name: `Gerät ${micDeviceStates.length + 1}` }, _midiOutNames)
                updateRemoveBtns()
            })

            // ── Ausgabe-Geräte (MIDI + OSC unified) ─────────────────
            const outputDevicesList = document.getElementById('output-devices-list')
            const addOutputDeviceBtn = document.getElementById('add-output-device-btn')
            const outputDeviceStates = []

            const DEVICE_COLORS = {
                blue: '#61afef', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
                purple: '#c678dd', cyan: '#56b6c2', darkblue: '#317fbf', darkred: '#b03c45',
                darkgreen: '#68b349', darkyellow: '#b5904b', darkpurple: '#9648ad', darkcyan: '#268692',
            }
            const DEVICE_COLOR_LABELS = {
                blue: 'Blau', red: 'Rot', green: 'Grün', yellow: 'Gelb',
                purple: 'Lila', cyan: 'Türkis', darkblue: 'Dunkelblau', darkred: 'Dunkelrot',
                darkgreen: 'Dunkelgrün', darkyellow: 'Dunkelgelb', darkpurple: 'Dunkellila', darkcyan: 'Dunkeltürkis',
            }
            const DEVICE_COLOR_CYCLE = Object.keys(DEVICE_COLORS)
            function hexToColorKey(hex) {
                if (!hex) return ''
                const h = hex.toLowerCase()
                return Object.keys(DEVICE_COLORS).find(k => DEVICE_COLORS[k] === h) || ''
            }

            function buildOutputDeviceCard(cfg, midiOutNames) {
                cfg = cfg || {}
                const idx = outputDeviceStates.length
                const card = document.createElement('div')
                card.className = 'mic-device-card'

                const header = document.createElement('div')
                header.className = 'mic-device-header'
                const nameInput = document.createElement('input')
                nameInput.type = 'text'; nameInput.placeholder = `Gerät ${idx + 1}`
                nameInput.value = cfg.name || `Gerät ${idx + 1}`
                const typeSel = document.createElement('select')
                typeSel.style.cssText = 'width:auto;background:#383c44;color:#abb2bf;border:1px solid #4b5263;padding:0.3rem 0.5rem;border-radius:4px;font-size:0.9rem;font-family:inherit;cursor:pointer;flex-shrink:0'
                for (const [v, lbl] of [['midi','MIDI'],['osc','OSC']]) {
                    const o = new Option(lbl, v)
                    if (v === (cfg.type || 'midi')) o.selected = true
                    typeSel.appendChild(o)
                }
                const removeBtn = document.createElement('button')
                removeBtn.className = 'mic-device-remove'; removeBtn.textContent = '−'; removeBtn.title = 'Gerät entfernen'
                removeBtn.addEventListener('click', () => {
                    const i = outputDeviceStates.findIndex(s => s.card === card)
                    if (i !== -1) { outputDeviceStates.splice(i, 1); card.remove(); populateEmLightDeviceSelect() }
                })
                header.append(nameInput, typeSel, removeBtn)
                card.appendChild(header)

                // Aktiviert checkbox (shared)
                const activatedLabel = document.createElement('label')
                activatedLabel.style.cssText = 'display:flex;align-items:center;gap:0.5rem;text-transform:none;font-size:1rem;color:#abb2bf'
                const activatedCb = document.createElement('input'); activatedCb.type = 'checkbox'; activatedCb.style.width = 'auto'
                activatedCb.checked = cfg.enabled ?? true
                activatedLabel.append(activatedCb, document.createTextNode('Aktiviert'))
                const activatedWrap = document.createElement('div'); activatedWrap.className = 'field'
                activatedWrap.appendChild(activatedLabel)
                card.appendChild(activatedWrap)

                // MIDI-specific section
                const midiSection = document.createElement('div')
                const midiPortWrap = document.createElement('div'); midiPortWrap.className = 'field'
                const midiPortLbl = document.createElement('label'); midiPortLbl.textContent = 'MIDI-Ausgang'
                const midiSel = document.createElement('select')
                midiSel.appendChild(new Option('— kein Gerät —', ''))
                for (const name of (midiOutNames || new Set())) {
                    const o = new Option(name, name)
                    if (name === cfg.device) o.selected = true
                    midiSel.appendChild(o)
                }
                if (cfg.device && midiOutNames && !midiOutNames.has(cfg.device)) {
                    const w = document.createElement('p'); w.className = 'device-warning'
                    w.textContent = `Gerät „${cfg.device}" nicht gefunden`; midiPortWrap.appendChild(w)
                }
                midiPortWrap.append(midiPortLbl, midiSel)
                midiSection.appendChild(midiPortWrap)
                card.appendChild(midiSection)

                // OSC-specific section
                const oscSection = document.createElement('div')
                function mkField(labelText, el) {
                    const w = document.createElement('div'); w.className = 'field'
                    const l = document.createElement('label'); l.textContent = labelText
                    w.append(l, el); return w
                }
                const hostIn = document.createElement('input'); hostIn.type = 'text'
                hostIn.placeholder = '127.0.0.1'; hostIn.value = cfg.host || '127.0.0.1'
                const portIn = document.createElement('input'); portIn.type = 'number'
                portIn.min = '1'; portIn.max = '65535'; portIn.placeholder = '8000'
                portIn.value = cfg.port ?? 8000
                oscSection.append(mkField('Adresse', hostIn), mkField('Port', portIn))
                const cardValidators = [
                    [hostIn, isValidIPv4],
                    [portIn, isValidPort],
                ]
                for (const [el, fn] of cardValidators) {
                    const check = () => el.classList.toggle('invalid', el.value.trim() !== '' && !fn(el.value))
                    el.addEventListener('input', check); check()
                }
                card.appendChild(oscSection)

                function updateTypeVis() {
                    const isMidi = typeSel.value === 'midi'
                    midiSection.style.display = isMidi ? '' : 'none'
                    oscSection.style.display   = isMidi ? 'none' : ''
                    tcWrap.style.display = isMidi ? '' : 'none'
                }
                typeSel.addEventListener('change', updateTypeVis)

                const trigNoteLabel = document.createElement('label')
                trigNoteLabel.style.cssText = 'display:flex;align-items:center;gap:0.5rem;text-transform:none;font-size:1rem;color:#abb2bf'
                const trigNoteCb = document.createElement('input'); trigNoteCb.type = 'checkbox'; trigNoteCb.style.width = 'auto'
                trigNoteCb.checked = cfg.sendTriggerNote ?? (idx === 0)
                trigNoteLabel.append(trigNoteCb, document.createTextNode('Trigger-Note senden'))
                const trigNoteWrap = document.createElement('div'); trigNoteWrap.className = 'field'
                trigNoteWrap.appendChild(trigNoteLabel)
                card.appendChild(trigNoteWrap)

                const tcLabel = document.createElement('label')
                tcLabel.style.cssText = 'display:flex;align-items:center;gap:0.5rem;text-transform:none;font-size:1rem;color:#abb2bf'
                const tcCb = document.createElement('input'); tcCb.type = 'checkbox'; tcCb.style.width = 'auto'
                tcCb.checked = cfg.sendTimecode ?? false
                tcLabel.append(tcCb, document.createTextNode('MIDI-Timecode senden'))
                const tcWrap = document.createElement('div'); tcWrap.className = 'field'
                tcWrap.appendChild(tcLabel)
                card.appendChild(tcWrap)

                updateTypeVis()

                const colorWrap = document.createElement('div'); colorWrap.className = 'field'
                const colorLbl = document.createElement('label'); colorLbl.textContent = 'Farbe'
                const colorRow = document.createElement('div')
                colorRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem'
                const colorDot = document.createElement('div')
                colorDot.style.cssText = 'width:14px;height:14px;border-radius:50%;flex-shrink:0;border:2px solid rgba(255,255,255,0.15)'
                const colorSel = document.createElement('select')
                colorSel.style.cssText = 'flex:1'
                const noColorOpt = document.createElement('option'); noColorOpt.value = ''; noColorOpt.textContent = '— keine Farbe —'
                colorSel.appendChild(noColorOpt)
                for (const key of DEVICE_COLOR_CYCLE) {
                    const o = document.createElement('option'); o.value = key; o.textContent = DEVICE_COLOR_LABELS[key]
                    colorSel.appendChild(o)
                }
                const initColorKey = hexToColorKey(cfg.color) || cfg.color || ''
                colorSel.value = initColorKey
                colorDot.style.background = DEVICE_COLORS[colorSel.value] || 'transparent'
                colorSel.addEventListener('change', () => { colorDot.style.background = DEVICE_COLORS[colorSel.value] || 'transparent' })
                colorRow.append(colorDot, colorSel)
                colorWrap.append(colorLbl, colorRow)
                card.appendChild(colorWrap)

                function getValues() {
                    const type = typeSel.value
                    const base = { name: nameInput.value.trim() || nameInput.placeholder, type, enabled: activatedCb.checked, sendTriggerNote: trigNoteCb.checked, sendTimecode: type === 'midi' ? tcCb.checked : false, color: DEVICE_COLORS[colorSel.value] || '' }
                    if (type === 'midi') return { ...base, device: midiSel.value || null }
                    return { ...base, host: hostIn.value.trim() || '127.0.0.1', port: parseInt(portIn.value) || 8000 }
                }
                outputDeviceStates.push({ card, getValues, cardValidators, removeBtn })
                outputDevicesList.appendChild(card)
            }

            // Migrate or load outputDevices
            let initialOutputDevices
            if (settings.outputDevices?.length > 0) {
                // If saved devices have no sendTimecode yet, migrate from legacy midiTCDevice
                initialOutputDevices = settings.outputDevices.map(d =>
                    d.sendTimecode == null && d.type === 'midi' && d.device && settings.midiTCDevice === d.device
                        ? { ...d, sendTimecode: true }
                        : d
                )
            } else {
                const midiDevs = settings.midiOutputDevices?.length > 0
                    ? settings.midiOutputDevices
                    : settings.midiTriggerDevice
                        ? [{ name: 'Gerät 1', device: settings.midiTriggerDevice, sendTriggerNote: true }]
                        : []
                const oscDevs = settings.oscOutputDevices?.length > 0
                    ? settings.oscOutputDevices
                    : settings.oscEnabled
                        ? [{ name: 'OSC', enabled: true, host: settings.oscHost || '127.0.0.1', port: settings.oscPort ?? 8000, sendTriggerNote: false }]
                        : []
                initialOutputDevices = [
                    ...midiDevs.map(d => ({ sendTriggerNote: true, ...d, type: 'midi' })),
                    ...oscDevs.map(d => ({ sendTriggerNote: false, ...d, type: 'osc' })),
                ]
            }
            let _pendingOutputDevices = initialOutputDevices

            // ── MIDI ──────────────────────────────────────────────────
            const liveInputSelect = document.getElementById('live-input-device')

            const emLightDeviceSel = document.getElementById('em-light-device')
            const emLightMidiPanel = document.getElementById('em-light-midi-panel')
            const emLightOscPanel  = document.getElementById('em-light-osc-panel')

            function updateEmLightPanels() {
                const val = emLightDeviceSel.value
                emLightMidiPanel.style.display = val.startsWith('midi:') ? '' : 'none'
                emLightOscPanel.style.display  = val.startsWith('osc:')  ? '' : 'none'
            }

            try {
                const midiAccess = await navigator.requestMIDIAccess({ sysex: true })
                const midiOutNames = new Set()
                const midiInNames  = new Set()
                for (const output of midiAccess.outputs.values()) {
                    midiOutNames.add(output.name)
                }
                for (const input of midiAccess.inputs.values()) {
                    midiInNames.add(input.name)
                    const o = new Option(input.name, input.name)
                    if (settings.midiLiveDevice === input.name) o.selected = true
                    liveInputSelect.appendChild(o)
                }
                if (settings.midiLiveDevice && !midiInNames.has(settings.midiLiveDevice))
                    insertWarning(liveInputSelect, `Gerät „${settings.midiLiveDevice}" nicht gefunden – Eingang deaktiviert`)

                // Build output device cards now that we have the MIDI output list
                _midiOutNames = midiOutNames
                for (const dev of _pendingOutputDevices) buildOutputDeviceCard(dev, _midiOutNames)
                populateEmLightDeviceSelect()
                addOutputDeviceBtn.addEventListener('click', () => {
                    buildOutputDeviceCard({ name: `Gerät ${outputDeviceStates.length + 1}`, type: 'midi' }, _midiOutNames)
                    populateEmLightDeviceSelect()
                })

                // Build mic device cards now that we have the MIDI output list
                _midiOutNames = midiOutNames
                for (const dev of _pendingDevices) buildMicDeviceCard(dev, _midiOutNames)
                updateRemoveBtns()
            } catch (e) {
                insertError('MIDI nicht verfügbar: ' + e.message)
                // Still build cards even without MIDI access
                for (const dev of _pendingOutputDevices) buildOutputDeviceCard(dev, _midiOutNames)
                populateEmLightDeviceSelect()
                addOutputDeviceBtn.addEventListener('click', () => {
                    buildOutputDeviceCard({ name: `Gerät ${outputDeviceStates.length + 1}`, type: 'midi' }, _midiOutNames)
                    populateEmLightDeviceSelect()
                })
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
            const emLightEnabledEl = document.getElementById('em-light-enabled')
            emLightEnabledEl.checked = settings.emLightEnabled ?? true

            // Helper builders
            function _elNumIn(id, min, max, val) {
                const el = document.createElement('input')
                el.type = 'number'; el.id = id; el.min = min; el.max = max; el.value = val
                el.style.width = '100%'; return el
            }
            function _elTxtIn(id, placeholder, val) {
                const el = document.createElement('input')
                el.type = 'text'; el.id = id; el.placeholder = placeholder; el.value = val
                el.style.width = '100%'; return el
            }
            function _elSubField(labelText) {
                const wrap = document.createElement('div'); wrap.className = 'field'; wrap.style.flex = '1'
                const lbl = document.createElement('label')
                lbl.textContent = labelText
                lbl.style.cssText = 'text-transform:none;font-size:0.82rem;color:#5c6370'
                wrap.appendChild(lbl)
                return { wrap, append: (el) => wrap.appendChild(el) }
            }

            // MIDI panel
            const midiTypeField = document.createElement('div'); midiTypeField.className = 'field'
            const midiTypeLbl = document.createElement('label'); midiTypeLbl.setAttribute('data-i18n', 's.emlight.midi.type'); midiTypeLbl.textContent = window.t('s.emlight.midi.type')
            const midiTypeSel = document.createElement('select'); midiTypeSel.id = 'em-light-midi-type'
            for (const [v, k] of [['note','s.emlight.midi.type.note'],['cc','s.emlight.midi.type.cc'],['pc','s.emlight.midi.type.pc'],['sysex','s.emlight.midi.type.sysex']])
                midiTypeSel.appendChild(new Option(window.t(k), v))
            midiTypeSel.value = settings.emLightMidiType || 'note'
            midiTypeField.append(midiTypeLbl, midiTypeSel)

            const midiChField = document.createElement('div'); midiChField.className = 'field'
            const midiChLbl = document.createElement('label'); midiChLbl.setAttribute('data-i18n','s.emlight.midi.ch'); midiChLbl.textContent = window.t('s.emlight.midi.ch')
            const midiChIn = _elNumIn('em-light-midi-ch', 1, 16, settings.emLightMidiCh ?? 1)
            midiChField.append(midiChLbl, midiChIn)

            // Note row
            const noteRow = document.createElement('div'); noteRow.style.cssText = 'display:flex;gap:0.5rem'
            const noteNoteF = _elSubField(window.t('s.emlight.midi.note'))
            noteNoteF.append(_elNumIn('em-light-midi-note', 0, 127, settings.emLightMidiNote ?? 60))
            const noteOnF = _elSubField(`${window.t('s.emlight.midi.on')} – ${window.t('s.emlight.midi.vel')}`)
            noteOnF.append(_elNumIn('em-light-midi-on-vel', 0, 127, settings.emLightMidiOnVel ?? 127))
            const noteOffF = _elSubField(`${window.t('s.emlight.midi.off')} – ${window.t('s.emlight.midi.vel')}`)
            noteOffF.append(_elNumIn('em-light-midi-off-vel', 0, 127, settings.emLightMidiOffVel ?? 0))
            noteRow.append(noteNoteF.wrap, noteOnF.wrap, noteOffF.wrap)

            // CC row
            const ccRow = document.createElement('div'); ccRow.style.cssText = 'display:flex;gap:0.5rem'
            const ccCcF = _elSubField(window.t('s.emlight.midi.cc'))
            ccCcF.append(_elNumIn('em-light-midi-cc', 0, 127, settings.emLightMidiCc ?? 0))
            const ccOnF = _elSubField(`${window.t('s.emlight.midi.on')} – ${window.t('s.emlight.midi.val')}`)
            ccOnF.append(_elNumIn('em-light-midi-on-value', 0, 127, settings.emLightMidiOnValue ?? 127))
            const ccOffF = _elSubField(`${window.t('s.emlight.midi.off')} – ${window.t('s.emlight.midi.val')}`)
            ccOffF.append(_elNumIn('em-light-midi-off-value', 0, 127, settings.emLightMidiOffValue ?? 0))
            ccRow.append(ccCcF.wrap, ccOnF.wrap, ccOffF.wrap)

            // PC row
            const pcRow = document.createElement('div'); pcRow.style.cssText = 'display:flex;gap:0.5rem'
            const pcOnF = _elSubField(`${window.t('s.emlight.midi.on')} – ${window.t('s.emlight.midi.prog')}`)
            pcOnF.append(_elNumIn('em-light-midi-on-prog', 0, 127, settings.emLightMidiOnProgram ?? 0))
            const pcOffF = _elSubField(`${window.t('s.emlight.midi.off')} – ${window.t('s.emlight.midi.prog')}`)
            pcOffF.append(_elNumIn('em-light-midi-off-prog', 0, 127, settings.emLightMidiOffProgram ?? 127))
            pcRow.append(pcOnF.wrap, pcOffF.wrap)

            // Sysex fields
            const sysexWrap = document.createElement('div')
            const sysexOnF = document.createElement('div'); sysexOnF.className = 'field'
            const sysexOnL = document.createElement('label'); sysexOnL.textContent = `${window.t('s.emlight.midi.on')} – ${window.t('s.emlight.midi.bytes')}`
            const sysexOnIn = _elTxtIn('em-light-midi-on-bytes', 'F0 00 F7', settings.emLightMidiOnBytes || '')
            sysexOnF.append(sysexOnL, sysexOnIn)
            const sysexOffF = document.createElement('div'); sysexOffF.className = 'field'
            const sysexOffL = document.createElement('label'); sysexOffL.textContent = `${window.t('s.emlight.midi.off')} – ${window.t('s.emlight.midi.bytes')}`
            const sysexOffIn = _elTxtIn('em-light-midi-off-bytes', 'F0 01 F7', settings.emLightMidiOffBytes || '')
            sysexOffF.append(sysexOffL, sysexOffIn)
            sysexWrap.append(sysexOnF, sysexOffF)

            emLightMidiPanel.append(midiTypeField, midiChField, noteRow, ccRow, pcRow, sysexWrap)

            function updateMidiTypePanel() {
                const type = midiTypeSel.value
                noteRow.style.display    = type === 'note'  ? '' : 'none'
                ccRow.style.display      = type === 'cc'    ? '' : 'none'
                pcRow.style.display      = type === 'pc'    ? '' : 'none'
                sysexWrap.style.display  = type === 'sysex' ? '' : 'none'
                midiChField.style.display = type !== 'sysex' ? '' : 'none'
            }
            midiTypeSel.addEventListener('change', updateMidiTypePanel)
            updateMidiTypePanel()

            // OSC panel
            const oscAddrF = document.createElement('div'); oscAddrF.className = 'field'
            const oscAddrL = document.createElement('label'); oscAddrL.setAttribute('data-i18n','s.emlight.osc.addr'); oscAddrL.textContent = window.t('s.emlight.osc.addr')
            const oscAddrIn = _elTxtIn('em-light-osc-addr', '/light', settings.emLightOscAddress || '')
            oscAddrF.append(oscAddrL, oscAddrIn)

            const oscArgTypeF = document.createElement('div'); oscArgTypeF.className = 'field'
            const oscArgTypeL = document.createElement('label'); oscArgTypeL.setAttribute('data-i18n','s.emlight.osc.argtype'); oscArgTypeL.textContent = window.t('s.emlight.osc.argtype')
            const oscArgTypeSel = document.createElement('select'); oscArgTypeSel.id = 'em-light-osc-argtype'
            for (const [v, label] of [['int','Integer'],['float','Float'],['string','String'],['bool','Bool']])
                oscArgTypeSel.appendChild(new Option(label, v))
            oscArgTypeSel.value = settings.emLightOscArgType || 'int'
            oscArgTypeF.append(oscArgTypeL, oscArgTypeSel)

            const oscArgRow = document.createElement('div'); oscArgRow.style.cssText = 'display:flex;gap:0.5rem'
            const oscOnF = _elSubField(`${window.t('s.emlight.osc.arg')} (${window.t('s.emlight.midi.on')})`)
            const oscOnIn = _elTxtIn('em-light-osc-on-arg', '1', settings.emLightOscOnArg ?? '1')
            oscOnF.append(oscOnIn)
            const oscOffF = _elSubField(`${window.t('s.emlight.osc.arg')} (${window.t('s.emlight.midi.off')})`)
            const oscOffIn = _elTxtIn('em-light-osc-off-arg', '0', settings.emLightOscOffArg ?? '0')
            oscOffF.append(oscOffIn)
            oscArgRow.append(oscOnF.wrap, oscOffF.wrap)

            emLightOscPanel.append(oscAddrF, oscArgTypeF, oscArgRow)

            emLightDeviceSel.addEventListener('change', updateEmLightPanels)

            function populateEmLightDeviceSelect() {
                const current = emLightDeviceSel.value
                emLightDeviceSel.innerHTML = ''
                emLightDeviceSel.appendChild(new Option(window.t('s.emlight.device.none'), ''))
                const midiGroup = document.createElement('optgroup')
                midiGroup.label = 'MIDI'
                const oscGroup = document.createElement('optgroup')
                oscGroup.label = 'OSC'
                for (const s of outputDeviceStates) {
                    const v = s.getValues()
                    const opt = new Option(v.name, v.type + ':' + v.name)
                    if (v.type === 'osc') oscGroup.appendChild(opt)
                    else midiGroup.appendChild(opt)
                }
                if (midiGroup.children.length) emLightDeviceSel.appendChild(midiGroup)
                if (oscGroup.children.length) emLightDeviceSel.appendChild(oscGroup)
                if (current) {
                    emLightDeviceSel.value = current
                } else {
                    const savedKind = settings.emLightDeviceKind
                    const savedDev  = settings.emLightDevice || settings.emLightMidiDevice
                    if (savedDev) {
                        emLightDeviceSel.value = savedKind ? `${savedKind}:${savedDev}` : `midi:${savedDev}`
                    }
                }
                updateEmLightPanels()
            }

            // ── Anzeige ───────────────────────────────────────────────
            const micGroupDisplayEl = document.getElementById('mic-group-display')
            micGroupDisplayEl.checked = settings.micGroupDisplay ?? true
            const openLockedEl = document.getElementById('open-locked')
            openLockedEl.checked = settings.openLocked ?? false
            const showMdLinesEl = document.getElementById('show-md-line-numbers')
            showMdLinesEl.checked = settings.showMdLineNumbers ?? false

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

            function _hasInvalidVisible() {
                const outInvalid = outputDeviceStates.some(s =>
                    s.cardValidators?.some(([el]) => el.offsetParent !== null && el.classList.contains('invalid'))
                )
                if (outInvalid) return true
                return micDeviceStates.some(s =>
                    s.cardValidators.some(([el]) => el.offsetParent !== null && el.classList.contains('invalid'))
                )
            }

            document.getElementById('cancel').addEventListener('click', () => window.close())

            document.getElementById('save').addEventListener('click', async () => {
                if (_hasInvalidVisible()) {
                    const firstInvalid = [...outputDeviceStates, ...micDeviceStates]
                        .flatMap(s => (s.cardValidators || []).map(([el]) => el))
                        .find(el => el.offsetParent !== null && el.classList.contains('invalid'))
                    if (firstInvalid) { firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' }); firstInvalid.focus() }
                    return
                }
                const _elDevVal  = emLightDeviceSel.value
                const _elColonI  = _elDevVal.indexOf(':')
                const outDevs = outputDeviceStates.map(s => s.getValues())
                await window.electronAPI.saveSettings({
                    mainAudioDevice: mainAudioSel.value || null,
                    ...getRouting(),
                    outputDevices: outDevs,
                    midiTCDevice:     null,
                    editorApp:        editorAppSel.value || null,
                    midiGoNote,
                    midiBackNote,
                    midiLiveDevice: liveInputSelect.value || null,
                    appLanguage: langSel.value || 'de',
                    emLightEnabled:         emLightEnabledEl.checked,
                    emLightDevice:          _elColonI >= 0 ? _elDevVal.slice(_elColonI + 1) : null,
                    emLightDeviceKind:      _elDevVal.startsWith('midi:') ? 'midi' : _elDevVal.startsWith('osc:') ? 'osc' : null,
                    emLightMidiType:        midiTypeSel.value,
                    emLightMidiCh:          parseInt(midiChIn.value) || 1,
                    emLightMidiNote:        parseInt(document.getElementById('em-light-midi-note')?.value) ?? 60,
                    emLightMidiOnVel:       parseInt(document.getElementById('em-light-midi-on-vel')?.value) ?? 127,
                    emLightMidiOffVel:      parseInt(document.getElementById('em-light-midi-off-vel')?.value) ?? 0,
                    emLightMidiCc:          parseInt(document.getElementById('em-light-midi-cc')?.value) ?? 0,
                    emLightMidiOnValue:     parseInt(document.getElementById('em-light-midi-on-value')?.value) ?? 127,
                    emLightMidiOffValue:    parseInt(document.getElementById('em-light-midi-off-value')?.value) ?? 0,
                    emLightMidiOnProgram:   parseInt(document.getElementById('em-light-midi-on-prog')?.value) ?? 0,
                    emLightMidiOffProgram:  parseInt(document.getElementById('em-light-midi-off-prog')?.value) ?? 127,
                    emLightMidiOnBytes:     sysexOnIn.value || '',
                    emLightMidiOffBytes:    sysexOffIn.value || '',
                    emLightOscAddress:      oscAddrIn.value.trim() || null,
                    emLightOscArgType:      oscArgTypeSel.value,
                    emLightOscOnArg:        oscOnIn.value,
                    emLightOscOffArg:       oscOffIn.value,
                    micDevices: micDeviceStates.map(s => s.getValues()),
                    micGroupDisplay: micGroupDisplayEl.checked,
                    openLocked: openLockedEl.checked,
                    showMdLineNumbers: showMdLinesEl.checked,
                })
                window.close()
            })
        }
        init()
