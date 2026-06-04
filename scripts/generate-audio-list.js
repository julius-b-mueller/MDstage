'use strict'
const fs   = require('fs')
const path = require('path')

const audioDir = path.join(__dirname, '..', 'website', 'preview', 'audio')
const outFile  = path.join(audioDir, 'files.json')

let files = []
try {
    files = fs.readdirSync(audioDir)
        .filter(f => /\.(mp3|wav)$/i.test(f))
        .sort()
} catch (e) {
    console.warn('generate-audio-list: could not read', audioDir, e.message)
}

fs.writeFileSync(outFile, JSON.stringify(files, null, 0) + '\n')
console.log(`audio/files.json → ${files.length} file(s): ${files.join(', ') || '(none)'}`)
