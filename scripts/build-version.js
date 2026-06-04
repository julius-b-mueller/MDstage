#!/usr/bin/env node
'use strict'
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

let commit = 'dev'
let date = new Date().toISOString().slice(0, 10)

try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {}

const out = path.join(__dirname, '..', 'dist', 'version.json')
fs.writeFileSync(out, JSON.stringify({ commit, date }, null, 2))
console.log(`version.json → commit=${commit} date=${date}`)
