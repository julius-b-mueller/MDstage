
    async function init() {
        let version, buildInfo
        if (window.electronAPI) {
            version   = await window.electronAPI.getAppVersion()
            buildInfo = await window.electronAPI.getBuildInfo()
        } else {
            const v = await fetch('version.json').then(r => r.json()).catch(() => ({}))
            version   = v.version || '—'
            buildInfo = { date: v.date || '', commit: v.commit || '' }
        }

        document.getElementById('ver').textContent = 'Version ' + version

        const parts = []
        if (buildInfo.date)                                 parts.push(buildInfo.date)
        if (buildInfo.commit && buildInfo.commit !== 'dev') parts.push('Commit ' + buildInfo.commit)
        document.getElementById('bld').textContent = parts.join('  ·  ')
    }
    init().catch(() => {})
