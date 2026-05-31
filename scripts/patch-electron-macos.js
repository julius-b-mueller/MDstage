#!/usr/bin/env node
'use strict'
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

if (process.platform !== 'darwin') process.exit(0)

const root       = path.join(__dirname, '..')
const electronApp = path.join(root, 'node_modules/electron/dist/Electron.app')
const plist      = path.join(electronApp, 'Contents/Info.plist')
const icnsDest   = path.join(electronApp, 'Contents/Resources/electron.icns')
const iconSrc    = path.join(root, 'dist/assets/icon.png')

if (!fs.existsSync(plist)) {
    console.warn('patch-electron: Electron binary not found, skipping')
    process.exit(0)
}

// ── Name ────────────────────────────────────────────────────────────────────
try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Main Desk" "${plist}"`)
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName Main Desk" "${plist}"`)
    console.log('patch-electron: bundle name → Main Desk')
} catch (e) {
    console.warn('patch-electron: could not patch bundle name:', e.message)
}

// ── Icon ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(iconSrc)) {
    console.warn('patch-electron: icon.png not found, skipping icon patch')
    process.exit(0)
}

const tmpIconset = path.join(os.tmpdir(), 'MainDesk.iconset')
try {
    fs.mkdirSync(tmpIconset, { recursive: true })
    const sizes = [16, 32, 128, 256, 512]
    for (const s of sizes) {
        execSync(`sips -z ${s} ${s} "${iconSrc}" --out "${tmpIconset}/icon_${s}x${s}.png" -s format png 2>/dev/null`)
        if (s <= 256) {
            execSync(`sips -z ${s * 2} ${s * 2} "${iconSrc}" --out "${tmpIconset}/icon_${s}x${s}@2x.png" -s format png 2>/dev/null`)
        }
    }
    execSync(`iconutil -c icns "${tmpIconset}" -o "${icnsDest}"`)
    fs.rmSync(tmpIconset, { recursive: true })
    console.log('patch-electron: icon → Main Desk icon')
} catch (e) {
    console.warn('patch-electron: could not replace icon:', e.message)
    try { fs.rmSync(tmpIconset, { recursive: true, force: true }) } catch {}
}
