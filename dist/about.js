
    async function init() {
        const version   = await window.electronAPI.getAppVersion()
        const buildInfo = await window.electronAPI.getBuildInfo()

        document.getElementById('ver').textContent = 'Version ' + version

        const parts = []
        if (buildInfo.date)                       parts.push(buildInfo.date)
        if (buildInfo.commit && buildInfo.commit !== 'dev') parts.push('Commit ' + buildInfo.commit)
        document.getElementById('bld').textContent = parts.join('  ·  ')
    }
    init().catch(() => {})
