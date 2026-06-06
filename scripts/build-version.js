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

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const out = path.join(__dirname, '..', 'dist', 'version.json')
fs.writeFileSync(out, JSON.stringify({ version: pkg.version, commit, date }, null, 2))
console.log(`version.json → version=${pkg.version} commit=${commit} date=${date}`)
