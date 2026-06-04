'use strict'
const { cpSync, rmSync } = require('fs')
const path = require('path')

const src  = path.join(__dirname, '..', 'dist')
const dest = path.join(__dirname, '..', 'website', 'app')

rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log('Preview bundle → website/app/')
