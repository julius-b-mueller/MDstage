
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

        // rows: [{ originalName, nameInput, colorSelect, colorDot, chInput }]
        const rows = []

        function nextAutoColor() {
            const usedColors = rows.map(r => r.colorSelect.value)
            return COLOR_CYCLE.find(c => !usedColors.includes(c)) ?? COLOR_CYCLE[rows.length % COLOR_CYCLE.length]
        }

        function buildColorSelect(selectedColor) {
            const sel = document.createElement('select')
            sel.className = 'role-color'
            for (const key of COLOR_CYCLE) {
                const opt = document.createElement('option')
                opt.value = key
                opt.textContent = COLOR_LABELS[key]
                if (key === selectedColor) opt.selected = true
                sel.appendChild(opt)
            }
            return sel
        }

        function addRow(name, color, ch, isNew) {
            const row = document.createElement('div')
            row.className = 'role-row'

            const nameInput = document.createElement('input')
            nameInput.type = 'text'
            nameInput.className = 'role-name'
            nameInput.value = name
            nameInput.placeholder = 'Rollenname'

            const colorDot = document.createElement('div')
            colorDot.className = 'color-dot'
            colorDot.style.background = ROLE_COLORS[color] || ROLE_COLORS.blue

            const colorSel = buildColorSelect(color)
            colorSel.addEventListener('change', () => {
                colorDot.style.background = ROLE_COLORS[colorSel.value] || ''
            })

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
            })

            row.append(nameInput, colorDot, colorSel, chInput, removeBtn)
            document.getElementById('role-list').appendChild(row)

            rows.push({ originalName: isNew ? null : name, nameInput, colorSelect: colorSel, colorDot, chInput, row })
        }

        document.getElementById('add-btn').addEventListener('click', () => {
            const color = nextAutoColor()
            addRow('', color, '', true)
            rows[rows.length - 1].nameInput.focus()
        })

        document.getElementById('cancel-btn').addEventListener('click', () => window.close())

        document.getElementById('save-btn').addEventListener('click', async () => {
            const roles = {}
            const renames = []
            let valid = true

            for (const r of rows) {
                const name = r.nameInput.value.trim()
                if (!name) { r.nameInput.style.borderColor = '#e06c75'; valid = false; continue }
                r.nameInput.style.borderColor = ''
                if (roles[name]) { r.nameInput.style.borderColor = '#e5c07b'; valid = false; continue }
                roles[name] = {
                    color: r.colorSelect.value,
                    ch: parseInt(r.chInput.value) || null,
                }
                if (r.originalName && r.originalName !== name) {
                    renames.push({ from: r.originalName, to: name })
                }
            }

            if (!valid) return
            await window.electronAPI.saveRoles({ roles, renames })
            window.close()
        })

        async function init() {
            const rolesData = await window.electronAPI.getRoles()
            for (const [name, cfg] of Object.entries(rolesData)) {
                addRow(name, cfg.color || 'blue', cfg.ch, false)
            }
        }
        init()
    