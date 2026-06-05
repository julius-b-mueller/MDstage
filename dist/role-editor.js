
        const ROLE_COLORS = {
            blue: '#61afef', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
            purple: '#c678dd', cyan: '#56b6c2', darkblue: '#317fbf', darkred: '#b03c45',
            darkgreen: '#68b349', darkyellow: '#b5904b', darkpurple: '#9648ad', darkcyan: '#268692',
        }
        const COLOR_LABELS = {
            blue: 'Blau', red: 'Rot', green: 'Grün', yellow: 'Gelb',
            purple: 'Lila', cyan: 'Türkis', darkblue: 'Dunkelblau', darkred: 'Dunkelrot',
            darkgreen: 'Dunkelgrün', darkyellow: 'Dunkelgelb', darkpurple: 'Dunkellila', darkcyan: 'Dunkeltürkis',
        }
        const COLOR_CYCLE = ['blue', 'red', 'green', 'yellow', 'purple', 'cyan', 'darkblue', 'darkred', 'darkgreen', 'darkyellow', 'darkpurple', 'darkcyan']

        // rows: [{ originalName, nameInput, colorSelect, colorDot, deviceSelect, chInput, row }]
        const rows = []
        // groupRows: [{ nameInput, colorSelect, colorDot, getMemberRoles, row }]
        const groupRows = []
        let deviceNames = ['Gerät 1']
        let currentRoleNames = []  // kept in sync as roles are built, used by groups

        function nextAutoColor() {
            const usedColors = rows.map(r => r.colorSelect.value)
            return COLOR_CYCLE.find(c => !usedColors.includes(c)) ?? COLOR_CYCLE[rows.length % COLOR_CYCLE.length]
        }

        function buildColorSelect(selectedColor, cls) {
            const sel = document.createElement('select')
            sel.className = cls || 'role-color'
            for (const key of COLOR_CYCLE) {
                const opt = document.createElement('option')
                opt.value = key
                opt.textContent = COLOR_LABELS[key]
                if (key === selectedColor) opt.selected = true
                sel.appendChild(opt)
            }
            return sel
        }

        function buildDeviceSelect(selectedDevice) {
            const sel = document.createElement('select')
            sel.className = 'role-device'
            for (let i = 0; i < deviceNames.length; i++) {
                const opt = document.createElement('option')
                opt.value = String(i)
                opt.textContent = deviceNames[i]
                if (i === selectedDevice) opt.selected = true
                sel.appendChild(opt)
            }
            return sel
        }

        // Rebuild all member chips in every group row (called after roles change)
        function refreshGroupMemberChips() {
            currentRoleNames = rows.map(r => r.nameInput.value.trim()).filter(Boolean)
            for (const gr of groupRows) gr.rebuildChips()
        }

        // Returns true if all names are valid (no duplicates across roles+groups, no reserved names)
        function validateAllNames() {
            for (const r of rows) r.nameInput.classList.remove('name-conflict')
            for (const g of groupRows) g.nameInput.classList.remove('name-conflict')
            const nameMap = new Map()
            function collect(input) {
                const name = input.value.trim()
                if (!name) return
                if (name === 'Alle') { input.classList.add('name-conflict'); return }
                if (!nameMap.has(name)) nameMap.set(name, [])
                nameMap.get(name).push(input)
            }
            for (const r of rows) collect(r.nameInput)
            for (const g of groupRows) collect(g.nameInput)
            for (const [, inputs] of nameMap) {
                if (inputs.length > 1) {
                    for (const inp of inputs) inp.classList.add('name-conflict')
                }
            }
            return ![...rows, ...groupRows].some(x => x.nameInput.classList.contains('name-conflict'))
        }

        function addRow(name, color, ch, device, isNew) {
            const row = document.createElement('div')
            row.className = 'role-row'

            const nameInput = document.createElement('input')
            nameInput.type = 'text'
            nameInput.className = 'role-name'
            nameInput.value = name
            nameInput.placeholder = 'Rollenname'
            nameInput.addEventListener('input', () => { refreshGroupMemberChips(); validateAllNames() })

            const colorDot = document.createElement('div')
            colorDot.className = 'color-dot'
            colorDot.style.background = ROLE_COLORS[color] || ROLE_COLORS.blue

            const colorSel = buildColorSelect(color)
            colorSel.addEventListener('change', () => {
                colorDot.style.background = ROLE_COLORS[colorSel.value] || ''
            })

            const deviceSel = buildDeviceSelect(device ?? 0)
            if (deviceNames.length <= 1) deviceSel.style.display = 'none'

            const chInput = document.createElement('input')
            chInput.type = 'number'
            chInput.className = 'role-ch'
            chInput.min = '1'
            chInput.max = '32'
            chInput.value = ch || ''
            chInput.placeholder = '—'

            const removeBtn = document.createElement('button')
            removeBtn.className = 'remove-btn'
            removeBtn.textContent = '×'
            removeBtn.title = 'Rolle entfernen'
            removeBtn.addEventListener('click', () => {
                const idx = rows.findIndex(r => r.row === row)
                if (idx !== -1) rows.splice(idx, 1)
                row.remove()
                refreshGroupMemberChips()
                validateAllNames()
            })

            row.append(nameInput, colorDot, colorSel, deviceSel, chInput, removeBtn)
            document.getElementById('role-list').appendChild(row)

            rows.push({ originalName: isNew ? null : name, nameInput, colorSelect: colorSel, colorDot, deviceSelect: deviceSel, chInput, row })
        }

        function addGroupRow(name, color, memberRoles, isNew) {
            const row = document.createElement('div')
            row.className = 'group-row'

            const nameInput = document.createElement('input')
            nameInput.type = 'text'
            nameInput.className = 'group-name'
            nameInput.value = name
            nameInput.placeholder = 'Gruppenname'

            nameInput.addEventListener('input', validateAllNames)

            const colorDot = document.createElement('div')
            colorDot.className = 'color-dot'
            colorDot.style.cssText = 'width:18px;height:18px;border-radius:50%;flex-shrink:0;border:2px solid rgba(255,255,255,0.15);'
            colorDot.style.background = ROLE_COLORS[color] || '#4b5263'

            const colorSel = buildColorSelect(color, 'group-color')
            colorSel.addEventListener('change', () => {
                colorDot.style.background = ROLE_COLORS[colorSel.value] || '#4b5263'
            })

            const membersDiv = document.createElement('div')
            membersDiv.className = 'group-members'

            let memberSet = new Set(memberRoles || [])

            function rebuildChips() {
                membersDiv.innerHTML = ''
                const names = rows.map(r => r.nameInput.value.trim()).filter(Boolean)
                for (const rName of names) {
                    const chip = document.createElement('span')
                    chip.className = 'member-chip' + (memberSet.has(rName) ? ' active' : '')
                    chip.textContent = rName
                    chip.addEventListener('click', () => {
                        if (memberSet.has(rName)) memberSet.delete(rName)
                        else memberSet.add(rName)
                        chip.classList.toggle('active', memberSet.has(rName))
                    })
                    membersDiv.appendChild(chip)
                }
                if (names.length === 0) {
                    const hint = document.createElement('span')
                    hint.style.cssText = 'font-size:0.78rem;color:#5c6370;font-style:italic;'
                    hint.textContent = 'Noch keine Rollen vorhanden'
                    membersDiv.appendChild(hint)
                }
            }

            rebuildChips()

            const removeBtn = document.createElement('button')
            removeBtn.className = 'remove-btn'
            removeBtn.textContent = '×'
            removeBtn.title = 'Gruppe entfernen'
            removeBtn.addEventListener('click', () => {
                const idx = groupRows.findIndex(g => g.row === row)
                if (idx !== -1) groupRows.splice(idx, 1)
                row.remove()
                validateAllNames()
            })

            const header = document.createElement('div')
            header.className = 'group-row-header'
            header.append(nameInput, colorDot, colorSel, removeBtn)
            row.append(header, membersDiv)
            document.getElementById('group-list').appendChild(row)

            function getMemberRoles() {
                // Only return members that still exist as roles
                const validRoles = new Set(rows.map(r => r.nameInput.value.trim()).filter(Boolean))
                return [...memberSet].filter(m => validRoles.has(m))
            }

            groupRows.push({ originalName: isNew ? null : name, nameInput, colorSelect: colorSel, colorDot, getMemberRoles, rebuildChips, row })
        }

        document.getElementById('add-btn').addEventListener('click', () => {
            const color = nextAutoColor()
            addRow('', color, '', 0, true)
            rows[rows.length - 1].nameInput.focus()
            refreshGroupMemberChips()
        })

        document.getElementById('add-group-btn').addEventListener('click', () => {
            addGroupRow('', COLOR_CYCLE[groupRows.length % COLOR_CYCLE.length], [], true)
            groupRows[groupRows.length - 1].nameInput.focus()
        })

        document.getElementById('cancel-btn').addEventListener('click', () => window.close())

        document.getElementById('save-btn').addEventListener('click', async () => {
            if (!validateAllNames()) return

            const roles = {}
            const renames = []
            let valid = true

            for (const r of rows) {
                const name = r.nameInput.value.trim()
                if (!name) { r.nameInput.style.borderColor = '#e06c75'; valid = false; continue }
                r.nameInput.style.borderColor = ''
                roles[name] = {
                    color: r.colorSelect.value,
                    ch: parseInt(r.chInput.value) || null,
                    device: parseInt(r.deviceSelect.value) || 0,
                }
                if (r.originalName && r.originalName !== name) {
                    renames.push({ from: r.originalName, to: name })
                }
            }

            const groups = {}
            for (const g of groupRows) {
                const name = g.nameInput.value.trim()
                if (!name) { g.nameInput.style.borderColor = '#e06c75'; valid = false; continue }
                g.nameInput.style.borderColor = ''
                groups[name] = {
                    color: g.colorSelect.value,
                    roles: g.getMemberRoles(),
                }
            }

            if (!valid) return
            await window.electronAPI.saveRoles({ roles, renames, groups })
            window.close()
        })

        async function init() {
            const [rolesData, settingsData] = await Promise.all([
                window.electronAPI.getRoles(),
                window.electronAPI.getSettings(),
            ])
            const { roles = {}, groups = {} } = rolesData
            const micDevices = settingsData.micDevices && settingsData.micDevices.length > 0
                ? settingsData.micDevices
                : [{ name: 'Gerät 1' }]
            deviceNames = micDevices.map((d, i) => d.name || `Gerät ${i + 1}`)

            if (deviceNames.length <= 1) {
                const hdr = document.getElementById('col-device-header')
                if (hdr) hdr.style.display = 'none'
            }

            for (const [name, cfg] of Object.entries(roles)) {
                addRow(name, cfg.color || 'blue', cfg.ch, cfg.device ?? 0, false)
            }
            refreshGroupMemberChips()

            for (const [name, cfg] of Object.entries(groups)) {
                addGroupRow(name, cfg.color || 'blue', cfg.roles || [], false)
            }
        }
        init()

