#!/usr/bin/env node
/**
 * Validates theme directories against the contract in `lib/theme.js`.
 *
 * Usage:
 *   node scripts/validate-theme.mjs [dir ...]
 *
 * With no argument it scans the three places the plugin looks for themes:
 * the shipped `assets/themes/`, the local-only `assets/local-themes/`, and
 * `$DSH_HOME/dsh-clawd/themes/`. Exits non-zero when any theme has an error.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverThemes, readTheme } from '../lib/theme.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const args = process.argv.slice(2).filter((value) => !value.startsWith('-'))
const roots = args.length
  ? args.map((dir) => ({ dir: path.resolve(dir), source: 'argument' }))
  : [
      { dir: path.join(ROOT, 'assets', 'themes'), source: 'builtin' },
      { dir: path.join(ROOT, 'assets', 'local-themes'), source: 'local' },
      { dir: path.join(DSH_HOME, 'dsh-clawd', 'themes'), source: 'user' },
    ]

let errors = 0
let checked = 0
for (const { dir, source } of roots) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const themeDir = path.join(dir, entry.name)
    if (fs.existsSync(themeDir) && !fs.existsSync(path.join(themeDir, 'theme.json'))) {
      if (args.length) process.stdout.write(`SKIP  ${themeDir} (no theme.json)\n`)
      continue
    }
    const read = readTheme(themeDir)
    if (!fs.existsSync(path.join(themeDir, 'theme.json'))) continue
    checked += 1
    const id = read.manifest?.id ?? entry.name
    if (read.ok) {
      process.stdout.write(`OK    ${id} (${source}) — ${themeDir}\n`)
    } else {
      errors += 1
      process.stdout.write(`FAIL  ${id} (${source}) — ${themeDir}\n`)
    }
    for (const error of read.errors ?? []) process.stdout.write(`        error: ${error}\n`)
    for (const warning of read.warnings ?? []) process.stdout.write(`        warn:  ${warning}\n`)
  }
}

const { themes } = discoverThemes(roots)
// Discovery keys themes by id with later roots winning, so the two counts differ
// whenever a user theme shadows a local one.
process.stdout.write(
  `\n${checked} theme director${checked === 1 ? 'y' : 'ies'} checked, ${themes.size} usable id(s) after shadowing, ${errors} with errors\n`,
)
process.exit(errors ? 1 : 0)
